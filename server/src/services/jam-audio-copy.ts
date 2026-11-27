import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JAM_AUDIO_MAX_BYTES } from "@pqp/shared";
import type { PoolClient } from "pg";
import { getPool } from "../db.js";
import { isEnabled } from "../lib/flags.js";
import { logEvent } from "../lib/log.js";
import { deleteObject, downloadObjectToFile, putObjectFromFile } from "../lib/s3.js";
import {
  LISTEN_COPY_CONTENT_TYPE,
  convertFlacToListenCopy,
  copyLengthProblem,
  inspectFlacFile,
  inspectOggOpusFile,
  maxCopySeconds,
} from "../speech/audio-copy.js";
import { TranscodeError } from "../speech/transcode.js";
import {
  dropSpeechJob,
  enqueueSpeechJob,
  finishSpeechJob,
  retrySpeechJobLater,
  SPEECH_JOBS_CHANNEL,
  type SpeechJob,
} from "./speech-jobs.js";

/**
 * The Opus LISTENING COPY of a Jam stem (`speech_jobs` kind `jam_audio_copy`,
 * keyed by the track). WHY: public playback downloaded every stem as FLAC
 * before the first sound (a three minute, five stem song is about 54 MB, four
 * and a half minutes on Fast 3G); the copy is about a sixth of that. What the
 * copy must keep, and why it is for LISTENING only, is `speech/audio-copy.ts`;
 * what a read then says is `jamAudioSourceSchema` in `packages/shared`.
 *
 * BEHIND THE RUNTIME FLAG `jam_audio_copy` (default off, the only off switch).
 * Off: nothing is enqueued, the backfill does nothing, a process never claims
 * the kind (`runnableSpeechJobKinds`), and no read offers a copy, so the system
 * is what it was before this file existed. The copies already made stay in the
 * bucket and on their rows: turning it back on does not make them again.
 *
 *   enqueue   in the transaction that inserts a track with a FLAC stem
 *             (`addJamTrack`), flag on; and by `enqueueMissingJamAudioCopies`
 *             for every stem that existed before: newest first, tracks of
 *             public songs first, at most `backfillPerPass()` a minute and
 *             never more than `BACKFILL_QUEUE_CAP` waiting or running at once
 *   claim     `runSpeechJobsTick`, a lane of its own, ONE at a time, only on a
 *             process whose ffmpeg has libopus and only with the flag on
 *   run       download (at most `JAM_AUDIO_MAX_BYTES`, to a file) -> read its
 *             STREAMINFO -> ffmpeg -> check the copy is exactly as long as the
 *             original -> reserve the key -> upload -> confirm on the row
 *
 * RESERVE, UPLOAD, CONFIRM, in that order, the MP4 copy's contract: the key is
 * on the row before the PUT so the sweep and the channel, server and account
 * deletes (`jam-keys.ts`), which read keys, delete a half-made copy too;
 * `audio_listen_content_type` is written last and is all a read looks at; a
 * confirm that matches no row (the track was deleted while the file encoded)
 * deletes the object it just put. NOTHING between BEGIN and COMMIT touches the
 * network: the download, the encode and the PUT all happen before the
 * transaction opens, and the transaction is two statements.
 *
 * FAILURES ARE VISIBLE: every path that leaves no copy logs
 * `jamAudioCopy.failed` with the track and the reason, bumps a counter, and a
 * job that gives up stays `failed` in `speech_jobs`, which is what `failed` on
 * `GET /api/admin/metrics` (`jamAudioCopy`) counts. Nothing is lost by it: the
 * track plays from its FLAC, as it always did.
 */

export const JAM_AUDIO_COPY_JOB_KIND = "jam_audio_copy" as const;

/** The only original type that is copied: lossless, the web recorder's. See `speech/audio-copy.ts`. */
const LOSSLESS_TYPE = "audio/flac";

/** Waiting or running jobs the backfill leaves in the queue at once. */
export const BACKFILL_QUEUE_CAP = 10;
/** Default tracks the backfill queues per pass (the sweep runs once a minute). */
export const BACKFILL_PER_PASS_DEFAULT = 5;

/**
 * `JAM_AUDIO_COPY_BACKFILL_PER_MINUTE`: the backfill's rate limit, in tracks per
 * pass of the one-minute sweep. `0` pauses the backfill without touching the
 * flag (copies of NEW tracks still queue); unset or garbage is the default.
 * Read per pass, so a change needs no restart of anything but the worker.
 */
export function backfillPerPass(): number {
  const raw = process.env.JAM_AUDIO_COPY_BACKFILL_PER_MINUTE?.trim();
  if (!raw) return BACKFILL_PER_PASS_DEFAULT;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? Math.min(value, 100) : BACKFILL_PER_PASS_DEFAULT;
}

const stats = {
  /** A copy was made and confirmed. */
  made: 0,
  /** Settled without one on purpose: not lossless, not smaller. */
  skipped: 0,
  /** Gave up (attempts spent, or a file that cannot be converted). */
  failed: 0,
  retried: 0,
  skippedGone: 0,
  lostLease: 0,
  /** The copy's length was not the original's: the delay was not compensated. Should stay 0. */
  lengthMismatch: 0,
  /** The flag went off between the claim and the run: the job was dropped. */
  droppedFlagOff: 0,
};

export type JamAudioCopyJobMetrics = typeof stats;

/** Since boot, this process only: the database says the rest (`jam-audio-copy-metrics.ts`). */
export function jamAudioCopyJobMetrics(): JamAudioCopyJobMetrics {
  return { ...stats };
}

export function resetJamAudioCopyJobMetricsForTests(): void {
  for (const key of Object.keys(stats) as (keyof typeof stats)[]) stats[key] = 0;
  backfillIdleUntil = 0;
}

/** Whether the listening copy exists at all right now (the runtime flag, global). */
export function jamAudioCopyEnabled(): boolean {
  return isEnabled("jam_audio_copy");
}

/** `jam/<server>/<song>/<id>.flac` -> `jam/<server>/<song>/<id>.listen.ogg`: same prefix, same sweeps. */
export function listenKeyFor(audioKey: string): string {
  return audioKey.replace(/\.[^./]*$/, "") + ".listen.ogg";
}

type Queryable = Pick<PoolClient, "query">;

type Converter = typeof convertFlacToListenCopy;
let converterOverride: Converter | null = null;

/** Tests only: stand in for ffmpeg (CI may not have it, and a test wants to break it). `null` puts the real one back. */
export function setJamAudioCopyConverterForTests(fn: Converter | null): void {
  converterOverride = fn;
}

/**
 * Queue the copy of a track's stem. Idempotent per track. Answers false, and
 * writes nothing, with the flag off or for an original that is not FLAC. Safe
 * in the transaction that inserts the track: a row and a NOTIFY.
 */
export async function enqueueJamAudioCopy(
  db: Queryable,
  trackId: string,
  audioContentType: string,
): Promise<boolean> {
  if (!jamAudioCopyEnabled() || audioContentType !== LOSSLESS_TYPE) {
    return false;
  }
  return enqueueSpeechJob(db, { kind: JAM_AUDIO_COPY_JOB_KIND, trackId });
}

/** After a pass that found nothing to queue, the backfill rests this long. */
const BACKFILL_IDLE_MS = 30 * 60_000;
let backfillIdleUntil = 0;

/**
 * Queue the stems that have no copy and no job yet: every track recorded before
 * the flag went on. Newest first, the tracks of public songs ahead of the
 * rest (those are the ones a listener downloads), at most `limit` per call and
 * never more than `cap` waiting or running at once, so a backlog of a hundred
 * thousand stems is a trickle (`backfillPerPass()` a minute) and the worker's
 * one lane is never a queue's worth behind. Rows only, so it runs on any
 * process whatever ffmpeg says; claiming is what needs libopus.
 *
 * It also cancels what the flag and the tracks no longer want: with the flag
 * off it does nothing at all (the rest period is cleared, so a flip on starts
 * at once), and a QUEUED job whose track was deleted is dropped here instead
 * of waiting to be claimed (a running one finds the track gone and stops).
 */
export async function enqueueMissingJamAudioCopies(
  limit = backfillPerPass(),
  cap = BACKFILL_QUEUE_CAP,
): Promise<number> {
  if (!jamAudioCopyEnabled()) {
    backfillIdleUntil = 0;
    return 0;
  }
  // Cancel before counting: a job for a track that is gone is not "waiting" for anything.
  await getPool().query(
    `DELETE FROM speech_jobs j
      WHERE j.kind = $1 AND j.status = 'queued'
        AND NOT EXISTS (
          SELECT 1 FROM jam_tracks t
           WHERE t.id = j.track_id AND t.deleted_at IS NULL AND t.media_purged_at IS NULL)`,
    [JAM_AUDIO_COPY_JOB_KIND],
  );
  if (limit <= 0 || Date.now() < backfillIdleUntil) {
    return 0;
  }
  const waiting = await getPool().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM speech_jobs WHERE kind = $1 AND status IN ('queued', 'running')`,
    [JAM_AUDIO_COPY_JOB_KIND],
  );
  const room = Math.max(0, Math.min(limit, cap - (waiting.rows[0]?.n ?? 0)));
  if (room === 0) {
    return 0;
  }
  const inserted = await getPool().query(
    `WITH candidates AS (
       SELECT t.id FROM jam_tracks t
        WHERE t.audio_content_type = $3 AND t.audio_listen_content_type IS NULL
          AND t.deleted_at IS NULL AND t.media_purged_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM speech_jobs j WHERE j.kind = $2 AND j.track_id = t.id)
        ORDER BY EXISTS (
                   SELECT 1 FROM jam_public_tracks pt
                    WHERE pt.track_id = t.id AND pt.removed_at IS NULL) DESC,
                 t.created_at DESC
        LIMIT $1
     )
     INSERT INTO speech_jobs (kind, track_id)
     SELECT $2, id FROM candidates
     ON CONFLICT (kind, track_id) WHERE track_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [room, JAM_AUDIO_COPY_JOB_KIND, LOSSLESS_TYPE],
  );
  const added = inserted.rowCount ?? 0;
  if (added === 0) {
    backfillIdleUntil = Date.now() + BACKFILL_IDLE_MS;
  } else {
    await getPool().query(`SELECT pg_notify($1, '')`, [SPEECH_JOBS_CHANNEL]);
  }
  return added;
}

interface TrackRow {
  id: string;
  audio_key: string;
  audio_content_type: string;
  audio_bytes: string;
  duration_ms: number;
  audio_listen_content_type: string | null;
  deleted_at: Date | null;
  media_purged_at: Date | null;
}

async function loadTrack(trackId: string): Promise<TrackRow | null> {
  const found = await getPool().query<TrackRow>(
    `SELECT id::text AS id, audio_key, audio_content_type, audio_bytes::text AS audio_bytes,
            duration_ms, audio_listen_content_type, deleted_at, media_purged_at
       FROM jam_tracks WHERE id = $1`,
    [trackId],
  );
  return found.rows[0] ?? null;
}

async function dropObject(key: string): Promise<void> {
  await deleteObject(key).catch((error: unknown) => {
    console.error(`[jam] leaked audio copy ${key}:`, error instanceof Error ? error.message : error);
  });
}

/**
 * A copy that will not be confirmed because the job gave up: delete the object,
 * then drop the reservation, so no row names a file nobody wants. If the delete
 * fails the reservation stays, which keeps the key where the sweep reads it.
 */
async function discardCopy(trackId: string, key: string): Promise<void> {
  try {
    await deleteObject(key);
  } catch (error) {
    console.error(`[jam] could not delete unconfirmed audio copy ${key}:`, error instanceof Error ? error.message : error);
    return;
  }
  await getPool().query(
    `UPDATE jam_tracks SET audio_listen_key = NULL
      WHERE id = $1 AND audio_listen_key = $2 AND audio_listen_content_type IS NULL`,
    [trackId, key],
  );
}

/** A failure that no retry will change: say so, count it, settle the job `failed`. */
async function giveUp(job: SpeechJob, trackId: string, reason: string, reservedKey?: string): Promise<void> {
  stats.failed += 1;
  logEvent("jamAudioCopy.failed", { trackId, attempt: job.attempts, next: "gave-up", reason: reason.slice(0, 200) });
  await finishSpeechJob(getPool(), job, "failed", reason);
  if (reservedKey) await discardCopy(trackId, reservedKey);
}

/** Settled on purpose, no copy and nothing wrong: `last_error` carries the reason, which is how metrics tells it from a copy made. */
async function skip(job: SpeechJob, trackId: string, reason: string): Promise<void> {
  stats.skipped += 1;
  logEvent("jamAudioCopy.skipped", { trackId, reason });
  await finishSpeechJob(getPool(), job, "done", reason);
}

/**
 * A failure that may be temporary: back to the queue with backoff, or give up
 * when the attempts are spent. `reservedKey` is the copy's key once it is on the
 * row: a retry rewrites the same key, so it is only discarded on the give-up.
 */
async function retryOrGiveUp(job: SpeechJob, trackId: string, reason: string, reservedKey?: string): Promise<void> {
  const next = await retrySpeechJobLater(job, reason);
  logEvent("jamAudioCopy.failed", { trackId, attempt: job.attempts, next, reason: reason.slice(0, 200) });
  if (next === "retrying") {
    stats.retried += 1;
  } else if (next === "gave-up") {
    stats.failed += 1;
    await finishSpeechJob(getPool(), job, "failed", reason);
    if (reservedKey) await discardCopy(trackId, reservedKey);
  }
}

/** What a claimed `jam_audio_copy` job does. Never throws for a file it cannot convert. */
export async function runJamAudioCopyJob(job: SpeechJob): Promise<void> {
  const trackId = job.track_id;
  if (!trackId) {
    await finishSpeechJob(getPool(), job, "failed", "no-track");
    return;
  }
  // The flag went off after the claim: nothing was done, so nothing is kept (the
  // job is dropped, not failed, and the backfill makes it again when the flag is back).
  if (!jamAudioCopyEnabled()) {
    stats.droppedFlagOff += 1;
    await dropSpeechJob(getPool(), job);
    return;
  }
  const track = await loadTrack(trackId);
  if (!track || track.deleted_at || track.media_purged_at) {
    stats.skippedGone += 1;
    await finishSpeechJob(getPool(), job, "done", "gone");
    return;
  }
  if (track.audio_listen_content_type) {
    await finishSpeechJob(getPool(), job, "done", "already");
    return;
  }
  if (track.audio_content_type !== LOSSLESS_TYPE) {
    await skip(job, trackId, "not-lossless");
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "pqp-jam-audio-"));
  try {
    const inPath = join(dir, "in.flac");
    const outPath = join(dir, "out.ogg");
    let downloaded: { bytes: number } | null;
    try {
      downloaded = await downloadObjectToFile(track.audio_key, inPath, JAM_AUDIO_MAX_BYTES);
    } catch (error) {
      await retryOrGiveUp(job, trackId, error instanceof Error ? error.message : String(error));
      return;
    }
    if (!downloaded) {
      await giveUp(job, trackId, "object-missing");
      return;
    }

    const original = await inspectFlacFile(inPath).catch(() => null);
    if (!original) {
      await giveUp(job, trackId, "not-flac");
      return;
    }
    if (original.channels > 2) {
      await giveUp(job, trackId, `unsupported-channels ${original.channels}`);
      return;
    }

    try {
      await (converterOverride ?? convertFlacToListenCopy)(inPath, outPath, {
        channels: original.channels,
        maxSeconds: maxCopySeconds(track.duration_ms),
      });
    } catch (error) {
      const message = error instanceof TranscodeError || error instanceof Error ? error.message : String(error);
      await retryOrGiveUp(job, trackId, message);
      return;
    }
    const outBytes = (await stat(outPath)).size;
    if (outBytes === 0) {
      await retryOrGiveUp(job, trackId, "ffmpeg produced an empty file");
      return;
    }
    // THE DELAY CHECK: the copy must decode to as many samples as the original
    // (see `speech/audio-copy.ts`). A file that does not is never offered.
    const made = await inspectOggOpusFile(outPath).catch(() => null);
    if (!made) {
      await giveUp(job, trackId, "output-not-ogg-opus");
      return;
    }
    const problem = copyLengthProblem(original, made);
    if (problem) {
      stats.lengthMismatch += 1;
      await giveUp(job, trackId, `length-mismatch ${problem}`);
      return;
    }
    // A copy that is not smaller is no copy (a stem of near-silence in a tiny FLAC, say).
    if (outBytes >= downloaded.bytes) {
      await skip(job, trackId, "not-smaller");
      return;
    }

    // RESERVE, UPLOAD, CONFIRM. The reservation is fenced on the stem the job
    // downloaded: a track whose audio were ever replaced is not given the copy of the old one.
    const reserved = await getPool().query<{ audio_listen_key: string }>(
      `UPDATE jam_tracks SET audio_listen_key = COALESCE(audio_listen_key, $2)
        WHERE id = $1 AND audio_key = $3 AND deleted_at IS NULL AND media_purged_at IS NULL
        RETURNING audio_listen_key`,
      [trackId, listenKeyFor(track.audio_key), track.audio_key],
    );
    const key = reserved.rows[0]?.audio_listen_key;
    if (!key) {
      stats.skippedGone += 1;
      await finishSpeechJob(getPool(), job, "done", "gone");
      return;
    }
    try {
      // Streamed from the file: nothing is held in memory.
      await putObjectFromFile(key, outPath, LISTEN_COPY_CONTENT_TYPE);
    } catch (error) {
      await retryOrGiveUp(job, trackId, error instanceof Error ? error.message : String(error), key);
      return;
    }

    let confirmed = false;
    let confirmFailure: unknown = null;
    // Acquiring the connection is inside the guard too: the object is already in
    // the bucket, so a pool that refuses must take the same retry or give-up path.
    let client: PoolClient | null = null;
    try {
      client = await getPool().connect();
      await client.query("BEGIN");
      if (!(await finishSpeechJob(client, job, "done"))) {
        // Not our job any more: another worker holds it (and writes the same key),
        // or the job went with its track.
        stats.lostLease += 1;
        await client.query("ROLLBACK");
        const still = await getPool().query(
          `SELECT 1 FROM jam_tracks WHERE id = $1 AND audio_listen_key = $2 AND deleted_at IS NULL`,
          [trackId, key],
        );
        if ((still.rowCount ?? 0) === 0) await dropObject(key);
        return;
      }
      const updated = await client.query(
        `UPDATE jam_tracks SET audio_listen_content_type = $5, audio_listen_bytes = $3
          WHERE id = $1 AND audio_listen_key = $2 AND audio_key = $4
            AND deleted_at IS NULL AND media_purged_at IS NULL`,
        [trackId, key, outBytes, track.audio_key, LISTEN_COPY_CONTENT_TYPE],
      );
      confirmed = (updated.rowCount ?? 0) > 0;
      await client.query("COMMIT");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      confirmFailure = error;
    } finally {
      client?.release();
    }
    if (confirmFailure) {
      // The object is in the bucket and the row does not say so: a retry rewrites
      // the same key, and giving up deletes it (`discardCopy`).
      const reason = confirmFailure instanceof Error ? confirmFailure.message : String(confirmFailure);
      await retryOrGiveUp(job, trackId, reason, key);
      return;
    }
    if (!confirmed) {
      await dropObject(key);
      stats.skippedGone += 1;
      return;
    }
    stats.made += 1;
    logEvent("jamAudioCopy.done", {
      trackId,
      inBytes: downloaded.bytes,
      outBytes,
      preSkip: made.preSkip,
      samples: made.samples,
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

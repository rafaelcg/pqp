import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JAM_VIDEO_MAX_BYTES } from "@pqp/shared";
import type { PoolClient } from "pg";
import { getPool } from "../db.js";
import { logEvent } from "../lib/log.js";
import { deleteObject, downloadObjectToFile, putObject } from "../lib/s3.js";
import { TranscodeError, UnsupportedContainerError } from "../speech/transcode.js";
import {
  convertVideoToMp4,
  demuxerOf,
  inspectMp4File,
  planFor,
  type VideoPlan,
} from "../speech/video-transcode.js";
import {
  enqueueSpeechJob,
  finishSpeechJob,
  retrySpeechJobLater,
  SPEECH_JOBS_CHANNEL,
  type SpeechJob,
} from "./speech-jobs.js";

/**
 * The MP4 copy of a Jam track's camera video (`speech_jobs` kind
 * `jam_video_transcode`, keyed by the track). WHY: Chrome records WebM and
 * iOS (AVPlayer) and Safari cannot play it; see `speech/video-transcode.ts`
 * for what the copy must keep and `packages/shared/src/jam.ts` for what a
 * track read then says.
 *
 *   enqueue   in the transaction that inserts a track WITH a video
 *             (`addJamTrack`), and by `enqueueMissingJamVideoTranscodes`
 *             for the videos that existed before this shipped (the jam sweep
 *             calls it every minute: at most `BACKFILL_QUEUE_CAP` waiting at
 *             once, newest first, so a backlog is worked off one video at a
 *             time and never floods the worker)
 *   claim     `runSpeechJobsTick`, in a lane of its own, ONE at a time, and
 *             only on a process whose ffmpeg has libx264 (`isJamTranscodeAvailable`)
 *   run       download (at most `JAM_VIDEO_MAX_BYTES`, to a file) -> look at it
 *             -> nothing / copy the streams / re-encode -> upload ->
 *             confirm on the row
 *
 * RESERVE, UPLOAD, CONFIRM, in that order (a voice note's playback copy does
 * the same): the key goes on the row before the PUT, so the sweep and the
 * channel, server and account deletes (`jam-keys.ts`), which read keys, delete
 * the copy even when it is half made; `video_mp4_content_type` is written last
 * and is all a read looks at. A confirm that matches no row (the track was
 * deleted while the file was encoding) deletes the object it just put.
 *
 * FAILURES ARE VISIBLE: every path that does not leave a copy logs
 * `jamVideo.transcode.*` with the track and the reason, bumps a counter, and a
 * job that gives up stays `failed` in `speech_jobs`, which is what `failed` on
 * `GET /api/admin/metrics` (`jamVideo`) counts. Nothing is lost by it: the
 * track still lists, with the recorded file as its video.
 */

export const JAM_VIDEO_JOB_KIND = "jam_video_transcode" as const;

/** Waiting jobs the backfill leaves in the queue at once. */
export const BACKFILL_QUEUE_CAP = 10;

const stats = {
  /** A copy was made by re-encoding. */
  transcoded: 0,
  /** A copy was made by copying the streams into a regular MP4. */
  remuxed: 0,
  /** The recorded file already plays everywhere: nothing made. */
  alreadyPlayable: 0,
  /** Gave up (attempts spent, or a file that cannot be converted). */
  failed: 0,
  retried: 0,
  skippedGone: 0,
  lostLease: 0,
  outputTooLarge: 0,
};

export type JamVideoJobMetrics = typeof stats;

/** Since boot, this process only: the database says the rest (`jam-video-metrics.ts`). */
export function jamVideoJobMetrics(): JamVideoJobMetrics {
  return { ...stats };
}

export function resetJamVideoJobMetricsForTests(): void {
  for (const key of Object.keys(stats) as (keyof typeof stats)[]) stats[key] = 0;
}

/** `jam/<server>/<id>.webm` -> `jam/<server>/<id>.ios.mp4`: same prefix, same sweeps. */
export function mp4KeyFor(videoKey: string): string {
  return videoKey.replace(/\.[^./]*$/, "") + ".ios.mp4";
}

type Queryable = Pick<PoolClient, "query">;

type Converter = typeof convertVideoToMp4;
let converterOverride: Converter | null = null;

/** Tests only: stand in for ffmpeg (CI may not have it, and a test wants to break it). `null` puts the real one back. */
export function setJamVideoConverterForTests(fn: Converter | null): void {
  converterOverride = fn;
}

/** Queue the copy of a track's video. Idempotent per track. */
export async function enqueueJamVideoTranscode(db: Queryable, trackId: string): Promise<boolean> {
  return enqueueSpeechJob(db, { kind: JAM_VIDEO_JOB_KIND, trackId });
}

/**
 * Queue the tracks that have a video, no copy and no job yet: every take
 * recorded before the copy existed. Newest first, at most `limit` per call and
 * never more than `BACKFILL_QUEUE_CAP` waiting or running at once, so a
 * backlog of a thousand videos is a trickle. Rows only (a few statements), so
 * it runs on any process whatever ffmpeg says; claiming is what needs ffmpeg.
 */
export async function enqueueMissingJamVideoTranscodes(
  limit = BACKFILL_QUEUE_CAP,
  cap = BACKFILL_QUEUE_CAP,
): Promise<number> {
  const inserted = await getPool().query(
    `WITH room AS (
       SELECT GREATEST(0, LEAST($1::int, $2::int - COUNT(*)::int)) AS n
         FROM speech_jobs
        WHERE kind = $3 AND status IN ('queued', 'running')
     ),
     candidates AS (
       SELECT t.id FROM jam_tracks t
        WHERE t.video_key IS NOT NULL AND t.video_mp4_content_type IS NULL
          AND t.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM speech_jobs j WHERE j.kind = $3 AND j.track_id = t.id)
        ORDER BY t.created_at DESC
        LIMIT (SELECT n FROM room)
     )
     INSERT INTO speech_jobs (kind, track_id)
     SELECT $3, id FROM candidates
     ON CONFLICT (kind, track_id) WHERE track_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [limit, cap, JAM_VIDEO_JOB_KIND],
  );
  const added = inserted.rowCount ?? 0;
  if (added > 0) {
    await getPool().query(`SELECT pg_notify($1, '')`, [SPEECH_JOBS_CHANNEL]);
  }
  return added;
}

interface TrackRow {
  id: string;
  video_key: string | null;
  video_content_type: string | null;
  video_mp4_content_type: string | null;
  deleted_at: Date | null;
  media_purged_at: Date | null;
}

async function loadTrack(trackId: string): Promise<TrackRow | null> {
  const found = await getPool().query<TrackRow>(
    `SELECT id::text AS id, video_key, video_content_type, video_mp4_content_type,
            deleted_at, media_purged_at
       FROM jam_tracks WHERE id = $1`,
    [trackId],
  );
  return found.rows[0] ?? null;
}

/** A failure that no retry will change: say so, count it, settle the job `failed`. */
async function giveUp(job: SpeechJob, trackId: string, reason: string): Promise<void> {
  stats.failed += 1;
  logEvent("jamVideo.transcode.failed", { trackId, attempt: job.attempts, next: "gave-up", reason: reason.slice(0, 200) });
  await finishSpeechJob(getPool(), job, "failed", reason);
}

/** A failure that may be temporary: back to the queue with backoff, or give up when the attempts are spent. */
async function retryOrGiveUp(job: SpeechJob, trackId: string, reason: string): Promise<void> {
  const next = await retrySpeechJobLater(job, reason);
  logEvent("jamVideo.transcode.failed", { trackId, attempt: job.attempts, next, reason: reason.slice(0, 200) });
  if (next === "retrying") {
    stats.retried += 1;
  } else if (next === "gave-up") {
    stats.failed += 1;
    await finishSpeechJob(getPool(), job, "failed", reason);
  }
}

async function dropObject(key: string): Promise<void> {
  await deleteObject(key).catch((error: unknown) => {
    console.error(`[jam] leaked video copy ${key}:`, error instanceof Error ? error.message : error);
  });
}

/** What a claimed `jam_video_transcode` job does. Never throws for a file it cannot convert. */
export async function runJamVideoJob(job: SpeechJob): Promise<void> {
  const trackId = job.track_id;
  if (!trackId) {
    await finishSpeechJob(getPool(), job, "failed", "no-track");
    return;
  }
  const track = await loadTrack(trackId);
  if (!track || track.deleted_at || track.media_purged_at || !track.video_key) {
    stats.skippedGone += 1;
    await finishSpeechJob(getPool(), job, "done", "gone");
    return;
  }
  if (track.video_mp4_content_type) {
    await finishSpeechJob(getPool(), job, "done", "already");
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "pqp-jam-video-"));
  try {
    const inPath = join(dir, "in");
    const outPath = join(dir, "out.mp4");
    let downloaded: { bytes: number } | null;
    try {
      downloaded = await downloadObjectToFile(track.video_key, inPath, JAM_VIDEO_MAX_BYTES);
    } catch (error) {
      await retryOrGiveUp(job, trackId, error instanceof Error ? error.message : String(error));
      return;
    }
    if (!downloaded) {
      await giveUp(job, trackId, "object-missing");
      return;
    }

    let plan: VideoPlan;
    let demuxer: "mov" | "matroska";
    try {
      demuxer = await demuxerOf(inPath);
      plan = planFor(demuxer, demuxer === "mov" ? await inspectMp4File(inPath) : null);
    } catch (error) {
      if (error instanceof UnsupportedContainerError) {
        await giveUp(job, trackId, "unsupported-container");
        return;
      }
      await retryOrGiveUp(job, trackId, error instanceof Error ? error.message : String(error));
      return;
    }

    if (plan === "none") {
      stats.alreadyPlayable += 1;
      logEvent("jamVideo.transcode.skipped", { trackId, reason: "already-playable" });
      await finishSpeechJob(getPool(), job, "done", "already-playable");
      return;
    }

    try {
      await (converterOverride ?? convertVideoToMp4)(inPath, outPath, demuxer, plan);
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
    // The same ceiling as the upload: a copy bigger than the largest video a
    // person may upload is not worth serving, and it says something is wrong.
    if (outBytes > JAM_VIDEO_MAX_BYTES) {
      stats.outputTooLarge += 1;
      await giveUp(job, trackId, `output-too-large ${outBytes}`);
      return;
    }

    // RESERVE, UPLOAD, CONFIRM.
    const reserved = await getPool().query<{ video_mp4_key: string }>(
      `UPDATE jam_tracks SET video_mp4_key = COALESCE(video_mp4_key, $2)
        WHERE id = $1 AND deleted_at IS NULL AND media_purged_at IS NULL
        RETURNING video_mp4_key`,
      [trackId, mp4KeyFor(track.video_key)],
    );
    const key = reserved.rows[0]?.video_mp4_key;
    if (!key) {
      stats.skippedGone += 1;
      await finishSpeechJob(getPool(), job, "done", "gone");
      return;
    }
    try {
      await putObject(key, await readFile(outPath), "video/mp4");
    } catch (error) {
      await retryOrGiveUp(job, trackId, error instanceof Error ? error.message : String(error));
      return;
    }

    const client = await getPool().connect();
    let confirmed = false;
    try {
      await client.query("BEGIN");
      if (!(await finishSpeechJob(client, job, "done"))) {
        // Not our job any more: another worker holds it (and writes the same
        // key), or the job went with its track.
        stats.lostLease += 1;
        await client.query("ROLLBACK");
        const still = await getPool().query(
          `SELECT 1 FROM jam_tracks WHERE id = $1 AND video_mp4_key = $2 AND deleted_at IS NULL`,
          [trackId, key],
        );
        if ((still.rowCount ?? 0) === 0) await dropObject(key);
        return;
      }
      const updated = await client.query(
        `UPDATE jam_tracks SET video_mp4_content_type = 'video/mp4', video_mp4_bytes = $3
          WHERE id = $1 AND video_mp4_key = $2 AND deleted_at IS NULL AND media_purged_at IS NULL`,
        [trackId, key, outBytes],
      );
      confirmed = (updated.rowCount ?? 0) > 0;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (!confirmed) {
      await dropObject(key);
      stats.skippedGone += 1;
      return;
    }
    if (plan === "remux") stats.remuxed += 1;
    else stats.transcoded += 1;
    logEvent("jamVideo.transcode.done", {
      trackId,
      plan,
      from: track.video_content_type,
      inBytes: downloaded.bytes,
      outBytes,
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

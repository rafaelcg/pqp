import {
  VOICE_NOTE_TRANSCRIPT_MAX_LENGTH,
  type NoteTranscriptStatus,
  type VoiceNoteTranscript,
} from "@pqp/shared";
import type { PoolClient } from "pg";
import { getPool } from "../db.js";
import { startAdaptivePoller, type AdaptivePoller } from "../lib/adaptive-poller.js";
import { logEvent } from "../lib/log.js";
import { deleteObject, getObjectPrefix, isStorageConfigured, putObject } from "../lib/s3.js";
import { readContainerDuration, type ContainerInfo } from "../speech/container-duration.js";
import { collapseLoops } from "../speech/metrics.js";
import { selectSttProvider } from "../speech/select.js";
import { isFfmpegAvailable, transcodeToAac } from "../speech/transcode.js";
import type { SttResult } from "../speech/types.js";
import { broadcastToChannel } from "../ws/chat.js";
import { isTranscriptionOnFor } from "./attachments.js";
import {
  claimSpeechJobs,
  dropSpeechJob,
  finishSpeechJob,
  reserveSpeechSeconds,
  retrySpeechJobLater,
  SPEECH_JOBS_CHANNEL,
  type SpeechJob,
  type SpeechJobKind,
} from "./speech-jobs.js";

/**
 * The worker half of voice notes: what a claimed `speech_jobs` row does.
 * Runs in `jobs.ts`, so on `pqp-worker` in production and inside the one
 * process everywhere else.
 *
 *   voice_note       download (at most 5 MiB) → read the container's length →
 *                    the flag, again → budget → provider → collapse Whisper's
 *                    loops → drop what it marked as no speech → store →
 *                    `voice-note-transcript` to the note's channel
 *   voice_transcode  download → ffmpeg to AAC → reserve the key → upload →
 *                    confirm → `voice-note-updated` to the note's channel
 *
 * NOTHING IS SENT FROM HERE TO A SOCKET DIRECTLY. The worker has none: the
 * frames go through `broadcastToChannel`, which on the worker is the cluster
 * bus (publish only) and reaches the API's sockets through its relay. That is
 * why both frame types are in `CHAT_SERVER_MESSAGE_TYPES`.
 *
 * "SAYS WHY": every path that does not produce text logs it and bumps a
 * counter (`speechJobMetrics`).
 */

/** The largest note is ~4.8 MiB (`noteByteBudget` at five minutes). */
export const SPEECH_DOWNLOAD_MAX_BYTES = 5 * 1024 * 1024;
/** Segments Whisper itself rated at least this likely to be silence are dropped. */
export const NO_SPEECH_PROB_THRESHOLD = 0.6;
const PROVIDER_TIMEOUT_MS = 90_000;
/** Jobs in flight per tick. A provider call is I/O; a transcode is a short burst of one core. */
const CONCURRENCY = 2;

const stats = {
  done: 0,
  noSpeech: 0,
  unavailable: 0,
  overBudget: 0,
  failed: 0,
  retried: 0,
  droppedFlagOff: 0,
  skippedGone: 0,
  transcoded: 0,
  transcodeFailed: 0,
  durationMismatch: 0,
  lostLease: 0,
};

export type SpeechJobMetrics = typeof stats;

export function speechJobMetrics(): SpeechJobMetrics {
  return { ...stats };
}

export function resetSpeechJobMetricsForTests(): void {
  for (const key of Object.keys(stats) as (keyof typeof stats)[]) stats[key] = 0;
}

interface NoteRow {
  attachment_id: string;
  message_id: string | null;
  channel_id: string;
  server_id: string | null;
  storage_key: string | null;
  content_type: string;
  duration_ms: number;
  verified_duration_ms: number | null;
  transcribe_allowed: boolean;
  transcript_status: NoteTranscriptStatus;
  playback_key: string | null;
  playback_content_type: string | null;
}

async function loadNote(attachmentId: string): Promise<NoteRow | null> {
  const found = await getPool().query<NoteRow>(
    `SELECT v.attachment_id, a.message_id, a.channel_id, c.server_id,
            a.storage_key, a.content_type, v.duration_ms, v.verified_duration_ms,
            v.transcribe_allowed, v.transcript_status, v.playback_key,
            v.playback_content_type
       FROM message_attachment_voice v
       JOIN message_attachments a ON a.id = v.attachment_id
       JOIN channels c ON c.id = a.channel_id
      WHERE v.attachment_id = $1`,
    [attachmentId],
  );
  return found.rows[0] ?? null;
}

function formatFor(contentType: string): string {
  return contentType === "audio/mp4" ? "m4a" : contentType === "audio/ogg" ? "ogg" : "webm";
}

/**
 * The duration and codec the container says, written once (the first job to
 * see the bytes). A claim more than two seconds off the container is logged:
 * the card still shows what the sender said, the budget is charged by this.
 */
async function recordContainer(db: Pick<PoolClient, "query">, note: NoteRow, info: ContainerInfo | null): Promise<void> {
  if (!info || note.verified_duration_ms !== null) return;
  if (Math.abs(info.durationMs - note.duration_ms) > 2_000) {
    stats.durationMismatch += 1;
    logEvent("voiceNote.durationMismatch", {
      attachmentId: note.attachment_id,
      claimedMs: note.duration_ms,
      containerMs: info.durationMs,
    });
  }
  await db.query(
    `UPDATE message_attachment_voice
        SET verified_duration_ms = $2, codec = COALESCE(codec, $3)
      WHERE attachment_id = $1 AND verified_duration_ms IS NULL`,
    [note.attachment_id, info.durationMs, info.codec],
  );
}

/** Whisper's text, with what it said it did not hear removed and its loops collapsed. */
export function cleanTranscript(result: SttResult): { text: string; noSpeech: boolean } {
  let text: string;
  if (result.segments.length > 0) {
    const kept = result.segments.filter(
      (segment) => !(typeof segment.noSpeechProb === "number" && segment.noSpeechProb >= NO_SPEECH_PROB_THRESHOLD),
    );
    if (kept.length === 0) return { text: "", noSpeech: true };
    text = kept.map((segment) => segment.text.trim()).filter(Boolean).join(" ");
  } else {
    text = result.text;
  }
  text = collapseLoops(text.replace(/\s+/g, " ").trim()).text.trim();
  if (text.length === 0) return { text: "", noSpeech: true };
  return { text: text.slice(0, VOICE_NOTE_TRANSCRIPT_MAX_LENGTH), noSpeech: false };
}

function broadcastTranscript(note: NoteRow, transcript: VoiceNoteTranscript): void {
  // Visibility matches the audio's: the frame goes to the note's own channel,
  // so exactly the sockets allowed to read that channel receive it. Not sent
  // at all while the flag is off where the note lives (it would be hidden on
  // every read anyway).
  if (!note.message_id || !isTranscriptionOnFor(note.server_id)) return;
  broadcastToChannel(note.channel_id, {
    type: "voice-note-transcript",
    channelId: note.channel_id,
    messageId: note.message_id,
    attachmentId: note.attachment_id,
    transcript,
  });
}

/** Write the outcome and settle the job in one transaction, fenced by the lease. */
async function settleTranscript(
  job: SpeechJob,
  note: NoteRow,
  outcome: { status: NoteTranscriptStatus; text?: string | null; language?: string | null; provider?: string | null },
  info: ContainerInfo | null,
  jobOutcome: "done" | "failed" = "done",
  error: string | null = null,
): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (!(await finishSpeechJob(client, job, jobOutcome, error))) {
      await client.query("ROLLBACK");
      stats.lostLease += 1;
      return false;
    }
    await recordContainer(client, note, info);
    await client.query(
      `UPDATE message_attachment_voice
          SET transcript_status = $2, transcript_text = $3,
              transcript_language = $4, transcript_provider = $5,
              transcribed_at = NOW()
        WHERE attachment_id = $1`,
      [note.attachment_id, outcome.status, outcome.text ?? null, outcome.language ?? null, outcome.provider ?? null],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  broadcastTranscript(note, {
    status: outcome.status,
    text: outcome.status === "done" ? (outcome.text ?? "") : null,
    language: outcome.language ?? null,
  });
  return true;
}

/** The flag went off where the note lives: drop the job, the note back to `none`. */
async function dropForFlagOff(job: SpeechJob, note: NoteRow): Promise<void> {
  stats.droppedFlagOff += 1;
  logEvent("voiceNote.transcription.skipped", { attachmentId: note.attachment_id, reason: "flag-off" });
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (await dropSpeechJob(client, job)) {
      await client.query(
        `UPDATE message_attachment_voice SET transcript_status = 'none'
          WHERE attachment_id = $1 AND transcript_status = 'pending'`,
        [note.attachment_id],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function runVoiceNoteJob(job: SpeechJob): Promise<void> {
  const note = await loadNote(job.attachment_id!);
  if (!note || !note.message_id || !note.storage_key) {
    // Deleted, or its message was: nobody can read a transcript now.
    stats.skippedGone += 1;
    await finishSpeechJob(getPool(), job, "done", "gone");
    return;
  }

  // THE FLAG AGAIN, before anything costs money. Off since the enqueue: drop
  // the job and put the note back to `none`, so a request after the flag
  // comes back on can queue it afresh. No provider call, no budget. Asked
  // once more right before the call (below), with no await in between.
  if (!isTranscriptionOnFor(note.server_id)) {
    await dropForFlagOff(job, note);
    return;
  }
  if (!note.transcribe_allowed) {
    await finishSpeechJob(getPool(), job, "done", "sender-declined");
    return;
  }

  const selected = selectSttProvider();
  if (!selected) {
    stats.unavailable += 1;
    logEvent("voiceNote.transcription.skipped", { attachmentId: note.attachment_id, reason: "no-provider" });
    await settleTranscript(job, note, { status: "unavailable" }, null, "done", "no-provider");
    return;
  }

  const bytes = await getObjectPrefix(note.storage_key, SPEECH_DOWNLOAD_MAX_BYTES);
  if (!bytes) {
    stats.failed += 1;
    await settleTranscript(job, note, { status: "failed" }, null, "failed", "object-missing");
    return;
  }
  const info = readContainerDuration(bytes);

  // The download took time the operator may have used: ask before spending
  // budget, and once more after it, synchronously, right before the call.
  if (!isTranscriptionOnFor(note.server_id)) {
    await dropForFlagOff(job, note);
    return;
  }
  // Charged by the longer of what the sender stated and what the container
  // says, so neither a client nor a crafted header can shrink the bill.
  const seconds = Math.max(1, Math.ceil(Math.max(info?.durationMs ?? 0, note.duration_ms) / 1000));
  if (!(await reserveSpeechSeconds(seconds))) {
    stats.overBudget += 1;
    logEvent("voiceNote.transcription.skipped", { attachmentId: note.attachment_id, reason: "over-budget", seconds });
    await settleTranscript(job, note, { status: "unavailable" }, info, "done", "over-budget");
    return;
  }

  if (!isTranscriptionOnFor(note.server_id)) {
    // Spent budget stays spent (it is a few seconds); the audio stays here.
    await dropForFlagOff(job, note);
    return;
  }
  let result: SttResult;
  try {
    // No await between the check above and this call.
    result = await selected.provider.transcribe(Buffer.from(bytes), {
      format: formatFor(note.content_type),
      durationMs: info?.durationMs ?? note.duration_ms,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      ...(job.language_hint ? { language: job.language_hint } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const next = await retrySpeechJobLater(job, message);
    logEvent("voiceNote.transcription.providerError", {
      attachmentId: note.attachment_id,
      attempt: job.attempts,
      next,
      error: message.slice(0, 200),
    });
    if (next === "retrying") {
      stats.retried += 1;
    } else if (next === "gave-up") {
      stats.failed += 1;
      await settleTranscript(job, note, { status: "failed" }, info, "failed", message);
    }
    return;
  }

  const cleaned = cleanTranscript(result);
  const settled = await settleTranscript(
    job,
    note,
    cleaned.noSpeech
      ? { status: "no_speech", language: result.language ?? null, provider: selected.provider.id }
      : { status: "done", text: cleaned.text, language: result.language ?? null, provider: selected.provider.id },
    info,
  );
  if (settled) {
    if (cleaned.noSpeech) stats.noSpeech += 1;
    else stats.done += 1;
  }
}

/** `<channel>/<uuid>.webm` → `<channel>/<uuid>.playback.m4a`: same prefix, same sweeps. */
export function playbackKeyFor(storageKey: string): string {
  return storageKey.replace(/\.[^./]*$/, "") + ".playback.m4a";
}

async function runTranscodeJob(job: SpeechJob): Promise<void> {
  const note = await loadNote(job.attachment_id!);
  if (!note || !note.message_id || !note.storage_key) {
    stats.skippedGone += 1;
    await finishSpeechJob(getPool(), job, "done", "gone");
    return;
  }
  if (note.playback_content_type) {
    await finishSpeechJob(getPool(), job, "done", "already");
    return;
  }

  const fail = async (reason: string) => {
    const next = await retrySpeechJobLater(job, reason);
    logEvent("voiceNote.transcode.failed", { attachmentId: note.attachment_id, attempt: job.attempts, next, reason: reason.slice(0, 200) });
    if (next === "gave-up") {
      stats.transcodeFailed += 1;
      await finishSpeechJob(getPool(), job, "failed", reason);
    }
  };

  const bytes = await getObjectPrefix(note.storage_key, SPEECH_DOWNLOAD_MAX_BYTES);
  if (!bytes) {
    stats.transcodeFailed += 1;
    await finishSpeechJob(getPool(), job, "failed", "object-missing");
    return;
  }
  await recordContainer(getPool(), note, readContainerDuration(bytes));

  let output: Buffer;
  try {
    output = await transcodeToAac(bytes, note.content_type === "audio/ogg" ? ".ogg" : ".webm");
  } catch (error) {
    await fail(error instanceof Error ? error.message : String(error));
    return;
  }

  // RESERVE, UPLOAD, CONFIRM, in that order, so no delete path can miss the
  // object. The key is on the row before the PUT, so a channel or account
  // deletion that reads keys after this point deletes it (or finds it not yet
  // there). If the row is gone by the time the PUT lands, the confirm matches
  // nothing and the object is deleted here. Reads expose the copy only once
  // its type is set, which happens last.
  const reserved = await getPool().query<{ playback_key: string }>(
    `UPDATE message_attachment_voice SET playback_key = COALESCE(playback_key, $2)
      WHERE attachment_id = $1
      RETURNING playback_key`,
    [note.attachment_id, playbackKeyFor(note.storage_key)],
  );
  const key = reserved.rows[0]?.playback_key;
  if (!key) {
    stats.skippedGone += 1;
    await finishSpeechJob(getPool(), job, "done", "gone");
    return;
  }
  try {
    await putObject(key, output, "audio/mp4");
  } catch (error) {
    await fail(error instanceof Error ? error.message : String(error));
    return;
  }
  const client = await getPool().connect();
  let confirmed = false;
  try {
    await client.query("BEGIN");
    if (!(await finishSpeechJob(client, job, "done"))) {
      // Not our job any more: either another worker holds it (and will write
      // the same key), or the job went with its attachment. In the second case
      // nothing names the object we just PUT, so it is deleted here.
      stats.lostLease += 1;
      await client.query("ROLLBACK");
      const still = await getPool().query(
        `SELECT 1 FROM message_attachment_voice WHERE attachment_id = $1 AND playback_key = $2`,
        [note.attachment_id, key],
      );
      if ((still.rowCount ?? 0) === 0) {
        await deleteObject(key).catch((error: unknown) => {
          console.error(`[speech] leaked playback object ${key}:`, error instanceof Error ? error.message : error);
        });
      }
      return;
    }
    const updated = await client.query(
      `UPDATE message_attachment_voice SET playback_content_type = 'audio/mp4'
        WHERE attachment_id = $1 AND playback_key = $2`,
      [note.attachment_id, key],
    );
    confirmed = (updated.rowCount ?? 0) > 0;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  if (!confirmed) {
    await deleteObject(key).catch((error: unknown) => {
      console.error(`[speech] leaked playback object ${key}:`, error instanceof Error ? error.message : error);
    });
    stats.skippedGone += 1;
    return;
  }
  stats.transcoded += 1;
  broadcastToChannel(note.channel_id, {
    type: "voice-note-updated",
    channelId: note.channel_id,
    messageId: note.message_id,
    attachmentId: note.attachment_id,
    playbackReady: true,
  });
}

async function runJob(job: SpeechJob): Promise<void> {
  try {
    if (job.kind === "voice_note") await runVoiceNoteJob(job);
    else if (job.kind === "voice_transcode") await runTranscodeJob(job);
  } catch (error) {
    // Anything unexpected (the database, storage) is a retry, never a crash.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[speech] ${job.kind} job ${job.id} failed:`, message);
    const next = await retrySpeechJobLater(job, message).catch(() => "lost" as const);
    if (next === "gave-up") {
      stats.failed += 1;
      await finishSpeechJob(getPool(), job, "failed", message).catch(() => undefined);
      if (job.kind === "voice_note" && job.attachment_id) {
        await getPool()
          .query(
            `UPDATE message_attachment_voice SET transcript_status = 'failed'
              WHERE attachment_id = $1 AND transcript_status = 'pending'`,
            [job.attachment_id],
          )
          .catch(() => undefined);
      }
    }
  }
}

/** The kinds this process can run. Transcoding needs ffmpeg; nothing claims what it cannot do. */
export async function runnableSpeechJobKinds(): Promise<SpeechJobKind[]> {
  const kinds: SpeechJobKind[] = ["voice_note"];
  if (await isFfmpegAvailable()) kinds.push("voice_transcode");
  return kinds;
}

/**
 * One tick: claim what is due and run it. Skipped without storage (there are
 * no bytes to read), which leaves the rows for a process that has some.
 */
export async function runSpeechJobsTick(): Promise<number> {
  if (!isStorageConfigured()) return 0;
  const jobs = await claimSpeechJobs(await runnableSpeechJobKinds(), CONCURRENCY);
  await Promise.all(jobs.map((job) => runJob(job)));
  return jobs.length;
}

/** Started by `jobs.ts`: 1 s while busy, backing off to 30 s, woken by the enqueue's NOTIFY. */
export function startSpeechJobPoller(): AdaptivePoller {
  return startAdaptivePoller({
    name: "speech-jobs",
    channel: SPEECH_JOBS_CHANNEL,
    minMs: 1_000,
    maxMs: 30_000,
    run: runSpeechJobsTick,
  });
}

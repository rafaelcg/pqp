import { open, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMUNITY_HOME_MAX_BYTES } from "@pqp/shared";
import { getPool } from "../db.js";
import { logEvent } from "../lib/log.js";
import { downloadObjectToFile } from "../lib/s3.js";
import { buildCaptionCues, captionCuesHash } from "../speech/captions.js";
import { planWindows, stitchWindows, type WindowResult } from "../speech/chunker.js";
import { selectSttProvider } from "../speech/select.js";
import {
  extractPcm16k,
  pcmToWav,
  PCM16K_BYTES_PER_SECOND,
  TranscodeError,
  UnsupportedContainerError,
} from "../speech/transcode.js";
import {
  bumpCaptionStat,
  communityHomeCaptionsMaxSeconds,
  isCommunityHomeCaptionsOn,
  noteCaptionError,
  translateCaptionsEverywhere,
} from "./community-home-captions.js";
import {
  dropSpeechJob,
  finishSpeechJob,
  reserveSpeechSeconds,
  retrySpeechJobLater,
  speechDailySeconds,
  type SpeechJob,
} from "./speech-jobs.js";

/**
 * What a claimed `community_home_captions` job does, on the worker (it needs
 * ffmpeg, so `runnableSpeechJobKinds` only offers it where ffmpeg runs):
 *
 *   the post (still published, still this video, the flag still on)
 *     -> download the video to a temporary file (never into memory)
 *     -> ffmpeg: the first audio stream as 16 kHz mono PCM, at most
 *        `COMMUNITY_HOME_CAPTIONS_MAX_SECONDS`
 *     -> the day's speech budget, reserved for the whole length at once
 *     -> Whisper over 30 s windows with 1 s of overlap, one call at a time,
 *        the language detected on the first window that has words and then
 *        held, the flag asked again before every call
 *     -> stitched, turned into cues, stored as the source track, fenced by
 *        the lease and by the post still pointing at the same object
 *     -> translated into the other UI languages (`translateCaptionsEverywhere`)
 *
 * Windows of 30 s: Whisper's own window, a request of about 1.3 MB of base64
 * WAV, well inside Workers AI's 30 s call budget. The overlap is what lets
 * `stitchWindows` keep a word cut at the boundary.
 */

export const CAPTIONS_WINDOW = { windowMs: 30_000, overlapMs: 1_000 };
const PROVIDER_TIMEOUT_MS = 90_000;
/** The job gives up on itself well inside its lease (`CAPTIONS_JOB_LEASE_SECONDS`). */
const JOB_TIMEOUT_MS = 20 * 60_000;

type ExtractAudio = (videoPath: string, pcmPath: string, maxSeconds: number) => Promise<{ durationMs: number }>;
let extractOverride: ExtractAudio | null = null;

/** Tests only: stand in for ffmpeg (CI may not have it). `null` puts the real one back. */
export function setCaptionsAudioExtractorForTests(fn: ExtractAudio | null): void {
  extractOverride = fn;
}

interface PostRow {
  id: string;
  server_id: string;
  status: string;
  media_kind: string | null;
  media_storage_key: string | null;
}

async function loadPost(postId: string): Promise<PostRow | null> {
  const { rows } = await getPool().query<PostRow>(
    `SELECT id, server_id, status, media_kind, media_storage_key
       FROM community_home_posts WHERE id = $1`,
    [postId],
  );
  return rows[0] ?? null;
}

async function settleWithoutTrack(job: SpeechJob, reason: string, outcome: "done" | "failed" = "done"): Promise<void> {
  if (!(await finishSpeechJob(getPool(), job, outcome, reason))) {
    bumpCaptionStat("lostLease");
  }
}

async function dropForFlagOff(job: SpeechJob, postId: string): Promise<void> {
  bumpCaptionStat("droppedFlagOff");
  logEvent("communityHome.captions.skipped", { postId, reason: "flag-off" });
  // Deleted rather than settled: with no row, the sweep queues it again the
  // minute the flag comes back on.
  await dropSpeechJob(getPool(), job);
}

/** Read one window of the PCM file and wrap it as a WAV. */
async function readWindow(pcmPath: string, startMs: number, endMs: number): Promise<Buffer> {
  const handle = await open(pcmPath, "r");
  try {
    const from = Math.floor(startMs / 1000 * PCM16K_BYTES_PER_SECOND) & ~1;
    const to = Math.floor(endMs / 1000 * PCM16K_BYTES_PER_SECOND) & ~1;
    const buffer = Buffer.alloc(Math.max(0, to - from));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
    return pcmToWav(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/**
 * Before every window: is this job still ours, and does the post still play
 * this file? An edit that replaced or removed the video deletes the job row;
 * an unpublish leaves it. Either way not one more second of that sound goes
 * to the provider.
 */
async function stillWanted(job: SpeechJob, mediaKey: string): Promise<"yes" | "lost" | "gone"> {
  const { rows } = await getPool().query<{ ours: boolean; current: boolean }>(
    `SELECT TRUE AS ours,
            (p.status = 'published' AND p.media_storage_key = $3) AS current
       FROM speech_jobs j
       JOIN community_home_posts p ON p.id = j.post_id
      WHERE j.id = $1 AND j.leased_by = $2 AND j.status = 'running'`,
    [job.id, job.leased_by, mediaKey],
  );
  if (!rows[0]) return "lost";
  return rows[0].current ? "yes" : "gone";
}

/** Never throws: anything unexpected is a retry with backoff, like a voice note. */
export async function runCommunityHomeCaptionsJob(job: SpeechJob): Promise<void> {
  try {
    await runJobOnce(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    noteCaptionError(message);
    const next = await retrySpeechJobLater(job, message).catch(() => "lost" as const);
    logEvent("communityHome.captions.failed", {
      postId: job.post_id,
      attempt: job.attempts,
      next,
      error: message.slice(0, 200),
    });
    if (next === "retrying") {
      bumpCaptionStat("retried");
    } else if (next === "gave-up") {
      bumpCaptionStat("failed");
      await settleWithoutTrack(job, message, "failed").catch(() => undefined);
    }
  }
}

async function runJobOnce(job: SpeechJob): Promise<void> {
  const postId = job.post_id;
  const post = postId ? await loadPost(postId) : null;
  if (!post || post.status !== "published" || post.media_kind !== "video" || !post.media_storage_key) {
    bumpCaptionStat("skippedGone");
    await settleWithoutTrack(job, "gone");
    return;
  }
  const mediaKey = post.media_storage_key;
  if (!isCommunityHomeCaptionsOn(post.server_id)) {
    await dropForFlagOff(job, post.id);
    return;
  }
  const selected = selectSttProvider();
  if (!selected) {
    bumpCaptionStat("unavailable");
    logEvent("communityHome.captions.skipped", { postId: post.id, reason: "no-provider" });
    await settleWithoutTrack(job, "no-provider");
    return;
  }
  // Not even a minute of today's budget left: do not download 100 MiB to find
  // out. The sweep offers the job again in an hour.
  const budgetLeft = await getPool().query<{ seconds: number }>(
    `SELECT seconds FROM speech_usage_daily WHERE day = (NOW() AT TIME ZONE 'UTC')::date`,
  );
  if (speechDailySeconds() - (budgetLeft.rows[0]?.seconds ?? 0) < 60) {
    bumpCaptionStat("overBudget");
    logEvent("communityHome.captions.skipped", { postId: post.id, reason: "over-budget" });
    await settleWithoutTrack(job, "over-budget");
    return;
  }

  const signal = AbortSignal.timeout(JOB_TIMEOUT_MS);
  const dir = await mkdtemp(join(tmpdir(), "pqp-captions-"));
  try {
    const videoPath = join(dir, "video");
    const pcmPath = join(dir, "audio.pcm");
    // A little slack over the upload cap: the claim HEADs what was stored, and
    // this is a guard against a wrong object, not a second size rule.
    const downloaded = await downloadObjectToFile(mediaKey, videoPath, COMMUNITY_HOME_MAX_BYTES + 1024 * 1024);
    if (!downloaded) {
      bumpCaptionStat("failed");
      await settleWithoutTrack(job, "object-missing", "failed");
      return;
    }

    let durationMs: number;
    try {
      const extract = extractOverride ?? extractPcm16k;
      ({ durationMs } = await extract(videoPath, pcmPath, communityHomeCaptionsMaxSeconds()));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Not an MP4 or a WebM: never handed to ffmpeg (see `videoDemuxerFor`).
      if (error instanceof UnsupportedContainerError) {
        bumpCaptionStat("noAudio");
        logEvent("communityHome.captions.skipped", { postId: post.id, reason: "unsupported-container" });
        await settleWithoutTrack(job, "unsupported-container");
        return;
      }
      // A video with no sound track has nothing to caption. Anything else
      // ffmpeg says is a corrupt or odd file: retried, then failed.
      if (error instanceof TranscodeError && /matches no streams|does not contain any stream|Output file is empty/i.test(message)) {
        bumpCaptionStat("noAudio");
        await settleWithoutTrack(job, "no-audio");
        return;
      }
      throw error;
    }
    if (durationMs < 500) {
      bumpCaptionStat("noAudio");
      await settleWithoutTrack(job, "no-audio");
      return;
    }

    const windows = planWindows(durationMs, CAPTIONS_WINDOW);
    // Charged for what is sent, overlaps included, before the first call and
    // never refunded: the same rule as a voice note.
    const seconds = Math.ceil(windows.reduce((n, w) => n + (w.endMs - w.startMs), 0) / 1000);
    if (!isCommunityHomeCaptionsOn(post.server_id)) {
      await dropForFlagOff(job, post.id);
      return;
    }
    if (!(await reserveSpeechSeconds(seconds))) {
      bumpCaptionStat("overBudget");
      logEvent("communityHome.captions.skipped", { postId: post.id, reason: "over-budget", seconds });
      await settleWithoutTrack(job, "over-budget");
      return;
    }
    bumpCaptionStat("secondsSent", seconds);

    const results: WindowResult[] = [];
    let language: string | undefined;
    for (const window of windows) {
      const audio = await readWindow(pcmPath, window.startMs, window.endMs);
      const wanted = await stillWanted(job, mediaKey);
      if (wanted === "lost") {
        bumpCaptionStat("lostLease");
        return;
      }
      if (wanted === "gone") {
        bumpCaptionStat("skippedGone");
        logEvent("communityHome.captions.skipped", { postId: post.id, reason: "video-changed" });
        await settleWithoutTrack(job, "gone");
        return;
      }
      if (!isCommunityHomeCaptionsOn(post.server_id)) {
        // Spent budget stays spent; nothing more leaves the box.
        await dropForFlagOff(job, post.id);
        return;
      }
      // No await between the check above and this call.
      const result = await selected.provider.transcribe(audio, {
        format: "wav",
        durationMs: window.endMs - window.startMs,
        signal: AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)]),
        ...(language ? { language } : {}),
      });
      bumpCaptionStat("windows");
      results.push({ window, segments: result.segments });
      if (!language && result.segments.some((s) => s.text.trim()) && result.language) {
        language = result.language;
      }
    }

    const cues = buildCaptionCues(stitchWindows(results));
    if (cues.length === 0) {
      bumpCaptionStat("noSpeech");
      logEvent("communityHome.captions.noSpeech", { postId: post.id, seconds });
      await settleWithoutTrack(job, "no-speech");
      return;
    }

    // "und" (BCP 47 for undetermined) when the provider did not say: the
    // track is still shown, and its translations are asked for "whatever
    // language this is".
    const sourceLang = language ?? "und";
    const stored = await storeSourceTrack(job, post, mediaKey, sourceLang, cues, durationMs, selected.provider.id);
    if (!stored) return;
    bumpCaptionStat("done");
    logEvent("communityHome.captions.done", { postId: post.id, language: sourceLang, cues: cues.length, seconds });
    await translateCaptionsEverywhere(post.id, post.server_id, sourceLang);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Settle the job and write the track in one transaction. Written only if this
 * worker still holds the job AND the post still points at the object the
 * sound came from; every older track of the post goes with it (a new
 * transcription makes every translation of the old one meaningless).
 */
async function storeSourceTrack(
  job: SpeechJob,
  post: PostRow,
  mediaKey: string,
  language: string,
  cues: ReturnType<typeof buildCaptionCues>,
  durationMs: number,
  provider: string,
): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const still = await client.query(
      `SELECT 1 FROM community_home_posts
        WHERE id = $1 AND media_storage_key = $2 AND status = 'published'
        FOR SHARE`,
      [post.id, mediaKey],
    );
    const current = (still.rowCount ?? 0) > 0;
    // Replaced, unpublished or deleted while Whisper listened: settle the job
    // and show nothing.
    if (!(await finishSpeechJob(client, job, "done", current ? null : "gone"))) {
      await client.query("ROLLBACK");
      bumpCaptionStat("lostLease");
      return false;
    }
    if (!current) {
      await client.query("COMMIT");
      bumpCaptionStat("skippedGone");
      return false;
    }
    await client.query(`DELETE FROM community_home_post_captions WHERE post_id = $1`, [post.id]);
    const hash = captionCuesHash(cues);
    await client.query(
      `INSERT INTO community_home_post_captions
         (post_id, lang, is_source, media_key, cues, source_lang, source_hash, made_by, duration_ms)
       VALUES ($1, $2, TRUE, $3, $4::jsonb, $2, $5, $6, $7)`,
      [post.id, language, mediaKey, JSON.stringify(cues), hash, provider, durationMs],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

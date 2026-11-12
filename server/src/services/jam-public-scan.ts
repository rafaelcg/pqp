import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JAM_PUBLIC_VIDEO_FRAME_INTERVAL_S,
  JAM_PUBLIC_VIDEO_FRAMES_MAX,
  JAM_VIDEO_MAX_BYTES,
} from "@pqp/shared";
import { getPool } from "../db.js";
import {
  deleteObject,
  downloadObjectToFile,
  isStorageConfigured,
  presignGet,
  putObject,
} from "../lib/s3.js";
import { isFfmpegAvailable } from "../speech/transcode.js";
import {
  combineScans,
  contentScanProvider,
  isContentScanConfigured,
  quarantineDays,
  SCAN_URL_TTL_SECONDS,
  scanImage,
  scanReportReason,
  type ScanResult,
} from "./content-scan.js";
import { createAutomatedInstanceReport } from "./reports.js";

/**
 * PUBLIC JAMS' SCANS (docs/JAM_PUBLIC.md §"What is scanned";
 * docs/CONTENT_SAFETY.md, "Public jams"). A cold path from `jobs.ts`, so it
 * runs on the worker under `WORKER_MODE`, and safe on two processes: every job
 * is claimed with a lease (`FOR UPDATE SKIP LOCKED`), so two processes do
 * duplicate work at worst, never wrong work.
 *
 *  - COVERS: the image scanner, once per cover object. Any process claims
 *    them (no ffmpeg needed).
 *  - VIDEOS: ffmpeg samples frames (the first, then one every
 *    `JAM_PUBLIC_VIDEO_FRAME_INTERVAL_S`, at most `JAM_PUBLIC_VIDEO_FRAMES_MAX`)
 *    and each goes through the same scanner. Only a process with ffmpeg claims
 *    one (`isFfmpegAvailable`, the transcode jobs' rule), so the API container
 *    leaves them for the worker.
 *  - AUDIO: not scanned. Nothing here listens.
 *
 * Neither is claimed until `UPLOAD_SETTLE` after its upload was signed: the
 * presigned PUT is good for 15 minutes, and judging the bytes before the URL
 * that can replace them has expired would judge bytes that may not be the ones
 * shown (residual risk 9 in CONTENT_SAFETY.md, closed here by waiting). The
 * public version of a track is its audio meanwhile.
 *
 * Outcomes, for both:
 *   pass                 → `passed`: public.
 *   flagged              → `flagged`: NOT public (a public site is stricter
 *                          than a channel), a report to the instance queue.
 *   rejected             → `rejected`: quarantined (the object is kept as
 *                          evidence, `jam_public_quarantine`, and taken off the
 *                          song in the channel too), a report to the instance
 *                          queue, an `illegal` label logged loudly and never
 *                          auto-deleted.
 *   error                → tried again (at most `MAX_ATTEMPTS`), then
 *                          `unscanned` with a `scan_error` label: not public.
 *   no provider          → `unscanned`: not public, and honest about it.
 *   (video) unreadable   → `skipped`: not public.
 */

const LEASE = "5 minutes";
const MAX_ATTEMPTS = 3;
const UPLOAD_SETTLE = "16 minutes";

// ---------------------------------------------------------------- counters

const counters = {
  coversPassed: 0,
  coversFlagged: 0,
  coversRejected: 0,
  coversUnscanned: 0,
  videosPassed: 0,
  videosFlagged: 0,
  videosRejected: 0,
  videosUnscanned: 0,
  videosSkipped: 0,
  framesScanned: 0,
  failures: 0,
};

export function jamPublicScanCounters(): typeof counters {
  return { ...counters };
}

export function resetJamPublicScanCountersForTests(): void {
  for (const key of Object.keys(counters) as Array<keyof typeof counters>) {
    counters[key] = 0;
  }
}

// ------------------------------------------------------------ ffmpeg seam

export interface JamVideoTools {
  /** Seconds of video, or NaN when it cannot tell. Throws when the file is not a readable video. */
  probe(path: string, contentType: string): Promise<number>;
  /** One JPEG frame at `seconds`, written to `out`. */
  frame(path: string, contentType: string, seconds: number, out: string): Promise<void>;
}

const FFMPEG = () => process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const FFPROBE = () => process.env.FFPROBE_PATH?.trim() || "ffprobe";
const TOOL_TIMEOUT_MS = 60_000;

/**
 * The recorder's bytes are a stranger's, so they are read as the one local
 * container they claim to be and nothing else: the demuxer forced (never a
 * playlist or a format that names other resources), the `file` protocol only,
 * and the MP4 external data references off. The stories' rule
 * (`story-media.ts`), widened to WebM because a browser records it.
 */
function localInput(contentType: string): string[] {
  return contentType === "video/webm"
    ? ["-protocol_whitelist", "file", "-f", "matroska"]
    : ["-protocol_whitelist", "file", "-f", "mov", "-enable_drefs", "0"];
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.length > 2_000_000) child.kill("SIGKILL");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err = (err + chunk.toString()).slice(-500);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), TOOL_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${command} exited ${signal ?? code}: ${err.trim()}`));
    });
  });
}

export const realJamVideoTools: JamVideoTools = {
  async probe(path, contentType) {
    const out = await run(FFPROBE(), [
      ...localInput(contentType),
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      path,
    ]);
    const parsed = JSON.parse(out) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string; duration?: string }>;
    };
    const video = parsed.streams?.find((stream) => stream.codec_type === "video");
    if (!video) {
      throw new Error("no video stream");
    }
    let seconds = Number(parsed.format?.duration);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      seconds = Number(video.duration);
    }
    if (!Number.isFinite(seconds) || seconds <= 0) {
      // A browser's MediaRecorder WebM usually carries no duration: read the
      // last video packet's timestamp.
      const packets = await run(FFPROBE(), [
        ...localInput(contentType),
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "packet=pts_time",
        "-of",
        "csv=p=0",
        path,
      ]);
      seconds = Number.NaN;
      for (const line of packets.split("\n")) {
        const value = Number(line.split(",")[0]);
        if (Number.isFinite(value)) {
          seconds = Number.isNaN(seconds) ? value : Math.max(seconds, value);
        }
      }
    }
    return seconds;
  },
  async frame(path, contentType, seconds, out) {
    await run(FFMPEG(), [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      seconds.toFixed(3),
      ...localInput(contentType),
      "-i",
      path,
      "-frames:v",
      "1",
      "-vf",
      "scale='min(720,iw)':-2",
      "-q:v",
      "4",
      "-y",
      out,
    ]);
  },
};

let tools: JamVideoTools = realJamVideoTools;
let toolsAvailable: () => Promise<boolean> = isFfmpegAvailable;

/** Tests only: stand in for ffmpeg, or say whether it is there. `null` puts the real ones back. */
export function setJamVideoToolsForTests(
  next: JamVideoTools | null,
  available?: () => Promise<boolean>,
): void {
  tools = next ?? realJamVideoTools;
  toolsAvailable = available ?? (next ? async () => true : isFfmpegAvailable);
}

/**
 * When to sample: the first frame, then every interval, at most the cap. A
 * length nobody could read samples the first frame only.
 */
export function jamFrameTimes(durationSeconds: number): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return [0];
  }
  const times: number[] = [];
  for (
    let at = 0;
    at < durationSeconds && times.length < JAM_PUBLIC_VIDEO_FRAMES_MAX;
    at += JAM_PUBLIC_VIDEO_FRAME_INTERVAL_S
  ) {
    times.push(at);
  }
  return times;
}

// --------------------------------------------------------------- outcomes

type Verdict = "passed" | "flagged" | "rejected" | "unscanned";

function verdictOf(result: ScanResult): Verdict | "retry" {
  switch (result.status) {
    case "pass":
      return "passed";
    case "flagged":
      return "flagged";
    case "rejected":
      return "rejected";
    case "error":
      return "retry";
    default:
      return "unscanned";
  }
}

async function quarantine(input: {
  key: string;
  kind: "cover" | "video";
  songId: string;
  trackId: string | null;
  uploaderId: string | null;
  result: ScanResult;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO jam_public_quarantine
       (storage_key, kind, song_id, track_id, uploader_id, scan_provider, scan_score, scan_labels)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (storage_key) DO NOTHING`,
    [
      input.key,
      input.kind,
      input.songId,
      input.trackId,
      input.uploaderId,
      input.result.provider,
      input.result.score,
      JSON.stringify(input.result.labels),
    ],
  );
}

/** The loud line and the instance-queue report for a flag or a rejection. Never throws. */
async function escalate(input: {
  kind: "cover" | "video";
  key: string;
  songId: string;
  title: string;
  uploaderId: string | null;
  trackId: string | null;
  result: ScanResult;
}): Promise<void> {
  const { result } = input;
  if (result.illegal || result.labels.includes("illegal") || result.labels.includes("csam_suspected")) {
    console.error(
      `[content-safety] ILLEGAL-CONTENT MATCH — public jam ${input.kind} ${input.key}, ` +
        `song ${input.songId}${input.trackId ? `, track ${input.trackId}` : ""}, uploader ` +
        `${input.uploaderId ?? "unknown"}, provider ${result.provider}, labels ` +
        `${result.labels.join(",")}. Object retained under quarantine and NOT deleted. ` +
        `See docs/CONTENT_SAFETY.md before touching it.`,
    );
  }
  if (!input.uploaderId) {
    return;
  }
  try {
    await createAutomatedInstanceReport({
      reportedUserId: input.uploaderId,
      placeLabel: `Jam pública · ${input.title}`,
      reason: scanReportReason(result.labels),
      details:
        `Automated image scan (${result.provider}) returned ${result.status} for the ` +
        `${input.kind === "cover" ? "cover" : "video frames"} of public jam ${input.songId}` +
        (input.trackId ? `, track ${input.trackId}` : "") +
        ` (object ${input.key}): ${result.labels.join(", ") || "no labels"} ` +
        `(score ${result.score ?? "n/a"}). ` +
        (result.status === "rejected"
          ? "Taken off the song and held in quarantine; never public."
          : "Not shown publicly; still in its channel."),
    });
  } catch (error) {
    console.error(`[content-safety] could not file a report for ${input.key}:`, error);
  }
}

// ------------------------------------------------------------------ covers

interface ClaimedCover {
  upload_id: string;
  song_id: string;
  storage_key: string;
  content_type: string;
  uploader_id: string;
  title: string;
  attempts: number;
  claim: string;
}

async function claimCover(): Promise<ClaimedCover | null> {
  const result = await getPool().query<ClaimedCover>(
    `UPDATE jam_public_cover_scans cs
        SET claimed_at = NOW(), attempts = cs.attempts + 1
       FROM jam_uploads u, jam_songs s
      WHERE cs.upload_id = (
              SELECT c.upload_id FROM jam_public_cover_scans c
                JOIN jam_uploads cu ON cu.id = c.upload_id
               WHERE c.status = 'pending'
                 AND (c.claimed_at IS NULL OR c.claimed_at < NOW() - INTERVAL '${LEASE}')
                 AND cu.created_at < NOW() - INTERVAL '${UPLOAD_SETTLE}'
               ORDER BY c.created_at
               LIMIT 1
               FOR UPDATE OF c SKIP LOCKED)
        AND u.id = cs.upload_id AND s.id = cs.song_id
      RETURNING cs.upload_id, cs.song_id, u.storage_key, u.content_type, u.uploader_id, s.title,
                cs.attempts, cs.claimed_at::text AS claim`,
  );
  return result.rows[0] ?? null;
}

async function finishCover(claimed: ClaimedCover, verdict: Verdict, result: ScanResult): Promise<void> {
  await getPool().query(
    `UPDATE jam_public_cover_scans
        SET status = $3, provider = $4, score = $5, labels = $6::jsonb, scanned_at = NOW(), claimed_at = NULL
      WHERE upload_id = $1 AND claimed_at = $2::timestamptz`,
    [
      claimed.upload_id,
      claimed.claim,
      verdict,
      result.provider,
      result.score,
      JSON.stringify(result.labels),
    ],
  );
}

/** One cover. Returns what happened, or null when there was nothing to do. */
export async function processOneJamCover(): Promise<Verdict | "retry" | null> {
  const claimed = await claimCover();
  if (!claimed) {
    return null;
  }
  if (!isContentScanConfigured()) {
    await finishCover(claimed, "unscanned", unscannedResult());
    counters.coversUnscanned += 1;
    return "unscanned";
  }
  const result = await scanImage({
    imageUrl: presignGet(claimed.storage_key, { ttlSeconds: SCAN_URL_TTL_SECONDS }),
    contentType: claimed.content_type,
  });
  let verdict = verdictOf(result);
  if (verdict === "retry") {
    if (claimed.attempts < MAX_ATTEMPTS) {
      await getPool().query(
        `UPDATE jam_public_cover_scans SET claimed_at = NULL WHERE upload_id = $1 AND claimed_at = $2::timestamptz`,
        [claimed.upload_id, claimed.claim],
      );
      counters.failures += 1;
      return "retry";
    }
    verdict = "unscanned";
    result.labels = [...result.labels, "scan_error"];
  }
  if (verdict === "rejected") {
    await quarantine({
      key: claimed.storage_key,
      kind: "cover",
      songId: claimed.song_id,
      trackId: null,
      uploaderId: claimed.uploader_id,
      result,
    });
    // Off the song everywhere: a rejected picture is not shown in its channel
    // either. The ledger row stays (the quarantine holds its object).
    await getPool().query(`DELETE FROM jam_song_covers WHERE song_id = $1 AND upload_id = $2`, [
      claimed.song_id,
      claimed.upload_id,
    ]);
  }
  await finishCover(claimed, verdict, result);
  if (verdict === "rejected" || verdict === "flagged") {
    await escalate({
      kind: "cover",
      key: claimed.storage_key,
      songId: claimed.song_id,
      title: claimed.title,
      uploaderId: claimed.uploader_id,
      trackId: null,
      result,
    });
  }
  counters[
    verdict === "passed"
      ? "coversPassed"
      : verdict === "flagged"
        ? "coversFlagged"
        : verdict === "rejected"
          ? "coversRejected"
          : "coversUnscanned"
  ] += 1;
  return verdict;
}

function unscannedResult(): ScanResult {
  return { status: "unscanned", provider: contentScanProvider(), score: null, labels: [], illegal: false };
}

// ------------------------------------------------------------------ videos

interface ClaimedVideo {
  track_id: string;
  song_id: string;
  author_id: string;
  video_key: string;
  /** The worker's MP4 copy of it (`jam-video-transcode.ts`), when one is named. */
  video_mp4_key: string | null;
  video_content_type: string;
  title: string;
  attempts: number;
  claim: string;
}

async function claimVideo(): Promise<ClaimedVideo | null> {
  const result = await getPool().query<ClaimedVideo>(
    `UPDATE jam_public_tracks pt
        SET video_claimed_at = NOW(), video_attempts = pt.video_attempts + 1
       FROM jam_tracks t, jam_songs s
      WHERE pt.track_id = (
              SELECT q.track_id FROM jam_public_tracks q
                JOIN jam_tracks qt ON qt.id = q.track_id
               WHERE q.video_scan_status = 'pending'
                 AND qt.deleted_at IS NULL AND qt.video_key IS NOT NULL
                 AND q.video_scan_key = qt.video_key
                 AND (q.video_claimed_at IS NULL OR q.video_claimed_at < NOW() - INTERVAL '${LEASE}')
                 AND NOT EXISTS (
                   SELECT 1 FROM jam_uploads vu
                    WHERE vu.storage_key = qt.video_key
                      AND vu.created_at >= NOW() - INTERVAL '${UPLOAD_SETTLE}')
               ORDER BY q.created_at
               LIMIT 1
               FOR UPDATE OF q SKIP LOCKED)
        AND t.id = pt.track_id AND s.id = pt.song_id
      RETURNING pt.track_id, pt.song_id, pt.author_id, t.video_key, t.video_mp4_key, t.video_content_type, s.title,
                pt.video_attempts AS attempts, pt.video_claimed_at::text AS claim`,
  );
  return result.rows[0] ?? null;
}

async function finishVideo(
  claimed: ClaimedVideo,
  status: "passed" | "flagged" | "rejected" | "unscanned" | "skipped",
  result: ScanResult | null,
  frames: number,
): Promise<void> {
  await getPool().query(
    `UPDATE jam_public_tracks
        SET video_scan_status = $3, video_scan_provider = $4, video_scan_score = $5,
            video_scan_labels = $6::jsonb, video_scan_frames = $7, video_scanned_at = NOW(),
            video_claimed_at = NULL
      WHERE track_id = $1 AND video_claimed_at = $2::timestamptz`,
    [
      claimed.track_id,
      claimed.claim,
      status,
      result?.provider ?? null,
      result?.score ?? null,
      JSON.stringify(result?.labels ?? []),
      frames,
    ],
  );
}

async function releaseVideo(claimed: ClaimedVideo): Promise<void> {
  await getPool()
    .query(
      `UPDATE jam_public_tracks SET video_claimed_at = NULL
        WHERE track_id = $1 AND video_claimed_at = $2::timestamptz`,
      [claimed.track_id, claimed.claim],
    )
    .catch(() => undefined);
}

/**
 * Scan the sampled frames. Each is uploaded under `jam-scan/` only long enough
 * for the scanner to fetch it (the provider is handed a two-minute GET and
 * never sees the video), then deleted.
 */
async function scanFrames(claimed: ClaimedVideo, paths: string[]): Promise<ScanResult> {
  const keys: string[] = [];
  try {
    for (const [index, path] of paths.entries()) {
      const key = `jam-scan/${claimed.track_id}/frame-${index + 1}.jpg`;
      await putObject(key, await readFile(path), "image/jpeg");
      keys.push(key);
    }
    const results = await Promise.all(
      keys.map((key) =>
        scanImage({
          imageUrl: presignGet(key, { ttlSeconds: SCAN_URL_TTL_SECONDS }),
          contentType: "image/jpeg",
        }),
      ),
    );
    counters.framesScanned += results.length;
    return combineScans(results);
  } finally {
    for (const key of keys) {
      await deleteObject(key).catch((error: unknown) => {
        console.error(
          `[jam-public] leaked a sampled frame ${key}:`,
          error instanceof Error ? error.message : error,
        );
      });
    }
  }
}

/** One video. Returns what happened, or null when there was nothing to do (or nothing here can do it). */
export async function processOneJamVideo(): Promise<
  "passed" | "flagged" | "rejected" | "unscanned" | "skipped" | "retry" | null
> {
  const scanner = isContentScanConfigured();
  const canSample = await toolsAvailable();
  if (scanner && !canSample) {
    // A scanner says frames must be looked at and nothing here can sample
    // them: leave the row for a process that can (the worker).
    return null;
  }
  let dir: string | null = null;
  if (scanner) {
    try {
      dir = await mkdtemp(join(tmpdir(), "pqp-jam-scan-"));
    } catch (error) {
      console.error("[jam-public] no scratch directory:", error instanceof Error ? error.message : error);
      return null;
    }
  }
  const claimed = await claimVideo().catch(async (error: unknown) => {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  });
  if (!claimed) {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }
  if (!scanner || !dir) {
    await finishVideo(claimed, "unscanned", unscannedResult(), 0);
    counters.videosUnscanned += 1;
    return "unscanned";
  }
  try {
    const videoPath = join(dir, "in.video");
    const downloaded = await downloadObjectToFile(claimed.video_key, videoPath, JAM_VIDEO_MAX_BYTES);
    if (!downloaded) {
      await finishVideo(claimed, "skipped", null, 0);
      counters.videosSkipped += 1;
      return "skipped";
    }
    let duration: number;
    try {
      duration = await tools.probe(videoPath, claimed.video_content_type);
    } catch (error) {
      console.warn(
        `[jam-public] track ${claimed.track_id} has no readable video:`,
        error instanceof Error ? error.message : error,
      );
      await finishVideo(claimed, "skipped", null, 0);
      counters.videosSkipped += 1;
      return "skipped";
    }
    const paths: string[] = [];
    for (const [index, at] of jamFrameTimes(duration).entries()) {
      const out = join(dir, `frame-${index + 1}.jpg`);
      try {
        await tools.frame(videoPath, claimed.video_content_type, at, out);
        paths.push(out);
      } catch (error) {
        // A seek past the last keyframe of a short clip: the frames before it
        // still count. No frame at all is a video nobody could look at.
        if (index === 0) {
          console.warn(
            `[jam-public] track ${claimed.track_id}: no first frame:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
    if (paths.length === 0) {
      await finishVideo(claimed, "skipped", null, 0);
      counters.videosSkipped += 1;
      return "skipped";
    }
    const result = await scanFrames(claimed, paths);
    let verdict = verdictOf(result);
    if (verdict === "retry") {
      if (claimed.attempts < MAX_ATTEMPTS) {
        await releaseVideo(claimed);
        counters.failures += 1;
        return "retry";
      }
      verdict = "unscanned";
      result.labels = [...result.labels, "scan_error"];
    }
    if (verdict === "rejected") {
      await quarantine({
        key: claimed.video_key,
        kind: "video",
        songId: claimed.song_id,
        trackId: claimed.track_id,
        uploaderId: claimed.author_id,
        result,
      });
      // The MP4 copy is the same picture: held with it.
      if (claimed.video_mp4_key) {
        await quarantine({
          key: claimed.video_mp4_key,
          kind: "video",
          songId: claimed.song_id,
          trackId: claimed.track_id,
          uploaderId: claimed.author_id,
          result,
        });
      }
      // Off the track everywhere, the channel included, the MP4 copy too; the
      // audio stays. The quarantine holds the objects, so no sweep deletes them
      // before their time. A transcode still running finds its reservation gone
      // and does not confirm (`jam-video-transcode.ts` confirms on the key).
      await getPool().query(
        `UPDATE jam_tracks
            SET video_key = NULL, video_content_type = NULL, video_bytes = NULL,
                video_mp4_key = NULL, video_mp4_content_type = NULL, video_mp4_bytes = NULL
          WHERE id = $1 AND video_key = $2`,
        [claimed.track_id, claimed.video_key],
      );
    }
    await finishVideo(claimed, verdict, result, paths.length);
    if (verdict === "rejected" || verdict === "flagged") {
      await escalate({
        kind: "video",
        key: claimed.video_key,
        songId: claimed.song_id,
        title: claimed.title,
        uploaderId: claimed.author_id,
        trackId: claimed.track_id,
        result,
      });
    }
    counters[
      verdict === "passed"
        ? "videosPassed"
        : verdict === "flagged"
          ? "videosFlagged"
          : verdict === "rejected"
            ? "videosRejected"
            : "videosUnscanned"
    ] += 1;
    return verdict;
  } catch (error) {
    // Storage or a tool hiccup: let the lease go and try again.
    counters.failures += 1;
    console.error(
      `[jam-public] video ${claimed.track_id} failed, will retry:`,
      error instanceof Error ? error.message : error,
    );
    if (claimed.attempts >= MAX_ATTEMPTS) {
      await finishVideo(claimed, "unscanned", { ...unscannedResult(), labels: ["scan_error"] }, 0);
      counters.videosUnscanned += 1;
      return "unscanned";
    }
    await releaseVideo(claimed);
    return "retry";
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The job's tick: a few covers and one video. Never throws past a log line. */
export async function processJamPublicScans(): Promise<void> {
  if (!isStorageConfigured()) {
    return;
  }
  for (let i = 0; i < 5; i += 1) {
    if ((await processOneJamCover()) === null) {
      break;
    }
  }
  await processOneJamVideo();
}

/**
 * Expire quarantined objects after `CONTENT_SCAN_QUARANTINE_DAYS`, except one
 * labelled `illegal` or `csam_suspected`, which is never swept, at any age (the
 * rule of every quarantine in CONTENT_SAFETY.md). Object first, row after.
 */
export async function sweepJamPublicQuarantine(): Promise<number> {
  if (!isStorageConfigured()) {
    return 0;
  }
  const expired = await getPool().query<{ storage_key: string }>(
    `SELECT storage_key FROM jam_public_quarantine
      WHERE quarantined_at < NOW() - ($1 || ' days')::interval
        AND NOT COALESCE(scan_labels @> '["illegal"]'::jsonb, FALSE)
        AND NOT COALESCE(scan_labels @> '["csam_suspected"]'::jsonb, FALSE)
      ORDER BY quarantined_at
      LIMIT 100`,
    [quarantineDays()],
  );
  let done = 0;
  for (const row of expired.rows) {
    try {
      await deleteObject(row.storage_key);
    } catch (error) {
      console.error(
        `[jam-public] could not delete quarantined ${row.storage_key}:`,
        error instanceof Error ? error.message : error,
      );
      continue;
    }
    await getPool().query(`DELETE FROM jam_public_quarantine WHERE storage_key = $1`, [row.storage_key]);
    done += 1;
  }
  return done;
}

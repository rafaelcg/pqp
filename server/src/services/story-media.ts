import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STORY_MAX_BYTES, STORY_MAX_PROBED_VIDEO_MS } from "@pqp/shared";
import { getPool } from "../db.js";
import { INSTANCE_ID } from "../lib/bus.js";
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
  isContentScanConfigured,
  scanImage,
  SCAN_URL_TTL_SECONDS,
  type ScanResult,
} from "./content-scan.js";
import { applyStoryScan, goLive, refuseStory, storyPosterKey } from "./stories.js";
import { bumpStoryStat } from "./story-metrics.js";

/**
 * The two background halves of stories, both cold paths (`jobs.ts`, so they
 * run on the worker under `WORKER_MODE`):
 *
 * 1. THE VIDEO JOB. A published video is `processing` until this checks it:
 *    ffprobe for the length (at most `STORY_MAX_PROBED_VIDEO_MS`) and the codec
 *    (H.264, which every client plays), a poster at 0.5 s, and three frames at
 *    25, 50 and 75 % handed to the image scanner with the poster. Better than
 *    chat and Baú video today, which are not scanned at all. Only then live.
 * 2. THE SWEEP. Every minute: expire what is past its 24 h, delete the bytes of
 *    whatever nothing holds, delete rows a week later, and clear orphans (a
 *    story minted and never published, a video stuck processing). It runs
 *    whatever the flags say: a flag turned off must never make bytes outlive
 *    the promise.
 *
 * Both claim their rows in SQL, so a window in which the API and the worker
 * run them together does duplicate work, never wrong work, and each object is
 * deleted once.
 */

export const STORY_SWEEP_INTERVAL_MS = 60_000;
export const STORY_VIDEO_INTERVAL_MS = 5_000;
/** A claimed video not finished in this long is taken again. */
const VIDEO_LEASE = "5 minutes";
const VIDEO_MAX_ATTEMPTS = 3;
/** A story minted and never published, or a video never finished. */
const ORPHAN_GRACE = "1 hour";
/** An expired story's row lives this long after its bytes, for the rollups. */
const ROW_RETENTION = "7 days";
/** A resolved report holds the story's bytes this long. */
const REPORT_HOLD = "30 days";
const SWEEP_BATCH = 200;
/** A media delete claimed and not finished in this long is taken again. */
const DELETE_LEASE = "10 minutes";
/**
 * The largest frame the job will decode: 4096 x 4096. A phone records at most
 * 4K; past this a small file can still ask the decoder for gigabytes.
 */
export const STORY_MAX_VIDEO_PIXELS = 4096 * 4096;
const STORY_MAX_VIDEO_EDGE = 4096;

/**
 * "Somebody may still need these bytes": a scan hold, an illegal-content match
 * (forever), an open report, or a report resolved in the last 30 days. Shared
 * by the media sweep and the row sweep so the two can never disagree.
 */
export const STORY_HELD_SQL = `(
  s.hold_forever
  OR (s.hold_until IS NOT NULL AND s.hold_until > now())
  OR EXISTS (
    SELECT 1 FROM reports r
     WHERE r.reported_story_id = s.id
       AND (r.status = 'open' OR r.resolved_at > now() - interval '${REPORT_HOLD}')
  )
)`;

// ------------------------------------------------------------------ the sweep

export interface StorySweepResult {
  expired: number;
  orphaned: number;
  mediaDeleted: number;
  mediaFailed: number;
  rowsDeleted: number;
}

export async function sweepStories(): Promise<StorySweepResult> {
  const pool = getPool();
  const expired = await pool.query(
    `UPDATE stories SET status = 'expired'
      WHERE status = 'live' AND expires_at <= now()`,
  );
  const orphaned = await pool.query(
    `UPDATE stories SET status = 'deleted', deleted_at = now(),
            processing_error = COALESCE(processing_error, 'never finished')
      WHERE status IN ('pending', 'processing')
        AND created_at < now() - interval '${ORPHAN_GRACE}'`,
  );
  if ((orphaned.rowCount ?? 0) > 0) {
    bumpStoryStat("orphansDeleted", orphaned.rowCount ?? 0);
  }

  let mediaDeleted = 0;
  let mediaFailed = 0;
  if (isStorageConfigured()) {
    // CLAIM with a lease, outside any transaction that would wait on the
    // network: the UPDATE row-locks, so a second process sweeping at the same
    // moment skips what this one took, and each object is deleted once.
    // `media_deleted_at` is written only once BOTH objects are gone, so the row
    // sweep below can never drop a row whose bytes are still in flight, and a
    // process that dies mid-delete leaves a lease that lapses and is retried
    // (a delete of something already gone is a success).
    const claimed = await pool.query<{
      id: string;
      kind: string;
      media_storage_key: string | null;
      poster_storage_key: string | null;
      /** Composer v2: the objects behind image and drawing layers. */
      layer_keys: string[];
      /** The lease token as text: a JS Date would drop Postgres's microseconds. */
      claim: string;
    }>(
      `UPDATE stories s SET media_delete_claimed_at = now()
        WHERE s.id IN (
          SELECT s.id FROM stories s
           WHERE s.media_deleted_at IS NULL
             AND (s.media_storage_key IS NOT NULL OR cardinality(s.layer_keys) > 0)
             AND s.status IN ('expired', 'deleted')
             AND (s.media_delete_claimed_at IS NULL
                  OR s.media_delete_claimed_at < now() - interval '${DELETE_LEASE}')
             AND NOT ${STORY_HELD_SQL}
           ORDER BY COALESCE(s.expires_at, s.created_at) ASC
           LIMIT ${SWEEP_BATCH}
           FOR UPDATE SKIP LOCKED
        )
        RETURNING s.id, s.kind, s.media_storage_key, s.poster_storage_key, s.layer_keys,
                  s.media_delete_claimed_at::text AS claim`,
    );
    for (const row of claimed.rows) {
      try {
        if (row.media_storage_key) {
          await deleteObject(row.media_storage_key);
        }
        if (row.poster_storage_key) {
          await deleteObject(row.poster_storage_key);
        }
        // Layer objects (composer v2): a photo placed on the story, or the
        // drawing. Each is deleted whatever the story's kind, and a text card
        // may hold nothing else.
        // At most a handful per story, so all at once; the row is marked done
        // only after every one has gone.
        await Promise.all(row.layer_keys.map((key) => deleteObject(key)));
        if (row.kind === "video" && row.media_storage_key) {
          // The video job's sampled frames live only long enough to be
          // scanned and are deleted right after; a delete that failed then
          // is retried here, so none outlives its story.
          const prefix = row.media_storage_key.slice(0, row.media_storage_key.lastIndexOf("/") + 1);
          for (const frame of [1, 2, 3]) {
            await deleteObject(`${prefix}frame-${frame}.jpg`);
          }
        }
        await pool.query(
          `UPDATE stories SET media_deleted_at = now()
            WHERE id = $1 AND media_delete_claimed_at = $2::timestamptz`,
          [row.id, row.claim],
        );
        mediaDeleted += 1;
      } catch (error) {
        mediaFailed += 1;
        console.error(
          `[stories] could not delete the bytes of ${row.id}:`,
          error instanceof Error ? error.message : error,
        );
        await pool.query(
          `UPDATE stories SET media_delete_claimed_at = NULL
            WHERE id = $1 AND media_delete_claimed_at = $2::timestamptz`,
          [row.id, row.claim],
        );
      }
    }
    bumpStoryStat("mediaDeleted", mediaDeleted);
    bumpStoryStat("mediaDeleteFailures", mediaFailed);
  }

  const rows = await pool.query(
    `DELETE FROM stories s
      WHERE s.status IN ('expired', 'deleted')
        AND ((s.media_storage_key IS NULL AND cardinality(s.layer_keys) = 0)
             OR s.media_deleted_at IS NOT NULL)
        -- An account that is gone has no "who viewed" question left to answer.
        AND (s.author_id IS NULL
             OR COALESCE(s.deleted_at, s.expires_at, s.created_at)
                  < now() - interval '${ROW_RETENTION}')
        AND NOT ${STORY_HELD_SQL}`,
  );
  bumpStoryStat("rowsDeleted", rows.rowCount ?? 0);

  // Housekeeping with nothing depending on it.
  await pool.query(
    `DELETE FROM story_notices
      WHERE created_at < now() - interval '30 days'`,
  );
  await pool.query(
    `DELETE FROM story_media_processors WHERE seen_at < now() - interval '1 day'`,
  );

  return {
    expired: expired.rowCount ?? 0,
    orphaned: orphaned.rowCount ?? 0,
    mediaDeleted,
    mediaFailed,
    rowsDeleted: rows.rowCount ?? 0,
  };
}

// ------------------------------------------------------------------ ffmpeg seam

export interface ProbedVideo {
  durationMs: number;
  /** The first video stream's codec, as ffprobe names it (`h264`). */
  videoCodec: string | null;
  width: number | null;
  height: number | null;
}

export interface StoryVideoTools {
  probe(path: string): Promise<ProbedVideo>;
  /** One JPEG frame at `seconds`, written to `out`. */
  frame(path: string, seconds: number, out: string): Promise<void>;
}

const FFMPEG = () => process.env.FFMPEG_PATH?.trim() || "ffmpeg";
/**
 * The uploaded bytes are the author's, so the tools read them as a local MP4
 * and nothing else: the mov/mp4 demuxer forced (never a playlist or any other
 * format that names other resources) and the `file` protocol only, so a
 * crafted file cannot make the worker fetch a URL. External data references
 * stay off (`enable_drefs` is 0 by default and set here anyway).
 */
const LOCAL_MP4_INPUT = [
  "-protocol_whitelist",
  "file",
  "-f",
  "mov",
  "-enable_drefs",
  "0",
];
const FFPROBE = () => process.env.FFPROBE_PATH?.trim() || "ffprobe";
const TOOL_TIMEOUT_MS = 60_000;

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.length > 1_000_000) child.kill("SIGKILL");
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

/** The end of the last video packet, in seconds, read off the packet timestamps. NaN when there are none. */
async function packetSeconds(path: string): Promise<number> {
  const out = await run(FFPROBE(), [
    ...LOCAL_MP4_INPUT,
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "packet=pts_time,duration_time",
    "-of",
    "csv=p=0",
    path,
  ]);
  let end = Number.NaN;
  for (const line of out.split("\n")) {
    const [pts, duration] = line.split(",").map((value) => Number(value));
    if (pts !== undefined && Number.isFinite(pts)) {
      const last = pts + (Number.isFinite(duration) ? (duration as number) : 0);
      end = Number.isNaN(end) ? last : Math.max(end, last);
    }
  }
  return end;
}

export const realStoryVideoTools: StoryVideoTools = {
  async probe(path) {
    const out = await run(FFPROBE(), [
      ...LOCAL_MP4_INPUT,
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
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        duration?: string;
      }>;
    };
    const video = parsed.streams?.find((stream) => stream.codec_type === "video");
    let seconds = Number(parsed.format?.duration);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      // A fragmented MP4 straight off a browser's MediaRecorder (Chrome 126+
      // records `video/mp4`) can carry no duration in its header. The video
      // stream's own, then the packets' timestamps, both bounded by the 25 MB
      // the file may be; the story's length limit is judged on this number.
      seconds = Number(video?.duration);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        seconds = await packetSeconds(path);
      }
    }
    return {
      durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : Number.NaN,
      videoCodec: video?.codec_name ?? null,
      width: video?.width ?? null,
      height: video?.height ?? null,
    };
  },
  async frame(path, seconds, out) {
    await run(FFMPEG(), [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      seconds.toFixed(3),
      ...LOCAL_MP4_INPUT,
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

let tools: StoryVideoTools = realStoryVideoTools;
let toolsAvailable: () => Promise<boolean> = isFfmpegAvailable;

/** Tests only: stand in for ffmpeg (CI may not have it). `null` puts the real ones back. */
export function setStoryVideoToolsForTests(
  next: StoryVideoTools | null,
  available?: () => Promise<boolean>,
): void {
  tools = next ?? realStoryVideoTools;
  toolsAvailable = next ? (available ?? (async () => true)) : isFfmpegAvailable;
}

// ------------------------------------------------------------------ the video job

let lastAdvertised = 0;

/**
 * Say, at most once a minute, that this process can check videos, so the API
 * (which may have no ffmpeg) knows to offer video with a scanner configured.
 */
async function advertise(): Promise<void> {
  if (Date.now() - lastAdvertised < 60_000) {
    return;
  }
  lastAdvertised = Date.now();
  await getPool().query(
    `INSERT INTO story_media_processors (instance_id, seen_at) VALUES ($1, now())
     ON CONFLICT (instance_id) DO UPDATE SET seen_at = now()`,
    [INSTANCE_ID],
  );
}

interface ClaimedVideo {
  id: string;
  author_id: string;
  media_storage_key: string;
  processing_attempts: number;
  /**
   * The lease token, as text (a JS Date would drop Postgres's microseconds):
   * only the holder of this exact claim may finish or release it.
   */
  claim: string;
}

async function claimVideo(): Promise<ClaimedVideo | null> {
  const result = await getPool().query<ClaimedVideo>(
    `UPDATE stories
        SET processing_claimed_at = now(), processing_attempts = processing_attempts + 1
      WHERE id = (
        SELECT id FROM stories
         WHERE status = 'processing'
           AND (processing_claimed_at IS NULL
                OR processing_claimed_at < now() - interval '${VIDEO_LEASE}')
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, author_id, media_storage_key, processing_attempts,
                processing_claimed_at::text AS claim`,
  );
  return result.rows[0] ?? null;
}

// `combineScans` moved to content-scan.ts (stories.ts needs it for layer images too).
export { combineScans };

export type StoryVideoOutcome = "live" | "refused" | "retry" | "idle";

/**
 * One tick: claim one processing video and finish it. Returns what happened,
 * for the tests and the log. Never throws.
 */
export interface StoryVideoTick {
  storyId: string | null;
  /** Whose story it was, for the `own` nudge. */
  authorId?: string;
  outcome: StoryVideoOutcome;
  /** True when this tick flipped it live: tell its audience. */
  wentLive?: boolean;
}

export async function processStoryVideos(): Promise<StoryVideoTick> {
  if (!isStorageConfigured()) {
    return { storyId: null, outcome: "idle" };
  }
  const canProbe = await toolsAvailable();
  if (canProbe) {
    await advertise().catch(() => undefined);
  } else if (isContentScanConfigured()) {
    // Nothing here can sample frames, and a scanner says they must be: leave
    // the row for a process that can (the worker).
    return { storyId: null, outcome: "idle" };
  }
  // The scratch directory before the claim: a full or read-only tmp must not
  // spend one of a video's attempts.
  let dir: string | null = null;
  if (canProbe) {
    try {
      dir = await mkdtemp(join(tmpdir(), "pqp-story-"));
    } catch (error) {
      console.error(
        "[stories] no scratch directory for the video job:",
        error instanceof Error ? error.message : error,
      );
      return { storyId: null, outcome: "idle" };
    }
  }
  const claimed = await claimVideo().catch(async (error: unknown) => {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  });
  if (!claimed) {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return { storyId: null, outcome: "idle" };
  }
  if (claimed.processing_attempts > VIDEO_MAX_ATTEMPTS) {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await refuseStory(claimed.id, { until: "none" }, "processing failed too many times", claimed.claim);
    bumpStoryStat("videoFailures");
    return { storyId: claimed.id, authorId: claimed.author_id, outcome: "refused" };
  }
  if (!canProbe || !dir) {
    // No scanner and no ffmpeg anywhere: live as it is, recorded unscanned.
    const wentLive = await goLive(claimed.id, claimed.claim);
    return { storyId: claimed.id, authorId: claimed.author_id, outcome: "live", wentLive };
  }

  try {
    const videoPath = join(dir, "in.mp4");
    const downloaded = await downloadObjectToFile(
      claimed.media_storage_key,
      videoPath,
      STORY_MAX_BYTES,
    );
    if (!downloaded) {
      await refuseStory(claimed.id, { until: "none" }, "object missing", claimed.claim);
      bumpStoryStat("videosRefused");
      return { storyId: claimed.id, authorId: claimed.author_id, outcome: "refused" };
    }
    let probed: ProbedVideo;
    try {
      probed = await tools.probe(videoPath);
    } catch (error) {
      await refuseStory(claimed.id, { until: "none" }, "not a readable video", claimed.claim);
      bumpStoryStat("videosRefused");
      console.warn(
        `[stories] ${claimed.id} is not a readable video:`,
        error instanceof Error ? error.message : error,
      );
      return { storyId: claimed.id, authorId: claimed.author_id, outcome: "refused" };
    }
    if (
      !Number.isFinite(probed.durationMs) ||
      probed.durationMs <= 0 ||
      probed.durationMs > STORY_MAX_PROBED_VIDEO_MS
    ) {
      await refuseStory(claimed.id, { until: "none" }, `duration ${probed.durationMs} ms`, claimed.claim);
      bumpStoryStat("videosRefused");
      return { storyId: claimed.id, authorId: claimed.author_id, outcome: "refused" };
    }
    const width = probed.width ?? 0;
    const height = probed.height ?? 0;
    if (
      width <= 0 ||
      height <= 0 ||
      width > STORY_MAX_VIDEO_EDGE ||
      height > STORY_MAX_VIDEO_EDGE ||
      width * height > STORY_MAX_VIDEO_PIXELS
    ) {
      await refuseStory(claimed.id, { until: "none" }, `dimensions ${width}x${height}`, claimed.claim);
      bumpStoryStat("videosRefused");
      return { storyId: claimed.id, authorId: claimed.author_id, outcome: "refused" };
    }
    if (probed.videoCodec !== "h264") {
      await refuseStory(claimed.id, { until: "none" }, `codec ${probed.videoCodec ?? "none"}`, claimed.claim);
      bumpStoryStat("videosRefused");
      return { storyId: claimed.id, authorId: claimed.author_id, outcome: "refused" };
    }

    const seconds = probed.durationMs / 1000;
    const posterPath = join(dir, "poster.jpg");
    await tools.frame(videoPath, Math.min(0.5, seconds / 2), posterPath);
    const framePaths: string[] = [];
    for (const [index, share] of [0.25, 0.5, 0.75].entries()) {
      const out = join(dir, `frame-${index + 1}.jpg`);
      await tools.frame(videoPath, seconds * share, out);
      framePaths.push(out);
    }

    const posterKey = storyPosterKey(claimed.author_id, claimed.id);
    await putObject(posterKey, await readFile(posterPath), "image/jpeg");
    await getPool().query(
      `UPDATE stories
          SET poster_storage_key = $2, media_duration_ms = $3,
              media_width = COALESCE($4, media_width), media_height = COALESCE($5, media_height)
        WHERE id = $1`,
      [claimed.id, posterKey, probed.durationMs, probed.width, probed.height],
    );

    if (isContentScanConfigured()) {
      const scan = await scanVideoFrames(claimed, posterKey, framePaths);
      const allowed = await applyStoryScan(
        { id: claimed.id, author_id: claimed.author_id },
        scan,
        "video frames",
        claimed.claim,
      );
      if (!allowed) {
        return { storyId: claimed.id, authorId: claimed.author_id, outcome: "refused" };
      }
    }
    const wentLive = await goLive(claimed.id, claimed.claim);
    bumpStoryStat("videosProcessed");
    return { storyId: claimed.id, authorId: claimed.author_id, outcome: "live", wentLive };
  } catch (error) {
    // Storage or a tool hiccup: let the lease lapse and try again.
    bumpStoryStat("videoFailures");
    console.error(
      `[stories] video ${claimed.id} failed, will retry:`,
      error instanceof Error ? error.message : error,
    );
    await getPool()
      .query(
        `UPDATE stories SET processing_claimed_at = NULL
          WHERE id = $1 AND processing_claimed_at = $2::timestamptz`,
        [claimed.id, claimed.claim],
      )
      .catch(() => undefined);
    return { storyId: claimed.id, authorId: claimed.author_id, outcome: "retry" };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Scan the poster (already stored) and the three sampled frames. The frames
 * are uploaded under the story's own prefix only long enough for the scanner
 * to fetch them, then deleted: the poster is the only image a story keeps.
 */
async function scanVideoFrames(
  claimed: ClaimedVideo,
  posterKey: string,
  framePaths: string[],
): Promise<ScanResult> {
  const frameKeys: string[] = [];
  try {
    for (const [index, path] of framePaths.entries()) {
      const key = `stories/${claimed.author_id}/${claimed.id}/frame-${index + 1}.jpg`;
      await putObject(key, await readFile(path), "image/jpeg");
      frameKeys.push(key);
    }
    const results = await Promise.all(
      [posterKey, ...frameKeys].map((key) =>
        scanImage({
          imageUrl: presignGet(key, { ttlSeconds: SCAN_URL_TTL_SECONDS }),
          contentType: "image/jpeg",
        }),
      ),
    );
    bumpStoryStat("framesScanned", results.length);
    return combineScans(results);
  } finally {
    for (const key of frameKeys) {
      await deleteObject(key).catch((error: unknown) => {
        console.error(
          `[stories] leaked a sampled frame ${key}:`,
          error instanceof Error ? error.message : error,
        );
      });
    }
  }
}

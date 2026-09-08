import {
  EgressClient,
  EgressStatus,
  type EncodingOptions,
  RoomServiceClient,
  S3Upload,
  SegmentedFileOutput,
  TrackSource,
} from "livekit-server-sdk";
import { playlistLooksLive, type LiveHlsStream } from "@pqp/shared";
import { isLiveKitConfigured } from "./backends.js";
import { promotionBudgetMbps } from "./promotion.js";
import {
  decideLadder,
  LADDER_RUNGS,
  ladderBudgetMbps,
  parseLadder,
  rungEncodingOptions,
  type LadderRung,
} from "./hls-ladder.js";
import { logEvent } from "../lib/log.js";
import { getPool } from "../db.js";
import {
  buildStorageConfig,
  signRequest,
  type StorageConfig,
} from "../lib/s3.js";

/**
 * Live HLS for a watch-party screen share: LiveKit Track Composite egress
 * writes 2 s segments to a dedicated R2 bucket, and the playlist URL rides
 * the existing `/ws` as `voice-stream`.
 *
 * Off unless `LIVE_HLS_ENABLED=true` and a *separate* S3 set
 * (`LIVE_HLS_S3_*`) is present. Attachment `S3_*` is deliberately not
 * reused: that bucket is private. `LIVE_HLS_PUBLIC_BASE_URL` is only needed
 * when `LIVE_HLS_SIGNED_URLS=false`: in signed mode (the default, and what
 * production runs) the bucket stays private and everything a viewer or this
 * process reads goes through presigned URLs, so there is no public base.
 */

const TRACK_FIND_ATTEMPTS = 16;
const TRACK_FIND_GAP_MS = 400;
const DEFAULT_DELAY_SECONDS = 10;
const PLAYLIST_WAIT_ATTEMPTS = 20;
const PLAYLIST_WAIT_GAP_MS = 1000;

/** How often the monitor asks LiveKit whether each egress is still alive. */
export const HLS_HEALTH_CHECK_INTERVAL_MS = 10_000;
/** A fresh egress gets this long before its status is held against it. */
const HEALTH_GRACE_MS = 15_000;
/**
 * The live playlist not moving for this long is a dead egress, whatever
 * LiveKit's bookkeeping says. Verified on the local stack 2026-09-08: a
 * `docker stop lk-egress` mid-share leaves `ListEgress` answering ACTIVE
 * for that id indefinitely (v1.13.6, egress v1.14.1: the killed node never
 * writes a final status and nothing expires it), so the status alone
 * would never notice. Ten segments of 2 s: long enough for a presenter
 * pause, short enough that the client's own 15 s watchdog and this one
 * land in the same minute.
 */
const PLAYLIST_STUCK_MS = 20_000;
/** Restarts allowed per channel inside `RESTART_WINDOW_MS` before giving up. */
export const HLS_MAX_RESTARTS = 3;
export const HLS_RESTART_WINDOW_MS = 5 * 60 * 1000;
/** After the cap: no new egress for this channel until the share is stopped or this passes. */
const FAILED_COOLDOWN_MS = 5 * 60 * 1000;
const RESTART_BACKOFF_BASE_MS = 2_000;
const RESTART_BACKOFF_MAX_MS = 15_000;

/**
 * What LiveKit says about one egress, reduced to the three answers the
 * monitor acts on. `unknown` is "could not ask" and never triggers a restart.
 */
export type EgressHealth = "alive" | "ended" | "unknown";

export interface EgressListing {
  egressId: string;
  status: EgressStatus | number;
  error?: string;
}

export interface LiveHlsScreenTracks {
  videoTrackId: string;
  audioTrackId?: string;
}

export interface LiveHlsEgressApi {
  startTrackCompositeEgress: (
    roomName: string,
    output: SegmentedFileOutput,
    opts: {
      audioTrackId?: string;
      videoTrackId: string;
      encodingOptions?: EncodingOptions;
    },
  ) => Promise<{ egressId: string }>;
  stopEgress: (egressId: string) => Promise<void>;
  /**
   * `ListEgress`, by room or by id. Optional so the older fakes still
   * compile; without it the monitor has nothing to ask and does nothing,
   * which is the pre-monitor behaviour, not a crash.
   */
  listEgress?: (opts: {
    roomName?: string;
    egressId?: string;
  }) => Promise<EgressListing[]>;
}

/**
 * Who hears that a channel's stream changed underneath the room. `ws/voice.ts`
 * registers its reconcile-and-rebroadcast here; the monitor calls it after
 * an egress died (so a new one is started and the new playlist URL goes out)
 * and after the cap is hit (so viewers are told the stream is gone).
 */
export type LiveHlsChangeListener = (
  channelId: string,
  reason: string,
) => void;

export type LiveHlsTrackFinder = (
  roomName: string,
) => Promise<LiveHlsScreenTracks | null>;

/**
 * What the WebRTC side of the media box already costs, in the Mbit/s
 * `promotion.ts` prices rooms in. `ws/voice.ts` registers the real reader
 * (the same `readRoomLoads()` the promotion guard uses); without one the
 * ladder guard treats the box as unmeasured and refuses only on its own
 * budget, the same way `decidePromotion` treats an unprobed SFU as
 * promotable rather than as a failure.
 */
export type LiveHlsSfuLoadReader = () => Promise<number>;

/** One rendition of a live session: its own egress, its own playlist. */
interface RunningRung {
  rung: LadderRung;
  egressId: string;
  /** Wall clock when this egress was requested, for the health grace period. */
  startedAtMs: number;
  /** Last playlist shape the monitor saw (`sequence:segments`) and when it changed. */
  progress: { key: string; at: number } | null;
}

interface RoomHls {
  /**
   * Every rendition running for this session, LOWEST BITRATE FIRST. The
   * first entry is the primary: it is what the readiness probe waited for,
   * and the session lives and dies with it. A secondary rung that dies is
   * dropped from the master playlist and the rest keeps playing.
   */
  rungs: RunningRung[];
  stream: LiveHlsStream;
  /**
   * The screen track sid the egress was started on. A Track Composite egress
   * is bound to one sid; when the presenter republishes (a quality pick that
   * changes the top layer, the room crossing the large-room line, a
   * reconnect), the old sid goes away, the egress keeps running on audio
   * alone and the playlist stops growing. Verified on staging 2026-09-07:
   * "writer finished" for the video track, then no segment for 21 s until
   * stop. So a same-presenter reconcile compares this to what the SFU has.
   */
  videoTrackId: string;
  /** Wall clock when the session was requested. */
  startedAtMs: number;
}

const rooms = new Map<string, RoomHls>();
/** Restart timestamps per channel, pruned to `HLS_RESTART_WINDOW_MS`. */
const restartHistory = new Map<string, number[]>();
/** Channels that hit the cap: no egress until this instant, or the share stops. */
const failedUntil = new Map<string, number>();
const pendingRestarts = new Map<string, ReturnType<typeof setTimeout>>();
/** Per-channel serialisation of `reconcileLiveHls`: the monitor and the room can race. */
const reconcileQueue = new Map<string, Promise<unknown>>();
let changeListener: LiveHlsChangeListener | null = null;
let sfuLoadReader: LiveHlsSfuLoadReader | null = null;
let monitorTimer: ReturnType<typeof setInterval> | null = null;

let injectedEgress: LiveHlsEgressApi | null = null;
let injectedFinder: LiveHlsTrackFinder | null = null;
/** What the (skipped) readiness probe answers under a fake egress. */
let injectedPlaylistReady = true;
/** The monitor's playlist read under a fake egress; null skips that check. */
let injectedPlaylistProbe:
  | ((channelId: string, rung: string) => string | null)
  | null = null;

function truthyEnabled(): boolean {
  return process.env.LIVE_HLS_ENABLED === "true";
}

function publicBaseUrl(): string | null {
  const raw = process.env.LIVE_HLS_PUBLIC_BASE_URL?.trim();
  if (!raw) {
    return null;
  }
  return raw.replace(/\/+$/, "");
}

function delaySeconds(): number {
  const raw = Number(process.env.LIVE_HLS_DELAY_SECONDS);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_DELAY_SECONDS;
}

let warnedLadder: string | null = null;

/**
 * `LIVE_HLS_LADDER`: the renditions this deployment encodes, lowest first.
 * A comma-separated list of rung names (`1080p30,720p30`, the default), each
 * optionally carrying a bitrate override (`1080p30@3500`). `LIVE_HLS_PRESET`
 * is still read as the name of a ONE-RUNG ladder, so a deployment that
 * already sets it keeps exactly the behaviour it has.
 *
 * Entries that name nothing log `voice.hlsLadderInvalid` once per distinct
 * value; a list with no valid entry at all falls back to the default rather
 * than leaving a watch party with no rendition.
 */
export function liveHlsLadder(): LadderRung[] {
  const raw = process.env.LIVE_HLS_LADDER;
  const preset = process.env.LIVE_HLS_PRESET;
  const parsed = parseLadder({ ladder: raw, preset });
  if (parsed.invalid.length > 0) {
    const key = parsed.invalid.join(",");
    if (warnedLadder !== key) {
      warnedLadder = key;
      logEvent("voice.hlsLadderInvalid", {
        value: key,
        accepted: Object.keys(LADDER_RUNGS),
        using: parsed.rungs.map((rung) => rung.name),
      });
    }
  }
  return parsed.rungs;
}

const DEFAULT_RETENTION_MINUTES = 10;
const DEFAULT_REPLAY_HOURS = 24;
const DEFAULT_URL_TTL_SECONDS = 900;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** How long a finished session's objects stay once nobody asked to keep it. */
export function hlsRetentionMinutes(): number {
  return positiveIntFromEnv(
    "LIVE_HLS_RETENTION_MINUTES",
    DEFAULT_RETENTION_MINUTES,
  );
}

/** How long a finished session's objects stay when `keep_replay` is set. */
export function hlsReplayHours(): number {
  return positiveIntFromEnv("LIVE_HLS_REPLAY_HOURS", DEFAULT_REPLAY_HOURS);
}

/** TTL for a viewer's presigned segment URLs and playlist-proxy access. */
export function hlsUrlTtlSeconds(): number {
  return positiveIntFromEnv("LIVE_HLS_URL_TTL_SECONDS", DEFAULT_URL_TTL_SECONDS);
}

/**
 * Default true: a viewer gets a presigned, expiring URL rather than the raw
 * public bucket URL. Set `LIVE_HLS_SIGNED_URLS=false` to fall back to the
 * old public-base-URL behaviour (e.g. a bucket that is deliberately public).
 */
export function hlsSignedUrlsEnabled(): boolean {
  return process.env.LIVE_HLS_SIGNED_URLS !== "false";
}

/** The separate `LIVE_HLS_S3_*` bucket, in the shape `s3.ts` operations want. */
export function liveHlsStorageConfig(): StorageConfig | null {
  return buildStorageConfig({
    bucket: process.env.LIVE_HLS_S3_BUCKET,
    accessKeyId: process.env.LIVE_HLS_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY,
    endpoint: process.env.LIVE_HLS_S3_ENDPOINT,
    region: process.env.LIVE_HLS_S3_REGION,
    forcePathStyle: process.env.LIVE_HLS_S3_FORCE_PATH_STYLE === "true",
    publicBaseUrl: process.env.LIVE_HLS_PUBLIC_BASE_URL,
  });
}

/**
 * The exact string every object ONE RENDITION writes starts with: the
 * segments (`filenamePrefix`) and both playlist names all derive from
 * `live/{channelId}/{startedAt}-{rung}`, per `segmentOutput` below. The
 * retention sweep deletes only objects under this prefix, so this function
 * is the single source of truth both `hls-egress.ts` and `hls-cleanup.ts`
 * call, rather than each re-deriving the string.
 *
 * The rung is part of the prefix because a ladder runs one egress per
 * rendition and each needs its own segments, its own media playlist and its
 * own retention row. Omitting it names the session as a whole, which is what
 * `sessionPrefixPattern` matches on and what a pre-ladder session's single
 * row still looks like.
 */
export function hlsObjectPrefix(
  channelId: string,
  startedAt: number,
  rung?: string,
): string {
  const base = `live/${channelId}/${startedAt}`;
  return rung ? `${base}-${rung}` : base;
}

/**
 * A `LIKE` pattern matching every rung of one session. Safe as a literal:
 * the channel id is a UUID and `startedAt` is digits, so neither can carry
 * `%` or `_`.
 */
export function sessionPrefixPattern(
  channelId: string,
  startedAt: number,
): string {
  return `${hlsObjectPrefix(channelId, startedAt)}-%`;
}

/** One row per rendition: each has its own objects, egress and retention. */
async function recordSessionStarted(
  channelId: string,
  startedAt: number,
  egressId: string,
  rung: string,
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO hls_sessions (channel_id, object_prefix, started_at, egress_id, rung)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5)
       ON CONFLICT (object_prefix) DO NOTHING`,
      [
        channelId,
        hlsObjectPrefix(channelId, startedAt, rung),
        startedAt,
        egressId,
        rung,
      ],
    );
  } catch (error) {
    logEvent("voice.hlsSessionRecordFailed", {
      channelId,
      startedAt,
      rung,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * End one rung's row, or (no rung) every rung of the session. Ending a
 * single rung is what drops a dead secondary rendition out of the master
 * playlist while the rest of the ladder keeps playing.
 */
async function recordSessionEnded(
  channelId: string,
  startedAt: number,
  rung?: string,
): Promise<void> {
  try {
    if (rung) {
      await getPool().query(
        `UPDATE hls_sessions SET ended_at = NOW()
         WHERE object_prefix = $1 AND ended_at IS NULL`,
        [hlsObjectPrefix(channelId, startedAt, rung)],
      );
      return;
    }
    await getPool().query(
      `UPDATE hls_sessions SET ended_at = NOW()
       WHERE channel_id = $1
         AND (object_prefix = $2 OR object_prefix LIKE $3)
         AND ended_at IS NULL`,
      [
        channelId,
        hlsObjectPrefix(channelId, startedAt),
        sessionPrefixPattern(channelId, startedAt),
      ],
    );
  } catch (error) {
    logEvent("voice.hlsSessionEndFailed", {
      channelId,
      startedAt,
      rung: rung ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function liveHlsStorage(): {
  bucket: string;
  accessKey: string;
  secret: string;
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
} | null {
  const bucket = process.env.LIVE_HLS_S3_BUCKET?.trim();
  const accessKey = process.env.LIVE_HLS_S3_ACCESS_KEY_ID?.trim();
  const secret = process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY?.trim();
  const endpoint = process.env.LIVE_HLS_S3_ENDPOINT?.trim();
  if (!bucket || !accessKey || !secret || !endpoint) {
    return null;
  }
  return {
    bucket,
    accessKey,
    secret,
    endpoint,
    region: process.env.LIVE_HLS_S3_REGION?.trim() || "auto",
    forcePathStyle: process.env.LIVE_HLS_S3_FORCE_PATH_STYLE === "true",
  };
}

/**
 * Flag plus every secret the egress request needs. Read per call. The
 * public base is part of "configured" only in unsigned mode, where it is the
 * URL a viewer is handed; signed mode never reads it (see the file header).
 */
export function isLiveHlsEnabled(): boolean {
  return (
    truthyEnabled() &&
    isLiveKitConfigured() &&
    (hlsSignedUrlsEnabled() || publicBaseUrl() !== null) &&
    liveHlsStorage() !== null
  );
}

/**
 * `LIVE_HLS_SERVER_ALLOWLIST`: comma-separated server ids that may run live
 * HLS. Unset or empty means every server (null). Read per call, like the
 * flag, so an operator can widen the list without a deploy.
 */
export function liveHlsServerAllowlist(): Set<string> | null {
  const raw = process.env.LIVE_HLS_SERVER_ALLOWLIST;
  if (!raw) {
    return null;
  }
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return ids.length > 0 ? new Set(ids) : null;
}

/**
 * The per-server answer: the global flag, and the server is on the allowlist
 * (or there is no allowlist). A conversation has no server id and is never
 * HLS, whatever the list says.
 */
export function isLiveHlsEnabledForServer(
  serverId: string | null | undefined,
): boolean {
  if (!isLiveHlsEnabled()) {
    return false;
  }
  const allowlist = liveHlsServerAllowlist();
  if (allowlist === null) {
    return true;
  }
  return Boolean(serverId) && allowlist.has(serverId!);
}

export interface LiveHlsConfig {
  /** Per-server when a `serverId` is given, the global flag otherwise. */
  enabled: boolean;
  delaySeconds: number;
  /** Whether an allowlist exists at all; the client may say why it is off. */
  allowlisted: boolean;
  /**
   * The renditions this deployment encodes, lowest first. The presenter's
   * client reads the TOP of it: the egress transcodes from the published
   * WebRTC track, so a 720p source cannot produce a 1080p rendition however
   * the ladder is configured. Sending it here rather than hard-coding 1080
   * in the client means an operator who runs a 720p-only ladder does not get
   * a presenter uploading 4 Mbit/s for nothing.
   */
  ladder: { name: string; width: number; height: number; videoKbps: number }[];
}

export function liveHlsConfig(serverId?: string | null): LiveHlsConfig {
  const allowlist = liveHlsServerAllowlist();
  return {
    enabled:
      serverId === undefined || serverId === null
        ? isLiveHlsEnabled()
        : isLiveHlsEnabledForServer(serverId),
    delaySeconds: delaySeconds(),
    allowlisted: allowlist !== null,
    ladder: liveHlsLadder().map((rung) => ({
      name: rung.name,
      width: rung.width,
      height: rung.height,
      videoKbps: rung.videoKbps,
    })),
  };
}

export function liveHlsStreamFor(channelId: string): LiveHlsStream | null {
  return rooms.get(channelId)?.stream ?? null;
}

/** Tests inject fakes; production leaves both null. */
export function setLiveHlsTestHooks(hooks: {
  egress?: LiveHlsEgressApi | null;
  findTracks?: LiveHlsTrackFinder | null;
  playlistReady?: boolean;
  /** Body the monitor reads for one rung's live playlist (fake stack). */
  playlistProbe?: ((channelId: string, rung: string) => string | null) | null;
}): void {
  if ("playlistProbe" in hooks) {
    injectedPlaylistProbe = hooks.playlistProbe ?? null;
  }
  if ("egress" in hooks) {
    injectedEgress = hooks.egress ?? null;
  }
  if ("findTracks" in hooks) {
    injectedFinder = hooks.findTracks ?? null;
  }
  if (hooks.playlistReady !== undefined) {
    injectedPlaylistReady = hooks.playlistReady;
  }
}

export function resetLiveHlsForTests(): void {
  rooms.clear();
  restartHistory.clear();
  failedUntil.clear();
  for (const timer of pendingRestarts.values()) {
    clearTimeout(timer);
  }
  pendingRestarts.clear();
  reconcileQueue.clear();
  changeListener = null;
  sfuLoadReader = null;
  stopLiveHlsMonitor();
  warnedLadder = null;
  injectedEgress = null;
  injectedFinder = null;
  injectedPlaylistReady = true;
  injectedPlaylistProbe = null;
}

export function setLiveHlsChangeListener(
  listener: LiveHlsChangeListener | null,
): void {
  changeListener = listener;
}

export function setLiveHlsSfuLoadReader(
  reader: LiveHlsSfuLoadReader | null,
): void {
  sfuLoadReader = reader;
}

/** Renditions this process has running, across every channel. */
export function runningRungCount(): number {
  let total = 0;
  for (const room of rooms.values()) {
    total += room.rungs.length;
  }
  return total;
}

/**
 * The rungs a live session is actually serving, lowest first. The playlist
 * proxy builds the master from the database rather than from this, so that a
 * request mid-restart still answers; this is for the room, the tests and the
 * config endpoint.
 */
export function liveHlsRungsFor(channelId: string): LadderRung[] {
  return (rooms.get(channelId)?.rungs ?? []).map((entry) => entry.rung);
}

function notifyChanged(channelId: string, reason: string): void {
  if (!changeListener) {
    return;
  }
  try {
    changeListener(channelId, reason);
  } catch (error) {
    logEvent("voice.hlsChangeListenerFailed", {
      channelId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Timestamps inside the window, oldest first. */
function recentRestarts(channelId: string, now: number): number[] {
  const kept = (restartHistory.get(channelId) ?? []).filter(
    (at) => now - at < HLS_RESTART_WINDOW_MS,
  );
  if (kept.length === 0) {
    restartHistory.delete(channelId);
  } else {
    restartHistory.set(channelId, kept);
  }
  return kept;
}

/**
 * An egress for this channel is gone while the share may still be live.
 * Counts the attempt; under the cap, asks the listener to reconcile after
 * a backoff (2 s, 4 s, 8 s, capped at 15 s), which starts a new session
 * and hands viewers the new playlist URL. Over the cap, the channel is
 * marked failed for `FAILED_COOLDOWN_MS` (or until the share stops) and the
 * listener is asked once more so viewers get `stream: null` instead of a
 * frozen last frame.
 */
function scheduleRestart(
  channelId: string,
  reason: string,
  now = Date.now(),
): "scheduled" | "failed" {
  const history = recentRestarts(channelId, now);
  if (history.length >= HLS_MAX_RESTARTS) {
    failedUntil.set(channelId, now + FAILED_COOLDOWN_MS);
    restartHistory.delete(channelId);
    logEvent("voice.hlsFailed", {
      channelId,
      reason,
      restarts: history.length,
      windowMs: HLS_RESTART_WINDOW_MS,
    });
    notifyChanged(channelId, "failed");
    return "failed";
  }
  history.push(now);
  restartHistory.set(channelId, history);
  const attempt = history.length;
  const backoff = Math.min(
    RESTART_BACKOFF_BASE_MS * 2 ** (attempt - 1),
    RESTART_BACKOFF_MAX_MS,
  );
  logEvent("voice.hlsRestartScheduled", {
    channelId,
    reason,
    attempt,
    backoffMs: backoff,
  });
  const existing = pendingRestarts.get(channelId);
  if (existing) {
    clearTimeout(existing);
  }
  pendingRestarts.set(
    channelId,
    setTimeout(() => {
      pendingRestarts.delete(channelId);
      notifyChanged(channelId, reason);
    }, backoff),
  );
  return "scheduled";
}

function isFailed(channelId: string, now = Date.now()): boolean {
  const until = failedUntil.get(channelId);
  if (until === undefined) {
    return false;
  }
  if (until <= now) {
    failedUntil.delete(channelId);
    return false;
  }
  return true;
}

/** Whether the channel is in its post-cap cooldown (for the room and tests). */
export function isLiveHlsFailed(channelId: string): boolean {
  return isFailed(channelId);
}

function clearFailure(channelId: string): void {
  failedUntil.delete(channelId);
  restartHistory.delete(channelId);
  const pending = pendingRestarts.get(channelId);
  if (pending) {
    clearTimeout(pending);
    pendingRestarts.delete(channelId);
  }
}

function healthFromListing(
  egressId: string,
  listing: EgressListing[],
): EgressHealth {
  const info = listing.find((item) => item.egressId === egressId);
  if (!info) {
    // LiveKit forgot it (a restart of the SFU, or Redis wiped). Egress
    // cannot be running in a room LiveKit does not know about.
    return "ended";
  }
  return info.status === EgressStatus.EGRESS_STARTING ||
    info.status === EgressStatus.EGRESS_ACTIVE
    ? "alive"
    : "ended";
}

/**
 * `EXT-X-MEDIA-SEQUENCE` plus the segment count: the two numbers that move
 * while an egress is writing. Either one changing is progress.
 */
export function playlistProgressKey(body: string): string {
  let sequence = "";
  let segments = 0;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      sequence = line.slice("#EXT-X-MEDIA-SEQUENCE:".length);
    } else if (line !== "" && !line.startsWith("#")) {
      segments += 1;
    }
  }
  return `${sequence}:${segments}`;
}

/** The live playlist body for one rendition, or null when unreadable now. */
async function probePlaylist(
  channelId: string,
  startedAt: number,
  rung: string,
): Promise<string | null> {
  if (injectedEgress) {
    return injectedPlaylistProbe
      ? injectedPlaylistProbe(channelId, rung)
      : null;
  }
  try {
    const response = await fetch(
      internalPlaylistUrl(channelId, startedAt, rung),
      {
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Whether one rendition's playlist has stopped moving. Records the shape it
 * sees on the rung so the next pass can compare; `unknown` when it could not
 * read.
 */
async function playlistHealth(
  channelId: string,
  startedAt: number,
  entry: RunningRung,
  now: number,
): Promise<EgressHealth> {
  const body = await probePlaylist(channelId, startedAt, entry.rung.name);
  if (body === null) {
    return "unknown";
  }
  const key = playlistProgressKey(body);
  if (!entry.progress || entry.progress.key !== key) {
    entry.progress = { key, at: now };
    return "alive";
  }
  return now - entry.progress.at >= PLAYLIST_STUCK_MS ? "ended" : "alive";
}

/** Status plus playlist movement, for one rendition. */
async function rungHealth(
  egress: LiveHlsEgressApi,
  channelId: string,
  startedAt: number,
  entry: RunningRung,
  now: number,
): Promise<{ health: EgressHealth; detail?: string }> {
  let health: EgressHealth = "unknown";
  let detail: string | undefined;
  if (egress.listEgress) {
    try {
      const listing = await egress.listEgress({ egressId: entry.egressId });
      health = healthFromListing(entry.egressId, listing);
      detail = listing.find((item) => item.egressId === entry.egressId)?.error;
    } catch (error) {
      logEvent("voice.hlsHealthCheckFailed", {
        channelId,
        egressId: entry.egressId,
        rung: entry.rung.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (health !== "ended") {
    const playlist = await playlistHealth(channelId, startedAt, entry, now);
    if (playlist === "ended") {
      health = "ended";
      detail = detail ?? `playlist stuck for ${PLAYLIST_STUCK_MS} ms`;
    }
  }
  return { health, detail };
}

/**
 * One monitor pass: every room's egress is looked up by id, and its live
 * playlist is read to see whether it still moves. Either saying "ended" is
 * enough; the status check catches a clean failure fast, the playlist
 * check catches the killed node LiveKit never hears about. Exported so the
 * test can drive it with a fake clock; `startLiveHlsMonitor` runs it on an
 * interval. Returns the channels it restarted or failed, for the log and
 * the test.
 */
export async function checkLiveHlsHealth(
  now = Date.now(),
): Promise<{ channelId: string; outcome: "scheduled" | "failed" }[]> {
  const egress = getEgress();
  if (!egress) {
    return [];
  }
  const outcomes: { channelId: string; outcome: "scheduled" | "failed" }[] =
    [];
  for (const [channelId, room] of [...rooms.entries()]) {
    if (now - room.startedAtMs < HEALTH_GRACE_MS) {
      continue;
    }
    const startedAt = room.stream.startedAt;
    const primary = room.rungs[0];
    if (!primary) {
      continue;
    }
    // Secondary rungs first, and one at a time: a dead extra rendition is
    // dropped from the ladder and the viewers on it fall to the primary,
    // which is what a master playlist is for. Only the primary dying is a
    // dead stream, because it is the one every viewer can always reach.
    for (const entry of [...room.rungs.slice(1)]) {
      const { health, detail } = await rungHealth(
        egress,
        channelId,
        startedAt,
        entry,
        now,
      );
      if (health !== "ended" || rooms.get(channelId) !== room) {
        continue;
      }
      room.rungs = room.rungs.filter((item) => item !== entry);
      await recordSessionEnded(channelId, startedAt, entry.rung.name);
      logEvent("voice.hlsRungDied", {
        channelId,
        egressId: entry.egressId,
        rung: entry.rung.name,
        remaining: room.rungs.map((item) => item.rung.name),
        error: detail ?? null,
      });
      // The master playlist is built per request from the rows, so it
      // already lists one variant fewer. Tell the room anyway: a viewer
      // pinned to this rung needs a fresh source, not a stalled one.
      notifyChanged(channelId, "rung-ended");
    }
    if (rooms.get(channelId) !== room) {
      continue;
    }
    const { health, detail } = await rungHealth(
      egress,
      channelId,
      startedAt,
      primary,
      now,
    );
    if (health !== "ended") {
      continue;
    }
    // Still the same session? A reconcile may have replaced it meanwhile.
    if (rooms.get(channelId) !== room) {
      continue;
    }
    rooms.delete(channelId);
    await stopRungs(channelId, room.rungs.slice(1));
    await recordSessionEnded(channelId, startedAt);
    logEvent("voice.hlsEgressDied", {
      channelId,
      egressId: primary.egressId,
      rung: primary.rung.name,
      error: detail ?? null,
    });
    outcomes.push({
      channelId,
      outcome: scheduleRestart(channelId, "egress-ended", now),
    });
  }
  return outcomes;
}

export function startLiveHlsMonitor(): void {
  if (monitorTimer) {
    return;
  }
  monitorTimer = setInterval(() => {
    void checkLiveHlsHealth().catch((error: unknown) => {
      logEvent("voice.hlsMonitorFailed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, HLS_HEALTH_CHECK_INTERVAL_MS);
  monitorTimer.unref?.();
}

export function stopLiveHlsMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

function liveKitHttpUrl(): string {
  const url = process.env.LIVEKIT_URL!;
  return url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
}

function getEgress(): LiveHlsEgressApi | null {
  if (injectedEgress) {
    return injectedEgress;
  }
  if (!isLiveKitConfigured()) {
    return null;
  }
  const client = new EgressClient(
    liveKitHttpUrl(),
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
  );
  return {
    startTrackCompositeEgress: async (roomName, output, opts) => {
      const info = await client.startTrackCompositeEgress(
        roomName,
        { segments: output },
        {
          audioTrackId: opts.audioTrackId,
          videoTrackId: opts.videoTrackId,
          encodingOptions: opts.encodingOptions,
        },
      );
      return { egressId: info.egressId };
    },
    stopEgress: async (egressId) => {
      await client.stopEgress(egressId);
    },
    listEgress: async (opts) => {
      const infos = await client.listEgress(opts);
      return infos.map((info) => ({
        egressId: info.egressId,
        status: info.status,
        error: info.error || undefined,
      }));
    },
  };
}

/**
 * Stop every egress LiveKit still runs for a room. Boot uses it for the
 * sessions a previous process left behind: their rows are ended so retention
 * runs, and the transcode itself must not keep burning the box's CPU into a
 * prefix nobody will ever be handed again.
 */
export async function stopActiveEgressesForRoom(
  roomName: string,
): Promise<string[]> {
  const egress = getEgress();
  if (!egress?.listEgress) {
    return [];
  }
  const stopped: string[] = [];
  const listing = await egress.listEgress({ roomName });
  for (const info of listing) {
    if (healthFromListing(info.egressId, listing) !== "alive") {
      continue;
    }
    try {
      await egress.stopEgress(info.egressId);
      stopped.push(info.egressId);
    } catch (error) {
      logEvent("voice.hlsStopFailed", {
        channelId: roomName,
        egressId: info.egressId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return stopped;
}

function isTrackSource(source: unknown, wanted: TrackSource): boolean {
  return source === wanted || source === TrackSource[wanted];
}

async function defaultFindTracks(
  roomName: string,
  logInventory: boolean,
): Promise<LiveHlsScreenTracks | null> {
  if (!isLiveKitConfigured()) {
    return null;
  }
  const client = new RoomServiceClient(
    process.env.LIVEKIT_URL!,
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
  );
  const participants = await client.listParticipants(roomName);
  let videoTrackId: string | undefined;
  let audioTrackId: string | undefined;
  const inventory: { source: unknown; sid: string | undefined }[] = [];
  for (const participant of participants) {
    for (const track of participant.tracks) {
      inventory.push({ source: track.source, sid: track.sid });
      if (isTrackSource(track.source, TrackSource.SCREEN_SHARE) && track.sid) {
        videoTrackId = track.sid;
      }
      if (
        isTrackSource(track.source, TrackSource.SCREEN_SHARE_AUDIO) &&
        track.sid
      ) {
        audioTrackId = track.sid;
      }
    }
  }
  if (!videoTrackId && logInventory) {
    logEvent("voice.hlsTrackInventory", {
      room: roomName,
      participants: participants.length,
      tracks: inventory,
    });
  }
  return videoTrackId ? { videoTrackId, audioTrackId } : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Tests skip the public GET; production waits so joiners are not handed a 404. */
async function waitForLivePlaylist(url: string): Promise<boolean> {
  if (injectedEgress) {
    return injectedPlaylistReady;
  }
  for (let attempt = 0; attempt < PLAYLIST_WAIT_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok && playlistLooksLive(await response.text())) {
        return true;
      }
    } catch (error) {
      if (attempt + 1 === PLAYLIST_WAIT_ATTEMPTS) {
        logEvent("voice.hlsPlaylistPollFailed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (attempt + 1 < PLAYLIST_WAIT_ATTEMPTS) {
      await sleep(PLAYLIST_WAIT_GAP_MS);
    }
  }
  return false;
}

async function findScreenTracks(
  roomName: string,
): Promise<LiveHlsScreenTracks | null> {
  if (injectedFinder) {
    return injectedFinder(roomName);
  }
  for (let attempt = 0; attempt < TRACK_FIND_ATTEMPTS; attempt += 1) {
    try {
      const last = attempt + 1 === TRACK_FIND_ATTEMPTS;
      const tracks = await defaultFindTracks(roomName, last);
      if (tracks) {
        return tracks;
      }
    } catch (error) {
      logEvent("voice.hlsTrackFindFailed", {
        room: roomName,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (attempt + 1 < TRACK_FIND_ATTEMPTS) {
      await sleep(TRACK_FIND_GAP_MS);
    }
  }
  return null;
}

/**
 * One look at the SFU, no retries: this runs while a share is already up,
 * so an empty answer means "cannot tell right now", not "not sharing yet".
 */
async function probeScreenTracks(
  roomName: string,
): Promise<LiveHlsScreenTracks | null> {
  try {
    if (injectedFinder) {
      return await injectedFinder(roomName);
    }
    return await defaultFindTracks(roomName, false);
  } catch (error) {
    logEvent("voice.hlsTrackProbeFailed", {
      room: roomName,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** How long this process's own presigned read of the playlist is valid. */
const INTERNAL_PLAYLIST_TTL_SECONDS = 60;

/**
 * The URL THIS PROCESS fetches the live playlist from: the readiness probe
 * after egress starts, and the playlist proxy's own read. Always a presigned
 * GET in endpoint form (never the custom domain), so it works against a
 * fully private bucket and needs no `LIVE_HLS_PUBLIC_BASE_URL`. Production
 * runs exactly that: signed mode, `pqp-live` private, no public base.
 */
export function internalPlaylistUrl(
  channelId: string,
  startedAt: number,
  rung?: string,
): string {
  const config = liveHlsStorageConfig();
  if (!config) {
    return rawPlaylistUrl(channelId, startedAt, rung);
  }
  return signRequest({
    method: "GET",
    key: `${hlsObjectPrefix(channelId, startedAt, rung)}.m3u8`,
    ttlSeconds: INTERNAL_PLAYLIST_TTL_SECONDS,
    forRead: false,
    config,
  }).url;
}

/**
 * The raw public bucket URL. Only meaningful with `LIVE_HLS_SIGNED_URLS=false`
 * and a public base, where it is what a viewer is handed. Nothing internal
 * reads it any more (`internalPlaylistUrl` does that), so with the default
 * signed mode this is never called.
 *
 * LiveKit treats filenamePrefix as a file prefix, not a directory. Segments
 * land at live/{channel}/{startedAt}_00000.ts; a reused live.m3u8 keeps the
 * previous share's #EXT-X-ENDLIST until overwrite, so each share gets its
 * own playlist name.
 */
export function rawPlaylistUrl(
  channelId: string,
  startedAt: number,
  rung?: string,
): string {
  return `${publicBaseUrl()}/${hlsObjectPrefix(channelId, startedAt, rung)}.m3u8`;
}

/**
 * What a viewer is actually handed as `LiveHlsStream.hlsUrl`.
 *
 * `startedAt` rides in the signed path (not just the sibling `startedAt`
 * field) so this string changes every time a session restarts -- the same
 * reason each session already gets its own playlist name on the raw bucket
 * URL: `reconcileLiveHls`'s track-replace restart needs viewers to reload,
 * and a stable per-channel URL would not carry that signal on its own.
 */
function viewerPlaylistUrl(channelId: string, startedAt: number): string {
  if (!hlsSignedUrlsEnabled()) {
    return rawPlaylistUrl(channelId, startedAt);
  }
  // API-relative: the client prefixes this with its own API base URL and
  // (for hls.js) attaches its Bearer token via xhrSetup. See
  // `hls-playlist-proxy.ts` for the proxy that answers this route.
  return `/api/voice/hls-playlist/${channelId}/${startedAt}`;
}

function segmentOutput(
  prefix: string,
  startedAt: number,
  rung: string,
): SegmentedFileOutput {
  const storage = liveHlsStorage()!;
  // LiveKit resolves both playlist names against the DIRECTORY of
  // `filenamePrefix`, so the rung has to be repeated in the names or every
  // rendition would overwrite the same two playlist objects.
  return new SegmentedFileOutput({
    filenamePrefix: prefix,
    playlistName: `${startedAt}-${rung}-index.m3u8`,
    livePlaylistName: `${startedAt}-${rung}.m3u8`,
    segmentDuration: 2,
    output: {
      case: "s3",
      value: new S3Upload({
        accessKey: storage.accessKey,
        secret: storage.secret,
        bucket: storage.bucket,
        region: storage.region,
        endpoint: storage.endpoint,
        forcePathStyle: storage.forcePathStyle,
      }),
    },
  });
}

/** Stop these renditions' egresses, tolerating one that is already gone. */
async function stopRungs(
  channelId: string,
  entries: readonly RunningRung[],
): Promise<void> {
  const egress = getEgress();
  if (!egress) {
    return;
  }
  for (const entry of entries) {
    try {
      await egress.stopEgress(entry.egressId);
    } catch (error) {
      logEvent("voice.hlsStopFailed", {
        channelId,
        egressId: entry.egressId,
        rung: entry.rung.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function stopRoom(channelId: string): Promise<void> {
  const current = rooms.get(channelId);
  if (!current) {
    return;
  }
  rooms.delete(channelId);
  await recordSessionEnded(channelId, current.stream.startedAt);
  await stopRungs(channelId, current.rungs);
}

/**
 * Ask LiveKit for one rendition. Returns the egress id, or null when the
 * request itself failed (the caller decides whether that is fatal: it is for
 * the primary rung, and merely a shorter ladder for the rest).
 */
async function startRung(
  egress: LiveHlsEgressApi,
  channelId: string,
  startedAt: number,
  tracks: LiveHlsScreenTracks,
  rung: LadderRung,
): Promise<string | null> {
  try {
    const started = await egress.startTrackCompositeEgress(
      channelId,
      segmentOutput(
        hlsObjectPrefix(channelId, startedAt, rung.name),
        startedAt,
        rung.name,
      ),
      {
        videoTrackId: tracks.videoTrackId,
        audioTrackId: tracks.audioTrackId,
        encodingOptions: rungEncodingOptions(rung),
      },
    );
    return started.egressId;
  } catch (error) {
    logEvent("voice.hlsRungStartFailed", {
      channelId,
      rung: rung.name,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** What the WebRTC side already costs, or 0 when nothing can tell us. */
async function currentSfuLoadMbps(): Promise<number> {
  if (!sfuLoadReader) {
    return 0;
  }
  try {
    return await sfuLoadReader();
  } catch (error) {
    logEvent("voice.hlsLoadReadFailed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

async function startRoom(
  channelId: string,
  presenterPeerId: string,
  knownTracks?: LiveHlsScreenTracks,
): Promise<LiveHlsStream | null> {
  const egress = getEgress();
  if (!egress || !isLiveHlsEnabled()) {
    return null;
  }
  if (isFailed(channelId)) {
    logEvent("voice.hlsStartSuppressed", { channelId, presenterPeerId });
    return null;
  }
  const tracks = knownTracks ?? (await findScreenTracks(channelId));
  if (!tracks) {
    logEvent("voice.hlsNoScreenTrack", { channelId, presenterPeerId });
    return null;
  }
  const ladder = liveHlsLadder();
  const decisions = decideLadder({
    rungs: ladder,
    runningRungs: runningRungCount(),
    sfuLoadMbps: await currentSfuLoadMbps(),
    ladderBudgetMbps: ladderBudgetMbps(),
    boxBudgetMbps: promotionBudgetMbps(),
  });
  const startedAt = Date.now();
  const running: RunningRung[] = [];
  for (const decision of decisions) {
    if (!decision.start) {
      logEvent("voice.hlsRungRefused", {
        channelId,
        rung: decision.rung.name,
        refusal: decision.refusal,
        ladderMbps: Math.round(decision.ladderMbps),
        boxMbps: Math.round(decision.boxMbps),
        ladderBudgetMbps: ladderBudgetMbps(),
        boxBudgetMbps: promotionBudgetMbps(),
      });
      continue;
    }
    const egressId = await startRung(
      egress,
      channelId,
      startedAt,
      tracks,
      decision.rung,
    );
    if (!egressId) {
      if (running.length === 0) {
        // The lowest rung is the stream. Nothing above it is worth starting
        // if a viewer would have no rendition to fall back to.
        scheduleRestart(channelId, "start-failed");
        return null;
      }
      continue;
    }
    running.push({
      rung: decision.rung,
      egressId,
      startedAtMs: startedAt,
      progress: null,
    });
    await recordSessionStarted(
      channelId,
      startedAt,
      egressId,
      decision.rung.name,
    );
  }
  const primary = running[0];
  if (!primary) {
    scheduleRestart(channelId, "start-failed");
    return null;
  }
  const stream: LiveHlsStream = {
    hlsUrl: viewerPlaylistUrl(channelId, startedAt),
    startedAt,
    presenterPeerId,
    delaySeconds: delaySeconds(),
    // What actually started, not what was configured: a rung refused for
    // budget must not tell the presenter to upload for it.
    topHeight: Math.max(...running.map((entry) => entry.rung.height)),
  };
  const room: RoomHls = {
    rungs: running,
    stream,
    videoTrackId: tracks.videoTrackId,
    startedAtMs: startedAt,
  };
  rooms.set(channelId, room);
  // The readiness probe reads the bucket itself (presigned, endpoint form),
  // never the viewer-facing URL: a viewer gets the signed master path, which
  // this same process cannot usefully fetch from here. It waits on the
  // PRIMARY rung, because that is the one a viewer is guaranteed to land on.
  const ready = await waitForLivePlaylist(
    internalPlaylistUrl(channelId, startedAt, primary.rung.name),
  );
  logEvent("voice.hlsStarted", {
    channelId,
    presenterPeerId,
    playlistReady: ready,
    started: running.map((entry) => entry.rung.name),
    refused: decisions
      .filter((decision) => !decision.start)
      .map((decision) => `${decision.rung.name}:${decision.refusal}`),
    egressIds: running.map((entry) => entry.egressId),
  });
  if (!ready) {
    // Twenty seconds and no live playlist: this egress is not going to
    // produce one. Handing the URL out anyway parks every viewer on
    // "loading" for the whole share (the pre-fix behaviour). Tear it
    // down and let the restart path try again, under the same cap.
    if (rooms.get(channelId) === room) {
      await stopRoom(channelId);
      scheduleRestart(channelId, "playlist-not-ready");
    }
    return null;
  }
  return stream;
}

/**
 * First sharer in the room wins. A later share does not steal the transcode.
 * `presenterPeerId: null` means nobody is sharing: stop if we were. The
 * same presenter re-declaring is a no-op unless their screen track is a new
 * sid, in which case the egress is bound to a dead track and is restarted
 * (new playlist URL, so the caller broadcasts it and viewers reload).
 * `serverId` is the channel's server: a server outside
 * `LIVE_HLS_SERVER_ALLOWLIST` (or a conversation, null) never starts an
 * egress, and one already running for it is stopped.
 */
export function reconcileLiveHls(
  channelId: string,
  presenterPeerId: string | null,
  serverId: string | null,
): Promise<LiveHlsStream | null> {
  const previous = reconcileQueue.get(channelId) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(() => reconcileLiveHlsNow(channelId, presenterPeerId, serverId));
  reconcileQueue.set(channelId, run);
  void run.finally(() => {
    if (reconcileQueue.get(channelId) === run) {
      reconcileQueue.delete(channelId);
    }
  });
  return run;
}

async function reconcileLiveHlsNow(
  channelId: string,
  presenterPeerId: string | null,
  serverId: string | null,
): Promise<LiveHlsStream | null> {
  if (!isLiveHlsEnabledForServer(serverId)) {
    if (rooms.has(channelId)) {
      await stopRoom(channelId);
    }
    return null;
  }
  const current = rooms.get(channelId);
  if (!presenterPeerId) {
    // A share that stopped resets the restart budget: the next one starts
    // clean rather than inheriting the last one's failures.
    clearFailure(channelId);
    if (current) {
      await stopRoom(channelId);
      logEvent("voice.hlsStopped", { channelId, reason: "no-share" });
    }
    return null;
  }
  if (current && current.stream.presenterPeerId === presenterPeerId) {
    const tracks = await probeScreenTracks(channelId);
    if (!tracks || tracks.videoTrackId === current.videoTrackId) {
      return current.stream;
    }
    logEvent("voice.hlsTrackReplaced", {
      channelId,
      egressIds: current.rungs.map((entry) => entry.egressId),
      from: current.videoTrackId,
      to: tracks.videoTrackId,
    });
    await stopRoom(channelId);
    return startRoom(channelId, presenterPeerId, tracks);
  }
  if (current) {
    await stopRoom(channelId);
  }
  return startRoom(channelId, presenterPeerId);
}

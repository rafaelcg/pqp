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
  CAMERA_RUNG,
  CAMERA_RUNG_NAME,
  decideCameraEgress,
  decideLadder,
  HLS_CAMERA_MBPS,
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
const DEFAULT_DELAY_SECONDS = 30;
/**
 * How long a fresh egress gets to produce its first live playlist.
 *
 * WAS 20 SECONDS, AND THAT WAS TOO IMPATIENT. `docs/CAPACITY.md` section 2
 * measured time-to-first-playlist at 10.8 s for a `720p30`-first ladder on an
 * idle box and **43.7 s** for `1080p30` on a saturated core, so the old
 * ceiling sat between the good case and the bad one. Production on 2026-09-09
 * logged `voice.hlsStarted playlistReady=false` immediately followed by
 * `voice.hlsStopped reason=playlist-not-ready` on a box that was carrying
 * leftover transcodes at the time: the session was torn down, one of the three
 * restarts in the window was spent, and the audience got nothing, when waiting
 * a little longer would have served them.
 *
 * The cost of waiting is the host staring at "preparing" for longer. The cost
 * of not waiting is that plus a wasted session plus another wait. Forty-five
 * seconds covers the measured worst case; `voice.hlsStarted` now reports how
 * long it actually took, so the next revision of this number is measured
 * rather than argued.
 */
const PLAYLIST_WAIT_ATTEMPTS = 45;
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
 * First wait after a leftover `StopEgress` fails. Staging 2026-09-12: one
 * dead handler (`no response from servers`) was retried every monitor tick
 * for seven hours, each attempt a 3 s LiveKit timeout, in front of the
 * playlist check. The leftover never came back; the live encode paid for
 * the RPC. After this, 2 min, 5 min, then 15 min.
 */
export const ORPHAN_STOP_BACKOFF_FIRST_MS = 60_000;
const ORPHAN_STOP_BACKOFF_STEPS_MS = [
  ORPHAN_STOP_BACKOFF_FIRST_MS,
  2 * 60_000,
  5 * 60_000,
  15 * 60_000,
] as const;

/**
 * What LiveKit says about one egress, reduced to the three answers the
 * monitor acts on. `unknown` is "could not ask" and never triggers a restart.
 */
export type EgressHealth = "alive" | "ended" | "unknown";

export interface EgressListing {
  egressId: string;
  status: EgressStatus | number;
  error?: string;
  /** The LiveKit room, which for us is the voice channel id. */
  roomName?: string;
}

export interface LiveHlsScreenTracks {
  videoTrackId: string;
  audioTrackId?: string;
  /** Published capture height, when LiveKit stated it. */
  sourceHeight?: number;
  /**
   * The SAME participant's camera, when they have one published.
   *
   * Picked in the same pass as the share on purpose. The reconcile already
   * calls `listParticipants` on every roster event; asking a second time for
   * the camera would double an RPC on a hot path to learn something the first
   * answer already contained. Absent means no camera, which is the ordinary
   * case for a film night.
   */
  cameraTrackId?: string;
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
    active?: boolean;
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
  /**
   * The presenter's camera, transcoded beside the ladder, or null.
   *
   * ADDITIVE TO THE SESSION, NEVER A NEW ONE. It starts and stops inside the
   * running `startedAt`: a new one is a new playlist path, a new viewer token
   * and a new master, so every viewer re-attaches and rebuffers. Turning a
   * webcam on must not do that to an audience. See
   * `docs/plans/WATCH_PARTY_CAMERA_PIP.md`.
   *
   * A `RunningRung` rather than its own shape, because the health monitor,
   * `stopRungs` and `reapForeignEgresses` all want to treat it exactly like a
   * secondary rendition. It carries `CAMERA_RUNG`, which is deliberately not
   * in `LADDER_RUNGS`.
   */
  camera: (RunningRung & { cameraTrackId: string }) | null;
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
/** Leftover ids whose last `StopEgress` failed: do not ask again before `until`. */
const orphanStopBackoff = new Map<
  string,
  { failures: number; until: number }
>();
/**
 * Leftover transcodes this process has stopped since it started, from
 * `reapForeignEgresses`. Belongs at zero. Anything else is a session that
 * leaked handlers onto the media box, and the number is the only evidence a
 * leak ever happened, because the leak itself is silent.
 */
let orphansStopped = 0;
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
 * A comma-separated list of rung names (`720p30`, the default), each
 * optionally carrying a bitrate override (`1080p30@3500`). Named 1080 and
 * 60 fps rungs stay available for an operator who wants them.
 * `LIVE_HLS_PRESET` is still read as the name of a ONE-RUNG ladder, so a
 * deployment that already sets it keeps exactly the behaviour it has.
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
 * How many parties this process will transcode at once. Three.
 *
 * WHY THERE HAS TO BE ONE. `decideLadder` already prices the box, but read
 * its first rule: the lowest rung ALWAYS starts, because a party with no
 * rendition is a party nobody can see. That is right per party and unbounded
 * across parties: the fourth, tenth and fortieth simultaneous party each get
 * their floor rung whatever the budget says, and the budget only ever refuses
 * the rungs above it. So the ladder guard degrades quality and never refuses
 * a session, and something has to refuse the session.
 *
 * WHY THREE. Measured on the box production runs (`docs/CAPACITY.md`,
 * 2026-09-09): `1080p30` costs 0.88 of a core and `720p30` costs 0.51. The
 * first party gets the default two-rung ladder, 1.39 cores; every party after
 * it finds the ladder budget already spent and gets its floor rung alone,
 * 0.51. Three parties is therefore about 2.4 of the box's 4 cores, which
 * leaves the SFU, the TURN relay and everything else on the same machine the
 * rest. An operator with a bigger box says so with a bigger number; there is
 * no sentinel for "unlimited", because a value that turns the guard off is
 * the value somebody sets by accident.
 */
export const DEFAULT_MAX_HLS_SESSIONS = 3;

export function maxLiveHlsSessions(): number {
  return positiveIntFromEnv("LIVE_HLS_MAX_SESSIONS", DEFAULT_MAX_HLS_SESSIONS);
}

/**
 * ON BY DEFAULT, and `LIVE_HLS_REAP_ORPHANS=false` is the rollback switch.
 *
 * `reapForeignEgresses` is the only mechanism here that STOPS something it
 * did not start, and it is landing days before a large event. Its scope is
 * deliberately narrow (see the function), but "one command, no deploy" is how
 * this repo lands anything that can go wrong on a night that matters, the way
 * `TURN_PREFER_STATIC` and `WS_COMPRESSION` do. Turning it off restores the
 * pre-2026-09-09 behaviour: leftovers accumulate and `liveHls.orphansStopped`
 * stays at zero because nothing is looking.
 */
export function reapOrphansEnabled(): boolean {
  const raw = process.env.LIVE_HLS_REAP_ORPHANS?.trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off";
}

/**
 * ON BY DEFAULT, and `LIVE_HLS_CAMERA=false` is the rollback switch.
 *
 * The presenter's camera gets a transcode of its own so the seatless audience
 * can see a face (`docs/plans/WATCH_PARTY_CAMERA_PIP.md`). It costs about
 * 0.2 to 0.3 of a core, only ever while the host has deliberately turned a
 * camera on, and `decideCameraEgress` refuses it outright on a box with
 * nothing left. Turning it off restores exactly the pre-2026-09-12 behaviour:
 * no second egress, no `cameraHlsUrl` on any frame, and every client's PiP
 * draws nothing because there is nothing to draw.
 *
 * One command and no deploy, the same shape as `TURN_PREFER_STATIC` and
 * `LIVE_HLS_REAP_ORPHANS`, because this lands on a box that also carries the
 * SFU and the TURN relay.
 */
export function liveHlsCameraEnabled(): boolean {
  const raw = process.env.LIVE_HLS_CAMERA?.trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off";
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
  presenterPeerId: string,
  videoTrackId: string,
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO hls_sessions
         (channel_id, object_prefix, started_at, egress_id, rung,
          presenter_peer_id, video_track_id)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, $6, $7)
       ON CONFLICT (object_prefix) DO NOTHING`,
      [
        channelId,
        hlsObjectPrefix(channelId, startedAt, rung),
        startedAt,
        egressId,
        rung,
        presenterPeerId,
        videoTrackId,
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

/**
 * A new start for this channel makes every earlier session for it finished,
 * including ones this process never had in `rooms` (a previous API, a
 * share that outlived its watch party). Ending the rows is what lets
 * retention delete their objects; stopping leftover LiveKit egresses is
 * what stops them writing a second live playlist next to the real one.
 *
 * `keepStartedAt` / `keepEgressIds` are THIS start. Without them a
 * concurrent list would stop the rungs we just asked for.
 */
async function endSupersededSessions(
  channelId: string,
  keepStartedAt: number,
  keepEgressIds: ReadonlySet<string>,
): Promise<void> {
  try {
    const ended = await getPool().query(
      `UPDATE hls_sessions SET ended_at = NOW()
       WHERE channel_id = $1
         AND ended_at IS NULL
         AND started_at <> to_timestamp($2 / 1000.0)`,
      [channelId, keepStartedAt],
    );
    if ((ended.rowCount ?? 0) > 0) {
      logEvent("voice.hlsSupersededSessionsEnded", {
        channelId,
        keepStartedAt,
        ended: ended.rowCount,
      });
    }
  } catch (error) {
    logEvent("voice.hlsSupersededSessionEndFailed", {
      channelId,
      keepStartedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const active = await listActiveEgresses();
  if (!active) {
    return;
  }
  for (const info of active) {
    if (info.roomName !== channelId || keepEgressIds.has(info.egressId)) {
      continue;
    }
    const stopped = await stopEgressById(info.egressId, channelId);
    if (stopped) {
      logEvent("voice.hlsSupersededEgressStopped", {
        channelId,
        egressId: info.egressId,
        keepStartedAt,
      });
    }
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
 * `servers.live_hls_enabled` for one server: TRUE / FALSE when an operator
 * has decided, NULL when nobody has.
 *
 * Read per call, never cached, for the same reason the flag is: the whole
 * point of moving this out of the environment is that a change takes effect
 * without a deploy and without restarting `pqp-api`. One indexed primary-key
 * lookup, on paths that run once per room pin and once per share, not per
 * frame.
 *
 * A failed read answers NULL, which falls back to the environment. A database
 * hiccup must not silently revoke a running event's stream, and the
 * environment is exactly the answer this deployment had before the column
 * existed.
 */
export async function liveHlsServerOverride(
  serverId: string,
): Promise<boolean | null> {
  try {
    const result = await getPool().query<{ live_hls_enabled: boolean | null }>(
      `SELECT live_hls_enabled FROM servers WHERE id = $1`,
      [serverId],
    );
    return result.rows[0]?.live_hls_enabled ?? null;
  } catch (error) {
    logEvent("voice.hlsOverrideReadFailed", {
      serverId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The per-server answer, given the row this server carries. Pure, so the
 * whole resolution matrix is testable without a database.
 *
 * ORDER, AND WHY. The master switch first: `LIVE_HLS_ENABLED` plus LiveKit
 * plus the dedicated bucket. Nothing below can turn on a deployment that
 * cannot encode. Then the per-server row, TRUE or FALSE alike, because it is
 * a decision a person made about this one server, from the dashboard, after
 * whoever set the environment variable had left the building; it is also the
 * only kill switch that does not need a deploy, which is worth more during a
 * live event than consistency with a Fly secret. Only a NULL row falls
 * through to `LIVE_HLS_SERVER_ALLOWLIST`, which keeps behaving exactly as it
 * always did: on the list is on, no list at all is every server.
 *
 * The last two lines are the previous function verbatim, INCLUDING the case
 * where there is no allowlist and no server id: a deployment that confines
 * nothing answers true for a conversation too. That is not obviously right
 * (nothing starts an egress outside a `watch_party` channel, which is always
 * in a server), and it is deliberately left alone here: production runs with
 * an allowlist, so it already answers false, and widening or narrowing it is
 * a separate decision from moving the list into a table.
 */
export function resolveLiveHlsForServer(
  serverId: string | null | undefined,
  override: boolean | null,
): boolean {
  if (!isLiveHlsEnabled()) {
    return false;
  }
  if (override !== null) {
    return override;
  }
  const allowlist = liveHlsServerAllowlist();
  if (allowlist === null) {
    return true;
  }
  return Boolean(serverId) && allowlist.has(serverId!);
}

/**
 * The per-server answer, reading the row. Async since the source of truth
 * moved into the database; every caller was already on an async path.
 */
export async function isLiveHlsEnabledForServer(
  serverId: string | null | undefined,
): Promise<boolean> {
  if (!isLiveHlsEnabled()) {
    return false;
  }
  return resolveLiveHlsForServer(
    serverId,
    serverId ? await liveHlsServerOverride(serverId) : null,
  );
}

export interface LiveHlsConfig {
  /** Per-server when a `serverId` is given, the global flag otherwise. */
  enabled: boolean;
  delaySeconds: number;
  /**
   * Whether live HLS is confined to named servers rather than open to all.
   *
   * True when `LIVE_HLS_SERVER_ALLOWLIST` is set, and, for a per-server
   * answer, also when this server's own `live_hls_enabled` row decided it.
   * The client only ever reads it to say why streaming is off, so "somebody
   * chose, per server" is the same sentence as "there is a list".
   */
  allowlisted: boolean;
  /**
   * The renditions this deployment encodes, lowest first. The presenter's
   * client reads the TOP of it: the egress transcodes from the published
   * WebRTC track, so a 720p source cannot produce a 1080p rendition however
   * the ladder is configured. Sending it here rather than hard-coding 1080
   * in the client means an operator who runs a 720p-only ladder does not get
   * a presenter uploading 4 Mbit/s for nothing.
   */
  ladder: {
    name: string;
    width: number;
    height: number;
    framerate: number;
    videoKbps: number;
  }[];
}

/**
 * The deployment-wide answer, with no server in hand. Still synchronous:
 * nothing here reads a row, and the dashboard's metrics payload wants it on
 * the hot path with the rest of the process counters.
 */
export function liveHlsConfig(): LiveHlsConfig {
  const allowlist = liveHlsServerAllowlist();
  return {
    enabled: isLiveHlsEnabled(),
    delaySeconds: delaySeconds(),
    allowlisted: allowlist !== null,
    ladder: liveHlsLadder().map((rung) => ({
      name: rung.name,
      width: rung.width,
      height: rung.height,
      framerate: rung.framerate,
      videoKbps: rung.videoKbps,
    })),
  };
}

/**
 * The answer for one server, or the deployment-wide one when there is no
 * server (`GET /api/live-hls/config` with no `?serverId=`, which is what a
 * client asks before it knows where it is).
 */
export async function liveHlsConfigForServer(
  serverId: string | null,
): Promise<LiveHlsConfig> {
  const base = liveHlsConfig();
  if (!serverId) {
    return base;
  }
  const override = await liveHlsServerOverride(serverId);
  return {
    ...base,
    enabled: resolveLiveHlsForServer(serverId, override),
    allowlisted: base.allowlisted || override !== null,
  };
}

/** The channels this process is currently running an egress for. */
export function liveHlsRunningChannelIds(): string[] {
  return [...rooms.keys()];
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
  orphanStopBackoff.clear();
  orphansStopped = 0;
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

/** Camera transcodes running across every channel. */
export function runningCameraCount(): number {
  let total = 0;
  for (const room of rooms.values()) {
    if (room.camera) {
      total += 1;
    }
  }
  return total;
}

/**
 * What the running cameras cost the box, in the Mbit/s the ladder is priced
 * in.
 *
 * Added to the SFU load rather than to `runningRungs`, and the distinction is
 * deliberate. `runningRungs` counts renditions OF A SHARE and multiplies by a
 * whole `HLS_RUNG_MBPS`; a camera is 30 % of that and is not a rung. Counting
 * it as one would refuse a real rendition of somebody's film to pay for a
 * webcam, which is exactly the trade `decideCameraEgress` refuses to make in
 * the other direction.
 */
export function runningCameraMbps(): number {
  return runningCameraCount() * HLS_CAMERA_MBPS;
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

export interface LiveHlsActivity {
  /** Sessions this process is running an egress for, right now. */
  sessions: number;
  /**
   * `LIVE_HLS_MAX_SESSIONS`. The number `sessions` is refused at, so the
   * dashboard can show "2 of 3" rather than a count with no ceiling, and so
   * an operator raising the cap can read back that the process took it.
   */
  maxSessions: number;
  /** Renditions across all of them: what the media box is actually encoding. */
  rungs: number;
  /** Longest-running session, in minutes, or null when none is live. */
  oldestMinutes: number | null;
  /**
   * Sessions this process started whose transcode has NO audio track: the
   * share was picked without its own audio, so the seatless audience is
   * watching a silent film while the seated room hears everything.
   *
   * It is not an error and it is not always wrong (a silent slideshow is a
   * legitimate share), which is exactly why it needs a number rather than an
   * alert. Sitting at `sessions` during a film night is the thing to look at.
   * Adopted sessions never count: a process that inherited an egress across a
   * restart knows the video track sid from the row and nothing about the
   * audio, and guessing "silent" there would invent an incident.
   */
  silentSessions: number;
  /**
   * Leftover transcodes stopped by `reapForeignEgresses` since this process
   * started. **Belongs at zero**, and anything else is the number that proves
   * a session leaked handlers onto the media box, which is otherwise silent:
   * the box just gets slower and the parties on it start stalling. Per
   * process, so it resets on deploy like every counter here.
   */
  orphansStopped: number;
  /**
   * Sessions currently carrying a second, video-only transcode of the
   * presenter's camera. Each is about 0.2 to 0.3 of a core on top of that
   * party's ladder, so this is the number that turns "the box feels slow" into
   * "three hosts have their webcams on". Zero when `LIVE_HLS_CAMERA=false`.
   */
  cameraSessions: number;
}

/**
 * WHAT THE DASHBOARD READS TO KNOW A TRANSCODE EVER RAN.
 *
 * In-process, so it is the number for the instance that answered, the same
 * way `voice.rooms` is. Zero on a machine that is not the one presenting;
 * zero everywhere for a deployment where the flag is on and the egress
 * silently never starts, which is the case worth being able to see. Pair it
 * with `retention.uncleaned` below: sessions climbing with `uncleaned` flat
 * is healthy, `uncleaned` climbing on its own is a sweep that is not running.
 */
export function liveHlsActivity(now = Date.now()): LiveHlsActivity {
  let rungs = 0;
  let oldest: number | null = null;
  let silentSessions = 0;
  for (const room of rooms.values()) {
    rungs += room.rungs.length;
    oldest = oldest === null ? room.startedAtMs : Math.min(oldest, room.startedAtMs);
    if (room.stream.hasAudio === false) {
      silentSessions += 1;
    }
  }
  return {
    sessions: rooms.size,
    maxSessions: maxLiveHlsSessions(),
    rungs,
    oldestMinutes: oldest === null ? null : Math.floor((now - oldest) / 60_000),
    silentSessions,
    orphansStopped,
    cameraSessions: runningCameraCount(),
  };
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
function orphanStopBackoffMs(failures: number): number {
  const index = Math.min(
    Math.max(failures, 1),
    ORPHAN_STOP_BACKOFF_STEPS_MS.length,
  );
  return ORPHAN_STOP_BACKOFF_STEPS_MS[index - 1]!;
}

function orphanStopHeld(egressId: string, now: number): boolean {
  return (orphanStopBackoff.get(egressId)?.until ?? 0) > now;
}

function rememberOrphanStopFailure(
  egressId: string,
  now: number,
): { failures: number; waitMs: number } {
  const failures = (orphanStopBackoff.get(egressId)?.failures ?? 0) + 1;
  const waitMs = orphanStopBackoffMs(failures);
  orphanStopBackoff.set(egressId, { failures, until: now + waitMs });
  return { failures, waitMs };
}

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
): Promise<{ health: EgressHealth; detail?: string; stillRunning: boolean }> {
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
      // THE DISTINCTION THAT COST A CORE. "Ended" here means the playlist has
      // not moved for `PLAYLIST_STUCK_MS`, and the whole reason that rule
      // exists (see the constant's comment) is that LiveKit goes on reporting
      // a dead node's egress as ACTIVE forever. The converse is the case that
      // was never handled: a transcode whose playlist stalled while the
      // handler is genuinely still running and still burning a core. The
      // monitor used to drop such a rung from its bookkeeping and never stop
      // it, so it transcoded until somebody restarted the media box, and the
      // restart started a second ladder beside it.
      return { health, detail, stillRunning: true };
    }
  }
  // LiveKit itself said it is over, so there is nothing left to stop and
  // asking would only log a failure about an egress that finished normally.
  return { health, detail, stillRunning: false };
}

/**
 * ANY OTHER TRANSCODE RUNNING ON THIS ROOM IS A LEFTOVER. Stop it.
 *
 * The safety net, and the reason it exists is that every path that leaks one
 * looks identical to a healthy party from the API's side. A live production
 * watch party on 2026-09-09 showed two `voice.hlsStarted` for one channel nine
 * minutes apart with the same presenter and **nothing at all logged in
 * between**, and the earlier pair's handlers were still on the media box two
 * minutes after the later pair started: four transcoders on one room, on a
 * four core box that also carries the SFU and the TURN relay.
 *
 * The individual leaks are worth fixing one at a time and are (the stuck-but-
 * running rung directly above, the silent teardowns in `reconcileLiveHlsNow`).
 * This is the net under them, because `LIVE_HLS_MAX_SESSIONS` counts SESSIONS
 * and a session that can transiently be four handlers instead of two makes the
 * cap of 3 mean twelve.
 *
 * SCOPED TO ROOMS THIS PROCESS HAS A SESSION FOR, deliberately. "Stop every
 * active egress I do not recognise" would kill the ones `adoptLiveHlsSession`
 * exists to inherit across a deploy, which is the opposite of the promise that
 * a party does not notice a restart. Within a room we are already presenting,
 * an egress that is not one of our rungs cannot be anything but ours from
 * before. The 15 s health grace covers the boot window in which a ladder's
 * rungs are still being adopted one at a time.
 *
 * A listing we could not fetch is never a reason to act, the same rule
 * `listActiveEgresses` states for the retention sweep: "could not ask" is not
 * "nothing is running".
 */
async function reapForeignEgresses(
  egress: LiveHlsEgressApi,
  channelId: string,
  room: RoomHls,
  now: number,
): Promise<void> {
  if (!egress.listEgress || !reapOrphansEnabled()) {
    return;
  }
  let listing: EgressListing[];
  try {
    listing = await egress.listEgress({ roomName: channelId, active: true });
  } catch (error) {
    logEvent("voice.hlsReapListFailed", {
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  // THE CAMERA IS ONE OF OURS. Leaving it out of this set would have the
  // reaper stop it on the first monitor tick and the reconcile start it again
  // on the next push, forever, with `liveHls.orphansStopped` climbing and
  // nothing wrong: a silent, total failure of the shape this file has already
  // been bitten by twice.
  const ours = new Set(room.rungs.map((entry) => entry.egressId));
  if (room.camera) {
    ours.add(room.camera.egressId);
  }
  for (const info of listing) {
    if (ours.has(info.egressId)) {
      continue;
    }
    // THE FILTER IS RE-CHECKED HERE, and it is not paranoia about our own
    // code. `roomName` went into the request; if a LiveKit version, a proxy or
    // a future SDK ignored it, this loop would stop every other party's live
    // transcode across the instance, which is the worst outcome available to
    // anything in this file. A listing entry that does not name its room is
    // left alone rather than assumed to be this one.
    if (info.roomName !== channelId) {
      continue;
    }
    if (healthFromListing(info.egressId, listing) !== "alive") {
      continue;
    }
    if (orphanStopHeld(info.egressId, now)) {
      continue;
    }
    const stopped = await stopEgressById(info.egressId, channelId);
    if (stopped) {
      orphansStopped += 1;
      logEvent("voice.hlsOrphanStopped", {
        channelId,
        egressId: info.egressId,
        ours: [...ours],
      });
    }
  }
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
    // BEFORE the health checks, not after: a leftover ladder is what makes the
    // box slow enough for the live one's playlist to stall, which is the
    // stuck-playlist verdict, which schedules a restart, which starts a third.
    await reapForeignEgresses(egress, channelId, room, now);
    if (rooms.get(channelId) !== room) {
      continue;
    }
    // Secondary rungs first, and one at a time: a dead extra rendition is
    // dropped from the ladder and the viewers on it fall to the primary,
    // which is what a master playlist is for. Only the primary dying is a
    // dead stream, because it is the one every viewer can always reach.
    for (const entry of [...room.rungs.slice(1)]) {
      const { health, detail, stillRunning } = await rungHealth(
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
      // BEFORE forgetting it, not after. A rung dropped from `room.rungs` is
      // unreachable from `stopRoom`, so anything not stopped here is an
      // orphan for the life of the media box.
      if (stillRunning) {
        await stopRungs(channelId, [entry]);
      }
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
    // The camera, on exactly the terms a secondary rung gets: if it dies the
    // film does not, and it is stopped before it is forgotten so a stalled but
    // still-running transcode cannot become an orphan (the 2026-09-09 lesson,
    // above). Checked before the primary so a room the primary is about to
    // tear down does not pay for a probe.
    const camera = room.camera;
    if (camera) {
      const cameraHealth = await rungHealth(
        egress,
        channelId,
        startedAt,
        camera,
        now,
      );
      if (cameraHealth.health === "ended" && rooms.get(channelId) === room) {
        room.camera = null;
        if (cameraHealth.stillRunning) {
          await stopRungs(channelId, [camera]);
        }
        await recordSessionEnded(channelId, startedAt, CAMERA_RUNG_NAME);
        room.stream = withoutCameraUrl(room.stream);
        logEvent("voice.hlsCameraDied", {
          channelId,
          egressId: camera.egressId,
          error: cameraHealth.detail ?? null,
        });
        // The viewers are holding a `cameraHlsUrl` that will now 404. Tell
        // them so the PiP disappears instead of spinning.
        notifyChanged(channelId, "camera-ended");
      }
    }
    if (rooms.get(channelId) !== room) {
      continue;
    }
    const { health, detail, stillRunning } = await rungHealth(
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
    // EVERY RUNG, INCLUDING THE PRIMARY. This used to be `slice(1)`, on the
    // reasoning that a primary judged "ended" has already ended. That is true
    // of the LiveKit-said-so half and false of the other half: a primary whose
    // playlist stalled while its handler is still running was deleted from
    // `rooms` and never stopped, and `scheduleRestart` immediately below then
    // started a whole fresh ladder beside the one still transcoding. Two
    // restarts inside the window make three ladders on a four core box that
    // also carries the SFU and the TURN relay. `stillRunning` is what tells
    // the two halves apart, so a clean end still costs no pointless RPC.
    await stopRungs(
      channelId,
      // The camera unconditionally: unlike the primary there is no "LiveKit
      // already said it ended" about it, and a camera transcode left running
      // in a room this process has just forgotten is an orphan nothing owns.
      [
        ...(stillRunning ? room.rungs : room.rungs.slice(1)),
        ...(room.camera ? [room.camera] : []),
      ],
    );
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
        roomName: info.roomName,
      }));
    },
  };
}

/**
 * Every egress the media server is running right now, across all rooms. Null
 * means "could not ask", which callers must not confuse with "none": the
 * retention sweep in particular has to refuse to delete when it cannot tell.
 */
export async function listActiveEgresses(): Promise<EgressListing[] | null> {
  const egress = getEgress();
  if (!egress) {
    // NO LIVEKIT HERE. This used to answer `[]` — "there is genuinely nothing
    // running" — which is true of the process that would have started an
    // egress and false of any OTHER process asking about one. The retention
    // sweep's whole safety rule is "ask the media server, do not trust the
    // row", and `[]` turns that into a rubber stamp: a session whose egress is
    // still writing segments reads as finished and its objects get deleted
    // underneath a live watch party.
    //
    // That is reachable on the split deployment. `pqp-worker` is where the
    // sweep runs and it holds neither `LIVEKIT_*` nor `LIVE_HLS_S3_*`; the
    // moment somebody fixes half of that by giving it the bucket, this
    // function starts saying "nothing is running" about a box that is running
    // everything. `null` means "could not ask", every caller already treats
    // that as "leave it alone", and the log line names the reason.
    logEvent("voice.hlsListEgressUnavailable", { reason: "no-livekit" });
    return null;
  }
  if (!egress.listEgress) {
    return null;
  }
  try {
    const listing = await egress.listEgress({ active: true });
    return listing.filter(
      (info) => healthFromListing(info.egressId, listing) === "alive",
    );
  } catch (error) {
    logEvent("voice.hlsListEgressFailed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Stop one egress by id, for an orphan nobody owns. */
export async function stopEgressById(
  egressId: string,
  channelId?: string,
  now = Date.now(),
): Promise<boolean> {
  const egress = getEgress();
  if (!egress) {
    return false;
  }
  if (orphanStopHeld(egressId, now)) {
    return false;
  }
  try {
    await egress.stopEgress(egressId);
    orphanStopBackoff.delete(egressId);
    return true;
  } catch (error) {
    const { failures, waitMs } = rememberOrphanStopFailure(egressId, now);
    logEvent("voice.hlsStopFailed", {
      channelId: channelId ?? null,
      egressId,
      error: error instanceof Error ? error.message : String(error),
      failures,
      backoffMs: waitMs,
    });
    return false;
  }
}

/**
 * Take ownership of an egress that outlived the process which started it.
 *
 * WHY ADOPT RATHER THAN STOP. An API restart does not stop the media box: the
 * transcode keeps running and keeps writing segments. The first version of the
 * boot reconcile ended the row and stopped the egress, which killed a live
 * watch party on every deploy, and if the stop did not land it left an orphan
 * burning about a core of a four-core box that is also carrying voice. Adopting
 * is both kinder and safer: the party does not notice the deploy, which is the
 * same promise the voice resume machinery already makes.
 *
 * The room entry is rebuilt from the session row, which is why
 * `presenter_peer_id` and `video_track_id` are stored: `reconcileLiveHls`
 * compares both, and a presenter's client keeps its peer id across a restart,
 * so a resumed presenter matches and the egress is left alone.
 */
export function adoptLiveHlsSession(input: {
  channelId: string;
  egressId: string;
  startedAt: number;
  presenterPeerId: string;
  videoTrackId: string;
  /** Which rendition this egress is. Null is a pre-ladder single-rung row. */
  rung: string | null;
}): LiveHlsStream | null {
  // THE CAMERA IS NOT A RUNG, and adopting it as one is the failure this
  // branch exists to stop: `LADDER_RUNGS[input.rung]` answers undefined for
  // `cam360p30` and the fallback below would turn a 400 kbit/s webcam into a
  // 720p30 ladder rung, on the master playlist, for the whole party.
  //
  // `reconcileStaleHlsSessions` adopts camera egresses LAST (it sorts them
  // there, and says why), so by the time one arrives its session's room
  // exists. A camera whose session did not come back is unadoptable and is
  // said so: the caller stops it rather than leaving a transcode nothing owns.
  if (input.rung === CAMERA_RUNG_NAME) {
    return adoptCameraEgress(input);
  }
  const rung =
    (input.rung ? LADDER_RUNGS[input.rung] : undefined) ?? LADDER_RUNGS["720p30"]!;
  const entry: RunningRung = {
    rung,
    egressId: input.egressId,
    // Counts as freshly started for the health monitor's grace period: the
    // playlist's progress has not been sampled by THIS process yet.
    startedAtMs: Date.now(),
    progress: null,
  };
  // ADOPTION IS PER EGRESS AND A LADDER HAS SEVERAL. The boot reconcile walks
  // what the media server is running, one egress at a time, so the rungs of
  // one session arrive here separately and in no particular order. Replacing
  // the room each time would leave it holding whichever rung happened to come
  // last, and the master playlist would then be built from rows the room does
  // not know it owns.
  const existing = rooms.get(input.channelId);
  const rungs =
    existing && existing.stream.startedAt === input.startedAt
      ? [...existing.rungs.filter((r) => r.egressId !== input.egressId), entry]
      : [entry];
  rungs.sort((a, b) => a.rung.videoKbps - b.rung.videoKbps);
  const stream: LiveHlsStream = {
    hlsUrl: viewerPlaylistUrl(input.channelId, input.startedAt),
    startedAt: input.startedAt,
    presenterPeerId: input.presenterPeerId,
    delaySeconds: delaySeconds(),
    topHeight: Math.max(...rungs.map((r) => r.rung.height)),
    topFramerate: Math.max(...rungs.map((r) => r.rung.framerate)),
  };
  rooms.set(input.channelId, {
    rungs,
    stream: existing?.camera ? withCameraUrl(stream, input.channelId) : stream,
    videoTrackId: input.videoTrackId,
    // A camera adopted before its ladder (it should not be, but the ordering
    // is the caller's and this must not throw it away) keeps its slot.
    camera:
      existing && existing.stream.startedAt === input.startedAt
        ? existing.camera
        : null,
    startedAtMs: Date.now(),
  });
  logEvent("voice.hlsSessionAdopted", {
    channelId: input.channelId,
    egressId: input.egressId,
    startedAt: input.startedAt,
    presenterPeerId: input.presenterPeerId,
    rung: rung.name,
    rungs: rungs.map((r) => r.rung.name),
  });
  return rooms.get(input.channelId)!.stream;
}

/**
 * Take a camera transcode back after a restart, onto the session it belongs
 * to.
 *
 * Null when there is no such session in this process: the party it was
 * filming did not come back, and a camera egress with no room is a core of the
 * media box spent on a webcam nobody can reach. The caller stops it.
 */
function adoptCameraEgress(input: {
  channelId: string;
  egressId: string;
  startedAt: number;
  videoTrackId: string;
}): LiveHlsStream | null {
  const room = rooms.get(input.channelId);
  if (!room || room.stream.startedAt !== input.startedAt) {
    logEvent("voice.hlsCameraNotAdoptable", {
      channelId: input.channelId,
      egressId: input.egressId,
      startedAt: input.startedAt,
      sessionStartedAt: room?.stream.startedAt ?? null,
    });
    return null;
  }
  room.camera = {
    rung: CAMERA_RUNG,
    egressId: input.egressId,
    startedAtMs: Date.now(),
    progress: null,
    cameraTrackId: input.videoTrackId,
  };
  room.stream = withCameraUrl(room.stream, input.channelId);
  logEvent("voice.hlsCameraAdopted", {
    channelId: input.channelId,
    egressId: input.egressId,
    startedAt: input.startedAt,
  });
  return room.stream;
}

function isTrackSource(source: unknown, wanted: TrackSource): boolean {
  return source === wanted || source === TrackSource[wanted];
}

/** The two fields of a LiveKit `TrackInfo` this picker reads. */
export interface EgressCandidateTrack {
  source?: unknown;
  sid?: string;
  width?: number;
  height?: number;
}

export interface EgressCandidateParticipant {
  identity?: string;
  tracks?: readonly EgressCandidateTrack[];
}

/**
 * WHICH TWO TRACKS THE TRANSCODE IS BOUND TO. Exported because this is the
 * whole of what the HLS audience receives, and until it was pulled out of
 * `defaultFindTracks` no test could reach it: every case in
 * `hls-egress.test.ts` injects `findTracks`, so the real selection ran only in
 * production.
 *
 * A Track Composite egress takes ONE video sid and ONE audio sid
 * (`TrackCompositeEgressRequest` has singular fields, not repeated ones), so
 * this is a choice and not a mix. It picks the screen share and that same
 * share's own audio. **No microphone and no camera reaches the HLS audience**,
 * whatever the seated room can hear; `docs/WATCH_PARTY.md`, "What the stream
 * carries", is the product statement of that and
 * `docs/plans/WATCH_PARTY_STREAM_AUDIO.md` is what it would cost to change.
 *
 * PER PARTICIPANT, which the first version was not. It scanned every
 * participant's tracks into two variables, so with two people sharing at once
 * (two holders of START_WATCH_PARTY, which a party with co-hosts has) the
 * video could come from one and the audio from the other, in whatever order
 * `listParticipants` happened to answer. Now one participant supplies both or
 * the audio is dropped.
 *
 * `presenterIdentity` is the peer id `reconcileLiveHls` already decided to
 * follow, and LiveKit identities are peer ids, so it is the right sharer by
 * construction rather than the first one found. A presenter who is not in the
 * answer yet (the listing races the publish) falls back to any sharer, which
 * is the old behaviour and never worse than it.
 */
export function pickScreenTracks(
  participants: readonly EgressCandidateParticipant[],
  presenterIdentity?: string,
): LiveHlsScreenTracks | null {
  const sharers = participants.filter((participant) =>
    (participant.tracks ?? []).some(
      (track) => isTrackSource(track.source, TrackSource.SCREEN_SHARE) && track.sid,
    ),
  );
  const sharer =
    sharers.find((participant) => participant.identity === presenterIdentity) ??
    sharers[0];
  if (!sharer) {
    return null;
  }
  let videoTrackId: string | undefined;
  let audioTrackId: string | undefined;
  let sourceHeight: number | undefined;
  let cameraTrackId: string | undefined;
  for (const track of sharer.tracks ?? []) {
    if (!track.sid) {
      continue;
    }
    if (isTrackSource(track.source, TrackSource.SCREEN_SHARE)) {
      videoTrackId ??= track.sid;
      if (typeof track.height === "number" && track.height > 0) {
        sourceHeight ??= track.height;
      }
    }
    if (isTrackSource(track.source, TrackSource.SCREEN_SHARE_AUDIO)) {
      audioTrackId ??= track.sid;
    }
    // THE SAME PARTICIPANT'S CAMERA, in the same pass. A second
    // `listParticipants` on the reconcile path would double an RPC that runs
    // on every roster event to learn something this answer already carried.
    // The sharer's, never anybody else's: a second person's webcam is a second
    // transcode, which is the capacity conversation this feature defers.
    if (isTrackSource(track.source, TrackSource.CAMERA)) {
      cameraTrackId ??= track.sid;
    }
  }
  return videoTrackId
    ? {
        videoTrackId,
        audioTrackId,
        ...(sourceHeight ? { sourceHeight } : {}),
        ...(cameraTrackId ? { cameraTrackId } : {}),
      }
    : null;
}

async function defaultFindTracks(
  roomName: string,
  logInventory: boolean,
  presenterIdentity?: string,
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
  const picked = pickScreenTracks(participants, presenterIdentity);
  if (!picked && logInventory) {
    logEvent("voice.hlsTrackInventory", {
      room: roomName,
      participants: participants.length,
      tracks: participants.flatMap((participant) =>
        participant.tracks.map((track) => ({
          source: track.source,
          sid: track.sid,
        })),
      ),
    });
  }
  return picked;
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
  presenterIdentity?: string,
): Promise<LiveHlsScreenTracks | null> {
  if (injectedFinder) {
    return injectedFinder(roomName);
  }
  for (let attempt = 0; attempt < TRACK_FIND_ATTEMPTS; attempt += 1) {
    try {
      const last = attempt + 1 === TRACK_FIND_ATTEMPTS;
      const tracks = await defaultFindTracks(roomName, last, presenterIdentity);
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
  presenterIdentity?: string,
): Promise<LiveHlsScreenTracks | null> {
  try {
    if (injectedFinder) {
      return await injectedFinder(roomName);
    }
    return await defaultFindTracks(roomName, false, presenterIdentity);
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
 * Can this process reach the live-HLS bucket, with credentials it is allowed
 * to use? For `/ready`.
 *
 * WHY IT IS NOT COVERED BY THE EXISTING `storage` CHECK. That one probes the
 * ATTACHMENT bucket (`S3_*`). Live HLS deliberately uses a second, separate
 * set (`LIVE_HLS_S3_*`) with its own bucket and its own key pair, so
 * `storage: ok` says nothing whatsoever about whether a watch party can
 * write a segment. Production had `LIVE_HLS_S3_*` deployed and `/ready`
 * green for a week without either fact implying the other.
 *
 * A 404 is a PASS: the key cannot exist, and answering "not found" with a
 * valid signature is exactly the proof wanted — the endpoint resolves, the
 * bucket is there, and the credentials are accepted. Only a transport
 * failure or a non-404 error status is a failure. Same trick as the
 * attachment probe and the status page.
 */
const LIVE_HLS_PROBE_KEY = "__ready_probe__/does-not-exist";

export async function probeLiveHlsStorage(): Promise<void> {
  const config = liveHlsStorageConfig();
  if (!config) {
    throw new Error("live HLS storage is not configured");
  }
  const url = signRequest({
    method: "HEAD",
    key: LIVE_HLS_PROBE_KEY,
    ttlSeconds: 60,
    forRead: false,
    config,
  }).url;
  const response = await fetch(url, {
    method: "HEAD",
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 404 || response.ok) {
    return;
  }
  // 403 here is the one worth having: the bucket answers and the key pair is
  // wrong or has lost its grant, which is invisible until a party starts.
  throw new Error(`live HLS storage answered HTTP ${response.status}`);
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

/**
 * The camera's playlist, as a viewer is handed it.
 *
 * ALWAYS THE RUNG PATH, never a session path, and never a raw bucket URL.
 * `viewerPlaylistUrl` has an unsigned branch for `LIVE_HLS_SIGNED_URLS=false`;
 * this one does not need it, because the rendition path is exactly what the
 * proxy serves and the same `?t=` token authorises both. A deployment running
 * unsigned simply gets no camera URL, which is a missing PiP rather than a
 * broken one.
 */
function cameraPlaylistUrl(channelId: string, startedAt: number): string | null {
  if (!hlsSignedUrlsEnabled()) {
    return null;
  }
  return `/api/voice/hls-playlist/${channelId}/${startedAt}/${CAMERA_RUNG_NAME}`;
}

/** The same stream, now advertising a camera. */
function withCameraUrl(stream: LiveHlsStream, channelId: string): LiveHlsStream {
  const url = cameraPlaylistUrl(channelId, stream.startedAt);
  if (!url) {
    return stream;
  }
  return { ...stream, cameraHlsUrl: url };
}

/** The same stream with the camera gone. Deleted, not set to undefined. */
function withoutCameraUrl(stream: LiveHlsStream): LiveHlsStream {
  if (stream.cameraHlsUrl === undefined) {
    return stream;
  }
  const { cameraHlsUrl: _dropped, ...rest } = stream;
  return rest;
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

/**
 * `reason` IS NOT OPTIONAL, and that is the whole point of it.
 *
 * A live party on 2026-09-09 produced two `voice.hlsStarted` nine minutes
 * apart for one channel, same presenter, with **not one line between them**,
 * because three of this function's five callers logged nothing and the fourth
 * logged only in a branch the third one pre-empted. An operator reading that
 * log cannot tell a host re-picking their share from a transcode dying, and
 * those two want completely different responses during an event.
 *
 * The stop is now always narrated, and `voice.hlsStopped` is the one line to
 * grep for when a stream restarted and nobody knows why.
 */
async function stopRoom(channelId: string, reason: string): Promise<void> {
  const current = rooms.get(channelId);
  if (!current) {
    return;
  }
  rooms.delete(channelId);
  logEvent("voice.hlsStopped", {
    channelId,
    reason,
    presenterPeerId: current.stream.presenterPeerId,
    startedAt: current.stream.startedAt,
    egressIds: current.rungs.map((entry) => entry.egressId),
    cameraEgressId: current.camera?.egressId ?? null,
  });
  await recordSessionEnded(channelId, current.stream.startedAt);
  // The camera with the rungs, in the same call. `recordSessionEnded` with no
  // rung already ended its row; an egress whose row says ended and which is
  // still transcoding is the exact orphan shape this file keeps paying for.
  await stopRungs(channelId, [
    ...current.rungs,
    ...(current.camera ? [current.camera] : []),
  ]);
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

/**
 * The presenter's camera, reconciled against the session already running.
 *
 * FOUR CASES, AND THE SESSION IS NEVER RESTARTED FOR ANY OF THEM. A new
 * `startedAt` is a new playlist path, a new viewer token and a new master, so
 * every viewer re-attaches and rebuffers; turning a webcam on or off must
 * cost an audience nothing. So this only ever adds or removes one egress
 * beside the ladder, and the only thing a viewer sees is `cameraHlsUrl`
 * appearing or disappearing on a frame they were already being sent.
 *
 *  - no camera published, none running: nothing.
 *  - a camera published, none running: start one, if the box can carry it.
 *  - no camera published, one running: stop it.
 *  - a camera published on a DIFFERENT sid (a device switch, a republish, a
 *    reconnect): stop and start. A Track Composite egress is bound to one sid
 *    and goes on running against a dead one, writing nothing — the same
 *    failure `videoTrackId` on the room exists to catch for the share.
 *
 * `cameraTrackId` is `null` for "the presenter has no camera" and for "we
 * could not ask", and the caller is what tells those apart: it passes null
 * only when it actually looked. A probe that failed returns before reaching
 * here, so a momentary LiveKit hiccup never tears the camera down.
 */
async function reconcileCameraEgress(
  channelId: string,
  cameraTrackId: string | null,
): Promise<void> {
  const room = rooms.get(channelId);
  if (!room) {
    return;
  }
  const wanted = liveHlsCameraEnabled() ? cameraTrackId : null;
  const current = room.camera;
  if (current && current.cameraTrackId === wanted) {
    return;
  }
  if (current) {
    room.camera = null;
    room.stream = withoutCameraUrl(room.stream);
    await recordSessionEnded(channelId, room.stream.startedAt, CAMERA_RUNG_NAME);
    await stopRungs(channelId, [current]);
    logEvent("voice.hlsCameraStopped", {
      channelId,
      egressId: current.egressId,
      reason: wanted ? "track-replaced" : "no-camera",
    });
  }
  if (!wanted) {
    return;
  }
  const egress = getEgress();
  if (!egress) {
    return;
  }
  // Priced against the WHOLE box, and never against the ladder budget: see
  // `decideCameraEgress`. A refusal costs a face, never a rendition of the
  // film.
  const decision = decideCameraEgress({
    runningRungs: runningRungCount(),
    sfuLoadMbps: (await currentSfuLoadMbps()) + runningCameraMbps(),
    boxBudgetMbps: promotionBudgetMbps(),
  });
  if (!decision.start) {
    logEvent("voice.hlsCameraRefused", {
      channelId,
      refusal: decision.refusal,
      boxMbps: Math.round(decision.boxMbps),
      boxBudgetMbps: promotionBudgetMbps(),
    });
    return;
  }
  const startedAt = room.stream.startedAt;
  let egressId: string | null = null;
  try {
    const started = await egress.startTrackCompositeEgress(
      channelId,
      segmentOutput(
        hlsObjectPrefix(channelId, startedAt, CAMERA_RUNG_NAME),
        startedAt,
        CAMERA_RUNG_NAME,
      ),
      {
        videoTrackId: wanted,
        // NO AUDIO TRACK AT ALL. The audience's sound comes off the main
        // stream, which is the only place it is mixed, and a second audio
        // channel two seconds out of step with the first is worse than
        // silence. This is the same request shape a share picked without its
        // own audio already produces in production.
        encodingOptions: rungEncodingOptions(CAMERA_RUNG),
      },
    );
    egressId = started.egressId;
  } catch (error) {
    logEvent("voice.hlsCameraStartFailed", {
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  // The room may have been replaced while LiveKit was answering. Starting a
  // transcode into a session that no longer exists is an orphan, so stop it
  // rather than filing it under a room that moved on.
  const after = rooms.get(channelId);
  if (!after || after !== room || after.stream.startedAt !== startedAt) {
    await stopEgressById(egressId, channelId);
    return;
  }
  room.camera = {
    rung: CAMERA_RUNG,
    egressId,
    startedAtMs: Date.now(),
    progress: null,
    cameraTrackId: wanted,
  };
  room.stream = withCameraUrl(room.stream, channelId);
  await recordSessionStarted(
    channelId,
    startedAt,
    egressId,
    CAMERA_RUNG_NAME,
    room.stream.presenterPeerId,
    wanted,
  );
  logEvent("voice.hlsCameraStarted", {
    channelId,
    egressId,
    startedAt,
    cameraTrackId: wanted,
    boxMbps: Math.round(decision.boxMbps),
  });
}

/**
 * What the WebRTC side already costs, or 0 when nothing can tell us.
 *
 * Returns a NUMBER rather than a promise when there is no reader, so the
 * common path (and every test with no load registered) adds no await to the
 * restart chain. Awaiting a resolved promise is free at runtime and is not
 * free for a suite that drives this with fake timers.
 */
function currentSfuLoadMbps(): number | Promise<number> {
  const reader = sfuLoadReader;
  if (!reader) {
    return 0;
  }
  return readSfuLoad(reader);
}

async function readSfuLoad(reader: LiveHlsSfuLoadReader): Promise<number> {
  try {
    return await reader();
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
  sourceHeight?: number | null,
): Promise<LiveHlsStream | null> {
  const egress = getEgress();
  if (!egress || !isLiveHlsEnabled()) {
    return null;
  }
  if (isFailed(channelId)) {
    logEvent("voice.hlsStartSuppressed", { channelId, presenterPeerId });
    return null;
  }
  // The concurrency guard, and it comes BEFORE the track probe on purpose:
  // `findScreenTracks` polls LiveKit up to sixteen times over six seconds,
  // and spending that on a session that is going to be refused is the wrong
  // work to be doing on precisely the box that is already full.
  //
  // Deliberately here rather than inside `decideLadder`: that one degrades a
  // party (it refuses the rungs above the lowest and never the lowest), this
  // one refuses a session, and nothing else bounds the count.
  //
  // `rooms.size` is the count of OTHER sessions without having to subtract
  // one, because every caller that reaches here for a channel that was
  // already running stopped that room first (the three `stopRoom` calls in
  // `reconcileLiveHlsNow`, and the restart path, which stops before it
  // schedules). A restart is therefore judged on the same terms as a first
  // start: if three other parties have filled the box meanwhile, it waits.
  const maxSessions = maxLiveHlsSessions();
  if (rooms.size >= maxSessions) {
    logEvent("voice.hlsSessionsCapped", {
      channelId,
      presenterPeerId,
      sessions: rooms.size,
      maxSessions,
    });
    return null;
  }
  const tracks = knownTracks ?? (await findScreenTracks(channelId, presenterPeerId));
  if (!tracks) {
    logEvent("voice.hlsNoScreenTrack", { channelId, presenterPeerId });
    return null;
  }
  const ladder = liveHlsLadder();
  const decisions = decideLadder({
    rungs: ladder,
    runningRungs: runningRungCount(),
    // The cameras go in with the WebRTC load rather than into `runningRungs`:
    // one is 30 % of a rendition, not one of them. See `runningCameraMbps`.
    sfuLoadMbps: (await currentSfuLoadMbps()) + runningCameraMbps(),
    ladderBudgetMbps: ladderBudgetMbps(),
    boxBudgetMbps: promotionBudgetMbps(),
    // The host's getSettings() height, when announced, is the pixels. LiveKit
    // `track.height` is the declared layer and can be the frozen 1080 from a
    // 480p window. An upscale rung is a wasted x264 and a flapping ABR.
    sourceHeight: sourceHeight ?? tracks.sourceHeight ?? null,
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
    topFramerate: Math.max(...running.map((entry) => entry.rung.framerate)),
    // The one fact the host cannot check for themselves. They hear the film
    // out of their own speakers whether or not its audio was ever captured.
    hasAudio: Boolean(tracks.audioTrackId),
  };
  const room: RoomHls = {
    rungs: running,
    stream,
    videoTrackId: tracks.videoTrackId,
    // Started below, after the readiness probe: a camera must never be the
    // reason the film is late, and a session that fails its probe is torn down
    // anyway.
    camera: null,
    startedAtMs: startedAt,
  };
  rooms.set(channelId, room);
  // The rows AFTER the room is published, not before. They are what the
  // playlist proxy checks and what retention sweeps, so they have to exist
  // before the URL goes out (which is below, past the readiness probe), but
  // nothing in memory may wait on Postgres to become true: putting a real
  // round trip in front of `rooms.set` is what made the health-monitor tests
  // flake on the CI runner and would delay a restart in production for
  // exactly as long as the database felt like taking.
  await Promise.all(
    running.map((entry) =>
      recordSessionStarted(
        channelId,
        startedAt,
        entry.egressId,
        entry.rung.name,
        presenterPeerId,
        tracks.videoTrackId,
      ),
    ),
  );
  await endSupersededSessions(
    channelId,
    startedAt,
    new Set(running.map((entry) => entry.egressId)),
  );
  // The readiness probe reads the bucket itself (presigned, endpoint form),
  // never the viewer-facing URL: a viewer gets the signed master path, which
  // this same process cannot usefully fetch from here. It waits on the
  // PRIMARY rung, because that is the one a viewer is guaranteed to land on.
  const waitStartedAt = Date.now();
  const ready = await waitForLivePlaylist(
    internalPlaylistUrl(channelId, startedAt, primary.rung.name),
  );
  logEvent("voice.hlsStarted", {
    channelId,
    presenterPeerId,
    playlistReady: ready,
    // How long the first live playlist actually took. The only way to know
    // whether `PLAYLIST_WAIT_ATTEMPTS` is set anywhere near right, and the
    // reason the number above can be revised from data instead of argument.
    playlistWaitMs: Date.now() - waitStartedAt,
    // WHAT THE TRANSCODE IS ACTUALLY CARRYING, not what it was asked for.
    // "screen" is the share's own audio; "none" is a silent stream, which is
    // what a whole-screen or window capture always produces and what a tab
    // share produces when the host leaves the audio box unticked. `grep`ping
    // for `"audio":"none"` is how an operator answers "could they hear it?"
    // after the fact, and `liveHls.silentSessions` on /api/admin/metrics is
    // how they answer it during.
    audio: tracks.audioTrackId ? "screen" : "none",
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
      await stopRoom(channelId, "playlist-not-ready");
      scheduleRestart(channelId, "playlist-not-ready");
    }
    return null;
  }
  // AFTER the film is proven, and additively. The returned stream is read back
  // off the room rather than the local `stream`, because this is what stamps
  // `cameraHlsUrl` onto it.
  await reconcileCameraEgress(channelId, tracks.cameraTrackId ?? null);
  return rooms.get(channelId)?.stream ?? stream;
}

/**
 * First sharer in the room wins. A later share does not steal the transcode.
 * `presenterPeerId: null` means nobody is sharing: stop if we were. The
 * same presenter re-declaring is a no-op unless their screen track is a new
 * sid, in which case the egress is bound to a dead track and is restarted
 * (new playlist URL, so the caller broadcasts it and viewers reload).
 * `serverId` is the channel's server: a server whose `live_hls_enabled` row
 * (or, with no row, `LIVE_HLS_SERVER_ALLOWLIST`) says no never starts an
 * egress, and one already running for it is stopped. Read here, per share,
 * so turning a server off from the dashboard ends its stream at the next
 * reconcile rather than at the next deploy.
 */
export function reconcileLiveHls(
  channelId: string,
  presenterPeerId: string | null,
  serverId: string | null,
  sourceHeight?: number | null,
): Promise<LiveHlsStream | null> {
  const previous = reconcileQueue.get(channelId) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(() =>
      reconcileLiveHlsNow(channelId, presenterPeerId, serverId, sourceHeight),
    );
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
  sourceHeight?: number | null,
): Promise<LiveHlsStream | null> {
  if (!(await isLiveHlsEnabledForServer(serverId))) {
    // "not allowlisted" and "nobody is sharing" used to arrive here as the
    // same thing, because `pushLiveHls` resolved the server id only when it
    // had a sharer and passed null otherwise. So an ordinary end of share was
    // torn down by this branch, which logs nothing, instead of the branch
    // below, which does. The caller resolves the id either way now; this one
    // is the genuine allowlist case again and says so.
    if (rooms.has(channelId)) {
      await stopRoom(channelId, "not-allowlisted");
    }
    return null;
  }
  const current = rooms.get(channelId);
  if (!presenterPeerId) {
    // A share that stopped resets the restart budget: the next one starts
    // clean rather than inheriting the last one's failures.
    clearFailure(channelId);
    if (current) {
      await stopRoom(channelId, "no-share");
    }
    return null;
  }
  if (current && current.stream.presenterPeerId === presenterPeerId) {
    const tracks = await probeScreenTracks(channelId, presenterPeerId);
    if (!tracks) {
      // COULD NOT ASK, which is not "no camera". A momentary LiveKit hiccup
      // must not tear a running camera transcode down and start another one
      // on the next push.
      return current.stream;
    }
    if (tracks.videoTrackId === current.videoTrackId) {
      // The film has not moved; the camera may have. This is the ordinary
      // path: it runs on every roster event and on the `set-camera` frame,
      // and it is where a webcam being switched on actually starts its
      // transcode. It reuses the `listParticipants` call above, so it costs
      // no extra RPC.
      await reconcileCameraEgress(channelId, tracks.cameraTrackId ?? null);
      return current.stream;
    }
    logEvent("voice.hlsTrackReplaced", {
      channelId,
      egressIds: current.rungs.map((entry) => entry.egressId),
      from: current.videoTrackId,
      to: tracks.videoTrackId,
    });
    await stopRoom(channelId, "screen-track-replaced");
    return startRoom(channelId, presenterPeerId, tracks, sourceHeight);
  }
  if (current) {
    // A NEW PEER ID IS NOT NECESSARILY A NEW PRESENTER. A reconnect that
    // reconstructs or cold-joins gets a fresh peer id, and LiveKit identities
    // are peer ids, so the room reports a different presenter for what is
    // plainly the same person. If the SFU still holds the very screen track
    // this session was started on, the media never moved and there is nothing
    // to restart: adopt the new id onto the running session instead of
    // rebuffering every viewer to say the same picture again.
    //
    // Sids are unique per publication, so this cannot confuse two people: a
    // genuine second presenter has a track this session was never bound to.
    const tracks = await probeScreenTracks(channelId, presenterPeerId);
    if (tracks && tracks.videoTrackId === current.videoTrackId) {
      const from = current.stream.presenterPeerId;
      current.stream = { ...current.stream, presenterPeerId };
      logEvent("voice.hlsPresenterReattached", {
        channelId,
        from,
        to: presenterPeerId,
        videoTrackId: current.videoTrackId,
      });
      // The reconnect republished their camera on a fresh sid, so the running
      // camera egress is bound to a dead track. Same reasoning as the share's
      // `videoTrackId` comparison directly above.
      await reconcileCameraEgress(channelId, tracks.cameraTrackId ?? null);
      return current.stream;
    }
    await stopRoom(channelId, "presenter-changed");
  }
  return startRoom(channelId, presenterPeerId, undefined, sourceHeight);
}

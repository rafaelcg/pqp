import {
  DirectFileOutput,
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

/**
 * THE HOST'S VOICE AS ITS OWN FILE.
 *
 * `mic-archive` is the LiveKit track NAME the presenter's browser publishes a
 * second copy of its processed microphone under, when the server advertises
 * `micArchive` on `GET /api/live-hls/config`. Nothing plays it: every client
 * unsubscribes from a publication with this name on sight, and the HLS
 * audience keeps hearing the mix exactly as before. It exists so a Track
 * Egress can write the voice to its own Opus file beside the segments, and a
 * clip can be cut later with the film and the voice on separate tracks.
 *
 * THE NAME IS THE CONTRACT, and pitfall 14 is why it is a name and not a
 * source. `liveKitPublishGrant` sends `canPublishSources: ["microphone"]` to
 * anybody holding SPEAK and not STREAM, and LiveKit treats a non-empty list as
 * an allowlist that `SOURCE_UNKNOWN` is not in: a track published under an
 * invented source would be refused by the media server while the host's own
 * app showed it live. So this publication is a MICROPHONE like any other and
 * is told apart by `TrackInfo.name`, which no grant reads.
 */
export const MIC_ARCHIVE_TRACK_NAME = "mic-archive";

/**
 * How long after a session starts the monitor keeps looking for the archive
 * track. The browser publishes it AFTER the share is up and the mix is
 * running, so it is normally absent on the first look and present a second or
 * two later; a host whose browser never publishes one (an old bundle, the mic
 * switch off, no WebAudio) must not cost a `listParticipants` every ten
 * seconds for the length of a film.
 */
const MIC_ARCHIVE_WAIT_MS = 60_000;

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
 * Real incident, 2026-09-12: nine ACTIVE egress records sat in LiveKit's own
 * state (Redis on the media box) with nothing writing to them, and a 720p
 * rung was refused twice with `box-budget` while the box was otherwise idle.
 * The fix pinned here is the `hls_sessions` row, not the record's age: age
 * alone is not proof of anything (a real watch party's egress runs for
 * hours), but a record whose channel has no live session row is one LiveKit
 * is holding for a room nobody is presenting to. See `noLiveSession` in
 * `activeBoxEgressCount`.
 *
 * How long a fresh record is exempt from that check regardless: the
 * `startTrackCompositeEgress` call and the `hls_sessions` insert that backs
 * it are two round trips, not one, so a record can legitimately have no
 * matching row for a moment right after it starts. Two minutes is generous
 * for that gap to close.
 */
const GHOST_EGRESS_GRACE_PERIOD_MS = 2 * 60_000;

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
  /**
   * Wall-clock ms this egress started, when LiveKit stated it. Undefined for
   * an older fake in a test that has no reason to care — every caller that
   * uses it (the ghost filter below) already treats "unknown" as "cannot be
   * aged out", never as "definitely fresh".
   */
  startedAt?: number;
}

export interface LiveHlsScreenTracks {
  videoTrackId: string;
  audioTrackId?: string;
  /** Published capture height, when LiveKit stated it. */
  sourceHeight?: number;
  /**
   * The sharer's separate `mic-archive` audio publication, when they have one.
   * NOT part of the transcode: the Track Composite takes one audio sid and
   * that is still the share's own audio (which already carries the mixed
   * voice). This one is written to its own file. See `MIC_ARCHIVE_TRACK_NAME`.
   */
  micArchiveTrackId?: string;
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
  /**
   * `TrackEgress`: one track, no transcode, straight to a file. Optional so
   * every existing fake still compiles; without it the mic archive simply
   * never starts, which is the pre-feature behaviour rather than a crash.
   */
  startTrackEgress?: (
    roomName: string,
    output: DirectFileOutput,
    trackId: string,
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
  /** Wall clock when the session was requested. */
  startedAtMs: number;
  /**
   * The host's voice, recorded to its own file beside the segments. Null
   * until the presenter's `mic-archive` publication shows up (or forever,
   * when the feature is off or their browser never publishes one).
   */
  micArchive: { egressId: string; trackId: string } | null;
  /**
   * Stop looking for that publication after this instant. Zero means never
   * look, which is what an ADOPTED session gets: its archive either came back
   * with it or is gone, and starting a second one mid-film would write a
   * second file nobody asked for.
   */
  micArchiveUntil: number;
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
/**
 * Egress ids the box-budget count has already logged as a ghost, so a
 * record that lives on for hours (exactly what makes it a ghost) does not
 * re-log every monitor tick. Cleared only by `resetLiveHlsForTests`; nothing
 * in production ever needs to forget one, since a stopped id simply stops
 * appearing in `listEgress({active:true})`.
 */
const loggedGhostEgressIds = new Set<string>();
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

const DEFAULT_SEGMENT_SECONDS = 2;
const MAX_SEGMENT_SECONDS = 10;

/**
 * Segment length the egress is asked for, `LIVE_HLS_SEGMENT_SECONDS`.
 *
 * WHY THIS IS A KNOB. The egress uploads segments in parallel, but after
 * each one its playlist goroutine uploads the index playlist and the live
 * playlist one after the other, synchronously, before the segment is listed
 * (`pkg/pipeline/sink/segments.go` in egress 1.14.1, every segment in the
 * first hour). Each of those PUTs is a cross-region write to the bucket:
 * measured 2026-09-12 from the São Paulo box to the WEUR bucket, a 1 KB PUT
 * took 0.6 to 1.0 s (0.25 s from London). At 2 s segments that is two
 * seconds of serialised playlist uploads per two seconds of media, and on a
 * slow afternoon the live party's playlist advanced 19 to 25 segments a
 * minute instead of 30: every viewer, web and native, caught the edge and
 * starved every 10 to 15 s while the encoder sat at a third of a core.
 * Four-second segments halve the playlist PUTs per second of media for the
 * same bytes; viewers sit about twice as far behind (the client counts
 * segments, not seconds). Takes effect on the NEXT session: a running egress
 * keeps the length it started with.
 */
export function hlsSegmentSeconds(): number {
  const raw = positiveIntFromEnv("LIVE_HLS_SEGMENT_SECONDS", DEFAULT_SEGMENT_SECONDS);
  return Math.min(raw, MAX_SEGMENT_SECONDS);
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
 * `LIVE_HLS_MIC_ARCHIVE`: **off by default**, and off is a deployment that
 * behaves exactly as it did before this existed.
 *
 * On, two things change and neither touches the stream. The config endpoint
 * tells the presenter's browser to publish a second copy of its processed
 * microphone under the name `mic-archive`, and this process starts a LiveKit
 * **Track Egress** on it: no transcode, one Opus track straight to
 * `live/<channelId>/<startedAt>-mic.ogg` in the same bucket as the segments,
 * on the same retention row machinery as every rung. The HLS audience still
 * hears the mix; what this buys is a clip cut later with the film and the
 * voice on separate tracks.
 *
 * Read per call like every other switch in this file, so it can be turned on
 * or off without a deploy. Turning it off mid-party stops the archive at the
 * next monitor tick and leaves the party alone.
 */
export function micArchiveEnabled(): boolean {
  return process.env.LIVE_HLS_MIC_ARCHIVE === "true";
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
  /**
   * Whether the presenter should publish the extra `mic-archive` track.
   *
   * The client must never decide this from a build flag: the recording is
   * this deployment's, the bucket is this deployment's, and a browser that
   * published the track against a server which is not recording it would put
   * a second microphone into every room for nothing. False whenever HLS is
   * off for this answer, because an archive with no session to hang off is
   * not a thing that can start.
   */
  micArchive: boolean;
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
    micArchive: isLiveHlsEnabled() && micArchiveEnabled(),
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
  const enabled = resolveLiveHlsForServer(serverId, override);
  return {
    ...base,
    enabled,
    allowlisted: base.allowlisted || override !== null,
    // Follows THIS server's answer, not the deployment's: a server the
    // operator has switched off records nothing, so its host must not be
    // asked to publish a track for it.
    micArchive: enabled && micArchiveEnabled(),
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
  loggedGhostEgressIds.clear();
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
 * Which of `roomNames` has a session `hls_sessions` still calls live
 * (`ended_at IS NULL`). Scoped to the rooms the current `listEgress` call
 * actually returned rather than the whole table's distinct channels: the box
 * budget only ever judges records LiveKit just listed, so there is nothing to
 * gain from asking about every channel that has ever run an egress. Null
 * means "could not ask" — the same convention as `listActiveEgresses` — and
 * every caller must read that as "do not judge a record by this", never as
 * "no channel is live". Empty input is a no-op: no round trip, no rows.
 */
async function listChannelsWithLiveHlsSessions(
  roomNames: readonly string[],
): Promise<Set<string> | null> {
  if (roomNames.length === 0) {
    return new Set();
  }
  try {
    const result = await getPool().query<{ channel_id: string }>(
      `SELECT DISTINCT channel_id FROM hls_sessions
        WHERE ended_at IS NULL AND channel_id = ANY($1::uuid[])`,
      [roomNames],
    );
    return new Set(result.rows.map((row) => row.channel_id));
  } catch (error) {
    logEvent("voice.hlsLiveSessionsQueryFailed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Renditions running on the WHOLE box right now, for the box-budget check —
 * across every process, not just this one's `rooms` map. `decideLadder`
 * used to be handed `runningRungCount()`, which is exactly right for a box
 * that has never restarted and exactly wrong the moment `listEgress` still
 * remembers something this process does not: an adopted session mid-boot, or
 * — the case that actually cost a rung — a ghost record LiveKit never
 * cleaned up.
 *
 * A record counts only when it is BOTH: `alive` per `healthFromListing`, AND
 * not a ghost. A record is a ghost only when its room has no live
 * `hls_sessions` row AND it is past `GHOST_EGRESS_GRACE_PERIOD_MS` — age
 * alone proves nothing (a real watch party runs for hours) and a brand-new
 * record proves nothing either (the session row is a second round trip that
 * has not always landed yet), so both have to hold. Every ghost id is logged
 * exactly once via `loggedGhostEgressIds`, pruned each call to whatever
 * `listing` still contains, because a real ghost sits there for hours and
 * this must not become the noisiest line in the log nor an unbounded set.
 *
 * Falls back to `runningRungCount()` — this process's own honest count —
 * when there is no egress, no `listEgress` support (an older fake in a
 * test), or the listing call itself failed, AND takes it as a floor even on
 * the success path: "could not ask" and "asked, got nothing back" must
 * never read as "the box is empty" and refuse nothing, but the count must
 * also never read as infinite and refuse everything, so the floor is what
 * this process knows for certain it is running right now.
 */
export async function activeBoxEgressCount(now = Date.now()): Promise<number> {
  const localFloor = runningRungCount();
  const egress = getEgress();
  if (!egress?.listEgress) {
    return localFloor;
  }
  let listing: EgressListing[];
  try {
    listing = await egress.listEgress({ active: true });
  } catch (error) {
    logEvent("voice.hlsBoxBudgetListFailed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return localFloor;
  }
  const roomNames = [
    ...new Set(
      listing
        .map((info) => info.roomName)
        .filter((room): room is string => room !== undefined),
    ),
  ];
  const liveChannels = await listChannelsWithLiveHlsSessions(roomNames);
  let count = 0;
  const currentIds = new Set(listing.map((info) => info.egressId));
  for (const id of loggedGhostEgressIds) {
    if (!currentIds.has(id)) {
      loggedGhostEgressIds.delete(id);
    }
  }
  for (const info of listing) {
    if (healthFromListing(info.egressId, listing) !== "alive") {
      continue;
    }
    const ageMs = info.startedAt !== undefined ? now - info.startedAt : null;
    const withinGracePeriod =
      ageMs === null || ageMs < GHOST_EGRESS_GRACE_PERIOD_MS;
    const noLiveSession =
      liveChannels !== null &&
      info.roomName !== undefined &&
      !liveChannels.has(info.roomName);
    const isGhost = noLiveSession && !withinGracePeriod;
    if (isGhost) {
      if (!loggedGhostEgressIds.has(info.egressId)) {
        loggedGhostEgressIds.add(info.egressId);
        logEvent("voice.hlsGhostEgress", {
          egressId: info.egressId,
          roomName: info.roomName ?? null,
          ageMs,
          reason: "no-live-session",
        });
      }
      continue;
    }
    count += 1;
  }
  return Math.max(count, localFloor);
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
   * Live sessions with the host's voice being written to its own file right
   * now (`LIVE_HLS_MIC_ARCHIVE`). Zero on a deployment where the flag is off,
   * which is every deployment until somebody sets it; zero with the flag ON
   * is the number that says the browsers have not picked up the bundle that
   * publishes the track, or that the Track Egress request is failing.
   */
  micArchives: number;
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
  let micArchives = 0;
  for (const room of rooms.values()) {
    rungs += room.rungs.length;
    oldest = oldest === null ? room.startedAtMs : Math.min(oldest, room.startedAtMs);
    if (room.stream.hasAudio === false) {
      silentSessions += 1;
    }
    if (room.micArchive) {
      micArchives += 1;
    }
  }
  return {
    sessions: rooms.size,
    maxSessions: maxLiveHlsSessions(),
    rungs,
    oldestMinutes: oldest === null ? null : Math.floor((now - oldest) / 60_000),
    silentSessions,
    orphansStopped,
    micArchives,
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
  const ours = new Set(room.rungs.map((entry) => entry.egressId));
  // THE ARCHIVE IS ONE OF OURS. It is an ACTIVE egress on a room this process
  // is presenting and it is not a rung, which is the exact description of what
  // this function stops. Forgetting it here would kill the recording on the
  // first monitor tick and count it as a leak.
  if (room.micArchive) {
    ours.add(room.micArchive.egressId);
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
    // AFTER the reap, so a just-started archive is never the thing the reap
    // has not been told about yet, and before the health checks, which can
    // delete the room from under it.
    await tendMicArchive(egress, channelId, room, now);
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
    // The room is gone from the map, so nothing else can reach its archive:
    // stop it here or it transcodes to a file forever. Stated with its own
    // reason rather than folded into the rung teardown.
    await stopMicArchive(channelId, room, "egress-died");
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
      stillRunning ? room.rungs : room.rungs.slice(1),
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
    startTrackEgress: async (roomName, output, trackId) => {
      const info = await client.startTrackEgress(roomName, output, trackId);
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
        // `startedAt` is unix nanoseconds (protobuf int64). Dividing the
        // bigint first keeps the result inside Number's safe range — doing
        // that division after `Number()` would already have lost precision,
        // since nanoseconds-since-1970 overflows MAX_SAFE_INTEGER today.
        startedAt:
          info.startedAt > 0n ? Number(info.startedAt / 1_000_000n) : undefined,
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
}): LiveHlsStream {
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
    stream,
    videoTrackId: input.videoTrackId,
    startedAtMs: Date.now(),
    // Carried over from the entry this adoption is rebuilding, so a ladder
    // whose rungs arrive one at a time does not drop an archive the first of
    // them already attached. `adoptLiveHlsMicArchive` fills it otherwise.
    micArchive: existing?.micArchive ?? null,
    // NEVER hunt for a new one after a deploy. The archive either came back
    // with the process (the boot reconcile attaches it below) or its egress
    // is gone, and starting a second one mid-film would write a second file
    // that begins nowhere and that nobody asked for.
    micArchiveUntil: 0,
  });
  logEvent("voice.hlsSessionAdopted", {
    channelId: input.channelId,
    egressId: input.egressId,
    startedAt: input.startedAt,
    presenterPeerId: input.presenterPeerId,
    rung: rung.name,
    rungs: rungs.map((r) => r.rung.name),
  });
  return stream;
}

/**
 * Take back a mic-archive Track Egress that outlived the process which started
 * it, the same way `adoptLiveHlsSession` takes back a rendition.
 *
 * IT CANNOT GO THROUGH `adoptLiveHlsSession`, and that is the whole reason
 * this exists. That function turns a row into a RUNG: it looks the rung name
 * up in `LADDER_RUNGS`, and an unknown name falls back to `720p30`. A `mic`
 * row put through it would join the room as a fake 720p rendition, be listed
 * as a variant, be kept warm, and be handed to viewers as a playlist that is
 * really an audio file.
 *
 * Returns whether it attached. False means there is no live session for that
 * channel and startedAt to attach to, and the caller should stop the egress
 * rather than leave a handler writing into a session nobody owns.
 */
export function adoptLiveHlsMicArchive(input: {
  channelId: string;
  egressId: string;
  startedAt: number;
  trackId: string;
}): boolean {
  const room = rooms.get(input.channelId);
  if (!room || room.stream.startedAt !== input.startedAt) {
    return false;
  }
  if (room.micArchive && room.micArchive.egressId !== input.egressId) {
    // Two archives for one session is a leak, not a spare. Refuse the second
    // and let the caller stop it.
    return false;
  }
  room.micArchive = { egressId: input.egressId, trackId: input.trackId };
  room.micArchiveUntil = 0;
  logEvent("voice.hlsMicArchiveAdopted", {
    channelId: input.channelId,
    egressId: input.egressId,
    startedAt: input.startedAt,
  });
  return true;
}

function isTrackSource(source: unknown, wanted: TrackSource): boolean {
  return source === wanted || source === TrackSource[wanted];
}

/** The fields of a LiveKit `TrackInfo` this picker reads. */
export interface EgressCandidateTrack {
  source?: unknown;
  sid?: string;
  width?: number;
  height?: number;
  /** The publication's name. Only `mic-archive` means anything here. */
  name?: unknown;
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
  let micArchiveTrackId: string | undefined;
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
    // BY NAME, NOT BY SOURCE, and the source is deliberately not checked:
    // this publication is a MICROPHONE (pitfall 14 — a grant is an allowlist
    // of sources and an invented one is refused), so the source says nothing
    // that tells it from the host's ordinary mic. The name is the only thing
    // that does, and it is the same string the browser publishes under.
    if (track.name === MIC_ARCHIVE_TRACK_NAME) {
      micArchiveTrackId ??= track.sid;
    }
  }
  return videoTrackId
    ? {
        videoTrackId,
        audioTrackId,
        ...(sourceHeight ? { sourceHeight } : {}),
        ...(micArchiveTrackId ? { micArchiveTrackId } : {}),
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
          name: track.name,
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
    segmentDuration: hlsSegmentSeconds(),
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

/**
 * The rung name the archive's retention row carries.
 *
 * It is a rung in the `hls_sessions` sense (one row, one `object_prefix`, one
 * `egress_id`, swept and kept by exactly the same rules as a rendition) and it
 * is deliberately NOT a name in `LADDER_RUNGS`. That is what keeps it off the
 * master playlist and out of the keep-warm loop for free: `sessionRungs` in
 * `hls-playlist-proxy.ts` already filters the rows to rungs this build knows,
 * so a viewer never sees a variant pointing at an audio file, and nothing
 * polls it. `keep_replay` and the retention sweep, meanwhile, work on the
 * prefix and know nothing about ladders, so the archive is kept or deleted
 * with the session it belongs to and no code there changes.
 */
export const MIC_ARCHIVE_RUNG = "mic";

/**
 * Where the host's voice lands: `live/<channelId>/<startedAt>-mic.ogg`.
 *
 * **OGG because the muxer is chosen by the extension.** A Track Egress does
 * not transcode; it remuxes the published track, which for us is Opus, and
 * LiveKit writes Opus into an OGG container. Asking for `.mp4` here would
 * either fail or silently produce something no editor opens.
 *
 * The `.ogg` is INSIDE the session prefix (`...-mic` is the prefix, `.ogg` the
 * suffix), which is what makes the retention sweep's prefix listing find it.
 */
export function micArchiveObjectKey(
  channelId: string,
  startedAt: number,
): string {
  return `${hlsObjectPrefix(channelId, startedAt, MIC_ARCHIVE_RUNG)}.ogg`;
}

function micArchiveOutput(channelId: string, startedAt: number): DirectFileOutput {
  const storage = liveHlsStorage()!;
  return new DirectFileOutput({
    filepath: micArchiveObjectKey(channelId, startedAt),
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

/**
 * Start the archive for a session that has just found its `mic-archive`
 * track. Failure is never fatal: the party is the segments, and a party that
 * refused to start because a side recording could not is a worse product than
 * one that plays with no recording.
 */
async function startMicArchive(
  egress: LiveHlsEgressApi,
  channelId: string,
  room: RoomHls,
  trackId: string,
): Promise<void> {
  if (!egress.startTrackEgress || room.micArchive) {
    return;
  }
  const startedAt = room.stream.startedAt;
  let egressId: string;
  try {
    const started = await egress.startTrackEgress(
      channelId,
      micArchiveOutput(channelId, startedAt),
      trackId,
    );
    egressId = started.egressId;
  } catch (error) {
    logEvent("voice.hlsMicArchiveFailed", {
      channelId,
      startedAt,
      trackId,
      error: error instanceof Error ? error.message : String(error),
    });
    // No retry budget of its own: the deadline below is still open, so the
    // next monitor tick tries again until it closes.
    return;
  }
  // The room may have been replaced while LiveKit was answering. Stop what we
  // just started rather than filing it on a session nobody owns any more.
  if (rooms.get(channelId) !== room) {
    await stopEgressById(egressId, channelId);
    return;
  }
  room.micArchive = { egressId, trackId };
  room.micArchiveUntil = 0;
  await recordSessionStarted(
    channelId,
    startedAt,
    egressId,
    MIC_ARCHIVE_RUNG,
    room.stream.presenterPeerId,
    room.videoTrackId,
  );
  logEvent("voice.hlsMicArchiveStarted", {
    channelId,
    startedAt,
    egressId,
    trackId,
    key: micArchiveObjectKey(channelId, startedAt),
  });
}

/**
 * Stop the archive and close its row. `reason` is not optional here for the
 * same reason it is not on `stopRoom`: three callers that log nothing is how
 * pitfall 15 stayed invisible for a week.
 */
async function stopMicArchive(
  channelId: string,
  room: RoomHls,
  reason: string,
  { stopEgress = true }: { stopEgress?: boolean } = {},
): Promise<void> {
  const archive = room.micArchive;
  if (!archive) {
    return;
  }
  room.micArchive = null;
  room.micArchiveUntil = 0;
  logEvent("voice.hlsMicArchiveStopped", {
    channelId,
    startedAt: room.stream.startedAt,
    egressId: archive.egressId,
    reason,
  });
  if (stopEgress) {
    const egress = getEgress();
    if (egress) {
      try {
        await egress.stopEgress(archive.egressId);
      } catch (error) {
        logEvent("voice.hlsStopFailed", {
          channelId,
          egressId: archive.egressId,
          rung: MIC_ARCHIVE_RUNG,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  await recordSessionEnded(channelId, room.stream.startedAt, MIC_ARCHIVE_RUNG);
}

/**
 * One monitor pass for the archive: start it when the track finally shows up,
 * notice when it has ended, and stop it when the flag went off underneath.
 *
 * The late arrival is the normal case, not an edge: the browser publishes the
 * second track only once the mix is running, which is after the share is up,
 * which is what starts the session. So the first look almost always misses it
 * and the tick a few seconds later finds it.
 */
async function tendMicArchive(
  egress: LiveHlsEgressApi,
  channelId: string,
  room: RoomHls,
  now: number,
): Promise<void> {
  if (!micArchiveEnabled()) {
    // Turned off mid-party. Stop the recording; leave the party alone.
    await stopMicArchive(channelId, room, "disabled");
    return;
  }
  if (room.micArchive) {
    if (!egress.listEgress) {
      return;
    }
    let health: EgressHealth = "unknown";
    try {
      const listing = await egress.listEgress({
        egressId: room.micArchive.egressId,
      });
      health = healthFromListing(room.micArchive.egressId, listing);
    } catch (error) {
      logEvent("voice.hlsMicArchiveHealthFailed", {
        channelId,
        egressId: room.micArchive.egressId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (health === "ended") {
      // LiveKit says it is over, so there is nothing to stop: asking would
      // only log a failure about an egress that finished. The row is closed
      // so retention collects whatever was written.
      await stopMicArchive(channelId, room, "egress-ended", {
        stopEgress: false,
      });
    }
    return;
  }
  if (now >= room.micArchiveUntil) {
    return;
  }
  const tracks = await probeScreenTracks(channelId, room.stream.presenterPeerId);
  if (!tracks?.micArchiveTrackId || rooms.get(channelId) !== room) {
    return;
  }
  await startMicArchive(egress, channelId, room, tracks.micArchiveTrackId);
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
  });
  // BEFORE the rungs, and unconditionally: the archive is an egress on the
  // media box like any other, and a session torn down without stopping it
  // leaves a handler writing to a file whose row has just been closed for
  // retention — the exact shape of pitfall 15, one flag later.
  await stopMicArchive(channelId, current, reason);
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
    runningRungs: await activeBoxEgressCount(),
    sfuLoadMbps: await currentSfuLoadMbps(),
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
    startedAtMs: startedAt,
    micArchive: null,
    // Open the window even when the flag is off right now: it is read per
    // call, so an operator who turns it on thirty seconds into a party gets
    // the archive rather than having to restart the share.
    micArchiveUntil: startedAt + MIC_ARCHIVE_WAIT_MS,
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
  // AFTER `endSupersededSessions`, or the sweep of "every active egress on
  // this room that is not one of the ids I just started" would stop the
  // archive one line after starting it. Usually a no-op on this pass: the
  // browser publishes the archive track only once the mix is up, which is
  // after the share, which is what got us here. The monitor picks it up.
  if (micArchiveEnabled() && tracks.micArchiveTrackId) {
    await startMicArchive(egress, channelId, room, tracks.micArchiveTrackId);
  }
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
  return stream;
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
    if (!tracks || tracks.videoTrackId === current.videoTrackId) {
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
      return current.stream;
    }
    await stopRoom(channelId, "presenter-changed");
  }
  return startRoom(channelId, presenterPeerId, undefined, sourceHeight);
}

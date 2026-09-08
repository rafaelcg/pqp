import {
  EgressClient,
  EncodingOptionsPreset,
  RoomServiceClient,
  S3Upload,
  SegmentedFileOutput,
  TrackSource,
} from "livekit-server-sdk";
import { playlistLooksLive, type LiveHlsStream } from "@pqp/shared";
import { isLiveKitConfigured } from "./backends.js";
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
      encodingOptions?: EncodingOptionsPreset;
    },
  ) => Promise<{ egressId: string }>;
  stopEgress: (egressId: string) => Promise<void>;
}

export type LiveHlsTrackFinder = (
  roomName: string,
) => Promise<LiveHlsScreenTracks | null>;

interface RoomHls {
  egressId: string;
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
}

const rooms = new Map<string, RoomHls>();

let injectedEgress: LiveHlsEgressApi | null = null;
let injectedFinder: LiveHlsTrackFinder | null = null;

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

const DEFAULT_PRESET = "720p30";
const PRESETS: Record<string, EncodingOptionsPreset> = {
  "720p30": EncodingOptionsPreset.H264_720P_30,
  "1080p30": EncodingOptionsPreset.H264_1080P_30,
};
let warnedPreset: string | null = null;

/**
 * `LIVE_HLS_PRESET`: the egress encoding. `720p30` (default) or `1080p30`.
 * Anything else logs `voice.hlsPresetInvalid` once per distinct value and
 * uses the default. 720p is the box's safe ceiling: the transcode runs on
 * the same CPU as the SFU, and a share the presenter already sends at 720p
 * (the large-room cap) gains nothing from a 1080p encode.
 */
export function liveHlsPreset(): EncodingOptionsPreset {
  const raw = process.env.LIVE_HLS_PRESET?.trim();
  if (!raw) {
    return PRESETS[DEFAULT_PRESET]!;
  }
  const preset = PRESETS[raw.toLowerCase()];
  if (preset !== undefined) {
    return preset;
  }
  if (warnedPreset !== raw) {
    warnedPreset = raw;
    logEvent("voice.hlsPresetInvalid", {
      value: raw,
      accepted: Object.keys(PRESETS),
      using: DEFAULT_PRESET,
    });
  }
  return PRESETS[DEFAULT_PRESET]!;
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
 * The exact string every object a session writes starts with: the segments
 * (`filenamePrefix`) and both playlist names all derive from
 * `live/{channelId}/{startedAt}`, per `playlistUrl` / `segmentOutput` below.
 * The retention sweep deletes only objects under this prefix, so this
 * function is the single source of truth both `hls-egress.ts` and
 * `hls-cleanup.ts` call, rather than each re-deriving the string.
 */
export function hlsObjectPrefix(channelId: string, startedAt: number): string {
  return `live/${channelId}/${startedAt}`;
}

async function recordSessionStarted(
  channelId: string,
  startedAt: number,
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO hls_sessions (channel_id, object_prefix, started_at)
       VALUES ($1, $2, to_timestamp($3 / 1000.0))
       ON CONFLICT (object_prefix) DO NOTHING`,
      [channelId, hlsObjectPrefix(channelId, startedAt), startedAt],
    );
  } catch (error) {
    logEvent("voice.hlsSessionRecordFailed", {
      channelId,
      startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function recordSessionEnded(
  channelId: string,
  startedAt: number,
): Promise<void> {
  try {
    await getPool().query(
      `UPDATE hls_sessions SET ended_at = NOW()
       WHERE object_prefix = $1 AND ended_at IS NULL`,
      [hlsObjectPrefix(channelId, startedAt)],
    );
  } catch (error) {
    logEvent("voice.hlsSessionEndFailed", {
      channelId,
      startedAt,
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
  };
}

export function liveHlsStreamFor(channelId: string): LiveHlsStream | null {
  return rooms.get(channelId)?.stream ?? null;
}

/** Tests inject fakes; production leaves both null. */
export function setLiveHlsTestHooks(hooks: {
  egress?: LiveHlsEgressApi | null;
  findTracks?: LiveHlsTrackFinder | null;
}): void {
  if ("egress" in hooks) {
    injectedEgress = hooks.egress ?? null;
  }
  if ("findTracks" in hooks) {
    injectedFinder = hooks.findTracks ?? null;
  }
}

export function resetLiveHlsForTests(): void {
  rooms.clear();
  warnedPreset = null;
  injectedEgress = null;
  injectedFinder = null;
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
  };
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
    return true;
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
): string {
  const config = liveHlsStorageConfig();
  if (!config) {
    return rawPlaylistUrl(channelId, startedAt);
  }
  return signRequest({
    method: "GET",
    key: `${hlsObjectPrefix(channelId, startedAt)}.m3u8`,
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
export function rawPlaylistUrl(channelId: string, startedAt: number): string {
  return `${publicBaseUrl()}/${hlsObjectPrefix(channelId, startedAt)}.m3u8`;
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

function segmentOutput(prefix: string, startedAt: number): SegmentedFileOutput {
  const storage = liveHlsStorage()!;
  return new SegmentedFileOutput({
    filenamePrefix: prefix,
    playlistName: `${startedAt}-index.m3u8`,
    livePlaylistName: `${startedAt}.m3u8`,
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

async function stopRoom(channelId: string): Promise<void> {
  const current = rooms.get(channelId);
  if (!current) {
    return;
  }
  rooms.delete(channelId);
  await recordSessionEnded(channelId, current.stream.startedAt);
  const egress = getEgress();
  if (!egress) {
    return;
  }
  try {
    await egress.stopEgress(current.egressId);
  } catch (error) {
    logEvent("voice.hlsStopFailed", {
      channelId,
      egressId: current.egressId,
      error: error instanceof Error ? error.message : String(error),
    });
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
  const tracks = knownTracks ?? (await findScreenTracks(channelId));
  if (!tracks) {
    logEvent("voice.hlsNoScreenTrack", { channelId, presenterPeerId });
    return null;
  }
  const startedAt = Date.now();
  const prefix = hlsObjectPrefix(channelId, startedAt);
  try {
    const started = await egress.startTrackCompositeEgress(
      channelId,
      segmentOutput(prefix, startedAt),
      {
        videoTrackId: tracks.videoTrackId,
        audioTrackId: tracks.audioTrackId,
        encodingOptions: liveHlsPreset(),
      },
    );
    const stream: LiveHlsStream = {
      hlsUrl: viewerPlaylistUrl(channelId, startedAt),
      startedAt,
      presenterPeerId,
      delaySeconds: delaySeconds(),
    };
    rooms.set(channelId, {
      egressId: started.egressId,
      stream,
      videoTrackId: tracks.videoTrackId,
    });
    await recordSessionStarted(channelId, startedAt);
    // The readiness probe reads the bucket itself (presigned, endpoint
    // form), never the viewer-facing URL: a viewer may get the signed proxy
    // path, which this same process cannot usefully fetch from here.
    const ready = await waitForLivePlaylist(
      internalPlaylistUrl(channelId, startedAt),
    );
    logEvent("voice.hlsStarted", {
      channelId,
      egressId: started.egressId,
      presenterPeerId,
      playlistReady: ready,
    });
    return stream;
  } catch (error) {
    logEvent("voice.hlsStartFailed", {
      channelId,
      presenterPeerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
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
export async function reconcileLiveHls(
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
      egressId: current.egressId,
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

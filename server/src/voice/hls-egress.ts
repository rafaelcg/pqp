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

/**
 * Live HLS for a watch-party screen share: LiveKit Track Composite egress
 * writes 2 s segments to a dedicated R2 bucket, and the playlist URL rides
 * the existing `/ws` as `voice-stream`.
 *
 * Off unless `LIVE_HLS_ENABLED=true` and the public URL plus a *separate*
 * S3 set (`LIVE_HLS_S3_*`) are present. Attachment `S3_*` is deliberately
 * not reused — that bucket is private.
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

/** Flag plus every secret the egress request needs. Read per call. */
export function isLiveHlsEnabled(): boolean {
  return (
    truthyEnabled() &&
    isLiveKitConfigured() &&
    publicBaseUrl() !== null &&
    liveHlsStorage() !== null
  );
}

export function liveHlsConfig(): { enabled: boolean; delaySeconds: number } {
  return { enabled: isLiveHlsEnabled(), delaySeconds: delaySeconds() };
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

function isTrackSource(
  source: unknown,
  wanted: TrackSource,
): boolean {
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

function playlistUrl(channelId: string, startedAt: number): string {
  // LiveKit treats filenamePrefix as a file prefix, not a directory.
  // Segments land at live/{channel}/{startedAt}_00000.ts; a reused
  // live.m3u8 keeps the previous share's #EXT-X-ENDLIST until overwrite,
  // so each share gets its own playlist name.
  return `${publicBaseUrl()}/live/${channelId}/${startedAt}.m3u8`;
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
): Promise<LiveHlsStream | null> {
  const egress = getEgress();
  if (!egress || !isLiveHlsEnabled()) {
    return null;
  }
  const tracks = await findScreenTracks(channelId);
  if (!tracks) {
    logEvent("voice.hlsNoScreenTrack", { channelId, presenterPeerId });
    return null;
  }
  const startedAt = Date.now();
  const prefix = `live/${channelId}/${startedAt}`;
  try {
    const started = await egress.startTrackCompositeEgress(
      channelId,
      segmentOutput(prefix, startedAt),
      {
        videoTrackId: tracks.videoTrackId,
        audioTrackId: tracks.audioTrackId,
        // Default preset is H264_720P_30. A 1080 share would be crushed.
        encodingOptions: EncodingOptionsPreset.H264_1080P_30,
      },
    );
    const stream: LiveHlsStream = {
      hlsUrl: playlistUrl(channelId, startedAt),
      startedAt,
      presenterPeerId,
      delaySeconds: delaySeconds(),
    };
    rooms.set(channelId, { egressId: started.egressId, stream });
    const ready = await waitForLivePlaylist(stream.hlsUrl);
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
 * `presenterPeerId: null` means nobody is sharing — stop if we were.
 */
export async function reconcileLiveHls(
  channelId: string,
  presenterPeerId: string | null,
): Promise<LiveHlsStream | null> {
  if (!isLiveHlsEnabled()) {
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
    return current.stream;
  }
  if (current) {
    await stopRoom(channelId);
  }
  return startRoom(channelId, presenterPeerId);
}

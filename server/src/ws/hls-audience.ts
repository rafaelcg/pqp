import type { WebSocket } from "ws";
import type { LiveHlsStream } from "@pqp/shared";

/**
 * The channel-level half of live HLS: who is watching a channel's stream
 * WITHOUT a seat in its voice room, and when the audience is told about it.
 *
 * Kept out of voice.ts so the counting and the timer can be tested without a
 * room. voice.ts owns the sockets, the access checks and the frames; this
 * module owns three maps and one clock.
 */

/** The peer fields the HLS start reads. `VoicePeer` satisfies it. */
export interface HlsSharerLike {
  id: string;
  sharingScreen: boolean;
  canStream: boolean;
  /**
   * The seat is in a `watch_party` channel (`isWatchPartyChannelType` on the
   * row, resolved at join beside `canStream`). A channel fact carried on the
   * peer because every seat in a room came from the same row, so the picker
   * answers without a query on a path that runs on every join and leave.
   */
  watchParty: boolean;
}

/**
 * The peer that feeds the egress, or null.
 *
 * TWO GATES, and the second one is why `LIVE_HLS_ENABLED` is safe to set
 * globally.
 *
 * THE STAGE GATE: `canStream` is `Permission.STREAM` in a voice channel and
 * `START_WATCH_PARTY` in a watch party (see `canStartWatchPartyStream`),
 * resolved at join and re-resolved on a permissions change. A roster claim
 * that slipped past that gate must not become a transcode, so the flag is
 * read here as well as on the claim.
 *
 * THE ROOM GATE: `watchParty`. A transcode costs the media box about 1.4 of
 * its 4 cores for the default two-rung ladder (`docs/CAPACITY.md`), and
 * before this gate ANY screen share in ANY LiveKit room started one: a
 * ten-member server showing a friend some code, a listed community's hangout,
 * a room already on the SFU for size alone. None of those is a watch party
 * and none of them has an audience that could ever read the playlist, since
 * the watch surface only exists on a `watch_party` channel. So the egress is
 * confined to the one channel type a party can live in.
 */
export function pickHlsSharer<T extends HlsSharerLike>(peers: T[]): T | null {
  return (
    peers.find(
      (peer) => peer.watchParty && peer.sharingScreen && peer.canStream,
    ) ?? null
  );
}

export interface HlsAudienceOptions {
  /** How often a live or watched channel restates its count to the audience. */
  keyframeMs: number;
  /** Tell the channel's audience the current stream and count. */
  broadcast: (channelId: string) => void;
}

/**
 * Per-channel watch-mode state.
 *
 * The count is never broadcast on subscribe or unsubscribe. A watch party's
 * audience arrives in one wave (the 2026-09-05 spike was 212 people in
 * twenty minutes), and a frame to the whole server per arrival is the roster
 * cost this path exists to avoid. Instead, while a channel has a live stream
 * or at least one watcher, a per-channel timer restates the count on the
 * audience keyframe cadence; the timer stops when neither holds.
 */
export interface HlsAudience {
  /** `watch-live { watching: true }` from a socket without a seat. */
  subscribe(channelId: string, socket: WebSocket): void;
  /** `watch-live { watching: false }`. */
  unsubscribe(channelId: string, socket: WebSocket): void;
  /** The socket closed or took a seat: it is no longer a watcher anywhere. */
  dropSocket(socket: WebSocket): void;
  /** What `pushLiveHls` last told the audience about this channel. */
  setStream(channelId: string, stream: LiveHlsStream | null): void;
  stream(channelId: string): LiveHlsStream | null;
  /** Every channel with a live stream, for the socket-auth push. */
  liveChannels(): string[];
  /** Watchers without a seat. */
  count(channelId: string): number;
  /** Forget everything and stop every clock. Tests only. */
  reset(): void;
}

export function createHlsAudience(options: HlsAudienceOptions): HlsAudience {
  const watching = new Map<string, Set<WebSocket>>();
  const streams = new Map<string, LiveHlsStream>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();

  const active = (channelId: string) =>
    streams.has(channelId) || (watching.get(channelId)?.size ?? 0) > 0;

  /** Start the clock if the channel is live or watched, stop it otherwise. */
  const reconcileTimer = (channelId: string) => {
    const timer = timers.get(channelId);
    if (active(channelId)) {
      if (!timer) {
        const handle = setInterval(() => {
          if (!active(channelId)) {
            clearInterval(handle);
            timers.delete(channelId);
            return;
          }
          options.broadcast(channelId);
        }, options.keyframeMs);
        handle.unref?.();
        timers.set(channelId, handle);
      }
    } else if (timer) {
      clearInterval(timer);
      timers.delete(channelId);
    }
  };

  const remove = (channelId: string, socket: WebSocket) => {
    const set = watching.get(channelId);
    if (!set) {
      return;
    }
    set.delete(socket);
    if (set.size === 0) {
      watching.delete(channelId);
    }
    reconcileTimer(channelId);
  };

  return {
    subscribe(channelId, socket) {
      let set = watching.get(channelId);
      if (!set) {
        set = new Set();
        watching.set(channelId, set);
      }
      set.add(socket);
      reconcileTimer(channelId);
    },
    unsubscribe: remove,
    dropSocket(socket) {
      for (const channelId of [...watching.keys()]) {
        remove(channelId, socket);
      }
    },
    setStream(channelId, stream) {
      if (stream) {
        streams.set(channelId, stream);
      } else {
        streams.delete(channelId);
      }
      reconcileTimer(channelId);
    },
    stream(channelId) {
      return streams.get(channelId) ?? null;
    },
    liveChannels() {
      return [...streams.keys()];
    },
    count(channelId) {
      return watching.get(channelId)?.size ?? 0;
    },
    reset() {
      for (const timer of timers.values()) {
        clearInterval(timer);
      }
      timers.clear();
      watching.clear();
      streams.clear();
    },
  };
}

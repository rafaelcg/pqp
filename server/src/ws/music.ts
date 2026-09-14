import {
  musicWriteAllowed,
  musicWriteIsStale,
  musicWriteIsStructural,
  type ChannelMusicTrack,
  type MusicRights,
  type MusicState,
} from "@pqp/shared";
import { logEvent } from "../lib/log.js";
import { createRateLimiter } from "../lib/rate-limit.js";

/**
 * THE ROOM'S MUSIC QUEUE, HELD HERE RATHER THAN RELAYED THROUGH.
 *
 * The server half of `packages/shared/src/music.ts`, and a copy of the
 * watch-party module's shape (`ws/watch-party.ts`) for the same two reasons:
 * a peer joining mid-track has to land at the right position and has no way
 * to ask anybody for it, and the last participant leaving has to tear the
 * queue down.
 *
 * SCOPE. Per process, exactly like `peers` in `voice.ts` and the map in
 * `ws/watch-party.ts`. With the voice registry off (the default) this map IS
 * the queue and a room lives on one instance. With `VOICE_REGISTRY=postgres`
 * the queue is `voice_rooms.music` and this map is a cache of it: a write is
 * compared and coalesced here first, then persisted with the contract's
 * ordering as the WHERE clause (`persistMusic` in `voice/registry.ts`), and a
 * write that lost in the row is handed the row's winner. Writes from other
 * instances land through `adoptMusicState`, off the `voice.music` bus topic.
 * Documented in `docs/MUSIC.md`.
 */
const rooms = new Map<string, MusicState>();

/**
 * Same limiter shape as the watch party's: spent by every write, refusing
 * none, and consulted only for position-only updates (a scrub). A dropped
 * pause would split the room permanently, see `watch-party.ts`.
 */
const writeLimiter = createRateLimiter({ capacity: 15, refillPerSecond: 5 });

export function resetMusicLimits(): void {
  writeLimiter.reset();
}

export function getMusicState(voiceChannelId: string): MusicState | null {
  return rooms.get(voiceChannelId) ?? null;
}

/** Every room with music, for the connect-time `channel-music` frames. */
export function musicChannels(): string[] {
  return [...rooms.keys()];
}

/** What the sidebar is told: the current track, nothing else. */
export function channelMusicTrack(voiceChannelId: string): ChannelMusicTrack | null {
  const current = rooms.get(voiceChannelId)?.current;
  return current
    ? { videoId: current.videoId, title: current.title, thumbnailUrl: current.thumbnailUrl }
    : null;
}

/** Returns whether there was a queue to end. */
export function endMusic(voiceChannelId: string): boolean {
  return rooms.delete(voiceChannelId);
}

export function resetMusicForTests(): void {
  rooms.clear();
  writeLimiter.reset();
}

/**
 * Take a queue decided elsewhere (the registry row, or a `voice.music` frame
 * from another instance) into the cache. Applies the contract's ordering
 * against what is held, so a straggling frame cannot roll the cache back;
 * `null` is a teardown and always wins, as it does in `applyMusicWrite`.
 * Returns whether the cache changed. No limiter, no rights check, no log:
 * nothing here was written by a person on this instance, and whoever accepted
 * it already ran all three.
 */
export function adoptMusicState(
  voiceChannelId: string,
  state: MusicState | null,
): boolean {
  const held = getMusicState(voiceChannelId);
  if (state === null) {
    if (held === null) {
      return false;
    }
    rooms.delete(voiceChannelId);
    return true;
  }
  if (musicWriteIsStale(held, state)) {
    return false;
  }
  rooms.set(voiceChannelId, state);
  return true;
}

export type MusicWrite =
  | { kind: "accepted"; state: MusicState | null }
  | { kind: "coalesced" }
  | { kind: "stale"; held: MusicState }
  /** Outside the sender's rights. `held` goes back, forced, to undo their optimistic copy. */
  | { kind: "refused"; held: MusicState | null };

export function applyMusicWrite(
  voiceChannelId: string,
  incoming: MusicState | null,
  rights: MusicRights,
): MusicWrite {
  const actorUserId = rights.userId;
  const held = getMusicState(voiceChannelId);
  if (musicWriteIsStale(held, incoming)) {
    return { kind: "stale", held: held as MusicState };
  }
  if (!musicWriteAllowed(held, incoming, rights)) {
    logEvent("voice.musicRefused", { voiceChannelId, userId: actorUserId });
    return { kind: "refused", held };
  }
  const structural = musicWriteIsStructural(held, incoming);
  const withinBudget = writeLimiter.take(actorUserId);
  if (!structural && !withinBudget) {
    if (incoming) {
      rooms.set(voiceChannelId, incoming);
    }
    return { kind: "coalesced" };
  }
  if (incoming === null) {
    endMusic(voiceChannelId);
    return { kind: "accepted", state: null };
  }
  if (held === null) {
    logEvent("voice.musicStart", {
      voiceChannelId,
      userId: actorUserId,
      videoId: incoming.current?.videoId ?? null,
    });
  }
  rooms.set(voiceChannelId, incoming);
  return { kind: "accepted", state: incoming };
}

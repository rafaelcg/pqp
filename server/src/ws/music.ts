import {
  completeMusicState,
  musicWriteAllowed,
  musicWriteIsStale,
  musicWriteIsStructural,
  type ChannelMusicTrack,
  type MusicRights,
  type MusicState,
  type MusicStateWrite,
} from "@pqp/shared";
import { logEvent } from "../lib/log.js";
import { createDividedRateLimiter } from "../lib/cluster-rate-limit.js";

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
/**
 * DIVIDED, NOT SHARED. The budget is a cluster-wide 15, so with two machines
 * this process holds 8 of it (see `createDividedRateLimiter`). That is
 * approximate on purpose: this limiter is consulted on a per-frame path — a
 * seek scrub emits continuously while a thumb is down — and a round trip per
 * frame would cost more than the limit is worth. It is also the limiter that
 * REFUSES NOTHING, so dividing it can only make a scrub slightly choppier in
 * the worst case; a budget that refused would instead hand a single-tab user
 * half of what they had, since their socket lives on one machine.
 */
const writeLimiter = createDividedRateLimiter({ capacity: 15, refillPerSecond: 5 });

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

/** What the sidebar is told: the current track, and who is listening. */
export function channelMusicTrack(
  voiceChannelId: string,
  listeners?: number,
): ChannelMusicTrack | null {
  const current = rooms.get(voiceChannelId)?.current;
  return current
    ? {
        videoId: current.videoId,
        title: current.title,
        thumbnailUrl: current.thumbnailUrl,
        ...(listeners !== undefined ? { listeners } : {}),
      }
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
  incoming: MusicStateWrite | null,
  rights: MusicRights,
): MusicWrite {
  const actorUserId = rights.userId;
  const held = getMusicState(voiceChannelId);
  const next = incoming === null ? null : completeMusicState(held, incoming);
  if (musicWriteIsStale(held, next)) {
    return { kind: "stale", held: held as MusicState };
  }
  if (!musicWriteAllowed(held, next, rights)) {
    logEvent("voice.musicRefused", { voiceChannelId, userId: actorUserId });
    return { kind: "refused", held };
  }
  const structural = musicWriteIsStructural(held, next);
  const withinBudget = writeLimiter.take(actorUserId);
  if (!structural && !withinBudget) {
    if (next) {
      rooms.set(voiceChannelId, next);
    }
    return { kind: "coalesced" };
  }
  if (next === null) {
    endMusic(voiceChannelId);
    return { kind: "accepted", state: null };
  }
  if (held === null) {
    logEvent("voice.musicStart", {
      voiceChannelId,
      userId: actorUserId,
      videoId: next.current?.videoId ?? null,
    });
  }
  rooms.set(voiceChannelId, next);
  return { kind: "accepted", state: next };
}

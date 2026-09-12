import {
  musicWriteIsStale,
  musicWriteIsStructural,
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
 * SCOPE. Per process, like `peers` in `voice.ts`: a room lives on one
 * instance. Not mirrored into the voice registry yet, so a queue does not
 * survive an API restart. Documented in `docs/MUSIC.md`.
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

/** Returns whether there was a queue to end. */
export function endMusic(voiceChannelId: string): boolean {
  return rooms.delete(voiceChannelId);
}

export function resetMusicForTests(): void {
  rooms.clear();
  writeLimiter.reset();
}

export type MusicWrite =
  | { kind: "accepted"; state: MusicState | null }
  | { kind: "coalesced" }
  | { kind: "stale"; held: MusicState };

export function applyMusicWrite(
  voiceChannelId: string,
  incoming: MusicState | null,
  actorUserId: string,
): MusicWrite {
  const held = getMusicState(voiceChannelId);
  if (musicWriteIsStale(held, incoming)) {
    return { kind: "stale", held: held as MusicState };
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

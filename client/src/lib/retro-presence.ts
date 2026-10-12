/**
 * "Fulano acabou de entrar": which friends just came online, from the friends
 * list the app already polls (`GET /api/friends`, every 15 s while something
 * draws presence). A client-side diff on purpose: status is pull-only today,
 * and a server push on connect would toast every friend after every API
 * deploy, when all sockets reconnect at once.
 *
 * Pure and unit-tested. The rules:
 *
 *  - The first snapshot is a baseline. Nothing toasts from it.
 *  - A friend ARRIVES when they are not offline now, and the snapshots before
 *    this one saw them offline at least twice, the first and last of those
 *    sightings at least `MIN_OFFLINE_MS` apart (two polls, 15 s apart). A
 *    socket that blips through a deploy reconnects well inside that, so it
 *    never counts as leaving and coming back.
 *  - `invisible` friends are `offline` on the wire, so they never toast.
 *  - A friend new to the list (just accepted) has no history and never toasts.
 *
 * And the pacing: at most one card per `TOAST_GAP_MS`; everybody who arrives
 * while a card is cooling down rides on the next one ("Lu e mais 2").
 */

import type { UserStatus } from "@pqp/shared";

/** Two polls 15 s apart, with room for a late timer. */
export const MIN_OFFLINE_MS = 12_000;
export const TOAST_GAP_MS = 8_000;
export const TOAST_VISIBLE_MS = 5_000;
/** A tab hidden longer than this restarts from a baseline: no stale burst. */
export const HIDDEN_RESET_MS = 10 * 60_000;

interface FriendTrack {
  status: UserStatus;
  /** When the current offline stretch was first seen, or null. */
  offlineSince: number | null;
  /** When it was last seen, still offline, or null. */
  lastOfflineAt: number | null;
  /** Consecutive snapshots that saw them offline. */
  offlineFrames: number;
}

export interface PresenceMemory {
  tracks: ReadonlyMap<string, FriendTrack>;
  frames: number;
}

export const EMPTY_PRESENCE: PresenceMemory = { tracks: new Map(), frames: 0 };

export function observePresence(
  memory: PresenceMemory,
  statuses: Iterable<readonly [string, UserStatus]>,
  now: number,
): { memory: PresenceMemory; arrived: string[] } {
  const baseline = memory.frames === 0;
  const tracks = new Map<string, FriendTrack>();
  const arrived: string[] = [];
  for (const [id, status] of statuses) {
    const previous = memory.tracks.get(id);
    const offline = status === "offline";
    if (offline) {
      const stillOffline = previous?.status === "offline";
      tracks.set(id, {
        status,
        offlineSince: stillOffline ? previous.offlineSince : now,
        lastOfflineAt: now,
        offlineFrames: stillOffline ? previous.offlineFrames + 1 : 1,
      });
      continue;
    }
    tracks.set(id, {
      status,
      offlineSince: null,
      lastOfflineAt: null,
      offlineFrames: 0,
    });
    // The span is between OFFLINE sightings, not up to this one: a late poll
    // after two quick offline reads must not stretch a blip into an absence.
    if (
      !baseline &&
      previous?.status === "offline" &&
      previous.offlineFrames >= 2 &&
      previous.offlineSince !== null &&
      previous.lastOfflineAt !== null &&
      previous.lastOfflineAt - previous.offlineSince >= MIN_OFFLINE_MS
    ) {
      arrived.push(id);
    }
  }
  return { memory: { tracks, frames: memory.frames + 1 }, arrived };
}

export interface ToastPacing {
  /** Arrivals waiting for the next card, oldest first, no duplicates. */
  pending: readonly string[];
  lastShownAt: number;
}

export const EMPTY_PACING: ToastPacing = {
  pending: [],
  lastShownAt: Number.NEGATIVE_INFINITY,
};

export function queueArrivals(
  pacing: ToastPacing,
  arrived: readonly string[],
): ToastPacing {
  if (arrived.length === 0) {
    return pacing;
  }
  const pending = [...pacing.pending];
  for (const id of arrived) {
    if (!pending.includes(id)) {
      pending.push(id);
    }
  }
  return { ...pacing, pending };
}

/**
 * The next card, if one is due: everybody pending, grouped. `wait` is how
 * long until the gap allows one, for the caller's timer.
 */
export function takeToast(
  pacing: ToastPacing,
  now: number,
): { ids: string[] | null; wait: number; pacing: ToastPacing } {
  if (pacing.pending.length === 0) {
    return { ids: null, wait: 0, pacing };
  }
  const wait = pacing.lastShownAt + TOAST_GAP_MS - now;
  if (wait > 0) {
    return { ids: null, wait, pacing };
  }
  return {
    ids: [...pacing.pending],
    wait: 0,
    pacing: { pending: [], lastShownAt: now },
  };
}

/**
 * THE CHANNEL'S WATCH-PARTY SEAT SNAPSHOT, held here so `join-voice-room`
 * does not ask the database once per viewer.
 *
 * `loadWatchPartySeat` is still the loader. This is the cache in front of
 * it. A 500-person film night is one query (or none, if a mutation already
 * dropped this map and a later join refilled it) rather than 500 round trips
 * on the pool-pinned join path.
 *
 * WHAT IS STORED. The party's own facts: whether voice is on, who the host
 * is, the co-host ids, the stage-invite ids. Per-user fields (`isHost`,
 * `isCohost`, `isInvited`) are derived from those lists at read time, which
 * is why a second viewer does not need a second query.
 *
 * INVALIDATED ON EVERY STATE CHANGE that `broadcastWatchParty` sees, which
 * is every mutation: Voz on or off, a co-host added or removed, a stage
 * invitation, going live, ending. A stale "voice off" must not lock a
 * host's friends out after they turned Voz on, and a stale "voice on"
 * must not seat five hundred people after they turned it off.
 *
 * FAILS OPEN at the caller. A thrown load is not cached, so a hiccup is
 * still one missed snapshot rather than a stuck "voice off" for the rest
 * of the show. `mayTakeWatchPartySeat` stays the decision; this only feeds
 * it.
 */

export type WatchPartySeatSnapshot = {
  voiceEnabled: boolean;
  hostUserId: string;
  cohostIds: readonly string[];
  invitedIds: readonly string[];
} | null;

export type WatchPartySeatInfo = {
  voiceEnabled: boolean;
  isHost: boolean;
  isCohost: boolean;
  isInvited: boolean;
};

const snapshots = new Map<string, WatchPartySeatSnapshot>();
const inflight = new Map<string, Promise<WatchPartySeatSnapshot>>();
const epochs = new Map<string, number>();

function epochOf(channelId: string): number {
  return epochs.get(channelId) ?? 0;
}

function bump(channelId: string): void {
  epochs.set(channelId, epochOf(channelId) + 1);
}

/** Derive the per-user seat the join gate already understands. */
export function watchPartySeatForUser(
  snapshot: WatchPartySeatSnapshot,
  userId: string,
): WatchPartySeatInfo | null {
  if (!snapshot) {
    return null;
  }
  return {
    voiceEnabled: snapshot.voiceEnabled,
    isHost: snapshot.hostUserId === userId,
    isCohost: snapshot.cohostIds.includes(userId),
    isInvited: snapshot.invitedIds.includes(userId),
  };
}

/** What this process currently holds for the channel, or `undefined` on a miss. */
export function peekWatchPartySeatSnapshot(
  channelId: string,
): WatchPartySeatSnapshot | undefined {
  return snapshots.get(channelId);
}

/**
 * Plant a snapshot. Used by tests, and by `broadcastWatchParty` when it
 * already knows the answer (a party that just ended is `null`).
 */
export function rememberWatchPartySeatSnapshot(
  channelId: string,
  snapshot: WatchPartySeatSnapshot,
): void {
  bump(channelId);
  inflight.delete(channelId);
  snapshots.set(channelId, snapshot);
}

/**
 * Drop the snapshot. The next join reloads. Called from `broadcastWatchParty`
 * for every non-terminal state change, including a Voz toggle that does
 * not change `status`.
 */
export function invalidateWatchPartySeat(channelId: string): void {
  bump(channelId);
  inflight.delete(channelId);
  snapshots.delete(channelId);
}

/**
 * Cache, then load. Concurrent joins against an empty channel share one
 * in-flight fetch so a stampede after a restart is still one query.
 *
 * A mutation that lands while the fetch is in flight bumps the epoch and
 * clears `inflight`, so the stale result is not stored and the waiter
 * retries. Failures are not stored either: the next join asks again.
 */
export async function cachedWatchPartySeatSnapshot(
  channelId: string,
  load: (channelId: string) => Promise<WatchPartySeatSnapshot>,
): Promise<WatchPartySeatSnapshot> {
  const cached = snapshots.get(channelId);
  if (cached !== undefined) {
    return cached;
  }
  const pending = inflight.get(channelId);
  if (pending) {
    return pending;
  }
  const started = epochOf(channelId);
  // `load` is started before `inflight` is stored. That is safe because
  // two joins in the same turn run this function to completion before
  // either `then` fires, so the second call sees the pending promise.
  const task = Promise.resolve(load(channelId)).then(
    (snapshot) => {
      inflight.delete(channelId);
      if (epochOf(channelId) !== started) {
        return cachedWatchPartySeatSnapshot(channelId, load);
      }
      snapshots.set(channelId, snapshot);
      return snapshot;
    },
    (error: unknown) => {
      inflight.delete(channelId);
      throw error;
    },
  );
  inflight.set(channelId, task);
  return task;
}

export function resetWatchPartySeatCacheForTests(): void {
  snapshots.clear();
  inflight.clear();
  epochs.clear();
}

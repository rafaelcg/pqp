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
 * MULTI-INSTANCE. Unlike the read caches in `services/users.ts` and
 * `lib/read-cache.ts`, this map has NO TTL at all — it answers from memory
 * until something explicitly drops it, which on a single process is exactly
 * "until the next mutation" because `broadcastWatchParty` sees every one of
 * them. Behind a load balancer with no session affinity that stops being
 * true: a mutation processed on instance A only ever called the LOCAL
 * `invalidate`/`remember` below, so instance B kept answering from whatever
 * it last loaded — Voz off, a co-host still on the list, a stage invite
 * still live — with no TTL to age it out, for as long as the party ran or
 * until some OTHER mutation happened to land on B too. That is the exact
 * shape PR #593 fixed for the age gate (a per-process cache of one-shot,
 * mutable state with invalidation that only ever reached the writer's own
 * process), except worse: the age gate was bounded by a 30s TTL and this had
 * none. `invalidateWatchPartySeat` and `rememberWatchPartySeatSnapshot` now
 * publish over the cluster bus (`lib/bus.ts`), same pattern as
 * `invalidateChannelAccessForChannel` in `services/users.ts`: a sibling
 * instance drops its own copy of the snapshot on the same event, so its next
 * `join-voice-room` re-reads the database rather than a stale seat answer.
 * With no bus installed (`CLUSTER_BUS` unset, today's default) the publish
 * is a single boolean read and every process is on its own, same as before.
 *
 * FAILS OPEN at the caller. A thrown load is not cached, so a hiccup is
 * still one missed snapshot rather than a stuck "voice off" for the rest
 * of the show. `mayGoOnAir` stays the decision; this only feeds it.
 */

import { isBusEnabled, publishToCluster, subscribeToCluster } from "../lib/bus.js";
import type { WatchPartyGuestsMode } from "@pqp/shared";

export type WatchPartySeatSnapshot = {
  guests: WatchPartyGuestsMode;
  hostUserId: string;
  cohostIds: readonly string[];
  /** `accepted_at IS NOT NULL` rows only — an unanswered invitation is not a seat. */
  acceptedGuestIds: readonly string[];
} | null;

export type WatchPartySeatInfo = {
  guests: WatchPartyGuestsMode;
  isHost: boolean;
  isCohost: boolean;
  isGuest: boolean;
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
    guests: snapshot.guests,
    isHost: snapshot.hostUserId === userId,
    isCohost: snapshot.cohostIds.includes(userId),
    isGuest: snapshot.acceptedGuestIds.includes(userId),
  };
}

/** What this process currently holds for the channel, or `undefined` on a miss. */
export function peekWatchPartySeatSnapshot(
  channelId: string,
): WatchPartySeatSnapshot | undefined {
  return snapshots.get(channelId);
}

/**
 * The bus topic for the two functions below. Carries only the channel id —
 * a bare invalidation, not the snapshot value itself — so a sibling instance
 * always re-derives its own answer from the database (or from its own next
 * `broadcastWatchParty` pass) rather than trusting a value shipped over the
 * wire from a process whose `WatchPartySeatSnapshot` shape could differ
 * across a rolling deploy. Same reasoning as `CHANNEL_ACCESS_BUS_TOPIC` in
 * `services/users.ts`.
 */
const WATCH_PARTY_SEAT_BUS_TOPIC = "cache.watch-party-seat.invalidate";

function invalidateWatchPartySeatLocally(channelId: string): void {
  bump(channelId);
  inflight.delete(channelId);
  snapshots.delete(channelId);
}

function publishWatchPartySeatInvalidation(channelId: string): void {
  if (isBusEnabled()) {
    publishToCluster(WATCH_PARTY_SEAT_BUS_TOPIC, { channelId });
  }
}

/**
 * Plant a snapshot. Used by tests, and by `broadcastWatchParty` when it
 * already knows the answer (a party that just ended is `null`).
 *
 * Cross-process: a sibling instance does not receive this snapshot value —
 * it receives an invalidation (see the bus topic doc above) and reloads on
 * its own next `cachedWatchPartySeatSnapshot` call, which for a just-ended
 * party correctly finds nothing active.
 */
export function rememberWatchPartySeatSnapshot(
  channelId: string,
  snapshot: WatchPartySeatSnapshot,
): void {
  bump(channelId);
  inflight.delete(channelId);
  snapshots.set(channelId, snapshot);
  publishWatchPartySeatInvalidation(channelId);
}

/**
 * Drop the snapshot. The next join reloads. Called from `broadcastWatchParty`
 * for every non-terminal state change, including a Voz toggle that does
 * not change `status`.
 *
 * Cross-process: see the bus topic doc above this section. With no bus
 * installed this degrades to exactly the old behaviour — a process only
 * ever forgets its own snapshot.
 */
export function invalidateWatchPartySeat(channelId: string): void {
  invalidateWatchPartySeatLocally(channelId);
  publishWatchPartySeatInvalidation(channelId);
}

/**
 * Invalidations published by a sibling instance. Local half only —
 * publishing from here would let two instances answer each other forever;
 * the origin check in `lib/bus.ts` is the other half of that guard.
 *
 * Frames are validated because a rolling deploy puts two builds on one bus;
 * an unrecognised frame is ignored rather than guessed at.
 */
subscribeToCluster(WATCH_PARTY_SEAT_BUS_TOPIC, (data) => {
  const frame = data as { channelId?: unknown } | null;
  if (
    frame &&
    typeof frame === "object" &&
    typeof frame.channelId === "string" &&
    frame.channelId.length > 0
  ) {
    invalidateWatchPartySeatLocally(frame.channelId);
  }
});

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

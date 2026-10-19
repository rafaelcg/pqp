import type { AppEndReason } from "@pqp/shared";

/**
 * The apps counters, in process and cumulative since boot like the other
 * `GET /api/admin/metrics` blocks (the exporter sums the replicas). Written
 * where the thing happens, read by the metrics block. Nothing here stores
 * anything about a person or a session.
 */

const counters = {
  starts: 0,
  startsRefused: new Map<string, number>(),
  ends: new Map<AppEndReason, number>(),
  joins: 0,
  joinsRefused: new Map<string, number>(),
  /** Frames the server dropped or refused because of a cap, by what capped them. */
  framesDropped: new Map<string, number>(),
  stateWrites: 0,
  stateWritesCoalesced: 0,
  events: 0,
};

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function recordAppStart(): void {
  counters.starts += 1;
}

/** A start that was refused, by the machine token of the refusal. */
export function recordAppStartRefused(reason: string): void {
  bump(counters.startsRefused, reason);
}

export function recordAppEnd(reason: AppEndReason): void {
  bump(counters.ends, reason);
}

export function recordAppJoin(): void {
  counters.joins += 1;
}

/** A join refused, by the `app-error` code (`full`, `not-allowed`, `ended`, `rate-limited`). */
export function recordAppJoinRefused(code: string): void {
  bump(counters.joinsRefused, code);
}

/** A frame refused or dropped by a cap: `event-rate`, `event-size`, `state-size`, `state-rate`, `join-rate`. */
export function recordAppFrameDropped(reason: string): void {
  bump(counters.framesDropped, reason);
}

export function recordAppStateWrite(): void {
  counters.stateWrites += 1;
}

/** Patches that shared a write with an earlier one (the last value won). */
export function recordAppStateCoalesced(patches: number): void {
  counters.stateWritesCoalesced += patches;
}

export function recordAppEvent(): void {
  counters.events += 1;
}

export function appCountersSnapshot(): {
  starts: number;
  startsRefused: Record<string, number>;
  ends: Record<string, number>;
  joins: number;
  joinsRefused: Record<string, number>;
  framesDropped: Record<string, number>;
  stateWrites: number;
  stateWritesCoalesced: number;
  events: number;
} {
  return {
    starts: counters.starts,
    startsRefused: Object.fromEntries(counters.startsRefused),
    ends: Object.fromEntries(counters.ends),
    joins: counters.joins,
    joinsRefused: Object.fromEntries(counters.joinsRefused),
    framesDropped: Object.fromEntries(counters.framesDropped),
    stateWrites: counters.stateWrites,
    stateWritesCoalesced: counters.stateWritesCoalesced,
    events: counters.events,
  };
}

export function resetAppCountersForTests(): void {
  counters.starts = 0;
  counters.startsRefused.clear();
  counters.ends.clear();
  counters.joins = 0;
  counters.joinsRefused.clear();
  counters.framesDropped.clear();
  counters.stateWrites = 0;
  counters.stateWritesCoalesced = 0;
  counters.events = 0;
}

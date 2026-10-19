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

export function appCountersSnapshot(): {
  starts: number;
  startsRefused: Record<string, number>;
  ends: Record<string, number>;
} {
  return {
    starts: counters.starts,
    startsRefused: Object.fromEntries(counters.startsRefused),
    ends: Object.fromEntries(counters.ends),
  };
}

export function resetAppCountersForTests(): void {
  counters.starts = 0;
  counters.startsRefused.clear();
  counters.ends.clear();
}

/**
 * Shared helpers for spreading reconnect-triggered work across a short window
 * instead of firing it the instant every open tab notices the same signal.
 *
 * A deploy drains `/ws` sockets in batches (server/src/lib/drain.ts) or the
 * process restarts outright, so every open tab sees the same close at nearly
 * the same instant. The SFU bounces the same way. Reconnecting (or refetching)
 * right away turns that into a second, self-inflicted spike against the same
 * Postgres pool the drain exists to protect — 141 tabs pinned the pool at 70
 * connections with 79 queued on 2026-09-12. See CLAUDE.md pitfall 10/11 and
 * docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md item C7.
 *
 * Pure and framework-free on purpose: `lib/realtime.ts` is a transport and
 * must not pull React in, and this is shared with it.
 */

/** The window a first reconnect attempt is spread across after a deploy-shaped close. */
export const DRAIN_JITTER_MIN_MS = 500;
export const DRAIN_JITTER_MAX_MS = 4_000;

/** Uniform delay in [minMs, maxMs]. */
export function uniformJitterMs(minMs: number, maxMs: number): number {
  return minMs + Math.random() * (maxMs - minMs);
}

/** Uniform delay in [DRAIN_JITTER_MIN_MS, DRAIN_JITTER_MAX_MS]. */
export function drainJitterMs(): number {
  return uniformJitterMs(DRAIN_JITTER_MIN_MS, DRAIN_JITTER_MAX_MS);
}

/**
 * Whether `fetchedAt` (an epoch ms, or null/undefined for "never fetched") is
 * recent enough that a reconnect need not repeat the fetch. Used to skip a
 * bootstrap refetch when two reconnects land close together — the data is
 * already as fresh as a refetch would make it.
 */
export function isFreshEnough(
  fetchedAt: number | null | undefined,
  maxAgeMs: number,
  now = Date.now(),
): boolean {
  return fetchedAt != null && now - fetchedAt < maxAgeMs;
}

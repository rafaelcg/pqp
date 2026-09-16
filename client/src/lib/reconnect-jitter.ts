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

/**
 * The window the FIRST cold bootstrap of a fresh page load is spread across.
 *
 * A deploy or an SFU bounce closes `/ws` and the reconnect jitter above already
 * damps that. But a watch-party spike is a different herd: hundreds of people
 * F5 within the same second, and each fresh tab fires the ~11-request cold
 * bootstrap (`fetchMe`, `fetchServers`, `fetchChannels`, ICE, …) the instant it
 * mounts. Landing them all at once is what pinned the Postgres pool on
 * 2026-09-12. A small random delay on the automatic first load spreads that
 * front over a few seconds; a deliberate user retry is never delayed.
 */
export const BOOTSTRAP_JITTER_MAX_MS = 3_000;

/** Uniform delay in [0, BOOTSTRAP_JITTER_MAX_MS], for the cold bootstrap. */
export function bootstrapJitterMs(): number {
  return uniformJitterMs(0, BOOTSTRAP_JITTER_MAX_MS);
}

export const BOOTSTRAP_RETRY_BASE_MS = 1_000;
export const BOOTSTRAP_RETRY_MAX_MS = 30_000;

/**
 * Delay before an automatic bootstrap retry, full-jitter exponential backoff
 * (the AWS formula), with a floor the server can raise.
 *
 * `attempt` is 0-based and counts failed auto-retries. `retryAfterMs`, when
 * present, is the server's own `Retry-After` — the DB circuit breaker answers a
 * saturated pool with `503 database_unavailable` and `Retry-After: 5` (CLAUDE.md
 * pitfall 17). That value is a FLOOR the client must not undercut, and the herd
 * is spread ON TOP of it, so a 503 that says "come back in 5s" backs off harder
 * than a plain network drop (which starts near zero). Without a `Retry-After`
 * it is ordinary full jitter: a delay drawn uniformly from [0, cap].
 *
 * The floor itself is capped at BOOTSTRAP_RETRY_MAX_MS so a hostile or absurd
 * `Retry-After` cannot wedge the client for minutes.
 */
export function bootstrapRetryDelayMs(
  attempt: number,
  retryAfterMs?: number | null,
): number {
  const cap = Math.min(
    BOOTSTRAP_RETRY_MAX_MS,
    BOOTSTRAP_RETRY_BASE_MS * 2 ** attempt,
  );
  const jitter = Math.random() * cap;
  if (retryAfterMs != null && retryAfterMs > 0) {
    return Math.min(retryAfterMs, BOOTSTRAP_RETRY_MAX_MS) + jitter;
  }
  return jitter;
}

/**
 * Parse an HTTP `Retry-After` header into milliseconds, or null when it is
 * absent or unparseable. Accepts both forms the spec allows: a delta in whole
 * seconds (`"5"`) and an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`). A date
 * in the past clamps to 0. `now` is injectable for tests.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  now = Date.now(),
): number | null {
  if (header == null) {
    return null;
  }
  const trimmed = header.trim();
  if (trimmed === "") {
    return null;
  }
  // A bare integer number of seconds is the common case (and what our own API
  // sends). `/^\d+$/` on purpose — `Number("5s")` is NaN but `Number(" 5 ")`
  // is 5, and we do not want "5 minutes" silently read as 5ms.
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1_000;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) {
    return null;
  }
  return Math.max(0, dateMs - now);
}

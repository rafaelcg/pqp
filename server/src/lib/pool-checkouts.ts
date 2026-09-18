/**
 * How long each pooled Postgres connection has been checked out, and what it
 * was last asked to run.
 *
 * WHY THIS EXISTS. On 2026-09-17 a reconnect storm on staging (800 voice seats
 * dropping and rejoining at once) left both API processes with
 * `pool = {max:22, total:22, idle:0, busy:22, waiting:15, pressure:"saturated"}`
 * and the DB circuit breaker open, for many minutes, with two sockets left
 * connected. On the database side every one of the 45 API backends was `idle`
 * in `ClientRead`, several for over 250 seconds, the oldest 756 seconds old.
 * Postgres had finished the work and was waiting for the *next* statement; the
 * Node clients were still checked out, waiting for replies that the transport
 * under them had swallowed. The pool never recovered without a restart.
 *
 * `lib/runtime.ts` could say the pool was saturated and could not say for how
 * long any one connection had been sitting there, or on what. `busy: 22` looks
 * identical whether those are twenty-two queries that started 3 ms ago or the
 * same twenty-two that started four minutes ago and will never finish, and
 * those are opposite problems: the first is load, the second is a leak. This
 * module is the difference between the two.
 *
 * EVERYTHING HERE IS A MAP WRITE. No query, no allocation per row, one
 * `Map.set` on checkout and one `Map.delete` on release, both from listeners
 * pg-pool already emits. The map is bounded by `PG_POOL_MAX`, because a client
 * can only be checked out once at a time. Same rule as `lib/runtime.ts`: a
 * module whose whole job is to warn about pool pressure must never be able to
 * add any, and must never throw out of a pool event: a throw inside a pg
 * EventEmitter listener surfaces as an error on the pool, which is
 * observability breaking the thing it observes.
 */
import { logEvent } from "./log.js";

/**
 * The age at which a checkout is counted on the dashboard.
 *
 * Fixed, not configurable, because it is the name of the field
 * (`checkedOutOver10s`) and a threshold that moves is a metric nobody can
 * compare across two days. Ten seconds is far longer than any healthy query in
 * this codebase and far shorter than the timeout that now bounds one, so a
 * non-zero reading means something is genuinely sitting still.
 */
export const CHECKED_OUT_OVER_MS = 10_000;

/**
 * How often the sweeper looks for a checkout old enough to log.
 *
 * A per-checkout `setTimeout` would be the precise way to do this and would
 * also mean one timer created and cleared per query, roughly 110 per person
 * opening the app. One interval that walks a map of at most `PG_POOL_MAX`
 * entries costs nothing and is late by at most this much, which does not
 * matter for a diagnostic measured in tens of seconds.
 */
export const CHECKOUT_SWEEP_INTERVAL_MS = 5_000;

/**
 * Floor between two `db.pool.stuckClient` lines, whatever is stuck.
 *
 * A saturated pool has up to `PG_POOL_MAX` stuck clients at once and they all
 * cross the threshold within a few seconds of each other, so the unlimited
 * version of this log is a burst of seventy identical lines every sweep. Each
 * individual checkout is logged at most once (`warned` below) AND the whole
 * module emits at most one line per window, carrying `suppressed=` so the
 * count that did not get a line of its own is still on the record.
 */
export const STUCK_LOG_MIN_INTERVAL_MS = 30_000;

/** How much of the statement text goes into the log line. */
const QUERY_PREFIX_CHARS = 120;

interface Checkout {
  /** `Date.now()` at the pool's `acquire` event. */
  at: number;
  /** The text of the last statement issued on this client, or null. */
  query: string | null;
  /** Whether this checkout has already had its `db.pool.stuckClient` line. */
  warned: boolean;
}

/**
 * Keyed by the `PoolClient` object. A real `Map`, not a `WeakMap`, because the
 * whole point is to iterate it, and it is safe to hold these strongly because
 * every entry is deleted on the pool's own `release` or `remove` event, which
 * between them cover every way a checked-out client stops being checked out.
 */
const checkouts = new Map<object, Checkout>();

let lastStuckLogAt = 0;
let suppressedStuckLogs = 0;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Collapse whitespace and cut, so one stuck query is one greppable line. */
function queryPrefix(text: string | null): string | undefined {
  if (!text) {
    return undefined;
  }
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) {
    return undefined;
  }
  return flat.length > QUERY_PREFIX_CHARS
    ? `${flat.slice(0, QUERY_PREFIX_CHARS)}…`
    : flat;
}

/** The pool's `acquire` event: this client is now checked out. */
export function noteCheckout(client: object, now = Date.now()): void {
  try {
    checkouts.set(client, { at: now, query: null, warned: false });
  } catch {
    // Unreachable today; see the module header on never throwing out of a
    // pool event.
  }
}

/**
 * A statement was issued on a checked-out client. Overwrites rather than
 * appends: what a stuck checkout is *currently* waiting on is the useful
 * answer, and a transaction's earlier statements already returned.
 */
export function noteCheckoutQuery(client: object, text: string | null): void {
  try {
    const entry = checkouts.get(client);
    if (entry) {
      entry.query = text;
    }
  } catch {
    // See above.
  }
}

/** The pool's `release` or `remove` event: this client is free (or gone). */
export function noteRelease(client: object): void {
  try {
    checkouts.delete(client);
  } catch {
    // See above.
  }
}

export interface PoolCheckoutStats {
  /**
   * Age of the oldest connection currently checked out, in milliseconds; 0
   * when none is. Read it beside `pool.busy`: a high `busy` with a low
   * `longestCheckoutMs` is load, and a high `busy` with a
   * `longestCheckoutMs` in the minutes is the 2026-09-17 failure.
   */
  longestCheckoutMs: number;
  /** How many checkouts are older than {@link CHECKED_OUT_OVER_MS}. */
  checkedOutOver10s: number;
}

export function poolCheckoutStats(now = Date.now()): PoolCheckoutStats {
  let longest = 0;
  let over = 0;
  for (const entry of checkouts.values()) {
    const age = now - entry.at;
    if (age > longest) {
      longest = age;
    }
    if (age > CHECKED_OUT_OVER_MS) {
      over += 1;
    }
  }
  return { longestCheckoutMs: Math.max(0, longest), checkedOutOver10s: over };
}

/**
 * Log the oldest checkout past `thresholdMs`, if there is one and the rate
 * limit allows it. Exported for the test; the sweeper below is what calls it
 * in a live process.
 *
 * Returns the fields it logged, or null, so a test can assert on them without
 * parsing console output.
 */
export function sweepStuckCheckouts(
  thresholdMs: number,
  now = Date.now(),
): Record<string, unknown> | null {
  let worst: Checkout | null = null;
  for (const entry of checkouts.values()) {
    if (entry.warned || now - entry.at <= thresholdMs) {
      continue;
    }
    if (!worst || entry.at < worst.at) {
      worst = entry;
    }
  }
  if (!worst) {
    return null;
  }
  // Marked regardless of whether this one gets a line: "logged at most once"
  // has to mean once, or the suppressed backlog never drains.
  worst.warned = true;
  if (now - lastStuckLogAt < STUCK_LOG_MIN_INTERVAL_MS) {
    suppressedStuckLogs += 1;
    return null;
  }
  lastStuckLogAt = now;
  const fields: Record<string, unknown> = {
    ageMs: now - worst.at,
    thresholdMs,
    checkedOut: checkouts.size,
    query: queryPrefix(worst.query),
  };
  if (suppressedStuckLogs > 0) {
    fields.suppressed = suppressedStuckLogs;
    suppressedStuckLogs = 0;
  }
  logEvent("db.pool.stuckClient", fields);
  return fields;
}

/**
 * Start the sweeper. Idempotent; returns the stopper. Unref'd, same as every
 * other background timer in this process, because a diagnostic must never be the
 * reason `node` refuses to exit.
 *
 * `threshold` is read on every tick rather than captured, so a test (and a
 * future runtime knob) can move it without restarting the timer.
 */
export function startStuckCheckoutSweeper(threshold: () => number): () => void {
  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      try {
        sweepStuckCheckouts(threshold());
      } catch {
        // A sweeper must never be the reason anything else throws.
      }
    }, CHECKOUT_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }
  return stopStuckCheckoutSweeper;
}

export function stopStuckCheckoutSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/** Test/teardown hook: forget every checkout and every rate-limit clock. */
export function resetPoolCheckoutsForTests(): void {
  stopStuckCheckoutSweeper();
  checkouts.clear();
  lastStuckLogAt = 0;
  suppressedStuckLogs = 0;
}

/** Test hook: how many clients this module thinks are checked out. */
export function checkedOutCountForTests(): number {
  return checkouts.size;
}

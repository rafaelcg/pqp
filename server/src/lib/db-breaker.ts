/**
 * A small circuit breaker over the Postgres pool, born from A3.1 of
 * `docs/plans/ALWAYS_ON.md` and the 2026-09-12 collapse it describes: the
 * pool saturated, `/health` (which ran `SELECT 1`) failed with it, Fly
 * stopped routing to the only machine, and WebSockets, the HLS playlist
 * proxy and cached reads all went dark even though none of them needed the
 * database at that instant.
 *
 * `/health` no longer touches Postgres at all (see `lib/drain.ts` and
 * `index.ts`) — that half of the fix is "stop asking a question the router
 * doesn't need answered". This is the other half: when Postgres genuinely
 * is unhealthy, say so quickly and let every DB-dependent caller decide what
 * "quickly" should look like, instead of letting each one discover it by
 * queueing on the pool for `connectionTimeoutMillis` (30s) one request at a
 * time.
 *
 * THE SIGNAL. Two independent reasons to trip, either one enough:
 *  - the pool's queue (`waiting`) stays above `queueThreshold` for
 *    `graceMs` straight. A queue that appears for a tick is a burst the pool
 *    absorbed; a queue that never drains is a pool that is not serving. Same
 *    reasoning `services/ready.ts`'s `queuedSince` clock uses, independently,
 *    because this breaker must trip even when nobody is polling `/ready`.
 *  - a `SELECT 1` probe run on its own timer (`startDbBreakerSampler`,
 *    `DB_BREAKER_PROBE_INTERVAL_MS`) fails or exceeds `latencyBudgetMs`, for
 *    `graceMs` straight. One slow query is noise; a sustained one is the
 *    database.
 *
 * THE HYSTERESIS. `closed -> open` needs `graceMs` of sustained badness, not
 * one bad tick, so a single slow query never trips it. Once open, the
 * breaker holds itself shut for `openCooldownMs` and probes nothing —
 * hammering a database that is already on its knees with more connection
 * attempts is the opposite of a circuit breaker's job. After the cooldown it
 * moves to `half-open` and allows probing again; `halfOpenSuccesses`
 * consecutive good probes close it, and a single bad one (or a queue that is
 * still over threshold) sends it straight back to `open` for another full
 * cooldown. Closing on the first good probe would flap on a database that is
 * recovering but not yet stable.
 *
 * WHAT "OPEN" DOES, ELSEWHERE. This module only decides the state. `db.ts`
 * wraps the pool's own `query` so a call made while open rejects at once
 * with `DatabaseUnavailableError` instead of joining the pool's queue —
 * that is what turns "the breaker is open" into "routes answer in
 * milliseconds, not 30 seconds".
 */

export type DbBreakerState = "closed" | "open" | "half-open";

/** Pool `waiting` above this counts as queue pressure. */
export const DB_BREAKER_QUEUE_THRESHOLD = 8;

/** How long a condition (queue pressure, or a failing probe) must persist,
 *  unbroken, before it trips the breaker. Also the "N seconds" in "pool queue
 *  depth above a threshold for N seconds" from A3.1. */
export const DB_BREAKER_GRACE_MS = 5_000;

/** A `SELECT 1` slower than this counts as a failure, same as a rejection. */
export const DB_BREAKER_LATENCY_BUDGET_MS = 750;

/** How often the internal prober runs while the breaker can still see the
 *  database (closed or half-open; a fully open breaker probes nothing). */
export const DB_BREAKER_PROBE_INTERVAL_MS = 2_000;

/** How long the breaker stays open before it allows one half-open trial. */
export const DB_BREAKER_OPEN_COOLDOWN_MS = 5_000;

/** Consecutive good half-open probes required to fully close. */
export const DB_BREAKER_HALF_OPEN_SUCCESSES = 2;

export interface DbBreakerPoolStats {
  waiting: number;
}

export interface DbBreakerOptions {
  /** Resolves once Postgres answers; rejects or hangs when it does not. */
  probe: () => Promise<unknown>;
  /** Null when there is no pool yet — reported as no queue pressure. */
  poolStats: () => DbBreakerPoolStats | null;
  now?: () => number;
  queueThreshold?: number;
  graceMs?: number;
  latencyBudgetMs?: number;
  openCooldownMs?: number;
  halfOpenSuccesses?: number;
  /** Fires once per transition, after the new state is already in effect. */
  onStateChange?: (next: DbBreakerState, previous: DbBreakerState) => void;
}

export interface DbBreakerStats {
  state: DbBreakerState;
  /** How many times the breaker has opened since boot (or the last reset). */
  opened: number;
  /** How many queries `db.ts` fast-rejected while the breaker was open. */
  rejected: number;
}

export interface DbBreaker {
  state(): DbBreakerState;
  isOpen(): boolean;
  /** One sampling interval's worth of work: sample the pool, probe Postgres
   *  when the state calls for it, and step the state machine. Call this on a
   *  timer in production (`startDbBreakerSampler`); tests call it directly
   *  against an injected clock and probe. */
  tick(): Promise<void>;
  /** `db.ts` calls this once per query it fast-rejects. */
  noteRejected(): void;
  stats(): DbBreakerStats;
  reset(): void;
  /**
   * Test-only: jump straight to a state, bypassing every trigger and
   * hysteresis rule. HTTP-level tests (`api/db-breaker-http.test.ts`) use
   * this to prove a DB-dependent route answers 503 fast without needing a
   * real failing probe and a real grace window to elapse first.
   */
  forceStateForTests(next: DbBreakerState): void;
}

/**
 * Race a probe against a timeout, same shape as `services/ready.ts`'s
 * `timed`: the loser is abandoned and its rejection swallowed.
 */
function probeWithinBudget(
  probe: () => Promise<unknown>,
  budgetMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), budgetMs);
    timer.unref?.();
  });
  const attempt = Promise.resolve()
    .then(probe)
    .then(() => true)
    .catch(() => false);
  return Promise.race([attempt, timeout]).finally(() => clearTimeout(timer));
}

export function createDbBreaker(options: DbBreakerOptions): DbBreaker {
  const now = options.now ?? Date.now;
  const queueThreshold = options.queueThreshold ?? DB_BREAKER_QUEUE_THRESHOLD;
  const graceMs = options.graceMs ?? DB_BREAKER_GRACE_MS;
  const latencyBudgetMs = options.latencyBudgetMs ?? DB_BREAKER_LATENCY_BUDGET_MS;
  const openCooldownMs = options.openCooldownMs ?? DB_BREAKER_OPEN_COOLDOWN_MS;
  const halfOpenSuccesses =
    options.halfOpenSuccesses ?? DB_BREAKER_HALF_OPEN_SUCCESSES;

  let state: DbBreakerState = "closed";
  /** When the current unbroken run of queue pressure began; null while clear. */
  let queueBadSince: number | null = null;
  /** When the current unbroken run of failing probes began; null while clear. */
  let probeBadSince: number | null = null;
  let openedAt: number | null = null;
  let halfOpenGoodStreak = 0;
  let openedCount = 0;
  let rejectedCount = 0;

  function setState(next: DbBreakerState): void {
    if (next === state) {
      return;
    }
    const previous = state;
    state = next;
    if (next === "open") {
      openedAt = now();
      openedCount += 1;
      halfOpenGoodStreak = 0;
    }
    options.onStateChange?.(next, previous);
  }

  return {
    state: () => state,
    isOpen: () => state === "open",

    async tick(): Promise<void> {
      const at = now();
      const stats = options.poolStats();
      // Instantaneous, for the half-open trial below — a trial gets one
      // tick to prove itself, so there is no window over which to demand
      // "sustained" pressure the way the closed state does.
      const queueOverNow = stats !== null && stats.waiting > queueThreshold;
      if (queueOverNow) {
        queueBadSince ??= at;
      } else {
        queueBadSince = null;
      }
      if (state === "open") {
        // Hold the cooldown, and probe nothing: a database already on its
        // knees does not need another connection attempt from this process
        // every couple of seconds. Only the clock decides when to try again.
        if (openedAt === null || at - openedAt < openCooldownMs) {
          return;
        }
        // Cooldown elapsed: move to half-open and run the trial probe in
        // this SAME tick, rather than waiting a further interval to do
        // nothing but change a label. Falls through to the probe below.
        setState("half-open");
      }

      // Sustained, for the closed state's own threshold: a queue that
      // appears for one tick is a burst the pool absorbed, not a trip.
      const queueUnhealthy =
        queueBadSince !== null && at - queueBadSince >= graceMs;

      const ok = await probeWithinBudget(options.probe, latencyBudgetMs);
      if (!ok) {
        probeBadSince ??= at;
      } else {
        probeBadSince = null;
      }
      const probeUnhealthy =
        probeBadSince !== null && at - probeBadSince >= graceMs;

      if (state === "closed") {
        if (queueUnhealthy || probeUnhealthy) {
          setState("open");
        }
        return;
      }

      // state === "half-open": a single bad probe or a queue that is over
      // threshold RIGHT NOW sends it straight back to a full cooldown, not a
      // partial one — recovering "sort of" is not recovered, and a trial
      // gets no grace window to decide in.
      if (!ok || queueOverNow) {
        setState("open");
        return;
      }
      halfOpenGoodStreak += 1;
      if (halfOpenGoodStreak >= halfOpenSuccesses) {
        setState("closed");
        queueBadSince = null;
        probeBadSince = null;
      }
    },

    noteRejected(): void {
      rejectedCount += 1;
    },

    stats: () => ({ state, opened: openedCount, rejected: rejectedCount }),

    forceStateForTests(next: DbBreakerState): void {
      setState(next);
    },

    reset(): void {
      state = "closed";
      queueBadSince = null;
      probeBadSince = null;
      openedAt = null;
      halfOpenGoodStreak = 0;
      openedCount = 0;
      rejectedCount = 0;
    },
  };
}

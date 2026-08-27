/**
 * Live process pressure: open WebSockets and the Postgres connection pool.
 *
 * WHY THIS EXISTS. The operator dashboard could say how many people signed up
 * and how many messages they sent, and nothing at all about whether the process
 * serving them was close to a wall. The two numbers that actually predict
 * failure here are the socket count (every signed-in client holds one open for
 * its whole session) and the pool queue — and `waitingCount` is the earliest
 * honest warning the system can give, because it goes above zero while
 * everything still looks fine from the outside: no error, no slow page, just
 * requests standing in line for a connection.
 *
 * EVERYTHING HERE IS FREE. No query, no timer, no allocation per request. The
 * pool counters are plain properties (`_pendingQueue.length` and friends) and
 * `wss.clients.size` is a Set's size. That is deliberate: a block whose whole
 * job is to warn about pool pressure must not be able to *add* any.
 *
 * WIRING. This module is deliberately at the bottom of the import graph — it
 * imports nothing from `db.ts` or `index.ts`, because both of those import it.
 * The owners of the two live values register a getter:
 *   - `db.ts` calls `registerPoolStats` when it creates the pool;
 *   - `index.ts` calls `registerSocketCount` when it creates the WebSocket
 *     server.
 * Nothing registered means zeros, which is the truth for a process that has
 * opened neither (a test, a CLI import).
 */

export interface PoolStats {
  /** `PG_POOL_MAX`. One process, so this is the app's whole DB footprint. */
  max: number;
  /** Connections the pool owns right now: idle plus checked out. */
  total: number;
  /** Owned and free. */
  idle: number;
  /**
   * Requests in the pool's pending queue **right now**.
   *
   * READ THIS BEFORE TREATING IT AS "THE POOL IS EXHAUSTED". Checked against
   * pg-pool's `connect()`: a request is queued when the pool is full **or when
   * an idle client exists**, because the handover to an idle client is deferred
   * to `process.nextTick`. So a burst of concurrent queries in a single tick
   * registers here even with connections to spare, and does again on every cold
   * start while the pool is still opening its first connections.
   *
   * It is therefore a measure of *instantaneous concurrency exceeding what
   * could be handed over synchronously* — which is still the earliest warning
   * available and still means the request did not get a connection at once. The
   * unambiguous wall is this **together with** `total >= max`, which is what
   * `poolPressure` reports as `saturated`.
   */
  waiting: number;
}

/**
 * Three states, not a percentage, because the interesting distinction is not
 * "how full" but "how close to the wall".
 */
export type PoolPressure = "ok" | "tight" | "saturated";

/**
 * The share of `max` at which the pool is called `tight`.
 *
 * A knife-edge at `busy === max` would be true for microseconds at a time and
 * would essentially never be observed by a 30-second poll. 80% is the point at
 * which one more concurrent request starts queueing for real, which is the
 * thing worth seeing *before* it happens.
 */
const TIGHT_FRACTION = 0.8;

/**
 * Pure. The one piece of judgement in this file, so it is the piece that is
 * tested.
 *
 * `saturated` deliberately requires BOTH a queue and a full pool. Reporting a
 * non-empty queue on its own as saturation would paint the dashboard red on
 * every deploy and on every burst the pool absorbed without trouble — see the
 * note on `waiting` — and a red that appears when nothing is wrong is the same
 * failure as an alert that cries wolf.
 */
export function poolPressure(stats: PoolStats): PoolPressure {
  if (stats.max <= 0) {
    // No pool has been opened in this process; there is nothing to be tight.
    return "ok";
  }
  const busy = Math.max(0, stats.total - stats.idle);
  if (stats.waiting > 0 && stats.total >= stats.max) {
    // Queued, with nothing left to open. This is the wall.
    return "saturated";
  }
  // Either running hot, or a queue the pool still has room to absorb.
  return stats.waiting > 0 || busy >= stats.max * TIGHT_FRACTION ? "tight" : "ok";
}

export interface RuntimeMetrics {
  /**
   * ISO, and its own field rather than the payload's `generatedAt` on purpose:
   * this block is sampled per request and is NOT part of the 30-second metrics
   * cache. See `getAdminMetrics`.
   */
  sampledAt: string;
  /** WebSocket connections open right now. */
  sockets: number;
  /**
   * Highest concurrent sockets since `peakTrackedSince`.
   *
   * Exact, not sampled: a peak is always reached immediately after a socket
   * opens, and `index.ts` takes a sample on every connection, so no maximum can
   * happen between two observations.
   */
  peakSockets: number;
  pool: PoolStats & {
    /** `total - idle`: connections checked out right now. */
    busy: number;
    pressure: PoolPressure;
  };
  /**
   * Highest `waiting` since `peakTrackedSince`: the deepest queue seen.
   *
   * Observed at checkout (the pool's `acquire` event), so it can understate the
   * true instantaneous peak by however many requests queued after the last
   * dequeue. It cannot overstate it. Without it a 30-second poll would miss a
   * deploy stampede entirely: the queue forms and drains between two reads.
   *
   * Read it **with** `peakPoolBusy`, not on its own — see the note on `waiting`
   * for why a queue alone is not proof of exhaustion.
   */
  peakPoolWaiting: number;
  /**
   * Highest `busy` since `peakTrackedSince`, observed the same way.
   *
   * This is the unambiguous one: `peakPoolBusy === pool.max` means every
   * connection the process is allowed to hold was checked out at the same
   * moment, so the ceiling — not the database, not the network — was the
   * constraint.
   */
  peakPoolBusy: number;
  /** ISO. Process start or the last São Paulo midnight, whichever is later. */
  peakTrackedSince: string;
}

// -------------------------------------------------------------- registration

let readSocketCount: (() => number) | null = null;
let readPoolStats: (() => PoolStats) | null = null;

/** Called once by `index.ts` with `() => wss.clients.size`. */
export function registerSocketCount(read: () => number): void {
  readSocketCount = read;
}

/** Called by `db.ts` when it creates the pool. */
export function registerPoolStats(read: () => PoolStats): void {
  readPoolStats = read;
}

/** Called by `closePool`, so a torn-down pool is never read from. */
export function clearPoolStats(): void {
  readPoolStats = null;
}

// --------------------------------------------------------------------- peaks
//
// Same treatment as the voice peak in ws/voice.ts, for the same reason and with
// the same honesty problem in mind: a high-water mark with no start date reads
// as "now" forever. It resets on deploy (the process restarts) and at São Paulo
// midnight, and the payload says which by carrying `peakTrackedSince`.

let peakSockets = 0;
let peakPoolWaiting = 0;
let peakPoolBusy = 0;
let peakDay = "";
let peakTrackedSince = new Date().toISOString();

const SAO_PAULO_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function rollPeakDay(): void {
  const today = SAO_PAULO_DAY.format(new Date());
  if (today !== peakDay) {
    peakDay = today;
    peakSockets = 0;
    peakPoolWaiting = 0;
    peakPoolBusy = 0;
    peakTrackedSince = new Date().toISOString();
  }
}

function emptyStats(): PoolStats {
  return { max: 0, total: 0, idle: 0, waiting: 0 };
}

/**
 * Both getters, defended. Nothing in the registered implementations can throw
 * today; the guard is here because this block is decoration on an endpoint that
 * has a job, and a metrics read must never 500 over a counter.
 */
function safeStats(): PoolStats {
  try {
    return readPoolStats?.() ?? emptyStats();
  } catch {
    return emptyStats();
  }
}

function safeSocketCount(): number {
  try {
    return readSocketCount?.() ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Fold the current values into the high-water marks.
 *
 * Called from three places, all of them already-existing loops or events:
 * every WebSocket connection, every heartbeat tick, and every pool checkout.
 * The last one is the hot one — roughly 110 per person opening the app — and it
 * is four number comparisons, which is the price of seeing a queue that forms
 * and drains inside a single poll interval.
 *
 * It cannot throw (see `safeStats` / `safeSocketCount`), which matters most for
 * the checkout hook: a throw inside a pg EventEmitter listener surfaces as an
 * error on the pool rather than here, so an unguarded counter could break the
 * very thing it is counting.
 */
export function noteRuntimeSample(): void {
  rollPeakDay();
  const sockets = safeSocketCount();
  if (sockets > peakSockets) {
    peakSockets = sockets;
  }
  const stats = safeStats();
  if (stats.waiting > peakPoolWaiting) {
    peakPoolWaiting = stats.waiting;
  }
  const busy = stats.total - stats.idle;
  if (busy > peakPoolBusy) {
    peakPoolBusy = busy;
  }
}

/** The live block. Reads properties; never queries anything. */
export function runtimeSnapshot(): RuntimeMetrics {
  noteRuntimeSample();
  const stats = safeStats();
  return {
    sampledAt: new Date().toISOString(),
    sockets: safeSocketCount(),
    peakSockets,
    pool: {
      ...stats,
      busy: Math.max(0, stats.total - stats.idle),
      pressure: poolPressure(stats),
    },
    peakPoolWaiting,
    peakPoolBusy,
    peakTrackedSince,
  };
}

/** Test hook: forget both registrations and every peak. */
export function resetRuntimeMetrics(): void {
  readSocketCount = null;
  readPoolStats = null;
  peakSockets = 0;
  peakPoolWaiting = 0;
  peakPoolBusy = 0;
  peakDay = "";
  peakTrackedSince = new Date().toISOString();
}

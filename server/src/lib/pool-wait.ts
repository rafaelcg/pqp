/**
 * How long callers WAITED for a pooled Postgres connection, and the pool's
 * high-water marks per minute.
 *
 * WHY THIS EXISTS. The dashboard's pool card read `peakPoolBusy` and
 * `peakPoolWaiting`, which are high-water marks since process start (or São
 * Paulo midnight). Every rolling deploy produces a burst on the container
 * that takes the other one's sockets, and a burst that touches 22 of 22 for
 * a few milliseconds and drains at once read exactly like one that held
 * people in line for seconds: "o pool encostou no teto hoje", in yellow, for
 * the rest of the day. Grafana sampled `/ready` once a minute and never saw
 * more than 3 in use, so the two sources disagreed and neither could say
 * whether anybody had actually waited.
 *
 * The question that matters is "did a request wait for a connection, and for
 * how long". So this measures exactly that, per checkout, from the moment a
 * caller asked the pool (`pool.connect`, which `pool.query` also goes through)
 * to the moment it had a client, including opening a new connection when the
 * pool had room. Kept as:
 *
 *  - a fixed-bucket histogram per minute for the last hour, so p50 / p95 and
 *    "how many waited more than a second" come from the same counts;
 *  - per minute, the highest `busy` and `waiting` seen at any checkout, so a
 *    peak has a time attached and ages out after an hour instead of sitting
 *    on the card until midnight.
 *
 * Same rules as `lib/runtime.ts`: no query, no timer, a handful of array
 * writes per checkout, and nothing here may throw into a pool callback.
 */

/** Upper bounds, in ms, of the histogram buckets. The last one is open. */
export const WAIT_BUCKETS_MS = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000,
] as const;

/** How many minutes of history are kept. */
export const POOL_MINUTES_KEPT = 60;

/**
 * A wait at least this long is the one a person could feel: a page that hung,
 * a frame that came late. The dashboard turns yellow on these, not on a
 * high-water mark.
 */
export const FELT_WAIT_MS = 1_000;

interface MinuteBucket {
  /** Epoch minute (`Math.floor(ms / 60_000)`). */
  minute: number;
  checkouts: number;
  /** One count per `WAIT_BUCKETS_MS` entry, plus the open bucket. */
  counts: number[];
  maxWaitMs: number;
  totalWaitMs: number;
  maxBusy: number;
  maxWaiting: number;
}

const minutes: MinuteBucket[] = [];

function emptyMinute(minute: number): MinuteBucket {
  return {
    minute,
    checkouts: 0,
    counts: new Array(WAIT_BUCKETS_MS.length + 1).fill(0),
    maxWaitMs: 0,
    totalWaitMs: 0,
    maxBusy: 0,
    maxWaiting: 0,
  };
}

function currentMinute(nowMs: number): MinuteBucket {
  const minute = Math.floor(nowMs / 60_000);
  const last = minutes[minutes.length - 1];
  if (last && last.minute === minute) {
    return last;
  }
  const fresh = emptyMinute(minute);
  minutes.push(fresh);
  // Drop whatever fell out of the hour, gaps included.
  while (minutes.length > 0 && minutes[0]!.minute <= minute - POOL_MINUTES_KEPT) {
    minutes.shift();
  }
  return fresh;
}

function bucketIndex(ms: number): number {
  for (let i = 0; i < WAIT_BUCKETS_MS.length; i += 1) {
    if (ms <= WAIT_BUCKETS_MS[i]!) {
      return i;
    }
  }
  return WAIT_BUCKETS_MS.length;
}

/** One checkout finished waiting `waitMs`. */
export function notePoolWait(waitMs: number, nowMs = Date.now()): void {
  try {
    const ms = Math.max(0, waitMs);
    const bucket = currentMinute(nowMs);
    bucket.checkouts += 1;
    bucket.counts[bucketIndex(ms)]! += 1;
    bucket.totalWaitMs += ms;
    if (ms > bucket.maxWaitMs) {
      bucket.maxWaitMs = ms;
    }
  } catch {
    // Never into a pool callback.
  }
}

/** The pool's occupancy at a checkout, for this minute's high-water marks. */
export function notePoolOccupancy(busy: number, waiting: number, nowMs = Date.now()): void {
  try {
    const bucket = currentMinute(nowMs);
    if (busy > bucket.maxBusy) {
      bucket.maxBusy = busy;
    }
    if (waiting > bucket.maxWaiting) {
      bucket.maxWaiting = waiting;
    }
  } catch {
    // See above.
  }
}

export interface PoolWaitWindow {
  /** Minutes this window covers (fewer when the process is younger). */
  minutes: number;
  checkouts: number;
  /** Upper bound of the bucket the percentile falls in; 0 with no checkouts. */
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
  /** Checkouts that waited at least `FELT_WAIT_MS`. */
  waitedOver1s: number;
  maxBusy: number;
  maxWaiting: number;
}

export interface PoolWaitSnapshot {
  feltWaitMs: number;
  lastMinute: PoolWaitWindow;
  last5Minutes: PoolWaitWindow;
  lastHour: PoolWaitWindow;
  /**
   * Per minute, oldest first, only minutes that had a checkout: the peak with
   * a time attached. `at` is ISO for the start of the minute.
   */
  perMinute: {
    at: string;
    checkouts: number;
    maxBusy: number;
    maxWaiting: number;
    maxWaitMs: number;
    p95Ms: number;
    waitedOver1s: number;
  }[];
}

function percentileFromCounts(counts: readonly number[], total: number, p: number): number {
  if (total === 0) {
    return 0;
  }
  const rank = Math.ceil((p / 100) * total);
  let seen = 0;
  for (let i = 0; i < counts.length; i += 1) {
    seen += counts[i]!;
    if (seen >= rank) {
      return i < WAIT_BUCKETS_MS.length ? WAIT_BUCKETS_MS[i]! : Infinity;
    }
  }
  return Infinity;
}

function overThreshold(counts: readonly number[]): number {
  // Buckets whose LOWER bound is at least FELT_WAIT_MS: everything above the
  // bucket ending at FELT_WAIT_MS.
  const firstAbove = WAIT_BUCKETS_MS.findIndex((bound) => bound >= FELT_WAIT_MS) + 1;
  let total = 0;
  for (let i = firstAbove; i < counts.length; i += 1) {
    total += counts[i]!;
  }
  return total;
}

function summarise(selected: readonly MinuteBucket[], span: number): PoolWaitWindow {
  const counts = new Array(WAIT_BUCKETS_MS.length + 1).fill(0) as number[];
  let checkouts = 0;
  let maxMs = 0;
  let totalMs = 0;
  let maxBusy = 0;
  let maxWaiting = 0;
  for (const bucket of selected) {
    checkouts += bucket.checkouts;
    totalMs += bucket.totalWaitMs;
    maxMs = Math.max(maxMs, bucket.maxWaitMs);
    maxBusy = Math.max(maxBusy, bucket.maxBusy);
    maxWaiting = Math.max(maxWaiting, bucket.maxWaiting);
    for (let i = 0; i < counts.length; i += 1) {
      counts[i]! += bucket.counts[i]!;
    }
  }
  // A percentile is its bucket's upper bound, which can be above the largest
  // wait actually seen (and the open bucket has no bound at all): never
  // report more than the true max, rounded up to a whole millisecond.
  const ceilingMs = Math.max(1, Math.round(maxMs));
  const clamp = (value: number) =>
    checkouts === 0 ? 0 : Number.isFinite(value) ? Math.min(value, ceilingMs) : ceilingMs;
  return {
    minutes: span,
    checkouts,
    p50Ms: clamp(percentileFromCounts(counts, checkouts, 50)),
    p95Ms: clamp(percentileFromCounts(counts, checkouts, 95)),
    p99Ms: clamp(percentileFromCounts(counts, checkouts, 99)),
    maxMs: Math.round(maxMs),
    meanMs: checkouts > 0 ? Math.round((totalMs / checkouts) * 10) / 10 : 0,
    waitedOver1s: overThreshold(counts),
    maxBusy,
    maxWaiting,
  };
}

export function poolWaitSnapshot(nowMs = Date.now()): PoolWaitSnapshot {
  const minute = Math.floor(nowMs / 60_000);
  const within = (span: number) =>
    minutes.filter((bucket) => bucket.minute > minute - span);
  return {
    feltWaitMs: FELT_WAIT_MS,
    lastMinute: summarise(within(1), 1),
    last5Minutes: summarise(within(5), 5),
    lastHour: summarise(within(POOL_MINUTES_KEPT), POOL_MINUTES_KEPT),
    perMinute: within(POOL_MINUTES_KEPT)
      .filter((bucket) => bucket.checkouts > 0 || bucket.maxBusy > 0)
      .map((bucket) => {
        const one = summarise([bucket], 1);
        return {
          at: new Date(bucket.minute * 60_000).toISOString(),
          checkouts: bucket.checkouts,
          maxBusy: bucket.maxBusy,
          maxWaiting: bucket.maxWaiting,
          maxWaitMs: Math.round(bucket.maxWaitMs),
          p95Ms: one.p95Ms,
          waitedOver1s: one.waitedOver1s,
        };
      }),
  };
}

/** Test hook. */
export function resetPoolWaitForTests(): void {
  minutes.length = 0;
}

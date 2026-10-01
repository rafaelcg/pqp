/**
 * Bounded concurrency with a FIFO queue, for work that arrives as a herd.
 *
 * WHY THIS EXISTS. A rolling deploy drains one API container's sockets into
 * its sibling. Every one of them re-authenticates within a few seconds, and
 * each `auth` fans out into Postgres reads (the voice catch-up alone ran one
 * access check per occupied room in the cluster, all at once, per socket).
 * The pg pool is the only queue those reads had, so a herd showed up there:
 * 22 of 22 connections out and 161 callers waiting, on a box at 3% CPU. A
 * queue in the pool is the wrong place for it: it is shared with everything
 * else the process does (HTTP, voice writes, the HLS liveness check), and
 * pg-pool cannot tell a reconnect's catch-up from a chat send.
 *
 * So the herd waits HERE instead, before it takes a connection: at most
 * `concurrency` holders at a time, the rest in arrival order. Nothing that is
 * already connected goes through a gate (pings, chat, voice frames of an
 * established socket), so the queue can only ever delay a socket's first
 * moments, never someone in a call.
 *
 * FAIL-OPEN, ON PURPOSE. A waiter that has been queued for `maxWaitMs` is let
 * through over the limit rather than refused. The gate exists to shape a
 * burst, and the WebSocket auth timer (10 s) is still running while a socket
 * waits: a gate that could hold someone past it would turn backpressure into
 * a 4401 "Auth timeout", which blames a credential for a queue.
 */

export interface AdmissionStats {
  /** Holders right now. */
  inFlight: number;
  /** Waiting right now. */
  queued: number;
  /** Highest `queued` since boot. */
  peakQueued: number;
  /** Cumulative since boot. */
  admitted: number;
  /** Admitted without waiting at all. */
  admittedImmediately: number;
  /** Let through over the limit because they waited `maxWaitMs`. */
  overflowed: number;
  /** Longest wait any one holder had, since boot. */
  maxWaitMs: number;
  /** p50 / p95 of the last {@link WAIT_SAMPLE_SIZE} waits that were not zero. */
  waitP50Ms: number;
  waitP95Ms: number;
  concurrency: number;
}

export interface AdmissionGate {
  /**
   * Run `work` once a slot is free (or `maxWaitMs` has passed). The slot is
   * given back however `work` ends.
   */
  run<T>(work: () => Promise<T>): Promise<T>;
  stats(): AdmissionStats;
}

export interface AdmissionOptions {
  concurrency: number;
  maxWaitMs: number;
  /** When false, `run` calls `work` at once and counts nothing. Read per call. */
  enabled?: () => boolean;
  now?: () => number;
}

/** How many recent non-zero waits the percentiles are computed over. */
export const WAIT_SAMPLE_SIZE = 512;

interface Waiter {
  enqueuedAt: number;
  release: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

export function createAdmissionGate(options: AdmissionOptions): AdmissionGate {
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  const maxWaitMs = Math.max(0, options.maxWaitMs);
  const now = options.now ?? Date.now;
  const enabled = options.enabled ?? (() => true);

  let inFlight = 0;
  const queue: Waiter[] = [];
  let peakQueued = 0;
  let admitted = 0;
  let admittedImmediately = 0;
  let overflowed = 0;
  let maxWait = 0;
  const waits: number[] = [];

  const noteWait = (ms: number) => {
    if (ms > maxWait) {
      maxWait = ms;
    }
    if (ms > 0) {
      waits.push(ms);
      if (waits.length > WAIT_SAMPLE_SIZE) {
        waits.shift();
      }
    }
  };

  /** Hand free slots to the head of the queue, oldest first. */
  const pump = () => {
    while (inFlight < concurrency && queue.length > 0) {
      const next = queue.shift()!;
      if (next.done) {
        continue;
      }
      next.done = true;
      if (next.timer) {
        clearTimeout(next.timer);
      }
      inFlight += 1;
      noteWait(now() - next.enqueuedAt);
      next.release();
    }
  };

  const acquire = (): Promise<void> => {
    admitted += 1;
    if (inFlight < concurrency && queue.length === 0) {
      inFlight += 1;
      admittedImmediately += 1;
      noteWait(0);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const waiter: Waiter = {
        enqueuedAt: now(),
        release: resolve,
        timer: null,
        done: false,
      };
      if (maxWaitMs > 0) {
        waiter.timer = setTimeout(() => {
          if (waiter.done) {
            return;
          }
          // Over the limit, on purpose: see the header on failing open.
          waiter.done = true;
          const index = queue.indexOf(waiter);
          if (index >= 0) {
            queue.splice(index, 1);
          }
          inFlight += 1;
          overflowed += 1;
          noteWait(now() - waiter.enqueuedAt);
          resolve();
        }, maxWaitMs);
        waiter.timer.unref?.();
      }
      queue.push(waiter);
      if (queue.length > peakQueued) {
        peakQueued = queue.length;
      }
    });
  };

  const releaseSlot = () => {
    inFlight = Math.max(0, inFlight - 1);
    pump();
  };

  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      if (!enabled()) {
        return work();
      }
      await acquire();
      try {
        return await work();
      } finally {
        releaseSlot();
      }
    },
    stats(): AdmissionStats {
      const sorted = [...waits].sort((a, b) => a - b);
      return {
        inFlight,
        queued: queue.length,
        peakQueued,
        admitted,
        admittedImmediately,
        overflowed,
        maxWaitMs: maxWait,
        waitP50Ms: percentile(sorted, 50),
        waitP95Ms: percentile(sorted, 95),
        concurrency,
      };
    },
  };
}

/**
 * `Promise.all(items.map(fn))`, at most `limit` at a time, results in input
 * order. For a fan-out whose width is a property of the data (one query per
 * occupied room), where `Promise.all` lets one caller take most of the pool.
 *
 * A `limit` that is not a positive finite number means unbounded (one worker
 * per item), so `0` as a rollback switch reads as "the old `Promise.all`" and
 * never as "one at a time". On the first rejection no further item is
 * started, the ones already running are waited for, and then the first error
 * is thrown: a caller that retries never overlaps the call it is retrying.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown = null;
  const worker = async () => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) {
        return;
      }
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        return;
      }
    }
  };
  const bounded = Number.isFinite(limit) && limit >= 1;
  const workers = Math.max(1, bounded ? Math.min(Math.floor(limit), items.length) : items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (failed) {
    throw firstError;
  }
  return results;
}

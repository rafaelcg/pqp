import { monitorEventLoopDelay } from "node:perf_hooks";

/**
 * HOW LATE THIS PROCESS IS TO ITS OWN TIMERS, OVER THE LAST MINUTE.
 *
 * WHY THIS EXISTS. The API is one Node thread per replica. When something in
 * it holds the thread (a big JSON.stringify, a roster fan-out, a synchronous
 * loop in a handler) every socket, every HTTP request and every heartbeat on
 * that replica waits, while the box's CPU still reads 20 percent because the
 * other three cores are idle. The pool and the host CPU were the only proxies
 * for that, and neither moves when the loop is the bottleneck (capacity
 * review 2026-10-22, section G, item 2). This is the direct reading.
 *
 * HOW. `perf_hooks.monitorEventLoopDelay` runs a libuv timer on its own and
 * records how late each tick fired, in a histogram, with no per-request cost.
 * The histogram has no notion of "the last minute", so a timer folds it into
 * a ring of short slices and resets it, and a snapshot reads the ring plus the
 * slice in progress.
 *
 * TWO HONEST APPROXIMATIONS, both on the high side so a reading never hides
 * trouble:
 *  - `p99Ms` is the worst slice's p99, not the p99 of the whole minute
 *    (percentiles of slices cannot be merged exactly). With 5-second slices it
 *    can read higher than the true minute p99 and never lower than its worst
 *    slice, which is the number a "the loop stalled" alert cares about.
 *  - `p50Ms` is the median of the slices' medians.
 *
 * THE RESOLUTION IS SUBTRACTED. The histogram records the whole interval
 * between ticks, so an idle loop reads about `resolution` (20 ms), not zero.
 * Every figure here is that minus the resolution, floored at zero: what an
 * idle process reports is about 0 to 2 ms.
 *
 * ADDITIVE AND SAFE: nothing here is on a request path, the timer is unref'd
 * (it never keeps the process alive), and an unstarted monitor reports null.
 */

/** Minimal surface of a Node `IntervalHistogram`, so tests can drive it. */
export interface DelayHistogram {
  enable(): boolean;
  disable(): boolean;
  reset(): void;
  readonly count: number;
  /** Nanoseconds. */
  readonly max: number;
  /** Nanoseconds. */
  percentile(percentile: number): number;
}

export interface EventLoopLag {
  /** The window the figures cover, in seconds (the ring's span). */
  windowSeconds: number;
  /** Timer ticks behind the figures; 0 right after boot. */
  samples: number;
  p50Ms: number;
  /** Worst slice p99 in the window. See the header. */
  p99Ms: number;
  maxMs: number;
}

interface Slice {
  /** ms since the epoch the slice was closed. */
  at: number;
  samples: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface EventLoopMonitorOptions {
  /** Sampling period of the libuv timer. Default 20 ms. */
  resolutionMs?: number;
  /** How often the histogram is folded into the ring. Default 5 s. */
  sliceMs?: number;
  /** How long a figure stays in the snapshot. Default 60 s. */
  windowMs?: number;
  histogram?: DelayHistogram;
  now?: () => number;
}

const NS_PER_MS = 1_000_000;

export class EventLoopMonitor {
  private readonly histogram: DelayHistogram;
  private readonly resolutionMs: number;
  private readonly sliceMs: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private ring: Slice[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(options: EventLoopMonitorOptions = {}) {
    this.resolutionMs = options.resolutionMs ?? 20;
    this.sliceMs = options.sliceMs ?? 5_000;
    this.windowMs = options.windowMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.histogram =
      options.histogram ??
      monitorEventLoopDelay({ resolution: this.resolutionMs });
  }

  /** Idempotent. The timer is unref'd: it never holds the process open. */
  start(): void {
    if (this.timer) {
      return;
    }
    this.histogram.enable();
    this.timer = setInterval(() => this.tick(), this.sliceMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.histogram.disable();
  }

  /** Fold the histogram into the ring and start the next slice. */
  tick(): void {
    const slice = this.readSlice();
    this.histogram.reset();
    if (slice) {
      this.ring.push(slice);
    }
    this.prune();
  }

  /** The last window, or null when nothing has been sampled yet. */
  snapshot(): EventLoopLag | null {
    this.prune();
    const slices = [...this.ring];
    const live = this.readSlice();
    if (live) {
      slices.push(live);
    }
    if (slices.length === 0) {
      return null;
    }
    const p50s = slices.map((s) => s.p50Ms).sort((a, b) => a - b);
    return {
      windowSeconds: Math.round(this.windowMs / 1000),
      samples: slices.reduce((sum, s) => sum + s.samples, 0),
      p50Ms: round1(p50s[Math.floor((p50s.length - 1) / 2)] ?? 0),
      p99Ms: round1(Math.max(...slices.map((s) => s.p99Ms))),
      maxMs: round1(Math.max(...slices.map((s) => s.maxMs))),
    };
  }

  private readSlice(): Slice | null {
    // An empty histogram reports a huge sentinel max and zero percentiles;
    // never read those.
    if (this.histogram.count <= 0) {
      return null;
    }
    return {
      at: this.now(),
      samples: this.histogram.count,
      p50Ms: this.toLagMs(this.histogram.percentile(50)),
      p99Ms: this.toLagMs(this.histogram.percentile(99)),
      maxMs: this.toLagMs(this.histogram.max),
    };
  }

  private toLagMs(ns: number): number {
    if (!Number.isFinite(ns)) {
      return 0;
    }
    return Math.max(0, ns / NS_PER_MS - this.resolutionMs);
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    this.ring = this.ring.filter((slice) => slice.at > cutoff);
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// ----------------------------------------------------------- process-wide one

let shared: EventLoopMonitor | null = null;

/** Called once by `index.ts`. Safe to call twice. */
export function startEventLoopMonitor(): void {
  shared ??= new EventLoopMonitor();
  shared.start();
}

/** Null until started (a test, a CLI import, a process that never booted it). */
export function eventLoopLagSnapshot(): EventLoopLag | null {
  try {
    return shared?.snapshot() ?? null;
  } catch {
    return null;
  }
}

/** Test hook. */
export function resetEventLoopMonitorForTests(): void {
  shared?.stop();
  shared = null;
}

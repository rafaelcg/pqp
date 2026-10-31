import { afterEach, describe, expect, it } from "vitest";
import {
  EventLoopMonitor,
  eventLoopLagSnapshot,
  resetEventLoopMonitorForTests,
  startEventLoopMonitor,
  type DelayHistogram,
} from "./event-loop.js";
import { resetRuntimeMetrics, runtimeSnapshot } from "./runtime.js";

/**
 * The lag figures: a fake histogram drives the arithmetic (resolution
 * subtracted, slices folded, the window ageing out), and one real test blocks
 * the loop for real to prove the Node histogram is wired the way the fake
 * assumes.
 */

const MS = 1_000_000;

/** What a Node IntervalHistogram reads like, in nanoseconds. */
class FakeHistogram implements DelayHistogram {
  count = 0;
  max = 0;
  private values: number[] = [];
  enable(): boolean {
    return true;
  }
  disable(): boolean {
    return true;
  }
  reset(): void {
    this.values = [];
    this.count = 0;
    this.max = 0;
  }
  record(ms: number, times = 1): void {
    for (let i = 0; i < times; i += 1) {
      this.values.push(ms * MS);
    }
    this.count = this.values.length;
    this.max = Math.max(...this.values);
  }
  percentile(p: number): number {
    const sorted = [...this.values].sort((a, b) => a - b);
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    );
    return sorted[index] ?? 0;
  }
}

afterEach(() => {
  resetEventLoopMonitorForTests();
  resetRuntimeMetrics();
});

function monitor(clock: { t: number }, histogram: FakeHistogram) {
  return new EventLoopMonitor({
    resolutionMs: 20,
    sliceMs: 5_000,
    windowMs: 60_000,
    histogram,
    now: () => clock.t,
  });
}

describe("EventLoopMonitor", () => {
  it("is null before anything was sampled", () => {
    const m = monitor({ t: 0 }, new FakeHistogram());
    expect(m.snapshot()).toBeNull();
  });

  it("subtracts the sampling resolution, so an idle loop reads about zero", () => {
    const h = new FakeHistogram();
    h.record(20.4, 100);
    const lag = monitor({ t: 0 }, h).snapshot();
    expect(lag).toMatchObject({ samples: 100, p50Ms: 0.4, p99Ms: 0.4, maxMs: 0.4 });
  });

  it("never reports below zero when a tick fires early", () => {
    const h = new FakeHistogram();
    h.record(19, 10);
    const lag = monitor({ t: 0 }, h).snapshot();
    expect(lag?.p99Ms).toBe(0);
  });

  it("reports a stall in p99 and max while p50 stays calm", () => {
    const h = new FakeHistogram();
    h.record(21, 98);
    h.record(520, 2);
    const lag = monitor({ t: 0 }, h).snapshot();
    expect(lag?.p50Ms).toBe(1);
    expect(lag?.p99Ms).toBe(500);
    expect(lag?.maxMs).toBe(500);
  });

  it("folds slices into the window: worst p99, worst max, median of p50", () => {
    const clock = { t: 0 };
    const h = new FakeHistogram();
    const m = monitor(clock, h);
    // Three 5 s slices, each with a calm body and one slow tick.
    for (const [calm, slow] of [
      [22, 60],
      [24, 320],
      [23, 80],
    ] as const) {
      h.record(calm, 99);
      h.record(slow, 1);
      clock.t += 5_000;
      m.tick();
    }
    // The slice in progress is empty, so only the three closed slices count.
    const lag = m.snapshot();
    expect(lag?.samples).toBe(300);
    // Each slice's p99 is its calm body (99 of 100 ticks), so the window's
    // p99 is the worst calm body, and the spike only shows in max.
    expect(lag?.p99Ms).toBe(4);
    expect(lag?.maxMs).toBe(300);
    expect(lag?.p50Ms).toBe(3);
  });

  it("includes the slice still in progress", () => {
    const clock = { t: 0 };
    const h = new FakeHistogram();
    const m = monitor(clock, h);
    h.record(21, 50);
    clock.t += 5_000;
    m.tick();
    h.record(220, 50); // a stall that has not been folded yet
    expect(m.snapshot()?.p99Ms).toBe(200);
  });

  it("lets a slice age out after the window", () => {
    const clock = { t: 0 };
    const h = new FakeHistogram();
    const m = monitor(clock, h);
    h.record(520, 10);
    clock.t += 5_000;
    m.tick();
    expect(m.snapshot()?.maxMs).toBe(500);
    clock.t += 61_000;
    expect(m.snapshot()).toBeNull();
  });
});

describe("process-wide monitor", () => {
  it("is null in runtime until started, then carries the lag", async () => {
    expect(runtimeSnapshot().eventLoop).toBeNull();
    startEventLoopMonitor();
    // Block the loop for real; the timer then fires about 150 ms late.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const until = Date.now() + 150;
    while (Date.now() < until) {
      // spin
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    const lag = eventLoopLagSnapshot();
    expect(lag).not.toBeNull();
    expect(lag?.maxMs).toBeGreaterThan(60);
    expect(runtimeSnapshot().eventLoop?.maxMs).toBe(lag?.maxMs);
  });
});

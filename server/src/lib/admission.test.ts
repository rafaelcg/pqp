import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdmissionGate, mapWithConcurrency } from "./admission.js";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createAdmissionGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never has more than `concurrency` holders, and admits the rest in arrival order", async () => {
    const gate = createAdmissionGate({ concurrency: 2, maxWaitMs: 10_000 });
    const blockers = Array.from({ length: 5 }, () => deferred());
    const started: number[] = [];
    let live = 0;
    let peak = 0;
    const runs = blockers.map((blocker, index) =>
      gate.run(async () => {
        started.push(index);
        live += 1;
        peak = Math.max(peak, live);
        await blocker.promise;
        live -= 1;
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0, 1]);
    expect(gate.stats().queued).toBe(3);

    blockers[1]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0, 1, 2]);
    blockers[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0, 1, 2, 3]);
    for (const blocker of blockers) {
      blocker.resolve();
    }
    await Promise.all(runs);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    const stats = gate.stats();
    expect(stats.inFlight).toBe(0);
    expect(stats.queued).toBe(0);
    expect(stats.peakQueued).toBe(3);
    expect(stats.admitted).toBe(5);
    expect(stats.admittedImmediately).toBe(2);
    expect(stats.overflowed).toBe(0);
  });

  it("gives the slot back when the work throws", async () => {
    const gate = createAdmissionGate({ concurrency: 1, maxWaitMs: 10_000 });
    await expect(
      gate.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(gate.run(async () => "next")).resolves.toBe("next");
    expect(gate.stats().inFlight).toBe(0);
  });

  it("lets a waiter through over the limit after maxWaitMs, so the gate is never the reason for an auth timeout", async () => {
    const gate = createAdmissionGate({ concurrency: 1, maxWaitMs: 4_000 });
    const hog = deferred();
    const first = gate.run(() => hog.promise);
    let secondStarted = false;
    const second = gate.run(async () => {
      secondStarted = true;
    });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(secondStarted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(secondStarted).toBe(true);
    await second;
    const stats = gate.stats();
    expect(stats.overflowed).toBe(1);
    expect(stats.maxWaitMs).toBe(4_000);
    hog.resolve();
    await first;
    expect(gate.stats().inFlight).toBe(0);
  });

  it("never lets anyone over the limit when maxWaitMs is 0", async () => {
    const gate = createAdmissionGate({ concurrency: 1, maxWaitMs: 0 });
    const hog = deferred();
    const first = gate.run(() => hog.promise);
    let secondStarted = false;
    const second = gate.run(async () => {
      secondStarted = true;
    });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(secondStarted).toBe(false);
    hog.resolve();
    await first;
    await second;
    expect(secondStarted).toBe(true);
    expect(gate.stats().overflowed).toBe(0);
  });

  it("drops a waiter that asked to be dropped, without running it or going over the limit", async () => {
    const gate = createAdmissionGate({ concurrency: 1, maxWaitMs: 0 });
    const hog = deferred();
    const first = gate.run(() => hog.promise);
    let ran = false;
    const optional = gate.run(
      async () => {
        ran = true;
        return "ran";
      },
      { maxWaitMs: 1_000, onTimeout: "drop" },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(optional).resolves.toBeUndefined();
    expect(ran).toBe(false);
    expect(gate.stats()).toMatchObject({ dropped: 1, overflowed: 0, inFlight: 1, queued: 0 });
    hog.resolve();
    await first;
    expect(gate.stats().inFlight).toBe(0);
  });

  it("calls straight through when disabled (the runtime flag's off position)", async () => {
    let enabled = false;
    const gate = createAdmissionGate({
      concurrency: 1,
      maxWaitMs: 10_000,
      enabled: () => enabled,
    });
    const hog = deferred();
    const first = gate.run(() => hog.promise);
    let ran = false;
    await gate.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(gate.stats().admitted).toBe(0);
    hog.resolve();
    await first;
    enabled = true;
    await gate.run(async () => {});
    expect(gate.stats().admitted).toBe(1);
  });

  it("reports wait percentiles from the waits it saw", async () => {
    const gate = createAdmissionGate({ concurrency: 1, maxWaitMs: 60_000 });
    const hog = deferred();
    const first = gate.run(() => hog.promise);
    const second = gate.run(async () => {});
    await vi.advanceTimersByTimeAsync(250);
    hog.resolve();
    await first;
    await second;
    const stats = gate.stats();
    expect(stats.waitP50Ms).toBe(250);
    expect(stats.waitP95Ms).toBe(250);
    expect(stats.maxWaitMs).toBe(250);
  });
});

describe("mapWithConcurrency", () => {
  it("keeps input order and never exceeds the limit", async () => {
    let live = 0;
    let peak = 0;
    const results = await mapWithConcurrency([5, 1, 4, 2, 3, 0], 2, async (value) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((done) => setTimeout(done, value));
      live -= 1;
      return value * 10;
    });
    expect(results).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
  });

  it("handles an empty list", async () => {
    await expect(mapWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
  });

  it("reads 0 (and Infinity) as unbounded, never as one at a time", async () => {
    for (const limit of [0, Number.POSITIVE_INFINITY]) {
      let live = 0;
      let peak = 0;
      await mapWithConcurrency([1, 2, 3, 4, 5], limit, async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((done) => setTimeout(done, 5));
        live -= 1;
      });
      expect(peak).toBe(5);
    }
  });

  it("starts nothing new after a failure, and waits for what was running", async () => {
    const started: number[] = [];
    let finished = 0;
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (value) => {
        started.push(value);
        if (value === 0) {
          throw new Error("first");
        }
        await new Promise((done) => setTimeout(done, 10));
        finished += 1;
        return value;
      }),
    ).rejects.toThrow("first");
    // Item 1 was already running when item 0 failed; it finished before the
    // rejection, and nothing after it was started.
    expect(started).toEqual([0, 1]);
    expect(finished).toBe(1);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import {
  notePoolOccupancy,
  notePoolWait,
  poolWaitSnapshot,
  resetPoolWaitForTests,
} from "./pool-wait.js";

const MINUTE = 60_000;
const T0 = 1_000 * MINUTE;

describe("pool wait histogram", () => {
  beforeEach(() => {
    resetPoolWaitForTests();
  });

  it("reads zero when nothing was checked out", () => {
    const snapshot = poolWaitSnapshot(T0);
    expect(snapshot.lastMinute.checkouts).toBe(0);
    expect(snapshot.lastMinute.p95Ms).toBe(0);
    expect(snapshot.perMinute).toEqual([]);
  });

  it("separates a burst nobody felt from a wait somebody did", () => {
    // A deploy burst: the ceiling touched, every wait a few milliseconds.
    for (let i = 0; i < 95; i += 1) {
      notePoolWait(0.4, T0);
    }
    for (let i = 0; i < 5; i += 1) {
      notePoolWait(30, T0);
    }
    notePoolOccupancy(22, 161, T0);
    const burst = poolWaitSnapshot(T0).lastMinute;
    expect(burst.checkouts).toBe(100);
    expect(burst.p50Ms).toBe(1);
    expect(burst.p95Ms).toBe(1);
    expect(burst.p99Ms).toBe(30);
    expect(burst.maxMs).toBe(30);
    expect(burst.waitedOver1s).toBe(0);
    expect(burst.maxBusy).toBe(22);
    expect(burst.maxWaiting).toBe(161);

    // A minute later, somebody really waited.
    notePoolWait(3_200, T0 + MINUTE);
    const felt = poolWaitSnapshot(T0 + MINUTE);
    expect(felt.lastMinute.waitedOver1s).toBe(1);
    expect(felt.lastMinute.maxMs).toBe(3_200);
    expect(felt.last5Minutes.checkouts).toBe(101);
    expect(felt.last5Minutes.waitedOver1s).toBe(1);
  });

  it("dates every peak and forgets it after an hour", () => {
    notePoolOccupancy(22, 40, T0);
    notePoolWait(5, T0);
    const fresh = poolWaitSnapshot(T0);
    expect(fresh.perMinute).toHaveLength(1);
    expect(fresh.perMinute[0]!.at).toBe(new Date(T0).toISOString());
    expect(fresh.perMinute[0]!.maxBusy).toBe(22);

    notePoolWait(1, T0 + 61 * MINUTE);
    const later = poolWaitSnapshot(T0 + 61 * MINUTE);
    expect(later.lastHour.maxBusy).toBe(0);
    expect(later.perMinute).toHaveLength(1);
    expect(later.perMinute[0]!.at).toBe(new Date(T0 + 61 * MINUTE).toISOString());
  });

  it("never reports a percentile above the largest wait seen", () => {
    notePoolWait(12_000, T0);
    const snapshot = poolWaitSnapshot(T0).lastMinute;
    expect(snapshot.p50Ms).toBe(12_000);
    expect(snapshot.maxMs).toBe(12_000);
  });
});

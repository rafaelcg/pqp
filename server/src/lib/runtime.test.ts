import { afterEach, describe, expect, it } from "vitest";
import {
  clearPoolStats,
  noteRuntimeSample,
  poolPressure,
  registerPoolStats,
  registerSocketCount,
  resetRuntimeMetrics,
  runtimeSnapshot,
  type PoolStats,
} from "./runtime.js";

/**
 * The saturation verdict and the high-water marks. Nothing here touches a
 * database or a socket: the module reads registered getters, which is exactly
 * what makes the judgement testable.
 */

function stats(partial: Partial<PoolStats>): PoolStats {
  return { max: 10, total: 0, idle: 0, waiting: 0, ...partial };
}

afterEach(() => {
  resetRuntimeMetrics();
});

describe("poolPressure", () => {
  it("is ok while the pool has room", () => {
    expect(poolPressure(stats({ total: 0, idle: 0 }))).toBe("ok");
    expect(poolPressure(stats({ total: 10, idle: 10 }))).toBe("ok");
    expect(poolPressure(stats({ total: 7, idle: 0 }))).toBe("ok");
  });

  it("is tight from 80% of max checked out, before anything queues", () => {
    expect(poolPressure(stats({ total: 8, idle: 0 }))).toBe("tight");
    expect(poolPressure(stats({ total: 10, idle: 2 }))).toBe("tight");
    expect(poolPressure(stats({ total: 10, idle: 0 }))).toBe("tight");
  });

  it("is saturated only when the queue meets a pool with nothing left to open", () => {
    expect(poolPressure(stats({ total: 10, idle: 0, waiting: 1 }))).toBe("saturated");
    expect(poolPressure(stats({ total: 10, idle: 0, waiting: 170 }))).toBe("saturated");
  });

  it("calls a queue below the ceiling tight, not saturated", () => {
    // pg queues a request whenever it cannot hand over a connection in the same
    // tick — including while the pool is still opening its first connections,
    // which is every cold start. Painting that red would mean a red dashboard
    // on every single deploy.
    expect(poolPressure(stats({ max: 40, total: 15, idle: 0, waiting: 14 }))).toBe("tight");
    expect(poolPressure(stats({ max: 40, total: 1, idle: 1, waiting: 3 }))).toBe("tight");
  });

  it("does not call a process with no pool tight", () => {
    // Nothing has opened a pool: max 0 must not read as "fully checked out".
    expect(poolPressure(stats({ max: 0 }))).toBe("ok");
  });
});

describe("runtimeSnapshot", () => {
  it("reports zeros and no pressure when nothing is registered", () => {
    const snapshot = runtimeSnapshot();
    expect(snapshot.sockets).toBe(0);
    expect(snapshot.pool).toMatchObject({ max: 0, total: 0, idle: 0, waiting: 0, busy: 0 });
    expect(snapshot.pool.pressure).toBe("ok");
    expect(Date.parse(snapshot.sampledAt)).not.toBeNaN();
    expect(Date.parse(snapshot.peakTrackedSince)).not.toBeNaN();
  });

  it("reads the live values through the registered getters", () => {
    let sockets = 3;
    let live = stats({ total: 4, idle: 1 });
    registerSocketCount(() => sockets);
    registerPoolStats(() => live);

    expect(runtimeSnapshot()).toMatchObject({
      sockets: 3,
      pool: { max: 10, total: 4, idle: 1, waiting: 0, busy: 3, pressure: "ok" },
    });

    sockets = 9;
    live = stats({ total: 10, idle: 0, waiting: 2 });
    expect(runtimeSnapshot()).toMatchObject({
      sockets: 9,
      pool: { busy: 10, waiting: 2, pressure: "saturated" },
    });
  });

  it("reports the pressure a full pool with a queue is actually in", () => {
    registerPoolStats(() => stats({ max: 10, total: 10, idle: 0, waiting: 170 }));
    const snapshot = runtimeSnapshot();
    expect(snapshot.pool.pressure).toBe("saturated");
    // The ceiling, not the database, is the constraint — and this is how you
    // tell afterwards, since `busy` reaching `max` is unambiguous.
    expect(snapshot.peakPoolBusy).toBe(snapshot.pool.max);
  });

  it("keeps high-water marks that a poll would otherwise miss", () => {
    let sockets = 0;
    let live = stats({});
    registerSocketCount(() => sockets);
    registerPoolStats(() => live);

    // The spike: it forms and drains between two reads of the endpoint.
    sockets = 180;
    live = stats({ total: 10, idle: 0, waiting: 170 });
    noteRuntimeSample();

    sockets = 2;
    live = stats({ total: 10, idle: 10 });
    const after = runtimeSnapshot();

    expect(after.sockets).toBe(2);
    expect(after.pool.waiting).toBe(0);
    expect(after.pool.pressure).toBe("ok");
    // Live says calm; the peaks say what actually happened.
    expect(after.peakSockets).toBe(180);
    expect(after.peakPoolWaiting).toBe(170);
    expect(after.peakPoolBusy).toBe(10);
  });

  it("stops reading a pool that has been torn down", () => {
    registerPoolStats(() => stats({ total: 9, idle: 0 }));
    expect(runtimeSnapshot().pool.busy).toBe(9);
    clearPoolStats();
    expect(runtimeSnapshot().pool).toMatchObject({ max: 0, busy: 0, pressure: "ok" });
    // The peak from before the teardown is still true and is still reported.
    expect(runtimeSnapshot().peakPoolBusy).toBe(9);
  });

  it("cannot throw out of a checkout or a metrics read when a getter misbehaves", () => {
    // The pool `acquire` listener calls the first of these. A throw there would
    // surface as an error on the pool, i.e. observability breaking the thing it
    // observes; a throw in the second would 500 the whole metrics payload.
    registerPoolStats(() => {
      throw new Error("pool gone");
    });
    expect(() => noteRuntimeSample()).not.toThrow();
    expect(runtimeSnapshot().pool).toMatchObject({ max: 0, busy: 0, pressure: "ok" });
  });
});

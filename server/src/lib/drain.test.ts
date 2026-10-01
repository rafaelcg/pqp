import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  beginDrain,
  closeSocketsInBatches,
  DEFAULT_DRAIN_RATE_PER_SECOND,
  DRAIN_BATCH_INTERVAL_MS,
  DRAIN_BATCH_JITTER_MS,
  DRAIN_BATCH_SIZE,
  DRAIN_DEADLINE_MS,
  DRAIN_SPREAD_CEILING_FRACTION,
  drainPlan,
  resolveDrainRatePerSecond,
  GOING_AWAY,
  healthVerdict,
  isDraining,
  resetDrainForTests,
} from "./drain.js";

/**
 * The shutdown handover (M5). Two things are worth pinning: the sockets go
 * in batches with a pause between them rather than all at once, and
 * `/health` turns red the moment the drain starts, ahead of the first
 * close, so the proxy has stopped routing here by the time anybody
 * reconnects.
 */

interface FakeSocket {
  close: Mock<(code: number, reason: string) => void>;
  closedAt: number | null;
}

function sockets(count: number): FakeSocket[] {
  return Array.from({ length: count }, () => {
    const socket: FakeSocket = {
      close: vi.fn<(code: number, reason: string) => void>(),
      closedAt: null,
    };
    socket.close.mockImplementation(() => {
      socket.closedAt = Date.now();
    });
    return socket;
  });
}

const closedCount = (list: FakeSocket[]) =>
  list.filter((socket) => socket.close.mock.calls.length > 0).length;

describe("closeSocketsInBatches", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes in batches with a pause between them, not all at once", async () => {
    const list = sockets(120);
    const batches: number[] = [];
    const done = closeSocketsInBatches(list, {
      batchSize: 50,
      intervalMs: 100,
      jitterMs: 0,
      onBatch: (closed) => batches.push(closed),
    });

    // The first batch goes synchronously, then the loop waits.
    expect(closedCount(list)).toBe(50);
    await vi.advanceTimersByTimeAsync(99);
    expect(closedCount(list)).toBe(50);
    await vi.advanceTimersByTimeAsync(1);
    expect(closedCount(list)).toBe(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(closedCount(list)).toBe(120);

    await expect(done).resolves.toBe(120);
    expect(batches).toEqual([50, 50, 20]);
  });

  it("sends 1001 going-away to every socket exactly once", async () => {
    const list = sockets(7);
    const done = closeSocketsInBatches(list, { batchSize: 3, jitterMs: 0 });
    await vi.runAllTimersAsync();
    await done;
    for (const socket of list) {
      expect(socket.close).toHaveBeenCalledTimes(1);
      expect(socket.close).toHaveBeenCalledWith(GOING_AWAY, expect.any(String));
    }
  });

  it("adds the jitter the random source asks for", async () => {
    const list = sockets(100);
    const done = closeSocketsInBatches(list, {
      batchSize: 50,
      intervalMs: 100,
      jitterMs: 50,
      // Always the top of the range: the pause is 100 + 49.
      random: () => 0.99,
    });
    await vi.advanceTimersByTimeAsync(148);
    expect(closedCount(list)).toBe(50);
    await vi.advanceTimersByTimeAsync(1);
    expect(closedCount(list)).toBe(100);
    await done;
  });

  it("skips a socket whose close throws and keeps going", async () => {
    const list = sockets(3);
    list[1]!.close.mockImplementation(() => {
      throw new Error("already closed");
    });
    const done = closeSocketsInBatches(list, { batchSize: 1, jitterMs: 0 });
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBe(3);
    expect(list[2]!.close).toHaveBeenCalledTimes(1);
  });

  it("does not drain a socket that appeared after the snapshot", async () => {
    const live = new Set<FakeSocket>(sockets(2));
    const late = sockets(1)[0]!;
    const done = closeSocketsInBatches(live, { batchSize: 1, jitterMs: 0 });
    live.add(late);
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBe(2);
    expect(late.close).not.toHaveBeenCalled();
  });

  it("closes whatever is left at once past the deadline", async () => {
    const list = sockets(10);
    const done = closeSocketsInBatches(list, {
      batchSize: 1,
      intervalMs: 100,
      jitterMs: 0,
      deadlineMs: 250,
    });
    // t=0: 1 closed; t=100: 2; t=200: 3; t=300 is past the 250 deadline, so
    // the fourth batch takes everything that remains.
    await vi.advanceTimersByTimeAsync(200);
    expect(closedCount(list)).toBe(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(closedCount(list)).toBe(10);
    await done;
  });

  it("resolves immediately with nothing to close", async () => {
    await expect(closeSocketsInBatches([], { jitterMs: 0 })).resolves.toBe(0);
  });
});

describe("healthVerdict", () => {
  afterEach(() => {
    resetDrainForTests();
  });

  /**
   * A3.1: liveness only. No probe parameter exists any more to assert
   * "never touches the pool" against — that guarantee is now structural
   * (there is nothing here that could reach `db.ts` even by accident), and
   * `index.ts`'s spy test covers the wiring one level up.
   */
  it("is 200 with the version while listening and not draining", () => {
    expect(isDraining()).toBe(false);
    expect(healthVerdict(true, "abc123")).toEqual({
      status: 200,
      body: { ok: true, version: "abc123" },
    });
  });

  it("is 503 when the HTTP server is not listening", () => {
    expect(healthVerdict(false)).toMatchObject({
      status: 503,
      body: { ok: false, error: "not listening" },
    });
  });

  it("is 503 from the moment the drain begins, even while still listening", () => {
    beginDrain();
    expect(isDraining()).toBe(true);
    expect(healthVerdict(true)).toEqual({
      status: 503,
      body: { ok: false, error: "draining" },
    });
  });
});

describe("drainPlan", () => {
  const spreadOf = (total: number, batchSize: number) =>
    (Math.ceil(total / batchSize) - 1) *
    (DRAIN_BATCH_INTERVAL_MS + DRAIN_BATCH_JITTER_MS / 2);

  it("is the old fixed drain at rate 0 (the rollback)", () => {
    expect(drainPlan(143, 0)).toMatchObject({
      batchSize: DRAIN_BATCH_SIZE,
      intervalMs: DRAIN_BATCH_INTERVAL_MS,
    });
  });

  it("paces an ordinary container at about the rate asked for", () => {
    // 143 sockets, the 2026-09-30 23:33Z drain: 13 per ~125 ms, ~1.4 s,
    // where the fixed drain emptied it in about a third of a second.
    const plan = drainPlan(143, 100);
    expect(plan.batchSize).toBe(13);
    expect(plan.intervalMs).toBe(DRAIN_BATCH_INTERVAL_MS);
    expect(spreadOf(143, plan.batchSize)).toBeGreaterThan(1_000);
    expect(spreadOf(143, plan.batchSize)).toBeLessThan(2_000);
    expect(spreadOf(143, DRAIN_BATCH_SIZE)).toBeLessThan(400);
  });

  it("goes faster for a container too big to drain inside the budget at that rate", () => {
    const plan = drainPlan(2_000, 100);
    expect(spreadOf(2_000, plan.batchSize)).toBeLessThanOrEqual(
      DRAIN_DEADLINE_MS * DRAIN_SPREAD_CEILING_FRACTION,
    );
  });

  it("keeps a low rate low by spacing single closes further apart", () => {
    const plan = drainPlan(10, 2);
    expect(plan.batchSize).toBe(1);
    // ~2 a second once the jitter is added back on average.
    expect(plan.intervalMs + DRAIN_BATCH_JITTER_MS / 2).toBe(500);
  });

  it("reads DRAIN_RATE_PER_SECOND, defaulting to 100", () => {
    expect(resolveDrainRatePerSecond(undefined)).toBe(DEFAULT_DRAIN_RATE_PER_SECOND);
    expect(resolveDrainRatePerSecond("")).toBe(DEFAULT_DRAIN_RATE_PER_SECOND);
    expect(resolveDrainRatePerSecond("0")).toBe(0);
    expect(resolveDrainRatePerSecond("250")).toBe(250);
    expect(resolveDrainRatePerSecond("-3")).toBe(DEFAULT_DRAIN_RATE_PER_SECOND);
  });
});

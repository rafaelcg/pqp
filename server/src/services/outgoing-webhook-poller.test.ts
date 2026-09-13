import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * The adaptive poller: backoff, reset-on-work, and the NOTIFY wake. The
 * webhook delivery logic itself (claiming rows, retrying, dead-lettering) is
 * pinned in `outgoing-webhooks.test.ts`; this file only exercises the
 * scheduling loop around it, with a fake `deliver` so it needs no Postgres
 * for the backoff half.
 */

const {
  startOutgoingWebhookPoller,
  stopOutgoingWebhookPoller,
  outgoingWebhookPollerSnapshotForTests,
  OUTGOING_WEBHOOK_POLL_MIN_MS,
  OUTGOING_WEBHOOK_POLL_MAX_MS,
  notifyOutgoingWebhookEnqueued,
  wakeOutgoingWebhookPollerForTests,
} = await import("./outgoing-webhook-poller.js");

describe("outgoing webhook poller: backoff", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.useFakeTimers();
    // No DATABASE_URL: the LISTEN half no-ops, so these tests exercise pure
    // interval scheduling with no network at all.
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    stopOutgoingWebhookPoller();
    vi.useRealTimers();
    if (originalDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("ticks at the fast interval while there is work", async () => {
    const deliver = vi.fn(async () => 1);
    startOutgoingWebhookPoller(deliver);

    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(OUTGOING_WEBHOOK_POLL_MIN_MS);
    }
    expect(deliver).toHaveBeenCalledTimes(4);
    expect(outgoingWebhookPollerSnapshotForTests()?.intervalMs).toBe(
      OUTGOING_WEBHOOK_POLL_MIN_MS,
    );
  });

  it("doubles the wait after each empty tick, capped at the max", async () => {
    const deliver = vi.fn(async () => 0);
    startOutgoingWebhookPoller(deliver);

    const expectedIntervals: number[] = [];
    let interval = OUTGOING_WEBHOOK_POLL_MIN_MS;
    for (let i = 0; i < 6; i++) {
      expectedIntervals.push(interval);
      interval = Math.min(interval * 2, OUTGOING_WEBHOOK_POLL_MAX_MS);
    }

    for (const wait of expectedIntervals) {
      await vi.advanceTimersByTimeAsync(wait);
    }
    expect(deliver).toHaveBeenCalledTimes(expectedIntervals.length);
    expect(outgoingWebhookPollerSnapshotForTests()?.intervalMs).toBe(
      OUTGOING_WEBHOOK_POLL_MAX_MS,
    );
  });

  it("resets to the fast interval once work shows up again", async () => {
    const deliver = vi.fn(async () => 0);
    startOutgoingWebhookPoller(deliver);

    // Back off a few steps.
    await vi.advanceTimersByTimeAsync(OUTGOING_WEBHOOK_POLL_MIN_MS);
    await vi.advanceTimersByTimeAsync(OUTGOING_WEBHOOK_POLL_MIN_MS * 2);
    expect(outgoingWebhookPollerSnapshotForTests()?.intervalMs).toBe(
      OUTGOING_WEBHOOK_POLL_MIN_MS * 4,
    );

    deliver.mockResolvedValueOnce(1);
    await vi.advanceTimersByTimeAsync(OUTGOING_WEBHOOK_POLL_MIN_MS * 4);
    expect(outgoingWebhookPollerSnapshotForTests()?.intervalMs).toBe(
      OUTGOING_WEBHOOK_POLL_MIN_MS,
    );
  });

  it("logs a failing tick and keeps polling rather than stopping", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const deliver = vi
      .fn(async () => 0)
      .mockRejectedValueOnce(new Error("boom"));
    startOutgoingWebhookPoller(deliver);

    await vi.advanceTimersByTimeAsync(OUTGOING_WEBHOOK_POLL_MIN_MS);
    expect(error).toHaveBeenCalledWith(
      "[outgoing-webhooks] poll failed:",
      expect.any(Error),
    );
    await vi.advanceTimersByTimeAsync(OUTGOING_WEBHOOK_POLL_MIN_MS * 2);
    expect(deliver).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("stop() cancels the pending tick", async () => {
    const deliver = vi.fn(async () => 0);
    const { stop } = startOutgoingWebhookPoller(deliver);
    stop();
    await vi.advanceTimersByTimeAsync(OUTGOING_WEBHOOK_POLL_MAX_MS * 4);
    expect(deliver).not.toHaveBeenCalled();
    expect(outgoingWebhookPollerSnapshotForTests()).toBeNull();
  });

  it("a second start while one is running does not race a second loop", async () => {
    const deliver = vi.fn(async () => 0);
    startOutgoingWebhookPoller(deliver);
    startOutgoingWebhookPoller(deliver);
    await vi.advanceTimersByTimeAsync(OUTGOING_WEBHOOK_POLL_MIN_MS);
    // One loop, one tick — not two overlapping ones.
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  /**
   * The pending-wake path: a NOTIFY (or any wake) arriving while a tick's
   * own `deliver()` is still in flight must not be dropped, because that
   * tick's claim query may already have run before the row the wake is
   * about was committed.
   */
  it("does not drop a wake that arrives while a tick is in flight", async () => {
    const gate = (() => {
      let resolve!: (n: number) => void;
      const promise = new Promise<number>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    })();
    let calls = 0;
    const deliver = vi.fn(() => {
      calls += 1;
      return calls === 1 ? gate.promise : Promise.resolve(0);
    });
    startOutgoingWebhookPoller(deliver);
    await vi.advanceTimersByTimeAsync(OUTGOING_WEBHOOK_POLL_MIN_MS);
    expect(deliver).toHaveBeenCalledTimes(1);

    // The wake arrives while the first tick's `deliver()` is still pending.
    wakeOutgoingWebhookPollerForTests();
    expect(outgoingWebhookPollerSnapshotForTests()?.wakeRequested).toBe(true);

    // The in-flight tick finally resolves empty. The pending wake schedules
    // its forced re-tick at the fast interval rather than firing inline.
    gate.resolve(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(outgoingWebhookPollerSnapshotForTests()?.intervalMs).toBe(
      OUTGOING_WEBHOOK_POLL_MIN_MS,
    );
    expect(outgoingWebhookPollerSnapshotForTests()?.wakeRequested).toBe(false);
    expect(deliver).toHaveBeenCalledTimes(1);

    // The forced re-tick fires at the fast interval — not the doubled
    // backoff an empty tick would otherwise have applied.
    await vi.advanceTimersByTimeAsync(OUTGOING_WEBHOOK_POLL_MIN_MS);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  /**
   * The restart race: an old poller's in-flight tick must not resurrect
   * itself against a NEW poller started while it was still running.
   */
  it("a tick started by a stopped poller does not mutate the poller that replaced it", async () => {
    const gate = (() => {
      let resolve!: (n: number) => void;
      const promise = new Promise<number>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    })();
    const oldDeliver = vi.fn(() => gate.promise);
    startOutgoingWebhookPoller(oldDeliver);
    await vi.advanceTimersByTimeAsync(OUTGOING_WEBHOOK_POLL_MIN_MS);
    expect(oldDeliver).toHaveBeenCalledTimes(1);

    // Stop while the tick above is still pending, then start a fresh one.
    stopOutgoingWebhookPoller();
    const newDeliver = vi.fn(async () => 0);
    startOutgoingWebhookPoller(newDeliver);
    const freshIntervalAfterStart =
      outgoingWebhookPollerSnapshotForTests()?.intervalMs;

    // NOW the old poller's stuck tick resolves.
    gate.resolve(5);
    await vi.advanceTimersByTimeAsync(0);

    // The old tick's "work found" result must not have reset the NEW
    // poller's interval or scheduled an extra tick on it.
    expect(outgoingWebhookPollerSnapshotForTests()?.intervalMs).toBe(
      freshIntervalAfterStart,
    );
    expect(newDeliver).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(OUTGOING_WEBHOOK_POLL_MIN_MS);
    // The new poller's own loop still runs normally.
    expect(newDeliver).toHaveBeenCalledTimes(1);
  });
});

// ============================================================ NOTIFY wake

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

describeDb("outgoing webhook poller: NOTIFY wake", () => {
  afterEach(() => {
    stopOutgoingWebhookPoller();
  });

  it("wakes immediately on a NOTIFY instead of waiting out the backoff", async () => {
    const { getPool, initDb, closePool } = await import("../db.js");
    await initDb();
    try {
      const deliver = vi.fn(async () => 0);
      startOutgoingWebhookPoller(deliver);
      // Give the LISTEN connection a moment to actually establish before the
      // NOTIFY fires — this exercises the real Postgres round trip, so it
      // uses real timers throughout rather than fake ones.
      await new Promise((resolve) => setTimeout(resolve, 300));

      await notifyOutgoingWebhookEnqueued(getPool());

      await vi.waitFor(
        () => {
          expect(deliver.mock.calls.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 3_000, interval: 50 },
      );
    } finally {
      await closePool();
    }
  });
});

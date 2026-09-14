import { describe, expect, it, vi } from "vitest";
import { createHlsSessionLookupGuard } from "./hls-telemetry-session-guard.js";

/**
 * Fake timers so a "hung" lookup can be proven to time out deterministically
 * without a real database, a real 500ms wait, or touching the ambient
 * `setTimeout`/`Date.now` this module reads by default.
 */
function guardWithFakeTimers(overrides: {
  timeoutMs: number;
  negativeCacheMs: number;
  negativeCacheMaxSize?: number;
}) {
  const timers = new Map<number, () => void>();
  let nextId = 1;
  let clock = 0;
  const setTimeoutFn = ((fn: () => void, _ms: number) => {
    const id = nextId++;
    timers.set(id, fn);
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimeoutFn = ((id: unknown) => {
    timers.delete(id as number);
  }) as typeof clearTimeout;
  function fireAllTimers() {
    for (const fn of [...timers.values()]) {
      fn();
    }
    timers.clear();
  }
  const guard = createHlsSessionLookupGuard({
    ...overrides,
    setTimeoutFn,
    clearTimeoutFn,
  });
  return { guard, fireAllTimers, now: () => clock, advance: (ms: number) => (clock += ms) };
}

describe("createHlsSessionLookupGuard", () => {
  it("resolves normally when the lookup settles before the timeout", async () => {
    const { guard } = guardWithFakeTimers({ timeoutMs: 500, negativeCacheMs: 30_000 });
    const result = await guard.resolve("chan:123", async () => "hls-session-row-id");
    expect(result).toEqual({ outcome: "resolved", sessionId: "hls-session-row-id" });
  });

  it("resolves normally to null (a legitimate 'no session right now')", async () => {
    const { guard } = guardWithFakeTimers({ timeoutMs: 500, negativeCacheMs: 30_000 });
    const result = await guard.resolve("chan:123", async () => null);
    expect(result).toEqual({ outcome: "resolved", sessionId: null });
  });

  it("times out a lookup that never settles, and negatively caches its key", async () => {
    const { guard, fireAllTimers } = guardWithFakeTimers({
      timeoutMs: 500,
      negativeCacheMs: 30_000,
    });
    const hungLookup = () => new Promise<string | null>(() => {}); // never settles
    const pending = guard.resolve("chan:123", hungLookup, 1_000);
    fireAllTimers();
    await expect(pending).resolves.toEqual({ outcome: "timeout" });
  });

  it("skips the lookup entirely for a negatively-cached key, inside the window", async () => {
    const { guard, fireAllTimers } = guardWithFakeTimers({
      timeoutMs: 500,
      negativeCacheMs: 30_000,
    });
    const hungLookup = vi.fn(() => new Promise<string | null>(() => {}));
    const first = guard.resolve("chan:123", hungLookup, 1_000);
    fireAllTimers();
    await expect(first).resolves.toEqual({ outcome: "timeout" });

    // Same key, still inside the 30s window (1_000 + 5_000 < 1_000 + 30_000):
    // the lookup function must not even be called a second time.
    const second = await guard.resolve("chan:123", hungLookup, 6_000);
    expect(second).toEqual({ outcome: "negatively-cached" });
    expect(hungLookup).toHaveBeenCalledTimes(1);
  });

  it("tries again once the negative-cache window has expired", async () => {
    const { guard, fireAllTimers } = guardWithFakeTimers({
      timeoutMs: 500,
      negativeCacheMs: 30_000,
    });
    const hungLookup = vi.fn(() => new Promise<string | null>(() => {}));
    const first = guard.resolve("chan:123", hungLookup, 1_000);
    fireAllTimers();
    await expect(first).resolves.toEqual({ outcome: "timeout" });

    // Past the 30s window (1_000 + 30_000 = 31_000): tries the lookup again,
    // and this one succeeds.
    const second = await guard.resolve("chan:123", async () => "recovered-id", 31_001);
    expect(second).toEqual({ outcome: "resolved", sessionId: "recovered-id" });
    expect(hungLookup).toHaveBeenCalledTimes(1);
  });

  it("negative-caches independently per key -- one struggling session does not block another", async () => {
    const { guard, fireAllTimers } = guardWithFakeTimers({
      timeoutMs: 500,
      negativeCacheMs: 30_000,
    });
    const hungLookup = () => new Promise<string | null>(() => {});
    const stuckSession = guard.resolve("chan:stuck", hungLookup, 1_000);
    fireAllTimers();
    await expect(stuckSession).resolves.toEqual({ outcome: "timeout" });

    const healthySession = await guard.resolve(
      "chan:healthy",
      async () => "healthy-id",
      1_001,
    );
    expect(healthySession).toEqual({ outcome: "resolved", sessionId: "healthy-id" });
  });

  it("reset() forgets every negative-cache entry", async () => {
    const { guard, fireAllTimers } = guardWithFakeTimers({
      timeoutMs: 500,
      negativeCacheMs: 30_000,
    });
    const hungLookup = vi.fn(() => new Promise<string | null>(() => {}));
    const first = guard.resolve("chan:123", hungLookup, 1_000);
    fireAllTimers();
    await expect(first).resolves.toEqual({ outcome: "timeout" });

    guard.reset();
    const second = await guard.resolve("chan:123", async () => "fresh-id", 1_001);
    expect(second).toEqual({ outcome: "resolved", sessionId: "fresh-id" });
  });

  /**
   * Farol finding, 2026-09-14: concurrent batches for the same session each
   * started their own race and their own timer, so a whole sampled audience
   * flushing in the same tick meant one lookup attempt (and, on a timeout,
   * one negative-cache write) per caller rather than one for the session.
   */
  describe("single-flight per key", () => {
    it("shares one lookup call and one outcome across concurrent callers for the same key", async () => {
      const { guard } = guardWithFakeTimers({ timeoutMs: 500, negativeCacheMs: 30_000 });
      let resolveLookup: (value: string | null) => void;
      const lookup = vi.fn(
        () =>
          new Promise<string | null>((resolveIt) => {
            resolveLookup = resolveIt;
          }),
      );
      const first = guard.resolve("chan:123", lookup, 1_000);
      const second = guard.resolve("chan:123", lookup, 1_000);
      const third = guard.resolve("chan:123", lookup, 1_000);
      // `lookup` is now called through a promise boundary (a Farol finding
      // on synchronous throws, fixed alongside this), so it runs on the
      // NEXT microtask rather than synchronously -- flush one before
      // checking it was only reached once.
      await Promise.resolve();
      expect(lookup).toHaveBeenCalledTimes(1);

      resolveLookup!("shared-id");
      const [a, b, c] = await Promise.all([first, second, third]);
      const resolved = { outcome: "resolved", sessionId: "shared-id" };
      expect(a).toEqual(resolved);
      expect(b).toEqual(resolved);
      expect(c).toEqual(resolved);
    });

    it("a timeout is shared too: every concurrent caller gets the same negatively-cached outcome from one timer", async () => {
      const { guard, fireAllTimers } = guardWithFakeTimers({
        timeoutMs: 500,
        negativeCacheMs: 30_000,
      });
      const hungLookup = vi.fn(() => new Promise<string | null>(() => {}));
      const first = guard.resolve("chan:123", hungLookup, 1_000);
      const second = guard.resolve("chan:123", hungLookup, 1_000);
      fireAllTimers();
      const [a, b] = await Promise.all([first, second]);
      expect(a).toEqual({ outcome: "timeout" });
      expect(b).toEqual({ outcome: "timeout" });
      expect(hungLookup).toHaveBeenCalledTimes(1);
    });

    it("detaches once settled -- a call for the same key AFTER the shared attempt resolves starts fresh, not piled onto a stale entry", async () => {
      const { guard } = guardWithFakeTimers({ timeoutMs: 500, negativeCacheMs: 30_000 });
      const firstLookup = vi.fn(async () => "first-id");
      await guard.resolve("chan:123", firstLookup, 1_000);

      const secondLookup = vi.fn(async () => "second-id");
      const result = await guard.resolve("chan:123", secondLookup, 1_001);
      expect(result).toEqual({ outcome: "resolved", sessionId: "second-id" });
      expect(secondLookup).toHaveBeenCalledTimes(1);
    });

    it("different keys never share an attempt", async () => {
      const { guard } = guardWithFakeTimers({ timeoutMs: 500, negativeCacheMs: 30_000 });
      const lookupA = vi.fn(async () => "id-a");
      const lookupB = vi.fn(async () => "id-b");
      const [a, b] = await Promise.all([
        guard.resolve("chan:a", lookupA, 1_000),
        guard.resolve("chan:b", lookupB, 1_000),
      ]);
      expect(a).toEqual({ outcome: "resolved", sessionId: "id-a" });
      expect(b).toEqual({ outcome: "resolved", sessionId: "id-b" });
      expect(lookupA).toHaveBeenCalledTimes(1);
      expect(lookupB).toHaveBeenCalledTimes(1);
    });

    /**
     * Farol finding, 2026-09-14: a `lookup` that throws SYNCHRONOUSLY
     * (rather than returning a rejected promise) used to finish the whole
     * attempt -- `finally` included -- before this module ever stored it in
     * `inFlight`, so the cleanup ran too early to remove anything and the
     * rejected attempt was cached under `key` PERMANENTLY: every later call
     * for that key failed forever, without even calling `lookup` again.
     */
    it("a synchronously-throwing lookup rejects this call but does not poison later calls for the same key", async () => {
      const { guard } = guardWithFakeTimers({ timeoutMs: 500, negativeCacheMs: 30_000 });
      const throwingLookup = (): Promise<string | null> => {
        throw new Error("boom: this throws before returning a promise at all");
      };
      await expect(guard.resolve("chan:123", throwingLookup, 1_000)).rejects.toThrow(
        "boom",
      );

      // The key must NOT be stuck: a normal lookup right after gets a
      // genuinely fresh attempt, not the same rejected promise replayed.
      const healthyLookup = vi.fn(async () => "recovered-id");
      const result = await guard.resolve("chan:123", healthyLookup, 1_001);
      expect(result).toEqual({ outcome: "resolved", sessionId: "recovered-id" });
      expect(healthyLookup).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Coordinator's ask, 2026-09-14: 30s TTL (already covered above) plus a
   * max size so a struggling deployment with many distinct sessions timing
   * out does not grow this map without bound alongside the database
   * pressure that is already the problem.
   */
  describe("bounded negative cache", () => {
    it("evicts the oldest negatively-cached key once the cache is at its max size", async () => {
      const { guard, fireAllTimers } = guardWithFakeTimers({
        timeoutMs: 500,
        negativeCacheMs: 30_000,
        negativeCacheMaxSize: 2,
      });
      const hungLookup = () => new Promise<string | null>(() => {});

      // Three DIFFERENT sessions time out in order: a, then b, then c.
      // With a max size of 2, c's insertion must evict a (the oldest),
      // leaving b and c negatively cached.
      await Promise.all(
        ["chan:a", "chan:b"].map((key) => {
          const pending = guard.resolve(key, hungLookup, 1_000);
          fireAllTimers();
          return pending;
        }),
      );
      const cPending = guard.resolve("chan:c", hungLookup, 2_000);
      fireAllTimers();
      await expect(cPending).resolves.toEqual({ outcome: "timeout" });

      // "chan:a" was evicted: a fresh call for it runs the lookup again
      // rather than answering from the (now-gone) negative-cache entry.
      const freshLookupForA = vi.fn(async () => "recovered-a");
      const aResult = await guard.resolve("chan:a", freshLookupForA, 2_001);
      expect(aResult).toEqual({ outcome: "resolved", sessionId: "recovered-a" });
      expect(freshLookupForA).toHaveBeenCalledTimes(1);

      // "chan:b" and "chan:c" are both still within their negative-cache
      // window and were NOT evicted: neither one's lookup runs again.
      const stillCachedLookupForB = vi.fn(hungLookup);
      const bResult = await guard.resolve("chan:b", stillCachedLookupForB, 2_002);
      expect(bResult).toEqual({ outcome: "negatively-cached" });
      expect(stillCachedLookupForB).not.toHaveBeenCalled();

      const stillCachedLookupForC = vi.fn(hungLookup);
      const cResult = await guard.resolve("chan:c", stillCachedLookupForC, 2_003);
      expect(cResult).toEqual({ outcome: "negatively-cached" });
      expect(stillCachedLookupForC).not.toHaveBeenCalled();
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { createHlsSessionLookupGuard } from "./hls-telemetry-session-guard.js";

/**
 * Fake timers so a "hung" lookup can be proven to time out deterministically
 * without a real database, a real 500ms wait, or touching the ambient
 * `setTimeout`/`Date.now` this module reads by default.
 */
function guardWithFakeTimers(overrides: { timeoutMs: number; negativeCacheMs: number }) {
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
});

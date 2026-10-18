import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOME_PREFETCH_IDLE_TIMEOUT_MS,
  createHomeLoader,
  prefetchHomeWhenIdle,
  withCeiling,
} from "./load";

afterEach(() => {
  vi.useRealTimers();
});

describe("createHomeLoader", () => {
  it("imports once and reuses the resolved module", async () => {
    const mod = { default: () => null };
    const importer = vi.fn(() => Promise.resolve(mod));
    const loader = createHomeLoader(importer);

    expect(loader.loaded()).toBeNull();
    const [a, b] = await Promise.all([loader.load(), loader.load()]);
    expect(a).toBe(mod);
    expect(b).toBe(mod);
    expect(loader.loaded()).toBe(mod);
    expect(await loader.load()).toBe(mod);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("forgets a rejected import, so the next call starts a fresh one", async () => {
    const mod = { default: () => null };
    const dead = new Error("Failed to fetch dynamically imported module");
    const importer = vi
      .fn<() => Promise<typeof mod>>()
      .mockRejectedValueOnce(dead)
      .mockResolvedValueOnce(mod);
    const loader = createHomeLoader(importer);

    await expect(loader.load()).rejects.toBe(dead);
    expect(loader.loaded()).toBeNull();
    await expect(loader.load()).resolves.toBe(mod);
    expect(importer).toHaveBeenCalledTimes(2);
    expect(loader.loaded()).toBe(mod);
  });
});

describe("withCeiling", () => {
  it("resolves when the promise resolves first", async () => {
    vi.useFakeTimers();
    let settled = false;
    void withCeiling(Promise.resolve("x"), 3000).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });

  it("resolves, never rejects, when the promise rejects", async () => {
    await expect(withCeiling(Promise.reject(new Error("no chunk")), 3000)).resolves.toBeUndefined();
  });

  it("resolves at the ceiling when the promise hangs", async () => {
    vi.useFakeTimers();
    let settled = false;
    void withCeiling(new Promise(() => {}), 3000).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });
});

describe("prefetchHomeWhenIdle", () => {
  function fakeWindow(opts: { idle?: boolean; saveData?: boolean } = {}) {
    const idleCalls: { fn: () => void; timeout?: number }[] = [];
    const timers: { fn: () => void; ms?: number }[] = [];
    const win = {
      navigator: { connection: { saveData: opts.saveData ?? false } },
      setTimeout: vi.fn((fn: () => void, ms?: number) => {
        timers.push({ fn, ms });
        return timers.length;
      }),
      clearTimeout: vi.fn(),
      ...(opts.idle === false
        ? {}
        : {
            requestIdleCallback: vi.fn((fn: () => void, o?: { timeout?: number }) => {
              idleCalls.push({ fn, timeout: o?.timeout });
              return idleCalls.length;
            }),
            cancelIdleCallback: vi.fn(),
          }),
    };
    return { win, idleCalls, timers };
  }

  it("loads the chunk in an idle callback with a timeout", () => {
    const { win, idleCalls } = fakeWindow();
    const load = vi.fn(() => Promise.resolve());
    prefetchHomeWhenIdle(win as never, load);
    expect(load).not.toHaveBeenCalled();
    expect(idleCalls).toHaveLength(1);
    expect(idleCalls[0].timeout).toBe(HOME_PREFETCH_IDLE_TIMEOUT_MS);
    idleCalls[0].fn();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("falls back to a timer without requestIdleCallback (Safari)", () => {
    const { win, timers } = fakeWindow({ idle: false });
    const load = vi.fn(() => Promise.resolve());
    const cancel = prefetchHomeWhenIdle(win as never, load);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(HOME_PREFETCH_IDLE_TIMEOUT_MS);
    cancel();
    expect(win.clearTimeout).toHaveBeenCalledWith(1);
  });

  it("does nothing under Save-Data", () => {
    const { win, idleCalls, timers } = fakeWindow({ saveData: true });
    const load = vi.fn(() => Promise.resolve());
    prefetchHomeWhenIdle(win as never, load);
    expect(idleCalls).toHaveLength(0);
    expect(timers).toHaveLength(0);
    expect(load).not.toHaveBeenCalled();
  });

  it("swallows a failed prefetch", async () => {
    const { win, idleCalls } = fakeWindow();
    const load = vi.fn(() => Promise.reject(new Error("offline")));
    prefetchHomeWhenIdle(win as never, load);
    idleCalls[0].fn();
    // An unhandled rejection would fail the run; give it a turn to surface.
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
  });
});

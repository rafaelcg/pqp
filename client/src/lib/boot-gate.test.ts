import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HYDRATE_CEILING_MS,
  HYDRATE_IDLE_TIMEOUT_MS,
  hasPrerenderedHero,
  whenReadyToRender,
} from "./boot-gate";

type Listener = () => void;

/** Just enough window for the gate, with timers under the test's control. */
function fakeWindow(opts: { readyState: string; idle?: boolean }) {
  const listeners = new Map<string, Listener[]>();
  let idleCallback: (() => void) | null = null;
  const win = {
    document: { readyState: opts.readyState },
    addEventListener(name: string, fn: Listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), fn]);
    },
    removeEventListener(name: string, fn: Listener) {
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((l) => l !== fn),
      );
    },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    ...(opts.idle === false
      ? {}
      : {
          requestIdleCallback: (fn: () => void) => {
            idleCallback = fn;
            return 1;
          },
          cancelIdleCallback: () => {
            idleCallback = null;
          },
        }),
  };
  return {
    win: win as unknown as Window,
    fire: (name: string) => (listeners.get(name) ?? []).forEach((l) => l()),
    runIdle: () => idleCallback?.(),
    hasIdle: () => idleCallback !== null,
  };
}

describe("whenReadyToRender", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for load, then for an idle moment", () => {
    const start = vi.fn();
    const w = fakeWindow({ readyState: "loading" });
    whenReadyToRender(start, w.win);
    expect(start).not.toHaveBeenCalled();
    w.fire("load");
    expect(start).not.toHaveBeenCalled();
    expect(w.hasIdle()).toBe(true);
    w.runIdle();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("goes straight to waiting for idle when the page has already loaded", () => {
    const start = vi.fn();
    const w = fakeWindow({ readyState: "complete" });
    whenReadyToRender(start, w.win);
    expect(w.hasIdle()).toBe(true);
    w.runIdle();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("falls back to a short timer where there is no idle callback", () => {
    const start = vi.fn();
    const w = fakeWindow({ readyState: "complete", idle: false });
    whenReadyToRender(start, w.win);
    vi.advanceTimersByTime(250);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("does not wait for a visitor who has already touched the page", () => {
    for (const name of ["pointerdown", "keydown", "touchstart"]) {
      const start = vi.fn();
      const w = fakeWindow({ readyState: "loading" });
      whenReadyToRender(start, w.win);
      w.fire(name);
      expect(start, name).toHaveBeenCalledTimes(1);
    }
  });

  it("gives up waiting for a stalled load after the ceiling", () => {
    const start = vi.fn();
    const w = fakeWindow({ readyState: "loading" });
    whenReadyToRender(start, w.win);
    vi.advanceTimersByTime(HYDRATE_CEILING_MS - 1);
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("starts once, however many signals arrive", () => {
    const start = vi.fn();
    const w = fakeWindow({ readyState: "loading" });
    whenReadyToRender(start, w.win);
    w.fire("pointerdown");
    w.fire("keydown");
    w.fire("load");
    w.runIdle();
    vi.advanceTimersByTime(HYDRATE_CEILING_MS + HYDRATE_IDLE_TIMEOUT_MS);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("can be cancelled", () => {
    const start = vi.fn();
    const w = fakeWindow({ readyState: "loading" });
    const cancel = whenReadyToRender(start, w.win);
    cancel();
    w.fire("pointerdown");
    vi.advanceTimersByTime(HYDRATE_CEILING_MS * 2);
    expect(start).not.toHaveBeenCalled();
  });
});

describe("hasPrerenderedHero", () => {
  function doc(route: string | null, block: boolean) {
    return {
      documentElement: { getAttribute: () => route },
      getElementById: (id: string) => (block && id === "pre-hero" ? {} : null),
    } as unknown as Document;
  }

  it("is true only on the home route with the block present", () => {
    expect(hasPrerenderedHero(doc("home", true))).toBe(true);
    expect(hasPrerenderedHero(doc("home", false))).toBe(false);
    expect(hasPrerenderedHero(doc("other", true))).toBe(false);
    expect(hasPrerenderedHero(doc(null, true))).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HYDRATE_CEILING_MS,
  HYDRATE_IDLE_TIMEOUT_MS,
  INTERACTIONS,
  hasPrerenderedHero,
  isInFirstViewport,
  whenPrerenderPainted,
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
    for (const name of ["pointerdown", "keydown", "touchstart", "wheel"]) {
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

describe("INTERACTIONS", () => {
  it("counts a wheel turn as the first interaction, like a touch, a click or a key", () => {
    expect([...INTERACTIONS]).toEqual(["pointerdown", "keydown", "touchstart", "wheel"]);
  });
});

/** An image with a box, and a decode the test settles by hand. */
function fakeImage(rect: { top: number; left?: number; width: number; height: number }) {
  let settle: () => void = () => {};
  const decode = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
  );
  const left = rect.left ?? 0;
  return {
    img: {
      decode,
      getBoundingClientRect: () => ({
        top: rect.top,
        left,
        width: rect.width,
        height: rect.height,
        bottom: rect.top + rect.height,
        right: left + rect.width,
      }),
    },
    decode,
    settle: () => settle(),
  };
}

function fakeDoc(images: Array<{ img: unknown }>, view = { innerWidth: 390, innerHeight: 844 }) {
  return {
    defaultView: view,
    querySelectorAll: (selector: string) => (selector === "#pre-hero img" ? images.map((i) => i.img) : []),
  } as unknown as Document;
}

describe("isInFirstViewport", () => {
  const box = (top: number, height = 100, left = 0, width = 100) =>
    fakeImage({ top, left, width, height }).img as unknown as Element;

  it("is true for a box that overlaps the viewport", () => {
    expect(isInFirstViewport(box(0), 390, 844)).toBe(true);
    expect(isInFirstViewport(box(800), 390, 844)).toBe(true);
    expect(isInFirstViewport(box(-50), 390, 844)).toBe(true);
  });

  it("is false below the fold, above the top, and beside the viewport", () => {
    expect(isInFirstViewport(box(844), 390, 844)).toBe(false);
    expect(isInFirstViewport(box(-100), 390, 844)).toBe(false);
    expect(isInFirstViewport(box(0, 100, 390), 390, 844)).toBe(false);
  });

  it("is false for an empty box, which is how a hidden language block's picture measures", () => {
    expect(isInFirstViewport(box(0, 0, 0, 0), 390, 844)).toBe(false);
    expect(isInFirstViewport(box(10, 0), 390, 844)).toBe(false);
  });
});

describe("whenPrerenderPainted", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => setTimeout(fn, 16));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function settled(promise: Promise<void>): Promise<boolean> {
    let done = false;
    void promise.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(40);
    return done;
  }

  it("waits for the pictures on screen to decode, then two frames", async () => {
    const onScreen = fakeImage({ top: 100, width: 350, height: 260 });
    const painted = whenPrerenderPainted(fakeDoc([onScreen]), 1200);
    expect(onScreen.decode).toHaveBeenCalledTimes(1);
    expect(await settled(painted)).toBe(false);
    onScreen.settle();
    expect(await settled(painted)).toBe(true);
  });

  it("does not wait for a picture below the fold or in a hidden language block", async () => {
    const below = fakeImage({ top: 900, width: 350, height: 260 });
    const hidden = fakeImage({ top: 0, width: 0, height: 0 });
    const painted = whenPrerenderPainted(fakeDoc([below, hidden]), 1200);
    expect(below.decode).not.toHaveBeenCalled();
    expect(hidden.decode).not.toHaveBeenCalled();
    expect(await settled(painted)).toBe(true);
  });

  it("stops waiting at the ceiling when a decode never settles", async () => {
    const stuck = fakeImage({ top: 0, width: 390, height: 300 });
    let done = false;
    void whenPrerenderPainted(fakeDoc([stuck]), 1200).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1199);
    expect(done).toBe(false);
    // The ceiling, then the two frames.
    await vi.advanceTimersByTimeAsync(1 + 32);
    expect(done).toBe(true);
  });

  it("never rejects, even without a window to measure against", async () => {
    const doc = {
      defaultView: null,
      querySelectorAll: () => {
        throw new Error("no DOM");
      },
    } as unknown as Document;
    await expect(whenPrerenderPainted(doc, 10)).resolves.toBeUndefined();
  });
});

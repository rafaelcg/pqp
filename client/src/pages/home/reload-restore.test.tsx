// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReloadRestore } from "./reload-restore";

/*
 * The reload restore and a hash glide must never fight. CI caught the restore's
 * late correction (500 ms after its jump) landing inside a header link's
 * smooth glide before the glide had moved a pixel: "nothing moved", so it
 * jumped back and the glide was cancelled for good. A browser only shows that
 * on a slow machine, so the order of events is pinned here instead.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SAVED = 3200;

function Probe() {
  useReloadRestore();
  return null;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let scrollTo: ReturnType<typeof vi.fn>;

function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<Probe />));
}

/** The two frames the restore waits before its jump. */
function runFrames() {
  act(() => {
    vi.advanceTimersToNextFrame();
    vi.advanceTimersToNextFrame();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([
    { type: "reload" } as unknown as PerformanceEntry,
  ]);
  scrollTo = vi.fn();
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
  window.history.replaceState(null, "", "/");
  sessionStorage.clear();
  sessionStorage.setItem("pqp:home-scroll:default", String(SAVED));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

const jumps = () => scrollTo.mock.calls.filter(([arg]) => (arg as ScrollToOptions)?.top === SAVED).length;

describe("useReloadRestore", () => {
  it("jumps back after two frames and corrects once if nothing moved the page", () => {
    mount();
    expect(jumps()).toBe(0);
    runFrames();
    expect(jumps()).toBe(1);
    act(() => vi.advanceTimersByTime(500));
    expect(jumps()).toBe(2);
  });

  it("stands down when a hash arrives before the correction", () => {
    mount();
    runFrames();
    expect(jumps()).toBe(1);
    // A header link: the URL changes, and its glide has not moved yet.
    act(() => {
      window.location.hash = "#perguntas";
    });
    act(() => vi.advanceTimersByTime(500));
    expect(jumps()).toBe(1);
  });

  it("reads the URL at the correction even when no event came first", () => {
    mount();
    runFrames();
    // pushState fires no hashchange and no popstate.
    window.history.pushState(null, "", "/#perguntas");
    act(() => vi.advanceTimersByTime(500));
    expect(jumps()).toBe(1);
  });

  it("stands down on back or forward and on the reader's own input", () => {
    for (const event of [new PopStateEvent("popstate"), new WheelEvent("wheel"), new KeyboardEvent("keydown")]) {
      window.history.replaceState(null, "", "/");
      sessionStorage.setItem("pqp:home-scroll:default", String(SAVED));
      scrollTo.mockClear();
      mount();
      runFrames();
      act(() => {
        window.dispatchEvent(event);
      });
      act(() => vi.advanceTimersByTime(500));
      expect(jumps(), event.type).toBe(1);
      act(() => root?.unmount());
      root = null;
      host?.remove();
    }
  });

  it("never jumps when an event lands before the first jump", () => {
    mount();
    act(() => {
      window.location.hash = "#perguntas";
    });
    runFrames();
    act(() => vi.advanceTimersByTime(500));
    expect(jumps()).toBe(0);
  });
});

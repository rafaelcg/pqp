import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDLE_CHROME_DELAY_MS,
  createIdleChrome,
  idleChromeClassName,
  type IdleChromeController,
} from "@/hooks/use-idle-chrome";

/**
 * The call stage's video-player chrome. Pinned as a controller with fake
 * timers because the rules are about time, and a 3 s wait per case would make
 * the suite unrunnable; the React binding is one `useEffect` around this.
 */
describe("createIdleChrome", () => {
  let changes: boolean[];
  let chrome: IdleChromeController;

  beforeEach(() => {
    vi.useFakeTimers();
    changes = [];
    chrome = createIdleChrome((hidden) => changes.push(hidden));
  });
  afterEach(() => {
    chrome.dispose();
    vi.useRealTimers();
  });

  it("hides after the idle delay once a share is on stage", () => {
    chrome.configure({ enabled: true, pinned: false });
    vi.advanceTimersByTime(IDLE_CHROME_DELAY_MS - 1);
    expect(chrome.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(chrome.hidden).toBe(true);
    expect(changes).toEqual([true]);
  });

  it("never hides while nothing is on stage (audio-only call)", () => {
    chrome.configure({ enabled: false, pinned: false });
    chrome.activity();
    vi.advanceTimersByTime(IDLE_CHROME_DELAY_MS * 10);
    expect(chrome.hidden).toBe(false);
    expect(changes).toEqual([]);
  });

  it("shows on a pointer move and restarts the clock", () => {
    chrome.configure({ enabled: true, pinned: false });
    vi.advanceTimersByTime(IDLE_CHROME_DELAY_MS);
    expect(chrome.hidden).toBe(true);

    chrome.activity();
    expect(chrome.hidden).toBe(false);
    // Each move pushes the deadline out; the bar stays while the pointer
    // keeps going.
    vi.advanceTimersByTime(IDLE_CHROME_DELAY_MS - 500);
    chrome.activity();
    vi.advanceTimersByTime(IDLE_CHROME_DELAY_MS - 500);
    expect(chrome.hidden).toBe(false);
    vi.advanceTimersByTime(500);
    expect(chrome.hidden).toBe(true);
    expect(changes).toEqual([true, false, true]);
  });

  it("does not hide while a menu from the bar is open, and restarts when it closes", () => {
    chrome.configure({ enabled: true, pinned: false });
    vi.advanceTimersByTime(1000);
    // The quality menu opens: the clock stops and stays stopped.
    chrome.configure({ enabled: true, pinned: true });
    vi.advanceTimersByTime(IDLE_CHROME_DELAY_MS * 3);
    expect(chrome.hidden).toBe(false);
    // Activity while pinned does not start a clock either.
    chrome.activity();
    vi.advanceTimersByTime(IDLE_CHROME_DELAY_MS * 3);
    expect(chrome.hidden).toBe(false);

    // Menu closes: a fresh full delay, not the 2 s that were left.
    chrome.configure({ enabled: true, pinned: false });
    vi.advanceTimersByTime(IDLE_CHROME_DELAY_MS - 1);
    expect(chrome.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(chrome.hidden).toBe(true);
  });

  it("brings hidden chrome back the moment something pins it (focus lands on the bar)", () => {
    chrome.configure({ enabled: true, pinned: false });
    vi.advanceTimersByTime(IDLE_CHROME_DELAY_MS);
    expect(chrome.hidden).toBe(true);
    chrome.configure({ enabled: true, pinned: true });
    expect(chrome.hidden).toBe(false);
  });

  it("shows again when the share ends", () => {
    chrome.configure({ enabled: true, pinned: false });
    vi.advanceTimersByTime(IDLE_CHROME_DELAY_MS);
    expect(chrome.hidden).toBe(true);
    chrome.configure({ enabled: false, pinned: false });
    expect(chrome.hidden).toBe(false);
    vi.advanceTimersByTime(IDLE_CHROME_DELAY_MS * 2);
    expect(chrome.hidden).toBe(false);
  });

  it("a touch tap toggles: hide when shown, show (and re-arm) when hidden", () => {
    chrome.configure({ enabled: true, pinned: false });
    chrome.toggle();
    expect(chrome.hidden).toBe(true);
    chrome.toggle();
    expect(chrome.hidden).toBe(false);
    // Shown by a tap, the chrome still leaves on its own afterwards.
    vi.advanceTimersByTime(IDLE_CHROME_DELAY_MS);
    expect(chrome.hidden).toBe(true);
  });

  it("a tap cannot hide pinned chrome", () => {
    chrome.configure({ enabled: true, pinned: true });
    chrome.toggle();
    expect(chrome.hidden).toBe(false);
  });

  it("a tap does nothing over an audio-only call", () => {
    chrome.configure({ enabled: false, pinned: false });
    chrome.toggle();
    expect(chrome.hidden).toBe(false);
  });

  it("a repeated configure with the same values does not reset the clock", () => {
    chrome.configure({ enabled: true, pinned: false });
    vi.advanceTimersByTime(IDLE_CHROME_DELAY_MS - 1);
    chrome.configure({ enabled: true, pinned: false });
    vi.advanceTimersByTime(1);
    expect(chrome.hidden).toBe(true);
  });

  it("dispose drops a pending timer", () => {
    chrome.configure({ enabled: true, pinned: false });
    chrome.dispose();
    vi.advanceTimersByTime(IDLE_CHROME_DELAY_MS * 2);
    expect(chrome.hidden).toBe(false);
    expect(changes).toEqual([]);
  });
});

describe("idleChromeClassName", () => {
  it("fades over 200 ms by default and keeps taking the pointer while hidden", () => {
    expect(idleChromeClassName({ hidden: false, reducedMotion: false })).toBe(
      "transition-opacity duration-200 opacity-100",
    );
    // No `pointer-events-none`: a hit-target check that precedes the pointer
    // move (Playwright, some assistive pointers) must still find the bar. The
    // bar swallows the press itself while hidden.
    expect(idleChromeClassName({ hidden: true, reducedMotion: false })).toBe(
      "transition-opacity duration-200 opacity-0",
    );
  });

  it("toggles instantly under prefers-reduced-motion, still hiding", () => {
    const hidden = idleChromeClassName({ hidden: true, reducedMotion: true });
    expect(hidden).toContain("transition-none");
    expect(hidden).toContain("opacity-0");
    expect(hidden).not.toContain("duration-");
    expect(
      idleChromeClassName({ hidden: false, reducedMotion: true }),
    ).toBe("transition-none opacity-100");
  });
});

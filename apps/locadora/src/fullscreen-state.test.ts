import { describe, expect, it } from "vitest";
import { coversScreen, createFullscreenTracker, type ViewportProbe } from "./fullscreen-state";

const probe = (viewW: number, viewH: number, screenW = 2000, screenH = 1270): ViewportProbe => ({ viewW, viewH, screenW, screenH });

describe("coversScreen", () => {
  it("is the whole screen, or the whole width and nearly all the height (a notch, a kept menu bar)", () => {
    expect(coversScreen(probe(2000, 1270))).toBe(true);
    expect(coversScreen(probe(2000, 1230, 2000, 1270))).toBe(true);
    expect(coversScreen(probe(2056, 1290, 2056, 1329))).toBe(true);
  });

  it("is never a pane: narrower than the screen, or much shorter", () => {
    expect(coversScreen(probe(1400, 900))).toBe(false);
    expect(coversScreen(probe(1999 - 2, 1270))).toBe(false);
    expect(coversScreen(probe(2000, 1000))).toBe(false);
    expect(coversScreen(probe(0, 0))).toBe(false);
  });
});

describe("the fullscreen tracker", () => {
  it("believes the host, even when the window is shorter than the screen (the MacBook notch): no windowed layout in full screen", () => {
    const tracker = createFullscreenTracker();
    // the old rule (display-mode, or the window equal to the screen) said "not full screen" here, a frame after the host said yes
    expect(tracker.hostSaid(true, probe(2000, 1270, 2000, 1330))).toBe(true);
    expect(tracker.judge(probe(2000, 1270, 2000, 1330))).toBe(true);
    // the menu bar sliding in and out moves the height by a few pixels: still full screen
    expect(tracker.judge(probe(2000, 1240, 2000, 1330))).toBe(true);
  });

  it("follows the window on the way in: the answer can come before the window has grown", () => {
    const tracker = createFullscreenTracker();
    expect(tracker.hostSaid(true, probe(1400, 900))).toBe(true);
    expect(tracker.judge(probe(1700, 1080))).toBe(true);
    expect(tracker.judge(probe(2000, 1270))).toBe(true);
  });

  it("sees Escape (an exit nobody asked us for) as the window shrinking back to its pane", () => {
    const tracker = createFullscreenTracker();
    tracker.hostSaid(true, probe(2000, 1270));
    expect(tracker.judge(probe(1400, 900))).toBe(false);
    // and it stays out: the pane growing is still the pane
    expect(tracker.judge(probe(1500, 950))).toBe(false);
  });

  it("the host saying no is the end of it, even before the window has shrunk", () => {
    const tracker = createFullscreenTracker();
    tracker.hostSaid(true, probe(2000, 1270));
    expect(tracker.hostSaid(false, probe(2000, 1270))).toBe(false);
    expect(tracker.judge(probe(2000, 1270))).toBe(false);
    expect(tracker.judge(probe(1400, 900))).toBe(false);
    // and the next yes is believed again
    expect(tracker.hostSaid(true, probe(2000, 1270))).toBe(true);
    expect(tracker.judge(probe(2000, 1270))).toBe(true);
  });

  it("a browser in F11 with the frame in its pane is not full screen (the old display-mode rule said it was)", () => {
    const tracker = createFullscreenTracker();
    expect(tracker.judge(probe(1400, 1000, 2000, 1270))).toBe(false);
  });

  it("a frame reloaded inside a full-screen window knows it from the size alone", () => {
    const tracker = createFullscreenTracker();
    expect(tracker.judge(probe(2000, 1270))).toBe(true);
  });
});

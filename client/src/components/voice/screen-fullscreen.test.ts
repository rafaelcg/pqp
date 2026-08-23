import { describe, expect, it } from "vitest";
import {
  NO_SCREEN_FULLSCREEN,
  nextSoloPeerId,
  reconcileScreenFullscreen,
  syncScreenFullscreen,
  toggleScreenFullscreen,
  toggleStageFullscreen,
} from "./screen-fullscreen";

const ALICE = "peer-alice";
const BOB = "peer-bob";

describe("toggleScreenFullscreen", () => {
  it("blows up only the screen whose button was pressed", () => {
    expect(toggleScreenFullscreen(NO_SCREEN_FULLSCREEN, ALICE)).toEqual({
      next: { active: true, soloPeerId: ALICE },
      request: "enter",
    });
  });

  it("swaps to the other screen instead of stacking a second fullscreen", () => {
    // The whole reason the state is separate from the platform call: the
    // browser is already fullscreen on the stage, so switching which share is
    // alone on it must not ask for fullscreen again.
    expect(
      toggleScreenFullscreen({ active: true, soloPeerId: ALICE }, BOB),
    ).toEqual({
      next: { active: true, soloPeerId: BOB },
      request: "none",
    });
  });

  it("takes over from a whole-stage fullscreen without leaving it", () => {
    expect(
      toggleScreenFullscreen({ active: true, soloPeerId: null }, ALICE),
    ).toEqual({
      next: { active: true, soloPeerId: ALICE },
      request: "none",
    });
  });

  it("presses again to come back to the grid", () => {
    expect(
      toggleScreenFullscreen({ active: true, soloPeerId: ALICE }, ALICE),
    ).toEqual({ next: NO_SCREEN_FULLSCREEN, request: "exit" });
  });
});

describe("toggleStageFullscreen", () => {
  it("is the one-sharer path: enter and leave, no solo choice", () => {
    const entered = toggleStageFullscreen(NO_SCREEN_FULLSCREEN);
    expect(entered).toEqual({
      next: { active: true, soloPeerId: null },
      request: "enter",
    });
    expect(toggleStageFullscreen(entered.next)).toEqual({
      next: NO_SCREEN_FULLSCREEN,
      request: "exit",
    });
  });

  it("leaves fullscreen entirely when one screen is solo", () => {
    expect(toggleStageFullscreen({ active: true, soloPeerId: BOB })).toEqual({
      next: NO_SCREEN_FULLSCREEN,
      request: "exit",
    });
  });
});

describe("syncScreenFullscreen", () => {
  it("drops the solo choice when the browser says fullscreen ended", () => {
    // Escape and the window chrome never go through the button, so this is the
    // only thing that makes the control tell the truth afterwards.
    expect(
      syncScreenFullscreen({ active: true, soloPeerId: ALICE }, false),
    ).toEqual(NO_SCREEN_FULLSCREEN);
  });

  it("keeps the solo choice made just before the browser confirmed", () => {
    // `request: "enter"` is asynchronous: the click records the target, the
    // fullscreenchange event that follows must not throw it away.
    expect(
      syncScreenFullscreen({ active: false, soloPeerId: ALICE }, true),
    ).toEqual({ active: true, soloPeerId: ALICE });
  });

  it("returns the same object when nothing changed", () => {
    const idle = NO_SCREEN_FULLSCREEN;
    expect(syncScreenFullscreen(idle, false)).toBe(idle);
    const live = { active: true, soloPeerId: ALICE };
    expect(syncScreenFullscreen(live, true)).toBe(live);
  });
});

describe("reconcileScreenFullscreen", () => {
  it("falls back to the grid when the solo presenter stops sharing", () => {
    expect(
      reconcileScreenFullscreen({ active: true, soloPeerId: ALICE }, [BOB]),
    ).toEqual({ active: true, soloPeerId: null });
  });

  it("leaves a still-sharing solo peer alone", () => {
    const state = { active: true, soloPeerId: ALICE };
    expect(reconcileScreenFullscreen(state, [ALICE, BOB])).toBe(state);
  });

  it("does not touch a whole-stage fullscreen", () => {
    const state = { active: true, soloPeerId: null };
    expect(reconcileScreenFullscreen(state, [])).toBe(state);
  });
});

describe("nextSoloPeerId", () => {
  it("is a toggle, not an accumulator", () => {
    expect(nextSoloPeerId(null, ALICE)).toBe(ALICE);
    expect(nextSoloPeerId(ALICE, BOB)).toBe(BOB);
    expect(nextSoloPeerId(ALICE, ALICE)).toBeNull();
  });
});

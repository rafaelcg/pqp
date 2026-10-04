import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_CHROME_DELAY_MS, createIdleChrome } from "@/hooks/use-idle-chrome";
import {
  isKeyboardFocus,
  stageChromeAttentionKey,
  stageChromeHold,
  stageChromeMayHide,
  type StageChromeHoldInput,
  type StageChromeInput,
} from "./stage-chrome";

const watchingOneStream: StageChromeInput = {
  autoHideSetting: true,
  expanded: true,
  streamOnStage: true,
  ownPictureOnly: false,
};

const nothingHolding: StageChromeHoldInput = {
  menuOpen: false,
  sharePickerOpen: false,
  pointerOverControls: false,
  keyboardFocusInControls: false,
  pushToTalkHeld: false,
  connected: true,
  error: false,
  notice: false,
  peerFailed: false,
};

describe("stageChromeMayHide", () => {
  it("allows hiding while a stream owns the stage", () => {
    expect(stageChromeMayHide(watchingOneStream)).toBe(true);
  });

  it("never hides a grid of cameras, or a call with nothing on stage", () => {
    expect(
      stageChromeMayHide({ ...watchingOneStream, streamOnStage: false }),
    ).toBe(false);
  });

  it("never hides a collapsed stage", () => {
    expect(stageChromeMayHide({ ...watchingOneStream, expanded: false })).toBe(
      false,
    );
  });

  it("keeps the controls for a presenter looking at their own picture", () => {
    expect(
      stageChromeMayHide({ ...watchingOneStream, ownPictureOnly: true }),
    ).toBe(false);
  });

  it("obeys the person's own switch", () => {
    expect(
      stageChromeMayHide({ ...watchingOneStream, autoHideSetting: false }),
    ).toBe(false);
  });
});

describe("stageChromeHold", () => {
  it("holds nothing in a connected call with nobody touching anything", () => {
    expect(stageChromeHold(nothingHolding)).toBeNull();
  });

  it.each<[string, Partial<StageChromeHoldInput>]>([
    ["menu-open", { menuOpen: true }],
    ["share-picker-open", { sharePickerOpen: true }],
    ["pointer-over-controls", { pointerOverControls: true }],
    ["keyboard-focus-in-controls", { keyboardFocusInControls: true }],
    ["push-to-talk-held", { pushToTalkHeld: true }],
    ["not-connected", { connected: false }],
    ["error", { error: true }],
    ["notice", { notice: true }],
    ["peer-failed", { peerFailed: true }],
  ])("holds the controls for %s", (reason, patch) => {
    expect(stageChromeHold({ ...nothingHolding, ...patch })).toBe(reason);
  });

  it("names the first reason when several apply", () => {
    expect(
      stageChromeHold({
        ...nothingHolding,
        menuOpen: true,
        pointerOverControls: true,
        connected: false,
      }),
    ).toBe("menu-open");
  });
});

describe("isKeyboardFocus", () => {
  class FakeElement {
    constructor(private readonly focusVisible: boolean | "throws") {}
    matches(selector: string): boolean {
      if (this.focusVisible === "throws") {
        throw new SyntaxError(`unknown selector ${selector}`);
      }
      return selector === ":focus-visible" && this.focusVisible;
    }
  }
  beforeEach(() => {
    vi.stubGlobal("Element", FakeElement);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is false for a button a mouse just pressed", () => {
    expect(isKeyboardFocus(new FakeElement(false) as unknown as Element)).toBe(
      false,
    );
  });

  it("is true for a control reached with the keyboard", () => {
    expect(isKeyboardFocus(new FakeElement(true) as unknown as Element)).toBe(
      true,
    );
  });

  it("errs towards holding the bar where the selector is unknown", () => {
    expect(
      isKeyboardFocus(new FakeElement("throws") as unknown as Element),
    ).toBe(true);
  });

  it("is false for something that is not an element", () => {
    expect(isKeyboardFocus(null)).toBe(false);
  });
});

describe("stageChromeAttentionKey", () => {
  const base = {
    isMuted: false,
    isDeafened: false,
    serverMuted: false,
    canSpeak: true,
    peerCount: 2,
    handsUp: 0,
  };

  it("is stable while nothing a person must notice changes", () => {
    expect(stageChromeAttentionKey(base)).toBe(stageChromeAttentionKey({ ...base }));
  });

  it.each<[string, Partial<typeof base>]>([
    ["a hotkey mute", { isMuted: true }],
    ["a moderator mute", { serverMuted: true }],
    ["losing the right to speak", { canSpeak: false }],
    ["somebody joining", { peerCount: 3 }],
    ["somebody leaving", { peerCount: 1 }],
    ["a hand going up", { handsUp: 1 }],
  ])("changes for %s", (_label, patch) => {
    expect(stageChromeAttentionKey({ ...base, ...patch })).not.toBe(
      stageChromeAttentionKey(base),
    );
  });
});

/**
 * The bug that started this: a mouse click on a bar button left it focused,
 * focus was treated as "a keyboard user is on the way to hang up", and the bar
 * was held for the rest of the stream. Driven through the real controller with
 * the real policy, so the sentence "a click does not hold the bar, a Tab does"
 * is what is pinned, not a flag name.
 */
describe("a used control and the idle clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function run(hold: Partial<StageChromeHoldInput>) {
    const chrome = createIdleChrome(() => {});
    chrome.configure({
      enabled: stageChromeMayHide(watchingOneStream),
      pinned: stageChromeHold({ ...nothingHolding, ...hold }) !== null,
    });
    vi.advanceTimersByTime(IDLE_CHROME_DELAY_MS);
    const hidden = chrome.hidden;
    chrome.dispose();
    return hidden;
  }

  it("hides after a mouse press on mute (focus there is not keyboard focus)", () => {
    expect(run({ keyboardFocusInControls: false })).toBe(true);
  });

  it("does not hide while a Tab has put focus on a control", () => {
    expect(run({ keyboardFocusInControls: true })).toBe(false);
  });

  it("does not hide while a menu is open", () => {
    expect(run({ menuOpen: true })).toBe(false);
  });

  it("does not hide while reconnecting", () => {
    expect(run({ notice: true })).toBe(false);
  });
});

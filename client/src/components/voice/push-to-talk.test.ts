import { describe, expect, it } from "vitest";
import {
  captureBinding,
  captureModifier,
  defaultPushToTalkBinding,
  formatBinding,
  isTextEntryTarget,
  parseBinding,
  shouldEngage,
  shouldRelease,
  type KeyBinding,
  type KeyEventLike,
} from "./push-to-talk";

function keyEvent(partial: Partial<KeyEventLike> & { code: string }): KeyEventLike {
  return {
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...partial,
  };
}

const T_KEY: KeyBinding = {
  code: "KeyT",
  label: "T",
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
};

/** Stand-ins for DOM nodes — the unit environment is `node`, with no DOM. */
const composer = { tagName: "TEXTAREA" };
const searchBox = { tagName: "INPUT", type: "search" };
const richTextSpan = { tagName: "SPAN", isContentEditable: true };
const plainDiv = { tagName: "DIV" };

describe("the focus trap", () => {
  it("blocks every place a person types", () => {
    expect(isTextEntryTarget(composer)).toBe(true);
    expect(isTextEntryTarget(searchBox)).toBe(true);
    expect(isTextEntryTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "SELECT" })).toBe(true);
    // A node *inside* a contenteditable, which is what the event target
    // actually is for a rich composer — the naive `tagName` check misses it.
    expect(isTextEntryTarget(richTextSpan)).toBe(true);
    expect(
      isTextEntryTarget({
        tagName: "DIV",
        getAttribute: (name: string) =>
          name === "role" ? "textbox" : null,
      }),
    ).toBe(true);
  });

  it("blocks inputs that do not take text either", () => {
    // Deliberate over-blocking: the cost of a false positive is push-to-talk
    // not engaging over a checkbox. The cost of a false negative is a hot mic.
    expect(isTextEntryTarget({ tagName: "INPUT", type: "checkbox" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "INPUT", type: "range" })).toBe(true);
  });

  it("allows the ordinary page", () => {
    expect(isTextEntryTarget(plainDiv)).toBe(false);
    expect(isTextEntryTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
    expect(isTextEntryTarget(undefined)).toBe(false);
  });
});

describe("engaging", () => {
  it("fires on the bound key over the page", () => {
    expect(shouldEngage(keyEvent({ code: "KeyT", target: plainDiv }), T_KEY)).toBe(
      true,
    );
  });

  it("does NOT fire while typing in the composer", () => {
    // The failure everyone is afraid of: holding "T" mid-sentence silently
    // opening the mic.
    expect(
      shouldEngage(keyEvent({ code: "KeyT", target: composer }), T_KEY),
    ).toBe(false);
  });

  it("does NOT fire while typing in the search box", () => {
    expect(
      shouldEngage(keyEvent({ code: "KeyT", target: searchBox }), T_KEY),
    ).toBe(false);
  });

  it("does NOT fire mid-IME composition", () => {
    expect(
      shouldEngage(
        keyEvent({ code: "KeyT", target: plainDiv, isComposing: true }),
        T_KEY,
      ),
    ).toBe(false);
  });

  it("ignores auto-repeat rather than re-engaging every 30ms", () => {
    expect(
      shouldEngage(keyEvent({ code: "KeyT", target: plainDiv, repeat: true }), T_KEY),
    ).toBe(false);
  });

  it("requires the exact chord", () => {
    const chord: KeyBinding = { ...T_KEY, ctrl: true };
    expect(
      shouldEngage(keyEvent({ code: "KeyT", target: plainDiv }), chord),
    ).toBe(false);
    expect(
      shouldEngage(
        keyEvent({ code: "KeyT", ctrlKey: true, target: plainDiv }),
        chord,
      ),
    ).toBe(true);
    // A stray modifier is a different chord, and a different chord is not ours.
    expect(
      shouldEngage(keyEvent({ code: "KeyT", shiftKey: true, target: plainDiv }), T_KEY),
    ).toBe(false);
  });

  it("matches a bare modifier binding despite its own modifier flag", () => {
    const ctrl: KeyBinding = {
      code: "ControlLeft",
      label: "Left Ctrl",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    };
    // `ctrlKey` is true on the keydown *of* Control, so a naive flag comparison
    // would never match the key it is bound to.
    expect(
      shouldEngage(
        keyEvent({ code: "ControlLeft", ctrlKey: true, target: plainDiv }),
        ctrl,
      ),
    ).toBe(true);
  });
});

describe("releasing — the one that must never fail", () => {
  it("releases on the bound key", () => {
    expect(shouldRelease(keyEvent({ code: "KeyT", target: plainDiv }), T_KEY)).toBe(
      true,
    );
  });

  it("releases even when focus has moved into a text field mid-transmission", () => {
    // Click into the composer while holding the key and the keyup arrives with
    // an <input> as its target. Filtering that the way `shouldEngage` does
    // would leave the mic open with no way to close it.
    expect(shouldRelease(keyEvent({ code: "KeyT", target: composer }), T_KEY)).toBe(
      true,
    );
    expect(
      shouldRelease(keyEvent({ code: "KeyT", target: searchBox }), T_KEY),
    ).toBe(true);
  });

  it("releases even if the chord no longer holds", () => {
    const chord: KeyBinding = { ...T_KEY, ctrl: true };
    // Ctrl already let go, then T comes up: still ours.
    expect(
      shouldRelease(keyEvent({ code: "KeyT", target: plainDiv }), chord),
    ).toBe(true);
    // And letting go of Ctrl first ends it on its own, because some platforms
    // never deliver the keyup for the letter once the modifier is gone.
    expect(
      shouldRelease(keyEvent({ code: "ControlLeft", target: plainDiv }), chord),
    ).toBe(true);
  });

  it("does not release on an unrelated key", () => {
    expect(shouldRelease(keyEvent({ code: "KeyX", target: plainDiv }), T_KEY)).toBe(
      false,
    );
  });
});

describe("capture", () => {
  it("refuses the keys the app cannot give up", () => {
    for (const code of ["Escape", "Tab", "Enter", "NumpadEnter", "Backspace"]) {
      expect(captureBinding(keyEvent({ code })).ok, code).toBe(false);
    }
  });

  it("records the physical key and a readable label", () => {
    const outcome = captureBinding(keyEvent({ code: "KeyT", key: "t" }));
    expect(outcome).toEqual({
      ok: true,
      binding: {
        code: "KeyT",
        label: "T",
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
      },
    });
  });

  it("records the chord that was held", () => {
    const outcome = captureBinding(
      keyEvent({ code: "KeyQ", key: "q", ctrlKey: true, shiftKey: true }),
    );
    expect(outcome.ok && formatBinding(outcome.binding)).toBe("Ctrl + Shift + Q");
  });

  it("names a modifier bound on its own", () => {
    expect(formatBinding(captureModifier(keyEvent({ code: "AltRight" })))).toBe(
      "Right Alt",
    );
  });

  it("names Space rather than printing a blank", () => {
    const outcome = captureBinding(keyEvent({ code: "Space", key: " " }));
    expect(outcome.ok && outcome.binding.label).toBe("Space");
  });
});

describe("parsing stored bindings", () => {
  it("round-trips a real binding", () => {
    expect(parseBinding(defaultPushToTalkBinding)).toEqual(
      defaultPushToTalkBinding,
    );
  });

  it("rejects junk, so push-to-talk is never bound to nothing", () => {
    expect(parseBinding(null)).toBeNull();
    expect(parseBinding("KeyT")).toBeNull();
    expect(parseBinding({})).toBeNull();
    expect(parseBinding({ code: "" })).toBeNull();
    // A key an older build allowed and this one refuses.
    expect(parseBinding({ code: "Tab", label: "Tab" })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  BINDABLE_MOUSE_CODES,
  bindingTypesText,
  captureBinding,
  captureModifier,
  captureMouseBinding,
  capturePttKeyboardBinding,
  capturePttModifierBinding,
  defaultPttBinding,
  defaultPushToTalkBinding,
  formatBinding,
  isBindableMouseCode,
  isTextEntryTarget,
  matchesBinding,
  matchesMouseBinding,
  mouseCodeFromButton,
  parseBinding,
  parsePttBinding,
  shouldEngage,
  shouldRelease,
  shouldReleaseMouse,
  type KeyBinding,
  type KeyEventLike,
  type MouseEventLike,
  type PttBinding,
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

  it("lets through inputs that take no characters", () => {
    // The settings dialog is full of sliders and switches. Focus left on one
    // is not somebody typing, and the key must still work there.
    expect(isTextEntryTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTextEntryTarget({ tagName: "INPUT", type: "range" })).toBe(false);
    expect(isTextEntryTarget({ tagName: "INPUT", type: "radio" })).toBe(false);
  });

  it("treats an input with no or an unknown type as text", () => {
    expect(isTextEntryTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "INPUT", type: "number" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "INPUT", type: "something-new" })).toBe(true);
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

  it("matchesBinding ignores the target so a Ctrl chord can still be recognised in the composer", () => {
    expect(matchesBinding(keyEvent({ code: "KeyT", target: composer }), T_KEY)).toBe(
      true,
    );
    expect(
      matchesBinding(
        keyEvent({ code: "KeyT", target: composer, isComposing: true }),
        T_KEY,
      ),
    ).toBe(false);
    expect(
      matchesBinding(
        keyEvent({ code: "KeyT", target: composer, repeat: true }),
        T_KEY,
      ),
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

describe("bindings that cannot type work from the composer", () => {
  const binding = (partial: Partial<KeyBinding> & { code: string }): KeyBinding => ({
    label: partial.code,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    ...partial,
  });

  it("knows which bindings type a character", () => {
    expect(bindingTypesText(defaultPushToTalkBinding)).toBe(true);
    expect(bindingTypesText(T_KEY)).toBe(true);
    expect(bindingTypesText(binding({ code: "Space" }))).toBe(true);
    expect(bindingTypesText(binding({ code: "KeyV", shift: true }))).toBe(true);
    // Option/AltGr plus a letter types on macOS and European layouts.
    expect(bindingTypesText(binding({ code: "KeyV", alt: true }))).toBe(true);
    expect(bindingTypesText(binding({ code: "Numpad0" }))).toBe(true);

    // Right Alt is AltGr on most non-US layouts, and Windows makes AltGr out
    // of Ctrl+Alt: both are held to type "@" or "€".
    expect(bindingTypesText(binding({ code: "AltRight" }))).toBe(true);
    expect(bindingTypesText(binding({ code: "KeyQ", ctrl: true, alt: true }))).toBe(true);

    expect(bindingTypesText(binding({ code: "ControlLeft" }))).toBe(false);
    expect(bindingTypesText(binding({ code: "AltLeft" }))).toBe(false);
    expect(bindingTypesText(binding({ code: "KeyV", ctrl: true }))).toBe(false);
    expect(bindingTypesText(binding({ code: "KeyV", meta: true }))).toBe(false);
    expect(bindingTypesText(binding({ code: "F13" }))).toBe(false);
    expect(bindingTypesText(binding({ code: "F1" }))).toBe(false);
    expect(bindingTypesText(binding({ code: "Pause" }))).toBe(false);
    expect(bindingTypesText(binding({ code: "F25" }))).toBe(true);
  });

  it("a bare modifier engages while the composer has focus", () => {
    // THE BUG: focus sits in the composer while you read a text channel, and
    // this used to refuse every binding there, so push-to-talk looked like it
    // only worked on the voice channel's own view.
    const ctrlRight = binding({ code: "ControlRight" });
    expect(
      shouldEngage(keyEvent({ code: "ControlRight", ctrlKey: true, target: composer }), ctrlRight),
    ).toBe(true);
    expect(
      shouldEngage(keyEvent({ code: "ControlRight", ctrlKey: true, target: richTextSpan }), ctrlRight),
    ).toBe(true);
  });

  it("Right Alt (AltGr) does not engage in the composer, where it types @ and €", () => {
    const altRight = binding({ code: "AltRight" });
    expect(
      shouldEngage(keyEvent({ code: "AltRight", altKey: true, target: composer }), altRight),
    ).toBe(false);
    // Over the ordinary page it is still a perfectly good binding.
    expect(
      shouldEngage(keyEvent({ code: "AltRight", altKey: true, target: plainDiv }), altRight),
    ).toBe(true);
  });

  it("a Ctrl chord and a function key engage while the composer has focus", () => {
    const chord = binding({ code: "KeyT", ctrl: true });
    expect(
      shouldEngage(keyEvent({ code: "KeyT", ctrlKey: true, target: composer }), chord),
    ).toBe(true);
    const f13 = binding({ code: "F13" });
    expect(shouldEngage(keyEvent({ code: "F13", target: searchBox }), f13)).toBe(true);
  });

  it("a printable key still bows out of the composer", () => {
    expect(
      shouldEngage(
        keyEvent({ code: "Backquote", target: composer }),
        defaultPushToTalkBinding,
      ),
    ).toBe(false);
    const shifted = binding({ code: "KeyV", shift: true });
    expect(
      shouldEngage(keyEvent({ code: "KeyV", shiftKey: true, target: composer }), shifted),
    ).toBe(false);
  });

  it("a printable key engages over a focused slider or checkbox", () => {
    expect(
      shouldEngage(
        keyEvent({ code: "Backquote", target: { tagName: "INPUT", type: "range" } }),
        defaultPushToTalkBinding,
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

function mouseEvent(button: number): MouseEventLike {
  return { button };
}

describe("mouse-button push-to-talk bindings", () => {
  it("only offers middle click and the two extra side buttons", () => {
    expect(BINDABLE_MOUSE_CODES).toEqual([
      "MouseMiddle",
      "MouseButton4",
      "MouseButton5",
    ]);
  });

  it("mouseCodeFromButton maps the DOM button numbers that matter", () => {
    expect(mouseCodeFromButton(1)).toBe("MouseMiddle");
    expect(mouseCodeFromButton(3)).toBe("MouseButton4");
    expect(mouseCodeFromButton(4)).toBe("MouseButton5");
  });

  it("refuses left and right click, never a valid mouse code", () => {
    expect(mouseCodeFromButton(0)).toBeNull();
    expect(mouseCodeFromButton(2)).toBeNull();
    expect(mouseCodeFromButton(99)).toBeNull();
  });

  it("captureMouseBinding produces a labeled, device-tagged binding", () => {
    const outcome = captureMouseBinding(3);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.binding).toEqual({
        device: "mouse",
        code: "MouseButton4",
        label: "Mouse Button 4",
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
      });
    }
  });

  it("captureMouseBinding refuses left/right click", () => {
    expect(captureMouseBinding(0)).toEqual({ ok: false, reason: "refused" });
    expect(captureMouseBinding(2)).toEqual({ ok: false, reason: "refused" });
  });

  it("isBindableMouseCode narrows correctly", () => {
    expect(isBindableMouseCode("MouseMiddle")).toBe(true);
    expect(isBindableMouseCode("MouseButton6")).toBe(false);
    expect(isBindableMouseCode(42)).toBe(false);
    expect(isBindableMouseCode(undefined)).toBe(false);
  });

  it("matchesMouseBinding matches on code alone", () => {
    const binding = captureMouseBinding(4);
    expect(binding.ok).toBe(true);
    if (!binding.ok) return;
    expect(matchesMouseBinding(mouseEvent(4), binding.binding)).toBe(true);
    expect(matchesMouseBinding(mouseEvent(3), binding.binding)).toBe(false);
  });

  it("matchesMouseBinding refuses a keyboard-device binding", () => {
    const keyboardBinding: PttBinding = { ...defaultPttBinding() };
    expect(matchesMouseBinding(mouseEvent(1), keyboardBinding)).toBe(false);
  });

  it("shouldReleaseMouse is the same rule as matching, no chord to lose", () => {
    const binding = captureMouseBinding(4);
    expect(binding.ok).toBe(true);
    if (!binding.ok) return;
    expect(shouldReleaseMouse(mouseEvent(4), binding.binding)).toBe(true);
    expect(shouldReleaseMouse(mouseEvent(3), binding.binding)).toBe(false);
  });

  it("formatBinding prints a mouse binding's label untouched, no phantom chord", () => {
    const outcome = captureMouseBinding(3);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(formatBinding(outcome.binding)).toBe("Mouse Button 4");
    }
  });
});

describe("capturePttKeyboardBinding / capturePttModifierBinding", () => {
  it("tags a captured key with device: keyboard", () => {
    const outcome = capturePttKeyboardBinding(keyEvent({ code: "KeyT", key: "t" }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.binding.device).toBe("keyboard");
      expect(outcome.binding.code).toBe("KeyT");
    }
  });

  it("still refuses reserved codes", () => {
    expect(capturePttKeyboardBinding(keyEvent({ code: "Escape" }))).toEqual({
      ok: false,
      reason: "refused",
    });
  });

  it("tags a captured modifier with device: keyboard", () => {
    const binding = capturePttModifierBinding(keyEvent({ code: "ControlLeft" }));
    expect(binding.device).toBe("keyboard");
    expect(binding.code).toBe("ControlLeft");
  });
});

describe("parsePttBinding", () => {
  it("defaults a device-less stored blob to keyboard, old localStorage, pre-native-hook", () => {
    const stored = { code: "KeyT", label: "T", ctrl: true, alt: false, shift: false, meta: false };
    expect(parsePttBinding(stored)).toEqual({ ...stored, device: "keyboard" });
  });

  it("round-trips defaultPttBinding()", () => {
    expect(parsePttBinding(defaultPttBinding())).toEqual(defaultPttBinding());
  });

  it("parses a stored mouse binding", () => {
    const stored = { device: "mouse", code: "MouseButton5" };
    expect(parsePttBinding(stored)).toEqual({
      device: "mouse",
      code: "MouseButton5",
      label: "Mouse Button 5",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    });
  });

  it("refuses a mouse binding with an unrecognized code", () => {
    expect(parsePttBinding({ device: "mouse", code: "MouseLeft" })).toBeNull();
  });

  it("refuses a keyboard binding on a reserved code, same as parseBinding", () => {
    expect(parsePttBinding({ device: "keyboard", code: "Tab" })).toBeNull();
  });

  it("rejects junk", () => {
    expect(parsePttBinding(null)).toBeNull();
    expect(parsePttBinding("nope")).toBeNull();
    expect(parsePttBinding({})).toBeNull();
  });
});

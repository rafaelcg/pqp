import { describe, expect, it } from "vitest";
import {
  defaultPushToTalkBinding,
  type KeyBinding,
} from "@/components/voice/push-to-talk";
import { bindingToAccelerator } from "@/components/voice/push-to-talk-accelerator";

function binding(code: string, chord: Partial<KeyBinding> = {}): KeyBinding {
  return {
    code,
    label: code,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    ...chord,
  };
}

describe("bindingToAccelerator", () => {
  it("maps the default backquote binding", () => {
    expect(bindingToAccelerator(defaultPushToTalkBinding)).toBe("`");
  });

  it("names letters, digits, function keys and the numpad the way Electron spells them", () => {
    expect(bindingToAccelerator(binding("KeyT"))).toBe("T");
    expect(bindingToAccelerator(binding("Digit3"))).toBe("3");
    expect(bindingToAccelerator(binding("F13"))).toBe("F13");
    expect(bindingToAccelerator(binding("Numpad0"))).toBe("num0");
    expect(bindingToAccelerator(binding("NumpadAdd"))).toBe("numadd");
    expect(bindingToAccelerator(binding("Space"))).toBe("Space");
    expect(bindingToAccelerator(binding("CapsLock"))).toBe("Capslock");
  });

  it("carries the chord in Electron's order without CommandOrControl", () => {
    expect(
      bindingToAccelerator(binding("KeyV", { ctrl: true, shift: true })),
    ).toBe("Control+Shift+V");
    expect(bindingToAccelerator(binding("KeyV", { meta: true }))).toBe(
      "Super+V",
    );
    expect(bindingToAccelerator(binding("KeyV", { alt: true }))).toBe("Alt+V");
  });

  it("refuses modifier-only bindings: globalShortcut needs a real key", () => {
    expect(bindingToAccelerator(binding("ControlLeft"))).toBeNull();
    expect(bindingToAccelerator(binding("ShiftRight"))).toBeNull();
    expect(bindingToAccelerator(binding("MetaLeft"))).toBeNull();
  });

  it("refuses codes it has no spelling for rather than guessing", () => {
    expect(bindingToAccelerator(binding("IntlBackslash"))).toBeNull();
    expect(bindingToAccelerator(binding("F25"))).toBeNull();
    expect(bindingToAccelerator(binding(""))).toBeNull();
  });
});

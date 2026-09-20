import { describe, expect, it } from "vitest";
import type { KeyBinding } from "@/components/voice/push-to-talk";
import { defaultShortcutBindings } from "@/lib/keyboard-shortcuts";
import { globalVoiceHotkeyAccelerators } from "@/lib/global-voice-hotkeys";

describe("globalVoiceHotkeyAccelerators", () => {
  it("converts the default mute/deafen chords on Windows/Linux (Ctrl)", () => {
    const bindings = defaultShortcutBindings(false);
    expect(globalVoiceHotkeyAccelerators(bindings)).toEqual({
      toggleMute: "Control+Shift+M",
      toggleDeafen: "Control+Shift+D",
    });
  });

  it("converts the default mute/deafen chords on macOS (Cmd -> Super)", () => {
    const bindings = defaultShortcutBindings(true);
    expect(globalVoiceHotkeyAccelerators(bindings)).toEqual({
      toggleMute: "Shift+Super+M",
      toggleDeafen: "Shift+Super+D",
    });
  });

  it("follows a remap to a different key", () => {
    const bindings = defaultShortcutBindings(false);
    const remapped: KeyBinding = {
      code: "KeyN",
      label: "N",
      ctrl: true,
      alt: true,
      shift: false,
      meta: false,
    };
    expect(
      globalVoiceHotkeyAccelerators({ ...bindings, toggleDeafen: remapped }),
    ).toEqual({
      toggleMute: "Control+Shift+M",
      toggleDeafen: "Control+Alt+N",
    });
  });

  it("comes back null for a modifier-only binding, without touching the other action", () => {
    const bindings = defaultShortcutBindings(false);
    const modifierOnly: KeyBinding = {
      code: "ControlLeft",
      label: "Left Ctrl",
      ctrl: true,
      alt: false,
      shift: false,
      meta: false,
    };
    const result = globalVoiceHotkeyAccelerators({
      ...bindings,
      toggleMute: modifierOnly,
    });
    expect(result.toggleMute).toBeNull();
    expect(result.toggleDeafen).toBe("Control+Shift+D");
  });
});

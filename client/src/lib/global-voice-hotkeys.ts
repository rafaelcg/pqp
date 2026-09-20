import { bindingToAccelerator } from "@/components/voice/push-to-talk-accelerator";
import type { KeyBinding } from "@/components/voice/push-to-talk";
import type { ShortcutAction } from "@/lib/keyboard-shortcuts";

export interface GlobalVoiceHotkeyAccelerators {
  toggleMute: string | null;
  toggleDeafen: string | null;
}

/**
 * Turn the user's current toggle-mute / toggle-deafen key bindings into the
 * pair of Electron accelerators the desktop shell registers as global
 * hotkeys, so mute/deafen also work while pqp's window is not focused.
 *
 * Reuses `bindingToAccelerator`, built for push-to-talk: the conversion from
 * a physical `KeyBinding` to an accelerator string does not care what the
 * key does once pressed, only what it is. A binding that has no accelerator
 * spelling (a modifier held alone, or a code the map does not name) comes
 * back `null` for that one action, which is the shell's cue to let go of it
 * rather than register nothing and call it done; see `bindingToAccelerator`
 * for the full reasoning.
 *
 * Caller decides whether to send this at all: the shell should not hold a
 * global Cmd/Ctrl+Shift+M outside of a call, so this is only meant to be
 * computed and sent while connected, and cleared (both `null`) on leaving.
 */
export function globalVoiceHotkeyAccelerators(
  bindings: Pick<Record<ShortcutAction, KeyBinding>, "toggleMute" | "toggleDeafen">,
): GlobalVoiceHotkeyAccelerators {
  return {
    toggleMute: bindingToAccelerator(bindings.toggleMute),
    toggleDeafen: bindingToAccelerator(bindings.toggleDeafen),
  };
}

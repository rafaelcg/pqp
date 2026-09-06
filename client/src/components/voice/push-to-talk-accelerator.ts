import type { KeyBinding } from "@/components/voice/push-to-talk";

/**
 * Turn a push-to-talk binding into an Electron accelerator, or refuse.
 *
 * The binding is a *physical* key (`KeyboardEvent.code`), which is what makes
 * it layout-proof in the renderer. Electron's `globalShortcut` speaks a
 * different language: accelerator strings name the key by what it types on a
 * US layout (`A`, `1`, `` ` ``, `Space`, `F5`, `num0`). The two meet in the
 * middle here. The map is deliberately explicit rather than derived so that a
 * code with no accelerator spelling returns `null` and stays in-window only,
 * which is the outcome the hook needs in order to say the truth about it.
 *
 * Modifier-only bindings (Left Ctrl on its own, which is what a Discord user
 * reaches for first) are the notable `null`: `globalShortcut` requires a
 * non-modifier key, so those can only ever work while the window is focused.
 */
const CODE_TO_ACCELERATOR: Record<string, string> = {
  Space: "Space",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  CapsLock: "Capslock",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ScrollLock: "Scrolllock",
  Pause: "Pause",
  PrintScreen: "PrintScreen",
  NumLock: "Numlock",
  NumpadAdd: "numadd",
  NumpadSubtract: "numsub",
  NumpadMultiply: "nummult",
  NumpadDivide: "numdiv",
  NumpadDecimal: "numdec",
};

function keyNameForCode(code: string): string | null {
  const direct = CODE_TO_ACCELERATOR[code];
  if (direct) {
    return direct;
  }
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) {
    return letter[1];
  }
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) {
    return digit[1];
  }
  const numpad = /^Numpad([0-9])$/.exec(code);
  if (numpad) {
    return `num${numpad[1]}`;
  }
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (fn) {
    return `F${fn[1]}`;
  }
  return null;
}

/**
 * `null` means "no global hotkey for this binding"; the renderer keeps the
 * in-window behaviour it already has and the desktop shell is not asked.
 */
export function bindingToAccelerator(binding: KeyBinding): string | null {
  const key = keyNameForCode(binding.code);
  if (!key) {
    return null;
  }
  const parts: string[] = [];
  // `CommandOrControl` is avoided on purpose: the binding recorded which
  // modifier was down, and a Ctrl chord on macOS must stay a Ctrl chord.
  if (binding.ctrl) parts.push("Control");
  if (binding.alt) parts.push("Alt");
  if (binding.shift) parts.push("Shift");
  if (binding.meta) parts.push("Super");
  parts.push(key);
  return parts.join("+");
}

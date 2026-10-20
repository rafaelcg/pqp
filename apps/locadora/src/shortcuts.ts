/**
 * Locadora's own keyboard shortcuts (SPEC 4.4 and 8 of the locadora-ux-pass).
 *
 * The keys are exactly the ones the controller map refuses (`RESERVED_CODES` in
 * `keymap.ts`), minus the two that are not ours: Escape belongs to the browser
 * (it leaves full screen) and the menus, Tab is how a person walks into the HUD.
 * A test pins that the two lists never drift apart.
 *
 * `resolveShortcut` is a pure function from a key press to an action, so the
 * table can be tested without a document. `installShortcuts` is the thin DOM
 * half. Two rules live there, because they are what makes a shortcut safe:
 *  - nothing fires while a text field has focus (a rename field must never save
 *    a game, mute it or pause it), and the core's keyboard is switched off while
 *    one does, so typing never moves the character either;
 *  - a held Space is "turbo while held" and must always let go: on key up, on a
 *    lost window focus, on a hidden tab. A turbo that sticks is worse than none.
 */
import type { EmulatorRuntime } from "./runtime";

/** What a shortcut asks the HUD to do. `turbo-hold` carries its own phase, the rest are one shot. */
export type ShortcutAction =
  | "pause"
  | "save"
  | "slot-next"
  | "slot-prev"
  | "load"
  | "saves"
  | "turbo-toggle"
  | "controls"
  | "sound"
  | "fullscreen"
  | "eject";

export type ShortcutPhase = "down" | "up";

export type Shortcut = { action: ShortcutAction } | { action: "turbo-hold"; phase: ShortcutPhase };

/** The slice of a keyboard event the table reads (so tests need no DOM). */
export interface KeyPress {
  code: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

/** Key code to action. Shift+F3 is the one chord, handled in `resolveShortcut`. */
export const SHORTCUT_KEYS: Readonly<Record<string, ShortcutAction | "turbo-hold">> = {
  KeyP: "pause",
  F2: "save",
  F3: "slot-next",
  F4: "load",
  F6: "saves",
  KeyT: "turbo-toggle",
  Space: "turbo-hold",
  F1: "controls",
  KeyM: "sound",
  KeyF: "fullscreen",
  // Ejetar has no letter that is not a game button's: F8 is the one function key no browser takes
  F8: "eject",
};

/** Every code a shortcut uses, for the test that keeps it inside the reserved list. */
export const SHORTCUT_CODES: readonly string[] = Object.keys(SHORTCUT_KEYS);

/**
 * The shortcut a key press means, or null when it is not one. A chord with
 * Ctrl, Meta or Alt is the browser's (Ctrl+F, Cmd+P) and is never ours; Shift
 * only counts on F3, where it means "previous slot".
 */
export function resolveShortcut(press: KeyPress, phase: ShortcutPhase = "down"): Shortcut | null {
  if (press.isComposing || press.ctrlKey || press.metaKey || press.altKey) return null;
  const found = SHORTCUT_KEYS[press.code];
  if (found === undefined) return null;
  if (press.code === "F3" && press.shiftKey) return { action: "slot-prev" };
  // the function keys mean nothing with Shift held, except F3
  if (press.shiftKey && press.code.startsWith("F")) return null;
  if (found === "turbo-hold") return { action: "turbo-hold", phase };
  // a letter or function key only acts on the press, never on key up
  if (phase === "up") return null;
  return { action: found };
}

// "range" is here because a slider takes the arrow keys, Home, End and the page keys for itself: while one has focus
// the game must not also hear them, and no shortcut should fire from under a hand that is steering a value
const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number", "range", ""]);

/** A place where typing is for the text, not for the game or the shortcuts. */
export function isTextTarget(target: EventTarget | null): boolean {
  const node = target as Element | null;
  if (!node || typeof node.tagName !== "string") return false;
  const tag = node.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") return TEXT_INPUT_TYPES.has(((node as HTMLInputElement).type || "").toLowerCase());
  if ((node as HTMLElement).isContentEditable) return true;
  const editable = node.getAttribute("contenteditable");
  return editable !== null && editable !== "false";
}

/**
 * Something Space or Enter already means on its own (press the button, pick the
 * menu item). The turbo hold steps aside for it so a keyboard user can still
 * operate the HUD.
 */
export function isActivatable(target: EventTarget | null): boolean {
  const node = target as Element | null;
  if (!node || typeof node.tagName !== "string") return false;
  const tag = node.tagName.toLowerCase();
  if (tag === "button" || tag === "a" || tag === "summary") return true;
  if (tag === "input") return !isTextTarget(node);
  const role = node.getAttribute("role");
  return role !== null && /^(button|link|menuitem|menuitemcheckbox|menuitemradio|switch|tab|checkbox|radio|option)$/.test(role);
}

export interface ShortcutOptions {
  /** Where the keys are heard: the document of the frame. */
  target: Document;
  onShortcut: (shortcut: Shortcut) => void;
  /** Asked on every key: false while the stage is not on screen. */
  enabled?: () => boolean;
  /** Its keyboard is switched off while a text field has focus. */
  runtime?: Pick<EmulatorRuntime, "setKeyboard">;
}

/** Starts listening; the returned function stops and lets any held key go. */
export function installShortcuts(options: ShortcutOptions): () => void {
  const { target, onShortcut, runtime } = options;
  const enabled = options.enabled ?? (() => true);
  const win = target.defaultView;
  let holding = false;

  const release = () => {
    if (!holding) return;
    holding = false;
    onShortcut({ action: "turbo-hold", phase: "up" });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!enabled() || isTextTarget(event.target)) return;
    const shortcut = resolveShortcut(event, "down");
    if (!shortcut) return;
    // Space on a button presses the button; the hold only starts from the game or the page
    if (shortcut.action === "turbo-hold" && isActivatable(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (shortcut.action === "turbo-hold") {
      if (holding) return;
      holding = true;
    }
    onShortcut(shortcut);
  };

  const onKeyUp = (event: KeyboardEvent) => {
    // always let go, even if focus has since moved into a text field
    if (event.code === "Space" && holding) {
      event.preventDefault();
      release();
    }
  };

  // focusout fires before the new element has focus: `relatedTarget` is where it is going
  const onFocusIn = (event: FocusEvent) => runtime?.setKeyboard(!isTextTarget(event.target));
  const onFocusOut = (event: FocusEvent) => runtime?.setKeyboard(!isTextTarget(event.relatedTarget));
  const onVisibility = () => {
    if (target.hidden) release();
  };

  target.addEventListener("keydown", onKeyDown, true);
  target.addEventListener("keyup", onKeyUp, true);
  target.addEventListener("focusin", onFocusIn);
  target.addEventListener("focusout", onFocusOut);
  target.addEventListener("visibilitychange", onVisibility);
  win?.addEventListener("blur", release);

  return () => {
    release();
    target.removeEventListener("keydown", onKeyDown, true);
    target.removeEventListener("keyup", onKeyUp, true);
    target.removeEventListener("focusin", onFocusIn);
    target.removeEventListener("focusout", onFocusOut);
    target.removeEventListener("visibilitychange", onVisibility);
    win?.removeEventListener("blur", release);
  };
}

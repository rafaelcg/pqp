/**
 * Push-to-talk key binding: the pure half.
 *
 * Nothing here touches the DOM or React — it is the decision table that
 * `use-push-to-talk.ts` drives and that the unit suite pins, because the two
 * ways this feature fails are both decisions rather than plumbing:
 *
 * 1. **The key fires while you are typing.** Holding "T" in a message would
 *    open your mic mid-sentence, which is precisely the failure that makes
 *    people distrust push-to-talk and never turn it on. `isTextEntryTarget`
 *    is the trap, and `shouldEngage` is the only place allowed to say yes.
 *
 * 2. **The key never un-fires.** A mic that is stuck open is strictly worse
 *    than one that never opened. So the asymmetry below is deliberate and load
 *    bearing: *engaging* is filtered six ways, *releasing* is filtered by
 *    nothing at all. `shouldRelease` deliberately ignores the event target, the
 *    modifier state and the focus state — if a keyup that could plausibly be
 *    this binding arrives, the mic closes.
 */

/** A physical key plus the chord that must be down with it. */
export interface KeyBinding {
  /**
   * `KeyboardEvent.code`, not `.key`. The binding is a *place on the keyboard*:
   * a French user who binds the key left of "1" gets the same physical key back
   * regardless of what character it produces, and Shift does not turn "1" into
   * "!" and lose the match.
   */
  code: string;
  /** What to print. Captured from `event.key` at bind time — layout-aware. */
  label: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/**
 * Backquote: present on every layout this app targets, types nothing anyone
 * misses, and is not a browser or OS shortcut on any platform. Left Ctrl would
 * be the more Discord-ish default but it prefixes half the app's own shortcuts.
 */
export const defaultPushToTalkBinding: KeyBinding = {
  code: "Backquote",
  label: "`",
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
};

/**
 * Keys that would break the app if we swallowed them.
 *
 * Escape closes dialogs and cancels the capture itself; Tab is the only way to
 * move focus without a mouse, and a screen-reader user who lost it would have
 * no way back; Enter sends the message. A binding that has to be held for
 * seconds at a time cannot be any of them.
 */
const REFUSED_CODES = new Set([
  "Escape",
  "Tab",
  "Enter",
  "NumpadEnter",
  "Backspace",
  "Delete",
]);

const MODIFIER_LABELS: Record<string, string> = {
  ControlLeft: "Left Ctrl",
  ControlRight: "Right Ctrl",
  ShiftLeft: "Left Shift",
  ShiftRight: "Right Shift",
  AltLeft: "Left Alt",
  AltRight: "Right Alt",
  MetaLeft: "Left Cmd",
  MetaRight: "Right Cmd",
};

export function isModifierCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(MODIFIER_LABELS, code);
}

/**
 * The minimum of `KeyboardEvent` this module reads.
 *
 * A structural type rather than the DOM one so the tests can hand it plain
 * objects — the environment for the unit suite is `node`, with no DOM at all.
 */
export interface KeyEventLike {
  code: string;
  key?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  target?: unknown;
}

/** Shape of a DOM element, as far as the focus trap needs to know. */
interface ElementLike {
  tagName?: unknown;
  isContentEditable?: unknown;
  type?: unknown;
  getAttribute?: (name: string) => string | null;
}

const TEXTUAL_ROLES = new Set(["textbox", "searchbox", "combobox"]);

/**
 * Is this event aimed at somewhere a person types?
 *
 * Deliberately generous. `<input>` is blocked whatever its `type` is, including
 * checkboxes and ranges where the letter would not have produced a character:
 * the cost of a false positive is "push-to-talk did not engage while you were
 * fiddling with a slider", and the cost of a false negative is a hot mic in the
 * middle of a sentence. Those are not the same size of mistake.
 */
export function isTextEntryTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") {
    return false;
  }
  const element = target as ElementLike;

  // Walks up on its own: a `<span>` inside a contenteditable composer reports
  // true, which is exactly the case a naive tagName check misses.
  if (element.isContentEditable === true) {
    return true;
  }

  const tag =
    typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }

  if (typeof element.getAttribute === "function") {
    const role = element.getAttribute("role");
    if (role && TEXTUAL_ROLES.has(role)) {
      return true;
    }
    // A custom editor that sets the attribute but is not an HTMLElement in this
    // realm (so `isContentEditable` is undefined) still counts.
    const editable = element.getAttribute("contenteditable");
    if (editable !== null && editable !== "false") {
      return true;
    }
  }

  return false;
}

/**
 * Does this keydown match the binding *and* land somewhere it is allowed to?
 *
 * Every clause is a reason someone would otherwise have been transmitting
 * without meaning to.
 */
export function shouldEngage(
  event: KeyEventLike,
  binding: KeyBinding,
): boolean {
  // An auto-repeat from a key we are already holding. Not wrong, just nothing
  // new to do; the caller treats engage as idempotent anyway.
  if (event.repeat) {
    return false;
  }
  // Mid-IME composition: every keystroke is going into the candidate window.
  if (event.isComposing) {
    return false;
  }
  if (isTextEntryTarget(event.target)) {
    return false;
  }
  if (event.code !== binding.code) {
    return false;
  }
  // A modifier bound on its own carries its chord in the key itself; asking for
  // `ctrlKey === false` while the bound key *is* Control never matches.
  if (isModifierCode(binding.code)) {
    return true;
  }
  return (
    event.ctrlKey === binding.ctrl &&
    event.altKey === binding.alt &&
    event.shiftKey === binding.shift &&
    event.metaKey === binding.meta
  );
}

/**
 * Does this keyup end the transmission?
 *
 * Note what is *not* checked: the target, whether focus moved into an input
 * while the key was down, and whether the chord still holds. Click into the
 * composer mid-transmission and the keyup arrives with an `<input>` as its
 * target — filtering that the way `shouldEngage` does would leave the mic open
 * forever. Releasing any part of the chord ends it too, because letting go of
 * Ctrl in "Ctrl+T" would otherwise leave "T" held with no matching keyup in
 * sight on some platforms.
 */
export function shouldRelease(
  event: KeyEventLike,
  binding: KeyBinding,
): boolean {
  if (event.code === binding.code) {
    return true;
  }
  if (isModifierCode(binding.code)) {
    return false;
  }
  return (
    (binding.ctrl && !event.ctrlKey) ||
    (binding.alt && !event.altKey) ||
    (binding.shift && !event.shiftKey) ||
    (binding.meta && !event.metaKey)
  );
}

export function labelForEvent(event: KeyEventLike): string {
  const modifier = MODIFIER_LABELS[event.code];
  if (modifier) {
    return modifier;
  }
  const key = event.key ?? "";
  if (key.length === 1) {
    return key === " " ? "Space" : key.toUpperCase();
  }
  if (key) {
    return key;
  }
  return event.code;
}

export type CaptureOutcome =
  | { ok: true; binding: KeyBinding }
  | { ok: false; reason: "refused" };

/**
 * Turn a captured keydown into a binding, or refuse it.
 *
 * Modifiers are *not* captured here — the caller waits for their keyup, so that
 * "Ctrl" and "Ctrl+Q" are both reachable rather than the first one swallowing
 * the second. See `captureModifier`.
 */
export function captureBinding(event: KeyEventLike): CaptureOutcome {
  if (REFUSED_CODES.has(event.code)) {
    return { ok: false, reason: "refused" };
  }
  return {
    ok: true,
    binding: {
      code: event.code,
      label: labelForEvent(event),
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
    },
  };
}

/** A modifier held and released on its own is a perfectly good binding. */
export function captureModifier(event: KeyEventLike): KeyBinding {
  return {
    code: event.code,
    label: labelForEvent(event),
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  };
}

export function formatBinding(binding: KeyBinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push("Ctrl");
  if (binding.alt) parts.push("Alt");
  if (binding.shift) parts.push("Shift");
  if (binding.meta) parts.push("Cmd");
  parts.push(binding.label);
  return parts.join(" + ");
}

/** Narrow whatever came back out of `localStorage` to a usable binding. */
export function parseBinding(value: unknown): KeyBinding | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<KeyBinding>;
  if (typeof raw.code !== "string" || raw.code === "") {
    return null;
  }
  if (REFUSED_CODES.has(raw.code)) {
    return null;
  }
  return {
    code: raw.code,
    label: typeof raw.label === "string" && raw.label ? raw.label : raw.code,
    ctrl: raw.ctrl === true,
    alt: raw.alt === true,
    shift: raw.shift === true,
    meta: raw.meta === true,
  };
}

/**
 * Can this device usefully bind a key at all?
 *
 * A phone has no keyboard that is up while the app is in the foreground and not
 * covering half the screen, so offering a "press a key to bind" field there is
 * worse than offering nothing. Coarse pointer with no hover is the pair that
 * actually separates a phone from a laptop; a tablet with a keyboard case
 * reports a fine pointer once one is attached and gets the field.
 */
export function supportsKeyBinding(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    // No way to ask — assume a keyboard rather than hide the feature.
    return true;
  }
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

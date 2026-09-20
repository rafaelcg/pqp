/**
 * Translate `uiohook-napi` keycodes and mouse buttons into the vocabulary
 * the rest of the app already speaks.
 *
 * The renderer's push-to-talk binding is a `KeyboardEvent.code` string
 * (`client/src/components/voice/push-to-talk.ts`) because that is what the
 * web has to work with and it is layout-proof. `uiohook-napi` speaks a
 * different, numeric vocabulary borrowed from libuiohook's virtual keycodes
 * (its own `UiohookKey` map, `dist/index.js` in the installed package).
 * Nothing about that vocabulary is derivable from ours, so this is a table,
 * the same way `push-to-talk-accelerator.ts` is a table rather than a
 * formula for the DOM-code-to-Electron-accelerator direction. The numeric
 * values below are copied from that file (pinned at the `uiohook-napi`
 * version in `package.json`), not guessed from the scan-code pattern, since
 * several of them (the NumLock-off numpad "navigation" keys) are a
 * synthesized `0xEE00 | scancode`, not the plain scan code you would expect.
 *
 * Pure data plus pure lookups, no `require("uiohook-napi")` in this file,
 * so it is unit-testable without the native binary.
 */

/**
 * uiohook keycode → DOM `KeyboardEvent.code`.
 *
 * The Numpad rows appear twice on purpose: once for the plain digit
 * (NumLock on) and once for the alternate keycode uiohook reports when
 * NumLock is off and the key acts as its "navigation" function (End, arrow,
 * Home, Page Up/Down, Insert, Delete). The DOM `code` for a numpad key is the
 * same physical key either way (`.code` never changes with NumLock, only
 * `.key` does), so both keycodes map to the same `NumpadN` string. Skipping
 * the alternate keycodes would mean a binding on `Numpad1` silently stops
 * matching the instant somebody's NumLock is off.
 */
const KEYCODE_TO_CODE = {
  0x000e: "Backspace",
  0x000f: "Tab",
  0x001c: "Enter",
  0x003a: "CapsLock",
  0x0001: "Escape",
  0x0039: "Space",
  0x0e49: "PageUp",
  0x0e51: "PageDown",
  0x0e4f: "End",
  0x0e47: "Home",
  0xe04b: "ArrowLeft",
  0xe048: "ArrowUp",
  0xe04d: "ArrowRight",
  0xe050: "ArrowDown",
  0x0e52: "Insert",
  0x0e53: "Delete",

  0x000b: "Digit0",
  0x0002: "Digit1",
  0x0003: "Digit2",
  0x0004: "Digit3",
  0x0005: "Digit4",
  0x0006: "Digit5",
  0x0007: "Digit6",
  0x0008: "Digit7",
  0x0009: "Digit8",
  0x000a: "Digit9",

  0x001e: "KeyA",
  0x0030: "KeyB",
  0x002e: "KeyC",
  0x0020: "KeyD",
  0x0012: "KeyE",
  0x0021: "KeyF",
  0x0022: "KeyG",
  0x0023: "KeyH",
  0x0017: "KeyI",
  0x0024: "KeyJ",
  0x0025: "KeyK",
  0x0026: "KeyL",
  0x0032: "KeyM",
  0x0031: "KeyN",
  0x0018: "KeyO",
  0x0019: "KeyP",
  0x0010: "KeyQ",
  0x0013: "KeyR",
  0x001f: "KeyS",
  0x0014: "KeyT",
  0x0016: "KeyU",
  0x002f: "KeyV",
  0x0011: "KeyW",
  0x002d: "KeyX",
  0x0015: "KeyY",
  0x002c: "KeyZ",

  // Numpad digits (NumLock on).
  0x0052: "Numpad0",
  0x004f: "Numpad1",
  0x0050: "Numpad2",
  0x0051: "Numpad3",
  0x004b: "Numpad4",
  0x004c: "Numpad5",
  0x004d: "Numpad6",
  0x0047: "Numpad7",
  0x0048: "Numpad8",
  0x0049: "Numpad9",
  0x0037: "NumpadMultiply",
  0x004e: "NumpadAdd",
  0x004a: "NumpadSubtract",
  0x0053: "NumpadDecimal",
  0x0e35: "NumpadDivide",
  0x0e1c /* NumpadEnter = 0x0E00 | 0x001C */: "NumpadEnter",

  // Numpad navigation keycodes (NumLock off), `0xEE00 | scancode`, a
  // synthesized value uiohook uses to disambiguate these from the plain
  // Insert/Delete/Home/End/Page/Arrow keys above, which have different,
  // non-`0xEE`-prefixed codes of their own.
  0xee4f /* NumpadEnd */: "Numpad1",
  0xee50 /* NumpadArrowDown */: "Numpad2",
  0xee51 /* NumpadPageDown */: "Numpad3",
  0xee4b /* NumpadArrowLeft */: "Numpad4",
  0xee4d /* NumpadArrowRight */: "Numpad6",
  0xee47 /* NumpadHome */: "Numpad7",
  0xee48 /* NumpadArrowUp */: "Numpad8",
  0xee49 /* NumpadPageUp */: "Numpad9",
  0xee52 /* NumpadInsert */: "Numpad0",
  0xee53 /* NumpadDelete */: "NumpadDecimal",

  0x003b: "F1",
  0x003c: "F2",
  0x003d: "F3",
  0x003e: "F4",
  0x003f: "F5",
  0x0040: "F6",
  0x0041: "F7",
  0x0042: "F8",
  0x0043: "F9",
  0x0044: "F10",
  0x0057: "F11",
  0x0058: "F12",
  0x005b: "F13",
  0x005c: "F14",
  0x005d: "F15",
  0x0063: "F16",
  0x0064: "F17",
  0x0065: "F18",
  0x0066: "F19",
  0x0067: "F20",
  0x0068: "F21",
  0x0069: "F22",
  0x006a: "F23",
  0x006b: "F24",

  0x0027: "Semicolon",
  0x000d: "Equal",
  0x0033: "Comma",
  0x000c: "Minus",
  0x0034: "Period",
  0x0035: "Slash",
  0x0029: "Backquote",
  0x001a: "BracketLeft",
  0x002b: "Backslash",
  0x001b: "BracketRight",
  0x0028: "Quote",

  0x001d: "ControlLeft",
  0x0e1d: "ControlRight",
  0x0038: "AltLeft",
  0x0e38: "AltRight",
  0x002a: "ShiftLeft",
  0x0036: "ShiftRight",
  0x0e5b: "MetaLeft",
  0x0e5c: "MetaRight",

  0x0045: "NumLock",
  0x0046: "ScrollLock",
  0x0e37: "PrintScreen",
};

/** @param {number} keycode uiohook's `UiohookKeyboardEvent.keycode` */
function codeFromUiohookKeycode(keycode) {
  return KEYCODE_TO_CODE[keycode] ?? null;
}

/**
 * Mouse buttons. libuiohook numbers 1/2/3 as left/right/middle and 4/5 as
 * the two "extra" side buttons most mice ship (back/forward). Left and right
 * are deliberately not offered as bindable (see `BINDABLE_MOUSE_BUTTONS`),
 * because a push-to-talk key that is also how you click things would make
 * every click a transmission.
 */
const MOUSE_BUTTON_TO_CODE = {
  3: "MouseMiddle",
  4: "MouseButton4",
  5: "MouseButton5",
};

const CODE_TO_MOUSE_BUTTON = {
  MouseMiddle: 3,
  MouseButton4: 4,
  MouseButton5: 5,
};

/** What the settings UI prints for each bindable mouse button. */
const MOUSE_BUTTON_LABELS = {
  MouseMiddle: "Middle Click",
  MouseButton4: "Mouse Button 4",
  MouseButton5: "Mouse Button 5",
};

/** Bindable mouse buttons, in the order the UI should offer them. */
const BINDABLE_MOUSE_BUTTONS = ["MouseMiddle", "MouseButton4", "MouseButton5"];

/** @param {number} button uiohook's `UiohookMouseEvent.button` */
function mouseCodeFromUiohookButton(button) {
  return MOUSE_BUTTON_TO_CODE[button] ?? null;
}

/** @param {string} code One of `BINDABLE_MOUSE_BUTTONS` */
function uiohookButtonFromMouseCode(code) {
  return CODE_TO_MOUSE_BUTTON[code] ?? null;
}

module.exports = {
  KEYCODE_TO_CODE,
  codeFromUiohookKeycode,
  MOUSE_BUTTON_TO_CODE,
  CODE_TO_MOUSE_BUTTON,
  MOUSE_BUTTON_LABELS,
  BINDABLE_MOUSE_BUTTONS,
  mouseCodeFromUiohookButton,
  uiohookButtonFromMouseCode,
};

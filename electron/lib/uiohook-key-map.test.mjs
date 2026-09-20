import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const {
  codeFromUiohookKeycode,
  mouseCodeFromUiohookButton,
  uiohookButtonFromMouseCode,
  BINDABLE_MOUSE_BUTTONS,
  MOUSE_BUTTON_LABELS,
} = require("./uiohook-key-map.js");

describe("codeFromUiohookKeycode", () => {
  it("maps letters, digits and common named keys", () => {
    assert.equal(codeFromUiohookKeycode(0x0010), "KeyQ");
    assert.equal(codeFromUiohookKeycode(0x0002), "Digit1");
    assert.equal(codeFromUiohookKeycode(0x0039), "Space");
    assert.equal(codeFromUiohookKeycode(0x0029), "Backquote");
    assert.equal(codeFromUiohookKeycode(0x003b), "F1");
  });

  it("distinguishes left and right modifiers", () => {
    assert.equal(codeFromUiohookKeycode(0x001d), "ControlLeft");
    assert.equal(codeFromUiohookKeycode(0x0e1d), "ControlRight");
    assert.equal(codeFromUiohookKeycode(0x0038), "AltLeft");
    assert.equal(codeFromUiohookKeycode(0x0e38), "AltRight");
    assert.equal(codeFromUiohookKeycode(0x002a), "ShiftLeft");
    assert.equal(codeFromUiohookKeycode(0x0036), "ShiftRight");
    assert.equal(codeFromUiohookKeycode(0x0e5b), "MetaLeft");
    assert.equal(codeFromUiohookKeycode(0x0e5c), "MetaRight");
  });

  it("maps a numpad digit the same way regardless of NumLock", () => {
    // NumLock on: the plain digit keycode.
    assert.equal(codeFromUiohookKeycode(0x004f), "Numpad1");
    // NumLock off: uiohook's synthesized 0xEE00-prefixed "NumpadEnd" keycode
    // for the very same physical key.
    assert.equal(codeFromUiohookKeycode(0xee4f), "Numpad1");

    assert.equal(codeFromUiohookKeycode(0x0052), "Numpad0");
    assert.equal(codeFromUiohookKeycode(0xee52), "Numpad0");

    assert.equal(codeFromUiohookKeycode(0x0053), "NumpadDecimal");
    assert.equal(codeFromUiohookKeycode(0xee53), "NumpadDecimal");
  });

  it("does not confuse the numpad Enter with the main Enter", () => {
    // Both report DOM code "Enter"? No. The DOM distinguishes NumpadEnter
    // from Enter, and so does this table.
    assert.equal(codeFromUiohookKeycode(0x001c), "Enter");
    assert.equal(codeFromUiohookKeycode(0x0e1c), "NumpadEnter");
  });

  it("does not confuse Insert/Delete with the numpad-off aliases", () => {
    assert.equal(codeFromUiohookKeycode(0x0e52), "Insert");
    assert.equal(codeFromUiohookKeycode(0x0e53), "Delete");
    // The numpad aliases are a different numeric value (0xEE.. vs 0x0E..)
    // and land on the numpad codes, not Insert/Delete.
    assert.notEqual(codeFromUiohookKeycode(0xee52), "Insert");
    assert.notEqual(codeFromUiohookKeycode(0xee53), "Delete");
  });

  it("returns null for an unrecognized keycode", () => {
    assert.equal(codeFromUiohookKeycode(0xffffff), null);
    assert.equal(codeFromUiohookKeycode(-1), null);
  });
});

describe("mouse button mapping", () => {
  it("maps uiohook's middle/extra buttons to our codes", () => {
    assert.equal(mouseCodeFromUiohookButton(3), "MouseMiddle");
    assert.equal(mouseCodeFromUiohookButton(4), "MouseButton4");
    assert.equal(mouseCodeFromUiohookButton(5), "MouseButton5");
  });

  it("refuses left and right click, never bindable", () => {
    assert.equal(mouseCodeFromUiohookButton(1), null);
    assert.equal(mouseCodeFromUiohookButton(2), null);
  });

  it("round-trips through uiohookButtonFromMouseCode", () => {
    for (const code of BINDABLE_MOUSE_BUTTONS) {
      const button = uiohookButtonFromMouseCode(code);
      assert.equal(mouseCodeFromUiohookButton(button), code);
    }
  });

  it("every bindable mouse button has a human label", () => {
    for (const code of BINDABLE_MOUSE_BUTTONS) {
      assert.equal(typeof MOUSE_BUTTON_LABELS[code], "string");
      assert.ok(MOUSE_BUTTON_LABELS[code].length > 0);
    }
  });

  it("uiohookButtonFromMouseCode refuses an unknown code", () => {
    assert.equal(uiohookButtonFromMouseCode("MouseLeft"), null);
    assert.equal(uiohookButtonFromMouseCode("nonsense"), null);
  });
});

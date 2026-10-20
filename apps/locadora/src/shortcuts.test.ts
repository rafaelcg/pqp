// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { RESERVED_CODES } from "./keymap";
import {
  installShortcuts,
  isActivatable,
  isTextTarget,
  resolveShortcut,
  SHORTCUT_CODES,
  type Shortcut,
} from "./shortcuts";

function key(target: EventTarget, type: "keydown" | "keyup", init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("the shortcut table", () => {
  it("uses exactly the keys the controller map reserves, minus Escape and Tab", () => {
    // a game button on one of these would fire both, so the map refuses them (SPEC 8)
    for (const code of SHORTCUT_CODES) expect(RESERVED_CODES.has(code), code).toBe(true);
    const unused = [...RESERVED_CODES].filter((code) => !SHORTCUT_CODES.includes(code)).sort();
    expect(unused).toEqual(["Escape", "Tab"]);
  });

  it("maps each key to its action", () => {
    const action = (code: string, extra: Partial<KeyboardEventInit> = {}) => resolveShortcut({ code, ...extra });
    expect(action("KeyP")).toEqual({ action: "pause" });
    expect(action("F2")).toEqual({ action: "save" });
    expect(action("F3")).toEqual({ action: "slot-next" });
    expect(action("F3", { shiftKey: true })).toEqual({ action: "slot-prev" });
    expect(action("F4")).toEqual({ action: "load" });
    expect(action("F6")).toEqual({ action: "saves" });
    expect(action("KeyT")).toEqual({ action: "turbo-toggle" });
    expect(action("F1")).toEqual({ action: "controls" });
    expect(action("KeyM")).toEqual({ action: "sound" });
    expect(action("KeyF")).toEqual({ action: "fullscreen" });
    expect(action("F8")).toEqual({ action: "eject" });
    // Shift+F8 is not Ejetar: only F3 has a Shift form
    expect(action("F8", { shiftKey: true })).toBeNull();
    expect(resolveShortcut({ code: "Space" }, "down")).toEqual({ action: "turbo-hold", phase: "down" });
    expect(resolveShortcut({ code: "Space" }, "up")).toEqual({ action: "turbo-hold", phase: "up" });
  });

  it("leaves the browser's chords, other keys and game keys alone", () => {
    for (const mod of ["ctrlKey", "metaKey", "altKey"] as const) {
      expect(resolveShortcut({ code: "KeyF", [mod]: true }), mod).toBeNull();
      expect(resolveShortcut({ code: "KeyP", [mod]: true }), mod).toBeNull();
      expect(resolveShortcut({ code: "Space", [mod]: true }), mod).toBeNull();
    }
    for (const code of ["KeyZ", "KeyX", "Enter", "ArrowUp", "Escape", "Tab", "F5", "F12", "KeyA"]) {
      expect(resolveShortcut({ code }), code).toBeNull();
    }
    expect(resolveShortcut({ code: "F2", shiftKey: true })).toBeNull();
    expect(resolveShortcut({ code: "KeyP", isComposing: true })).toBeNull();
  });

  it("acts on the press, not on the release, except for the turbo hold", () => {
    expect(resolveShortcut({ code: "KeyP" }, "up")).toBeNull();
    expect(resolveShortcut({ code: "F2" }, "up")).toBeNull();
  });
});

describe("what counts as a text field", () => {
  it("is every place typing means text", () => {
    const make = (html: string) => {
      document.body.innerHTML = html;
      return document.body.firstElementChild;
    };
    expect(isTextTarget(make('<input type="text">'))).toBe(true);
    expect(isTextTarget(make("<input>"))).toBe(true);
    expect(isTextTarget(make('<input type="search">'))).toBe(true);
    expect(isTextTarget(make("<textarea></textarea>"))).toBe(true);
    expect(isTextTarget(make("<select></select>"))).toBe(true);
    expect(isTextTarget(make('<div contenteditable="true"></div>'))).toBe(true);
    expect(isTextTarget(make('<input type="checkbox">'))).toBe(false);
    // a slider takes the arrows and Home and End for itself, so the game and the shortcuts stand aside
    expect(isTextTarget(make('<input type="range">'))).toBe(true);
    expect(isTextTarget(make("<button></button>"))).toBe(false);
    expect(isTextTarget(make("<canvas></canvas>"))).toBe(false);
    expect(isTextTarget(null)).toBe(false);
  });

  it("knows what Space already means on its own", () => {
    const make = (html: string) => {
      document.body.innerHTML = html;
      return document.body.firstElementChild;
    };
    expect(isActivatable(make("<button></button>"))).toBe(true);
    expect(isActivatable(make('<div role="menuitemradio"></div>'))).toBe(true);
    expect(isActivatable(make('<input type="checkbox">'))).toBe(true);
    expect(isActivatable(make("<canvas></canvas>"))).toBe(false);
    expect(isActivatable(make("<div></div>"))).toBe(false);
  });
});

describe("installShortcuts", () => {
  let heard: Shortcut[];
  let stop: () => void;
  let setKeyboard: Mock<(enabled: boolean) => void>;
  let enabled: boolean;

  beforeEach(() => {
    document.body.innerHTML = '<canvas id="game" tabindex="0"></canvas><input id="name" type="text"><button id="btn">ok</button>';
    heard = [];
    enabled = true;
    setKeyboard = vi.fn<(enabled: boolean) => void>();
    stop = installShortcuts({ target: document, onShortcut: (s) => heard.push(s), enabled: () => enabled, runtime: { setKeyboard } });
  });

  afterEach(() => stop());

  const game = () => document.getElementById("game")!;
  const field = () => document.getElementById("name") as HTMLInputElement;

  it("fires from the game and stops the key from reaching anything else", () => {
    const event = key(game(), "keydown", { code: "KeyP" });
    expect(heard).toEqual([{ action: "pause" }]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores every shortcut while a text field has focus", () => {
    field().focus();
    for (const code of ["KeyP", "KeyM", "KeyF", "KeyT", "F2", "F3", "F4", "F6", "F1", "Space"]) {
      const event = key(field(), "keydown", { code });
      expect(event.defaultPrevented, code).toBe(false);
    }
    key(field(), "keyup", { code: "Space" });
    expect(heard).toEqual([]);
  });

  it("switches the game's keyboard off while a text field has focus and back on after", () => {
    field().focus();
    expect(setKeyboard).toHaveBeenLastCalledWith(false);
    field().blur();
    expect(setKeyboard).toHaveBeenLastCalledWith(true);
  });

  it("holds turbo from key down to key up, once, however long the key repeats", () => {
    key(game(), "keydown", { code: "Space" });
    key(game(), "keydown", { code: "Space", repeat: true });
    key(game(), "keydown", { code: "Space", repeat: true });
    expect(heard).toEqual([{ action: "turbo-hold", phase: "down" }]);
    key(game(), "keyup", { code: "Space" });
    expect(heard).toEqual([
      { action: "turbo-hold", phase: "down" },
      { action: "turbo-hold", phase: "up" },
    ]);
    // a stray key up with nothing held says nothing
    key(game(), "keyup", { code: "Space" });
    expect(heard).toHaveLength(2);
  });

  it("lets Space press the button it is on instead of holding turbo", () => {
    const button = document.getElementById("btn")!;
    button.focus();
    const event = key(button, "keydown", { code: "Space" });
    expect(event.defaultPrevented).toBe(false);
    expect(heard).toEqual([]);
    // the letters still work from a button
    key(button, "keydown", { code: "KeyP" });
    expect(heard).toEqual([{ action: "pause" }]);
  });

  it("lets go of a held turbo when the key up lands in a text field, or the window loses focus", () => {
    key(game(), "keydown", { code: "Space" });
    field().focus();
    key(field(), "keyup", { code: "Space" });
    expect(heard.at(-1)).toEqual({ action: "turbo-hold", phase: "up" });

    heard.length = 0;
    key(game(), "keydown", { code: "Space" });
    window.dispatchEvent(new Event("blur"));
    expect(heard).toEqual([
      { action: "turbo-hold", phase: "down" },
      { action: "turbo-hold", phase: "up" },
    ]);
  });

  it("does nothing while disabled, and lets go on removal", () => {
    enabled = false;
    key(game(), "keydown", { code: "KeyP" });
    expect(heard).toEqual([]);
    enabled = true;
    key(game(), "keydown", { code: "Space" });
    stop();
    expect(heard.at(-1)).toEqual({ action: "turbo-hold", phase: "up" });
    heard.length = 0;
    key(game(), "keydown", { code: "KeyP" });
    expect(heard).toEqual([]);
  });

  it("does not take the browser's own chords", () => {
    const event = key(game(), "keydown", { code: "KeyF", ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(heard).toEqual([]);
  });
});

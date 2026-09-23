import { describe, expect, it } from "vitest";
import { defaultPttBinding, type PttBinding } from "./push-to-talk";
import { attachPushToTalkListeners } from "./push-to-talk-listeners";

/**
 * The listener wiring against real `EventTarget`s, which Node has. What the
 * pure suite (`push-to-talk.test.ts`) cannot show is that the right events are
 * listened for at all, and that every way out ends a transmission.
 */

class FakeDocument extends EventTarget {
  visibilityState = "visible";
}

function key(
  type: "keydown" | "keyup",
  init: Partial<KeyboardEventInit> & {
    code: string;
    target?: unknown;
    altGraph?: boolean;
  },
) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, {
    code: init.code,
    key: init.key ?? "",
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    metaKey: init.metaKey ?? false,
    repeat: init.repeat ?? false,
    isComposing: false,
    getModifierState: (name: string) =>
      name === "AltGraph" && init.altGraph === true,
  });
  // `target` is read-only on a real Event; the handlers only read it.
  Object.defineProperty(event, "target", {
    value: init.target ?? { tagName: "BODY" },
  });
  return event;
}

function mouse(type: "mousedown" | "mouseup", button: number) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { button });
  return event;
}

function setup(binding: PttBinding = defaultPttBinding()) {
  const win = new EventTarget();
  const doc = new FakeDocument();
  const log: boolean[] = [];
  let held = false;
  const detach = attachPushToTalkListeners(win, doc, binding, (next) => {
    held = next;
    log.push(next);
  });
  return { win, doc, log, detach, isHeld: () => held };
}

const composer = { tagName: "TEXTAREA" };
const leftCtrl: PttBinding = {
  device: "keyboard",
  code: "ControlLeft",
  label: "Left Ctrl",
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
};

describe("push-to-talk listeners: where it works", () => {
  it("opens on keydown and closes on keyup from an ordinary page", () => {
    const { win, isHeld } = setup();
    win.dispatchEvent(key("keydown", { code: "Backquote" }));
    expect(isHeld()).toBe(true);
    win.dispatchEvent(key("keyup", { code: "Backquote" }));
    expect(isHeld()).toBe(false);
  });

  it("a printable key typed into the composer does not transmit and is not swallowed", () => {
    const { win, isHeld } = setup();
    const down = key("keydown", { code: "Backquote", target: composer });
    win.dispatchEvent(down);
    expect(isHeld()).toBe(false);
    expect(down.defaultPrevented).toBe(false);
  });

  it("a modifier binding transmits from the composer without eating the keystroke", () => {
    const { win, isHeld } = setup(leftCtrl);
    const down = key("keydown", {
      code: "ControlLeft",
      ctrlKey: true,
      target: composer,
    });
    win.dispatchEvent(down);
    expect(isHeld()).toBe(true);
    // Ctrl+C, Ctrl+V still work while talking.
    expect(down.defaultPrevented).toBe(false);
    win.dispatchEvent(key("keyup", { code: "ControlLeft", target: composer }));
    expect(isHeld()).toBe(false);
  });

  it("a mouse binding transmits whatever has focus", () => {
    const binding: PttBinding = {
      device: "mouse",
      code: "MouseButton4",
      label: "Mouse Button 4",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    };
    const { win, isHeld } = setup(binding);
    win.dispatchEvent(mouse("mousedown", 3));
    expect(isHeld()).toBe(true);
    win.dispatchEvent(mouse("mouseup", 3));
    expect(isHeld()).toBe(false);
  });
});

describe("push-to-talk listeners: AltGr is typing", () => {
  it("a Left Ctrl binding lets go when Windows' synthetic Ctrl turns out to be AltGr in the composer", () => {
    // ABNT: AltGr+Q types "/". Windows delivers ControlLeft down, then
    // AltRight down with key "AltGraph".
    const leftCtrlBinding: PttBinding = { ...leftCtrl };
    const { win, log, isHeld } = setup(leftCtrlBinding);
    win.dispatchEvent(
      key("keydown", { code: "ControlLeft", ctrlKey: true, target: composer }),
    );
    win.dispatchEvent(
      key("keydown", {
        code: "AltRight",
        key: "AltGraph",
        ctrlKey: true,
        altKey: true,
        target: composer,
        altGraph: true,
      }),
    );
    expect(isHeld()).toBe(false);
    // The mic was open for the gap between two keydowns of one keystroke, no
    // longer: the very next event closed it.
    expect(log).toEqual([true, false]);
  });

  it("never engages while AltGr is held in a text field", () => {
    const { win, isHeld } = setup(leftCtrl);
    win.dispatchEvent(
      key("keydown", {
        code: "ControlLeft",
        ctrlKey: true,
        target: composer,
        altGraph: true,
      }),
    );
    expect(isHeld()).toBe(false);
  });

  it("AltGr typed in the composer does not cut an unrelated binding already held", () => {
    const f13: PttBinding = {
      device: "keyboard",
      code: "F13",
      label: "F13",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    };
    const { win, isHeld } = setup(f13);
    win.dispatchEvent(key("keydown", { code: "F13", target: composer }));
    win.dispatchEvent(
      key("keydown", {
        code: "AltRight",
        key: "AltGraph",
        altGraph: true,
        target: composer,
      }),
    );
    expect(isHeld()).toBe(true);
  });

  it("a Right Alt binding never engages from the composer, even reported as plain Alt", () => {
    const altRight: PttBinding = {
      device: "keyboard",
      code: "AltRight",
      label: "Right Alt",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    };
    const { win, isHeld } = setup(altRight);
    // macOS and US layouts report Right Alt as "Alt", not "AltGraph".
    win.dispatchEvent(
      key("keydown", {
        code: "AltRight",
        key: "Alt",
        altKey: true,
        target: composer,
      }),
    );
    expect(isHeld()).toBe(false);
    // And as AltGr on ABNT / European layouts.
    win.dispatchEvent(
      key("keydown", {
        code: "AltRight",
        key: "AltGraph",
        altGraph: true,
        target: composer,
      }),
    );
    expect(isHeld()).toBe(false);
    // Over the page it is a fine binding.
    win.dispatchEvent(
      key("keydown", { code: "AltRight", key: "Alt", altKey: true }),
    );
    expect(isHeld()).toBe(true);
  });

  it("AltGr outside a text field does not interfere", () => {
    const { win, isHeld } = setup(leftCtrl);
    win.dispatchEvent(key("keydown", { code: "ControlLeft", ctrlKey: true }));
    win.dispatchEvent(
      key("keydown", { code: "AltRight", key: "AltGraph", altGraph: true }),
    );
    expect(isHeld()).toBe(true);
  });
});

describe("push-to-talk listeners: never stuck open", () => {
  it("keyup releases even when focus moved into the composer mid-press", () => {
    const { win, isHeld } = setup();
    win.dispatchEvent(key("keydown", { code: "Backquote" }));
    win.dispatchEvent(key("keyup", { code: "Backquote", target: composer }));
    expect(isHeld()).toBe(false);
  });

  it("window blur releases (Alt-Tab, the keyup lands in another app)", () => {
    const { win, isHeld } = setup();
    win.dispatchEvent(key("keydown", { code: "Backquote" }));
    win.dispatchEvent(new Event("blur"));
    expect(isHeld()).toBe(false);
  });

  it("the tab going hidden releases", () => {
    const { win, doc, isHeld } = setup(leftCtrl);
    win.dispatchEvent(key("keydown", { code: "ControlLeft", ctrlKey: true }));
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(isHeld()).toBe(false);
  });

  it("becoming visible again does not reopen anything", () => {
    const { win, doc, log } = setup();
    win.dispatchEvent(key("keydown", { code: "Backquote" }));
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(log.at(-1)).toBe(false);
  });

  it("pagehide releases", () => {
    const { win, isHeld } = setup();
    win.dispatchEvent(key("keydown", { code: "Backquote" }));
    win.dispatchEvent(new Event("pagehide"));
    expect(isHeld()).toBe(false);
  });

  it("teardown releases and stops listening", () => {
    const { win, detach, isHeld } = setup();
    win.dispatchEvent(key("keydown", { code: "Backquote" }));
    detach();
    expect(isHeld()).toBe(false);
    win.dispatchEvent(key("keydown", { code: "Backquote" }));
    expect(isHeld()).toBe(false);
  });

  it("mouse binding: blur releases a held button", () => {
    const binding: PttBinding = {
      device: "mouse",
      code: "MouseMiddle",
      label: "Middle Click",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    };
    const { win, isHeld } = setup(binding);
    win.dispatchEvent(mouse("mousedown", 1));
    win.dispatchEvent(new Event("blur"));
    expect(isHeld()).toBe(false);
  });
});

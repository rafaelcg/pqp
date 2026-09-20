import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const {
  isWaylandSession,
  nativeHookPlatformSupport,
  macAccessibilityPermission,
  MAC_ACCESSIBILITY_SETTINGS_URL,
  MAC_INPUT_MONITORING_SETTINGS_URL,
  matchesEngage,
  matchesRelease,
  createNativeHookSession,
} = require("./native-ptt-hook.js");

describe("isWaylandSession", () => {
  it("reads XDG_SESSION_TYPE", () => {
    assert.equal(isWaylandSession({ XDG_SESSION_TYPE: "wayland" }), true);
    assert.equal(isWaylandSession({ XDG_SESSION_TYPE: "Wayland" }), true);
    assert.equal(isWaylandSession({ XDG_SESSION_TYPE: "x11" }), false);
  });

  it("falls back to WAYLAND_DISPLAY", () => {
    assert.equal(isWaylandSession({ WAYLAND_DISPLAY: "wayland-0" }), true);
    assert.equal(isWaylandSession({}), false);
  });

  it("survives a missing env", () => {
    assert.equal(isWaylandSession(undefined), false);
  });
});

describe("nativeHookPlatformSupport", () => {
  it("supports mac and windows unconditionally", () => {
    assert.equal(nativeHookPlatformSupport("darwin", {}).supported, true);
    assert.equal(nativeHookPlatformSupport("win32", {}).supported, true);
  });

  it("supports linux X11", () => {
    const result = nativeHookPlatformSupport("linux", { XDG_SESSION_TYPE: "x11" });
    assert.equal(result.supported, true);
  });

  it("refuses linux Wayland, with a reason the UI can show", () => {
    const result = nativeHookPlatformSupport("linux", { XDG_SESSION_TYPE: "wayland" });
    assert.equal(result.supported, false);
    assert.equal(result.reason, "wayland");
  });

  it("refuses an unknown platform", () => {
    const result = nativeHookPlatformSupport("freebsd", {});
    assert.equal(result.supported, false);
    assert.equal(result.reason, "platform");
  });
});

describe("macAccessibilityPermission", () => {
  it("is not-required off darwin", () => {
    assert.equal(macAccessibilityPermission("win32", null), "not-required");
  });

  it("reads the Electron API when present", () => {
    const granted = { isTrustedAccessibilityClient: () => true };
    const denied = { isTrustedAccessibilityClient: () => false };
    assert.equal(macAccessibilityPermission("darwin", granted), "granted");
    assert.equal(macAccessibilityPermission("darwin", denied), "denied");
  });

  it("never prompts, always calls with false", () => {
    let promptArg;
    const probe = { isTrustedAccessibilityClient: (prompt) => { promptArg = prompt; return true; } };
    macAccessibilityPermission("darwin", probe);
    assert.equal(promptArg, false);
  });

  it("is unknown when the API throws or is missing", () => {
    const throws = {
      isTrustedAccessibilityClient: () => {
        throw new Error("no");
      },
    };
    assert.equal(macAccessibilityPermission("darwin", throws), "unknown");
    assert.equal(macAccessibilityPermission("darwin", null), "unknown");
    assert.equal(macAccessibilityPermission("darwin", {}), "unknown");
  });

  it("exports both settings deep links", () => {
    assert.match(MAC_ACCESSIBILITY_SETTINGS_URL, /Privacy_Accessibility$/);
    assert.match(MAC_INPUT_MONITORING_SETTINGS_URL, /Privacy_ListenEvent$/);
  });
});

const keyboardBinding = (overrides = {}) => ({
  device: "keyboard",
  code: "Backquote",
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
  ...overrides,
});

const keyEvent = (down, overrides = {}) => ({
  device: "keyboard",
  code: "Backquote",
  down,
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
  ...overrides,
});

describe("matchesEngage / matchesRelease (keyboard)", () => {
  it("matches a plain key", () => {
    assert.equal(matchesEngage(keyboardBinding(), keyEvent(true)), true);
    assert.equal(matchesRelease(keyboardBinding(), keyEvent(false)), true);
  });

  it("requires the exact chord to engage", () => {
    const binding = keyboardBinding({ code: "KeyV", ctrl: true });
    assert.equal(matchesEngage(binding, keyEvent(true, { code: "KeyV", ctrl: false })), false);
    assert.equal(matchesEngage(binding, keyEvent(true, { code: "KeyV", ctrl: true })), true);
  });

  it("releases when the primary key goes up, chord or not", () => {
    const binding = keyboardBinding({ code: "KeyV", ctrl: true });
    assert.equal(matchesRelease(binding, keyEvent(false, { code: "KeyV", ctrl: false })), true);
  });

  it("releases when a required modifier lets go, even if the primary key is still down", () => {
    const binding = keyboardBinding({ code: "KeyV", ctrl: true });
    // A ControlLeft key-up event: code differs from the binding's primary
    // code, but the chord's ctrl flag is now false.
    assert.equal(
      matchesRelease(binding, keyEvent(false, { code: "ControlLeft", ctrl: false })),
      true,
    );
  });

  it("does not release on an unrelated key-up", () => {
    const binding = keyboardBinding({ code: "KeyV", ctrl: true });
    assert.equal(
      matchesRelease(binding, keyEvent(false, { code: "KeyQ", ctrl: true })),
      false,
    );
  });

  it("a modifier bound alone matches on code regardless of its own reported chord flag", () => {
    const binding = keyboardBinding({ code: "ControlLeft" });
    assert.equal(matchesEngage(binding, keyEvent(true, { code: "ControlLeft", ctrl: true })), true);
    assert.equal(matchesRelease(binding, keyEvent(false, { code: "ControlLeft", ctrl: false })), true);
  });

  it("refuses a mismatched device", () => {
    const binding = keyboardBinding();
    const mouseEvt = { device: "mouse", code: "Backquote", down: true };
    assert.equal(matchesEngage(binding, mouseEvt), false);
  });

  it("handles null binding or event", () => {
    assert.equal(matchesEngage(null, keyEvent(true)), false);
    assert.equal(matchesEngage(keyboardBinding(), null), false);
    assert.equal(matchesRelease(null, keyEvent(false)), false);
  });
});

describe("matchesEngage / matchesRelease (mouse)", () => {
  const mouseBinding = { device: "mouse", code: "MouseButton4" };
  const mouseEvent = (down, code = "MouseButton4") => ({ device: "mouse", code, down });

  it("matches on code alone, no chord", () => {
    assert.equal(matchesEngage(mouseBinding, mouseEvent(true)), true);
    assert.equal(matchesRelease(mouseBinding, mouseEvent(false)), true);
  });

  it("does not match a different button", () => {
    assert.equal(matchesEngage(mouseBinding, mouseEvent(true, "MouseMiddle")), false);
  });

  it("does not match a keyboard event with the same binding", () => {
    assert.equal(matchesEngage(mouseBinding, keyEvent(true, { code: "MouseButton4" })), false);
  });
});

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    setTimer(fn, ms) {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let soonest = null;
        for (const [id, entry] of pending) {
          if (entry.at <= target && (soonest === null || entry.at < soonest.at)) {
            soonest = { id, ...entry };
          }
        }
        if (!soonest) break;
        pending.delete(soonest.id);
        now = soonest.at;
        soonest.fn();
      }
      now = target;
    },
  };
}

/** A fake `uiohook-napi` export: enough of an EventEmitter plus start/stop. */
function fakeUiohook({ throwOnStart } = {}) {
  const emitter = new EventEmitter();
  let started = false;
  return {
    on: (...args) => emitter.on(...args),
    off: (...args) => emitter.off(...args),
    start() {
      if (throwOnStart) {
        throw throwOnStart;
      }
      started = true;
    },
    stop() {
      started = false;
    },
    get started() {
      return started;
    },
    emitKeyDown(keycode, chord = {}) {
      emitter.emit("keydown", { keycode, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...chord });
    },
    emitKeyUp(keycode, chord = {}) {
      emitter.emit("keyup", { keycode, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...chord });
    },
    emitMouseDown(button) {
      emitter.emit("mousedown", { button });
    },
    emitMouseUp(button) {
      emitter.emit("mouseup", { button });
    },
    listenerCount(event) {
      return emitter.listenerCount(event);
    },
  };
}

describe("createNativeHookSession", () => {
  it("requires getBinding", () => {
    assert.throws(() => createNativeHookSession({}));
  });

  it("reports unavailable when there is no hook to start", () => {
    const session = createNativeHookSession({ getBinding: () => null });
    const result = session.start();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unavailable");
  });

  it("presses and releases through the delay on a matched keyboard binding", () => {
    const clock = fakeClock();
    const uiohook = fakeUiohook();
    const changes = [];
    const binding = { device: "keyboard", code: "Backquote", ctrl: false, alt: false, shift: false, meta: false };
    const session = createNativeHookSession({
      uiohook,
      getBinding: () => binding,
      onHeldChange: (held) => changes.push(held),
      releaseDelayMs: 20,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    assert.equal(session.start().ok, true);
    assert.equal(uiohook.started, true);

    uiohook.emitKeyDown(0x0029 /* Backquote */);
    assert.equal(session.held, true);
    assert.deepEqual(changes, [true]);

    uiohook.emitKeyUp(0x0029);
    assert.equal(session.held, true, "release is delayed");
    clock.advance(20);
    assert.equal(session.held, false);
    assert.deepEqual(changes, [true, false]);
  });

  it("ignores an unmatched key entirely", () => {
    const uiohook = fakeUiohook();
    const changes = [];
    const binding = { device: "keyboard", code: "Backquote" };
    const session = createNativeHookSession({
      uiohook,
      getBinding: () => binding,
      onHeldChange: (held) => changes.push(held),
    });
    session.start();
    uiohook.emitKeyDown(0x0010 /* KeyQ */);
    assert.deepEqual(changes, []);
  });

  it("does nothing when getBinding() returns null (unbound)", () => {
    const uiohook = fakeUiohook();
    const changes = [];
    const session = createNativeHookSession({
      uiohook,
      getBinding: () => null,
      onHeldChange: (held) => changes.push(held),
    });
    session.start();
    uiohook.emitKeyDown(0x0029);
    assert.deepEqual(changes, []);
  });

  it("presses and releases a mouse binding", () => {
    const uiohook = fakeUiohook();
    const changes = [];
    const binding = { device: "mouse", code: "MouseButton4" };
    const session = createNativeHookSession({
      uiohook,
      getBinding: () => binding,
      onHeldChange: (held) => changes.push(held),
      releaseDelayMs: 0,
    });
    session.start();
    uiohook.emitMouseDown(4);
    assert.deepEqual(changes, [true]);
    uiohook.emitMouseUp(4);
    assert.deepEqual(changes, [true, false]);
  });

  it("start failure reports the reason, calls onError, and leaves no listeners attached", () => {
    const boom = new Error("permission denied");
    const uiohook = fakeUiohook({ throwOnStart: boom });
    let caught = null;
    const session = createNativeHookSession({
      uiohook,
      getBinding: () => null,
      onError: (err) => {
        caught = err;
      },
    });
    const result = session.start();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "start-failed");
    assert.equal(result.error, boom);
    assert.equal(caught, boom);
    assert.equal(session.listening, false);
    assert.equal(uiohook.listenerCount("keydown"), 0);
    assert.equal(uiohook.listenerCount("keyup"), 0);
  });

  it("start is idempotent", () => {
    const uiohook = fakeUiohook();
    const session = createNativeHookSession({ uiohook, getBinding: () => null });
    assert.equal(session.start().ok, true);
    assert.equal(session.start().ok, true);
    assert.equal(uiohook.listenerCount("keydown"), 1, "no duplicate listeners from a second start()");
  });

  it("stop() force-releases a held key immediately, no delay", () => {
    const uiohook = fakeUiohook();
    const changes = [];
    const binding = { device: "keyboard", code: "Backquote" };
    const session = createNativeHookSession({
      uiohook,
      getBinding: () => binding,
      onHeldChange: (held) => changes.push(held),
      releaseDelayMs: 5000,
    });
    session.start();
    uiohook.emitKeyDown(0x0029);
    assert.deepEqual(changes, [true]);
    session.stop();
    assert.deepEqual(changes, [true, false]);
    assert.equal(session.listening, false);
    assert.equal(uiohook.started, false);
  });

  it("stop() is safe to call when never started", () => {
    const session = createNativeHookSession({ getBinding: () => null });
    assert.doesNotThrow(() => session.stop());
  });

  it("setReleaseDelayMs changes the delay for the next release", () => {
    const clock = fakeClock();
    const uiohook = fakeUiohook();
    const changes = [];
    const binding = { device: "keyboard", code: "Backquote" };
    const session = createNativeHookSession({
      uiohook,
      getBinding: () => binding,
      onHeldChange: (held) => changes.push(held),
      releaseDelayMs: 1000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    session.start();
    session.setReleaseDelayMs(10);
    uiohook.emitKeyDown(0x0029);
    uiohook.emitKeyUp(0x0029);
    clock.advance(10);
    assert.deepEqual(changes, [true, false]);
  });

  it("a rebind mid-session is picked up on the next event, no restart needed", () => {
    const uiohook = fakeUiohook();
    const changes = [];
    let binding = { device: "keyboard", code: "Backquote" };
    const session = createNativeHookSession({
      uiohook,
      getBinding: () => binding,
      onHeldChange: (held) => changes.push(held),
      releaseDelayMs: 0,
    });
    session.start();
    binding = { device: "keyboard", code: "KeyQ" };
    uiohook.emitKeyDown(0x0029 /* Backquote, the old binding */);
    assert.deepEqual(changes, [], "old binding no longer matches");
    uiohook.emitKeyDown(0x0010 /* KeyQ, the new binding */);
    assert.deepEqual(changes, [true]);
  });
});

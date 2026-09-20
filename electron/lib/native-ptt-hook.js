/**
 * Native global push-to-talk: real key-down / key-up (and mouse-button
 * down/up) instead of the auto-repeat inference in `lib/global-ptt.js`.
 *
 * WHY THIS EXISTS. `globalShortcut` only ever reports a key going down,
 * with no key-up and no way to poll, so `lib/global-ptt.js` has to guess
 * the release from auto-repeat. That guess is at best "a tap holds the mic
 * for ~1.1 s, a hold releases ~250 ms late" (see that file's own comment).
 * `uiohook-napi` is a real global keyboard/mouse hook (an N-API binding
 * over libuiohook, prebuilt for every target platform, so no compiler is
 * needed at install or package time; see `asarUnpack` in `package.json`),
 * and it reports the true edges. This module wraps it.
 *
 * WHY THE HOOK ITSELF IS NOT REQUIRED HERE. `require("uiohook-napi")`
 * touches a native binary, which does not exist in this test environment and
 * should not have to for the logic to be pinned. Every function below either
 * takes the hook as a parameter (`createNativeHookSession({ uiohook, ... })`)
 * or does not need it at all (the platform/permission probes, the pure event
 * matchers). `main.js` is the only place that actually calls
 * `require("uiohook-napi")`, behind a try/catch; see `loadUiohook`.
 *
 * THE FOCUS-SWAP, AND WHY IT MATTERS MORE HERE THAN IT DID FOR
 * `globalShortcut` (uiohook-napi issue #54). On Windows, there is a reported
 * case where uiohook's low-level keyboard hook stops delivering events once
 * `getUserMedia()` starts capturing the microphone *while the window that
 * called it is focused*. We never give that bug a window to occur in,
 * structurally rather than by working around the symptom: this hook is only
 * ever started while the app window is NOT focused (`main.js`'s
 * `syncPushToTalkRegistration`, exactly the rule `global-ptt.js` already
 * follows for `globalShortcut`). While the window IS focused, this hook is
 * stopped and the renderer's own `keydown`/`keyup`/`mousedown`/`mouseup`
 * listeners do the job. Those are ordinary page events, not a global hook,
 * so a focused mic capture has nothing to race them for. The two states
 * (native hook listening, page focused and capturing mic) are mutually
 * exclusive by construction. This is a structural argument, not a verified
 * fix: nobody on this change reproduced #54 on real Windows hardware to
 * confirm it, so treat it as "designed so the bug's precondition never
 * holds" rather than "tested against the bug".
 */

const {
  codeFromUiohookKeycode,
  mouseCodeFromUiohookButton,
} = require("./uiohook-key-map");
const { createReleaseDelayTracker, DEFAULT_RELEASE_DELAY_MS } = require("./release-delay");

const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

function isModifierCode(code) {
  return MODIFIER_CODES.has(code);
}

/**
 * Wayland detection is a heuristic, not a certainty: a session can run
 * XWayland underneath and some compositors misreport these variables. We
 * treat it as an outright "no" anyway (rather than trying the hook and
 * seeing what happens) because libuiohook has no Wayland backend at all
 * (only x11, darwin and windows exist in its source tree), and the
 * compositors that matter here (GNOME, KDE) deliberately restrict the
 * legacy X11 global-input extensions XWayland would otherwise relay, for
 * the same reason Wayland exists: an app should not be able to watch every
 * other app's keystrokes. Same ceiling Discord hits. See `docs/PARITY.md`
 * and `electron/README.md`.
 */
function isWaylandSession(env = process.env) {
  if (!env) {
    return false;
  }
  if (String(env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland") {
    return true;
  }
  return Boolean(env.WAYLAND_DISPLAY);
}

/**
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ supported: boolean, reason: "wayland" | "platform" | null }}
 */
function nativeHookPlatformSupport(platform, env = process.env) {
  if (platform === "darwin" || platform === "win32") {
    return { supported: true, reason: null };
  }
  if (platform === "linux") {
    if (isWaylandSession(env)) {
      return { supported: false, reason: "wayland" };
    }
    return { supported: true, reason: null };
  }
  return { supported: false, reason: "platform" };
}

/**
 * macOS deep links into the two Privacy & Security panes that gate a global
 * key/mouse hook. macOS shows its own one-time system prompt for neither of
 * these the way it does for the microphone. Once denied (or never granted in
 * the first place, which reads the same as denied to us), it never asks
 * again, so the only way back is Settings. Both panes are offered because we
 * cannot tell from here which one a hook failure is actually blocked on;
 * see `macAccessibilityPermission` below for what we *can* see.
 */
const MAC_ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const MAC_INPUT_MONITORING_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent";

/**
 * What macOS's Accessibility permission says about this process, without
 * prompting (`isTrustedAccessibilityClient(false)`). A background probe run
 * every time the voice settings need to know is not a reason to interrupt
 * someone with a system dialog.
 *
 * THIS IS A PROXY, NOT THE WHOLE ANSWER. Global key/mouse capture on modern
 * macOS is also gated by **Input Monitoring**, a separate TCC permission
 * Electron exposes no query API for at all (`systemPreferences` has nothing
 * for it). So "granted" here means "Accessibility is fine", not "the hook
 * will definitely work". Input Monitoring could still be the thing saying
 * no, and the only way we would find out is the hook itself failing to
 * start or (worse, unobserved) silently receiving nothing. The in-app nudge
 * therefore always offers both panes rather than only the one we can check.
 */
function macAccessibilityPermission(platform, systemPreferences) {
  if (platform !== "darwin") {
    return "not-required";
  }
  if (!systemPreferences || typeof systemPreferences.isTrustedAccessibilityClient !== "function") {
    return "unknown";
  }
  try {
    return systemPreferences.isTrustedAccessibilityClient(false) === true ? "granted" : "denied";
  } catch {
    // A macOS that will not answer is not a macOS that has said no.
    return "unknown";
  }
}

/**
 * A translated hardware event, the same shape whether it came from a key or
 * a mouse button; `matchesEngage` / `matchesRelease` do not care which.
 * @typedef {{ device: "keyboard" | "mouse", code: string, down: boolean, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean }} HookEvent
 */

/**
 * A push-to-talk binding as the main process understands it. The same
 * fields as the renderer's `KeyBinding` (`client/src/components/voice/push-to-talk.ts`)
 * plus `device`, sent over IPC rather than imported: this is a different
 * package and a different process, and the two vocabularies (DOM
 * `KeyboardEvent.code`, `uiohook` keycodes) already live in their own
 * tables for exactly that reason. See `codeFromUiohookKeycode`.
 * @typedef {{ device: "keyboard" | "mouse", code: string, ctrl?: boolean, alt?: boolean, shift?: boolean, meta?: boolean }} PttBindingDescriptor
 */

/**
 * Does this hardware key/button going down engage the binding?
 *
 * Mirrors `matchesBinding` in `push-to-talk.ts` on purpose: same rule (a
 * modifier bound alone matches on code, everything else needs the exact
 * chord), independently implemented because this runs in the main process
 * against `uiohook` events rather than DOM ones.
 * @param {PttBindingDescriptor | null} binding
 * @param {HookEvent} event
 */
function matchesEngage(binding, event) {
  if (!binding || !event || binding.device !== event.device) {
    return false;
  }
  if (event.code !== binding.code) {
    return false;
  }
  if (binding.device === "mouse" || isModifierCode(binding.code)) {
    return true;
  }
  return (
    Boolean(event.ctrl) === Boolean(binding.ctrl) &&
    Boolean(event.alt) === Boolean(binding.alt) &&
    Boolean(event.shift) === Boolean(binding.shift) &&
    Boolean(event.meta) === Boolean(binding.meta)
  );
}

/**
 * Does this hardware key/button going up end the transmission?
 *
 * Mirrors `shouldRelease` in `push-to-talk.ts`: deliberately the lax half.
 * Letting go of any modifier the chord needs ends it, not just the primary
 * key, because leaving a modifier bit "stuck" is a worse failure than an
 * extra release.
 * @param {PttBindingDescriptor | null} binding
 * @param {HookEvent} event
 */
function matchesRelease(binding, event) {
  if (!binding || !event || binding.device !== event.device) {
    return false;
  }
  if (event.code === binding.code) {
    return true;
  }
  if (binding.device === "mouse" || isModifierCode(binding.code)) {
    return false;
  }
  return (
    (Boolean(binding.ctrl) && !event.ctrl) ||
    (Boolean(binding.alt) && !event.alt) ||
    (Boolean(binding.shift) && !event.shift) ||
    (Boolean(binding.meta) && !event.meta)
  );
}

function translateKeyboardEvent(raw, down) {
  const code = codeFromUiohookKeycode(raw?.keycode);
  if (!code) {
    // An uiohook keycode our table does not know. Silently dropping it
    // (rather than matching nothing) is correct: we can never have bound
    // this key in the first place, since the renderer's capture UI only
    // ever produces codes this table also knows about.
    return null;
  }
  return {
    device: "keyboard",
    code,
    down,
    ctrl: Boolean(raw.ctrlKey),
    alt: Boolean(raw.altKey),
    shift: Boolean(raw.shiftKey),
    meta: Boolean(raw.metaKey),
  };
}

function translateMouseEvent(raw, down) {
  const code = mouseCodeFromUiohookButton(raw?.button);
  if (!code) {
    return null;
  }
  return { device: "mouse", code, down, ctrl: false, alt: false, shift: false, meta: false };
}

/**
 * Owns one running (or not) native hook and the release-delay timer that
 * sits downstream of it. `main.js` creates exactly one of these; the
 * dependency injection (`uiohook`, `setTimer`/`clearTimer`) is what makes it
 * testable without the native binary or a real clock.
 *
 * @param {object} options
 * @param {object} [options.uiohook] The `uiohook-napi` export (or a fake).
 *   `start()` is undefined behaviour here without it; call sites must not
 *   invoke `start()` when the module failed to load.
 * @param {() => PttBindingDescriptor | null} options.getBinding Read the
 *   current binding fresh on every event, rather than snapshotting it, so a
 *   rebind while the hook is running takes effect without a restart.
 * @param {(held: boolean) => void} options.onHeldChange
 * @param {number} [options.releaseDelayMs]
 * @param {typeof setTimeout} [options.setTimer]
 * @param {typeof clearTimeout} [options.clearTimer]
 * @param {(err: unknown) => void} [options.onError] Called when `uiohook.start()`
 *   throws: a permission denial or a platform the prebuild does not cover.
 */
function createNativeHookSession({
  uiohook,
  getBinding,
  onHeldChange,
  releaseDelayMs = DEFAULT_RELEASE_DELAY_MS,
  setTimer,
  clearTimer,
  onError,
} = {}) {
  if (typeof getBinding !== "function") {
    throw new Error("createNativeHookSession requires getBinding()");
  }
  const releaseTracker = createReleaseDelayTracker(onHeldChange ?? (() => {}), {
    delayMs: releaseDelayMs,
    setTimer,
    clearTimer,
  });

  let listening = false;
  let handlers = null;

  function handle(translated) {
    if (!translated) {
      return;
    }
    const binding = getBinding();
    if (!binding) {
      return;
    }
    if (translated.down) {
      if (matchesEngage(binding, translated)) {
        releaseTracker.press();
      }
      return;
    }
    if (matchesRelease(binding, translated)) {
      releaseTracker.release();
    }
  }

  /** @returns {{ ok: boolean, reason?: string, error?: unknown }} */
  function start() {
    if (listening) {
      return { ok: true };
    }
    if (!uiohook || typeof uiohook.start !== "function") {
      return { ok: false, reason: "unavailable" };
    }
    const onKeyDown = (e) => handle(translateKeyboardEvent(e, true));
    const onKeyUp = (e) => handle(translateKeyboardEvent(e, false));
    const onMouseDown = (e) => handle(translateMouseEvent(e, true));
    const onMouseUp = (e) => handle(translateMouseEvent(e, false));
    const attached = { onKeyDown, onKeyUp, onMouseDown, onMouseUp };
    try {
      uiohook.on("keydown", onKeyDown);
      uiohook.on("keyup", onKeyUp);
      uiohook.on("mousedown", onMouseDown);
      uiohook.on("mouseup", onMouseUp);
      uiohook.start();
    } catch (err) {
      detach(attached);
      onError?.(err);
      return { ok: false, reason: "start-failed", error: err };
    }
    handlers = attached;
    listening = true;
    return { ok: true };
  }

  function detach(attached) {
    if (!attached || typeof uiohook?.off !== "function") {
      return;
    }
    try {
      uiohook.off("keydown", attached.onKeyDown);
      uiohook.off("keyup", attached.onKeyUp);
      uiohook.off("mousedown", attached.onMouseDown);
      uiohook.off("mouseup", attached.onMouseUp);
    } catch {
      // Best-effort. A hook that will not unregister is not a reason to
      // leave the mic held open below.
    }
  }

  function stop() {
    if (listening) {
      listening = false;
      detach(handlers);
      handlers = null;
      try {
        uiohook?.stop?.();
      } catch {
        // Already gone. Nothing to clean up further.
      }
    }
    // Always force-release, even if we were never listening: a caller that
    // asks to stop wants the mic closed, full stop.
    releaseTracker.forceRelease();
  }

  return {
    start,
    stop,
    dispose: stop,
    setReleaseDelayMs: releaseTracker.setDelayMs,
    get listening() {
      return listening;
    },
    get held() {
      return releaseTracker.held;
    },
  };
}

module.exports = {
  isWaylandSession,
  nativeHookPlatformSupport,
  MAC_ACCESSIBILITY_SETTINGS_URL,
  MAC_INPUT_MONITORING_SETTINGS_URL,
  macAccessibilityPermission,
  isModifierCode,
  matchesEngage,
  matchesRelease,
  translateKeyboardEvent,
  translateMouseEvent,
  createNativeHookSession,
};

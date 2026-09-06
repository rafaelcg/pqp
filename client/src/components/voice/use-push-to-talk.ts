import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  shouldEngage,
  shouldRelease,
  type KeyBinding,
} from "@/components/voice/push-to-talk";
import { bindingToAccelerator } from "@/components/voice/push-to-talk-accelerator";
import { getDesktop } from "@/lib/desktop";

interface PushToTalkOptions {
  /** Only true while push-to-talk is the chosen mode *and* a call is up. */
  enabled: boolean;
  binding: KeyBinding;
  /** Idempotent — this hook calls it with `false` more often than with `true`. */
  onHeldChange: (held: boolean) => void;
}

/**
 * Binds the push-to-talk key to the window, and — far more importantly — makes
 * sure it always lets go.
 *
 * THE WHOLE POINT IS THE RELEASE PATHS. A browser delivers `keyup` only to the
 * window that had focus when the key went up, so every way of leaving with the
 * key still down has to be treated as a release in its own right:
 *
 * - `keyup` — the ordinary case.
 * - `blur` on the window — Alt-Tab, Cmd-Tab, clicking another window. The keyup
 *   lands in the other application and this page never hears it. Without this
 *   the mic stays open for as long as you are away, which is exactly the
 *   scenario people are afraid of.
 * - `visibilitychange` to hidden — tab switched, phone locked.
 * - `pagehide` — navigating away or bfcache; also fires where `beforeunload`
 *   does not on iOS.
 * - unmount, or the binding/enabled flag changing under us.
 *
 * WHAT THIS CANNOT DO ON THE WEB. There is no global hotkey in a browser: a
 * key pressed while another application has focus is never delivered here, so
 * push-to-talk genuinely stops working the moment the window is not focused.
 * The hook reports `windowFocused` so the UI can say so out loud rather than
 * leaving someone pressing a key at a screen that is not listening.
 *
 * WHAT THE DESKTOP SHELL ADDS. In Electron the same binding is also handed to
 * the main process as a `globalShortcut` accelerator (`bindPushToTalk`), which
 * fires while another application is focused. The shell only holds that
 * registration while this window is *not* focused: a registered global
 * shortcut swallows the key before the renderer sees it, and the renderer's
 * own keydown / keyup pair is the precise one. So in-window behaviour is
 * exactly what it is on the web, and out of the window the shell reports
 * presses and releases over `onPushToTalk`. Both feed the same `held`. When
 * the shell has the key, `windowFocused` reads true, because the thing that
 * flag exists to warn about is no longer true. Everything is feature-detected:
 * a browser, or a shell built before the bridge existed, takes the web path.
 */
export function usePushToTalk({
  enabled,
  binding,
  onHeldChange,
}: PushToTalkOptions): { held: boolean; windowFocused: boolean } {
  const [held, setHeld] = useState(false);
  const [windowFocused, setWindowFocused] = useState(true);
  const [globalHotkey, setGlobalHotkey] = useState(false);
  // Read inside the listeners so a re-render with a new callback identity does
  // not have to tear the listeners down and risk losing a keyup in the gap.
  const onHeldChangeRef = useRef(onHeldChange);
  const heldRef = useRef(false);

  /**
   * Keyed on the binding's *values*, not its object identity.
   *
   * Callers hold the binding inside a larger settings object that is replaced
   * whenever anything in it changes — so without this, dragging the input
   * volume slider would rebuild the listeners, and the teardown's release would
   * cut a transmission already in progress. The binding is what this effect
   * depends on; nothing else about the settings should reach it.
   */
  const { code, label, ctrl, alt, shift, meta } = binding;
  const stableBinding = useMemo(
    () => ({ code, label, ctrl, alt, shift, meta }),
    [code, label, ctrl, alt, shift, meta],
  );

  useEffect(() => {
    onHeldChangeRef.current = onHeldChange;
  }, [onHeldChange]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    // Seeded from `hasFocus()`, then driven by the events rather than by
    // re-reading it. Inside a `blur` handler `document.hasFocus()` is still
    // true in some browsers, so re-reading it there would leave the UI claiming
    // the key still works at the exact moment it stopped working.
    setWindowFocused(document.hasFocus());
    const onFocus = () => setWindowFocused(true);
    const onBlur = () => setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Shared by the window listeners and the desktop bridge: a release from
  // either side ends the transmission, whichever side started it.
  const set = useCallback((next: boolean) => {
    if (heldRef.current === next) {
      return;
    }
    heldRef.current = next;
    setHeld(next);
    onHeldChangeRef.current(next);
  }, []);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (!shouldEngage(event, stableBinding)) {
        return;
      }
      // Only once we know it is ours and not aimed at a text field. Stops the
      // page scrolling on Space and stops "/" opening Firefox quick-find.
      event.preventDefault();
      set(true);
    }

    function onKeyUp(event: KeyboardEvent) {
      // No target check, no focus check, no chord check beyond the binding
      // itself. Releasing is never conditional on anything that could be
      // wrong — see `shouldRelease`.
      if (shouldRelease(event, stableBinding)) {
        set(false);
      }
    }

    const releaseNow = () => set(false);

    function onVisibility() {
      if (document.visibilityState === "hidden") {
        releaseNow();
      }
    }

    // Capture phase: a keyup must reach us even if something downstream stops
    // propagation, and it must reach us before any handler that could move
    // focus and change what the event looks like.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", releaseNow);
    window.addEventListener("pagehide", releaseNow);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", releaseNow);
      window.removeEventListener("pagehide", releaseNow);
      document.removeEventListener("visibilitychange", onVisibility);
      // Turning the feature off, changing the binding, or leaving the call
      // while the key is down all end the transmission. Never inherit a held
      // key across a change to what "held" means.
      releaseNow();
    };
  }, [enabled, stableBinding, set]);

  // The desktop half. Keyed on the same values as the window listeners, so a
  // rebind reaches the shell the moment the setting changes.
  useEffect(() => {
    const desktop = getDesktop();
    // Bound out of the object so the narrowing survives into the callbacks,
    // and so a shell that predates either half takes the web path.
    const bind = desktop?.bindPushToTalk?.bind(desktop);
    const subscribe = desktop?.onPushToTalk?.bind(desktop);
    if (!bind || !subscribe) {
      return;
    }
    const accelerator = enabled ? bindingToAccelerator(stableBinding) : null;
    if (!accelerator) {
      // Modifier-only binding, or nothing to bind: make sure the shell holds
      // no stale registration from a previous binding.
      void bind(null);
      setGlobalHotkey(false);
      return;
    }
    let cancelled = false;
    const off = subscribe((down) => set(down));
    void bind(accelerator).then((registered) => {
      if (!cancelled) {
        setGlobalHotkey(registered === true);
      }
    });
    return () => {
      cancelled = true;
      off();
      void bind(null);
      setGlobalHotkey(false);
      set(false);
    };
  }, [enabled, stableBinding, set]);

  return { held, windowFocused: windowFocused || globalHotkey };
}

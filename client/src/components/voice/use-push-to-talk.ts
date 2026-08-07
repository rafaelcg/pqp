import { useEffect, useMemo, useRef, useState } from "react";
import {
  shouldEngage,
  shouldRelease,
  type KeyBinding,
} from "@/components/voice/push-to-talk";

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
 * WHAT THIS CANNOT DO. There is no global hotkey on the web: a key pressed
 * while another application has focus is never delivered here, so push-to-talk
 * genuinely stops working the moment the window is not focused. The hook
 * reports `windowFocused` so the UI can say so out loud rather than leaving
 * someone pressing a key at a screen that is not listening. Only the Electron
 * shell can do better (see the note in the report / `electron/`).
 */
export function usePushToTalk({
  enabled,
  binding,
  onHeldChange,
}: PushToTalkOptions): { held: boolean; windowFocused: boolean } {
  const [held, setHeld] = useState(false);
  const [windowFocused, setWindowFocused] = useState(true);
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

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    function set(next: boolean) {
      if (heldRef.current === next) {
        return;
      }
      heldRef.current = next;
      setHeld(next);
      onHeldChangeRef.current(next);
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
  }, [enabled, stableBinding]);

  return { held, windowFocused };
}

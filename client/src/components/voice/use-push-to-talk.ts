import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PttBinding } from "@/components/voice/push-to-talk";
import { attachPushToTalkListeners } from "@/components/voice/push-to-talk-listeners";
import { bindingToAccelerator } from "@/components/voice/push-to-talk-accelerator";
import { getDesktop, type DesktopPttBinding } from "@/lib/desktop";
import { playPttHeldChange, pttHeldCue, resetPttHeld } from "@/lib/sounds";
import { DEFAULT_RELEASE_DELAY_MS } from "@/lib/ptt-release-delay";

/**
 * Hand a binding back to the shell, retry once if it refuses, and never
 * leave the rejection unhandled.
 *
 * Nothing better is available on failure: the IPC call is the only door to
 * the main process, and it is the main process that holds the hook. What
 * keeps a failed unbind from leaving the mic open is on the main side, not
 * here: the hook only runs while the window is unfocused and is stopped (and
 * force-released) the moment it regains focus, and every renderer press path
 * still goes through `set`, whose releases are unconditional.
 */
function unbindQuietly(
  pending: Promise<unknown>,
  retry?: () => Promise<unknown>,
): void {
  const generation = shellRequestGeneration;
  pending.catch((err: unknown) => {
    // One retry, and only if nothing has asked the shell for anything since:
    // a retry landing after a newer bind would silently undo it.
    if (!retry || generation !== shellRequestGeneration) {
      console.warn(
        "[pqp] push-to-talk: shell refused to release the binding",
        err,
      );
      return;
    }
    window.setTimeout(() => {
      if (generation === shellRequestGeneration) {
        unbindQuietly(retry());
      }
    }, 500);
  });
}

/**
 * Bumped on every bind and unbind sent to the shell, so a delayed retry can
 * tell whether it is still the latest request. Module-level because there is
 * one shell and one push-to-talk binding per window.
 */
let shellRequestGeneration = 0;

function nextShellRequest(): void {
  shellRequestGeneration += 1;
}

interface PushToTalkOptions {
  /** Only true while push-to-talk is the chosen mode *and* a call is up. */
  enabled: boolean;
  binding: PttBinding;
  /**
   * Desktop-only, ignored on the web (there is no native hook there). See
   * `LocalSettings.pttReleaseDelayMs` in `settings-modal.tsx`.
   */
  releaseDelayMs?: number;
  /**
   * Desktop-only: whether the shell may hold the binding while the window is
   * in the background (`LocalSettings.pttGlobal`). Off keeps push-to-talk
   * in-window, exactly like the web. Defaults to on.
   */
  global?: boolean;
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
 * WHAT THE DESKTOP SHELL ADDS. A current shell offers `bindPushToTalkNative`
 * (Tier 2): a real global keyboard/mouse hook, or its own `globalShortcut`
 * fallback when the hook is unavailable or denied, chosen inside the main
 * process, see `electron/lib/native-ptt-hook.js` and `bindPushToTalkNative`'s
 * own doc in `lib/desktop.ts`. This hook prefers that bridge whenever it
 * exists and otherwise falls all the way back to the older `bindPushToTalk` /
 * `onPushToTalk` pair (`globalShortcut` with an auto-repeat-inferred release,
 * keyboard bindings only), which is exactly what every shell before this
 * landed already did; nothing here narrows what an old shell could do, only
 * widens what a current one can. Either way, the registration is held only
 * while this window is *not* focused: a registered global hook or shortcut
 * swallows the key/button before the renderer sees it, and the renderer's own
 * keydown/keyup (or mousedown/mouseup) pair is the precise one, so in-window
 * behaviour is exactly what it is on the web. Out of the window, the shell
 * reports presses and releases over IPC; both paths feed the same `held`.
 * When the shell has the binding, `windowFocused` reads true, because the
 * thing that flag exists to warn about is no longer true. Everything is
 * feature-detected: a browser, or a shell built before either bridge
 * existed, takes the web path (or the older desktop path) automatically.
 *
 * MOUSE BINDINGS have no web-focused equivalent to `globalShortcut` at all:
 * there is no such thing as a "global mouse shortcut" API, so a mouse
 * binding on a shell without `bindPushToTalkNative` simply has no
 * out-of-window reach; in-window `mousedown`/`mouseup` still work everywhere,
 * including the web, for whatever middle-click or back/forward-button
 * behaviour the browser itself does not already claim.
 */
export function usePushToTalk({
  enabled,
  binding,
  releaseDelayMs = DEFAULT_RELEASE_DELAY_MS,
  global: globalEnabled = true,
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
  const { device, code, label, ctrl, alt, shift, meta } = binding;
  const stableBinding = useMemo(
    () => ({ device, code, label, ctrl, alt, shift, meta }),
    [device, code, label, ctrl, alt, shift, meta],
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
    // Key repeat keeps firing keydown while the key is down. Same held flag
    // means no second open, and no second beep.
    if (pttHeldCue(heldRef.current, next) === null) {
      return;
    }
    heldRef.current = next;
    setHeld(next);
    onHeldChangeRef.current(next);
    playPttHeldChange(next);
  }, []);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      resetPttHeld();
      return;
    }
    const detach = attachPushToTalkListeners(
      window,
      document,
      stableBinding,
      set,
    );
    return () => {
      detach();
      resetPttHeld();
    };
  }, [enabled, stableBinding, set]);

  // The desktop half. Keyed on the same values as the window listeners (plus
  // the release delay for the native path), so a rebind reaches the shell
  // the moment the setting changes.
  useEffect(() => {
    const desktop = getDesktop();
    const bindNative = desktop?.bindPushToTalkNative?.bind(desktop);
    const subscribeNative = desktop?.onPushToTalkNative?.bind(desktop);
    const wanted = enabled && globalEnabled;
    if (bindNative && subscribeNative) {
      if (!wanted) {
        nextShellRequest();
        unbindQuietly(bindNative(null, releaseDelayMs), () =>
          bindNative(null, releaseDelayMs),
        );
        setGlobalHotkey(false);
        return;
      }
      const descriptor: DesktopPttBinding = {
        device: stableBinding.device,
        code: stableBinding.code,
        ctrl: stableBinding.ctrl,
        alt: stableBinding.alt,
        shift: stableBinding.shift,
        meta: stableBinding.meta,
        accelerator: bindingToAccelerator(stableBinding),
      };
      let cancelled = false;
      const off = subscribeNative((down) => set(down));
      nextShellRequest();
      bindNative(descriptor, releaseDelayMs).then(
        (result) => {
          if (!cancelled) {
            setGlobalHotkey(result.registered === true);
          }
        },
        () => {
          if (!cancelled) {
            setGlobalHotkey(false);
          }
        },
      );
      return () => {
        cancelled = true;
        off();
        nextShellRequest();
        unbindQuietly(bindNative(null, releaseDelayMs), () =>
          bindNative(null, releaseDelayMs),
        );
        setGlobalHotkey(false);
        set(false);
      };
    }

    // Older shell: no `bindPushToTalkNative`. Same behaviour this hook has
    // always had: `globalShortcut`, keyboard bindings only, release
    // inferred from auto-repeat. A mouse binding has nothing to reach for
    // here (`bindingToAccelerator` already answers `null` for one), so it
    // silently stays in-window only, exactly like a modifier-only key does.
    const bind = desktop?.bindPushToTalk?.bind(desktop);
    const subscribe = desktop?.onPushToTalk?.bind(desktop);
    if (!bind || !subscribe) {
      return;
    }
    const accelerator = wanted ? bindingToAccelerator(stableBinding) : null;
    if (!accelerator) {
      nextShellRequest();
      unbindQuietly(bind(null), () => bind(null));
      setGlobalHotkey(false);
      return;
    }
    let cancelled = false;
    const off = subscribe((down) => set(down));
    nextShellRequest();
    bind(accelerator).then(
      (registered) => {
        if (!cancelled) {
          setGlobalHotkey(registered === true);
        }
      },
      () => {
        if (!cancelled) {
          setGlobalHotkey(false);
        }
      },
    );
    return () => {
      cancelled = true;
      off();
      nextShellRequest();
      unbindQuietly(bind(null), () => bind(null));
      setGlobalHotkey(false);
      set(false);
    };
  }, [enabled, globalEnabled, stableBinding, releaseDelayMs, set]);

  return { held, windowFocused: windowFocused || globalHotkey };
}

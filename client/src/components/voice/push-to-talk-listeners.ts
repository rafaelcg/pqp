import {
  isModifierCode,
  isTextEntryTarget,
  matchesMouseBinding,
  shouldEngage,
  shouldRelease,
  shouldReleaseMouse,
  type PttBinding,
} from "@/components/voice/push-to-talk";

/**
 * The window and document, as far as push-to-talk needs them. Structural so
 * the unit suite can hand in plain `EventTarget`s (Node has them, the suite
 * has no DOM).
 */
export interface PttWindowLike {
  addEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: boolean | EventListenerOptions,
  ): void;
}

export interface PttDocumentLike extends PttWindowLike {
  readonly visibilityState: string;
}

/** Is AltGr part of this keydown, by either of the two ways browsers say so? */
export function isAltGraph(event: {
  key?: string;
  getModifierState?: (key: string) => boolean;
}): boolean {
  if (event.key === "AltGraph") {
    return true;
  }
  try {
    return event.getModifierState?.("AltGraph") === true;
  } catch {
    return false;
  }
}

/** Bindings AltGr produces a keydown for: Ctrl (Windows' synthetic one), Right Alt, or any Ctrl chord. */
function altGraphCanFake(binding: PttBinding): boolean {
  return (
    binding.code === "ControlLeft" ||
    binding.code === "ControlRight" ||
    binding.code === "AltRight" ||
    binding.ctrl
  );
}

/**
 * Wire the push-to-talk key (or mouse button) to `set`, and every way of
 * leaving with it still down to `set(false)`. Returns the teardown, which
 * releases too.
 *
 * Mounted once at the app root (`App.tsx`), never inside a view: the voice
 * panel unmounts the moment you open a text channel, DMs or settings, and
 * push-to-talk has to keep working from all of them.
 *
 * Release paths, each one a way the keyup can go missing:
 * - `keyup` / `mouseup`, the ordinary case, never filtered by target.
 * - `blur` on the window: Alt-Tab, Cmd-Tab, clicking another app.
 * - `visibilitychange` to hidden: tab switched, window minimized.
 * - `pagehide`: navigating away, bfcache.
 * - the teardown itself: leaving the call, changing the binding or the mode.
 */
export function attachPushToTalkListeners(
  win: PttWindowLike,
  doc: PttDocumentLike,
  binding: PttBinding,
  set: (held: boolean) => void,
): () => void {
  const releaseNow = () => set(false);
  const onVisibility = () => {
    if (doc.visibilityState === "hidden") {
      releaseNow();
    }
  };

  win.addEventListener("blur", releaseNow);
  win.addEventListener("pagehide", releaseNow);
  doc.addEventListener("visibilitychange", onVisibility);

  const pairs: Array<[string, (event: Event) => void]> = [];

  if (binding.device === "mouse") {
    pairs.push([
      "mousedown",
      (event) => {
        if (!matchesMouseBinding(event as MouseEvent, binding)) {
          return;
        }
        // Stops a middle-click auto-scroll or a back/forward navigation from
        // riding along with the bind.
        event.preventDefault();
        set(true);
      },
    ]);
    pairs.push([
      "mouseup",
      (event) => {
        if (shouldReleaseMouse(event as MouseEvent, binding)) {
          set(false);
        }
      },
    ]);
  } else {
    pairs.push([
      "keydown",
      (event) => {
        const key = event as KeyboardEvent;
        // AltGr in a text field is typing ("/", "?" and "°" on Brazilian
        // ABNT, "@" and "€" across Europe). Windows sends a synthetic Left
        // Ctrl keydown just before the AltGraph one, so a Ctrl binding would
        // already be held by the time AltGr is recognised: let go then, and
        // never engage while AltGr is down.
        if (isAltGraph(key) && isTextEntryTarget(key.target)) {
          // Only a binding AltGr can be mistaken for lets go: a Ctrl one
          // (the synthetic keydown) or Right Alt itself. An F13 held while
          // somebody types "/" is still meant.
          if (altGraphCanFake(binding)) {
            set(false);
          }
          return;
        }
        if (!shouldEngage(key, binding)) {
          return;
        }
        // Stops the page scrolling on Space and "/" opening Firefox
        // quick-find. Not for a bare modifier held in a text field: that
        // keydown has no default worth stopping there, and leaving it alone
        // keeps every Ctrl/Shift chord typed while talking exactly as it was.
        if (!(isModifierCode(binding.code) && isTextEntryTarget(key.target))) {
          event.preventDefault();
        }
        set(true);
      },
    ]);
    pairs.push([
      "keyup",
      (event) => {
        // No target check, no focus check: releasing is never conditional on
        // anything that could be wrong. See `shouldRelease`.
        if (shouldRelease(event as KeyboardEvent, binding)) {
          set(false);
        }
      },
    ]);
  }

  // Capture phase: a release must reach us even if something downstream
  // stops propagation, and before any handler that could move focus. An
  // options object rather than `true`: Node's EventTarget (the unit suite)
  // ignores a boolean on remove, browsers treat the two the same.
  const capture = { capture: true };
  for (const [type, listener] of pairs) {
    win.addEventListener(type, listener, capture);
  }

  return () => {
    for (const [type, listener] of pairs) {
      win.removeEventListener(type, listener, capture);
    }
    win.removeEventListener("blur", releaseNow);
    win.removeEventListener("pagehide", releaseNow);
    doc.removeEventListener("visibilitychange", onVisibility);
    // Never inherit a held key across a change to what "held" means.
    releaseNow();
  };
}

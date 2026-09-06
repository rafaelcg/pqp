/**
 * Which remote video publications the SFU should be sending right now.
 *
 * WHY THIS EXISTS. Simulcast (`video-quality.ts`) and the receive selector
 * (`receive-quality.ts`) shrink the bytes a viewer takes for a picture it is
 * looking at. This is about the pictures nobody is looking at: a camera whose
 * rail tile is parked off-screen or whose rail is closed, and every video
 * once the tab has been in the background for a while. Each of those is a
 * full layer arriving at a decoder that draws nothing, and in a big room the
 * cameras alone add up.
 *
 * THE RULE IS ONE SENTENCE. A publication is delivered while at least one
 * `<video>` element is bound to it and the tab is visible; otherwise it is
 * paused with `RemoteTrackPublication.setEnabled(false)`. Audio is never
 * touched: this only ever sees video publications.
 *
 * `setEnabled` RATHER THAN `setSubscribed`. Unsubscribing tears the receiver
 * down and re-subscribing renegotiates, which is a second or more of black and
 * a new track object for the tile to rebind. `setEnabled(false)` is one
 * signalling message that stops the server forwarding; the receiver and the
 * track stay, and `setEnabled(true)` resumes within a round trip.
 *
 * TWO GRACE PERIODS, BOTH SHORT. Losing the last element waits
 * `OFFSCREEN_GRACE_MS` before pausing, because React unbinds and rebinds an
 * element across a layout change and a tile scrolled just past the rail's
 * edge comes straight back; a pause and resume across a re-render would cost
 * two messages and a blink for nothing. Hiding the tab waits
 * `HIDDEN_GRACE_MS`, so a glance at another window does not stop every
 * picture. Resuming is immediate in both cases.
 *
 * HOW IT MEETS THE LIBRARY'S OWN ADAPTIVE PAUSE. With `adaptiveStream` on,
 * livekit-client already reports an attached element that scrolls out of
 * view as invisible and pauses the tab's video after five seconds in the
 * background. That covers a track that was attached at least once. It does
 * not cover a track nothing was ever attached to, which is exactly the parked
 * tile and the closed rail, and that is the gap this fills. The two are kept
 * from fighting by the way a pause is lifted: a manual `setEnabled(true)`
 * would pin the publication enabled and switch the library's visibility
 * logic off for it, so `release` clears the manual request instead when the
 * library exposes it (`livekit-session.ts` supplies that), and only falls
 * back to `setEnabled(true)` when it does not.
 */

export interface DeliveryPublication {
  setEnabled(enabled: boolean): void;
}

export interface RemoteVideoDeliveryOptions {
  /** Lift a pause. Defaults to `setEnabled(true)`. */
  release?: (publication: DeliveryPublication) => void;
  offscreenGraceMs?: number;
  hiddenGraceMs?: number;
}

export interface RemoteVideoDelivery {
  /** A video publication arrived. It starts delivered, then follows the rule. */
  register(publication: DeliveryPublication): void;
  /** The publication went away. Forgets it; sends nothing. */
  unregister(publication: DeliveryPublication): void;
  /** A `<video>` element was bound to this publication. */
  attached(publication: DeliveryPublication): void;
  /** A `<video>` element bound to this publication went away. */
  detached(publication: DeliveryPublication): void;
  /** `document.visibilityState` changed. */
  setTabHidden(hidden: boolean): void;
  /** Whether the rule currently has this publication paused. */
  isPaused(publication: DeliveryPublication): boolean;
  /** Drop every timer. Nothing is resumed; the room is going away. */
  dispose(): void;
}

export const OFFSCREEN_GRACE_MS = 1000;
export const HIDDEN_GRACE_MS = 10_000;

interface Entry {
  elements: number;
  paused: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createRemoteVideoDelivery(
  options: RemoteVideoDeliveryOptions = {},
): RemoteVideoDelivery {
  const offscreenGraceMs = options.offscreenGraceMs ?? OFFSCREEN_GRACE_MS;
  const hiddenGraceMs = options.hiddenGraceMs ?? HIDDEN_GRACE_MS;
  const release =
    options.release ??
    ((publication: DeliveryPublication) => publication.setEnabled(true));

  const entries = new Map<DeliveryPublication, Entry>();
  let tabHidden = false;
  /** Set while the tab is hidden and the grace has run out. */
  let tabPaused = false;
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;

  function wanted(entry: Entry) {
    return entry.elements > 0 && !tabPaused;
  }

  function pause(publication: DeliveryPublication, entry: Entry) {
    if (entry.paused) {
      return;
    }
    entry.paused = true;
    try {
      publication.setEnabled(false);
    } catch (err) {
      console.warn("[pqp] could not pause remote video delivery", err);
    }
  }

  function resume(publication: DeliveryPublication, entry: Entry) {
    if (!entry.paused) {
      return;
    }
    entry.paused = false;
    try {
      release(publication);
    } catch (err) {
      console.warn("[pqp] could not resume remote video delivery", err);
    }
  }

  function clearTimer(entry: Entry) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  /** Apply the rule to one publication, now or after the off-screen grace. */
  function reconcile(publication: DeliveryPublication, entry: Entry) {
    if (wanted(entry)) {
      clearTimer(entry);
      resume(publication, entry);
      return;
    }
    if (entry.paused || entry.timer !== null) {
      return;
    }
    if (tabPaused) {
      // The tab's own grace already ran; nothing to wait for.
      pause(publication, entry);
      return;
    }
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (!wanted(entry)) {
        pause(publication, entry);
      }
    }, offscreenGraceMs);
  }

  function reconcileAll() {
    for (const [publication, entry] of entries) {
      reconcile(publication, entry);
    }
  }

  return {
    register(publication) {
      if (entries.has(publication)) {
        return;
      }
      const entry: Entry = { elements: 0, paused: false, timer: null };
      entries.set(publication, entry);
      // A tile usually binds within a frame of the track arriving; the grace
      // covers that. A track nothing ever binds pauses when it runs out.
      reconcile(publication, entry);
    },

    unregister(publication) {
      const entry = entries.get(publication);
      if (!entry) {
        return;
      }
      clearTimer(entry);
      entries.delete(publication);
    },

    attached(publication) {
      const entry = entries.get(publication);
      if (!entry) {
        return;
      }
      entry.elements += 1;
      reconcile(publication, entry);
    },

    detached(publication) {
      const entry = entries.get(publication);
      if (!entry) {
        return;
      }
      entry.elements = Math.max(0, entry.elements - 1);
      reconcile(publication, entry);
    },

    setTabHidden(hidden) {
      if (hidden === tabHidden) {
        return;
      }
      tabHidden = hidden;
      if (hiddenTimer !== null) {
        clearTimeout(hiddenTimer);
        hiddenTimer = null;
      }
      if (!hidden) {
        tabPaused = false;
        reconcileAll();
        return;
      }
      hiddenTimer = setTimeout(() => {
        hiddenTimer = null;
        tabPaused = true;
        reconcileAll();
      }, hiddenGraceMs);
    },

    isPaused(publication) {
      return entries.get(publication)?.paused ?? false;
    },

    dispose() {
      if (hiddenTimer !== null) {
        clearTimeout(hiddenTimer);
        hiddenTimer = null;
      }
      for (const entry of entries.values()) {
        clearTimer(entry);
      }
      entries.clear();
    },
  };
}

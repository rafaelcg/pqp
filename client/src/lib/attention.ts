/**
 * "Is this window in front of the person?", reported to the server as
 * `set-attention { foreground }`.
 *
 * WHAT THE SERVER DOES WITH IT. With `push_attention_gate` on, a phone is
 * pushed unless at least one of the account's sockets is foreground and not
 * idle. Before this frame, any open socket anywhere silenced every phone, so a
 * tab forgotten in the background or a desktop window minimised all day kept
 * DMs and calls off the lock screen. A server that does not know the frame
 * drops it: the socket router ignores a type it does not route
 * (`server/src/ws/index.ts`), with no error frame and no close.
 *
 * THE RULE. Foreground is "the document is visible AND the window has focus".
 * Becoming foreground is reported at once. Losing it is reported only after
 * `ATTENTION_BACKGROUND_GRACE_MS`, and cancelled if the window comes back
 * first, so alt-tabbing to look something up does not send the next DM to the
 * phone as well. The timer re-checks before it reports, which also covers
 * focus moving into an iframe (the window fires `blur`, but the document
 * still has focus).
 *
 * THE SOCKET FORGETS. Attention is scoped to the socket that sent it, exactly
 * like `set-idle`, so every (re)connect re-announces the current value. A
 * reconnect while the tab is in the background must say so, or the new socket
 * would read as "never declared", which the server treats as foreground.
 *
 * No React and no DOM in the controller, so the rules can be pinned with fake
 * timers; `useAttentionReport` is the binding.
 */

/** How long the window must stay out of the person's way before it says so. */
export const ATTENTION_BACKGROUND_GRACE_MS = 60_000;

export interface AttentionTrackerOptions {
  /** Sends `set-attention` over the chat socket. Only called while connected. */
  send: (foreground: boolean) => void;
  /** Reads the window's current state (visible and focused). */
  isForeground: () => boolean;
  graceMs?: number;
}

export interface AttentionTracker {
  /** Something changed (visibility, focus, blur): look again. */
  evaluate(): void;
  /** The realtime link came up or went down. */
  setConnected(connected: boolean): void;
  /** What this window is declaring right now, after the grace. */
  readonly declared: boolean;
  dispose(): void;
}

export function createAttentionTracker(
  options: AttentionTrackerOptions,
): AttentionTracker {
  const graceMs = options.graceMs ?? ATTENTION_BACKGROUND_GRACE_MS;
  // The state at startup is reported as it is, with no grace: the grace is
  // for absorbing a brief switch away, and a window that opened in the
  // background (a restored tab, a desktop app started minimised) never was
  // in front of anybody.
  let declared = options.isForeground();
  /** What the current socket was last told; null means nothing yet. */
  let reported: boolean | null = null;
  let connected = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const declare = (next: boolean) => {
    declared = next;
    if (connected && reported !== next) {
      reported = next;
      options.send(next);
    }
  };

  return {
    evaluate() {
      if (options.isForeground()) {
        clearTimer();
        declare(true);
        return;
      }
      if (!declared || timer !== null) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        if (!options.isForeground()) {
          declare(false);
        }
      }, graceMs);
    },

    setConnected(next: boolean) {
      connected = next;
      // A new socket knows nothing, an old one is gone: either way the next
      // declaration has to be sent.
      reported = null;
      if (next) {
        declare(declared);
      }
    },

    get declared() {
      return declared;
    },

    dispose() {
      clearTimer();
      connected = false;
    },
  };
}

/** The browser's answer: the page is showing and this window has focus. */
export function documentIsForeground(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return document.visibilityState === "visible" && document.hasFocus();
}

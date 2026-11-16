"use strict";

/**
 * Why the shell answered a display-media request with nothing.
 *
 * Electron turns every `callback(null)` from `setDisplayMediaRequestHandler`
 * into the same rejection in the page: `AbortError: Invalid capture
 * constraints` (`INVALID_DISPLAY_CAPTURE_CONSTRAINTS` in
 * `electron_browser_context.cc`, measured on 44.9.1). A Cancel in the picker,
 * a picker that never loaded (0.2.8), a second request while the picker is
 * open, a surface that closed before it could be handed over and a thrown
 * error all look identical from the page, and the page used to print
 * Chromium's English string as the error. A Windows 11 desktop user saw it
 * again on 16 Nov 2026 with nothing to say which of those it was.
 *
 * So the shell remembers the reason for the request it just refused, and the
 * page, having seen the AbortError, asks for it once. Same rules as
 * `share-silent-retry.js`: the answer belongs to the frame that made the
 * request, is cleared by every new request, is read once, and expires.
 */

const SHARE_REFUSAL_WINDOW_MS = 15_000;

/**
 * Every reason the handler can give. The page maps each to its own sentence;
 * an unknown value from a newer shell reads as "error" there.
 */
const SHARE_REFUSAL_REASONS = Object.freeze([
  // The person closed the picker: Cancel, Escape or the title bar's X.
  "cancelled",
  // A second request arrived while the picker was still open.
  "busy",
  // The picker window did not load, crashed, or never said it was ready.
  "picker-failed",
  // `desktopCapturer` listed nothing (the shell showed its own dialog).
  "no-sources",
  // macOS screen recording is not granted (the shell showed its own dialog).
  "permission",
  // The chosen surface was gone by the time the answer was built.
  "source-gone",
  // The request came from a frame that is not pqp.
  "origin",
  // Anything thrown while building the answer.
  "error",
]);

function createShareRefusal({ now = Date.now, windowMs = SHARE_REFUSAL_WINDOW_MS } = {}) {
  let remembered = null;

  return {
    /** Called at the top of every display-media request. */
    clear() {
      remembered = null;
    },
    /** The request `requester` made was answered with nothing, for `reason`. */
    note(reason, requester = null) {
      const known = SHARE_REFUSAL_REASONS.includes(reason) ? reason : "error";
      remembered = requester !== null ? { reason: known, requester, at: now() } : null;
    },
    /**
     * The page saw its request fail. The reason, once, for the frame that
     * made the request and only within the window; null otherwise.
     */
    take(requester = null) {
      const hit =
        remembered !== null &&
        requester !== null &&
        remembered.requester === requester &&
        now() - remembered.at <= windowMs
          ? remembered.reason
          : null;
      if (hit !== null) {
        remembered = null;
      }
      return hit;
    },
  };
}

module.exports = { SHARE_REFUSAL_WINDOW_MS, SHARE_REFUSAL_REASONS, createShareRefusal };

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
 * page, having seen the AbortError, asks for it once. The answer belongs to
 * the frame that made the request (`requesterKey`, as in
 * `share-silent-retry.js`), is read once, and expires.
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

/** More unread refusals than this from one frame means nobody is reading them. */
const SHARE_REFUSAL_MAX_PENDING = 8;

function createShareRefusal({ now = Date.now, windowMs = SHARE_REFUSAL_WINDOW_MS } = {}) {
  // Oldest first. Two requests from one frame can overlap (a second share
  // while the picker is open is refused at once as "busy", the first ends
  // later as whatever the person did), and each rejection reaches the page in
  // the order its refusal was noted, so each `take` gets the oldest one left:
  // every failed request reads its own reason, never its neighbour's.
  let pending = [];

  function prune() {
    const cutoff = now() - windowMs;
    pending = pending.filter((entry) => entry.at >= cutoff);
  }

  return {
    /** The request `requester` made was answered with nothing, for `reason`. */
    note(reason, requester = null) {
      if (requester === null) {
        return;
      }
      prune();
      const known = SHARE_REFUSAL_REASONS.includes(reason) ? reason : "error";
      pending.push({ reason: known, requester, at: now() });
      const mine = pending.filter((entry) => entry.requester === requester);
      if (mine.length > SHARE_REFUSAL_MAX_PENDING) {
        const drop = mine[0];
        pending = pending.filter((entry) => entry !== drop);
      }
    },
    /**
     * The page saw its request fail. The oldest unread reason for that frame,
     * once and only within the window; null otherwise.
     */
    take(requester = null) {
      if (requester === null) {
        return null;
      }
      prune();
      const index = pending.findIndex((entry) => entry.requester === requester);
      if (index < 0) {
        return null;
      }
      const [hit] = pending.splice(index, 1);
      return hit.reason;
    },
  };
}

module.exports = {
  SHARE_REFUSAL_WINDOW_MS,
  SHARE_REFUSAL_MAX_PENDING,
  SHARE_REFUSAL_REASONS,
  createShareRefusal,
};

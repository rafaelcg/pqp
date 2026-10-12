"use strict";

/**
 * PQP-31: a share whose computer sound will not open goes out without sound
 * instead of not going out at all.
 *
 * Chromium decides whether the loopback device opens AFTER this shell has
 * answered the display-media request, and a loopback that fails rejects the
 * whole capture with `NotReadableError`, picture included. The handler never
 * hears about it, so it cannot retry by itself. The page can, but a second
 * `getDisplayMedia` would open the picker again for a surface the person
 * chose a second ago.
 *
 * So the shell remembers the surface of the request it just answered with
 * loopback, and the page, having seen that request fail, arms one video-only
 * retry. The next request then gets that same surface without a picker.
 *
 * Every request clears the memory before anything else, so `arm()` is true
 * only when the most recent request carried loopback: a cancelled picker, an
 * auto-pick or a share without sound leaves nothing to retry. The retry is
 * one-shot, never carries audio, and expires after `windowMs`, because the
 * rejection lands within a second of the answer and a stale surface is a
 * share nobody picked.
 */

const SILENT_RETRY_WINDOW_MS = 15_000;

function createShareSilentRetry({ now = Date.now, windowMs = SILENT_RETRY_WINDOW_MS } = {}) {
  let remembered = null;
  let armed = false;

  function fresh() {
    return remembered !== null && now() - remembered.at <= windowMs;
  }

  return {
    /**
     * Called at the top of every display-media request. Returns the surface
     * to reuse when the page armed a retry and this request is the video-only
     * one it promised, otherwise null. Clears the memory either way.
     */
    take(audioRequested) {
      const reuse = armed && audioRequested !== true && fresh() ? remembered.source : null;
      remembered = null;
      armed = false;
      return reuse;
    },
    /** The request just answered carried loopback for `source`. */
    rememberLoopback(source) {
      remembered = source ? { source, at: now() } : null;
      armed = false;
    },
    /** The page saw that request fail. True when a retry is now armed. */
    arm() {
      armed = fresh();
      if (!armed) {
        remembered = null;
      }
      return armed;
    },
  };
}

module.exports = { SILENT_RETRY_WINDOW_MS, createShareSilentRetry };

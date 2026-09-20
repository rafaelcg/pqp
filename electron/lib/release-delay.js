/**
 * Release-delay tracker: the pure half of the native-hook push-to-talk path.
 *
 * `lib/global-ptt.js` has to INFER a release from `globalShortcut`
 * auto-repeat, because that API only ever reports key-down. The native hook
 * (`lib/native-ptt-hook.js`, `uiohook-napi`) gives a real key-up (and a real
 * mouse-button-up), so there is nothing to infer here. But Discord-quality
 * push-to-talk still does not release the instant the physical key comes up.
 * Word endings get clipped if it does: the mic has to stay open a little
 * longer than the finger does. That "a little longer" is what this module
 * turns into a timer.
 *
 * The shape mirrors `createHoldTracker` on purpose (same press/release/held
 * contract, same injectable clock for the test suite) even though the logic
 * is simpler: there is no auto-repeat to reason about, only one delay to
 * apply on the way down from held to not-held.
 */

const DEFAULT_RELEASE_DELAY_MS = 20;
const MIN_RELEASE_DELAY_MS = 0;
const MAX_RELEASE_DELAY_MS = 2000;

/**
 * Clamp a release-delay setting to the range the slider offers. Anything
 * else (a hand-edited `localStorage` blob, a future build that widened the
 * range and got rolled back) falls back to the default rather than arming a
 * negative or runaway timer.
 */
function clampReleaseDelayMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_RELEASE_DELAY_MS;
  }
  return Math.min(MAX_RELEASE_DELAY_MS, Math.max(MIN_RELEASE_DELAY_MS, Math.round(value)));
}

/**
 * @param {(held: boolean) => void} onChange
 * @param {{ delayMs?: number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} [options]
 */
function createReleaseDelayTracker(onChange, options = {}) {
  let delayMs = clampReleaseDelayMs(options.delayMs ?? DEFAULT_RELEASE_DELAY_MS);
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;

  let held = false;
  let timer = null;

  function clearPending() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  /**
   * A physical press. Cancels any pending delayed release. This is the
   * whole point: a quick up-then-down (stammering into the same word, a key
   * that bounces) must not close the mic in between, and `press` inside the
   * delay window is exactly that case.
   */
  function press() {
    clearPending();
    if (!held) {
      held = true;
      onChange(true);
    }
  }

  /**
   * A physical release. Does not close the mic immediately; arms a timer
   * for the configured delay, and `press` above can still cancel it.
   */
  function release() {
    if (!held || timer !== null) {
      // Not held, or a release is already pending: nothing new to schedule.
      return;
    }
    if (delayMs <= 0) {
      held = false;
      onChange(false);
      return;
    }
    timer = setTimer(() => {
      timer = null;
      held = false;
      onChange(false);
    }, delayMs);
  }

  /** Update the delay for future releases. Does not affect one already timing. */
  function setDelayMs(nextDelayMs) {
    delayMs = clampReleaseDelayMs(nextDelayMs);
  }

  /** Drop everything and close the mic now, no delay. For teardown paths. */
  function forceRelease() {
    clearPending();
    if (held) {
      held = false;
      onChange(false);
    }
  }

  return {
    press,
    release,
    setDelayMs,
    dispose: forceRelease,
    forceRelease,
    get held() {
      return held;
    },
    get delayMs() {
      return delayMs;
    },
  };
}

module.exports = {
  DEFAULT_RELEASE_DELAY_MS,
  MIN_RELEASE_DELAY_MS,
  MAX_RELEASE_DELAY_MS,
  clampReleaseDelayMs,
  createReleaseDelayTracker,
};

/**
 * Global push-to-talk: the pure half of what `globalShortcut` cannot do.
 *
 * Electron's `globalShortcut` reports a key going DOWN and nothing else. There
 * is no key-up event, and there is no API to ask whether a key is still held.
 * Push-to-talk is defined by the release, so the release has to be inferred.
 *
 * What the OS does give us is auto-repeat: while a registered accelerator is
 * held, the callback fires again at the keyboard's repeat rate. The tracker
 * below turns that stream into a `held` boolean: the first press engages,
 * every repeat extends a deadline, and the deadline passing is the release.
 *
 * Two deadlines, because the first repeat is slower than the rest. Every
 * desktop waits an "initial delay" (250 ms to about a second, user-tunable)
 * before it starts repeating, then repeats every 30 to 100 ms. So the tracker
 * allows a long gap after the first press and a short gap between repeats.
 * A quick tap therefore keeps the mic open for `FIRST_REPEAT_GRACE_MS` at
 * most; a held key lets go `REPEAT_GAP_MS` after the finger does.
 *
 * On a system that does not repeat global hotkeys at all, a hold becomes a
 * pulse of `FIRST_REPEAT_GRACE_MS`. That is the honest ceiling of this
 * approach without a native keyboard hook, and the README says so.
 *
 * None of this runs while the app window is focused: the main process only
 * registers the accelerator on blur and drops it on focus, so in-window
 * push-to-talk keeps the renderer's exact keydown / keyup pair.
 */

const FIRST_REPEAT_GRACE_MS = 1100;
const REPEAT_GAP_MS = 250;

/**
 * Electron accelerator grammar, narrowed to what the client produces (see
 * client/src/components/voice/push-to-talk-accelerator.ts). Anything else is
 * refused before it reaches `globalShortcut.register`, which throws on
 * garbage and would take the IPC handler down with it.
 */
const ACCELERATOR_RE =
  /^((Control|Alt|Shift|Super)\+){0,4}([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|num[0-9]|numadd|numsub|nummult|numdiv|numdec|Space|Capslock|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Scrolllock|Pause|PrintScreen|Numlock|[`\-=[\]\\;',./])$/;

function isAcceptableAccelerator(value) {
  return typeof value === "string" && ACCELERATOR_RE.test(value);
}

/**
 * @param {(held: boolean) => void} onChange
 * @param {{ firstRepeatGraceMs?: number, repeatGapMs?: number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} [options]
 */
function createHoldTracker(onChange, options = {}) {
  const firstGrace = options.firstRepeatGraceMs ?? FIRST_REPEAT_GRACE_MS;
  const repeatGap = options.repeatGapMs ?? REPEAT_GAP_MS;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;

  let held = false;
  let sawRepeat = false;
  let timer = null;

  function arm(ms) {
    if (timer !== null) {
      clearTimer(timer);
    }
    timer = setTimer(() => {
      timer = null;
      release();
    }, ms);
  }

  function press() {
    if (!held) {
      held = true;
      sawRepeat = false;
      onChange(true);
      arm(firstGrace);
      return;
    }
    // A repeat. From here on the key is expected to keep reporting at the
    // repeat rate, so the allowed silence shrinks to the repeat gap.
    sawRepeat = true;
    arm(repeatGap);
  }

  function release() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (!held) {
      return;
    }
    held = false;
    sawRepeat = false;
    onChange(false);
  }

  return {
    press,
    release,
    dispose: release,
    get held() {
      return held;
    },
    get sawRepeat() {
      return sawRepeat;
    },
  };
}

module.exports = {
  FIRST_REPEAT_GRACE_MS,
  REPEAT_GAP_MS,
  isAcceptableAccelerator,
  createHoldTracker,
};

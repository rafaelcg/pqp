/**
 * The clocks behind the call's speaking detector (`voice_calm_detector`).
 *
 * WHAT WAS WRONG. The detector read every peer's analyser inside a
 * `requestAnimationFrame` callback, which runs at the display's refresh rate:
 * 120 times a second on a ProMotion laptop, whether or not anything on the
 * screen changed. Alone in a quiet call that single loop was the only thing
 * waking the page (`client/bench/call-who-wakes.mjs`), and each wake-up is a
 * whole frame pipeline in the renderer and the GPU process, not just a few
 * microseconds of script; the desktop shell turns background throttling off, so
 * a minimized window kept doing it. The speaking ring does not need a reading
 * every 8 ms: the hangover that holds it is 280 ms.
 *
 * WHAT THIS DOES.
 *  - The ring loop runs on a timer: `SPEAKING_POLL_VISIBLE_MS` (20 Hz) while the
 *    window is visible, `SPEAKING_POLL_HIDDEN_MS` (4 Hz) when it is hidden or
 *    minimized. It is slowed down while hidden, not stopped: the same state
 *    ducks the music player and nobody should lose that with the window.
 *  - The analyser smooths per call, so a third of the calls would also be a
 *    slower rise. `analyserSmoothingFor` keeps the smoothing the same in
 *    wall-clock time (`smoothing ** (interval / frame)`), which is what keeps
 *    the ring lighting as quickly as it did.
 *  - The transmit gate (voice activity) is what decides whether a syllable
 *    leaves this machine, so it keeps a clock as fast as a 60 Hz screen's: 16 ms
 *    while it has anything to decide and the window is visible, and the 50 ms
 *    interval it always had as the backstop when hidden. Nothing here touches
 *    the audio, the mic, push-to-talk or what the server hears.
 *
 * Pure scheduling with injectable timers, so the rates are a test and not a
 * measurement.
 */

/** The speaking ring's reading rate while the window is visible. */
export const SPEAKING_POLL_VISIBLE_MS = 50;
/** And while it is hidden or minimized (the music ducking still follows it). */
export const SPEAKING_POLL_HIDDEN_MS = 250;
/** The transmit gate's clock while it has something to decide and the window is visible. */
export const GATE_FAST_POLL_MS = 16;
/** How often an idle gate clock looks again for something to decide. */
export const GATE_IDLE_RECHECK_MS = 100;

/** One frame of a 60 Hz screen, the cadence the analysers' smoothing was tuned at. */
const FRAME_MS = 1000 / 60;
/** `createStreamAnalyser`'s own smoothing, per call. */
export const ANALYSER_SMOOTHING = 0.65;

/**
 * The smoothing that gives, at one call every `intervalMs`, the same decay in
 * wall-clock time as `ANALYSER_SMOOTHING` gives at one call per frame.
 */
export function analyserSmoothingFor(intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= FRAME_MS) {
    return ANALYSER_SMOOTHING;
  }
  return Math.min(0.99, ANALYSER_SMOOTHING ** (intervalMs / FRAME_MS));
}

export interface ClockEnv {
  /** Timer functions, injectable for tests. */
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  requestAnimationFrame: (fn: () => void) => number;
  cancelAnimationFrame: (handle: number) => void;
  /** Whether the window is hidden or minimized right now. */
  isHidden: () => boolean;
  /** Tell `listener` when visibility changes. Returns the unsubscribe. */
  onVisibilityChange: (listener: () => void) => () => void;
}

export function browserClockEnv(): ClockEnv {
  return {
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      // A Node test runner treats a live timer as an open handle; the browser
      // returns a number, which has no unref.
      if (typeof handle === "object" && handle !== null && "unref" in handle) {
        (handle as { unref: () => void }).unref();
      }
      return handle;
    },
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    requestAnimationFrame: (fn) => requestAnimationFrame(() => fn()),
    cancelAnimationFrame: (handle) => {
      // Absent in a test that swapped the globals out under a running loop.
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(handle);
      }
    },
    isHidden: () =>
      typeof document !== "undefined" && document.visibilityState === "hidden",
    onVisibilityChange: (listener) => {
      if (typeof document === "undefined") {
        return () => {};
      }
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}

export interface SpeakingScheduler {
  /** Run `step` after the next interval (a timer) or frame (the old loop). */
  next(step: () => void): void;
  /** Cancel whatever is pending. */
  cancel(): void;
  /**
   * Run the pending step now, once: the window just became visible and the
   * ring should be right at once, not up to 250 ms later.
   */
  poke(): void;
  /** The interval the next step waits, or null when a frame decides (the old loop). */
  intervalMs(): number | null;
}

/**
 * Schedules the ring loop's steps. `calm()` is read on every step, so the
 * runtime flag moves a call that is already running from one clock to the
 * other without a rejoin.
 */
export function createSpeakingScheduler(
  calm: () => boolean,
  env: ClockEnv = browserClockEnv(),
): SpeakingScheduler {
  let frame = 0;
  let timer: unknown = null;
  let pending: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;

  function clear() {
    if (frame) {
      env.cancelAnimationFrame(frame);
      frame = 0;
    }
    if (timer !== null) {
      env.clearTimeout(timer);
      timer = null;
    }
  }

  function intervalMs(): number | null {
    if (!calm()) {
      return null;
    }
    return env.isHidden() ? SPEAKING_POLL_HIDDEN_MS : SPEAKING_POLL_VISIBLE_MS;
  }

  function poke() {
    const step = pending;
    if (!step) {
      return;
    }
    clear();
    step();
  }

  return {
    next(step) {
      clear();
      pending = step;
      const wait = intervalMs();
      if (wait === null) {
        frame = env.requestAnimationFrame(() => {
          frame = 0;
          step();
        });
        return;
      }
      timer = env.setTimeout(() => {
        timer = null;
        step();
      }, wait);
      if (!unsubscribe) {
        unsubscribe = env.onVisibilityChange(() => {
          if (pending && timer !== null && !env.isHidden()) {
            poke();
          }
        });
      }
    },
    cancel() {
      clear();
      pending = null;
      unsubscribe?.();
      unsubscribe = null;
    },
    poke,
    intervalMs,
  };
}

export interface GateClockOptions {
  /** True when the gate has something to decide: voice activity mode, a live mic, visible. */
  eligible: () => boolean;
  /** One reading of the gate. */
  run: () => void;
  /** Whether the feature is on, read every step. */
  calm: () => boolean;
}

/**
 * A clock for the transmit gate that is as quick as a 60 Hz screen's frame
 * while the gate has something to decide, and idle (one look every 100 ms)
 * when it does not. It only exists while `calm()` is on: with the flag off its
 * chain of timers ends at the next step and nothing is armed, so the old
 * frame-driven loop is all there is. `sync()` (called by the ring loop on every
 * step) re-arms it when the flag comes on mid-call.
 */
export function createGateClock(
  options: GateClockOptions,
  env: ClockEnv = browserClockEnv(),
): { start(): void; sync(): void; stop(): void } {
  let timer: unknown = null;
  let active = false;

  function arm(wait: number) {
    timer = env.setTimeout(step, wait);
  }

  function step() {
    timer = null;
    if (!active || !options.calm()) {
      return; // the chain ends; `sync()` starts it again if the flag returns
    }
    let wait = GATE_IDLE_RECHECK_MS;
    if (!env.isHidden() && options.eligible()) {
      options.run();
      wait = GATE_FAST_POLL_MS;
    }
    arm(wait);
  }

  function sync() {
    if (active && timer === null && options.calm()) {
      arm(GATE_IDLE_RECHECK_MS);
    }
  }

  return {
    start() {
      active = true;
      sync();
    },
    sync,
    stop() {
      active = false;
      if (timer !== null) {
        env.clearTimeout(timer);
        timer = null;
      }
    },
  };
}

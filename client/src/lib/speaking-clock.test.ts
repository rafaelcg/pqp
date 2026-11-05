import { describe, expect, it } from "vitest";
import {
  ANALYSER_SMOOTHING,
  analyserSmoothingFor,
  createGateClock,
  createSpeakingScheduler,
  GATE_FAST_POLL_MS,
  GATE_IDLE_RECHECK_MS,
  SPEAKING_POLL_HIDDEN_MS,
  SPEAKING_POLL_VISIBLE_MS,
  type ClockEnv,
} from "./speaking-clock";

/** A clock the test winds by hand: timers, frames and visibility. */
function fakeEnv() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const frames = new Map<number, () => void>();
  const listeners = new Set<() => void>();
  const state = { hidden: false };
  const env: ClockEnv = {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    requestAnimationFrame: (fn) => {
      const id = nextId++;
      frames.set(id, fn);
      return id;
    },
    cancelAnimationFrame: (handle) => {
      frames.delete(handle);
    },
    isHidden: () => state.hidden,
    onVisibilityChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    env,
    state,
    pendingTimers: () => timers.size,
    pendingFrames: () => frames.size,
    /** Advance time, firing every timer that comes due (and any it schedules). */
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) {
          break;
        }
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    /** One display frame. */
    frame() {
      const [id, fn] = [...frames.entries()][0] ?? [];
      if (id !== undefined && fn) {
        frames.delete(id);
        fn();
      }
    },
    setHidden(hidden: boolean) {
      state.hidden = hidden;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

describe("analyserSmoothingFor", () => {
  it("leaves the per-frame smoothing alone at frame rate and faster", () => {
    expect(analyserSmoothingFor(1000 / 60)).toBe(ANALYSER_SMOOTHING);
    expect(analyserSmoothingFor(8)).toBe(ANALYSER_SMOOTHING);
    expect(analyserSmoothingFor(Number.NaN)).toBe(ANALYSER_SMOOTHING);
  });

  it("keeps the decay per second the same at a slower rate", () => {
    // At 60 reads a second the leftover of the old reading after one second is
    // smoothing ** 60. At one read every 50 ms it must be the same number.
    const perSecondFrame = ANALYSER_SMOOTHING ** 60;
    const perSecondCalm = analyserSmoothingFor(SPEAKING_POLL_VISIBLE_MS) ** (1000 / SPEAKING_POLL_VISIBLE_MS);
    expect(perSecondCalm).toBeCloseTo(perSecondFrame, 12);
  });

  it("is never 1, which would freeze the meter", () => {
    expect(analyserSmoothingFor(60_000)).toBeLessThan(1);
  });
});

describe("createSpeakingScheduler", () => {
  it("waits for a frame, as it always did, while the flag is off", () => {
    const fake = fakeEnv();
    const scheduler = createSpeakingScheduler(() => false, fake.env);
    let runs = 0;
    const step = () => {
      runs += 1;
      scheduler.next(step);
    };
    scheduler.next(step);
    expect(fake.pendingFrames()).toBe(1);
    expect(fake.pendingTimers()).toBe(0);
    expect(scheduler.intervalMs()).toBeNull();
    fake.frame();
    fake.frame();
    expect(runs).toBe(2);
    // No timer is ever armed on this path, so nothing can double-run a step.
    expect(fake.pendingTimers()).toBe(0);
  });

  it("runs at 20 Hz while visible and 4 Hz while hidden, with the flag on", () => {
    const fake = fakeEnv();
    const scheduler = createSpeakingScheduler(() => true, fake.env);
    let runs = 0;
    const step = () => {
      runs += 1;
      scheduler.next(step);
    };
    scheduler.next(step);
    expect(fake.pendingFrames()).toBe(0);
    fake.advance(1000);
    expect(runs).toBe(1000 / SPEAKING_POLL_VISIBLE_MS);
    expect(scheduler.intervalMs()).toBe(SPEAKING_POLL_VISIBLE_MS);

    fake.state.hidden = true;
    runs = 0;
    fake.advance(1000 + SPEAKING_POLL_VISIBLE_MS);
    expect(scheduler.intervalMs()).toBe(SPEAKING_POLL_HIDDEN_MS);
    // The step in flight finishes on the old interval, then every 250 ms.
    expect(runs).toBeLessThanOrEqual(1000 / SPEAKING_POLL_HIDDEN_MS + 1);
    expect(runs).toBeGreaterThanOrEqual(1000 / SPEAKING_POLL_HIDDEN_MS - 1);
  });

  it("does not stop while hidden, so the music ducking still follows speech", () => {
    const fake = fakeEnv();
    fake.state.hidden = true;
    const scheduler = createSpeakingScheduler(() => true, fake.env);
    let runs = 0;
    const step = () => {
      runs += 1;
      scheduler.next(step);
    };
    scheduler.next(step);
    fake.advance(10_000);
    expect(runs).toBe(10_000 / SPEAKING_POLL_HIDDEN_MS);
  });

  it("reads at once when the window comes back instead of waiting out a slow tick", () => {
    const fake = fakeEnv();
    fake.state.hidden = true;
    const scheduler = createSpeakingScheduler(() => true, fake.env);
    let runs = 0;
    const step = () => {
      runs += 1;
      scheduler.next(step);
    };
    scheduler.next(step);
    fake.advance(10);
    expect(runs).toBe(0);
    fake.setHidden(false);
    expect(runs).toBe(1);
    // And the new step is on the visible interval.
    fake.advance(SPEAKING_POLL_VISIBLE_MS);
    expect(runs).toBe(2);
  });

  it("follows the flag live: a call already running moves from frames to the timer and back", () => {
    const fake = fakeEnv();
    let calm = false;
    const scheduler = createSpeakingScheduler(() => calm, fake.env);
    let runs = 0;
    const step = () => {
      runs += 1;
      scheduler.next(step);
    };
    scheduler.next(step);
    fake.frame();
    expect(runs).toBe(1);
    expect(fake.pendingFrames()).toBe(1);

    calm = true;
    fake.frame(); // the pending frame runs, and the next step is a timer
    expect(runs).toBe(2);
    expect(fake.pendingFrames()).toBe(0);
    expect(fake.pendingTimers()).toBe(1);
    fake.advance(SPEAKING_POLL_VISIBLE_MS);
    expect(runs).toBe(3);

    calm = false;
    fake.advance(SPEAKING_POLL_VISIBLE_MS); // the pending timer runs, the next step is a frame
    expect(runs).toBe(4);
    expect(fake.pendingTimers()).toBe(0);
    expect(fake.pendingFrames()).toBe(1);
  });

  it("cancel leaves nothing pending, timer or frame", () => {
    const fake = fakeEnv();
    let calm = true;
    const scheduler = createSpeakingScheduler(() => calm, fake.env);
    scheduler.next(() => {});
    expect(fake.pendingTimers()).toBe(1);
    scheduler.cancel();
    expect(fake.pendingTimers()).toBe(0);
    calm = false;
    scheduler.next(() => {});
    expect(fake.pendingFrames()).toBe(1);
    scheduler.cancel();
    expect(fake.pendingFrames()).toBe(0);
    // A visibility change after cancel runs nothing.
    fake.setHidden(true);
    fake.setHidden(false);
    expect(fake.pendingTimers()).toBe(0);
  });
});

describe("createGateClock", () => {
  function setup(flags: { calm: boolean; eligible: boolean }) {
    const fake = fakeEnv();
    let runs = 0;
    const clock = createGateClock(
      { calm: () => flags.calm, eligible: () => flags.eligible, run: () => (runs += 1) },
      fake.env,
    );
    return { fake, clock, runs: () => runs, flags };
  }

  it("reads the gate every 16 ms while it has something to decide and the window is visible", () => {
    const { fake, clock, runs } = setup({ calm: true, eligible: true });
    clock.start();
    fake.advance(GATE_IDLE_RECHECK_MS); // the first look
    const before = runs();
    fake.advance(1000);
    expect(runs() - before).toBeGreaterThanOrEqual(Math.floor(1000 / GATE_FAST_POLL_MS) - 1);
    expect(runs() - before).toBeLessThanOrEqual(Math.ceil(1000 / GATE_FAST_POLL_MS) + 1);
  });

  it("only looks every 100 ms when there is nothing to decide, and reads nothing", () => {
    const { fake, clock, runs } = setup({ calm: true, eligible: false });
    clock.start();
    fake.advance(1000);
    expect(runs()).toBe(0);
    expect(fake.pendingTimers()).toBe(1);
  });

  it("is quiet with the flag off: the frame loop reads the gate as it always did", () => {
    const { fake, clock, runs } = setup({ calm: false, eligible: true });
    clock.start();
    fake.advance(2000);
    expect(runs()).toBe(0);
  });

  it("leaves a hidden window to the 50 ms interval that was always there", () => {
    const { fake, clock, runs } = setup({ calm: true, eligible: true });
    fake.state.hidden = true;
    clock.start();
    fake.advance(2000);
    expect(runs()).toBe(0);
  });

  it("picks up eligibility as it changes and stops cleanly", () => {
    const { fake, clock, runs, flags } = setup({ calm: true, eligible: false });
    clock.start();
    fake.advance(500);
    expect(runs()).toBe(0);
    flags.eligible = true;
    fake.advance(GATE_IDLE_RECHECK_MS + 5 * GATE_FAST_POLL_MS);
    expect(runs()).toBeGreaterThan(0);
    clock.stop();
    const after = runs();
    fake.advance(1000);
    expect(runs()).toBe(after);
    expect(fake.pendingTimers()).toBe(0);
  });

  it("start twice does not double the clock", () => {
    const { fake, clock, runs } = setup({ calm: true, eligible: true });
    clock.start();
    clock.start();
    fake.advance(GATE_IDLE_RECHECK_MS);
    const before = runs();
    fake.advance(160);
    expect(runs() - before).toBeLessThanOrEqual(11);
  });
});

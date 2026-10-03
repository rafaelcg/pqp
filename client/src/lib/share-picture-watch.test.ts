import { describe, expect, it, vi } from "vitest";
import { startSharePictureWatch, type FrameReader } from "./share-picture-watch";

/**
 * The watch around `judgePicture`, driven by hand: frames are pushed into a
 * fake reader, the clock and the interval are ours. The point of these is the
 * rule that keeps a still slide out: QUIET or BLACK pixels alone never reach
 * the presenter, only a verdict the shell confirms.
 */

const W = 32 * 18;
const black = () => new Uint8Array(W);
const bright = (step: number) => Uint8Array.from({ length: W }, (_, i) => (i * 7 + step * 31) % 200 + 40);
const slide = () => Uint8Array.from({ length: W }, (_, i) => (i % 5 === 0 ? 30 : 235));

interface FakeFrame {
  grid: Uint8Array;
  close(): void;
}

function rig(
  confirmAnswer: boolean | null,
  options: {
    /** Does the capture answer a refresh (a live capturer does, even for a still picture)? */
    refresh?: boolean;
    /** Hand back the shell's answer by hand, to land it late. */
    deferConfirm?: boolean;
  } = {},
) {
  let clock = 0;
  const pendingConfirms: Array<(answer: boolean | null) => void> = [];
  let tick: (() => void) | null = null;
  const waiting: Array<(r: { done: boolean; value?: FakeFrame }) => void> = [];
  const queued: FakeFrame[] = [];
  let opened = 0;
  let stoppedReaders = 0;
  const listeners = new Map<string, () => void>();
  const track = {
    muted: false,
    readyState: "live",
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    getSettings: () => ({ displaySurface: "monitor" }),
  } as unknown as MediaStreamTrack;
  const reader: FrameReader = {
    read: () =>
      new Promise((resolve) => {
        const next = queued.shift();
        if (next) {
          resolve({ done: false, value: next });
        } else {
          waiting.push(resolve as (r: { done: boolean; value?: FakeFrame }) => void);
        }
      }),
    cancel: () => {
      for (const w of waiting.splice(0)) w({ done: true });
    },
  };
  const confirm = vi.fn(() =>
    options.deferConfirm
      ? new Promise<boolean | null>((resolve) => pendingConfirms.push(resolve))
      : Promise.resolve(confirmAnswer),
  );
  const probe = vi.fn(async () => options.refresh ?? false);
  const onDead = vi.fn();
  const watch = startSharePictureWatch({
    track,
    onDead,
    confirm,
    deps: {
      probe,
      openReader: () => {
        opened += 1;
        return {
          reader,
          stop: () => {
            stoppedReaders += 1;
            reader.cancel();
          },
        };
      },
      gridOf: (frame) => (frame as FakeFrame).grid,
      now: () => clock,
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => {
        tick = null;
      },
    },
  });
  const frame = (grid: Uint8Array) => {
    const f: FakeFrame = { grid, close: () => {} };
    const w = waiting.shift();
    if (w) w({ done: false, value: f });
    else queued.push(f);
  };
  /** Advance one 2 s sample, delivering `frames` frames of `grid` first. */
  const step = async (grid: Uint8Array | null, frames = 30) => {
    if (grid) {
      for (let i = 0; i < frames; i += 1) {
        clock += 2_000 / frames;
        frame(grid);
        await Promise.resolve();
        await Promise.resolve();
      }
    } else {
      clock += 2_000;
    }
    tick?.();
    // Let a probe and a confirmation settle.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  /** Let microtasks run (a probe and a confirmation are a few hops each). */
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  /** Land the oldest deferred shell answer. */
  const answer = async (value: boolean | null) => {
    pendingConfirms.shift()?.(value);
    await flush();
  };
  /** The share's track ends: the clone's stream says done. */
  const endStream = async () => {
    for (const w of waiting.splice(0)) w({ done: true });
    await flush();
  };
  return {
    watch,
    step,
    flush,
    answer,
    endStream,
    confirm,
    probe,
    onDead,
    listeners,
    get pendingConfirms() {
      return pendingConfirms.length;
    },
    get ticking() {
      return tick !== null;
    },
    get opened() {
      return opened;
    },
    get stoppedReaders() {
      return stoppedReaders;
    },
    track,
  };
}

describe("startSharePictureWatch", () => {
  it("reports a black capture once the shell confirms exclusive fullscreen", async () => {
    const r = rig(true);
    for (let i = 0; i < 6; i += 1) await r.step(black());
    expect(r.confirm).toHaveBeenCalled();
    expect(r.onDead).toHaveBeenCalledTimes(1);
    expect(r.onDead).toHaveBeenCalledWith("black");
    expect(r.watch.status().reported).toBe("black");
    // Reported once, then the clone is let go.
    expect(r.ticking).toBe(false);
    expect(r.stoppedReaders).toBeGreaterThan(0);
  });

  it("reports a frozen game (frames stop, a refresh gets nothing back) as stalled when confirmed", async () => {
    const r = rig(true, { refresh: false });
    await r.step(bright(1));
    await r.step(bright(2));
    for (let i = 0; i < 6; i += 1) await r.step(null);
    expect(r.probe).toHaveBeenCalled();
    expect(r.onDead).toHaveBeenCalledWith("stalled");
    expect(r.watch.status().refreshAnswered).toBe(false);
  });

  it("never reports a STILL game in exclusive fullscreen: the capture answers a refresh", async () => {
    // Farol, PR 946: zero-hertz capture stops delivering for a paused frame
    // or a static menu, and the shell says yes to fullscreen all the same.
    // The refresh probe is the independent proof that the capture is alive.
    const r = rig(true, { refresh: true });
    await r.step(bright(1));
    for (let i = 0; i < 25; i += 1) await r.step(null);
    expect(r.watch.status().suspected).toBe("quiet");
    expect(r.probe).toHaveBeenCalled();
    expect(r.watch.status().refreshAnswered).toBe(true);
    // The shell is not even asked: the capture proved itself alive first.
    expect(r.confirm).not.toHaveBeenCalled();
    expect(r.onDead).not.toHaveBeenCalled();
  });

  it("does not probe a BLACK capture: the pixels are the proof", async () => {
    const r = rig(true, { refresh: true });
    for (let i = 0; i < 6; i += 1) await r.step(black());
    expect(r.probe).not.toHaveBeenCalled();
    expect(r.onDead).toHaveBeenCalledWith("black");
  });

  it("a stream that ends is the ended path, never a stalled verdict", async () => {
    // Farol, PR 946: the reader saying `done` used to leave the interval
    // running with a frame count that could only sit still.
    const r = rig(true, { refresh: false });
    await r.step(bright(1));
    await r.endStream();
    expect(r.ticking).toBe(false);
    expect(r.watch.status().running).toBe(false);
    for (let i = 0; i < 10; i += 1) await r.step(null);
    expect(r.onDead).not.toHaveBeenCalled();
  });

  it("a late yes from the shell after a mute reports nothing", async () => {
    // Farol, PR 946: a confirmation in flight outlived its window.
    const r = rig(true, { deferConfirm: true });
    for (let i = 0; i < 6; i += 1) await r.step(black());
    expect(r.pendingConfirms).toBe(1);
    r.listeners.get("mute")?.();
    await r.answer(true);
    expect(r.onDead).not.toHaveBeenCalled();
    expect(r.watch.status().suspected).toBeNull();
  });

  it("a late yes after a re-arm reports nothing from the old window", async () => {
    const r = rig(true, { deferConfirm: true });
    for (let i = 0; i < 6; i += 1) await r.step(black());
    r.watch.rearm();
    await r.answer(true);
    expect(r.onDead).not.toHaveBeenCalled();
    // The new window starts from nothing and has to earn its own verdict.
    await r.step(bright(1));
    expect(r.watch.status().suspected).toBeNull();
  });

  it("a late yes after the picture came back reports nothing", async () => {
    const r = rig(true, { deferConfirm: true });
    for (let i = 0; i < 6; i += 1) await r.step(black());
    await r.step(bright(1));
    await r.answer(true);
    expect(r.onDead).not.toHaveBeenCalled();
  });

  it("a late yes after the minute ran out reports nothing", async () => {
    const r = rig(true, { deferConfirm: true });
    for (let i = 0; i < 25; i += 1) await r.step(bright(i));
    for (let i = 0; i < 6; i += 1) await r.step(black());
    expect(r.ticking).toBe(false);
    await r.answer(true);
    expect(r.onDead).not.toHaveBeenCalled();
  });

  it("never reports a still slide: no frames under zero-hertz, and no exclusive-fullscreen app", async () => {
    const r = rig(false);
    await r.step(slide(), 1);
    for (let i = 0; i < 25; i += 1) await r.step(null);
    expect(r.watch.status().suspected).toBe("quiet");
    expect(r.confirm).toHaveBeenCalled();
    expect(r.onDead).not.toHaveBeenCalled();
    expect(r.watch.status().exclusiveFullscreen).toBe(false);
  });

  it("never reports when the shell cannot tell (older shell, PowerShell refused)", async () => {
    const r = rig(null);
    for (let i = 0; i < 10; i += 1) await r.step(black());
    expect(r.onDead).not.toHaveBeenCalled();
  });

  it("asks the shell at most every 6 s while it suspects", async () => {
    const r = rig(false);
    for (let i = 0; i < 12; i += 1) await r.step(black());
    // Suspected from t = 10 s to t = 24 s: asks at 10, 16, 22.
    expect(r.confirm.mock.calls.length).toBeLessThanOrEqual(3);
    expect(r.confirm.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not ask the shell at all for a healthy game", async () => {
    const r = rig(true);
    for (let i = 0; i < 20; i += 1) await r.step(bright(i));
    expect(r.confirm).not.toHaveBeenCalled();
    expect(r.onDead).not.toHaveBeenCalled();
  });

  it("stops sampling after the first minute", async () => {
    const r = rig(true);
    for (let i = 0; i < 31; i += 1) await r.step(bright(i));
    expect(r.ticking).toBe(false);
    expect(r.watch.status().running).toBe(false);
  });

  it("opens a fresh minute when the track comes back from a mute", async () => {
    const r = rig(true);
    for (let i = 0; i < 31; i += 1) await r.step(bright(i));
    expect(r.ticking).toBe(false);
    r.listeners.get("unmute")?.();
    expect(r.ticking).toBe(true);
    expect(r.opened).toBe(2);
  });

  it("stop() lets everything go and removes its listeners", async () => {
    const r = rig(true);
    await r.step(bright(1));
    r.watch.stop();
    expect(r.ticking).toBe(false);
    expect(r.listeners.size).toBe(0);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  captureConstraintsFor,
  enforceCaptureFrameRate,
  startShareGuard,
  type ShareGuardTimers,
  type ShareGuardTransport,
} from "./share-guard-runtime";
import { buildShareGuardLadder } from "./share-high-motion-guard";

/** A capture track that remembers what it was asked for and reports it back. */
function fakeTrack(initial: {
  frameRate?: number;
  height?: number;
  constraints?: MediaTrackConstraints;
}) {
  const settings = { frameRate: initial.frameRate, height: initial.height, width: 1920 };
  let constraints: MediaTrackConstraints = initial.constraints ?? {
    frameRate: { ideal: 60, max: 60 },
    width: { max: 1920 },
    height: { max: 1080 },
  };
  const applied: MediaTrackConstraints[] = [];
  const track = {
    readyState: "live" as MediaStreamTrackState,
    getSettings: () => ({ ...settings }),
    getConstraints: () => constraints,
    applyConstraints: vi.fn(async (next: MediaTrackConstraints) => {
      applied.push(next);
      constraints = next;
      const fps = next.frameRate;
      if (fps && typeof fps === "object" && typeof fps.max === "number") {
        settings.frameRate = fps.max;
      }
      const h = next.height;
      if (h && typeof h === "object" && typeof h.max === "number") {
        settings.height = h.max;
      }
    }),
  };
  return { track: track as unknown as MediaStreamTrack, applied, settings, raw: track };
}

/** One outbound-rtp report the way a browser shapes it. */
function report(over: Record<string, unknown>) {
  return new Map<string, unknown>([
    [
      "out",
      {
        id: "out",
        type: "outbound-rtp",
        kind: "video",
        frameWidth: 1920,
        frameHeight: 1080,
        framesPerSecond: 60,
        framesEncoded: 0,
        totalEncodeTime: 0,
        bytesSent: 0,
        targetBitrate: 4_000_000,
        qualityLimitationReason: "none",
        ...over,
      },
    ],
  ]);
}

function harness(options: { blocked?: () => boolean; baseFps?: 30 | 60; height?: number } = {}) {
  const { track, applied, raw } = fakeTrack({ frameRate: options.baseFps ?? 60, height: options.height ?? 1080 });
  let clock = 0;
  let starved = false;
  let frames = 0;
  const ceilings: Array<unknown> = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  let timerCallback: (() => void) | null = null;
  const timers: ShareGuardTimers = {
    set: (run) => {
      timerCallback = run;
      return 1;
    },
    clear: () => {
      timerCallback = null;
    },
  };
  const transport: ShareGuardTransport = {
    async readReports() {
      frames += 120;
      return [
        report(
          starved
            ? { framesPerSecond: 30, framesEncoded: frames, totalEncodeTime: frames * 0.018 }
            : { framesEncoded: frames, totalEncodeTime: frames * 0.003 },
        ),
      ];
    },
    async applyCeiling(level) {
      ceilings.push(level ? { index: level.index, maxFps: level.maxFps, maxHeight: level.maxHeight } : null);
    },
    blocked: options.blocked,
  };
  const guard = startShareGuard({
    track,
    transport,
    baseFps: options.baseFps ?? 60,
    now: () => clock,
    timers,
    log: (message, detail) => logs.push([message, detail]),
  });
  return {
    guard,
    applied,
    raw,
    ceilings,
    logs,
    fire: () => timerCallback,
    async advance(seconds: number, isStarved: boolean) {
      starved = isStarved;
      const out = [];
      for (let spent = 0; spent < seconds; spent += 2) {
        clock += 2_000;
        out.push(await guard.tick());
      }
      return out;
    },
  };
}

describe("captureConstraintsFor", () => {
  it("lays a level over the capture's own constraints instead of replacing them", () => {
    const ladder = buildShareGuardLadder({ fps: 60, height: 1080 });
    const base = {
      frameRate: { ideal: 60, max: 60 },
      width: { max: 1920 },
      height: { max: 1080 },
    } as MediaTrackConstraints;
    expect(captureConstraintsFor(base, ladder[1]!)).toEqual({
      frameRate: { ideal: 60, max: 60 },
      width: { max: 1920 },
      height: { max: 720 },
    });
    expect(captureConstraintsFor(base, ladder[3]!)).toEqual({
      frameRate: { ideal: 30, max: 30 },
      width: { max: 1920 },
      height: { max: 540 },
    });
    // The top of the ladder is the request as it was, frame rate included.
    expect(captureConstraintsFor(base, ladder[0]!)).toEqual(base);
  });

  it("never raises a height ceiling the capture was opened under", () => {
    const ladder = buildShareGuardLadder({ fps: 60, height: 1080 });
    const base = { height: { max: 600 } } as MediaTrackConstraints;
    expect((captureConstraintsFor(base, ladder[1]!).height as { max: number }).max).toBe(600);
  });
});

describe("enforceCaptureFrameRate", () => {
  it("leaves a capture that already reports the asked rate alone", async () => {
    const { track, applied } = fakeTrack({ frameRate: 60 });
    expect(await enforceCaptureFrameRate(track, 60)).toMatchObject({
      enforced: false,
      reported: 60,
    });
    expect(applied).toHaveLength(0);
  });

  it("asks again, in place and keeping the rest of the constraints, when the capture reports more", async () => {
    const { track, applied } = fakeTrack({ frameRate: 144 });
    const result = await enforceCaptureFrameRate(track, 60);
    expect(result).toMatchObject({ enforced: true, reported: 144, after: 60 });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      frameRate: { ideal: 60, max: 60 },
      width: { max: 1920 },
      height: { max: 1080 },
    });
  });

  it("asks when the capture reports nothing at all, and survives a refusal", async () => {
    const { track, raw } = fakeTrack({});
    raw.applyConstraints.mockRejectedValueOnce(new Error("overconstrained"));
    const result = await enforceCaptureFrameRate(track, 30);
    expect(result).toMatchObject({ enforced: true, reported: null });
  });
});

describe("startShareGuard", () => {
  it("does nothing to a healthy share, tick after tick", async () => {
    const h = harness();
    await h.advance(300, false);
    expect(h.applied).toHaveLength(0);
    expect(h.ceilings).toHaveLength(0);
    expect(h.logs).toHaveLength(0);
    await h.guard.stop();
  });

  it("steps the capture and the senders down in place when the encoder is starved", async () => {
    const h = harness();
    await h.advance(10, true);
    // One step: 1080p60 to 720p60. The capture was re-constrained over its
    // own settings, and the senders were told the new ceiling.
    expect(h.guard.level()).toMatchObject({ index: 1, maxHeight: 720, maxFps: 60 });
    expect(h.applied.at(-1)).toMatchObject({
      frameRate: { ideal: 60, max: 60 },
      width: { max: 1920 },
      height: { max: 720 },
    });
    expect(h.ceilings.at(-1)).toEqual({ index: 1, maxFps: 60, maxHeight: 720 });
    expect(h.logs.map(([m]) => m)).toEqual(["[pqp] share guard: stepped down"]);
    await h.guard.stop();
  });

  it("goes back up slowly once the pipeline is healthy, and lifts the hold at the top", async () => {
    const h = harness();
    await h.advance(10, true);
    expect(h.guard.level().index).toBe(1);
    await h.advance(60, false);
    expect(h.guard.level().index).toBe(0);
    // The top of the ladder is the request again, and the senders are released.
    expect(h.ceilings.at(-1)).toBeNull();
    expect(h.applied.at(-1)).toMatchObject({ frameRate: { ideal: 60, max: 60 }, height: { max: 1080 } });
    await h.guard.stop();
  });

  it("keeps the share running when the browser refuses the new constraints", async () => {
    const h = harness();
    h.raw.applyConstraints.mockRejectedValue(new Error("OverconstrainedError"));
    await h.advance(10, true);
    // Still stepped: the senders got their ceiling even though the capture kept its size.
    expect(h.ceilings.at(-1)).toMatchObject({ index: 1 });
    expect(h.logs.some(([m]) => m === "[pqp] share guard: capture kept its settings")).toBe(true);
    await h.guard.stop();
  });

  it("gives the share back and stops for good when a watch party takes it over", async () => {
    let blocked = false;
    const h = harness({ blocked: () => blocked });
    await h.advance(10, true);
    expect(h.guard.level().index).toBe(1);
    blocked = true;
    await h.advance(2, true);
    // The hold came off the senders and the capture got its original settings.
    expect(h.ceilings.at(-1)).toBeNull();
    expect(h.raw.applyConstraints).toHaveBeenLastCalledWith({
      frameRate: { ideal: 60, max: 60 },
      width: { max: 1920 },
      height: { max: 1080 },
    });
    const before = h.ceilings.length;
    blocked = false;
    await h.advance(60, true);
    expect(h.ceilings).toHaveLength(before);
  });

  it("releases the senders on stop, and does not touch a capture that already ended", async () => {
    const h = harness();
    await h.advance(10, true);
    (h.raw as { readyState: string }).readyState = "ended";
    const calls = h.raw.applyConstraints.mock.calls.length;
    await h.guard.stop();
    expect(h.ceilings.at(-1)).toBeNull();
    expect(h.raw.applyConstraints.mock.calls.length).toBe(calls);
    // Stopped is stopped: a late tick does nothing.
    expect(await h.guard.tick()).toBeNull();
  });

  it("lets a person put it on a step by hand, and rebases onto a new capture rate", async () => {
    const h = harness();
    await h.guard.force(3);
    expect(h.guard.level()).toMatchObject({ index: 3, maxFps: 30 });
    expect(h.applied.at(-1)).toMatchObject({ frameRate: { ideal: 30, max: 30 } });
    await h.guard.rebase(30);
    expect(h.guard.level()).toMatchObject({ index: 0, maxFps: 30 });
    expect(h.applied.at(-1)).toMatchObject({ frameRate: { ideal: 30, max: 30 } });
    expect(h.ceilings.at(-1)).toBeNull();
    await h.guard.stop();
  });

  it("holds a level chosen by hand until it is released, however starved the share is", async () => {
    const h = harness();
    const forced = await h.guard.force(1);
    expect(forced).toMatchObject({ applied: true, level: { index: 1 } });
    expect(h.guard.manual()).toBe(true);
    // Starved for a minute: the machine would have walked down the ladder.
    await h.advance(60, true);
    expect(h.guard.level().index).toBe(1);
    // Healthy for two minutes: it would have walked back up.
    await h.advance(120, false);
    expect(h.guard.level().index).toBe(1);
    // Released: the machine decides again.
    await h.guard.force(null);
    expect(h.guard.manual()).toBe(false);
    expect(h.guard.level().index).toBe(0);
    await h.advance(20, true);
    expect(h.guard.level().index).toBeGreaterThan(0);
    await h.guard.stop();
  });

  it("says so when the browser refused part of a forced level", async () => {
    const h = harness();
    h.raw.applyConstraints.mockRejectedValue(new Error("OverconstrainedError"));
    const forced = await h.guard.force(2);
    expect(forced.applied).toBe(false);
    expect(forced.level.index).toBe(2);
    await h.guard.stop();
  });

  it("does not let a step that is still being applied land after the stop", async () => {
    const h = harness();
    // Starve until a step is decided, with the capture write held open.
    let release: () => void = () => {};
    h.raw.applyConstraints.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await h.advance(6, true);
    const stepping = h.advance(2, true);
    await Promise.resolve();
    // The share ends (or a watch party takes it) while the write is in flight.
    const stopped = h.guard.stop();
    release();
    await stepping;
    release();
    await stopped;
    // The last thing written to the senders is the release, never a step.
    expect(h.ceilings.at(-1)).toBeNull();
    // And nothing is applied after the stop.
    const writes = h.ceilings.length;
    await h.advance(30, true);
    expect(h.ceilings).toHaveLength(writes);
  });

  it("asks the timer, not a tight loop: one sampling pass per tick", async () => {
    const h = harness();
    expect(typeof h.fire()).toBe("function");
    await h.guard.stop();
    expect(h.fire()).toBeNull();
  });
});

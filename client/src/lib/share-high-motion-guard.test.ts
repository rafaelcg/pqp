import { describe, expect, it } from "vitest";
import {
  buildShareGuardLadder,
  createShareGuard,
  DEFAULT_SHARE_GUARD_CONFIG,
  deriveShareSample,
  judgeShareSample,
  readShareEncodeStats,
  type ShareGuardSample,
} from "./share-high-motion-guard";

const STEP_MS = 2_000;

function sample(at: number, over: Partial<ShareGuardSample> = {}): ShareGuardSample {
  return {
    at,
    fps: 60,
    sourceFps: 60,
    encodeMs: 3,
    kbps: 3_000,
    targetKbps: 4_000,
    limitedBy: "none",
    height: 1080,
    ...over,
  };
}

const starvedEncoder = (at: number) =>
  sample(at, { limitedBy: "cpu", fps: 22, encodeMs: 14 });
const healthy = (at: number, over: Partial<ShareGuardSample> = {}) => sample(at, over);

/** Feed one sample per 2 s from `from`, return the last decision. */
function run(
  guard: ReturnType<typeof createShareGuard>,
  from: number,
  seconds: number,
  make: (at: number) => ShareGuardSample,
) {
  let at = from;
  const decisions = [];
  for (let spent = 0; spent <= seconds * 1000; spent += STEP_MS) {
    decisions.push(guard.observe([make(at)]));
    at += STEP_MS;
  }
  return { decisions, end: at };
}

describe("buildShareGuardLadder", () => {
  it("spends resolution before frame rate, and frame rate last", () => {
    const ladder = buildShareGuardLadder({ fps: 60, height: 1080 });
    expect(ladder.map((l) => [l.maxFps, l.maxHeight, l.step])).toEqual([
      [60, null, "base"],
      [60, 720, "resolution"],
      [60, 540, "resolution"],
      [30, 540, "frame-rate"],
    ]);
    expect(ladder[0]!.bitrateScale).toBe(1);
    expect(ladder[1]!.bitrateScale).toBeLessThan(1);
    expect(ladder[2]!.bitrateScale).toBeLessThan(ladder[1]!.bitrateScale);
  });

  it("has no frame-rate step for a 30 fps capture", () => {
    const ladder = buildShareGuardLadder({ fps: 30, height: 1080 });
    expect(ladder.every((l) => l.maxFps === 30)).toBe(true);
    expect(ladder).toHaveLength(3);
  });

  it("only offers rungs that are a real step under the capture", () => {
    expect(buildShareGuardLadder({ fps: 60, height: 720 }).map((l) => l.maxHeight)).toEqual([
      null,
      540,
      540,
    ]);
    // 648 lines: 540 is a step, 720 is not under it.
    expect(buildShareGuardLadder({ fps: 30, height: 648 }).map((l) => l.maxHeight)).toEqual([
      null,
      540,
    ]);
    // Already at the floor: only the frame rate is left.
    expect(buildShareGuardLadder({ fps: 60, height: 480 }).map((l) => [l.maxFps, l.maxHeight])).toEqual([
      [60, null],
      [30, null],
    ]);
  });

  it("assumes the request's own ceiling when the capture height is unknown", () => {
    expect(buildShareGuardLadder({ fps: 30, height: null })[0]!.height).toBe(1080);
  });
});

describe("judgeShareSample", () => {
  it("calls a cpu limitation an encoder that is behind", () => {
    expect(judgeShareSample(sample(0, { limitedBy: "cpu" }), 60)).toEqual({
      verdict: "starved-encoder",
      reason: "cpu-limited",
    });
  });

  it("calls a slow encode with frames missing an encoder that is behind", () => {
    // 60 fps is a 16.7 ms slot; 16 ms is over 90 % of it, and 40 of 60 frames
    // are leaving.
    expect(judgeShareSample(sample(0, { encodeMs: 16, fps: 40 }), 60).reason).toBe(
      "encode-time",
    );
    expect(judgeShareSample(sample(0, { encodeMs: 9, fps: 40, sourceFps: 40, kbps: 100 }), 60).verdict).toBe(
      "healthy",
    );
    // The same encode is fine at 30 fps, where the slot is twice as long.
    expect(judgeShareSample(sample(0, { encodeMs: 16, fps: 25 }), 30).verdict).toBe("healthy");
  });

  it("does not call an asynchronous hardware encoder slow for taking a long time per frame", () => {
    // Media Foundation keeps several frames in flight: 25 ms from call to
    // completion at 60 fps, and every frame still leaves on time.
    expect(judgeShareSample(sample(0, { encodeMs: 25, fps: 59 }), 60).verdict).toBe("healthy");
    const guard = createShareGuard(buildShareGuardLadder({ fps: 60, height: 1080 }));
    const { decisions } = run(guard, 0, 600, (at) => sample(at, { encodeMs: 25, fps: 59 }));
    expect(decisions.every((d) => d.action === "hold")).toBe(true);
  });

  it("separates a capture that is behind from an encoder that is", () => {
    // The capture delivers 55 and 12 leave: the encoder dropped them.
    expect(
      judgeShareSample(sample(0, { fps: 12, sourceFps: 55, kbps: 500 }), 60),
    ).toEqual({ verdict: "starved-encoder", reason: "low-fps" });
    // The capture itself hands over 12 and each one is large: the capture.
    expect(
      judgeShareSample(sample(0, { fps: 12, sourceFps: 12, kbps: 3_000 }), 60),
    ).toEqual({ verdict: "starved-capture", reason: "low-fps" });
  });

  it("does not call a still picture starved", () => {
    // 2 fps, tiny frames, tiny bitrate: a desktop nobody is moving.
    expect(
      judgeShareSample(sample(0, { fps: 2, sourceFps: 2, kbps: 40 }), 60).verdict,
    ).toBe("healthy");
  });

  it("leaves a bandwidth limitation to the link, and waits without readings", () => {
    expect(judgeShareSample(sample(0, { limitedBy: "bandwidth", fps: 5 }), 60).verdict).toBe(
      "network",
    );
    expect(judgeShareSample(sample(0, { fps: null, encodeMs: null }), 60).verdict).toBe(
      "unknown",
    );
  });
});

describe("the guard's state machine", () => {
  const ladder = buildShareGuardLadder({ fps: 60, height: 1080 });

  it("does nothing while the share is healthy, however long", () => {
    const guard = createShareGuard(ladder);
    const { decisions } = run(guard, 0, 600, healthy);
    expect(decisions.every((d) => d.action === "hold")).toBe(true);
    expect(guard.level().index).toBe(0);
  });

  it("steps down only after about five seconds of sustained starvation", () => {
    const guard = createShareGuard(ladder);
    const first = guard.observe([starvedEncoder(0)]);
    const second = guard.observe([starvedEncoder(2_000)]);
    const third = guard.observe([starvedEncoder(4_000)]);
    // 4 s in, three readings: not yet five seconds.
    expect([first.action, second.action, third.action]).toEqual(["hold", "hold", "hold"]);
    const fourth = guard.observe([starvedEncoder(6_000)]);
    expect(fourth.action).toBe("down");
    expect(fourth.level.index).toBe(1);
    expect(fourth.level.maxHeight).toBe(720);
    // Frame rate was not touched: it is the last thing to go.
    expect(fourth.level.maxFps).toBe(60);
  });

  it("ignores a single bad reading", () => {
    const guard = createShareGuard(ladder);
    guard.observe([starvedEncoder(0)]);
    guard.observe([healthy(2_000)]);
    guard.observe([healthy(4_000)]);
    const { decisions } = run(guard, 6_000, 60, healthy);
    expect(decisions.some((d) => d.action === "down")).toBe(false);
  });

  it("survives one good reading in the middle of a starved run", () => {
    const guard = createShareGuard(ladder);
    guard.observe([starvedEncoder(0)]);
    guard.observe([starvedEncoder(2_000)]);
    guard.observe([healthy(4_000)]);
    const d = guard.observe([starvedEncoder(6_000)]);
    expect(d.action).toBe("down");
  });

  it("does not trust readings while the encoder reconfigures after a step", () => {
    const guard = createShareGuard(ladder);
    run(guard, 0, 6, starvedEncoder);
    expect(guard.level().index).toBe(1);
    // Still starved right after the step: settle window, no second step.
    const inSettle = guard.observe([starvedEncoder(8_000)]);
    expect(inSettle.action).toBe("hold");
    expect(guard.snapshot().settling).toBe(true);
  });

  it("walks the whole ladder under continued starvation and stops at the bottom", () => {
    const guard = createShareGuard(ladder);
    const { decisions } = run(guard, 0, 120, starvedEncoder);
    const downs = decisions.filter((d) => d.action === "down");
    expect(downs.map((d) => d.level.index)).toEqual([1, 2, 3]);
    expect(downs.at(-1)!.level).toMatchObject({ maxFps: 30, step: "frame-rate" });
    expect(guard.level().index).toBe(3);
  });

  it("recovers slowly, one step at a time, frame rate first", () => {
    const guard = createShareGuard(ladder);
    const down = run(guard, 0, 120, starvedEncoder);
    expect(guard.level().index).toBe(3);
    // Healthy from here. Less than the wait: nothing moves.
    const early = run(guard, down.end, 40, (at) => healthy(at, { fps: 30, encodeMs: 3 }));
    expect(early.decisions.every((d) => d.action === "hold")).toBe(true);
    // Past 45 s of health: one step up, and it is the frame rate coming back.
    const later = run(guard, early.end, 10, (at) => healthy(at, { fps: 30, encodeMs: 3 }));
    const up = later.decisions.find((d) => d.action === "up");
    expect(up?.level).toMatchObject({ index: 2, maxFps: 60, step: "resolution" });
  });

  it("will not step up into a level the measured encode time says it cannot carry", () => {
    const guard = createShareGuard(ladder);
    run(guard, 0, 6, starvedEncoder);
    expect(guard.level().index).toBe(1);
    // Healthy and delivering, but the encode is 11 ms at 720p: at 1080p that
    // projects to about 25 ms, against the 14 ms it was failing at.
    const { decisions } = run(guard, 20_000, 300, (at) => healthy(at, { encodeMs: 11 }));
    expect(decisions.some((d) => d.action === "up")).toBe(false);
    expect(guard.level().index).toBe(1);
  });

  it("keeps a starved streak alive through readings the link explains", () => {
    // A starved machine flips between "bandwidth" and "none" reading to reading.
    const guard = createShareGuard(ladder);
    const decisions = [];
    for (let i = 0; i < 6; i += 1) {
      const at = i * STEP_MS;
      decisions.push(
        guard.observe([
          i % 2 === 1 ? sample(at, { limitedBy: "bandwidth", fps: 20 }) : starvedEncoder(at),
        ]),
      );
    }
    expect(decisions.some((d) => d.action === "down")).toBe(true);
  });

  it("does not step up on a network limitation or without delivering", () => {
    const guard = createShareGuard(ladder);
    run(guard, 0, 6, starvedEncoder);
    const net = run(guard, 20_000, 200, (at) => sample(at, { limitedBy: "bandwidth", fps: 30 }));
    expect(net.decisions.some((d) => d.action === "up")).toBe(false);
    const slow = run(guard, net.end, 200, (at) => healthy(at, { fps: 20, sourceFps: 20, kbps: 100 }));
    expect(slow.decisions.some((d) => d.action === "up")).toBe(false);
  });

  it("backs off after a flap and stays down after three", () => {
    const guard = createShareGuard(ladder);
    let at = 0;
    const cycle = () => {
      // Starve to a step down, then heal until it steps back up, then starve
      // again right away.
      // Starved until the step down lands (readings inside the settle window
      // after an up-step do not count, so this can take a while), then stop.
      let stepped = false;
      for (let i = 0; i < 50 && !stepped; i += 1) {
        stepped = guard.observe([starvedEncoder(at)]).action === "down";
        at += STEP_MS;
      }
      expect(stepped).toBe(true);
      const before = guard.level().index;
      let waited = 0;
      let climbed = false;
      while (waited < 1_500_000 && !climbed) {
        const d = guard.observe([healthy(at)]);
        at += STEP_MS;
        waited += STEP_MS;
        climbed = d.action === "up";
      }
      return { before, climbed, waited };
    };
    const first = cycle();
    expect(first.climbed).toBe(true);
    // The wait to climb after one flap is longer than the first one was.
    const second = cycle();
    expect(second.climbed).toBe(true);
    expect(second.waited).toBeGreaterThan(first.waited);
    const third = cycle();
    expect(third.climbed).toBe(true);
    // After a third step down inside the flap window it stays put for good.
    let stepped = false;
    for (let i = 0; i < 50 && !stepped; i += 1) {
      stepped = guard.observe([starvedEncoder(at)]).action === "down";
      at += STEP_MS;
    }
    expect(stepped).toBe(true);
    expect(guard.snapshot().sticky).toBe(true);
    const settled = guard.level().index;
    const after = run(guard, at + 20_000, 1_200, healthy);
    expect(after.decisions.some((d) => d.action === "up")).toBe(false);
    expect(guard.level().index).toBe(settled);
  });

  it("sends a starved capture straight to the frame rate, because pixels do not help it", () => {
    const guard = createShareGuard(ladder);
    const capture = (at: number) =>
      sample(at, { fps: 12, sourceFps: 12, kbps: 3_000, encodeMs: 3 });
    const { decisions } = run(guard, 0, 8, capture);
    const down = decisions.find((d) => d.action === "down");
    expect(down?.verdict).toBe("starved-capture");
    expect(down?.level).toMatchObject({ maxFps: 30, step: "frame-rate" });
    expect(down?.level.index).toBe(3);
  });

  it("has nothing to do for a starved capture that is already at 30 fps", () => {
    const guard = createShareGuard(buildShareGuardLadder({ fps: 30, height: 1080 }));
    const { decisions } = run(guard, 0, 120, (at) =>
      sample(at, { fps: 6, sourceFps: 6, kbps: 3_000, encodeMs: 3 }),
    );
    expect(decisions.every((d) => d.action === "hold")).toBe(true);
  });

  it("takes the worst of several senders (a mesh call encodes once per peer)", () => {
    const guard = createShareGuard(ladder);
    let last;
    for (let at = 0; at <= 6_000; at += STEP_MS) {
      last = guard.observe([healthy(at), starvedEncoder(at), healthy(at)]);
    }
    expect(last?.action).toBe("down");
  });

  it("can be put on a level by hand and rebased onto a new ladder", () => {
    const guard = createShareGuard(ladder);
    expect(guard.force(2, 0).index).toBe(2);
    expect(guard.force(99, 1).index).toBe(ladder.length - 1);
    expect(guard.force(null, 2).index).toBe(0);
    guard.force(2, 3);
    const top = guard.rebase(buildShareGuardLadder({ fps: 30, height: 1080 }));
    expect(top).toMatchObject({ index: 0, maxFps: 30 });
    expect(guard.level().index).toBe(0);
  });

  it("uses documented defaults", () => {
    expect(DEFAULT_SHARE_GUARD_CONFIG).toMatchObject({
      downAfterMs: 5_000,
      upAfterMs: 45_000,
      maxFlaps: 3,
    });
  });
});

describe("reading stats", () => {
  const report = new Map<string, unknown>([
    [
      "out-low",
      {
        id: "out-low",
        type: "outbound-rtp",
        kind: "video",
        rid: "q",
        frameWidth: 640,
        frameHeight: 360,
        bytesSent: 10,
      },
    ],
    [
      "out-top",
      {
        id: "out-top",
        type: "outbound-rtp",
        kind: "video",
        rid: "f",
        frameWidth: 1920,
        frameHeight: 1080,
        framesPerSecond: 58,
        framesEncoded: 600,
        totalEncodeTime: 3,
        bytesSent: 1_000_000,
        targetBitrate: 4_000_000,
        qualityLimitationReason: "none",
        encoderImplementation: "MediaFoundationVideoEncodeAccelerator",
        powerEfficientEncoder: true,
        mediaSourceId: "src",
        codecId: "cdc",
      },
    ],
    ["src", { id: "src", type: "media-source", kind: "video", framesPerSecond: 61, width: 1920, height: 1080 }],
    ["cdc", { id: "cdc", type: "codec", mimeType: "video/H264" }],
    ["audio", { id: "audio", type: "outbound-rtp", kind: "audio", frameWidth: 99999 }],
  ]);

  it("picks the tallest video layer and follows its codec and source", () => {
    const stats = readShareEncodeStats(report, 1_000);
    expect(stats).toMatchObject({
      frameHeight: 1080,
      framesPerSecond: 58,
      encoderImplementation: "MediaFoundationVideoEncodeAccelerator",
      powerEfficientEncoder: true,
      codec: "video/H264",
      sourceFps: 61,
      qualityLimitationReason: "none",
    });
  });

  it("answers null when there is no outbound video", () => {
    expect(readShareEncodeStats(new Map(), 0)).toBeNull();
  });

  it("derives encode time, send rate and bitrate between two readings", () => {
    const a = readShareEncodeStats(report, 1_000)!;
    const b = {
      ...a,
      at: 3_000,
      framesEncoded: 720,
      totalEncodeTime: 3.6,
      bytesSent: 1_000_000 + 1_000_000,
    };
    const derived = deriveShareSample(a, b);
    // 120 frames, 0.6 s of encoding: 5 ms a frame.
    expect(derived.encodeMs).toBeCloseTo(5, 5);
    // 1 MB over 2 s.
    expect(derived.kbps).toBeCloseTo(4_000, 5);
    expect(derived.targetKbps).toBe(4_000);
  });

  it("says nothing about encode cost from a handful of frames", () => {
    const a = readShareEncodeStats(report, 1_000)!;
    const b = { ...a, at: 3_000, framesEncoded: 603, totalEncodeTime: 3.5 };
    expect(deriveShareSample(a, b).encodeMs).toBeNull();
  });
});

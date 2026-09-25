import { describe, expect, it } from "vitest";
import {
  decideScreenResolutionRecovery,
  initialScreenResolutionRecovery,
  nextKickDelayMs,
  readScreenEncodeSample,
  refundScreenResolutionKick,
  SCREEN_RESOLUTION_HEALTHY_MS,
  SCREEN_RESOLUTION_REFUND_LIMIT,
  SCREEN_RESOLUTION_STUCK_MS,
  type ScreenEncodeSample,
  type ScreenResolutionRecoveryState,
} from "./screen-resolution-recovery";

/**
 * The numbers are production rehearsal F's, 2026-09-25, after the presenter's
 * first reload: 280x180 under a 720-line plan, `qualityLimitationReason:
 * "bandwidth"`, a target of ~891 kbit/s and ~390 kbit/s actually sent, for
 * eight minutes.
 */
const INTENDED = 720;
const TARGET = 891_000;

function wedged(at: number, bytesSent: number): ScreenEncodeSample {
  return {
    at,
    frameHeight: 180,
    targetBitrate: TARGET,
    bytesSent,
    qualityLimitationReason: "bandwidth",
  };
}

/** `seconds` of 2 s samples at `bps`, starting from `state`. */
function run(
  state: ScreenResolutionRecoveryState,
  fromMs: number,
  seconds: number,
  sample: (at: number, bytes: number) => ScreenEncodeSample,
  bps = 390_000,
  startBytes = 0,
) {
  let current = state;
  let bytes = startBytes;
  const kicks: number[] = [];
  for (let t = 0; t <= seconds * 1000; t += 2000) {
    const at = fromMs + t;
    const decision = decideScreenResolutionRecovery(
      current,
      sample(at, bytes),
      INTENDED,
    );
    current = decision.state;
    if (decision.kick) {
      kicks.push(at);
    }
    bytes += (bps / 8) * 2;
  }
  return { state: current, kicks, bytes };
}

describe("decideScreenResolutionRecovery", () => {
  it("kicks a share wedged at the floor with budget to spare, once it has held", () => {
    const { kicks } = run(initialScreenResolutionRecovery(), 0, 12, wedged);
    // Not on the first sighting: it has to hold for the whole window first.
    expect(kicks.length).toBeGreaterThanOrEqual(1);
    expect(kicks[0]).toBeGreaterThanOrEqual(SCREEN_RESOLUTION_STUCK_MS);
    expect(kicks[0]).toBeLessThanOrEqual(SCREEN_RESOLUTION_STUCK_MS + 4000);
  });

  it("never kicks a share that is spending its budget: that is a real squeeze", () => {
    const { kicks } = run(
      initialScreenResolutionRecovery(),
      0,
      120,
      wedged,
      TARGET, // sending everything it was granted
    );
    expect(kicks).toEqual([]);
  });

  it("never kicks when the CPU is what holds it down", () => {
    const { kicks } = run(initialScreenResolutionRecovery(), 0, 120, (at, bytes) => ({
      ...wedged(at, bytes),
      qualityLimitationReason: "cpu",
    }));
    expect(kicks).toEqual([]);
  });

  it("never kicks a share at its intended size", () => {
    const { kicks } = run(initialScreenResolutionRecovery(), 0, 120, (at, bytes) => ({
      ...wedged(at, bytes),
      frameHeight: 720,
      qualityLimitationReason: "none",
    }));
    expect(kicks).toEqual([]);
  });

  it("leaves a share alone while it is climbing back by itself", () => {
    let state = initialScreenResolutionRecovery();
    const heights = [180, 270, 270, 360, 360, 450, 450, 540];
    let bytes = 0;
    const kicks: number[] = [];
    heights.forEach((frameHeight, index) => {
      const decision = decideScreenResolutionRecovery(
        state,
        { ...wedged(index * 2000, bytes), frameHeight },
        INTENDED,
      );
      state = decision.state;
      if (decision.kick) {
        kicks.push(index);
      }
      bytes += (390_000 / 8) * 2;
    });
    expect(kicks).toEqual([]);
  });

  it("backs off between kicks, so a link that cannot carry it costs one try a minute", () => {
    const { kicks } = run(initialScreenResolutionRecovery(), 0, 240, wedged);
    expect(kicks.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < kicks.length; i += 1) {
      expect(kicks[i]! - kicks[i - 1]!).toBeGreaterThanOrEqual(
        nextKickDelayMs(i),
      );
    }
    const lastGap = kicks[kicks.length - 1]! - kicks[kicks.length - 2]!;
    expect(lastGap).toBeGreaterThanOrEqual(60_000);
  });

  it("starts the backoff over after a minute at full size", () => {
    const first = run(initialScreenResolutionRecovery(), 0, 10, wedged);
    expect(first.kicks).toHaveLength(1);
    const healthy = run(
      first.state,
      12_000,
      SCREEN_RESOLUTION_HEALTHY_MS / 1000 + 2,
      (at, bytes) => ({ ...wedged(at, bytes), frameHeight: 720 }),
      390_000,
      first.bytes,
    );
    expect(healthy.state.kicks).toBe(0);
    const again = run(
      healthy.state,
      12_000 + SCREEN_RESOLUTION_HEALTHY_MS + 4000,
      10,
      wedged,
      390_000,
      healthy.bytes,
    );
    // No long backoff: the second wedge is treated like the first.
    expect(again.kicks).toHaveLength(1);
  });

  it("catches a share wedged a single notch down", () => {
    const { kicks } = run(initialScreenResolutionRecovery(), 0, 12, (at, bytes) => ({
      ...wedged(at, bytes),
      frameHeight: 540,
    }));
    expect(kicks.length).toBeGreaterThanOrEqual(1);
  });

  it("never kicks without a target to measure against", () => {
    let state = initialScreenResolutionRecovery();
    for (let t = 0; t < 60_000; t += 2000) {
      const decision = decideScreenResolutionRecovery(state, wedged(t, t * 50), null);
      state = decision.state;
      expect(decision.kick).toBe(false);
    }
  });
});

describe("refundScreenResolutionKick", () => {
  it("gives a refused kick back, so the next tick may try again at once", () => {
    let state = initialScreenResolutionRecovery();
    let before = state;
    let kickedAt = -1;
    for (let t = 0; kickedAt < 0; t += 2000) {
      before = state;
      const decision = decideScreenResolutionRecovery(state, wedged(t, t * 48.75), INTENDED);
      state = decision.state;
      if (decision.kick) {
        kickedAt = t;
      }
    }
    const refunded = refundScreenResolutionKick(before, state, 1);
    expect(refunded.kicks).toBe(0);
    expect(refunded.lastKickAt).toBeNull();
    const next = decideScreenResolutionRecovery(
      refunded,
      wedged(kickedAt + 2000, (kickedAt + 2000) * 48.75),
      INTENDED,
    );
    expect(next.kick).toBe(true);
  });

  it("stops refunding a browser that refuses every time", () => {
    const before = initialScreenResolutionRecovery();
    const attempted = { ...before, kicks: 1, lastKickAt: 10_000 };
    expect(
      refundScreenResolutionKick(before, attempted, SCREEN_RESOLUTION_REFUND_LIMIT + 1),
    ).toBe(attempted);
  });
});

describe("readScreenEncodeSample", () => {
  const report = new Map<string, unknown>([
    ["a", { type: "outbound-rtp", kind: "audio", bytesSent: 1 }],
    [
      "q",
      { type: "outbound-rtp", kind: "video", rid: "q", frameHeight: 90, bytesSent: 5 },
    ],
    [
      "f",
      {
        type: "outbound-rtp",
        kind: "video",
        rid: "f",
        frameHeight: 270,
        targetBitrate: 828_000,
        bytesSent: 900,
        qualityLimitationReason: "bandwidth",
      },
    ],
  ]);

  it("reads the top layer by its rid", () => {
    expect(readScreenEncodeSample(report.values(), "f", 7)).toEqual({
      at: 7,
      frameHeight: 270,
      targetBitrate: 828_000,
      bytesSent: 900,
      qualityLimitationReason: "bandwidth",
    });
  });

  it("reads a single-encoding share, which has no rid", () => {
    const single = new Map<string, unknown>([
      ["v", { type: "outbound-rtp", kind: "video", frameHeight: 180, bytesSent: 3 }],
    ]);
    expect(readScreenEncodeSample(single.values(), undefined, 1)?.frameHeight).toBe(180);
  });

  it("answers null when the top layer is not in the report", () => {
    expect(readScreenEncodeSample(report.values(), "h", 1)).toBeNull();
  });
});

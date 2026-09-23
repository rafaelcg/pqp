import { describe, expect, it } from "vitest";
import {
  LL_CEILING_HEADROOM_SECONDS,
  LL_PARTS_MIN_TARGET_SECONDS,
  LL_PARTS_OPT_IN_KEY,
  LL_SEGMENTS_CATCH_UP_RATE,
  LL_SEGMENTS_SLOW_DOWN_RATE,
  LL_SEGMENTS_TARGET_SECONDS,
  LL_TARGET_DECAY_AFTER_MS,
  LL_TARGET_DECAY_SECONDS,
  LL_TARGET_MAX_SECONDS,
  LL_TARGET_STEP_SECONDS,
  LlLatencyGovernor,
  llPartsOptedIn,
  llSegmentsCatchUpRate,
} from "./hls-ll-latency";

const T0 = 1_000_000;

describe("LlLatencyGovernor", () => {
  it("starts LL-lite on whole segments ~8 s behind, with the ceiling well clear", () => {
    const g = new LlLatencyGovernor({ delivery: "segments", now: T0 });
    expect(g.state()).toEqual({
      delivery: "segments",
      targetSeconds: LL_SEGMENTS_TARGET_SECONDS,
      ceilingSeconds: LL_SEGMENTS_TARGET_SECONDS + LL_CEILING_HEADROOM_SECONDS,
    });
    // Under the 10 s latency bar the investigation set for merging.
    expect(LL_SEGMENTS_TARGET_SECONDS).toBeLessThan(10);
  });

  it("never lets a parts manifest pull the target under its floor, but obeys one asking for more", () => {
    const g = new LlLatencyGovernor({ delivery: "parts", now: T0 });
    g.onManifest({ partHoldBackSeconds: 3.072 });
    expect(g.state().targetSeconds).toBe(LL_PARTS_MIN_TARGET_SECONDS);
    g.onManifest({ partHoldBackSeconds: 7 });
    expect(g.state().targetSeconds).toBe(7);
  });

  it("buys room on every stall and caps it", () => {
    const g = new LlLatencyGovernor({ delivery: "segments", now: T0 });
    g.onStall(T0 + 1_000);
    expect(g.state().targetSeconds).toBe(
      LL_SEGMENTS_TARGET_SECONDS + LL_TARGET_STEP_SECONDS,
    );
    for (let i = 0; i < 20; i += 1) {
      g.onStall(T0 + 2_000 + i * 70_000);
    }
    expect(g.state().targetSeconds).toBe(LL_TARGET_MAX_SECONDS);
  });

  it("gives room back slowly while healthy, never under the floor", () => {
    const g = new LlLatencyGovernor({ delivery: "segments", now: T0 });
    g.onStall(T0);
    g.tick(T0 + LL_TARGET_DECAY_AFTER_MS - 1);
    expect(g.state().targetSeconds).toBe(
      LL_SEGMENTS_TARGET_SECONDS + LL_TARGET_STEP_SECONDS,
    );
    g.tick(T0 + LL_TARGET_DECAY_AFTER_MS);
    expect(g.state().targetSeconds).toBe(
      LL_SEGMENTS_TARGET_SECONDS + LL_TARGET_STEP_SECONDS - LL_TARGET_DECAY_SECONDS,
    );
    for (let i = 2; i < 20; i += 1) {
      g.tick(T0 + i * LL_TARGET_DECAY_AFTER_MS);
    }
    expect(g.state().targetSeconds).toBe(LL_SEGMENTS_TARGET_SECONDS);
  });

  it("moves parts to segments on the third stall inside a minute, not the second", () => {
    const g = new LlLatencyGovernor({ delivery: "parts", now: T0 });
    expect(g.onStall(T0 + 1_000)).toBe(false);
    expect(g.onStall(T0 + 20_000)).toBe(false);
    expect(g.onStall(T0 + 40_000)).toBe(true);
    expect(g.state().delivery).toBe("segments");
    expect(g.state().targetSeconds).toBeGreaterThanOrEqual(LL_SEGMENTS_TARGET_SECONDS);
  });

  it("does not count stalls a minute apart toward the switch", () => {
    const g = new LlLatencyGovernor({ delivery: "parts", now: T0 });
    g.onStall(T0);
    g.onStall(T0 + 61_000);
    g.onStall(T0 + 122_000);
    expect(g.state().delivery).toBe("parts");
  });

  it("moves parts to segments on two part-load errors inside 10 s (the old pin rule, in place)", () => {
    const g = new LlLatencyGovernor({ delivery: "parts", now: T0 });
    expect(g.onPartLoadError(T0)).toBe(false);
    expect(g.onPartLoadError(T0 + 10_001)).toBe(false);
    expect(g.onPartLoadError(T0 + 15_000)).toBe(true);
    expect(g.state().delivery).toBe("segments");
    // Already on segments: nothing further to switch.
    expect(g.onPartLoadError(T0 + 15_500)).toBe(false);
  });
});

describe("llPartsOptedIn", () => {
  it("is off unless the browser asked, and never throws", () => {
    expect(llPartsOptedIn(null)).toBe(false);
    expect(llPartsOptedIn({ getItem: () => null })).toBe(false);
    expect(
      llPartsOptedIn({ getItem: (k) => (k === LL_PARTS_OPT_IN_KEY ? "1" : null) }),
    ).toBe(true);
    expect(
      llPartsOptedIn({
        getItem: () => {
          throw new Error("SecurityError");
        },
      }),
    ).toBe(false);
  });
});

describe("llSegmentsCatchUpRate", () => {
  it("gives latency back at 1.05x only past a second behind and with buffer to spare", () => {
    expect(
      llSegmentsCatchUpRate({ latencySeconds: 10, targetSeconds: 8, bufferAheadSeconds: 5 }),
    ).toBe(LL_SEGMENTS_CATCH_UP_RATE);
    expect(
      llSegmentsCatchUpRate({ latencySeconds: 8.9, targetSeconds: 8, bufferAheadSeconds: 5 }),
    ).toBe(1);
    // Thin buffer: speeding up is how a late viewer becomes a waiting one.
    expect(
      llSegmentsCatchUpRate({ latencySeconds: 12, targetSeconds: 8, bufferAheadSeconds: 2 }),
    ).toBe(1);
    expect(
      llSegmentsCatchUpRate({ latencySeconds: null, targetSeconds: 8, bufferAheadSeconds: 9 }),
    ).toBe(1);
  });

  it("slows down to build the cushion a stall asked for", () => {
    expect(
      llSegmentsCatchUpRate({ latencySeconds: 8.3, targetSeconds: 9, bufferAheadSeconds: 1 }),
    ).toBe(LL_SEGMENTS_SLOW_DOWN_RATE);
    expect(
      llSegmentsCatchUpRate({ latencySeconds: 8.6, targetSeconds: 9, bufferAheadSeconds: 1 }),
    ).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import {
  HLS_SLOW_START_ESTIMATE_BPS,
  hlsStartPlan,
  isSlowConnection,
} from "./hls-slow-start";

const SEED = 1_800_000;

describe("isSlowConnection", () => {
  it("reads 3g and worse, and the data saver, as slow", () => {
    expect(isSlowConnection({ effectiveType: "3g" })).toBe(true);
    expect(isSlowConnection({ effectiveType: "2g" })).toBe(true);
    expect(isSlowConnection({ effectiveType: "slow-2g" })).toBe(true);
    expect(isSlowConnection({ effectiveType: "4g", saveData: true })).toBe(true);
  });

  it("is false on 4g, and where the browser says nothing", () => {
    expect(isSlowConnection({ effectiveType: "4g" })).toBe(false);
    expect(isSlowConnection(null)).toBe(false);
    expect(isSlowConnection({})).toBe(false);
  });
});

describe("hlsStartPlan", () => {
  it("starts on the lowest rung on a slow link, seeded under the second rung", () => {
    const plan = hlsStartPlan({
      connection: { effectiveType: "3g" },
      rememberedEstimateBps: SEED,
      measuredBefore: false,
    });
    expect(plan).toEqual({
      startLevel: 0,
      abrEwmaDefaultEstimate: HLS_SLOW_START_ESTIMATE_BPS,
      slowStart: true,
    });
    expect(HLS_SLOW_START_ESTIMATE_BPS).toBeLessThan(900_000);
  });

  it("lets ABR guess from the seed on a link that says nothing", () => {
    expect(
      hlsStartPlan({ connection: null, rememberedEstimateBps: SEED, measuredBefore: false }),
    ).toEqual({ startLevel: -1, abrEwmaDefaultEstimate: SEED, slowStart: false });
  });

  it("trusts a measurement over the signal", () => {
    // A previous stream in this tab measured 6 Mbit/s: the 3g label is a
    // guess and the number is a fact.
    expect(
      hlsStartPlan({
        connection: { effectiveType: "3g" },
        rememberedEstimateBps: 6_000_000,
        measuredBefore: true,
      }),
    ).toEqual({ startLevel: -1, abrEwmaDefaultEstimate: 6_000_000, slowStart: false });
  });
});

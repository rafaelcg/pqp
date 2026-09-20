import { describe, expect, it } from "vitest";
import {
  clampReleaseDelayMs,
  DEFAULT_RELEASE_DELAY_MS,
  MAX_RELEASE_DELAY_MS,
  MIN_RELEASE_DELAY_MS,
} from "./ptt-release-delay";

describe("clampReleaseDelayMs", () => {
  it("keeps an in-range value", () => {
    expect(clampReleaseDelayMs(250)).toBe(250);
  });

  it("clamps below the minimum and above the maximum", () => {
    expect(clampReleaseDelayMs(-100)).toBe(MIN_RELEASE_DELAY_MS);
    expect(clampReleaseDelayMs(10_000)).toBe(MAX_RELEASE_DELAY_MS);
  });

  it("rounds fractional input", () => {
    expect(clampReleaseDelayMs(19.6)).toBe(20);
  });

  it("falls back to the default for garbage", () => {
    for (const value of [NaN, Infinity, -Infinity, "20", null, undefined, {}]) {
      expect(clampReleaseDelayMs(value)).toBe(DEFAULT_RELEASE_DELAY_MS);
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAIN_JITTER_MAX_MS,
  DRAIN_JITTER_MIN_MS,
  drainJitterMs,
  isFreshEnough,
  uniformJitterMs,
} from "./reconnect-jitter";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("uniformJitterMs", () => {
  it("stays within [min, max] across many draws", () => {
    for (let i = 0; i < 500; i++) {
      const delay = uniformJitterMs(100, 300);
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThanOrEqual(300);
    }
  });

  it("hits the floor and ceiling at the extremes of Math.random", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(uniformJitterMs(100, 300)).toBe(100);
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(uniformJitterMs(100, 300)).toBe(300);
  });
});

describe("drainJitterMs", () => {
  it("stays within the documented drain window", () => {
    for (let i = 0; i < 500; i++) {
      const delay = drainJitterMs();
      expect(delay).toBeGreaterThanOrEqual(DRAIN_JITTER_MIN_MS);
      expect(delay).toBeLessThanOrEqual(DRAIN_JITTER_MAX_MS);
    }
  });
});

describe("isFreshEnough", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is false for never-fetched data", () => {
    expect(isFreshEnough(null, 5_000)).toBe(false);
    expect(isFreshEnough(undefined, 5_000)).toBe(false);
  });

  it("is true just under the age limit and false at or past it", () => {
    const now = Date.now();
    expect(isFreshEnough(now - 4_999, 5_000, now)).toBe(true);
    expect(isFreshEnough(now - 5_000, 5_000, now)).toBe(false);
    expect(isFreshEnough(now - 5_001, 5_000, now)).toBe(false);
  });

  it("defaults `now` to the current clock", () => {
    const fetchedAt = Date.now();
    vi.advanceTimersByTime(1_000);
    expect(isFreshEnough(fetchedAt, 5_000)).toBe(true);
    vi.advanceTimersByTime(4_000);
    expect(isFreshEnough(fetchedAt, 5_000)).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_JITTER_MAX_MS,
  BOOTSTRAP_RETRY_BASE_MS,
  BOOTSTRAP_RETRY_MAX_MS,
  DRAIN_JITTER_MAX_MS,
  DRAIN_JITTER_MIN_MS,
  bootstrapJitterMs,
  bootstrapRetryDelayMs,
  drainJitterMs,
  isFreshEnough,
  parseRetryAfterMs,
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

describe("bootstrapJitterMs", () => {
  it("stays within [0, BOOTSTRAP_JITTER_MAX_MS] across many draws", () => {
    for (let i = 0; i < 500; i++) {
      const delay = bootstrapJitterMs();
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(BOOTSTRAP_JITTER_MAX_MS);
    }
  });

  it("can resolve to zero (a lucky tab bootstraps immediately)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(bootstrapJitterMs()).toBe(0);
  });
});

describe("bootstrapRetryDelayMs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("without a Retry-After is full jitter in [0, cap]", () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const cap = Math.min(
        BOOTSTRAP_RETRY_MAX_MS,
        BOOTSTRAP_RETRY_BASE_MS * 2 ** attempt,
      );
      for (let i = 0; i < 50; i++) {
        const delay = bootstrapRetryDelayMs(attempt);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(cap);
      }
    }
  });

  it("grows the cap exponentially and stops at BOOTSTRAP_RETRY_MAX_MS", () => {
    vi.spyOn(Math, "random").mockReturnValue(1); // draw the ceiling
    expect(bootstrapRetryDelayMs(0)).toBe(1_000);
    expect(bootstrapRetryDelayMs(1)).toBe(2_000);
    expect(bootstrapRetryDelayMs(2)).toBe(4_000);
    expect(bootstrapRetryDelayMs(10)).toBe(BOOTSTRAP_RETRY_MAX_MS);
    expect(bootstrapRetryDelayMs(100)).toBe(BOOTSTRAP_RETRY_MAX_MS);
  });

  it("honors a Retry-After as a floor and spreads jitter above it", () => {
    // Floor 5s (our breaker's Retry-After: 5). Every draw is >= the floor, so
    // it always backs off harder than a bare network drop (which starts at 0).
    for (let i = 0; i < 200; i++) {
      const delay = bootstrapRetryDelayMs(0, 5_000);
      expect(delay).toBeGreaterThanOrEqual(5_000);
      expect(delay).toBeLessThanOrEqual(5_000 + BOOTSTRAP_RETRY_BASE_MS);
    }
  });

  it("caps an absurd Retry-After floor at BOOTSTRAP_RETRY_MAX_MS", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // no jitter on top
    expect(bootstrapRetryDelayMs(0, 999_999_999)).toBe(BOOTSTRAP_RETRY_MAX_MS);
  });

  it("ignores a non-positive Retry-After and falls back to plain jitter", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(bootstrapRetryDelayMs(0, 0)).toBe(1_000);
    expect(bootstrapRetryDelayMs(0, -5_000)).toBe(1_000);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses a bare integer number of seconds", () => {
    expect(parseRetryAfterMs("5")).toBe(5_000);
    expect(parseRetryAfterMs("0")).toBe(0);
    expect(parseRetryAfterMs("  12  ")).toBe(12_000);
  });

  it("returns null for absent, empty, or unparseable values", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs("   ")).toBeNull();
    expect(parseRetryAfterMs("soon")).toBeNull();
    // Not silently read as 5ms — a unit suffix is not a valid delta-seconds.
    expect(parseRetryAfterMs("5s")).toBeNull();
  });

  it("parses an HTTP-date into ms from now, clamping the past to 0", () => {
    const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(
      parseRetryAfterMs("Wed, 21 Oct 2026 07:28:30 GMT", now),
    ).toBe(30_000);
    expect(
      parseRetryAfterMs("Wed, 21 Oct 2026 07:27:00 GMT", now),
    ).toBe(0);
  });
});

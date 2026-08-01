import { beforeEach, describe, expect, it } from "vitest";
import {
  rateLimit,
  resetRateLimits,
  sweepRateLimits,
} from "../dist/lib/rate-limit.js";

describe("rateLimit", () => {
  beforeEach(() => resetRateLimits());

  it("allows up to the limit then blocks", () => {
    const now = 1000;
    for (let i = 0; i < 3; i++) {
      expect(rateLimit("k", 3, 1000, now).allowed).toBe(true);
    }
    const blocked = rateLimit("k", 3, 1000, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("resets after the window elapses", () => {
    rateLimit("k", 1, 1000, 0);
    expect(rateLimit("k", 1, 1000, 500).allowed).toBe(false);
    expect(rateLimit("k", 1, 1000, 1001).allowed).toBe(true);
  });

  it("keeps separate keys independent", () => {
    expect(rateLimit("a", 1, 1000, 0).allowed).toBe(true);
    expect(rateLimit("b", 1, 1000, 0).allowed).toBe(true);
    expect(rateLimit("a", 1, 1000, 0).allowed).toBe(false);
  });

  it("sweeps expired windows", () => {
    rateLimit("k", 1, 1000, 0);
    sweepRateLimits(2000);
    // After the sweep the window is gone, so a fresh call is allowed again.
    expect(rateLimit("k", 1, 1000, 2000).allowed).toBe(true);
  });
});

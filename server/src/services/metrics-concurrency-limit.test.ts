import { describe, expect, it } from "vitest";
import { runWithConcurrencyLimit } from "./metrics.js";

/**
 * `computeAdminMetrics` used to fan every query out through a bare
 * `Promise.all`, which could grab up to 17 of the 22 connections in
 * production's `PG_POOL_MAX` pool at once. `runWithConcurrencyLimit` is the
 * fix: it runs the same array of thunks with at most N in flight. These
 * tests pin the three things that matter for pool safety and correctness —
 * the in-flight cap is never exceeded, results come back in the thunks'
 * original order regardless of finish order, and a rejection propagates
 * like it would from `Promise.all`.
 */
describe("runWithConcurrencyLimit", () => {
  it("never runs more than the limit at once, and returns results in order", async () => {
    const limit = 4;
    let inFlight = 0;
    let maxInFlight = 0;

    const thunks = Array.from({ length: 10 }, (_, i) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Stagger completion so later thunks can finish before earlier ones,
      // which is what would scramble ordering if results were pushed in
      // completion order instead of assigned by index.
      await new Promise((resolve) => setTimeout(resolve, (10 - i) % 4));
      inFlight--;
      return i;
    });

    const results = await runWithConcurrencyLimit(thunks, limit);

    expect(maxInFlight).toBeLessThanOrEqual(limit);
    expect(maxInFlight).toBeGreaterThan(0);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("propagates a rejection like Promise.all", async () => {
    const thunks = [
      async () => 1,
      async () => {
        throw new Error("boom");
      },
      async () => 3,
    ];

    await expect(runWithConcurrencyLimit(thunks, 2)).rejects.toThrow("boom");
  });

  it("runs everything when the limit is at least as large as the work", async () => {
    const thunks = [async () => "a", async () => "b", async () => "c"];
    const results = await runWithConcurrencyLimit(thunks, 10);
    expect(results).toEqual(["a", "b", "c"]);
  });

  it("handles an empty array of thunks", async () => {
    const results = await runWithConcurrencyLimit([], 4);
    expect(results).toEqual([]);
  });
});

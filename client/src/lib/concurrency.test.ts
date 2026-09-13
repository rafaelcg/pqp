import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency";

/** Resolves after a macrotask, so a batch of these genuinely overlaps
 * instead of resolving synchronously in submission order. */
function tick<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 0));
}

describe("mapWithConcurrency", () => {
  it("returns results in the same order as the input, regardless of timing", async () => {
    const items = [30, 10, 20];
    const results = await mapWithConcurrency(items, 3, (ms) =>
      new Promise<number>((resolve) => setTimeout(() => resolve(ms), ms)),
    );
    expect(results).toEqual(items);
  });

  it("never runs more than `limit` callbacks at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 8 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const result = await tick(item);
      inFlight--;
      return result;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("still runs every item when the limit is larger than the list", async () => {
    const items = ["a", "b"];
    const results = await mapWithConcurrency(items, 10, (s) =>
      Promise.resolve(s.toUpperCase()),
    );
    expect(results).toEqual(["A", "B"]);
  });

  it("handles an empty list without a division-by-zero worker count", async () => {
    const results = await mapWithConcurrency<number, number>(
      [],
      3,
      (n) => Promise.resolve(n),
    );
    expect(results).toEqual([]);
  });

  it("propagates a rejection", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) {
          throw new Error("boom");
        }
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});

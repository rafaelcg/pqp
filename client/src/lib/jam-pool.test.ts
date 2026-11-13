import { describe, expect, it } from "vitest";
import { inPool } from "./jam-pool";

describe("loading in a pool", () => {
  it("never has more than the limit in flight, and does every item", async () => {
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await inPool([1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      done.push(item);
    });
    expect(peak).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("is fine with nothing to do and with fewer items than lanes", async () => {
    await inPool([], 4, async () => undefined);
    const seen: string[] = [];
    await inPool(["a", "b"], 4, async (item) => {
      seen.push(item);
    });
    expect(seen.sort()).toEqual(["a", "b"]);
  });
});

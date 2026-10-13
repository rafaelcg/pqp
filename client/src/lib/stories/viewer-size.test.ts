import { describe, expect, it } from "vitest";
import { storyCardSize } from "./viewer-size";

describe("storyCardSize", () => {
  it.each([
    [1280, 720],
    [1440, 900],
    [1920, 1080],
    [2560, 1440],
    [2000, 1600],
    [800, 1600],
    [700, 1400],
  ])("fits a %ix%i window with a 9:16 card", (w, h) => {
    const size = storyCardSize(w, h);
    expect(size.height).toBeLessThanOrEqual(h * 0.92 + 1);
    // The card is the canvas: nothing else is stacked under it.
    expect(size.height / size.width).toBeCloseTo(16 / 9, 1);
    expect(size.neighbourHeight / size.neighbourWidth).toBeCloseTo(16 / 9, 1);
    // Never wider than the room beside the arrows (and the neighbours at xl).
    const room = size.showNeighbours ? 2 * size.neighbourWidth + 152 : 144;
    expect(size.width).toBeLessThanOrEqual(w - room);
  });

  it("uses most of the height on a big window", () => {
    expect(storyCardSize(1920, 1080).height).toBeGreaterThan(1080 * 0.9);
    expect(storyCardSize(1440, 900).width).toBeGreaterThan(366);
  });

  it("shrinks to fit a very short window instead of overflowing it", () => {
    for (const h of [200, 400, 500, 560]) {
      const size = storyCardSize(1280, h);
      expect(size.height).toBeLessThanOrEqual(h);
      expect(size.width).toBeGreaterThan(0);
    }
  });

  it("is limited by width on a narrow, tall window", () => {
    const size = storyCardSize(700, 2000);
    expect(size.width).toBe(556);
    expect(size.showNeighbours).toBe(false);
  });

  it("keeps the neighbours shorter than the card, and only from xl", () => {
    for (const [w, h] of [
      [1280, 720],
      [1920, 1080],
      [2560, 1440],
    ] as const) {
      const size = storyCardSize(w, h);
      expect(size.showNeighbours).toBe(true);
      expect(size.neighbourHeight).toBeLessThan(size.height * 0.6);
      expect(size.neighbourWidth).toBeGreaterThanOrEqual(112);
      expect(size.neighbourWidth).toBeLessThanOrEqual(240);
    }
    expect(storyCardSize(1279, 900).showNeighbours).toBe(false);
  });
});

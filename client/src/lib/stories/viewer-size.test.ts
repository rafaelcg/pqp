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
  ])("fits a %ix%i window with a 9:16 canvas", (w, h) => {
    const size = storyCardSize(w, h);
    expect(size.height).toBeLessThanOrEqual(h * 0.92 + 1);
    // Canvas is the card minus a reply bar scaled by the same zoom.
    const canvas = size.height - 64 * size.zoom;
    expect(canvas / size.width).toBeCloseTo(16 / 9, 1);
    expect(size.zoom).toBeGreaterThanOrEqual(1);
    expect(size.zoom).toBeLessThanOrEqual(1.6);
    // Never wider than the room beside the arrows (and the neighbours at xl).
    expect(size.width).toBeLessThanOrEqual(w - (w >= 1280 ? 456 : 144));
  });

  it("uses most of the height on a big window", () => {
    expect(storyCardSize(1920, 1080).height).toBeGreaterThan(1080 * 0.88);
    expect(storyCardSize(1440, 900).width).toBeGreaterThan(366);
  });

  it("keeps the old type size on a short window", () => {
    expect(storyCardSize(1280, 720).zoom).toBe(1);
  });

  it("is limited by width on a narrow, tall window", () => {
    const size = storyCardSize(700, 2000);
    expect(size.width).toBe(556);
  });
});

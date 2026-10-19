import { describe, expect, it } from "vitest";
import { centerCropRectForAspect } from "./avatar";
import {
  MAX_CROP_ZOOM,
  MIN_CROP_ZOOM,
  clampView,
  cropRect,
  cropRegion,
  imageLayout,
  initialCropView,
  panView,
  regionToRect,
  visibleSize,
  wheelZoomFactor,
  zoomView,
} from "./image-crop";

/**
 * The crop step's arithmetic. Every case here is a way a crop goes wrong
 * without throwing: the frame sliding off the picture, a zoom that drifts, a
 * banner cut from the wrong axis, a rectangle that is a pixel past the edge
 * and makes `drawImage` paint a black line.
 */

describe("the starting view", () => {
  it("is the old automatic centre crop, for a landscape photo in a square", () => {
    const view = initialCropView(4000, 3000, 1);
    expect(cropRect(view)).toEqual({ x: 500, y: 0, width: 3000, height: 3000 });
    expect(cropRect(view)).toEqual({
      ...centerCropRectForAspect(4000, 3000, 1),
    });
  });

  it("is the old automatic centre crop, for a portrait photo in a 3:1 banner", () => {
    const view = initialCropView(3000, 4000, 3);
    // Full width, a 1000px strip from the middle. Cutting the wrong axis is
    // the forehead strip `centerCropRectForAspect` warns about.
    expect(cropRect(view)).toEqual({ x: 0, y: 1500, width: 3000, height: 1000 });
    expect(cropRect(view)).toEqual(centerCropRectForAspect(3000, 4000, 3));
  });

  it("fills the frame with a picture that is exactly the frame's shape", () => {
    expect(cropRect(initialCropView(1500, 500, 3))).toEqual({
      x: 0,
      y: 0,
      width: 1500,
      height: 500,
    });
  });
});

describe("zoom", () => {
  it("shows a smaller part of the picture as it goes up", () => {
    const view = zoomView(initialCropView(1000, 1000, 1), 2);
    expect(visibleSize(view)).toEqual({ width: 500, height: 500 });
    // Around the centre by default: the slider and the keys.
    expect(cropRect(view)).toEqual({ x: 250, y: 250, width: 500, height: 500 });
  });

  it("stays between 1 and 4", () => {
    const start = initialCropView(1000, 1000, 1);
    expect(zoomView(start, 0.2).zoom).toBe(MIN_CROP_ZOOM);
    expect(zoomView(start, 40).zoom).toBe(MAX_CROP_ZOOM);
    expect(clampView({ ...start, zoom: Number.NaN }).zoom).toBe(MIN_CROP_ZOOM);
  });

  it("keeps the point under the pointer where it is", () => {
    const start = zoomView(initialCropView(1000, 1000, 1), 2); // shows 250..750
    // The pointer at 30% across and 60% down sits over picture (400, 550).
    const zoomed = zoomView(start, 4, 0.3, 0.6);
    const visible = visibleSize(zoomed); // 250 across
    const left = zoomed.centerX - visible.width / 2;
    const top = zoomed.centerY - visible.height / 2;
    expect(left + 0.3 * visible.width).toBeCloseTo(400);
    expect(top + 0.6 * visible.height).toBeCloseTo(550);
  });

  it("never zooms out past an edge, even from a corner", () => {
    const corner = panView(zoomView(initialCropView(1000, 1000, 1), 4), 9999, 9999, 100);
    expect(cropRect(corner)).toEqual({ x: 0, y: 0, width: 250, height: 250 });
    const out = zoomView(corner, 1, 0, 0);
    expect(cropRect(out)).toEqual({ x: 0, y: 0, width: 1000, height: 1000 });
  });

  it("zooms back to where it started with the same wheel distance either way", () => {
    expect(wheelZoomFactor(120) * wheelZoomFactor(-120)).toBeCloseTo(1);
    // Wheel down is out, the way every map and photo viewer does it.
    expect(wheelZoomFactor(120)).toBeLessThan(1);
    expect(wheelZoomFactor(-120)).toBeGreaterThan(1);
  });
});

describe("pan", () => {
  it("moves the picture with the pointer", () => {
    const view = zoomView(initialCropView(1000, 1000, 1), 2); // 500 across
    // A 250px-wide frame: one CSS pixel is two picture pixels.
    const dragged = panView(view, 50, -25, 250);
    // Dragged right by 50: the frame now shows 100 picture pixels further left.
    expect(cropRect(dragged)).toEqual({ x: 150, y: 300, width: 500, height: 500 });
  });

  it("cannot drag the frame off the picture", () => {
    const view = zoomView(initialCropView(1000, 800, 1), 2);
    const far = panView(view, 100_000, -100_000, 300);
    const rect = cropRect(far);
    expect(rect.x).toBe(0);
    expect(rect.y + rect.height).toBe(800);
  });

  it("has nowhere to go at zoom 1 on the axis the picture already fills", () => {
    // A 3:1 frame over a 3:1 picture fills it completely.
    const view = initialCropView(1500, 500, 3);
    expect(cropRect(panView(view, 80, 80, 300))).toEqual(cropRect(view));
  });

  it("slides along the long side at zoom 1", () => {
    // A square frame over a wide photo: the sides can be chosen.
    const view = initialCropView(4000, 3000, 1);
    const left = panView(view, 10_000, 0, 300);
    expect(cropRect(left)).toEqual({ x: 0, y: 0, width: 3000, height: 3000 });
  });

  it("ignores a frame that has not been measured yet", () => {
    const view = initialCropView(1000, 1000, 1);
    expect(panView(view, 50, 50, 0)).toBe(view);
  });
});

describe("what reaches the canvas", () => {
  it("is a fraction of the picture, so a second decode at another size cuts the same part", () => {
    const view = panView(zoomView(initialCropView(2000, 1000, 1), 2), 40, 0, 200);
    const region = cropRegion(view);
    const here = cropRect(view);
    // The same region on a decode half the size is the same rectangle, halved.
    const half = regionToRect(region, 1000, 500);
    expect(half.x).toBe(Math.round(here.x / 2));
    expect(half.width).toBe(Math.round(here.width / 2));
    expect(half.height).toBe(Math.round(here.height / 2));
  });

  it("never asks the canvas for a pixel past the edge", () => {
    const rect = regionToRect({ x: 0.9, y: 0.9, width: 0.2, height: 0.2 }, 333, 777);
    expect(rect.x + rect.width).toBeLessThanOrEqual(333);
    expect(rect.y + rect.height).toBeLessThanOrEqual(777);
    expect(rect.width).toBeGreaterThan(0);
  });

  it("keeps the frame's shape after rounding", () => {
    const rect = cropRect(zoomView(initialCropView(4032, 3024, 3), 1.7));
    expect(rect.width / rect.height).toBeCloseTo(3, 1);
  });
});

describe("drawing the picture in the frame", () => {
  it("lines the visible part up with the frame exactly", () => {
    const view = panView(zoomView(initialCropView(1000, 1000, 1), 2), 50, 0, 250);
    const layout = imageLayout(view, 250);
    const rect = cropRect(view); // x 150, width 500
    const scale = 250 / rect.width;
    expect(layout.width).toBeCloseTo(1000 * scale);
    expect(layout.left).toBeCloseTo(-rect.x * scale);
    expect(layout.top).toBeCloseTo(-rect.y * scale);
    // And the picture always covers the frame: no empty edge.
    expect(layout.left).toBeLessThanOrEqual(0);
    expect(layout.left + layout.width).toBeGreaterThanOrEqual(250);
  });
});

import { describe, expect, it } from "vitest";
import { GUARDED_LOWER_LAYER_FPS, guardedLayerFramerates } from "./share-guard-layers";

// livekit-client's order for a three-layer screen share: 360p, 720p, full.
const SIMULCAST = [
  { scaleResolutionDownBy: 3 },
  { scaleResolutionDownBy: 1.5 },
  { scaleResolutionDownBy: 1 },
];

describe("guardedLayerFramerates", () => {
  it("leaves every layer at the capture rate when the guard holds nothing", () => {
    expect(guardedLayerFramerates(SIMULCAST, 60, false)).toEqual([60, 60, 60]);
  });

  it("drops only the smaller copies to 30 under a ceiling that keeps 60", () => {
    expect(guardedLayerFramerates(SIMULCAST, 60, true)).toEqual([
      GUARDED_LOWER_LAYER_FPS,
      GUARDED_LOWER_LAYER_FPS,
      60,
    ]);
  });

  it("never raises a layer above the level's own rate", () => {
    expect(guardedLayerFramerates(SIMULCAST, 30, true)).toEqual([30, 30, 30]);
    expect(guardedLayerFramerates(SIMULCAST, 24, true)).toEqual([24, 24, 24]);
  });

  it("finds the top layer by scale, not by position", () => {
    const reordered = [{ scaleResolutionDownBy: 1 }, { scaleResolutionDownBy: 2 }, { scaleResolutionDownBy: 4 }];
    expect(guardedLayerFramerates(reordered, 60, true)).toEqual([60, 30, 30]);
  });

  it("treats a missing scale as full size, and a tie goes to the last layer", () => {
    expect(guardedLayerFramerates([{}, {}, {}], 60, true)).toEqual([30, 30, 60]);
  });

  it("keeps a single-layer share (a watch party's ingest, a mesh sender) whole", () => {
    expect(guardedLayerFramerates([{}], 60, true)).toEqual([60]);
    expect(guardedLayerFramerates([], 60, true)).toEqual([]);
  });
});

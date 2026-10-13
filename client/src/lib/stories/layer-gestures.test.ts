import { describe, expect, it } from "vitest";
import {
  HANDLE_ROTATE_DEAD_ZONE,
  SNAP_DISTANCE,
  clampScaleToFit,
  dragTo,
  handleDrag,
  keyboardTransform,
  maxScaleToFit,
  nearSafeEdge,
  overTrash,
  pinch,
  snap,
  trashZone,
  wheelScale,
} from "./layer-gestures";

const canvas = { width: 400, height: 711 };
const start = { x: 0.5, y: 0.5, scale: 1, rotation: 0 };

describe("dragTo", () => {
  it("moves by the pointer's travel in canvas units, not pixels", () => {
    const moved = dragTo(start, { x: 100, y: 100 }, { x: 140, y: 171.1 }, canvas);
    expect(moved.x).toBeCloseTo(0.6, 5);
    expect(moved.y).toBeCloseTo(0.6, 5);
    expect(moved.scale).toBe(1);
  });
});

describe("pinch", () => {
  const a0 = { x: 100, y: 200 };
  const b0 = { x: 200, y: 200 };

  it("scales by how the gap between the fingers changed", () => {
    const result = pinch(start, [a0, b0], [{ x: 50, y: 200 }, { x: 250, y: 200 }], canvas);
    expect(result.scale).toBeCloseTo(2, 5);
    expect(result.rotation).toBeCloseTo(0, 5);
  });

  it("turns with the line between the fingers", () => {
    const result = pinch(start, [a0, b0], [{ x: 150, y: 150 }, { x: 150, y: 250 }], canvas);
    expect(result.rotation).toBeCloseTo(Math.PI / 2, 5);
    expect(result.scale).toBeCloseTo(1, 5);
  });

  it("follows the midpoint", () => {
    const result = pinch(start, [a0, b0], [{ x: 140, y: 200 }, { x: 240, y: 200 }], canvas);
    expect(result.x).toBeCloseTo(0.6, 5);
  });

  it("never leaves the allowed scale, however far the fingers go", () => {
    expect(pinch(start, [a0, b0], [{ x: 0, y: 0 }, { x: 4000, y: 0 }], canvas).scale).toBe(5);
    expect(pinch(start, [a0, b0], [a0, { x: 100.1, y: 200 }], canvas).scale).toBe(0.2);
  });

  it("does not divide by zero when the fingers start on the same spot", () => {
    expect(pinch(start, [a0, a0], [a0, b0], canvas).scale).toBe(1);
  });
});

describe("handleDrag", () => {
  const center = { x: 200, y: 300 };
  it("scales by the handle's distance from the center", () => {
    const result = handleDrag(start, center, { x: 250, y: 300 }, { x: 350, y: 300 });
    expect(result.scale).toBeCloseTo(3, 5);
  });
  it("turns by the swing around the center, from the edge of the dead zone (no jump)", () => {
    const result = handleDrag(start, center, { x: 250, y: 300 }, { x: 200, y: 350 });
    expect(result.rotation).toBeCloseTo(Math.PI / 2 - HANDLE_ROTATE_DEAD_ZONE, 5);
  });
  it("does not turn on a small wobble: a pull in or out stays a pure scale", () => {
    // The pointer drifts 6 degrees sideways while it pulls out.
    const drift = (6 * Math.PI) / 180;
    const result = handleDrag(start, center, { x: 250, y: 300 }, { x: 200 + 100 * Math.cos(drift), y: 300 + 100 * Math.sin(drift) });
    expect(result.rotation).toBe(0);
    expect(result.scale).toBeCloseTo(2, 5);
  });
  it("with Shift it only turns, freely, and the scale stays put", () => {
    const drift = (6 * Math.PI) / 180;
    const result = handleDrag(start, center, { x: 250, y: 300 }, { x: 200 + 100 * Math.cos(drift), y: 300 + 100 * Math.sin(drift) }, { shift: true });
    expect(result.scale).toBe(1);
    expect(result.rotation).toBeCloseTo(drift, 5);
  });
  it("swings the short way round: crossing the back of the layer is not a lap", () => {
    const at = (degrees: number) => ({ x: 200 + 100 * Math.cos((degrees * Math.PI) / 180), y: 300 + 100 * Math.sin((degrees * Math.PI) / 180) });
    const result = handleDrag(start, center, at(170), at(-170), { shift: true });
    expect(result.rotation).toBeCloseTo((20 * Math.PI) / 180, 5);
  });
  it("never scales a layer past the canvas it is on", () => {
    const natural = { width: 300, height: 60 };
    const result = handleDrag(start, center, { x: 250, y: 300 }, { x: 1000, y: 300 }, { fit: natural, canvas });
    // The canvas is 400 wide and the layer 300 wide at scale 1: a third more at most.
    expect(result.scale).toBeCloseTo(400 / 300, 5);
  });
});

describe("keeping a layer on the canvas", () => {
  const natural = { width: 300, height: 60 };
  it("the biggest scale is the one at which the turned layer still fits", () => {
    expect(maxScaleToFit(natural, 0, canvas)).toBeCloseTo(400 / 300, 5);
    // Turned a quarter, its 300 length is vertical: 711 / 300.
    expect(maxScaleToFit(natural, Math.PI / 2, canvas)).toBeCloseTo(Math.min(400 / 60, 711 / 300), 5);
  });
  it("without a measured size there is no limit beyond the shared bounds", () => {
    expect(maxScaleToFit(null, 0, canvas)).toBe(5);
    expect(clampScaleToFit(9, null, 0, canvas)).toBe(5);
  });
  it("a layer that is already too big is not forced smaller, only kept from growing", () => {
    const big = { width: 600, height: 60 };
    expect(clampScaleToFit(1, big, 0, canvas, 1)).toBe(1);
    expect(clampScaleToFit(1.5, big, 0, canvas, 1)).toBe(1);
    expect(clampScaleToFit(0.5, big, 0, canvas, 1)).toBe(0.5);
  });
  it("keys and the wheel stop at the canvas too", () => {
    expect(wheelScale(1.3, -5000, { natural, rotation: 0, canvas })).toBeCloseTo(400 / 300, 5);
    const grown = keyboardTransform({ ...start, scale: 1.3 }, "+", false, { natural, canvas });
    expect(grown!.scale).toBeCloseTo(400 / 300, 5);
    // Turning it so that it no longer fits shrinks it to fit, never past.
    const turned = keyboardTransform({ ...start, scale: 1.3 }, "]", false, { natural, canvas });
    expect(turned!.scale).toBeLessThanOrEqual(1.3);
  });
});

describe("the safe area guide", () => {
  const natural = { width: 100, height: 40 };
  it("is quiet in the middle of the canvas", () => {
    expect(nearSafeEdge({ ...start }, natural, canvas)).toEqual({ near: false, outside: false });
  });
  it("shows near an edge of the safe rectangle, and turns bright past it", () => {
    // Right edge of the layer at 400 * 0.95 - 4 = 376: inside, but within 14 px of the edge.
    expect(nearSafeEdge({ ...start, x: (376 - 50) / 400 }, natural, canvas)).toEqual({ near: true, outside: false });
    expect(nearSafeEdge({ ...start, x: 0.98 }, natural, canvas)).toEqual({ near: true, outside: true });
    // The top band is a tenth of the height.
    expect(nearSafeEdge({ ...start, y: 0.1 }, natural, canvas).outside).toBe(true);
  });
  it("sees a turned or scaled layer by its bounding box", () => {
    expect(nearSafeEdge({ x: 0.5, y: 0.5, scale: 4.2, rotation: 0 }, natural, canvas).outside).toBe(true);
  });
});

describe("wheelScale", () => {
  it("grows on scroll up and shrinks on scroll down", () => {
    expect(wheelScale(1, -100)).toBeGreaterThan(1);
    expect(wheelScale(1, 100)).toBeLessThan(1);
  });
  it("stays inside the bounds", () => {
    expect(wheelScale(5, -5000)).toBe(5);
    expect(wheelScale(0.2, 5000)).toBe(0.2);
  });
});

describe("snap", () => {
  it("pulls a layer onto a center line it is close to and says which", () => {
    const result = snap({ ...start, x: 0.5 + SNAP_DISTANCE / 2, y: 0.3 });
    expect(result.x).toBe(0.5);
    expect(result.guideX).toBe(true);
    expect(result.y).toBe(0.3);
    expect(result.guideY).toBe(false);
  });

  it("leaves a layer that is farther than the pull alone", () => {
    const result = snap({ ...start, x: 0.5 + SNAP_DISTANCE * 2 });
    expect(result.guideX).toBe(false);
    expect(result.x).toBeCloseTo(0.5 + SNAP_DISTANCE * 2, 6);
  });

  it("snaps a near-upright rotation only when rotating", () => {
    expect(snap({ ...start, rotation: 0.01 }).rotation).toBe(0.01);
    const turning = snap({ ...start, rotation: 0.01 }, { rotate: true });
    expect(turning.rotation).toBe(0);
    expect(turning.guideAngle).toBe(true);
    expect(snap({ ...start, rotation: Math.PI / 4 + 0.01 }, { rotate: true }).rotation).toBeCloseTo(Math.PI / 4, 6);
  });
});

describe("the trash zone", () => {
  it("is at the bottom center and catches a pointer inside it", () => {
    const zone = trashZone(canvas);
    expect(zone.center.x).toBe(200);
    expect(overTrash(zone.center, canvas)).toBe(true);
    expect(overTrash({ x: 200, y: 100 }, canvas)).toBe(false);
    expect(overTrash({ x: 20, y: zone.center.y }, canvas)).toBe(false);
  });
});

describe("keyboardTransform", () => {
  it("moves by 1% and by 5% with Shift, inside the canvas", () => {
    expect(keyboardTransform(start, "ArrowRight", false)!.x).toBeCloseTo(0.51, 6);
    expect(keyboardTransform(start, "ArrowUp", true)!.y).toBeCloseTo(0.45, 6);
    expect(keyboardTransform({ ...start, x: 0.005 }, "ArrowLeft", false)!.x).toBe(0);
  });

  it("scales and turns", () => {
    expect(keyboardTransform(start, "+", false)!.scale).toBeCloseTo(1.1, 6);
    expect(keyboardTransform(start, "-", false)!.scale).toBeCloseTo(1 / 1.1, 6);
    expect(keyboardTransform(start, "]", false)!.rotation).toBeGreaterThan(0);
    expect(keyboardTransform(start, "[", false)!.rotation).toBeLessThan(0);
  });

  it("ignores keys it does not own", () => {
    expect(keyboardTransform(start, "a", false)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  SNAP_DISTANCE,
  dragTo,
  handleDrag,
  keyboardTransform,
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
  it("turns by the swing around the center", () => {
    const result = handleDrag(start, center, { x: 250, y: 300 }, { x: 200, y: 350 });
    expect(result.rotation).toBeCloseTo(Math.PI / 2, 5);
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

import { describe, expect, it } from "vitest";
import { createRope, endAngle, grabEnd, stepRope } from "./rope";

/**
 * The rope, without a browser.
 *
 * This is the entire reason the maths lives in its own file: a hanging strap
 * either settles or it does not, and finding out by watching a canvas is not a
 * test. The properties below are the ones a physics engine would have given us
 * for free and which we now owe ourselves.
 */

const OPTS = {
  gravity: 9.8,
  damping: 0.97,
  spacing: 0.22,
  iterations: 6,
  dt: 1 / 60,
};

function settle(points: ReturnType<typeof createRope>, steps = 600) {
  for (let i = 0; i < steps; i += 1) {
    stepRope(points, OPTS);
  }
}

describe("stepRope", () => {
  it("hangs straight down and stops moving", () => {
    // The one behaviour that matters: left alone, a strap comes to rest. A
    // damping value at or above 1 passes every other test here and never
    // settles, which on screen is a badge that jitters forever.
    const rope = createRope({ segments: 10, spacing: 0.22, originX: 0, originY: 2 });
    settle(rope);
    const end = rope[rope.length - 1]!;
    expect(Math.abs(end.x)).toBeLessThan(0.01);
    expect(Math.abs(end.x - end.px)).toBeLessThan(0.0005);
    expect(Math.abs(end.y - end.py)).toBeLessThan(0.0005);
  });

  it("keeps the pinned end exactly where it was put", () => {
    // A rope that crawls off its anchor is the classic symptom of splitting
    // constraint error evenly against a pinned point.
    const rope = createRope({ segments: 10, spacing: 0.22, originX: 0.4, originY: 2 });
    settle(rope, 900);
    expect(rope[0]!.x).toBe(0.4);
    expect(rope[0]!.y).toBe(2);
  });

  it("does not stretch under its own weight", () => {
    const rope = createRope({ segments: 12, spacing: 0.22, originX: 0, originY: 2 });
    settle(rope);
    for (let i = 0; i < rope.length - 1; i += 1) {
      const a = rope[i]!;
      const b = rope[i + 1]!;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(0.22, 1);
    }
  });

  it("swings back when pulled aside and let go", () => {
    const rope = createRope({ segments: 10, spacing: 0.22, originX: 0, originY: 2 });
    settle(rope);
    grabEnd(rope, 1.2, 0.4);
    for (let i = 0; i < 20; i += 1) {
      stepRope(rope, OPTS);
    }
    const swinging = rope[rope.length - 1]!.x;
    expect(swinging).toBeLessThan(1.2);
    settle(rope, 1200);
    expect(Math.abs(rope[rope.length - 1]!.x)).toBeLessThan(0.02);
  });

  it("survives a frame the tab slept through", () => {
    // A backgrounded tab hands back an enormous dt on the next frame. The
    // caller clamps it, and this pins that the clamped value stays finite
    // rather than flinging the badge to infinity.
    const rope = createRope({ segments: 10, spacing: 0.22, originX: 0, originY: 2 });
    stepRope(rope, { ...OPTS, dt: 1 / 20 });
    for (const point of rope) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });
});

describe("grabEnd", () => {
  it("moves the end and forgets its velocity", () => {
    // Without the velocity reset, releasing a drag launches the badge at
    // whatever speed the pointer was moving twenty frames earlier.
    const rope = createRope({ segments: 6, spacing: 0.22, originX: 0, originY: 2 });
    settle(rope, 120);
    grabEnd(rope, 0.8, 0.9);
    const end = rope[rope.length - 1]!;
    expect(end.x).toBe(end.px);
    expect(end.y).toBe(end.py);
  });
});

describe("endAngle", () => {
  it("is zero when the strap hangs straight", () => {
    const rope = createRope({ segments: 10, spacing: 0.22, originX: 0, originY: 2 });
    settle(rope);
    expect(Math.abs(endAngle(rope))).toBeLessThan(0.02);
  });

  it("leans the way the strap leans", () => {
    const rope = createRope({ segments: 10, spacing: 0.22, originX: 0, originY: 2 });
    settle(rope);
    grabEnd(rope, 1.0, 0.6);
    stepRope(rope, OPTS);
    expect(endAngle(rope)).toBeGreaterThan(0);
  });
});

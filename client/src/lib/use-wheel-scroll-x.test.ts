import { describe, expect, it } from "vitest";
import { wheelScrollDelta } from "./use-wheel-scroll-x";

const row = (scrollLeft: number, scrollWidth = 600, clientWidth = 300) => ({ scrollLeft, scrollWidth, clientWidth });
const turn = (deltaY: number, deltaX = 0, deltaMode = 0) => ({ deltaX, deltaY, deltaMode });

describe("wheelScrollDelta", () => {
  it("turns a vertical wheel into a sideways move, both ways", () => {
    expect(wheelScrollDelta(turn(100), row(0))).toBe(100);
    expect(wheelScrollDelta(turn(-100), row(150))).toBe(-100);
  });

  it("leaves a sideways swipe to the browser", () => {
    expect(wheelScrollDelta(turn(5, 80), row(0))).toBe(0);
  });

  it("lets the turn through at either end, and when nothing overflows", () => {
    expect(wheelScrollDelta(turn(100), row(300))).toBe(0);
    expect(wheelScrollDelta(turn(-100), row(0))).toBe(0);
    expect(wheelScrollDelta(turn(100), row(0, 300, 300))).toBe(0);
  });

  it("reads a line or a page turn in pixels", () => {
    expect(wheelScrollDelta(turn(3, 0, 1), row(0))).toBe(48);
    expect(wheelScrollDelta(turn(1, 0, 2), row(0))).toBe(300);
  });
});

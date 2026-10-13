import { describe, expect, it } from "vitest";
import {
  autoscrollStep,
  clampTop,
  dropLineY,
  keyMoveTarget,
  moveId,
  railKeyMove,
  targetSlot,
  type RailSlot,
} from "./server-rail-reorder";

// Five 48px tiles with an 8px gap, from y = 100.
const slots: RailSlot[] = [0, 1, 2, 3, 4].map((i) => ({ top: 100 + i * 56, height: 48 }));

describe("moveId", () => {
  it("moves down and up", () => {
    expect(moveId(["a", "b", "c", "d"], "a", 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveId(["a", "b", "c", "d"], "d", 0)).toEqual(["d", "a", "b", "c"]);
  });
  it("clamps to the ends and ignores a no-op or an unknown id", () => {
    expect(moveId(["a", "b", "c"], "a", 99)).toEqual(["b", "c", "a"]);
    expect(moveId(["a", "b", "c"], "c", -5)).toEqual(["c", "a", "b"]);
    expect(moveId(["a", "b", "c"], "b", 1)).toEqual(["a", "b", "c"]);
    expect(moveId(["a", "b", "c"], "z", 0)).toEqual(["a", "b", "c"]);
  });
});

describe("targetSlot", () => {
  it("picks the nearest slot centre", () => {
    expect(targetSlot(slots, 100 + 24)).toBe(0);
    expect(targetSlot(slots, 100 + 56 + 24)).toBe(1);
    expect(targetSlot(slots, 100 + 56 * 2 + 40)).toBe(2);
  });
  it("answers the end slot past either end", () => {
    expect(targetSlot(slots, -500)).toBe(0);
    expect(targetSlot(slots, 99_999)).toBe(4);
  });
});

describe("dropLineY", () => {
  it("is null when nothing would change", () => {
    expect(dropLineY(slots, 2, 2, 8)).toBeNull();
  });
  it("sits after the target when moving down and before it when moving up", () => {
    expect(dropLineY(slots, 0, 2, 8)).toBe(100 + 56 * 2 + 48 + 4);
    expect(dropLineY(slots, 4, 1, 8)).toBe(100 + 56 - 4);
  });
  it("can sit above the first tile and below the last", () => {
    expect(dropLineY(slots, 3, 0, 8)).toBe(96);
    expect(dropLineY(slots, 0, 4, 8)).toBe(100 + 56 * 4 + 48 + 4);
  });
});

describe("clampTop", () => {
  it("keeps the dragged tile inside the list", () => {
    expect(clampTop(slots, 0)).toBe(100);
    expect(clampTop(slots, 5000)).toBe(100 + 56 * 4);
    expect(clampTop(slots, 200)).toBe(200);
  });
});

describe("autoscrollStep", () => {
  it("is zero in the middle and scrolls toward the edge the pointer is in", () => {
    expect(autoscrollStep(400, 0, 800)).toBe(0);
    expect(autoscrollStep(10, 0, 800)).toBeLessThan(0);
    expect(autoscrollStep(790, 0, 800)).toBeGreaterThan(0);
  });
  it("is fastest at and beyond the edge, and never exceeds the cap", () => {
    expect(autoscrollStep(-200, 0, 800)).toBe(-18);
    expect(autoscrollStep(2000, 0, 800)).toBe(18);
    expect(Math.abs(autoscrollStep(40, 0, 800))).toBeLessThan(Math.abs(autoscrollStep(5, 0, 800)));
  });
});

describe("railKeyMove", () => {
  const key = (k: string, extra = {}) => ({
    key: k,
    altKey: true,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    ...extra,
  });
  it("needs Alt and nothing else", () => {
    expect(railKeyMove(key("ArrowUp"))).toBe("up");
    expect(railKeyMove(key("ArrowDown"))).toBe("down");
    expect(railKeyMove(key("Home"))).toBe("first");
    expect(railKeyMove(key("End"))).toBe("last");
    expect(railKeyMove(key("ArrowUp", { altKey: false }))).toBeNull();
    // Alt+Shift+arrow is "next unread channel", not ours.
    expect(railKeyMove(key("ArrowUp", { shiftKey: true }))).toBeNull();
    expect(railKeyMove(key("ArrowUp", { ctrlKey: true }))).toBeNull();
    expect(railKeyMove(key("a"))).toBeNull();
  });
});

describe("keyMoveTarget", () => {
  it("steps and stops at the ends", () => {
    expect(keyMoveTarget("up", 0, 5)).toBe(0);
    expect(keyMoveTarget("up", 3, 5)).toBe(2);
    expect(keyMoveTarget("down", 4, 5)).toBe(4);
    expect(keyMoveTarget("down", 1, 5)).toBe(2);
    expect(keyMoveTarget("first", 3, 5)).toBe(0);
    expect(keyMoveTarget("last", 1, 5)).toBe(4);
  });
});

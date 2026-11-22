import { describe, expect, it } from "vitest";
import { alignPanelEnd } from "./composer-picker-place";

describe("alignPanelEnd", () => {
  it("puts the panel's right edge on the button's right edge", () => {
    // A 1440px window, the composer from 300 to 1440, emoji button ending at 1380.
    const placed = alignPanelEnd(1380, { left: 300, right: 1440 }, 336);
    expect(placed).toEqual({ left: 1044, width: 336, right: 60 });
  });

  it("slides right to stay inside a narrow pane", () => {
    // The thread panel's composer: 416px wide, the button near its left.
    const placed = alignPanelEnd(1100, { left: 1000, right: 1416 }, 336);
    expect(placed.left).toBe(1008);
    expect(placed.left + placed.width).toBeLessThanOrEqual(1416 - 8);
  });

  it("shrinks to the pane when the pane is narrower than the panel", () => {
    const placed = alignPanelEnd(290, { left: 0, right: 300 }, 336);
    expect(placed).toEqual({ left: 8, width: 284, right: 8 });
  });
});

import { describe, expect, it } from "vitest";
import { horizontalShiftIntoView } from "./context-menu-placement";

const VIEWPORT = 390;
const PAD = 8;

describe("horizontalShiftIntoView", () => {
  it("leaves a menu that already fits alone", () => {
    expect(
      horizontalShiftIntoView({ left: 94, right: 358 }, 0, VIEWPORT, PAD),
    ).toBe(0);
  });

  it("pulls a menu hanging off the right edge back in", () => {
    // A long-press at x=132 on a 390px phone: 134 to 398.
    expect(
      horizontalShiftIntoView({ left: 134, right: 398 }, 0, VIEWPORT, PAD),
    ).toBe(-16);
  });

  it("pushes a menu hanging off the left edge back in", () => {
    // A long-press at x=252, flipped to the left: -14 to 250.
    expect(
      horizontalShiftIntoView({ left: -14, right: 250 }, 0, VIEWPORT, PAD),
    ).toBe(22);
  });

  it("measures from the unshifted position, so a second pass is stable", () => {
    // The menu already sits at 118 to 382 after a shift of -16.
    expect(
      horizontalShiftIntoView({ left: 118, right: 382 }, -16, VIEWPORT, PAD),
    ).toBe(-16);
  });

  it("keeps the left edge visible when the window is narrower than the menu", () => {
    expect(horizontalShiftIntoView({ left: 40, right: 340 }, 0, 300, PAD)).toBe(
      -32,
    );
  });
});

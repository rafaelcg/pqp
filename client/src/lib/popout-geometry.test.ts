import { describe, expect, it } from "vitest";
import {
  POPOUT_ASPECT,
  POPOUT_DEFAULT_WIDTH_FRACTION,
  POPOUT_MARGIN_PX,
  POPOUT_MAX_WIDTH_FRACTION,
  POPOUT_MIN_WIDTH_PX,
  clampToArea,
  clampWidthFraction,
  cornerAfterArrow,
  nearestCorner,
  popoutRect,
  popoutSize,
  widthFractionFor,
  type PopoutRect,
} from "./popout-geometry";

/** A laptop's conversation area: right of a 300px sidebar, above the composer. */
const area: PopoutRect = { left: 300, top: 48, width: 1000, height: 700 };

describe("popoutSize", () => {
  it("is the stored fraction of the area's width, at 16:9", () => {
    expect(popoutSize(area, 0.32)).toEqual({ width: 320, height: Math.round(320 / POPOUT_ASPECT) });
  });

  it("never goes below the legible minimum or above the popout maximum", () => {
    expect(popoutSize(area, 0.05).width).toBe(POPOUT_MIN_WIDTH_PX);
    expect(popoutSize(area, 0.95).width).toBe(1000 * POPOUT_MAX_WIDTH_FRACTION);
  });

  it("gives up width rather than overflow a short area", () => {
    const short = { ...area, height: 200 };
    const size = popoutSize(short, 0.5);
    expect(size.height).toBe(200 - 2 * POPOUT_MARGIN_PX);
    expect(size.width).toBe(Math.round(size.height * POPOUT_ASPECT));
  });

  it("fits inside an area narrower than the minimum", () => {
    const narrow = { ...area, width: 200 };
    expect(popoutSize(narrow, 0.32).width).toBeLessThanOrEqual(200 - 2 * POPOUT_MARGIN_PX);
  });
});

describe("popoutRect", () => {
  it("rests in each corner, a margin away from the edges", () => {
    const { width, height } = popoutSize(area, 0.32);
    expect(popoutRect(area, "top-left", 0.32)).toEqual({
      left: 300 + POPOUT_MARGIN_PX,
      top: 48 + POPOUT_MARGIN_PX,
      width,
      height,
    });
    const bottomRight = popoutRect(area, "bottom-right", 0.32);
    expect(bottomRight.left + width).toBe(1300 - POPOUT_MARGIN_PX);
    expect(bottomRight.top + height).toBe(748 - POPOUT_MARGIN_PX);
  });
});

describe("clampToArea", () => {
  it("keeps a dragged popout inside the area", () => {
    const rect = { left: 2000, top: -50, width: 320, height: 180 };
    expect(clampToArea(area, rect)).toEqual({ left: 980, top: 48, width: 320, height: 180 });
    expect(clampToArea(area, { ...rect, left: 0, top: 9000 })).toEqual({
      left: 300,
      top: 568,
      width: 320,
      height: 180,
    });
  });
});

describe("nearestCorner", () => {
  it("snaps by the popout's centre", () => {
    const at = (left: number, top: number) => ({ left, top, width: 320, height: 180 });
    expect(nearestCorner(area, at(310, 60))).toBe("top-left");
    expect(nearestCorner(area, at(900, 60))).toBe("top-right");
    expect(nearestCorner(area, at(310, 500))).toBe("bottom-left");
    expect(nearestCorner(area, at(900, 500))).toBe("bottom-right");
  });
});

describe("width fraction", () => {
  it("is stored relative to the area and clamped", () => {
    expect(widthFractionFor(area, 400)).toBeCloseTo(0.4);
    expect(widthFractionFor(area, 5000)).toBe(POPOUT_MAX_WIDTH_FRACTION);
    expect(widthFractionFor({ ...area, width: 0 }, 400)).toBe(POPOUT_DEFAULT_WIDTH_FRACTION);
  });

  it("reads garbage as the default", () => {
    expect(clampWidthFraction(Number.NaN)).toBe(POPOUT_DEFAULT_WIDTH_FRACTION);
    expect(clampWidthFraction(-1)).toBe(POPOUT_DEFAULT_WIDTH_FRACTION);
  });
});

describe("cornerAfterArrow", () => {
  it("moves to the corner on that side and keeps the other axis", () => {
    expect(cornerAfterArrow("bottom-right", "ArrowUp")).toBe("top-right");
    expect(cornerAfterArrow("bottom-right", "ArrowLeft")).toBe("bottom-left");
    expect(cornerAfterArrow("top-left", "ArrowDown")).toBe("bottom-left");
    expect(cornerAfterArrow("top-left", "ArrowRight")).toBe("top-right");
    expect(cornerAfterArrow("top-left", "ArrowUp")).toBe("top-left");
  });
});

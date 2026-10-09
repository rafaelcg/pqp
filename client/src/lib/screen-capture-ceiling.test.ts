import { describe, expect, it } from "vitest";
import { screenCaptureCeiling } from "./screen-capture-ceiling";

/** What `screenCaptureOptions` opens a share with, as `getConstraints()` returns it. */
const OPENED: MediaTrackConstraints = {
  frameRate: { ideal: 30, max: 30 },
  width: { max: 1920 },
  height: { max: 1080 },
};

describe("screenCaptureCeiling", () => {
  it("scales the width ceiling with the height, which is what makes Chrome rescale", () => {
    // Measured: { width: { max: 1920 }, height: { max: 720 } } leaves a
    // 1920x1080 capture at 1920x1080; { width: { max: 1280 }, ... } gives 1280x720.
    expect(screenCaptureCeiling(OPENED, 720, { width: 1920, height: 1080 })).toEqual({
      frameRate: { ideal: 30, max: 30 },
      width: { max: 1280 },
      height: { max: 720 },
    });
  });

  it("uses the capture's own shape, so an ultrawide stays ultrawide", () => {
    const next = screenCaptureCeiling(OPENED, 720, { width: 3440, height: 1440 });
    expect(next.height).toEqual({ max: 720 });
    expect(next.width).toEqual({ max: 1720 });
  });

  it("never lets the width above the ceiling the share was opened with", () => {
    const next = screenCaptureCeiling(OPENED, 1080, { width: 3440, height: 1440 });
    expect(next.width).toEqual({ max: 1920 });
  });

  it("reads the shape after an earlier rescale the same way, since the ratio survives it", () => {
    const next = screenCaptureCeiling(OPENED, 1080, { width: 1280, height: 720 });
    expect(next.width).toEqual({ max: 1920 });
    expect(next.height).toEqual({ max: 1080 });
  });

  it("drops the width ceiling when the capture reports no size", () => {
    const next = screenCaptureCeiling(OPENED, 720, null);
    expect(next).toEqual({ frameRate: { ideal: 30, max: 30 }, height: { max: 720 } });
  });

  it("keeps only ceilings, so a leftover ideal cannot pull against the new height", () => {
    const next = screenCaptureCeiling(
      { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 } },
      720,
      { width: 1920, height: 1080 },
    );
    expect(next.width).toEqual({ max: 1280 });
    expect(next.height).toEqual({ max: 720 });
  });
});

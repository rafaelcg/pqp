import { describe, expect, it } from "vitest";
import {
  canZoomToActualSize,
  clampPanOffset,
  computeFit,
  formatDimensions,
  navCounter,
  nextLightboxIndex,
  planImageCopy,
} from "./image-lightbox";

describe("computeFit", () => {
  it("shrinks a large image to fit inside the viewport", () => {
    const fit = computeFit(
      { width: 4000, height: 2000 },
      { width: 800, height: 600 },
    );
    // Width is the binding constraint: 800 / 4000 = 0.2, vs 600 / 2000 = 0.3.
    expect(fit).toEqual({ width: 800, height: 400, scale: 0.2 });
  });

  it("never upscales a small image past its own pixels", () => {
    const fit = computeFit(
      { width: 200, height: 100 },
      { width: 1200, height: 800 },
    );
    expect(fit).toEqual({ width: 200, height: 100, scale: 1 });
  });

  it("falls back to the viewport when the natural size is not known yet", () => {
    const fit = computeFit({ width: 0, height: 0 }, { width: 800, height: 600 });
    expect(fit).toEqual({ width: 800, height: 600, scale: 1 });
  });

  it("falls back to the viewport when the viewport itself is degenerate", () => {
    const fit = computeFit({ width: 100, height: 100 }, { width: 0, height: 0 });
    expect(fit).toEqual({ width: 0, height: 0, scale: 1 });
  });
});

describe("canZoomToActualSize", () => {
  it("offers zoom when the image was shrunk to fit", () => {
    const natural = { width: 4000, height: 2000 };
    const fit = computeFit(natural, { width: 800, height: 600 });
    expect(canZoomToActualSize(natural, fit)).toBe(true);
  });

  it("has nothing to offer when the image already fits at full size", () => {
    const natural = { width: 200, height: 100 };
    const fit = computeFit(natural, { width: 1200, height: 800 });
    expect(canZoomToActualSize(natural, fit)).toBe(false);
  });
});

describe("clampPanOffset", () => {
  it("allows no pan when the content fits inside the viewport", () => {
    expect(clampPanOffset(50, 400, 800)).toBe(0);
  });

  it("clamps to half the overhang on each side", () => {
    // Content is 1000px in a 800px viewport: 100px of overhang per side.
    expect(clampPanOffset(500, 1000, 800)).toBe(100);
    expect(clampPanOffset(-500, 1000, 800)).toBe(-100);
  });

  it("passes an offset already inside bounds through unchanged", () => {
    expect(clampPanOffset(40, 1000, 800)).toBe(40);
  });
});

describe("nextLightboxIndex", () => {
  it("moves right and left inside the strip", () => {
    expect(nextLightboxIndex(1, 5, 1)).toBe(2);
    expect(nextLightboxIndex(1, 5, -1)).toBe(0);
  });

  it("stops at the last attachment instead of wrapping to the first", () => {
    expect(nextLightboxIndex(4, 5, 1)).toBeNull();
  });

  it("stops at the first attachment instead of wrapping to the last", () => {
    expect(nextLightboxIndex(0, 5, -1)).toBeNull();
  });

  it("has nowhere to go in a single-attachment message", () => {
    expect(nextLightboxIndex(0, 1, 1)).toBeNull();
    expect(nextLightboxIndex(0, 1, -1)).toBeNull();
  });
});

describe("navCounter", () => {
  it("is one-based for display", () => {
    expect(navCounter(0, 5)).toEqual({ position: 1, total: 5 });
    expect(navCounter(4, 5)).toEqual({ position: 5, total: 5 });
  });
});

describe("planImageCopy", () => {
  it("copies a PNG directly", () => {
    expect(planImageCopy("image/png")).toEqual({
      needsConversion: false,
      includeLinkText: false,
      reason: "png",
    });
  });

  it("converts a JPEG through a canvas, with no link riding along", () => {
    expect(planImageCopy("image/jpeg")).toEqual({
      needsConversion: true,
      includeLinkText: false,
      reason: "convert",
    });
  });

  it("converts WebP and AVIF the same way as JPEG", () => {
    expect(planImageCopy("image/webp").reason).toBe("convert");
    expect(planImageCopy("image/avif").reason).toBe("convert");
  });

  it("converts a GIF to its first frame and carries the link as a second format", () => {
    expect(planImageCopy("image/gif")).toEqual({
      needsConversion: true,
      includeLinkText: true,
      reason: "gif",
    });
  });

  it("is case- and whitespace-insensitive", () => {
    expect(planImageCopy(" IMAGE/GIF ").reason).toBe("gif");
  });
});

describe("formatDimensions", () => {
  it("joins width and height", () => {
    expect(formatDimensions(1920, 1080)).toBe("1920 × 1080");
  });

  it("is null when either dimension is missing", () => {
    expect(formatDimensions(null, 1080)).toBeNull();
    expect(formatDimensions(1920, null)).toBeNull();
    expect(formatDimensions(null, null)).toBeNull();
  });
});

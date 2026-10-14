import { describe, expect, it } from "vitest";
import {
  STORY_LAYER_COLORS,
  STORY_LAYOUT,
  STORY_SAFE_AREA,
  STORY_TEXT_COLOR_HEX,
  storyBaseFit,
  storyTextOnColorHex,
} from "./stories.js";

describe("STORY_SAFE_AREA", () => {
  it("leaves a real rectangle between the viewer's bars, and a bigger bottom than top (the reply row)", () => {
    expect(STORY_SAFE_AREA).toEqual({ x: 0.05, top: 0.1, bottom: 0.13 });
    expect(1 - 2 * STORY_SAFE_AREA.x).toBeGreaterThan(0.8);
    expect(1 - STORY_SAFE_AREA.top - STORY_SAFE_AREA.bottom).toBeGreaterThan(0.7);
    expect(STORY_SAFE_AREA.bottom).toBeGreaterThan(STORY_SAFE_AREA.top);
  });
});

describe("STORY_LAYOUT", () => {
  it("is the canonical table the three clients draw from", () => {
    expect(STORY_LAYOUT).toEqual({
      canvasAspect: 9 / 16,
      textSize: 0.08,
      textMaxWidth: 0.84,
      textLineHeight: 1.14,
      textSoftAlpha: 0.5,
      imageWidth: 0.4,
      imageRoundedRadius: 0.05,
      mentionFont: 0.05,
      callCardWidth: 0.82,
      drawingWidth: 810,
      drawingHeight: 1440,
      baseFillTolerance: 0.12,
    });
  });

  it("makes a drawing the canvas' own shape", () => {
    expect(STORY_LAYOUT.drawingWidth / STORY_LAYOUT.drawingHeight).toBeCloseTo(STORY_LAYOUT.canvasAspect, 6);
  });
});

describe("STORY_TEXT_COLOR_HEX", () => {
  it("has exactly one six-digit hex for each of the twelve palette tokens", () => {
    expect(Object.keys(STORY_TEXT_COLOR_HEX).sort()).toEqual([...STORY_LAYER_COLORS].sort());
    for (const hex of Object.values(STORY_TEXT_COLOR_HEX)) {
      expect(hex).toMatch(/^[0-9A-F]{6}$/);
    }
  });

  it("puts black text on every pill but the black one", () => {
    expect(storyTextOnColorHex("black")).toBe("FFFFFF");
    for (const color of STORY_LAYER_COLORS.filter((entry) => entry !== "black")) {
      expect(storyTextOnColorHex(color)).toBe("000000");
    }
  });
});

describe("storyBaseFit", () => {
  it("fills a picture that is near 9:16, either way", () => {
    expect(storyBaseFit(1080, 1920)).toBe("fill");
    expect(storyBaseFit(1080, 2160)).toBe("fill");
    expect(storyBaseFit(1000, 1700)).toBe("fill");
  });

  it("shows anything wider whole, over a blur", () => {
    expect(storyBaseFit(1920, 1080)).toBe("contain");
    expect(storyBaseFit(1000, 1000)).toBe("contain");
    expect(storyBaseFit(1080, 1350)).toBe("contain");
  });

  it("sits on the 12% edge: just inside fills, just outside does not", () => {
    const aspect = STORY_LAYOUT.canvasAspect;
    expect(storyBaseFit(1000 * aspect * 1.11, 1000)).toBe("fill");
    expect(storyBaseFit(1000 * aspect * 1.13, 1000)).toBe("contain");
    expect(storyBaseFit(1000 * aspect * 0.89, 1000)).toBe("fill");
    expect(storyBaseFit(1000 * aspect * 0.87, 1000)).toBe("contain");
  });

  it("does not divide by a missing size", () => {
    expect(storyBaseFit(0, 100)).toBe("fill");
  });
});

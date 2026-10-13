import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STORY_LAYER_COLORS, STORY_LAYOUT, STORY_TEXT_COLOR_HEX, storyTextOnColorHex } from "@pqp/shared";
import {
  CALL_CARD_CQW,
  IMAGE_BASE_CQW,
  IMAGE_ROUNDED_CQW,
  MENTION_BASE_CQW,
  TEXT_BASE_CQW,
  TEXT_MAX_WIDTH_CQW,
} from "./layers";

/**
 * The web draws from the shared layout table twice: in TypeScript (`layers.ts`)
 * and in the stylesheet (`.story-tl`, `--story-c-*`). The stylesheet cannot
 * import a constant, so this test is what keeps the two from drifting, which is
 * how three platforms ended up with three text sizes.
 */
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../index.css"), "utf8");

describe("the story palette in the stylesheet", () => {
  it("is the shared hex table, token for token", () => {
    for (const color of STORY_LAYER_COLORS) {
      const match = new RegExp(`--story-c-${color}:\\s*#([0-9A-Fa-f]{6})\\s*;`).exec(css);
      expect(match, `--story-c-${color}`).not.toBeNull();
      expect(match![1]!.toUpperCase()).toBe(STORY_TEXT_COLOR_HEX[color]);
    }
  });

  it("puts the shared contrast color on a solid pill", () => {
    for (const color of STORY_LAYER_COLORS) {
      const match = new RegExp(`--story-c-${color}-on:\\s*#([0-9A-Fa-f]{6})\\s*;`).exec(css);
      expect(match![1]!.toUpperCase()).toBe(storyTextOnColorHex(color));
    }
  });
});

describe("the story text in the stylesheet", () => {
  const rule = /\.story-tl \{[^}]*\}/.exec(css)![0];

  it("sets type at the shared size, width and line height", () => {
    expect(rule).toContain(`* ${STORY_LAYOUT.textSize * 100}cqw`);
    expect(rule).toContain(`max-width: ${STORY_LAYOUT.textMaxWidth * 100}cqw`);
    expect(rule).toContain(`line-height: ${STORY_LAYOUT.textLineHeight}`);
  });
});

describe("layers.ts", () => {
  it("reads every length from the shared table", () => {
    expect(TEXT_BASE_CQW).toBeCloseTo(STORY_LAYOUT.textSize * 100, 9);
    expect(TEXT_MAX_WIDTH_CQW).toBeCloseTo(STORY_LAYOUT.textMaxWidth * 100, 9);
    expect(IMAGE_BASE_CQW).toBeCloseTo(STORY_LAYOUT.imageWidth * 100, 9);
    expect(IMAGE_ROUNDED_CQW).toBeCloseTo(STORY_LAYOUT.imageRoundedRadius * 100, 9);
    expect(CALL_CARD_CQW).toBeCloseTo(STORY_LAYOUT.callCardWidth * 100, 9);
    expect(MENTION_BASE_CQW).toBeCloseTo(STORY_LAYOUT.mentionFont * 100, 9);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STORY_CARD_BACKGROUNDS } from "@pqp/shared";

const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

describe("text card backgrounds in the stylesheet", () => {
  // A key the server accepts but the stylesheet does not paint is a blank card in the viewer.
  it("paints every key the contract allows, from a token of the same name", () => {
    for (const key of STORY_CARD_BACKGROUNDS) {
      expect(css, `rule for ${key}`).toContain(`.story-text-card[data-bg="${key}"] {\n  background: var(--story-bg-${key});`);
      expect(css, `token for ${key}`).toMatch(new RegExp(`--story-bg-${key}:`));
    }
  });
});

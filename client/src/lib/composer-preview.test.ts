import { describe, expect, it } from "vitest";
import { draftNeedsPreview } from "./composer-preview";

describe("draftNeedsPreview", () => {
  it("is no for plain text, however many lines", () => {
    expect(draftNeedsPreview("")).toBe(false);
    expect(draftNeedsPreview("   ")).toBe(false);
    expect(draftNeedsPreview("bora jogar hoje?\nlá pelas 9")).toBe(false);
    expect(draftNeedsPreview("snake_case_name e 2 * 3 * 4")).toBe(false);
    expect(draftNeedsPreview("a lone * star and a lone _ and ~")).toBe(false);
  });

  it("is no for what chat keeps as text: headings, rules, mentions, bare links", () => {
    expect(draftNeedsPreview("# anúncio")).toBe(false);
    expect(draftNeedsPreview("texto\n---")).toBe(false);
    expect(draftNeedsPreview("@rafa olha https://pqp.gg")).toBe(false);
  });

  it("is yes for inline markup", () => {
    expect(draftNeedsPreview("**bold**")).toBe(true);
    expect(draftNeedsPreview("*italic*")).toBe(true);
    expect(draftNeedsPreview("2*3*4")).toBe(true);
    expect(draftNeedsPreview("_italic_ word")).toBe(true);
    expect(draftNeedsPreview("~~strike~~")).toBe(true);
    expect(draftNeedsPreview("run `pnpm dev`")).toBe(true);
    expect(draftNeedsPreview("[pqp](https://pqp.gg)")).toBe(true);
    expect(draftNeedsPreview("<https://pqp.gg>")).toBe(true);
    expect(draftNeedsPreview("not \\*bold\\*")).toBe(true);
  });

  it("is yes for blocks: fence, quote, lists", () => {
    expect(draftNeedsPreview("```\nconst x = 1\n```")).toBe(true);
    expect(draftNeedsPreview("> quoted")).toBe(true);
    expect(draftNeedsPreview("itens:\n- um\n- dois")).toBe(true);
    expect(draftNeedsPreview("1. first")).toBe(true);
  });
});

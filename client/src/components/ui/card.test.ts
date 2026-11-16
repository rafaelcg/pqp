import { describe, expect, it } from "vitest";
import { CARD_LIST, CARD_ROW_HOVER, CARD_SURFACE } from "@/components/ui/card";

describe("CARD_SURFACE", () => {
  it("is the card every caller drew, with the toggle off", () => {
    // Each token falls back to the class it replaced: border-border and
    // bg-surface-card.
    expect(CARD_SURFACE).toContain("rounded-[var(--radius-card)]");
    expect(CARD_SURFACE).toContain("border-[color:var(--card-border,var(--color-border))]");
    expect(CARD_SURFACE).toContain("bg-[color:var(--card-bg,var(--color-surface-card))]");
  });

  it("carries no padding or element, which stay the caller's", () => {
    expect(CARD_SURFACE).not.toMatch(/\bp[xy]?-\d/);
  });

  it("gives a list inside it the card's own edge for its rules, the plain border with the toggle off", () => {
    expect(CARD_LIST).toContain("divide-[color:var(--card-border,var(--color-border))]");
    // A card that holds no list gets no rule colour on its children.
    expect(CARD_SURFACE).not.toContain("divide-");
  });

  it("hovers a row in a card with the card's own tint, under the redesign only", () => {
    expect(CARD_ROW_HOVER).toBe("redesign:hover:bg-[color:var(--card-row-hover)]");
  });
});


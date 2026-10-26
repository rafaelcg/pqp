import { describe, expect, it } from "vitest";
import { CARD_SURFACE } from "@/components/ui/card";

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
});

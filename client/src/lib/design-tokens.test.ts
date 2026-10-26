import { describe, expect, it } from "vitest";
import { contrastRatio, parseColour } from "@/lib/design-tokens";

describe("parseColour", () => {
  it("reads a plain oklch value", () => {
    expect(parseColour("oklch(0.5 0.1 120)")).toEqual({
      l: 0.5,
      c: 0.1,
      h: 120,
      alpha: 1,
    });
  });

  it("mixes two stops in oklab by their weights", () => {
    const mixed = parseColour(
      "color-mix(in oklab, oklch(0.16 0.012 250) 75%, oklch(0 0 0))",
    );
    expect(mixed?.l).toBeCloseTo(0.12, 5);
    expect(mixed?.c).toBeCloseTo(0.009, 5);
  });

  it("takes the missing weight as the rest of 100%", () => {
    const a = parseColour("color-mix(in oklab, oklch(0.2 0 0) 25%, oklch(0.6 0 0))");
    const b = parseColour("color-mix(in oklab, oklch(0.2 0 0), oklch(0.6 0 0) 75%)");
    expect(a?.l).toBeCloseTo(0.5, 5);
    expect(b?.l).toBeCloseTo(0.5, 5);
  });

  it("reads a mix the browser hands back with line breaks and a nested mix", () => {
    const value = `color-mix(
    in oklab,
    color-mix(in oklab, oklch(0.4 0 0) 50%, oklch(0.2 0 0)) 50%,
    oklch(0.5 0 0)
  )`;
    expect(parseColour(value)?.l).toBeCloseTo(0.4, 5);
  });

  it("refuses a space the token layer does not mix in", () => {
    expect(parseColour("color-mix(in srgb, oklch(0.2 0 0), oklch(0.6 0 0))")).toBeNull();
  });

  it("scores contrast on a mixed background", () => {
    const ratio = contrastRatio(
      "oklch(0.95 0.006 95)",
      "color-mix(in oklab, oklch(0.32 0.06 125) 45%, oklch(0.2 0.014 262))",
    );
    expect(ratio).toBeGreaterThan(10);
  });
});

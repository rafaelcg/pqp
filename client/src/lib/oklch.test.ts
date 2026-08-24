import { describe, expect, it } from "vitest";
import { cssColorToRgb, oklchToRgb, parseOklch, rgbToHex } from "./oklch";

/**
 * Pinned against a real browser.
 *
 * Every expected value below was measured by painting the token to a 1x1
 * canvas in Chrome and reading the pixel back. That is the only check that
 * catches a transposed matrix coefficient: a wrong pipeline still produces
 * plausible-looking colours, and a hand-written expectation would just encode
 * the same mistake twice.
 */

const bytes = ({ r, g, b }: { r: number; g: number; b: number }) =>
  [r, g, b].map((c) => Math.round(c * 255));

const hex = (rgb: { r: number; g: number; b: number }) =>
  "#" + bytes(rgb).map((c) => c.toString(16).padStart(2, "0")).join("");

/**
 * Within one unit per channel of what Chrome paints.
 *
 * Not byte-exact on purpose. Three of pqp's five tokens land on precisely the
 * same bytes; two come out one unit off in a channel, because the browser
 * quantises to 8 bits with its own rounding at the end of the same pipeline.
 * That difference is invisible and outside our control, and asserting equality
 * with it would be asserting something about Chrome's rounding rather than
 * about this conversion. A transposed matrix coefficient moves a channel by
 * tens, so the tolerance still catches the bug this test is for.
 */
function expectCloseTo(actual: { r: number; g: number; b: number }, expected: string) {
  const want = [1, 3, 5].map((i) => parseInt(expected.slice(i, i + 2), 16));
  const got = bytes(actual);
  for (let i = 0; i < 3; i += 1) {
    expect(Math.abs(got[i]! - want[i]!), `channel ${i} of ${expected}`).toBeLessThanOrEqual(1);
  }
}

describe("oklchToRgb", () => {
  it("matches what Chrome paints for pqp's tokens", () => {
    // --color-surface-0, --color-surface-2, --color-accent, --color-text,
    // --color-text-muted, in that order.
    expectCloseTo(oklchToRgb({ l: 0.16, c: 0.012, h: 250 }), "#090e12");
    expectCloseTo(oklchToRgb({ l: 0.24, c: 0.016, h: 250 }), "#1b2127");
    expectCloseTo(oklchToRgb({ l: 0.88, c: 0.19, h: 125 }), "#baed4d");
    expectCloseTo(oklchToRgb({ l: 0.93, c: 0.015, h: 95 }), "#eae9dd");
    expectCloseTo(oklchToRgb({ l: 0.72, c: 0.02, h: 95 }), "#a9a497");
  });

  it("puts black at zero and white at one", () => {
    expect(hex(oklchToRgb({ l: 0, c: 0, h: 0 }))).toBe("#000000");
    expect(hex(oklchToRgb({ l: 1, c: 0, h: 0 }))).toBe("#ffffff");
  });

  it("clamps rather than wrapping when a colour is outside sRGB", () => {
    // An enormous chroma drives channels past 1 and below 0. Wrapping would
    // produce a colour from the wrong end of the scale, which is how a subtle
    // brand green becomes magenta.
    const out = oklchToRgb({ l: 0.7, c: 0.9, h: 140 });
    for (const channel of [out.r, out.g, out.b]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
  });
});

describe("parseOklch", () => {
  it("reads the plain form a stylesheet returns", () => {
    expect(parseOklch("oklch(0.88 0.19 125)")).toEqual({
      l: 0.88,
      c: 0.19,
      h: 125,
    });
  });

  it("reads percentages and ignores a trailing alpha", () => {
    expect(parseOklch("oklch(88% 0.19 125 / 0.5)")).toEqual({
      l: 0.88,
      c: 0.19,
      h: 125,
    });
  });

  it("returns null for anything else rather than throwing", () => {
    // The caller's fallback for an unknown syntax is a sensible colour, not a
    // crash on a marketing page.
    expect(parseOklch("#baed4d")).toBeNull();
    expect(parseOklch("rebeccapurple")).toBeNull();
    expect(parseOklch("")).toBeNull();
  });
});

describe("rgbToHex", () => {
  it("writes the six-digit form a colour input can take", () => {
    expect(rgbToHex(oklchToRgb({ l: 0, c: 0, h: 0 }))).toBe("#000000");
    expect(rgbToHex(oklchToRgb({ l: 1, c: 0, h: 0 }))).toBe("#ffffff");
  });
});

describe("cssColorToRgb", () => {
  it("falls back when the token is missing or in another syntax", () => {
    const fallback = { l: 0.88, c: 0.19, h: 125 };
    expectCloseTo(cssColorToRgb("", fallback), "#baed4d");
    expectCloseTo(cssColorToRgb("not a colour", fallback), "#baed4d");
  });
});

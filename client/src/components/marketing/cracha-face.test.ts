import { describe, expect, it } from "vitest";
import { withAlpha } from "./cracha-face";

/**
 * The bug this file exists for.
 *
 * The first version built translucent colours by concatenating a hex alpha onto
 * whatever the stylesheet held: `${palette.accent}44`. pqp's tokens are
 * `oklch(...)`, so that produced `oklch(0.88 0.19 125)44`, `addColorStop`
 * rejected it, and the error boundary took down the whole /garanta page. It
 * passed typecheck, passed lint, and only showed up in a real browser.
 */
describe("withAlpha", () => {
  it("adds alpha to an rgb string, which is what the browser hands back", () => {
    expect(withAlpha("rgb(201, 242, 75)", 0.27)).toBe("rgba(201, 242, 75, 0.27)");
  });

  it("handles the spaced syntax too", () => {
    expect(withAlpha("rgb(10 20 30)", 0.5)).toBe("rgba(10, 20, 30, 0.5)");
  });

  it("adds alpha to hex, which is what the defaults are", () => {
    expect(withAlpha("#c9f24b", 0)).toBe("rgba(201, 242, 75, 0)");
  });

  it("clamps out-of-range alpha rather than emitting an invalid colour", () => {
    expect(withAlpha("#000000", 5)).toBe("rgba(0, 0, 0, 1)");
    expect(withAlpha("#000000", -2)).toBe("rgba(0, 0, 0, 0)");
  });

  it("never returns something a canvas would reject", () => {
    // The actual failure mode: an unparseable colour must come back unchanged
    // and opaque, which is a worse picture and a working page. It must NOT come
    // back with characters glued to the end.
    const oklch = "oklch(0.88 0.19 125)";
    expect(withAlpha(oklch, 0.3)).toBe(oklch);
    expect(withAlpha(oklch, 0.3)).not.toMatch(/\)\S/);
  });
});

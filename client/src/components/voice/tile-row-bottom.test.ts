import { describe, expect, it } from "vitest";
import { tileRowBottom } from "./call-stage";

describe("tileRowBottom", () => {
  it("clears the higher of the letterbox band and the floating bar, not their sum", () => {
    // A 16:9 share centred in a tall theater tile: a 207px band under the
    // picture and a 72px bar floating over it. The row belongs at the
    // picture's bottom edge (207 + 8), not at 207 + 72 + 8 in the middle.
    const bottom = tileRowBottom(207);
    expect(bottom).toContain("max(207px, var(--tile-row-lift, 0px))");
    expect(bottom).not.toMatch(/207px\s*\+\s*var/);
    expect(bottom).toContain("+ 8px");
  });

  it("never leaves the tile from the top", () => {
    expect(tileRowBottom(0)).toContain("calc(100% - 2.25rem)");
  });
});

import { describe, expect, it } from "vitest";
import { lockedPostSummary } from "./posts";

describe("lockedPostSummary", () => {
  it("prefers the members teaser", () => {
    expect(
      lockedPostSummary({
        title: "Archive",
        teaser: "A glimpse of what is inside",
      }),
    ).toBe("A glimpse of what is inside");
  });

  it("falls back to the title without inventing a body", () => {
    expect(
      lockedPostSummary({
        title: "Archive",
        teaser: "   ",
      }),
    ).toBe("Archive");
  });

  it("returns null when the API supplied no public summary", () => {
    expect(
      lockedPostSummary({
        title: null,
        teaser: null,
      }),
    ).toBeNull();
  });
});

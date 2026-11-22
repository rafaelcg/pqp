import { describe, expect, it } from "vitest";
import { fieldLineHeightPx, singleLineFits } from "./composer-field";

describe("fieldLineHeightPx", () => {
  it("follows the chat list's 22/15 ratio", () => {
    expect(fieldLineHeightPx(15)).toBe(22);
    expect(fieldLineHeightPx(16)).toBe(23);
    expect(fieldLineHeightPx(24)).toBe(35);
    expect(fieldLineHeightPx(12)).toBe(18);
  });

  it("falls back when the size cannot be read", () => {
    expect(fieldLineHeightPx(Number.NaN)).toBe(20);
    expect(fieldLineHeightPx(0, 20)).toBe(20);
  });
});

describe("singleLineFits", () => {
  it("rests one line at the control height, even at 24px", () => {
    expect(singleLineFits(38, 8, 22, 40)).toBe(true);
    expect(singleLineFits(51, 8, 35, 40)).toBe(true);
  });

  it("grows for a second line", () => {
    expect(singleLineFits(60, 8, 22, 40)).toBe(false);
    expect(singleLineFits(86, 8, 35, 40)).toBe(false);
  });
});

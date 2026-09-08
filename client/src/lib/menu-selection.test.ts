import { describe, expect, it } from "vitest";
import { wrapSelection } from "./menu-selection";

describe("wrapSelection", () => {
  it("steps forward within bounds", () => {
    expect(wrapSelection(0, 1, 6)).toBe(1);
    expect(wrapSelection(2, 1, 6)).toBe(3);
  });

  it("steps backward within bounds", () => {
    expect(wrapSelection(3, -1, 6)).toBe(2);
  });

  it("wraps from the last row back to the first on the way down", () => {
    // This is the bug: arrowing down past the bottom used to leave the
    // highlighted row selected-but-invisible instead of returning to the top.
    expect(wrapSelection(5, 1, 6)).toBe(0);
  });

  it("wraps from the first row to the last on the way up", () => {
    expect(wrapSelection(0, -1, 6)).toBe(5);
  });

  it("wraps a multi-row step, as the dice grid uses for up/down", () => {
    // 8 dice, 4 columns: row 2 (indices 4-7) stepping down by 4 wraps to row 1.
    expect(wrapSelection(6, 4, 8)).toBe(2);
    expect(wrapSelection(1, -4, 8)).toBe(5);
  });

  it("returns 0 for an empty menu instead of dividing by zero", () => {
    expect(wrapSelection(0, 1, 0)).toBe(0);
    expect(wrapSelection(0, -1, 0)).toBe(0);
  });

  it("is a no-op on a single-item menu", () => {
    expect(wrapSelection(0, 1, 1)).toBe(0);
    expect(wrapSelection(0, -1, 1)).toBe(0);
  });
});

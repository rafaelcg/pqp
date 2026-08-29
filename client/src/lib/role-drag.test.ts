import { describe, expect, it } from "vitest";
import { dropIndexFromPointer, moveItem } from "./role-drag";

describe("moveItem", () => {
  it("moves an entry down the list", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });

  it("moves an entry up the list", () => {
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("returns the same list when the indexes match", () => {
    const list = ["a", "b"];
    expect(moveItem(list, 1, 1)).toBe(list);
  });
});

describe("dropIndexFromPointer", () => {
  it("picks the first slot above the first midpoint", () => {
    expect(dropIndexFromPointer(10, [20, 40, 60])).toBe(0);
  });

  it("picks the last slot below every midpoint", () => {
    expect(dropIndexFromPointer(80, [20, 40, 60])).toBe(2);
  });

  it("lands on an empty list at zero", () => {
    expect(dropIndexFromPointer(50, [])).toBe(0);
  });
});

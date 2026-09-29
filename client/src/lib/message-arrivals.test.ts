import { describe, expect, it } from "vitest";
import { splitArrivals } from "./message-arrivals";

const ME = "me";

describe("splitArrivals", () => {
  it("never counts the reader's own send as new", () => {
    const split = splitArrivals([{ authorId: ME, pending: true }], ME);
    expect(split.sentHere).toBe(true);
    expect(split.fromOthers).toEqual([]);
  });

  it("counts only other people in a mixed batch", () => {
    const other = { authorId: "them" };
    const split = splitArrivals(
      [other, { authorId: ME, pending: true }, { authorId: "them" }],
      ME,
    );
    expect(split.sentHere).toBe(true);
    expect(split.fromOthers).toHaveLength(2);
    expect(split.fromOthers[0]).toBe(other);
  });

  it("treats the reader's message from another device as neither news nor a send", () => {
    const split = splitArrivals([{ authorId: ME }], ME);
    expect(split.sentHere).toBe(false);
    expect(split.fromOthers).toEqual([]);
  });

  it("counts everything when nobody is signed in", () => {
    const split = splitArrivals([{ authorId: ME, pending: true }], null);
    expect(split.sentHere).toBe(false);
    expect(split.fromOthers).toHaveLength(1);
  });
});

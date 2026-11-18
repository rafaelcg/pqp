import { describe, expect, it } from "vitest";
import { extendUnreadTally } from "./unread-tally";

const row = (id: string, authorId = "other") => ({ message: { id, authorId } });

describe("extendUnreadTally", () => {
  it("counts others' rows from the first unread and skips your own", () => {
    const rows = [row("a"), row("b"), row("c", "me"), row("d")];
    const tally = extendUnreadTally(null, rows, [false, true, false, false], "b", "me");
    expect(tally).toMatchObject({ start: 1, count: 2, mentions: 1, scanned: 4 });
  });

  it("scans only the appended rows when the log grows at the bottom", () => {
    const rows = [row("a"), row("b"), row("c")];
    const first = extendUnreadTally(null, rows, [false, false, false], "b", "me")!;
    const grown = [...rows, row("d"), row("e")];
    // The old rows' mask entries are lies: a recount would see them, an
    // extension does not.
    const next = extendUnreadTally(first, grown, [true, true, true, true, false], "b", "me")!;
    expect(next).toMatchObject({ start: 1, count: 4, mentions: 1, scanned: 5 });
  });

  it("recounts when an older page lands above", () => {
    const rows = [row("b"), row("c")];
    const first = extendUnreadTally(null, rows, [false, false], "b", "me")!;
    const paged = [row("a"), ...rows];
    expect(extendUnreadTally(first, paged, [true, false, false], "b", "me")).toMatchObject({
      start: 1,
      count: 2,
      mentions: 0,
    });
  });

  it("recounts when a counted row was deleted or replaced", () => {
    const rows = [row("a"), row("b"), row("c")];
    const first = extendUnreadTally(null, rows, [false, false, false], "a", "me")!;
    expect(extendUnreadTally(first, [rows[0], rows[2]], [false, false], "a", "me")).toMatchObject({
      count: 2,
    });
    const edited = [rows[0], rows[1], row("c")];
    expect(extendUnreadTally(first, edited, [false, false, true], "a", "me")).toMatchObject({
      count: 3,
      mentions: 1,
    });
  });

  it("is null when the first unread is not loaded", () => {
    expect(extendUnreadTally(null, [row("a")], [false], "z", "me")).toBeNull();
  });
});

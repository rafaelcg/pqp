import { describe, expect, it } from "vitest";
import { extendUnreadTally } from "./unread-tally";

const row = (id: string, authorId = "other") => ({ message: { id, authorId } });
const input = (
  rows: ReturnType<typeof row>[],
  mentionMask: boolean[],
  firstId: string,
  changedFrom = 0,
  maskKey = "me",
) => ({ rows, mentionMask, firstId, selfId: "me", changedFrom, maskKey });

describe("extendUnreadTally", () => {
  it("counts others' rows from the first unread and skips your own", () => {
    const rows = [row("a"), row("b"), row("c", "me"), row("d")];
    expect(extendUnreadTally(null, input(rows, [false, true, false, false], "b"))).toMatchObject({
      start: 1,
      count: 2,
      mentions: 1,
      scanned: 4,
    });
  });

  it("scans only the appended rows when nothing counted was rebuilt", () => {
    const rows = [row("a"), row("b"), row("c")];
    const first = extendUnreadTally(null, input(rows, [false, false, false], "b"))!;
    const grown = [...rows, row("d"), row("e")];
    // The old rows' mask entries are lies: a recount would see them, an
    // extension does not.
    const next = extendUnreadTally(first, input(grown, [true, true, true, true, false], "b", 3))!;
    expect(next).toMatchObject({ start: 1, count: 4, mentions: 1, scanned: 5 });
  });

  it("recounts when a counted row was edited, even between unchanged ends", () => {
    const rows = [row("a"), row("b"), row("c"), row("d")];
    const first = extendUnreadTally(null, input(rows, [false, false, false, false], "a"))!;
    const edited = [rows[0], rows[1], row("c"), rows[3]];
    expect(extendUnreadTally(first, input(edited, [false, false, true, false], "a", 2))).toMatchObject({
      count: 4,
      mentions: 1,
    });
  });

  it("recounts when an older page lands above or a row is deleted", () => {
    const rows = [row("b"), row("c")];
    const first = extendUnreadTally(null, input(rows, [false, false], "b"))!;
    expect(extendUnreadTally(first, input([row("a"), ...rows], [true, false, false], "b", 0))).toMatchObject({
      start: 1,
      count: 2,
      mentions: 0,
    });
    expect(extendUnreadTally(first, input([rows[0]], [false], "b", 1))).toMatchObject({ count: 1 });
  });

  it("recounts when the viewer's names change", () => {
    const rows = [row("a"), row("b")];
    const first = extendUnreadTally(null, input(rows, [false, false], "a"))!;
    expect(extendUnreadTally(first, input(rows, [true, true], "a", 2, "renamed"))).toMatchObject({
      mentions: 2,
    });
  });

  it("is null when the first unread is not loaded", () => {
    expect(extendUnreadTally(null, input([row("a")], [false], "z"))).toBeNull();
  });
});

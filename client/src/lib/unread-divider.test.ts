import { describe, expect, it } from "vitest";
import { findFirstUnreadMessageId } from "./unread-divider";

function msg(id: string, createdAt: string) {
  return { id, createdAt };
}

describe("findFirstUnreadMessageId", () => {
  const early = "2026-08-24T12:00:00.000Z";
  const mid = "2026-08-24T12:01:00.000Z";
  const late = "2026-08-24T12:02:00.000Z";

  it("returns null without a cursor", () => {
    expect(findFirstUnreadMessageId([msg("a", late)], null)).toBeNull();
    expect(findFirstUnreadMessageId([msg("a", late)], undefined)).toBeNull();
  });

  it("skips messages at or before the cursor", () => {
    const messages = [msg("a", early), msg("b", mid), msg("c", late)];
    expect(findFirstUnreadMessageId(messages, mid)).toBe("c");
    expect(findFirstUnreadMessageId(messages, early)).toBe("b");
  });

  it("returns null when everything in the window is already read", () => {
    expect(
      findFirstUnreadMessageId([msg("a", early), msg("b", mid)], late),
    ).toBeNull();
  });

  it("ignores unparseable timestamps", () => {
    expect(findFirstUnreadMessageId([msg("a", late)], "not-a-date")).toBeNull();
    expect(
      findFirstUnreadMessageId([msg("a", "nope")], early),
    ).toBeNull();
  });
});

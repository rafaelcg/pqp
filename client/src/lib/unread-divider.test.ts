import { describe, expect, it } from "vitest";
import { findFirstUnreadMessageId } from "./unread-divider";

function msg(id: string, createdAt: string, authorId = "other") {
  return { id, createdAt, authorId };
}

describe("findFirstUnreadMessageId", () => {
  const early = "2026-08-24T12:00:00.000Z";
  const mid = "2026-08-24T12:01:00.000Z";
  const late = "2026-08-24T12:02:00.000Z";

  it("returns null without a cursor", () => {
    expect(findFirstUnreadMessageId([msg("a", late)], null, "me")).toBeNull();
    expect(findFirstUnreadMessageId([msg("a", late)], undefined, "me")).toBeNull();
  });

  it("skips messages at or before the cursor", () => {
    const messages = [msg("a", early), msg("b", mid), msg("c", late)];
    expect(findFirstUnreadMessageId(messages, mid, "me")).toBe("c");
    expect(findFirstUnreadMessageId(messages, early, "me")).toBe("b");
  });

  it("returns null when everything in the window is already read", () => {
    expect(
      findFirstUnreadMessageId([msg("a", early), msg("b", mid)], late, "me"),
    ).toBeNull();
  });

  it("ignores unparseable timestamps", () => {
    expect(findFirstUnreadMessageId([msg("a", late)], "not-a-date", "me")).toBeNull();
    expect(
      findFirstUnreadMessageId([msg("a", "nope")], early, "me"),
    ).toBeNull();
  });

  it("never puts the rule above the viewer's own messages", () => {
    const messages = [
      msg("a", early, "other"),
      msg("b", mid, "me"),
      msg("c", late, "me"),
    ];
    expect(findFirstUnreadMessageId(messages, early, "me")).toBeNull();
  });

  it("puts the rule on the first message from somebody else", () => {
    const later = "2026-08-24T12:03:00.000Z";
    const messages = [
      msg("a", early, "other"),
      msg("b", mid, "me"),
      msg("c", late, "other"),
      msg("d", later, "me"),
    ];
    expect(findFirstUnreadMessageId(messages, early, "me")).toBe("c");
  });

  it("counts every author when the viewer is unknown", () => {
    expect(
      findFirstUnreadMessageId([msg("a", late, "me")], early, null),
    ).toBe("a");
  });
});

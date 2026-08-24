import { describe, expect, it } from "vitest";
import { findLastOwnEditableMessage } from "./edit-last-message";

describe("findLastOwnEditableMessage", () => {
  const mine = { id: "a", authorId: "me" };
  const other = { id: "b", authorId: "them" };

  it("returns the newest own stored message", () => {
    expect(
      findLastOwnEditableMessage(
        [mine, other, { id: "c", authorId: "me" }],
        "me",
      )?.id,
    ).toBe("c");
  });

  it("skips pending, failed, and webhook rows", () => {
    expect(
      findLastOwnEditableMessage(
        [
          mine,
          { id: "p", authorId: "me", pending: true },
          { id: "f", authorId: "me", failed: true },
          { id: "w", authorId: "me", isWebhook: true },
        ],
        "me",
      )?.id,
    ).toBe("a");
  });

  it("returns null when there is nothing to edit", () => {
    expect(findLastOwnEditableMessage([other], "me")).toBeNull();
    expect(findLastOwnEditableMessage([mine], null)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { MessageSearchResult } from "@pqp/shared";
import { appendUniqueResults, clampSelection } from "./search-results";

function result(messageId: string): MessageSearchResult {
  return {
    messageId,
    channelId: "00000000-0000-4000-8000-000000000001",
    channelName: "general",
    authorId: "00000000-0000-4000-8000-000000000002",
    authorName: "Owner",
    authorTag: null,
    authorAvatarUrl: null,
    snippet: "hit",
    createdAt: "2026-07-31T12:00:00.000Z",
  };
}

describe("appendUniqueResults", () => {
  it("appends a page in order", () => {
    const merged = appendUniqueResults(
      [result("a"), result("b")],
      [result("c")],
    );
    expect(merged.map((r) => r.messageId)).toEqual(["a", "b", "c"]);
  });

  it("drops a message already on screen, including within one page", () => {
    const merged = appendUniqueResults(
      [result("a")],
      [result("a"), result("b"), result("b")],
    );
    expect(merged.map((r) => r.messageId)).toEqual(["a", "b"]);
  });
});

describe("clampSelection", () => {
  it("stops at both ends instead of wrapping", () => {
    expect(clampSelection(0, -1, 3)).toBe(0);
    expect(clampSelection(2, 1, 3)).toBe(2);
    expect(clampSelection(0, 1, 3)).toBe(1);
  });

  it("stays at zero with nothing to select", () => {
    expect(clampSelection(0, 1, 0)).toBe(0);
  });
});

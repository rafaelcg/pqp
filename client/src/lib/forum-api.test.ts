import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { forumListQuery, readForumPublishError } from "./forum-api";
import { DEFAULT_FORUM_FILTERS } from "./forum-list";

const TAG_A = "00000000-0000-4000-8000-00000000000a";
const TAG_B = "00000000-0000-4000-8000-00000000000b";

describe("forumListQuery", () => {
  it("repeats tag for AND and leaves out what is not set", () => {
    const query = new URLSearchParams(
      forumListQuery(
        { ...DEFAULT_FORUM_FILTERS, tagIds: [TAG_A, TAG_B], status: "open", mine: true, q: "  steam deck " },
        "c1",
      ),
    );
    expect(query.getAll("tag")).toEqual([TAG_A, TAG_B]);
    expect(query.get("status")).toBe("open");
    expect(query.get("mine")).toBe("true");
    expect(query.get("q")).toBe("steam deck");
    expect(query.get("cursor")).toBe("c1");
    expect(query.get("sort")).toBe("activity");

    const bare = new URLSearchParams(forumListQuery(DEFAULT_FORUM_FILTERS, null));
    expect([...bare.keys()]).toEqual(["sort"]);
  });
});

describe("readForumPublishError", () => {
  const rejected = (body: Record<string, unknown>, status = 422) =>
    new ApiError(status, String(body.error ?? "x"), null, body);

  it("reads the message-path refusals the composer has copy for", () => {
    expect(
      readForumPublishError(
        rejected({ error: "forum_post_rejected", reason: "slow-mode", retryAfterMs: 42_000 }),
      ),
    ).toEqual({ kind: "slow-mode", retryAfterMs: 42_000 });
    expect(
      readForumPublishError(
        rejected({ error: "forum_post_rejected", reason: "automod", automodMessage: "Sem convite." }),
      ),
    ).toEqual({ kind: "automod", field: null, message: "Sem convite." });
    expect(
      readForumPublishError(
        rejected({ error: "forum_post_rejected", reason: "automod", field: "title" }),
      ),
    ).toEqual({ kind: "automod", field: "title", message: null });
    expect(
      readForumPublishError(
        rejected({ error: "forum_post_rejected", reason: "rate-limited", retryAfterMs: 300_000 }),
      ),
    ).toEqual({ kind: "rate-limited", retryAfterMs: 300_000 });
  });

  it("reads the forum's own refusals", () => {
    expect(readForumPublishError(rejected({ error: "forum_tag_required" }))).toEqual({
      kind: "tag-required",
    });
    expect(readForumPublishError(rejected({ error: "forum_channels_off" }, 403))).toEqual({
      kind: "paused",
    });
  });

  it("falls back to a generic failure, keeping the draft", () => {
    expect(readForumPublishError(new ApiError(403, "You cannot post in this forum"))).toEqual({
      kind: "cannot-send",
    });
    expect(readForumPublishError(new Error("network"))).toEqual({ kind: "failed" });
    expect(readForumPublishError(new ApiError(500, "boom"))).toEqual({ kind: "failed" });
  });
});

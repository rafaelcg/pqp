import { describe, expect, it } from "vitest";
import { channelTypeSchema, MESSAGE_MAX_LENGTH } from "./api.js";
import { AUDIT_ACTIONS } from "./audit.js";
import {
  CHAT_SERVER_MESSAGE_TYPES,
  chatServerMessageSchema,
  forumPostRejectedBodySchema,
  isChatServerMessage,
  messageRejectReasonSchema,
} from "./chat.js";
import {
  createForumPostSchema,
  FORUM_BODY_MAX,
  FORUM_MAX_TAGS,
  FORUM_MAX_TAGS_PER_POST,
  FORUM_SETTINGS_DEFAULTS,
  FORUM_TITLE_MAX,
  forumPostDetailResponseSchema,
  forumPostListResponseSchema,
  forumPostSummarySchema,
  forumSettingsSchema,
  forumTagNameKey,
  listForumPostsQuerySchema,
  putForumTagsSchema,
  updateForumPostSchema,
  updateForumSettingsSchema,
  webhookForumSettingsSchema,
  type ForumPostSummary,
} from "./forums.js";
import { searchResultSchema } from "./search.js";
import { executeWebhookSchema } from "./webhooks.js";

const FORUM = "11111111-1111-4111-8111-111111111111";
const POST = "22222222-2222-4222-8222-222222222222";
const TAG_A = "33333333-3333-4333-8333-333333333333";
const TAG_B = "44444444-4444-4444-8444-444444444444";

const SUMMARY: ForumPostSummary = {
  id: POST,
  forumId: FORUM,
  title: "Notebook não liga",
  authorId: null,
  authorName: null,
  authorAvatarUrl: null,
  authorIsWebhook: false,
  createdAt: "2026-10-11T12:00:00.000Z",
  lastActivityAt: "2026-10-11T13:00:00.000Z",
  pinnedAt: null,
  lockedAt: null,
  resolvedAt: "2026-10-11T13:00:00.000Z",
  acceptedAnswerId: TAG_A,
  preview: "socorro",
  openingDeleted: false,
  openingKind: "text",
  attachmentCount: 0,
  replyCount: 3,
  reactionCount: 2,
  topReaction: { emoji: "👍", count: 2 },
  thumbnailUrl: null,
  thumbnailAttachmentId: null,
  thumbnailWidth: null,
  thumbnailHeight: null,
  thumbnailVideoUrl: null,
  tagIds: [TAG_A],
};

describe("forum contract", () => {
  it("adds forum to the channel types", () => {
    expect(channelTypeSchema.options).toContain("forum");
  });

  it("restates the message length it may not import", () => {
    expect(FORUM_BODY_MAX).toBe(MESSAGE_MAX_LENGTH);
  });

  it("both frames are chat frames AND relayable to a channel", () => {
    // Relayable is the half that is easy to forget: without it the cluster
    // relay drops a post made on the sibling instance on the floor.
    const upsert = { type: "forum-post-upsert", forumId: FORUM, post: SUMMARY };
    const removed = { type: "forum-post-removed", forumId: FORUM, postId: POST };
    expect(chatServerMessageSchema.safeParse(upsert).success).toBe(true);
    expect(chatServerMessageSchema.safeParse(removed).success).toBe(true);
    expect(CHAT_SERVER_MESSAGE_TYPES).toContain("forum-post-upsert");
    expect(CHAT_SERVER_MESSAGE_TYPES).toContain("forum-post-removed");
    expect(isChatServerMessage(upsert)).toBe(true);
    expect(isChatServerMessage(removed)).toBe(true);
  });

  it("does not reject a summary from a newer server that carries more tags", () => {
    const many = { ...SUMMARY, tagIds: Array.from({ length: 9 }, () => TAG_A) };
    expect(forumPostSummarySchema.safeParse(many).success).toBe(true);
  });

  it("knows the locked refusal and the 422 body a refused create answers", () => {
    expect(messageRejectReasonSchema.options).toContain("locked");
    expect(
      forumPostRejectedBodySchema.parse({
        error: "forum_post_rejected",
        reason: "slow-mode",
        retryAfterMs: 5000,
      }).retryAfterMs,
    ).toBe(5000);
  });

  it("names an audit action for every staff forum action", () => {
    for (const action of [
      "forum.post_pin",
      "forum.post_lock",
      "forum.post_delete",
      "forum.post_edit",
      "forum.tags_update",
      "forum.settings_update",
      "webhook.forum_settings",
    ]) {
      expect(AUDIT_ACTIONS).toContain(action);
    }
  });

  it("lets search name a hit's parent, and still parses a result without one", () => {
    const base = {
      messageId: POST,
      channelId: POST,
      channelName: "x",
      authorId: FORUM,
      authorName: "Ana",
      authorTag: null,
      authorAvatarUrl: null,
      snippet: "",
      createdAt: "2026-10-11T12:00:00.000Z",
    };
    expect(searchResultSchema.parse(base).parentChannelId).toBeUndefined();
    expect(searchResultSchema.parse({ ...base, parentChannelId: FORUM }).parentChannelId).toBe(
      FORUM,
    );
  });
});

describe("list query", () => {
  it("reads one tag or several as a list (AND), and absent sort as the forum's default", () => {
    expect(listForumPostsQuerySchema.parse({ tag: TAG_A }).tag).toEqual([TAG_A]);
    expect(listForumPostsQuerySchema.parse({ tag: [TAG_A, TAG_B] }).tag).toEqual([TAG_A, TAG_B]);
    expect(listForumPostsQuerySchema.parse({}).sort).toBeUndefined();
  });

  it("reads query-string booleans and numbers", () => {
    const parsed = listForumPostsQuerySchema.parse({ mine: "true", limit: "10", q: "  nao liga " });
    expect(parsed).toMatchObject({ mine: true, limit: 10, q: "nao liga" });
    expect(listForumPostsQuerySchema.parse({ mine: "false" }).mine).toBe(false);
  });

  it("refuses more tags than a post can carry, a page too big and an empty search", () => {
    const six = Array.from({ length: FORUM_MAX_TAGS_PER_POST + 1 }, (_, i) =>
      `${i}${TAG_A.slice(1)}`,
    );
    expect(listForumPostsQuerySchema.safeParse({ tag: six }).success).toBe(false);
    expect(listForumPostsQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(listForumPostsQuerySchema.safeParse({ q: "   " }).success).toBe(false);
  });

  it("the list answer carries pinned, viewer halves and counts", () => {
    const parsed = forumPostListResponseSchema.parse({
      pinned: [],
      posts: [SUMMARY],
      viewer: [{ postId: POST, lastReadAt: null, newReplyCount: 0, following: false }],
      nextCursor: null,
      forumPreviousReadAt: null,
      counts: { posts: 1, open: 0 },
    });
    expect(parsed.viewer[0]!.newReplyCount).toBe(0);
  });

  it("the detail answer can say a marked answer was deleted", () => {
    const parsed = forumPostDetailResponseSchema.parse({
      post: SUMMARY,
      viewer: { postId: POST, lastReadAt: null, newReplyCount: 0, following: true },
      acceptedAnswer: {
        messageId: TAG_A,
        deleted: true,
        authorId: null,
        authorName: null,
        excerpt: null,
        createdAt: null,
      },
      participantCount: 2,
    });
    expect(parsed.acceptedAnswer?.deleted).toBe(true);
  });
});

describe("writes", () => {
  it("a post needs a title, and text or a file", () => {
    expect(createForumPostSchema.safeParse({ title: "x", body: "oi", nonce: "n" }).success).toBe(
      true,
    );
    expect(
      createForumPostSchema.safeParse({ title: "x", body: "", attachmentIds: [POST], nonce: "n" })
        .success,
    ).toBe(true);
    expect(createForumPostSchema.safeParse({ title: "x", body: "  ", nonce: "n" }).success).toBe(
      false,
    );
    expect(createForumPostSchema.safeParse({ title: "   ", body: "oi", nonce: "n" }).success).toBe(
      false,
    );
    expect(
      createForumPostSchema.safeParse({
        title: "x".repeat(FORUM_TITLE_MAX + 1),
        body: "oi",
        nonce: "n",
      }).success,
    ).toBe(false);
  });

  it("flattens a title to one trimmed line", () => {
    expect(
      createForumPostSchema.parse({ title: "  Notebook\nnão   liga ", body: "oi", nonce: "n" })
        .title,
    ).toBe("Notebook não liga");
  });

  it("a patch must change something, and may clear the accepted answer", () => {
    expect(updateForumPostSchema.safeParse({}).success).toBe(false);
    expect(updateForumPostSchema.parse({ acceptedAnswerId: null }).acceptedAnswerId).toBeNull();
    expect(updateForumPostSchema.safeParse({ tagIds: [TAG_A, TAG_A] }).success).toBe(false);
  });

  it("tags: at most 20, names unique across case, accents and spaces", () => {
    expect(
      putForumTagsSchema.safeParse({
        tags: [
          { name: "Bug", moderated: false },
          { name: "bug", moderated: false },
        ],
      }).success,
    ).toBe(false);
    expect(
      putForumTagsSchema.safeParse({
        tags: [
          { name: "Dúvida", moderated: false },
          { name: "duvida", moderated: false },
        ],
      }).success,
    ).toBe(false);
    expect(forumTagNameKey("  Dúvida   Rápida ")).toBe(forumTagNameKey("duvida rapida"));
    expect(forumTagNameKey("Bug")).not.toBe(forumTagNameKey("Bugs"));
    expect(
      putForumTagsSchema.safeParse({
        tags: Array.from({ length: FORUM_MAX_TAGS + 1 }, (_, i) => ({
          name: `t${i}`,
          moderated: false,
        })),
      }).success,
    ).toBe(false);
  });

  it("settings default to activity with no required tag, and a patch must name one", () => {
    expect(forumSettingsSchema.parse(FORUM_SETTINGS_DEFAULTS)).toEqual({
      requireTag: false,
      defaultSort: "activity",
    });
    expect(updateForumSettingsSchema.safeParse({}).success).toBe(false);
    expect(updateForumSettingsSchema.safeParse({ defaultSort: "hot" }).success).toBe(false);
  });

  it("a webhook's dedupe window stays within 0 to 720 hours", () => {
    const ok = { allowedTagIds: null, defaultTagIds: [], dedupeWindowHours: 0 };
    expect(webhookForumSettingsSchema.safeParse(ok).success).toBe(true);
    expect(
      webhookForumSettingsSchema.safeParse({ ...ok, dedupeWindowHours: 721 }).success,
    ).toBe(false);
  });
});

describe("webhook execute stays as lenient as it was", () => {
  // Discord's forum fields were silently stripped before they were declared.
  // A payload that is fine for a text channel today must stay fine.
  it("accepts thread_name and applied_tags in any shape a Discord tool sends", () => {
    for (const extra of [
      { thread_name: "Notícia" },
      { thread_name: "" },
      { thread_name: "x".repeat(300) },
      { thread_name: null },
      { applied_tags: ["123456789012345678", "Notícias"] },
      { applied_tags: [42, 7] },
      { applied_tags: null },
    ]) {
      expect(executeWebhookSchema.safeParse({ content: "oi", ...extra }).success, JSON.stringify(extra)).toBe(
        true,
      );
    }
  });
});

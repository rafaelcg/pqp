import { describe, expect, it, vi } from "vitest";
import type { ForumPostSummary, ThreadSummary } from "@pqp/shared";
import { resolveRoutedThread } from "./forum-route";

const FORUM = "f0000000-0000-4000-8000-000000000000";
const POST = "p0000000-0000-4000-8000-000000000000";
const TEXT = "c0000000-0000-4000-8000-000000000000";
const THREAD = "t0000000-0000-4000-8000-000000000000";

const post: ForumPostSummary = {
  id: POST,
  forumId: FORUM,
  title: "Notebook não liga",
  authorId: null,
  authorName: null,
  authorAvatarUrl: null,
  authorIsWebhook: false,
  createdAt: "2026-10-10T10:00:00.000Z",
  lastActivityAt: "2026-10-11T10:00:00.000Z",
  pinnedAt: null,
  lockedAt: null,
  resolvedAt: null,
  acceptedAnswerId: null,
  preview: "Já tentei tudo",
  openingDeleted: false,
  openingKind: "text",
  attachmentCount: 0,
  replyCount: 4,
  reactionCount: 0,
  topReaction: null,
  thumbnailUrl: null,
  thumbnailAttachmentId: null,
  thumbnailWidth: null,
  thumbnailHeight: null,
  tagIds: [],
};

const thread: ThreadSummary = {
  channelId: THREAD,
  parentChannelId: TEXT,
  rootMessageId: "m0000000-0000-4000-8000-000000000000",
  name: "sobre o patch",
  replyCount: 2,
  lastActivityAt: "2026-10-11T10:00:00.000Z",
  archived: false,
  participants: [],
};

const notFound = () => Promise.reject(Object.assign(new Error("Not found"), { status: 404 }));
const down = () => Promise.reject(Object.assign(new Error("Bad gateway"), { status: 502 }));

describe("resolveRoutedThread", () => {
  it("opens a post over its forum", async () => {
    await expect(
      resolveRoutedThread(POST, {
        listedChannelIds: new Set([FORUM, TEXT]),
        fetchPost: async () => ({ post }),
        fetchThreads: async () => ({ threads: {} }),
      }),
    ).resolves.toEqual({ kind: "forum-post", forumId: FORUM, post });
  });

  it("falls through to a chat thread when the id is not a post (the old dead link)", async () => {
    await expect(
      resolveRoutedThread(THREAD, {
        listedChannelIds: new Set([FORUM, TEXT]),
        fetchPost: notFound,
        fetchThreads: async () => ({ threads: { [TEXT]: [thread] } }),
      }),
    ).resolves.toEqual({ kind: "thread", thread });
  });

  it("opens a thread the sidebar already holds without a single request", async () => {
    const fetchPost = vi.fn();
    const fetchThreads = vi.fn();
    await expect(
      resolveRoutedThread(THREAD, {
        listedChannelIds: new Set([TEXT]),
        heldThreads: { [TEXT]: [thread] },
        fetchPost,
        fetchThreads,
      }),
    ).resolves.toEqual({ kind: "thread", thread });
    expect(fetchPost).not.toHaveBeenCalled();
    expect(fetchThreads).not.toHaveBeenCalled();
  });

  it("opens a post with one request, never asking for the thread list", async () => {
    const fetchThreads = vi.fn();
    await expect(
      resolveRoutedThread(POST, {
        listedChannelIds: new Set([FORUM]),
        fetchPost: async () => ({ post }),
        fetchThreads,
      }),
    ).resolves.toEqual({ kind: "forum-post", forumId: FORUM, post });
    expect(fetchThreads).not.toHaveBeenCalled();
  });

  it("does not open a post whose forum this viewer cannot list", async () => {
    await expect(
      resolveRoutedThread(POST, {
        listedChannelIds: new Set([TEXT]),
        fetchPost: async () => ({ post }),
        fetchThreads: async () => ({ threads: {} }),
      }),
    ).resolves.toBeNull();
  });

  it("is null when the post lookup says not found or forbidden and no thread matches", async () => {
    for (const status of [404, 403]) {
      await expect(
        resolveRoutedThread(THREAD, {
          listedChannelIds: new Set([TEXT]),
          fetchPost: () => Promise.reject(Object.assign(new Error("no"), { status })),
          fetchThreads: async () => ({ threads: {} }),
        }),
      ).resolves.toBeNull();
    }
  });

  it("throws, rather than calling it missing, when a lookup failed for another reason", async () => {
    await expect(
      resolveRoutedThread(POST, {
        listedChannelIds: new Set([FORUM]),
        fetchPost: down,
        fetchThreads: async () => ({ threads: {} }),
      }),
    ).rejects.toThrow("Bad gateway");
    await expect(
      resolveRoutedThread(THREAD, {
        listedChannelIds: new Set([TEXT]),
        fetchPost: notFound,
        fetchThreads: () => Promise.reject(new Error("down")),
      }),
    ).rejects.toThrow("down");
  });

  it("still finds a thread when only the post lookup failed", async () => {
    await expect(
      resolveRoutedThread(THREAD, {
        listedChannelIds: new Set([TEXT]),
        fetchPost: down,
        fetchThreads: async () => ({ threads: { [TEXT]: [thread] } }),
      }),
    ).resolves.toEqual({ kind: "thread", thread });
  });
});


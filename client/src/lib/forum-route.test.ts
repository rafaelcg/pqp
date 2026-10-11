import { describe, expect, it, vi } from "vitest";
import type { ForumPostSummary, ThreadSummary } from "@pqp/shared";
import {
  applyForumFrameToOpenPost,
  resolveRoutedThread,
  threadSummaryForPost,
} from "./forum-route";

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

describe("resolveRoutedThread", () => {
  it("opens a post over its forum, without asking about threads", async () => {
    const fetchThreads = vi.fn();
    await expect(
      resolveRoutedThread(POST, {
        listedChannelIds: new Set([FORUM, TEXT]),
        fetchPost: async () => ({ post }),
        fetchThreads,
      }),
    ).resolves.toEqual({ kind: "forum-post", forumId: FORUM, post });
    expect(fetchThreads).not.toHaveBeenCalled();
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

  it("does not open a post whose forum this viewer cannot list", async () => {
    await expect(
      resolveRoutedThread(POST, {
        listedChannelIds: new Set([TEXT]),
        fetchPost: async () => ({ post }),
        fetchThreads: async () => ({ threads: {} }),
      }),
    ).resolves.toBeNull();
  });

  it("is null, never a throw, when every lookup fails", async () => {
    await expect(
      resolveRoutedThread(THREAD, {
        listedChannelIds: new Set([TEXT]),
        fetchPost: notFound,
        fetchThreads: () => Promise.reject(new Error("down")),
      }),
    ).resolves.toBeNull();
  });
});

describe("applyForumFrameToOpenPost", () => {
  const open = {
    thread: threadSummaryForPost(post),
    origin: null,
    forumPost: { post, removed: false },
  };

  it("follows a retitle of the open post into the panel's header", () => {
    const next = applyForumFrameToOpenPost(open, {
      type: "forum-post-upsert",
      forumId: FORUM,
      post: { ...post, title: "Notebook não liga (resolvido)", replyCount: 5 },
    });
    expect(next?.thread.name).toBe("Notebook não liga (resolvido)");
    expect(next?.thread.replyCount).toBe(5);
    expect(next?.forumPost?.post.replyCount).toBe(5);
  });

  it("marks the open post removed instead of closing it", () => {
    const next = applyForumFrameToOpenPost(open, {
      type: "forum-post-removed",
      forumId: FORUM,
      postId: POST,
    });
    expect(next?.forumPost?.removed).toBe(true);
  });

  it("returns the same object for another post or a chat thread", () => {
    const other = { ...post, id: "o0000000-0000-4000-8000-000000000000" };
    expect(
      applyForumFrameToOpenPost(open, { type: "forum-post-upsert", forumId: FORUM, post: other }),
    ).toBe(open);
    const chat = { thread, origin: null };
    expect(
      applyForumFrameToOpenPost(chat, { type: "forum-post-removed", forumId: FORUM, postId: POST }),
    ).toBe(chat);
    expect(applyForumFrameToOpenPost(null, { type: "forum-post-removed", forumId: FORUM, postId: POST })).toBeNull();
  });
});

describe("threadSummaryForPost", () => {
  it("is a rootless, never-archived thread under the forum, named by the title", () => {
    expect(threadSummaryForPost(post)).toEqual({
      channelId: POST,
      parentChannelId: FORUM,
      rootMessageId: null,
      name: "Notebook não liga",
      replyCount: 4,
      lastActivityAt: post.lastActivityAt,
      archived: false,
      participants: [],
    });
  });
});

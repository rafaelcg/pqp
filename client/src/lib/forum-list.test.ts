import { describe, expect, it } from "vitest";
import type { ForumPostListResponse, ForumPostSummary } from "@pqp/shared";
import {
  DEFAULT_FORUM_FILTERS,
  appendForumPage,
  applyForumRemoved,
  applyForumUpsert,
  flushForumQueue,
  forumListFromPage,
  forumUnreadState,
  markForumPostRead,
  passesForumFilters,
  refreshForumFirstPage,
  titleMatchesQuery,
  type ForumFilters,
} from "./forum-list";

const FORUM = "00000000-0000-4000-8000-0000000000f0";
const ME = "00000000-0000-4000-8000-0000000000a1";
const BOB = "00000000-0000-4000-8000-0000000000b0";
const TAG_BUG = "00000000-0000-4000-8000-00000000000b";
const TAG_GAMES = "00000000-0000-4000-8000-00000000000c";

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function at(minute: number): string {
  return new Date(Date.UTC(2026, 9, 11, 12, minute)).toISOString();
}

function post(n: number, over: Partial<ForumPostSummary> = {}): ForumPostSummary {
  return {
    id: id(n),
    forumId: FORUM,
    title: `Post ${n}`,
    authorId: BOB,
    authorName: "bob",
    authorAvatarUrl: null,
    authorIsWebhook: false,
    createdAt: at(n),
    lastActivityAt: at(n),
    pinnedAt: null,
    lockedAt: null,
    resolvedAt: null,
    acceptedAnswerId: null,
    preview: "hello",
    openingDeleted: false,
    openingKind: "text",
    attachmentCount: 0,
    replyCount: 0,
    reactionCount: 0,
    topReaction: null,
    thumbnailUrl: null,
    thumbnailAttachmentId: null,
    thumbnailWidth: null,
    thumbnailHeight: null,
    thumbnailVideoUrl: null,
    tagIds: [],
    ...over,
  };
}

function page(
  posts: ForumPostSummary[],
  over: Partial<ForumPostListResponse> = {},
): ForumPostListResponse {
  return {
    pinned: [],
    posts,
    viewer: posts.map((one) => ({
      postId: one.id,
      lastReadAt: null,
      newReplyCount: 0,
      following: false,
    })),
    nextCursor: null,
    forumPreviousReadAt: null,
    counts: { posts: posts.length, open: posts.length },
    ...over,
  };
}

const activity: ForumFilters = { ...DEFAULT_FORUM_FILTERS, sort: "activity" };
const created: ForumFilters = { ...DEFAULT_FORUM_FILTERS, sort: "created" };

function order(state: { posts: ForumPostSummary[] }): string[] {
  return state.posts.map((one) => one.title);
}

describe("forum list reducer", () => {
  // Newest activity first: 3, 2, 1.
  const base = forumListFromPage(page([post(3), post(2), post(1)]));

  it("moves a bumped post to the top under activity sort when not held", () => {
    const bumped = post(1, { lastActivityAt: at(30), replyCount: 1 });
    const next = applyForumUpsert(base, bumped, {
      filters: activity,
      viewerId: ME,
      hold: false,
    });
    expect(order(next)).toEqual(["Post 1", "Post 3", "Post 2"]);
    expect(next.queued).toEqual([]);
  });

  it("never moves a bumped post under created sort", () => {
    const bumped = post(1, { lastActivityAt: at(30), replyCount: 1 });
    const next = applyForumUpsert(base, bumped, {
      filters: created,
      viewerId: ME,
      hold: false,
    });
    expect(order(next)).toEqual(["Post 3", "Post 2", "Post 1"]);
    expect(next.posts[2].replyCount).toBe(1);
  });

  it("queues the move while the reader is busy, but updates the words in place", () => {
    const bumped = post(1, {
      lastActivityAt: at(30),
      replyCount: 1,
      title: "Post 1 (edited)",
    });
    const held = applyForumUpsert(base, bumped, {
      filters: activity,
      viewerId: ME,
      hold: true,
    });
    expect(order(held)).toEqual(["Post 3", "Post 2", "Post 1 (edited)"]);
    expect(held.queued.map((one) => one.id)).toEqual([id(1)]);

    const flushed = flushForumQueue(held, { filters: activity, viewerId: ME });
    expect(order(flushed)).toEqual(["Post 1 (edited)", "Post 3", "Post 2"]);
    expect(flushed.queued).toEqual([]);
  });

  it("does not move a bump that no longer passes the filters", () => {
    const filters: ForumFilters = { ...activity, status: "open" };
    const resolvedBump = post(1, {
      lastActivityAt: at(30),
      replyCount: 1,
      resolvedAt: at(30),
    });
    const free = applyForumUpsert(base, resolvedBump, {
      filters,
      viewerId: ME,
      hold: false,
    });
    expect(order(free)).toEqual(["Post 3", "Post 2"]);

    const held = applyForumUpsert(base, resolvedBump, {
      filters,
      viewerId: ME,
      hold: true,
    });
    // Under the reader's hand it stays, updated, and nothing is queued.
    expect(order(held)).toEqual(["Post 3", "Post 2", "Post 1"]);
    expect(held.queued).toEqual([]);
  });

  it("inserts a new post that passes the filters on top, or queues it", () => {
    const fresh = post(40);
    const free = applyForumUpsert(base, fresh, {
      filters: activity,
      viewerId: ME,
      hold: false,
    });
    expect(order(free)[0]).toBe("Post 40");
    expect(free.counts).toEqual({ posts: 4, open: 4 });

    const held = applyForumUpsert(base, fresh, {
      filters: activity,
      viewerId: ME,
      hold: true,
    });
    expect(order(held)).toEqual(["Post 3", "Post 2", "Post 1"]);
    expect(held.queued.map((one) => one.title)).toEqual(["Post 40"]);
    expect(held.counts).toEqual({ posts: 4, open: 4 });

    // Applying the queue is not a second arrival.
    const flushed = flushForumQueue(held, { filters: activity, viewerId: ME });
    expect(order(flushed)[0]).toBe("Post 40");
    expect(flushed.counts).toEqual({ posts: 4, open: 4 });
  });

  it("drops a new post that fails the AND tag filter", () => {
    const filters: ForumFilters = { ...activity, tagIds: [TAG_BUG, TAG_GAMES] };
    const onlyBug = post(40, { tagIds: [TAG_BUG] });
    const next = applyForumUpsert(base, onlyBug, {
      filters,
      viewerId: ME,
      hold: false,
    });
    expect(next.posts.some((one) => one.id === onlyBug.id)).toBe(false);
    const both = post(41, { tagIds: [TAG_GAMES, TAG_BUG] });
    const after = applyForumUpsert(base, both, {
      filters,
      viewerId: ME,
      hold: false,
    });
    expect(after.posts[0].id).toBe(both.id);
  });

  it("ignores an old post bumped from beyond the loaded pages until paging reaches it", () => {
    const partial = forumListFromPage(
      page([post(30), post(20)], { nextCursor: "c1" }),
    );
    const oldEdit = post(5, { title: "renamed" });
    const next = applyForumUpsert(partial, oldEdit, {
      filters: activity,
      viewerId: ME,
      hold: true,
    });
    expect(next.queued).toEqual([]);
    expect(order(next)).toEqual(["Post 30", "Post 20"]);
  });

  it("keeps pinned posts above every filter, and moves posts in and out of pins", () => {
    const filters: ForumFilters = { ...activity, status: "resolved" };
    const pinnedOpen = post(2, { pinnedAt: at(50) });
    const next = applyForumUpsert(base, pinnedOpen, {
      filters,
      viewerId: ME,
      hold: false,
    });
    expect(next.pinned.map((one) => one.id)).toEqual([id(2)]);
    expect(next.posts.some((one) => one.id === id(2))).toBe(false);

    const unpinned = applyForumUpsert(
      next,
      post(2),
      { filters: activity, viewerId: ME, hold: false },
    );
    expect(unpinned.pinned).toEqual([]);
  });

  it("hides pins under a search", () => {
    const filters: ForumFilters = { ...activity, q: "post" };
    const next = applyForumUpsert(base, post(2, { pinnedAt: at(50) }), {
      filters,
      viewerId: ME,
      hold: false,
    });
    expect(next.pinned).toEqual([]);
  });

  it("removes a post everywhere and adjusts the counts", () => {
    const held = applyForumUpsert(base, post(40), {
      filters: activity,
      viewerId: ME,
      hold: true,
    });
    const removedQueued = applyForumRemoved(held, id(40));
    expect(removedQueued.queued).toEqual([]);

    const removed = applyForumRemoved(base, id(2));
    expect(order(removed)).toEqual(["Post 3", "Post 1"]);
    expect(removed.counts).toEqual({ posts: 2, open: 2 });
    expect(applyForumRemoved(base, id(99))).toBe(base);
  });

  it("removing a post still behind the pill lowers the pill and the counts", () => {
    const held = applyForumUpsert(base, post(40), {
      filters: activity,
      viewerId: ME,
      hold: true,
    });
    const twoQueued = applyForumUpsert(held, post(41), {
      filters: activity,
      viewerId: ME,
      hold: true,
    });
    expect(twoQueued.queued).toHaveLength(2);
    expect(twoQueued.counts).toEqual({ posts: 5, open: 5 });

    const removed = applyForumRemoved(twoQueued, id(40));
    expect(removed.queued.map((one) => one.id)).toEqual([id(41)]);
    expect(removed.counts).toEqual({ posts: 4, open: 4 });
    // Applying what is left is one arrival, not two.
    const flushed = flushForumQueue(removed, { filters: activity, viewerId: ME });
    expect(order(flushed)).toEqual(["Post 41", "Post 3", "Post 2", "Post 1"]);
    expect(flushed.counts).toEqual({ posts: 4, open: 4 });
  });

  it("dedupes a later page", () => {
    const partial = forumListFromPage(page([post(3), post(2)], { nextCursor: "c" }));
    const next = appendForumPage(partial, page([post(2), post(1)]));
    expect(order(next)).toEqual(["Post 3", "Post 2", "Post 1"]);
    expect(next.nextCursor).toBeNull();
  });

  it("counts new replies on a post the reader opened before, not on the open one", () => {
    const read = markForumPostRead(base, id(1), at(1));
    const bumped = post(1, { lastActivityAt: at(30), replyCount: 2 });
    const next = applyForumUpsert(read, bumped, {
      filters: activity,
      viewerId: ME,
      hold: false,
    });
    expect(next.viewer[id(1)].newReplyCount).toBe(2);

    const open = applyForumUpsert(read, bumped, {
      filters: activity,
      viewerId: ME,
      hold: false,
      openPostId: id(1),
    });
    expect(open.viewer[id(1)].newReplyCount).toBe(0);
  });

  it("resolves an open post and keeps the open count honest", () => {
    const next = applyForumUpsert(base, post(2, { resolvedAt: at(40) }), {
      filters: activity,
      viewerId: ME,
      hold: false,
    });
    expect(next.counts).toEqual({ posts: 3, open: 2 });
  });
});

describe("filters", () => {
  it("matches titles without accents or case, every word", () => {
    expect(titleMatchesQuery("Notebook não liga", "notebook nao")).toBe(true);
    expect(titleMatchesQuery("Notebook não liga", "LIGA note")).toBe(true);
    expect(titleMatchesQuery("Notebook não liga", "desliga")).toBe(false);
  });

  it("treats Meus posts as the viewer's own", () => {
    const filters: ForumFilters = { ...activity, mine: true };
    expect(passesForumFilters(post(1, { authorId: ME }), filters, ME)).toBe(true);
    expect(passesForumFilters(post(1), filters, ME)).toBe(false);
  });
});

describe("unread levels", () => {
  it("says Novo for a never-opened post by someone else after the last visit", () => {
    expect(forumUnreadState(post(5), undefined, ME, at(1)).kind).toBe("new");
    expect(forumUnreadState(post(5), undefined, ME, at(10)).kind).toBe("read");
    expect(
      forumUnreadState(post(5, { authorId: ME }), undefined, ME, null).kind,
    ).toBe("read");
  });

  it("says unread with a count after replies to an opened post", () => {
    const viewer = {
      postId: id(5),
      lastReadAt: at(5),
      newReplyCount: 3,
      following: false,
    };
    expect(
      forumUnreadState(post(5, { lastActivityAt: at(9) }), viewer, ME, null),
    ).toEqual({ kind: "unread", count: 3 });
    expect(
      forumUnreadState(post(5), { ...viewer, newReplyCount: 0 }, ME, null).kind,
    ).toBe("read");
  });
});

describe("refreshForumFirstPage", () => {
  it("keeps the pages the reader scrolled through, and the queue", () => {
    const twoPages = appendForumPage(
      forumListFromPage(page([post(30), post(20)], { nextCursor: "c1" })),
      page([post(10), post(5)], { nextCursor: "c2" }),
    );
    const held = applyForumUpsert(twoPages, post(40), {
      filters: activity,
      viewerId: ME,
      hold: true,
    });
    const refreshed = refreshForumFirstPage(
      held,
      page([post(31), post(30)], { nextCursor: "fresh" }),
    );
    expect(order(refreshed)).toEqual(["Post 31", "Post 30", "Post 20", "Post 10", "Post 5"]);
    expect(refreshed.nextCursor).toBe("c2");
    expect(refreshed.queued.map((one) => one.title)).toEqual(["Post 40"]);
  });

  it("is a plain replace when only page 1 was loaded", () => {
    const one = forumListFromPage(page([post(3), post(2)]));
    const refreshed = refreshForumFirstPage(one, page([post(4), post(3), post(2)]));
    expect(order(refreshed)).toEqual(["Post 4", "Post 3", "Post 2"]);
    expect(refreshed.nextCursor).toBeNull();
  });
});

describe("markForumPostRead", () => {
  it("never stamps earlier than the post's last activity", () => {
    const state = forumListFromPage(page([post(30, { lastActivityAt: at(50) })]));
    const read = markForumPostRead(state, id(30), at(40));
    expect(read.viewer[id(30)].lastReadAt).toBe(at(50));
    expect(forumUnreadState(state.posts[0], read.viewer[id(30)], ME, null).kind).toBe("read");
  });
});

describe("each post counts once, wherever it is drawn", () => {
  const base = forumListFromPage(page([post(3), post(2), post(1)]));

  it("a new post whose first frame already has a reply is still new, under created sort too", () => {
    const next = applyForumUpsert(base, post(40, { replyCount: 1, lastActivityAt: at(41) }), {
      filters: created,
      viewerId: ME,
      hold: false,
    });
    expect(order(next)[0]).toBe("Post 40");
    expect(next.counts).toEqual({ posts: 4, open: 4 });
  });

  it("a post created in the same instant as the newest is ordered by id, not dropped", () => {
    const twin = { ...post(3), id: "00000000-0000-4000-8000-0000000000ff", title: "Twin" };
    const next = applyForumUpsert(base, twin, { filters: created, viewerId: ME, hold: false });
    expect(order(next)[0]).toBe("Twin");
    expect(next.counts).toEqual({ posts: 4, open: 4 });
  });

  it("a new post the filters hide is counted once, however many frames it gets, and dropped once", () => {
    const filters: ForumFilters = { ...activity, tagIds: [TAG_BUG] };
    let next = applyForumUpsert(base, post(40), { filters, viewerId: ME, hold: false });
    next = applyForumUpsert(next, post(40, { title: "edited" }), { filters, viewerId: ME, hold: false });
    next = applyForumUpsert(next, post(40, { replyCount: 2, lastActivityAt: at(45) }), {
      filters,
      viewerId: ME,
      hold: false,
    });
    expect(next.posts.some((one) => one.id === id(40))).toBe(false);
    expect(next.counts).toEqual({ posts: 4, open: 4 });
    expect(applyForumRemoved(next, id(40)).counts).toEqual({ posts: 3, open: 3 });
  });

  it("resolving and reopening a post moves abertos, drawn or not", () => {
    const filters: ForumFilters = { ...activity, status: "open" };
    const resolved = applyForumUpsert(base, post(2, { resolvedAt: at(9) }), {
      filters,
      viewerId: ME,
      hold: false,
    });
    expect(resolved.counts).toEqual({ posts: 3, open: 2 });
    const reopened = applyForumUpsert(resolved, post(2), { filters, viewerId: ME, hold: false });
    expect(reopened.counts).toEqual({ posts: 3, open: 3 });
  });
});

describe("the queue behind the pill", () => {
  const base = forumListFromPage(page([post(3), post(2), post(1)]));

  it("an edit after a held bump is what the pill applies, not the older copy", () => {
    const bumped = applyForumUpsert(base, post(1, { lastActivityAt: at(30), replyCount: 1 }), {
      filters: activity,
      viewerId: ME,
      hold: true,
    });
    const edited = applyForumUpsert(
      bumped,
      post(1, { lastActivityAt: at(30), replyCount: 1, title: "Renamed" }),
      { filters: activity, viewerId: ME, hold: true },
    );
    const flushed = flushForumQueue(edited, { filters: activity, viewerId: ME });
    expect(order(flushed)).toEqual(["Renamed", "Post 3", "Post 2"]);
  });

  it("several queued moves and arrivals land in order in one pass", () => {
    const ctx = { filters: activity, viewerId: ME, hold: true };
    let next = applyForumUpsert(base, post(40), ctx);
    next = applyForumUpsert(next, post(1, { lastActivityAt: at(50), replyCount: 1 }), ctx);
    next = applyForumUpsert(next, post(41), ctx);
    expect(next.queued).toHaveLength(3);
    const flushed = flushForumQueue(next, { filters: activity, viewerId: ME });
    expect(order(flushed)).toEqual(["Post 1", "Post 41", "Post 40", "Post 3", "Post 2"]);
    expect(flushed.queued).toEqual([]);
    expect(flushed.counts).toEqual({ posts: 5, open: 5 });
  });

  it("a reconnect while the reader is busy moves nothing and queues what is new", () => {
    const held = applyForumUpsert(base, post(40), { filters: activity, viewerId: ME, hold: true });
    const refreshed = refreshForumFirstPage(
      held,
      page([post(41), post(40), post(3, { title: "Post 3 (fresh)" }), post(2)]),
      { hold: true },
    );
    expect(order(refreshed)).toEqual(["Post 3 (fresh)", "Post 2", "Post 1"]);
    expect(refreshed.queued.map((one) => one.title).sort()).toEqual(["Post 40", "Post 41"]);
  });

  it("a reconnect while the reader is busy takes fresh pins, and a newly pinned post leaves the list", () => {
    const refreshed = refreshForumFirstPage(
      base,
      page([post(3), post(1)], { pinned: [post(2, { pinnedAt: at(9) })] }),
      { hold: true },
    );
    expect(refreshed.pinned.map((one) => one.id)).toEqual([id(2)]);
    expect(order(refreshed)).toEqual(["Post 3", "Post 1"]);
  });
});

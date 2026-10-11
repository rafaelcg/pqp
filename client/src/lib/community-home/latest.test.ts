import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const fetchLatest = vi.fn();
const fetchUnread = vi.fn();

vi.mock("@/lib/api", () => ({
  ApiError: FakeApiError,
  fetchCommunityHomeLatest: (...args: unknown[]) => fetchLatest(...args),
  fetchCommunityHomeUnread: (...args: unknown[]) => fetchUnread(...args),
}));

const {
  LATEST_OFF_RETRY_MS,
  __resetLatestPreviewCache,
  bauPreviewMode,
  coverSource,
  leadPost,
  markLatestSeen,
  newestUnreadAt,
  otherNewPosts,
  readBauRow,
} = await import("./latest");
type LatestCard = import("./latest").LatestCard;
type LatestPreview = import("./latest").LatestPreview;

function card(overrides: Partial<LatestCard> = {}): LatestCard {
  return {
    postId: "11111111-1111-4111-8111-111111111111",
    serverId: "22222222-2222-4222-8222-222222222222",
    serverName: "QG",
    title: "Clutch 1v4",
    teaser: null,
    author: { id: "33333333-3333-4333-8333-333333333333", displayName: "Bia", avatarUrl: null },
    mediaKind: null,
    mediaUrl: null,
    posterUrl: null,
    visibility: "free",
    locked: false,
    pinned: false,
    likeCount: 0,
    commentCount: 0,
    publishedAt: "2026-10-11T20:00:00.000Z",
    isNew: false,
    ...overrides,
  };
}

function preview(posts: LatestCard[], unread = posts.filter((p) => p.isNew).length): LatestPreview {
  return { unread, lastSeenAt: null, posts };
}

describe("readBauRow", () => {
  beforeEach(() => {
    __resetLatestPreviewCache();
    fetchLatest.mockReset();
    fetchUnread.mockReset();
  });

  it("uses the preview when the server serves it, and takes the count from it", async () => {
    const latest = preview([card({ isNew: true, publishedAt: "2026-10-11T21:00:00.000Z" })]);
    fetchLatest.mockResolvedValue(latest);
    const read = await readBauRow("s1", "pt-BR");
    expect(fetchLatest).toHaveBeenCalledWith("s1", "pt-BR");
    expect(fetchUnread).not.toHaveBeenCalled();
    expect(read).toEqual({ count: 1, newestAt: "2026-10-11T21:00:00.000Z", latest });
  });

  it("a 404 (flag off) falls back to the unread read and stops asking for a while", async () => {
    let now = 1_000;
    fetchLatest.mockRejectedValue(new FakeApiError(404, "Not found"));
    fetchUnread.mockResolvedValue({ count: 2, newestAt: "2026-10-11T19:00:00.000Z" });
    expect(await readBauRow("s1", undefined, () => now)).toEqual({
      count: 2,
      newestAt: "2026-10-11T19:00:00.000Z",
      latest: null,
    });
    await readBauRow("s1", undefined, () => now);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(fetchUnread).toHaveBeenCalledTimes(2);

    // Per server: another server still asks.
    await readBauRow("s2", undefined, () => now);
    expect(fetchLatest).toHaveBeenCalledTimes(2);

    // Turned back on live: picked up after the retry window.
    now += LATEST_OFF_RETRY_MS;
    fetchLatest.mockResolvedValue(preview([]));
    expect((await readBauRow("s1", undefined, () => now)).latest).toEqual(preview([]));
  });

  it("anything but a 404 is a failure, not a fallback", async () => {
    fetchLatest.mockRejectedValue(new FakeApiError(503, "busy"));
    await expect(readBauRow("s1")).rejects.toThrow("busy");
    expect(fetchUnread).not.toHaveBeenCalled();
  });
});

describe("the preview's rules", () => {
  it("card while anything is new, row once seen, the two empties", () => {
    expect(bauPreviewMode(preview([card({ isNew: true })]), false)).toBe("card");
    expect(bauPreviewMode(preview([card()]), false)).toBe("row");
    expect(bauPreviewMode(preview([]), true)).toBe("empty-staff");
    expect(bauPreviewMode(preview([]), false)).toBe("empty");
  });

  it("leads with the newest NEW post, not the viewer's own newer one", () => {
    const mine = card({ postId: "a", title: "meu", isNew: false });
    const theirs = card({ postId: "b", title: "deles", isNew: true });
    const latest = preview([mine, theirs]);
    expect(leadPost(latest)?.title).toBe("deles");
    expect(newestUnreadAt(latest)).toBe(theirs.publishedAt);
  });

  it("the footer counts every other unread post, past the ones returned", () => {
    const a = card({ postId: "a", isNew: true });
    const b = card({ postId: "b", title: "Camp", isNew: true });
    const latest = preview([a, b], 5);
    expect(otherNewPosts(latest, a)).toEqual({ first: b, count: 4 });
    expect(otherNewPosts(preview([a], 1), a)).toEqual({ first: null, count: 0 });
  });

  it("opening the Baú keeps the posts and clears what is new", () => {
    const latest = preview([card({ isNew: true }), card({ postId: "b" })]);
    const seen = markLatestSeen(latest)!;
    expect(seen.unread).toBe(0);
    expect(seen.posts).toHaveLength(2);
    expect(seen.posts.every((p) => !p.isNew)).toBe(true);
    expect(seen.lastSeenAt).not.toBeNull();
    // Nothing to change: the same object back, so nothing re-renders.
    expect(markLatestSeen(seen)).toBe(seen);
    expect(markLatestSeen(null)).toBeNull();
  });

  it("never paints a thumbnail from a video file; uses the chosen cover or the plate", () => {
    expect(coverSource(card({ mediaKind: "image", mediaUrl: "https://b/i.jpg" }))).toEqual({
      kind: "image",
      url: "https://b/i.jpg",
    });
    expect(coverSource(card({ mediaKind: "youtube", mediaUrl: "https://i.ytimg.com/x.jpg" }))).toEqual({
      kind: "image",
      url: "https://i.ytimg.com/x.jpg",
    });
    expect(coverSource(card({ mediaKind: "video", mediaUrl: "https://b/v.mp4" }))).toEqual({
      kind: "plate",
    });
    expect(
      coverSource(
        card({ mediaKind: "video", mediaUrl: "https://b/v.mp4", posterUrl: "https://b/cover.jpg" }),
      ),
    ).toEqual({ kind: "image", url: "https://b/cover.jpg" });
    for (const kind of ["twitch", "tiktok", "instagram"] as const) {
      expect(coverSource(card({ mediaKind: kind }))).toEqual({ kind: "plate" });
    }
    expect(coverSource(card())).toEqual({ kind: "plate" });
  });
});

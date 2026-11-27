import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JamPublicMeState } from "./jam-public-store";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  list: vi.fn(),
  openById: vi.fn(),
  openNew: vi.fn(),
  inbox: vi.fn(),
}));

vi.mock("@/lib/jam-public-nav", () => ({
  listenToPublicJam: api.openById,
  startPublicJam: api.openNew,
}));

vi.mock("@/lib/jam-public-api", () => ({
  fetchJamPublicMe: api.me,
  fetchPublicJams: api.list,
  fetchJamPublicConsents: vi.fn().mockResolvedValue({ pending: [] }),
  fetchJamPublicInbox: api.inbox,
  fetchJamTakeNotices: vi.fn().mockResolvedValue({ notices: [] }),
  ackJamTakeNotice: vi.fn().mockResolvedValue({ ok: true }),
  answerJamConsent: vi.fn(),
}));

const store = await import("./jam-public-store");
const framesModule = await import("./jam-frames");
const { FEATURED_WINDOW } = await import("./jam-featured");

type Mode = "open" | "wanted" | "closed";
/** A song that has earned the slot (a cover, two parts from two people) unless the arguments say so. */
const song = (id: string, artist: string | null, joinMode: Mode = "open", parts = 2, cover: string | null = `/cover/${id}.jpg`) => ({
  id,
  artist,
  joinMode,
  coverUrl: cover,
  plays: 0,
  likes: 0,
  publishedAt: new Date(Date.now() - 86_400_000).toISOString(),
  parts: Array.from({ length: parts }, (_, index) => ({ person: { name: `P${index % 2}`, handle: null, avatarUrl: null } })),
  needs: [],
});

beforeEach(() => {
  api.me.mockReset();
  api.list.mockReset();
  api.openById.mockReset();
  api.openNew.mockReset();
  api.inbox.mockReset();
  api.inbox.mockResolvedValue({ takes: [] });
  store.resetJamPublic();
});

describe("the announce field", () => {
  it("is held beside enabled, and only when the server said yes to both", async () => {
    api.me.mockResolvedValue({ enabled: true, publishing: "open", uploads: true, announce: true });
    await store.loadJamPublicMe({ force: true });
    expect(store.readJamPublicMeForTests()).toMatchObject({ enabled: true, announce: true });
  });

  it("an API that predates it reads as off", async () => {
    api.me.mockResolvedValue({ enabled: true, publishing: "open", uploads: true });
    await store.loadJamPublicMe({ force: true });
    expect(store.readJamPublicMeForTests()).toMatchObject({ enabled: true, announce: false });
  });

  it("never announces with the flag off, whatever the field says", async () => {
    api.me.mockResolvedValue({ enabled: false, publishing: "open", uploads: true, announce: true });
    await store.loadJamPublicMe({ force: true });
    expect(store.readJamPublicMeForTests()).toMatchObject({ enabled: false, announce: false });
  });
});

describe("the song a door opens", () => {
  it("follows the site's hero rule: an original that still takes a part, over a closed hit", async () => {
    api.list.mockResolvedValue({
      songs: [
        song("closed-hit", null, "closed"),
        song("cover", "Banda Famosa", "wanted"),
        song("wants", null, "wanted"),
        song("other", null),
      ],
    });
    expect(await store.fetchFeaturedPublicJam()).toEqual({ id: "wants", takesParts: true });
    expect(api.list).toHaveBeenCalledWith({ sort: "top", limit: 12 });
  });

  it("reads the same twelve as the site, not ten", () => {
    expect(FEATURED_WINDOW).toBe(12);
  });

  it("falls to a closed original, saying it takes no part, when nothing takes one", async () => {
    api.list.mockResolvedValue({ songs: [song("cover", "X", "closed"), song("closed", null, "closed")] });
    expect(await store.fetchFeaturedPublicJam()).toEqual({ id: "closed", takesParts: false });
  });

  it("falls back to the first song when every one has an artist and takes a part", async () => {
    api.list.mockResolvedValue({ songs: [song("a", "X"), song("b", "Y")] });
    expect(await store.fetchFeaturedPublicJam()).toEqual({ id: "a", takesParts: true });
  });

  it("skips a song with no part to hear", async () => {
    api.list.mockResolvedValue({ songs: [song("bare", null, "open", 0), song("heard", null)] });
    expect((await store.fetchFeaturedPublicJam())?.id).toBe("heard");
  });

  it("is null when no song earned the slot, so a door offers starting one instead of a weak song", async () => {
    api.list.mockResolvedValue({
      songs: [song("rough", null, "open", 1, null), song("nocover", null, "open", 2, null), song("solo", null, "open", 1)],
    });
    expect(await store.fetchFeaturedPublicJam()).toBeNull();
  });

  it("is null when there is no public song", async () => {
    api.list.mockResolvedValue({ songs: [] });
    expect(await store.fetchFeaturedPublicJam()).toBeNull();
  });
});

describe("whether a door offers Gravar minha parte", () => {
  const me = (patch: Partial<JamPublicMeState> = {}): JamPublicMeState => ({
    loaded: true,
    enabled: true,
    publishing: "open",
    uploads: true,
    announce: true,
    ...patch,
  });
  it("needs a song that takes a part and an account that may record", () => {
    expect(store.canRecordOnFeatured({ id: "a", takesParts: true }, me())).toBe(true);
    expect(store.canRecordOnFeatured({ id: "a", takesParts: false }, me())).toBe(false);
    expect(store.canRecordOnFeatured(null, me())).toBe(false);
    expect(store.canRecordOnFeatured({ id: "a", takesParts: true }, me({ uploads: false }))).toBe(false);
    expect(store.canRecordOnFeatured({ id: "a", takesParts: true }, me({ publishing: "blocked" }))).toBe(false);
    expect(store.canRecordOnFeatured({ id: "a", takesParts: true }, me({ publishing: "review" }))).toBe(true);
  });
});

describe("the door with no song beside it", () => {
  it("opens the featured song waiting, or the start sheet when there is none or the lookup failed", async () => {
    api.list.mockResolvedValueOnce({ songs: [song("top", null)] });
    await store.openPublicJamsDoor();
    expect(api.openById).toHaveBeenCalledWith("top");

    api.list.mockResolvedValueOnce({ songs: [] });
    await store.openPublicJamsDoor();
    api.list.mockRejectedValueOnce(new Error("offline"));
    await store.openPublicJamsDoor();
    expect(api.openNew).toHaveBeenCalledTimes(2);
  });

  it("only the latest press opens anything: a late answer to an earlier one is dropped", async () => {
    let release: (page: { songs: unknown[] }) => void = () => {};
    api.list.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const first = store.openPublicJamsDoor();
    api.list.mockResolvedValueOnce({ songs: [song("second", null)] });
    await store.openPublicJamsDoor();
    release({ songs: [song("first", null)] });
    await first;
    expect(api.openById).toHaveBeenCalledTimes(1);
    expect(api.openById).toHaveBeenCalledWith("second");
  });
});

describe("the starter's own songs, live", () => {
  const dispatchJamFrame = (frame: unknown) => framesModule.dispatchJamFrame(frame as never);

  /** By default the take is somebody else's and waits (an outside take, or a member's later take). */
  const trackFrame = (
    type: "jam-track-added" | "jam-track-updated" | "jam-track-deleted",
    authorId: string | null,
    track: { authorId?: string; inMix?: boolean; id?: string } = {},
  ) =>
    ({
      type,
      channelId: "c1",
      song: { id: "s1", authorId },
      track: { id: track.id ?? "t1", songId: "s1", authorId: track.authorId ?? "carol", inMix: track.inMix ?? false },
      trackId: track.id ?? "t1",
    }) as unknown;

  async function enabled(viewer: string | null) {
    api.me.mockResolvedValue({ enabled: true, publishing: "open", uploads: true });
    store.resetJamPublic(viewer);
    await store.loadJamPublicMe({ force: true });
    await vi.waitFor(() => expect(api.inbox).toHaveBeenCalledTimes(1));
    api.inbox.mockClear();
  }

  it("a burst of frames for a song the viewer started is one read of the inbox, a while after the first", async () => {
    await enabled("alice");
    vi.useFakeTimers();
    try {
      dispatchJamFrame(trackFrame("jam-track-added", "alice"));
      dispatchJamFrame(trackFrame("jam-track-added", "alice"));
      dispatchJamFrame(trackFrame("jam-track-updated", "alice"));
      dispatchJamFrame(trackFrame("jam-track-deleted", "alice"));
      expect(api.inbox).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.inbox).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("frames for somebody else's song, or with nobody signed in, read nothing", async () => {
    await enabled("alice");
    vi.useFakeTimers();
    try {
      dispatchJamFrame(trackFrame("jam-track-added", "bob"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.inbox).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
    await enabled(null);
    vi.useFakeTimers();
    try {
      dispatchJamFrame(trackFrame("jam-track-added", null));
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.inbox).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a change that lands while a read is out queues exactly one more, never two at once", async () => {
    await enabled("alice");
    let release: (value: { takes: [] }) => void = () => undefined;
    api.inbox.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    vi.useFakeTimers();
    try {
      dispatchJamFrame(trackFrame("jam-track-added", "alice"));
      await vi.advanceTimersByTimeAsync(500);
      expect(api.inbox).toHaveBeenCalledTimes(1); // out, and not answered yet
      dispatchJamFrame(trackFrame("jam-track-added", "alice"));
      dispatchJamFrame(trackFrame("jam-track-added", "alice"));
      await vi.advanceTimersByTimeAsync(2000);
      expect(api.inbox).toHaveBeenCalledTimes(1); // still one in flight
      release({ takes: [] });
      await vi.advanceTimersByTimeAsync(2000);
      expect(api.inbox).toHaveBeenCalledTimes(2); // the queued one, once
      await vi.advanceTimersByTimeAsync(2000);
      expect(api.inbox).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the starter's inbox shows a part the moment its frame lands: the strip never trails the song", async () => {
    await enabled("alice");
    const take = { songId: "s1", songTitle: "Lua", track: { id: "t9" } };
    api.inbox.mockResolvedValue({ takes: [take] });
    vi.useFakeTimers();
    try {
      dispatchJamFrame(trackFrame("jam-track-added", "alice"));
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
    }
    expect(store.getJamPublicWaiting().inbox).toEqual([take]);
  });

  it("the ordinary in-mix takes of a song nobody sends outside takes to cost nothing; a waiting part and a listed one do", async () => {
    await enabled("alice");
    vi.useFakeTimers();
    try {
      // A member's take that went straight into the mix (a private channel song's ordinary take), the starter's own, and a deletion nothing lists.
      dispatchJamFrame(trackFrame("jam-track-added", "alice", { authorId: "bob", inMix: true }));
      dispatchJamFrame(trackFrame("jam-track-added", "alice", { authorId: "alice", inMix: true }));
      dispatchJamFrame(trackFrame("jam-track-deleted", "alice", { id: "t7" }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.inbox).not.toHaveBeenCalled();
      // Somebody else's part that waits is a request.
      dispatchJamFrame(trackFrame("jam-track-added", "alice", { authorId: "bob", inMix: false }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.inbox).toHaveBeenCalledTimes(1);
      // Its acceptance (now in the mix) is still about a take the inbox lists.
      api.inbox.mockResolvedValue({ takes: [{ songId: "s1", songTitle: "Lua", track: { id: "t1" } }] });
      dispatchJamFrame(trackFrame("jam-track-added", "alice", { authorId: "bob", inMix: false }));
      await vi.advanceTimersByTimeAsync(1000);
      api.inbox.mockClear();
      dispatchJamFrame(trackFrame("jam-track-updated", "alice", { authorId: "bob", inMix: true, id: "t1" }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.inbox).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a read that fails after an own-song frame is tried again 3 seconds later, not dropped", async () => {
    await enabled("alice");
    const take = { songId: "s1", songTitle: "Lua", track: { id: "t9" } };
    api.inbox.mockRejectedValueOnce(new Error("network")).mockResolvedValue({ takes: [take] });
    vi.useFakeTimers();
    try {
      dispatchJamFrame(trackFrame("jam-track-added", "alice"));
      await vi.advanceTimersByTimeAsync(500);
      expect(api.inbox).toHaveBeenCalledTimes(1);
      expect(store.getJamPublicWaiting().inbox).toEqual([]);
      expect(store.jamPublicWaitingStaleForTests()).toBe(true);
      await vi.advanceTimersByTimeAsync(3500);
      expect(api.inbox).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
    expect(store.getJamPublicWaiting().inbox).toEqual([take]);
    expect(store.jamPublicWaitingStaleForTests()).toBe(false);
  });

  it("a song deleted while the inbox is still loading is not lost: one more read follows the one that was out", async () => {
    api.me.mockResolvedValue({ enabled: true, publishing: "open", uploads: true });
    store.resetJamPublic("alice");
    // The first read of the inbox is slow and will answer with the song that is about to be deleted.
    const stale = { songId: "s1", songTitle: "Lua", track: { id: "t1" } };
    let release: (value: { takes: unknown[] }) => void = () => undefined;
    api.inbox.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    await store.loadJamPublicMe({ force: true });
    await vi.waitFor(() => expect(api.inbox).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    try {
      // Nothing is listed yet, so only the read being out makes this deletion matter.
      dispatchJamFrame({ type: "jam-song-deleted", channelId: "c1", songId: "s1" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.inbox).toHaveBeenCalledTimes(1);
      release({ takes: [stale] });
      await vi.advanceTimersByTimeAsync(2000);
      expect(api.inbox).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
    expect(store.getJamPublicWaiting().inbox).toEqual([]);
  });
});

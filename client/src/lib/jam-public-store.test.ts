import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JamPublicMeState } from "./jam-public-store";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  list: vi.fn(),
  openById: vi.fn(),
  openNew: vi.fn(),
}));

vi.mock("@/lib/jam-public-nav", () => ({
  listenToPublicJam: api.openById,
  startPublicJam: api.openNew,
}));

vi.mock("@/lib/jam-public-api", () => ({
  fetchJamPublicMe: api.me,
  fetchPublicJams: api.list,
  fetchJamPublicConsents: vi.fn().mockResolvedValue({ pending: [] }),
  fetchJamPublicInbox: vi.fn().mockResolvedValue({ takes: [] }),
  fetchJamTakeNotices: vi.fn().mockResolvedValue({ notices: [] }),
  ackJamTakeNotice: vi.fn().mockResolvedValue({ ok: true }),
  answerJamConsent: vi.fn(),
}));

const store = await import("./jam-public-store");
const { FEATURED_WINDOW } = await import("./jam-featured");

type Mode = "open" | "wanted" | "closed";
const song = (id: string, artist: string | null, joinMode: Mode = "open", parts = 1) => ({
  id,
  artist,
  joinMode,
  parts: Array.from({ length: parts }, () => ({})),
  needs: [],
});

beforeEach(() => {
  api.me.mockReset();
  api.list.mockReset();
  api.openById.mockReset();
  api.openNew.mockReset();
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

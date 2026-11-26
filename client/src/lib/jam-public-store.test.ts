import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  list: vi.fn(),
  openById: vi.fn(),
  openNew: vi.fn(),
}));

vi.mock("@/lib/jam-public-nav", () => ({
  openPublicJamById: api.openById,
  openPublicJam: api.openNew,
}));

vi.mock("@/lib/jam-public-api", () => ({
  fetchJamPublicMe: api.me,
  fetchPublicJams: api.list,
  fetchJamPublicConsents: vi.fn().mockResolvedValue({ pending: [] }),
  fetchJamPublicInbox: vi.fn().mockResolvedValue({ takes: [] }),
  answerJamConsent: vi.fn(),
}));

const store = await import("./jam-public-store");

const song = (id: string, artist: string | null) => ({ id, artist });

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
  it("is the first original among the most heard", async () => {
    api.list.mockResolvedValue({
      songs: [song("cover", "Banda Famosa"), song("original", null), song("other", null)],
    });
    expect(await store.fetchTopPublicJamId()).toBe("original");
    expect(api.list).toHaveBeenCalledWith({ sort: "top", limit: 10 });
  });

  it("falls back to the top song when every one has an artist", async () => {
    api.list.mockResolvedValue({ songs: [song("a", "X"), song("b", "Y")] });
    expect(await store.fetchTopPublicJamId()).toBe("a");
  });

  it("is null when there is no public song", async () => {
    api.list.mockResolvedValue({ songs: [] });
    expect(await store.fetchTopPublicJamId()).toBeNull();
  });
});

describe("the door with no song beside it", () => {
  it("opens the top song playing, or the start sheet when there is none or the lookup failed", async () => {
    api.list.mockResolvedValueOnce({ songs: [song("top", null)] });
    await store.openPublicJamsDoor();
    expect(api.openById).toHaveBeenCalledWith("top", { play: true });

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
    expect(api.openById).toHaveBeenCalledWith("second", { play: true });
  });
});

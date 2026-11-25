import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  list: vi.fn(),
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

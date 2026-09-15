import { afterEach, describe, expect, it, vi } from "vitest";

const innertube = vi.hoisted(() => ({
  innertubeSearch: vi.fn(),
}));

vi.mock("./innertube.js", () => ({
  innertubeSearch: innertube.innertubeSearch,
  innertubePlaylist: vi.fn(),
  setInnerTubeGate: vi.fn(),
}));

const { MusicResolveError, searchMusicCandidates } = await import("./music.js");

describe("searchMusicCandidates", () => {
  afterEach(() => {
    innertube.innertubeSearch.mockReset();
  });

  it("maps InnerTube hits to MusicResolved, capped at five", async () => {
    innertube.innertubeSearch.mockResolvedValue([
      {
        videoId: "aaaaaaaaaaa",
        title: "Primeira",
        durationMs: 180_000,
        thumbnailUrl: "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg",
      },
      {
        videoId: "bbbbbbbbbbb",
        title: "Segunda",
        durationMs: 90_000,
        thumbnailUrl: null,
      },
    ]);

    await expect(searchMusicCandidates("legia urbana")).resolves.toEqual([
      {
        provider: "youtube",
        videoId: "aaaaaaaaaaa",
        title: "Primeira",
        sourceUrl: null,
        thumbnailUrl: "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg",
        durationMs: 180_000,
      },
      {
        provider: "youtube",
        videoId: "bbbbbbbbbbb",
        title: "Segunda",
        sourceUrl: null,
        thumbnailUrl: null,
        durationMs: 90_000,
      },
    ]);
    expect(innertube.innertubeSearch).toHaveBeenCalledWith("legia urbana", 5);
  });

  it("rethrows a busy InnerTube error instead of falling through", async () => {
    innertube.innertubeSearch.mockRejectedValue(
      new MusicResolveError("busy", "upstream budget spent"),
    );
    await expect(searchMusicCandidates("x")).rejects.toMatchObject({ code: "busy" });
  });

  it("falls back to resolve when InnerTube returns nothing", async () => {
    innertube.innertubeSearch.mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("oembed")) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                title: "Fallback",
                thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
              }),
          };
        }
        return { ok: false, status: 404, text: async () => "" };
      }),
    );

    await expect(
      searchMusicCandidates("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).resolves.toEqual([
      {
        provider: "youtube",
        videoId: "dQw4w9WgXcQ",
        title: "Fallback",
        sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        durationMs: null,
      },
    ]);

    vi.unstubAllGlobals();
  });
});

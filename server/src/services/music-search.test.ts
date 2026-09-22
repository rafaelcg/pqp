import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const innertube = vi.hoisted(() => ({
  innertubeSearch: vi.fn(),
}));

vi.mock("./innertube.js", () => ({
  innertubeSearch: innertube.innertubeSearch,
  innertubePlaylist: vi.fn(),
  setInnerTubeGate: vi.fn(),
}));

const {
  MusicResolveError,
  resetMusicCachesForTests,
  resolveMusic,
  searchMusicCandidates,
  searchYouTube,
} = await import("./music.js");

describe("searchMusicCandidates", () => {
  afterEach(() => {
    innertube.innertubeSearch.mockReset();
  });

  beforeEach(() => {
    resetMusicCachesForTests();
  });

  it("maps InnerTube hits to MusicResolved, capped at five", async () => {
    innertube.innertubeSearch.mockResolvedValue([
      {
        videoId: "aaaaaaaaaaa",
        title: "Canção da Legião",
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
        title: "Canção da Legião",
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

/*
 * The typed-search path had no cache at all, which mattered more once the
 * field started searching as you type: every pause was an upstream call,
 * and an empty answer cost up to four tokens of the shared budget plus a
 * scrape. One cache serves both paths.
 */
describe("the search cache", () => {
  beforeEach(() => {
    resetMusicCachesForTests();
    innertube.innertubeSearch.mockReset();
  });

  const hit = (videoId: string) => ({
    videoId,
    title: `Track ${videoId}`,
    durationMs: 180_000,
    thumbnailUrl: null,
  });

  it("asks upstream once for the same typed query", async () => {
    innertube.innertubeSearch.mockResolvedValue([hit("aaaaaaaaaaa")]);
    await searchMusicCandidates("legiao urbana");
    await searchMusicCandidates("legiao urbana");
    expect(innertube.innertubeSearch).toHaveBeenCalledTimes(1);
  });

  it("ignores case and surrounding whitespace in the key", async () => {
    innertube.innertubeSearch.mockResolvedValue([hit("aaaaaaaaaaa")]);
    await searchMusicCandidates("Legiao  Urbana");
    await searchMusicCandidates("  legiao urbana  ");
    expect(innertube.innertubeSearch).toHaveBeenCalledTimes(1);
  });

  it("serves the resolve path from the same entry", async () => {
    innertube.innertubeSearch.mockResolvedValue([hit("aaaaaaaaaaa")]);
    await searchMusicCandidates("caetano veloso");
    const resolved = await searchYouTube("caetano veloso");
    expect(innertube.innertubeSearch).toHaveBeenCalledTimes(1);
    expect(resolved.videoId).toBe("aaaaaaaaaaa");
  });

  it("does not remember an empty answer, which is usually a flake", async () => {
    innertube.innertubeSearch.mockResolvedValue([]);
    await searchMusicCandidates("nothing at all").catch(() => undefined);
    innertube.innertubeSearch.mockResolvedValue([hit("bbbbbbbbbbb")]);
    const second = await searchMusicCandidates("nothing at all");
    expect(second[0]?.videoId).toBe("bbbbbbbbbbb");
  });

  /*
   * A RESOLVE MUST NOT LEAVE A ONE-HIT ANSWER WHERE A LIST IS EXPECTED.
   *
   * `searchYouTube` needs one hit and the candidates path needs five, and
   * both read the same key. The resolve path used to store its single hit
   * under that key, so somebody who pasted a Spotify link (which resolves
   * by searching its title) and then typed the same words was shown one
   * candidate and told that was all YouTube had.
   */
  it("does not let a resolve leave one candidate behind", async () => {
    innertube.innertubeSearch.mockResolvedValue([
      hit("aaaaaaaaaaa"),
      hit("bbbbbbbbbbb"),
      hit("ccccccccccc"),
    ]);
    const resolved = await searchYouTube("cravo e canela");
    expect(resolved.videoId).toBe("aaaaaaaaaaa");
    const candidates = await searchMusicCandidates("cravo e canela");
    expect(candidates.map((one) => one.videoId)).toEqual([
      "aaaaaaaaaaa",
      "bbbbbbbbbbb",
      "ccccccccccc",
    ]);
  });

  /*
   * With a Data API key the resolve path genuinely knows one hit, so its
   * entry cannot answer for five: the candidates path asks for its own.
   */
  it("asks again when all that is remembered is one hit", async () => {
    process.env.YOUTUBE_API_KEY = "test-key";
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: { videoId: "ddddddddddd" },
              snippet: { title: "One", thumbnails: {} },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as typeof globalThis.fetch;
    try {
      await searchYouTube("gilberto gil");
      innertube.innertubeSearch.mockResolvedValue([
        hit("eeeeeeeeeee"),
        hit("fffffffffff"),
      ]);
      const candidates = await searchMusicCandidates("gilberto gil");
      expect(candidates).toHaveLength(2);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.YOUTUBE_API_KEY;
    }
  });

  /*
   * The duration a pasted link needs is one InnerTube search, and the
   * comment beside it has always said it is cached like any other. It was
   * not: it went straight to `innertubeSearch`, so every paste of the same
   * link spent another budget token.
   */
  it("remembers the search a pasted link runs for its duration", async () => {
    innertube.innertubeSearch.mockResolvedValue([hit("aaaaaaaaaaa")]);
    const realFetch = globalThis.fetch;
    // oEmbed, which carries the title and the thumbnail and no duration.
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ title: "Track", thumbnail_url: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as typeof globalThis.fetch;
    try {
      const url = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
      const first = await resolveMusic(url);
      expect(first.tracks[0]?.durationMs).toBe(180_000);
      await resolveMusic(url);
      expect(innertube.innertubeSearch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("shares one upstream call between callers asking at the same time", async () => {
    let release: (value: unknown) => void = () => {};
    innertube.innertubeSearch.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const both = Promise.all([
      searchMusicCandidates("daft punk"),
      searchMusicCandidates("daft punk"),
    ]);
    release([hit("ccccccccccc")]);
    const [first, second] = await both;
    expect(innertube.innertubeSearch).toHaveBeenCalledTimes(1);
    expect(first[0]?.videoId).toBe("ccccccccccc");
    expect(second[0]?.videoId).toBe("ccccccccccc");
  });
});

describe("a typed link that does not parse", () => {
  beforeEach(() => {
    resetMusicCachesForTests();
    innertube.innertubeSearch.mockReset();
  });

  it("is refused rather than searched upstream", async () => {
    await expect(searchMusicCandidates("https://")).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(innertube.innertubeSearch).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A playlist that is gone answers "not found", not "the provider is down".
 *
 * InnerTube `browse` returns nothing for a deleted list, so the code falls
 * back to the public playlist page. YouTube answers 404 for that page, and
 * `fetchText` turned any non-ok status into an `upstream` error, which the
 * route maps to 502. The friendly 404 the function already carries was
 * unreachable for the one case it was written for.
 */
const innertube = vi.hoisted(() => ({
  innertubePlaylist: vi.fn(),
  innertubeSearch: vi.fn(),
}));

vi.mock("./innertube.js", () => ({
  innertubeSearch: innertube.innertubeSearch,
  innertubePlaylist: innertube.innertubePlaylist,
  setInnerTubeGate: vi.fn(),
}));

const { MusicResolveError, resetMusicCachesForTests, resolveYouTubePlaylist } =
  await import("./music.js");

describe("a playlist that is gone", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    resetMusicCachesForTests();
    innertube.innertubePlaylist.mockResolvedValue(null);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/playlist?list=")) {
        return new Response("", { status: 404, statusText: "Not Found" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    innertube.innertubePlaylist.mockReset();
  });

  it("says not found rather than blaming the provider", async () => {
    await expect(
      resolveYouTubePlaylist("PLbogusNoSuchPlaylist0000001", null),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("is still an upstream failure when the page breaks some other way", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("", { status: 500, statusText: "Server Error" }),
    ) as typeof globalThis.fetch;
    await expect(
      resolveYouTubePlaylist("PLbogusNoSuchPlaylist0000001", null),
    ).rejects.toMatchObject({ code: "upstream" });
  });

  it("keeps MusicResolveError's shape", () => {
    expect(new MusicResolveError("not_found", "x").code).toBe("not_found");
  });
});

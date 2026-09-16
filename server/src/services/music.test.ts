import { describe, expect, it, vi } from "vitest";
import {
  firstResultFromHtml,
  playlistFromHtml,
  spotifyTrackListFromHtml,
} from "./music.js";

describe("firstResultFromHtml", () => {
  it("reads the first videoRenderer's id and title", () => {
    const html =
      'junk {"videoRenderer":{"videoId":"abcdefghijk","thumbnail":{},"title":{"runs":[{"text":"Legi\\u00e3o Urbana - Tempo Perdido"}]}}} ' +
      '{"videoRenderer":{"videoId":"zzzzzzzzzzz","title":{"runs":[{"text":"second"}]}}}';
    expect(firstResultFromHtml(html)).toEqual({
      videoId: "abcdefghijk",
      title: "Legião Urbana - Tempo Perdido",
      thumbnailUrl: "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
    });
  });

  it("returns null on a page with no results", () => {
    expect(firstResultFromHtml("<html></html>")).toBeNull();
  });
});

describe("playlistFromHtml", () => {
  it("reads ids and titles off lockup view models, once each", () => {
    const item = (id: string, title: string) =>
      `{"lockupViewModel":{"contentImage":{"thumbnailViewModel":{}},"contentId":"${id}","metadata":{"lockupMetadataViewModel":{"title":{"content":"${title}"}}}}}`;
    const html = item("aaaaaaaaaaa", "First") + item("aaaaaaaaaaa", "First again") + item("bbbbbbbbbbb", "Legi\\u00e3o");
    expect(playlistFromHtml(html)).toEqual([
      { videoId: "aaaaaaaaaaa", title: "First" },
      { videoId: "bbbbbbbbbbb", title: "Legião" },
    ]);
  });
});

describe("spotifyTrackListFromHtml", () => {
  it("reads the list and the header, skipping the header row", () => {
    const html =
      '{"title":"Top Brasil","subtitle":"Spotify","trackList":[{"uri":"x","title":"Postinho","subtitle":"João, Grelo","contentRatings":{"labels":[]}},{"title":"GRWM","subtitle":"Iguinho"}],"other":1}';
    expect(spotifyTrackListFromHtml(html)).toEqual({
      name: "Top Brasil",
      tracks: [
        { title: "Postinho", artist: "João, Grelo" },
        { title: "GRWM", artist: "Iguinho" },
      ],
    });
    expect(spotifyTrackListFromHtml("<html></html>")).toEqual({ name: null, tracks: [] });
  });
});

describe("relatedMusicTracks", () => {
  it("maps InnerTube hits to MusicResolved with a null sourceUrl", async () => {
    const innertube = await import("./innertube.js");
    const spy = vi.spyOn(innertube, "innertubeRelated").mockResolvedValue([
      {
        videoId: "relWeb00001",
        title: "Parecida",
        durationMs: 180_000,
        thumbnailUrl: "https://i.ytimg.com/vi/relWeb00001/hqdefault.jpg",
      },
    ]);
    const { relatedMusicTracks } = await import("./music.js");
    await expect(relatedMusicTracks("dQw4w9WgXcQ")).resolves.toEqual([
      {
        provider: "youtube",
        videoId: "relWeb00001",
        title: "Parecida",
        sourceUrl: null,
        thumbnailUrl: "https://i.ytimg.com/vi/relWeb00001/hqdefault.jpg",
        durationMs: 180_000,
      },
    ]);
    expect(spy).toHaveBeenCalledWith("dQw4w9WgXcQ", 20);
    spy.mockRestore();
  });

  it("surfaces empty related as not_found", async () => {
    const innertube = await import("./innertube.js");
    const spy = vi.spyOn(innertube, "innertubeRelated").mockResolvedValue(null);
    const { relatedMusicTracks, MusicResolveError } = await import("./music.js");
    await expect(relatedMusicTracks("dQw4w9WgXcQ")).rejects.toBeInstanceOf(MusicResolveError);
    try {
      await relatedMusicTracks("dQw4w9WgXcQ");
    } catch (error) {
      expect((error as InstanceType<typeof MusicResolveError>).code).toBe("not_found");
    }
    spy.mockRestore();
  });
});

describe("upstream budget", () => {
  it("is charged per InnerTube attempt and surfaces as busy, never as a shorter list", async () => {
    const { resetUpstreamBudget, takeUpstreamBudget, MusicResolveError } = await import("./music.js");
    resetUpstreamBudget();
    for (let i = 0; i < 300; i++) {
      takeUpstreamBudget();
    }
    expect(() => takeUpstreamBudget()).toThrow(MusicResolveError);
    try {
      takeUpstreamBudget();
    } catch (error) {
      expect((error as InstanceType<typeof MusicResolveError>).code).toBe("busy");
    }
    resetUpstreamBudget();
  });
});

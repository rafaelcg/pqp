import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The bug this pins was never a parse fault: `LegiÃ£o Urbana - Pais E
 * Filhos` (video `bvIMBVBRpJU`) is stored that way on YouTube, and its own
 * oEmbed and watch page hand out the same string. So the pin belongs where
 * the repair is, at the seam where a title becomes ours, and it has to hold
 * that a title which is already right is not touched on the way through.
 */

const search = vi.fn();
const related = vi.fn();

vi.mock("./innertube.js", async () => {
  const actual = await vi.importActual<typeof import("./innertube.js")>(
    "./innertube.js",
  );
  return {
    ...actual,
    innertubeSearch: (query: string, limit: number) => search(query, limit),
    innertubeRelated: (videoId: string, limit: number) => related(videoId, limit),
  };
});

const { relatedMusicTracks, searchMusicCandidates } = await import("./music.js");

const video = (title: string, videoId = "bvIMBVBRpJU") => ({
  videoId,
  title,
  durationMs: 240_000,
  thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
});

describe("a title on its way out of the music service", () => {
  beforeEach(() => {
    search.mockReset();
    related.mockReset();
  });

  it("puts back a title YouTube stores as mojibake", async () => {
    search.mockResolvedValue([video("LegiÃ£o Urbana - Pais E Filhos")]);
    const tracks = await searchMusicCandidates("legiao urbana pais e filhos");
    expect(tracks[0]?.title).toBe("Legião Urbana - Pais E Filhos");
  });

  it("leaves the results that were already right exactly as they are", async () => {
    search.mockResolvedValue([
      video("Legião Urbana - Tempo Perdido (Ao Vivo Especial)", "tI9kSZgMLsc"),
      video("lofi hip hop 📚 beats", "aaaaaaaaaaa"),
      video("Don’t Stop Me Now", "bbbbbbbbbbb"),
    ]);
    const tracks = await searchMusicCandidates("anything");
    expect(tracks.map((track) => track.title)).toEqual([
      "Legião Urbana - Tempo Perdido (Ao Vivo Especial)",
      "lofi hip hop 📚 beats",
      "Don’t Stop Me Now",
    ]);
  });

  it("repairs an autoplay pick too, which is the same seam", async () => {
    related.mockResolvedValue([video("AmÃ©lie - La Valse")]);
    const tracks = await relatedMusicTracks("tI9kSZgMLsc", 1);
    expect(tracks[0]?.title).toBe("Amélie - La Valse");
  });
});

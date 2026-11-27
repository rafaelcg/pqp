// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SongCover } from "./art";

const song = (coverUrl: string | null, instruments: string[] = ["guitar", "bass"]) =>
  ({
    id: "0b8f2c1e-4d5a-4e6f-8a7b-1c2d3e4f5a6b",
    title: "Tarde de chuva",
    coverUrl,
    parts: instruments.map((instrument, index) => ({ instrument, hasVideo: false, person: { name: `P${index}`, handle: null, avatarUrl: null } })),
  }) as never;

describe("a song's small cover on the site", () => {
  it("is the picture when the song has one", () => {
    const html = renderToStaticMarkup(<SongCover song={song("/cover.jpg")} className="h-9 w-9" />);
    expect(html).toContain("<img");
    expect(html).toContain('src="/cover.jpg"');
    expect(html).not.toContain("data-jam-generated-cover");
  });

  it("is the generated one, never nothing, when it has none", () => {
    const html = renderToStaticMarkup(<SongCover song={song(null)} className="h-9 w-9" />);
    expect(html).not.toContain("<img");
    expect(html).toContain("data-jam-generated-cover");
    expect(html).toContain('data-jam-cover="generated"');
    expect(html).toContain("h-9 w-9");
  });

  it("is the same picture for the same song every time it is drawn", () => {
    expect(renderToStaticMarkup(<SongCover song={song(null)} />)).toBe(renderToStaticMarkup(<SongCover song={song(null)} />));
  });

  it("carries the band: a one-instrument song is that colour", () => {
    const html = renderToStaticMarkup(<SongCover song={song(null, ["bass"])} />);
    expect(html).toContain('data-ground="bass"');
  });
});

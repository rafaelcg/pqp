import { describe, expect, it } from "vitest";
import {
  BAND_INK,
  BOX_PALETTES,
  BOX_PLATFORMS,
  boxArtSpec,
  boxArtSvg,
  PATTERN_COUNT,
  TITLE_STROKE,
  fitTitle,
  titleLineWidth,
  wrapTitle,
  type BoxPlatform,
} from "./boxart";

const PLATFORMS = Object.keys(BOX_PLATFORMS) as BoxPlatform[];

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (ch[0] as number) + 0.7152 * (ch[1] as number) + 0.0722 * (ch[2] as number);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("palettes", () => {
  it("has eight", () => {
    expect(BOX_PALETTES).toHaveLength(8);
    expect(PATTERN_COUNT).toBe(5);
  });

  it.each(BOX_PALETTES.map((p, i) => [i, p] as const))("palette %i keeps 4.5:1 between title ink and its stroke", (_i, p) => {
    expect(contrast(p[3], TITLE_STROKE)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(PLATFORMS)("%s band keeps 4.5:1 for its label", (platform) => {
    expect(contrast(BAND_INK, BOX_PLATFORMS[platform].band)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("boxArtSvg", () => {
  it("is identical for the same input", () => {
    for (const p of PLATFORMS) {
      expect(boxArtSvg("Fixture Quest", p)).toBe(boxArtSvg("Fixture Quest", p));
    }
  });

  it("differs by title and by platform", () => {
    expect(boxArtSvg("Fixture One", "nes")).not.toBe(boxArtSvg("Fixture Two", "nes"));
    expect(boxArtSvg("Fixture One", "nes")).not.toBe(boxArtSvg("Fixture One", "gb"));
  });

  it("reaches every palette and every pattern across a modest set of titles", () => {
    const palettes = new Set<number>();
    const patterns = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const s = boxArtSpec(`Fixture ${i}`, "nes");
      palettes.add(s.palette);
      patterns.add(s.pattern);
    }
    expect(palettes.size).toBe(8);
    expect(patterns.size).toBe(PATTERN_COUNT);
  });

  it("is well formed: size, viewBox, band word and a clean title", () => {
    for (const p of PLATFORMS) {
      const spec = BOX_PLATFORMS[p];
      const svg = boxArtSvg("Test Cart", p);
      expect(svg.startsWith("<svg ")).toBe(true);
      expect(svg.endsWith("</svg>")).toBe(true);
      expect(svg).toContain(`viewBox="0 0 ${spec.w} ${spec.h}"`);
      expect(svg).toContain(`width="${spec.w}" height="${spec.h}"`);
      expect(svg).toContain(`>${spec.label}</text>`);
      // the title is set clean: no noise filter, a thin round outline under the fill
      expect(svg).not.toContain("<filter");
      expect(svg).not.toContain("<feTurbulence");
      expect(svg).not.toContain("<feDisplacementMap");
      expect(svg).toContain('stroke-linejoin="round"');
      expect(svg).toContain('paint-order="stroke"');
      expect(svg).toContain("TEST CART");
      expect(svg).toContain(`stroke="${TITLE_STROKE}"`);
      expect(svg).toContain(`aria-label="Test Cart, ${spec.label}"`);
    }
  });

  it("scales by width keeping the aspect", () => {
    const svg = boxArtSvg("Test Cart", "gba", { width: 62 });
    expect(svg).toContain('width="62" height="78"');
    expect(svg).toContain('viewBox="0 0 124 156"');
  });

  it("escapes markup in a title, label and caption", () => {
    const svg = boxArtSvg('<b>"A&B"</b>', "snes", { caption: "<i>x</i>" });
    expect(svg).not.toContain("<b>");
    expect(svg).not.toContain("<i>");
    expect(svg).toContain("&lt;B&gt;");
    expect(svg).toContain("&amp;");
    expect(svg).toContain("&lt;i&gt;x&lt;/i&gt;");
  });

  it("draws no caption strip unless asked", () => {
    expect(boxArtSvg("Test Cart", "nes")).not.toContain("font-size=\"8\"");
    expect(boxArtSvg("Test Cart", "nes", { caption: "capa gerada" })).toContain("capa gerada");
  });

  it("has no console logo, trade dress or external reference", () => {
    for (const p of PLATFORMS) {
      const svg = boxArtSvg("Test Cart", p);
      expect(svg).not.toMatch(/<image|href=|<use|url\(http/i);
      expect(svg).not.toMatch(/nintendo|famicom|super nes|game boy advance/i);
    }
  });

  it("has no em dash", () => {
    expect(boxArtSvg("Test Cart", "nes")).not.toContain(String.fromCharCode(0x2014));
  });

  it("copes with the longest title and an empty one", () => {
    const longest = "ABCDEFGHIJKLMNOPQRSTUVWX";
    for (const p of PLATFORMS) {
      expect(boxArtSvg(longest, p)).toContain("<tspan");
      expect(boxArtSvg("", p)).toContain("</svg>");
    }
  });
});

describe("the title's set", () => {
  const strokeOf = (svg: string) => [...svg.matchAll(/font-size="([\d.]+)"[^>]*stroke-width="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])] as const);

  it("has an outline about a tenth of the letter size, never the old fifth", () => {
    for (const p of PLATFORMS) {
      for (const title of ["Test Cart", "Fita sem nome 1", "Super Longo Nome De Fita"]) {
        const pairs = strokeOf(boxArtSvg(title, p));
        expect(pairs.length, title).toBeGreaterThan(0);
        for (const [fs, w] of pairs) expect(w, `${title} on ${p}`).toBeLessThanOrEqual(fs / 10 + 0.01);
      }
    }
  });

  it("tilts by 1.5 degrees at most", () => {
    for (let i = 0; i < 200; i++) {
      const svg = boxArtSvg(`Fixture ${i}`, "nes");
      const tilt = /<g transform="rotate\((-?[\d.]+) /.exec(svg);
      expect(tilt, `Fixture ${i}`).not.toBeNull();
      expect(Math.abs(Number(tilt![1]))).toBeLessThanOrEqual(1.5);
    }
  });
});

describe("wrapTitle", () => {
  it("upper-cases and wraps greedily", () => {
    expect(wrapTitle("fixture quest one")).toEqual(["FIXTURE", "QUEST ONE"]);
  });

  it("cuts a word longer than the limit", () => {
    expect(wrapTitle("ABCDEFGHIJKLMNOPQRSTUVWX")).toEqual(["ABCDEFGHIJK", "LMNOPQRSTUV", "WX"]);
  });

  it("keeps a 24 character title within three lines", () => {
    expect(wrapTitle("A B C D E F G H I J K L").length).toBeLessThanOrEqual(3);
  });
});

describe("fitTitle", () => {
  const TITLES = ["Xadrez NES", "Verde NES", "MMMMMMMMMM", "WWW WWW", "Test Cart", "A", "Super Longo Nome De Fita", "ABCDEFGHIJKLMNOPQRSTUVWX", "Fita sem nome 12"];

  it("keeps every line inside the cover, whatever the letters (a wide one is not an I)", () => {
    for (const platform of PLATFORMS) {
      const { w, h } = BOX_PLATFORMS[platform];
      for (const title of TITLES) {
        const { lines, fs } = fitTitle(title, w, h);
        for (const line of lines) {
          // at the smallest size the rule allows a very long title may not fit; every other one must
          if (fs > 8) expect(titleLineWidth(line, fs), `${title} on ${platform}`).toBeLessThanOrEqual(w - 14 + 0.5);
        }
        expect(fs).toBeLessThanOrEqual(24);
        expect(lines.length * fs * 0.95).toBeLessThanOrEqual(h * 0.3 + 0.5 + (fs === 8 ? 100 : 0));
      }
    }
  });

  it("no longer lets 'XADREZ NES' and 'VERDE NES' run past the edges", () => {
    for (const title of ["Xadrez NES", "Verde NES"]) {
      const { lines, fs } = fitTitle(title, 140, 196);
      expect(Math.max(...lines.map((l) => titleLineWidth(l, fs)))).toBeLessThan(140 - 8);
    }
  });

  it("keeps a short title on one line, as before", () => {
    expect(fitTitle("Test Cart", 140, 196).lines).toEqual(["TEST CART"]);
  });
});

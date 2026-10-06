import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "../locales/en/translation.json";
import es from "../locales/es/translation.json";
import ptBR from "../locales/pt-BR/translation.json";

/**
 * Rafael, 2026-10-05: what people watch together is implied and never said.
 * No film, series, cinema or streaming service in the copy a visitor or a
 * host reads around a watch party, in any language: an ad of ours was refused
 * for exactly that wording, and the product must not suggest showing what a
 * person has no right to show.
 *
 * Covered: the watch party surfaces (`watchParty.*`, the scheduling sheet,
 * the waitlist dialog the /streamers button opens), the two public pages that
 * sell it (`watchPartyPage.*`, `streamersPage.*`), the landing, the campaign
 * page's watch party card, the phone's full-screen hint, and the file names
 * the dialog's illustration is served under. Key NAMES are code and stay as
 * they are (`watchParty.checklist.filmPlaying`); only values are checked.
 *
 * One letter of each word is in brackets so a grep of the repository for
 * these words finds copy, not this guard.
 */
const BANNED =
  /fi[l]me|ci[n]ema|s[ée]ri[e]s?\b|mo[v]ie|fi[l]m|pel[ií]cula|\bpe[l]is?\b|ne[t]flix|di[s]ney/i;

const PREFIXES = [
  "watchParty.",
  "watchPartySchedule.",
  "watchPartyPage.",
  "streamersPage.",
  "landing.",
  "cinemaHint.",
  "vem.features.watch.",
  "voice.notice.voiceTrackNeedsMic",
];

const here = path.dirname(fileURLToPath(import.meta.url));

describe("watch party copy names nothing a person would need the rights to show", () => {
  for (const [locale, catalogue] of [
    ["en", en],
    ["pt-BR", ptBR],
    ["es", es],
  ] as const) {
    it(`in ${locale}`, () => {
      const hits = Object.entries(catalogue as Record<string, string>)
        .filter(([key]) => PREFIXES.some((prefix) => key.startsWith(prefix)))
        .filter(([, value]) => BANNED.test(value))
        .map(([key, value]) => `${key}: ${value}`);
      expect(hits).toEqual([]);
    });
  }

  it("covers the waitlist dialog the /streamers button opens", () => {
    // A guard whose prefix list stopped matching would pass by testing nothing.
    for (const key of [
      "watchParty.waitlist.art.label",
      "watchParty.waitlist.art.title",
      "watchParty.waitlist.feature.camera.body",
      "watchParty.waitlist.form.notePlaceholder",
    ]) {
      expect((en as Record<string, string>)[key], key).toBeTruthy();
      expect(PREFIXES.some((prefix) => key.startsWith(prefix))).toBe(true);
    }
  });

  it("serves the dialog's illustration under a neutral name", () => {
    const images = readdirSync(path.resolve(here, "../../public/images/watch-party"));
    expect(images.length).toBeGreaterThan(0);
    expect(images.filter((name) => BANNED.test(name))).toEqual([]);
    const art = readFileSync(
      path.resolve(here, "../components/watch-party/waitlist/watch-party-stage-art.tsx"),
      "utf8",
    );
    expect(art).toContain("/images/watch-party/stage.webp");
  });
});

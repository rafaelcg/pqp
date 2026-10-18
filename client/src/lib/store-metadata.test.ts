import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The store listings live in the repo as plain text (`ios/app-store/metadata/`
// uploaded by `.github/workflows/ios-store-metadata.yml`, and
// `android/play-listing/` pasted into Play Console by hand). Nothing else
// reads them, so nothing else catches a field that grew past the store's
// limit, a competitor's name that crept back into the keyword field, or a
// "voce" in a pt-BR listing. A store rejects or truncates those silently, days
// after the PR, so this test is the only guard. Limits and rules:
// `docs/STORE_LISTINGS.md` and `docs/ASO.md`.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const iosDir = path.join(repoRoot, "ios/app-store/metadata");
const playDir = path.join(repoRoot, "android/play-listing");

const IOS_LOCALES = ["en-US", "pt-BR", "es-MX"];
const PLAY_LOCALES = ["en-US", "pt-BR", "es-419"];

function read(dir: string, locale: string, file: string): string {
  return readFileSync(path.join(dir, locale, file), "utf8");
}

/** Characters as the stores count them: code points of the NFC form. */
function len(s: string): number {
  return [...s.normalize("NFC")].length;
}

/** Lowercase, accent-free, so "código" and "codigo" count as one word. */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

function words(s: string): string[] {
  return fold(s).match(/[\p{L}\p{N}]+/gu) ?? [];
}

// Other products' names. Apple 2.3.7 bars trademarked terms and popular app
// names from the name, subtitle and keywords; Play's metadata policy bars
// misleading references to other apps. None belongs in a field a store
// indexes or ranks.
const COMPETITOR_NAMES = [
  "discord",
  "teamspeak",
  "guilded",
  "slack",
  "telegram",
  "whatsapp",
  "stoat",
  "fluxer",
  "teleparty",
  "kosmi",
  "skype",
  "zoom",
];

function mentionsCompetitor(s: string): string | undefined {
  const ws = words(s);
  return COMPETITOR_NAMES.find((n) => ws.includes(n));
}

// Rules for every public string, whichever store or locale it is in.
const EM_DASH = new RegExp(String.fromCharCode(0x2014));
const EMOJI = /\p{Extended_Pictographic}/u;
const VOCE = /\bvoc[eê]s?\b/i;
// Topics Rafael ruled out of every marketing surface.
const OFF_LIMITS_TOPIC = /\bANPD\b|suspens|suspend/i;
const SOLO = /\bsolo (dev|developer|founder|maker|project)\b|\bdesenvolvedor solo\b/i;

type Field = { where: string; text: string };

function allFields(): Field[] {
  const out: Field[] = [];
  for (const locale of IOS_LOCALES) {
    for (const file of readdirSync(path.join(iosDir, locale))) {
      out.push({
        where: `ios/${locale}/${file}`,
        text: read(iosDir, locale, file),
      });
    }
  }
  for (const locale of PLAY_LOCALES) {
    for (const file of readdirSync(path.join(playDir, locale))) {
      out.push({
        where: `play/${locale}/${file}`,
        text: read(playDir, locale, file),
      });
    }
  }
  return out;
}

describe("store listing files", () => {
  it("has every managed locale on both stores", () => {
    for (const l of IOS_LOCALES) expect(existsSync(path.join(iosDir, l))).toBe(true);
    for (const l of PLAY_LOCALES) expect(existsSync(path.join(playDir, l))).toBe(true);
    // A locale directory the test does not know about would ship unchecked.
    const iosDirs = readdirSync(iosDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(iosDirs).toEqual([...IOS_LOCALES].sort());
    const playDirs = readdirSync(playDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(playDirs).toEqual([...PLAY_LOCALES].sort());
  });

  it("is free of em dashes, emoji, voce, off-limits topics and 'solo'", () => {
    for (const f of allFields()) {
      expect(EM_DASH.test(f.text), `${f.where} has an em dash`).toBe(false);
      expect(EMOJI.test(f.text), `${f.where} has an emoji`).toBe(false);
      expect(OFF_LIMITS_TOPIC.test(f.text), `${f.where} names an off-limits topic`).toBe(false);
      expect(SOLO.test(f.text), `${f.where} calls pqp solo`).toBe(false);
      if (f.where.includes("/pt-BR/")) {
        expect(VOCE.test(f.text), `${f.where} says voce, pt-BR copy uses tu`).toBe(false);
      }
    }
  });

  it("has no stray whitespace around a single-line field", () => {
    const single = ["name.txt", "subtitle.txt", "keywords.txt", "title.txt", "short_description.txt"];
    for (const f of allFields()) {
      if (!single.some((s) => f.where.endsWith(s))) continue;
      expect(f.text, `${f.where} has leading/trailing whitespace or a newline`).toBe(f.text.trim());
      expect(f.text.includes("\n"), `${f.where} spans lines`).toBe(false);
    }
  });
});

describe("App Store metadata", () => {
  const FILES = [
    "name.txt",
    "subtitle.txt",
    "keywords.txt",
    "promotional_text.txt",
    "description.txt",
    "release_notes.txt",
    "support_url.txt",
    "privacy_url.txt",
  ];

  for (const locale of IOS_LOCALES) {
    describe(locale, () => {
      it("has every managed field", () => {
        for (const f of FILES) {
          expect(existsSync(path.join(iosDir, locale, f)), f).toBe(true);
        }
      });

      it("stays inside Apple's limits", () => {
        expect(len(read(iosDir, locale, "name.txt"))).toBeLessThanOrEqual(30);
        expect(len(read(iosDir, locale, "subtitle.txt"))).toBeLessThanOrEqual(30);
        expect(len(read(iosDir, locale, "keywords.txt"))).toBeLessThanOrEqual(100);
        expect(len(read(iosDir, locale, "promotional_text.txt"))).toBeLessThanOrEqual(170);
        expect(len(read(iosDir, locale, "description.txt"))).toBeLessThanOrEqual(4000);
        expect(len(read(iosDir, locale, "release_notes.txt"))).toBeLessThanOrEqual(4000);
        expect(len(read(iosDir, locale, "name.txt"))).toBeGreaterThan(0);
        expect(len(read(iosDir, locale, "subtitle.txt"))).toBeGreaterThan(0);
      });

      it("names no other product in a field the store indexes or shows first", () => {
        for (const f of ["name.txt", "subtitle.txt", "keywords.txt", "promotional_text.txt"]) {
          expect(
            mentionsCompetitor(read(iosDir, locale, f)),
            `${locale}/${f} names another product`,
          ).toBeUndefined();
        }
      });

      it("writes the keyword field as a clean comma list", () => {
        const kw = read(iosDir, locale, "keywords.txt");
        expect(kw, "no space after a comma").not.toMatch(/\s/);
        const list = kw.split(",");
        expect(list.every((k) => k.length > 0), "no empty entry").toBe(true);

        const folded = list.map(fold);
        expect(new Set(folded).size, "no duplicate keyword").toBe(folded.length);

        // Apple indexes name + subtitle + keywords as one bag of words, so a
        // word spent in the name or subtitle is wasted in the keyword field.
        const spent = new Set([
          ...words(read(iosDir, locale, "name.txt")),
          ...words(read(iosDir, locale, "subtitle.txt")),
        ]);
        for (const k of folded) {
          expect(spent.has(k), `"${k}" is already in the name or subtitle`).toBe(false);
        }

        // Apple matches singular and plural, so listing both wastes the second.
        const all = [...folded, ...spent];
        for (const a of all) {
          for (const b of all) {
            if (a === b) continue;
            expect(
              a === b + "s" || a === b + "es",
              `"${a}" and "${b}" are singular and plural of one word`,
            ).toBe(false);
          }
        }
      });
    });
  }
});

describe("Google Play listing", () => {
  for (const locale of PLAY_LOCALES) {
    describe(locale, () => {
      it("stays inside Play's limits", () => {
        const title = read(playDir, locale, "title.txt");
        const short = read(playDir, locale, "short_description.txt");
        const full = read(playDir, locale, "full_description.txt");
        expect(len(title)).toBeGreaterThan(0);
        expect(len(title)).toBeLessThanOrEqual(30);
        expect(len(short)).toBeGreaterThan(0);
        expect(len(short)).toBeLessThanOrEqual(80);
        expect(len(full)).toBeLessThanOrEqual(4000);
      });

      it("names no other product in the title or short description", () => {
        for (const f of ["title.txt", "short_description.txt"]) {
          expect(
            mentionsCompetitor(read(playDir, locale, f)),
            `${locale}/${f} names another product`,
          ).toBeUndefined();
        }
      });
    });
  }
});

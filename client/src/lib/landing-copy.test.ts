import { describe, expect, it } from "vitest";
import INDEX_HTML from "../../index.html?raw";
import en from "../locales/en/translation.json";
import es from "../locales/es/translation.json";
import ptBR from "../locales/pt-BR/translation.json";
import SITEMAP from "../../public/sitemap.xml?raw";
/**
 * What the home page is allowed to say, pinned where it was found wrong by the
 * 2026-09-30 reviews. Each of these is a claim that was false, stale or
 * missing in one language and fine in another, which is the shape a catalogue
 * drifts in.
 *
 * The page at "/" is made of `home.*` keys. Two `landing.*` keys outlive the
 * old landing on purpose, `landing.seo.title` and `landing.seo.description`,
 * because `index.html` and `PAGE_COPY["/"]` pin them. Every check below is
 * written against the claim (a word that must be there, or must not be), never
 * against the exact sentence, so a copy pass can reword freely.
 */

const catalogues = { "pt-BR": ptBR, en, es } as const;
type Locale = keyof typeof catalogues;
const locales = Object.keys(catalogues) as Locale[];
const get = (locale: Locale, key: string): string => {
  const value = (catalogues[locale] as Record<string, string>)[key];
  if (value === undefined) throw new Error(`${locale} is missing ${key}`);
  return value;
};

/** Every `home.*` key with its value: the copy the page at "/" is made of. */
const homeEntries = (locale: Locale): [string, string][] =>
  Object.entries(catalogues[locale] as Record<string, string>).filter(([key]) =>
    key.startsWith("home."),
  );

/** The `{slot}` names in a value, sorted, so two languages compare by what they fill. */
const slots = (value: string): string[] => (value.match(/\{\w+\}/g) ?? []).sort();

/**
 * The seven questions on the page, in page order (`perguntas.tsx`). The FAQ
 * JSON-LD for "/" is built from these, so a question added to the catalogue
 * without the page (or the other way round) is a drift this file names.
 */
const FAQ_IDS = ["friends", "history", "free", "phone", "install", "data", "future"] as const;

/**
 * Questions the catalogue carries but the page asks only behind a launch
 * switch: `bot` shows (after `data`) only while `serverBotClaims()` in
 * `lib/server-bots-launch.ts` is not null, and so does its JSON-LD twin
 * (`landingFaq` in `lib/marketing-meta.ts`). `bots-claims.test.tsx` drives
 * both states. Its answer is two catalogue sentences joined at render: one of
 * `.a.actions` / `.a.replies`, then one of `.a.gradual` / `.a.everyone`.
 */
const GATED_FAQ_IDS = ["bot"] as const;
const GATED_FAQ_KEYS: Record<(typeof GATED_FAQ_IDS)[number], string[]> = {
  bot: [
    "home.faq.bot.q",
    "home.faq.bot.a.actions",
    "home.faq.bot.a.replies",
    "home.faq.bot.a.gradual",
    "home.faq.bot.a.everyone",
  ],
};

describe("landing search snippet", () => {
  for (const locale of locales) {
    it(`${locale}: title fits a result line and the description is not cut`, () => {
      expect(get(locale, "landing.seo.title").length).toBeLessThanOrEqual(60);
      expect(get(locale, "landing.seo.description").length).toBeLessThanOrEqual(158);
    });
  }

  it("index.html (English) says what the English catalogue says", () => {
    expect(INDEX_HTML).toContain(
      `<title>${en["landing.seo.title"]}</title>`,
    );
    expect(INDEX_HTML).toContain(en["landing.seo.description"]);
  });
});

describe("home claims", () => {
  it("never promises sound on every share, in any language", () => {
    // Hero, SEO and the screen beat's headline said "with sound" flat out;
    // sound is a Chrome/Edge tab, or the whole computer on Windows 11 in the
    // desktop app (docs/DESKTOP.md). The caveat lives in
    // `home.night.share.note` and `home.limits.sound.body`.
    for (const locale of locales) {
      for (const key of [
        "home.hero.body",
        "landing.seo.description",
        "home.night.share.title",
      ]) {
        expect(get(locale, key), `${locale} ${key}`).not.toMatch(
          /com som\b|with sound|con sonido/i,
        );
      }
      for (const key of ["home.night.share.note", "home.limits.sound.body"]) {
        expect(get(locale, key), `${locale} ${key}`).toMatch(/Windows 11/);
      }
    }
  });

  it("calls the watch party early access next to the number", () => {
    // The 100+ figure and its label live together in the night's watch party
    // beat. The hero no longer names watch parties, so the figure cannot
    // drift back there without the label.
    expect(get("pt-BR", "home.night.party.access")).toMatch(/acesso antecipado/);
    expect(get("en", "home.night.party.access")).toMatch(/early access/i);
    expect(get("es", "home.night.party.access")).toMatch(/acceso anticipado/i);
    for (const locale of locales) {
      expect(get(locale, "home.night.party.proof"), locale).toMatch(/100/);
      expect(get(locale, "home.hero.body"), `${locale} hero body`).not.toMatch(/\b100\b|\bcem\b/i);
    }
  });

  it("says no card is needed, in all three languages", () => {
    // The free line reads "De graça, sem cartão." after the hero's buttons.
    expect(get("pt-BR", "home.cta.free")).toMatch(/sem cartão/i);
    expect(get("en", "home.cta.free")).toMatch(/no card/i);
    expect(get("es", "home.cta.free")).toMatch(/sin tarjeta/i);
  });

  it("does not talk about Discord's suspension anywhere on the home page", () => {
    // pqp-stay-away-from-discord-ban-topic: en and es never had it, pt-BR did.
    // It used to be pinned on one key; the page has hundreds of values now,
    // and any of them could carry it.
    for (const locale of locales) {
      const hits = [
        ...homeEntries(locale),
        ...Object.entries(catalogues[locale] as Record<string, string>).filter(([key]) =>
          key.startsWith("landing."),
        ),
      ]
        .filter(([, value]) => /17 de agosto|17 August|suspens|suspend/i.test(value))
        .map(([key]) => key);
      expect(hits, locale).toEqual([]);
    }
  });

  it("names Twitch next to the ways to sign up", () => {
    // The FAQ half of this guard is retired with the sign-in question
    // (it left the FAQ, decision 40): the providers live in `home.cta.providers`.
    for (const locale of locales) {
      expect(get(locale, "home.cta.providers"), locale).toMatch(/Twitch/);
    }
  });

  it("keeps the ban out of the footer link to /tela too", () => {
    for (const locale of locales) {
      expect(get(locale, "footer.tela"), locale).not.toMatch(/Brasil|Brazil/);
    }
  });

  it("says who makes it, in all three languages", () => {
    expect(ptBR["footer.madeBy"]).toMatch(/dois irmãos/);
    expect(en["footer.madeBy"]).toMatch(/two brothers/);
    expect(es["footer.madeBy"]).toMatch(/dos hermanos/);
  });

  it("does not describe the Google Ads tag as cookie-less", () => {
    for (const locale of locales) {
      expect(get(locale, "home.faq.data.a"), locale).toMatch(/cookies/);
    }
  });

  it("states no hosting cost anywhere on the home page", () => {
    // André, October 17, 2026: the hosted service's monthly cost is not
    // disclosed on "/". The gated "support pqp" link stays; a figure does not.
    // A price needs a money marker: a currency sign, a currency word after a
    // number, or a number per month. "Once a month" alone is not a cost (the
    // handle can be renamed once every 30 days).
    const COST =
      /R\$|US\$|\$\s?\d|€|£|\d\s?(reais|dollars?|dólares|euros?|USD|BRL)\b|\d[\d.,]*\s*(\/|per|por|al)\s*(mês|mes|month|mo)\b/i;
    for (const locale of locales) {
      const hits = homeEntries(locale)
        .filter(([, value]) => COST.test(value))
        .map(([key]) => key);
      expect(hits, locale).toEqual([]);
    }
  });

  it("names no sample person after one of the brothers", () => {
    // André, October 17, 2026: nobody may mistake a sample person for Rafael
    // or André. Their own names belong to the brothers block alone
    // (`home.code.makers.*`, filled from slots). `\b` is ASCII-only in
    // JavaScript, so it cannot see the edge of "André"; the boundaries are
    // Unicode letter lookarounds instead.
    const BROTHERS = /(?<!\p{L})(?:Rafa|Rafael|Andr[eé])(?!\p{L})/u;
    for (const locale of locales) {
      const hits = homeEntries(locale)
        .filter(([key]) => !key.startsWith("home.code.makers."))
        .filter(([, value]) => BROTHERS.test(value))
        .map(([key]) => key);
      expect(hits, locale).toEqual([]);
    }
  });
});

/**
 * The shapes other code depends on. The h1 is printed twice (the live hero
 * and the static first screen in `index.html`), and both must fill the same
 * one slot; the status strip fills one age; the FAQ is the page's seven
 * questions in plain text because the search snippet serves the same words.
 */
describe("home keys other code depends on", () => {
  it("keeps the h1 to exactly one {accent} slot, in every language", () => {
    for (const locale of locales) {
      expect(slots(get(locale, "home.hero.title")), `${locale} home.hero.title`).toEqual(["{accent}"]);
      const accent = get(locale, "home.hero.titleAccent");
      expect(accent.trim().length, `${locale} home.hero.titleAccent`).toBeGreaterThan(0);
      expect(slots(accent), `${locale} home.hero.titleAccent slots`).toEqual([]);
    }
  });

  it("fills the status strip's age through exactly one {age} slot", () => {
    for (const locale of locales) {
      expect(slots(get(locale, "home.where.checked")), locale).toEqual(["{age}"]);
    }
  });

  it("has the seven FAQ questions plus the gated ones, and only those, in every language", () => {
    for (const locale of locales) {
      const ids = homeEntries(locale)
        .map(([key]) => /^home\.faq\.([a-z]+)\.q$/.exec(key)?.[1])
        .filter((id): id is string => id !== undefined)
        .sort();
      expect(ids, locale).toEqual([...FAQ_IDS, ...GATED_FAQ_IDS].sort());
    }
  });

  it("writes every FAQ question and answer as plain text", () => {
    // The JSON-LD answer is the visible answer, character for character, so
    // neither may carry a slot or markup. A link goes on its own line
    // (`home.faq.<id>.link`), not inside the answer.
    const MARKUP = /\{\w+\}|<[a-z/][^>]*>|\]\(|\*\*|`/i;
    for (const locale of locales) {
      const keySets = [
        ...FAQ_IDS.map((id) => [
          `home.faq.${id}.q`,
          `home.faq.${id}.a`,
          ...(id === "phone" ? ["home.faq.phone.a.play"] : []),
        ]),
        ...GATED_FAQ_IDS.map((id) => GATED_FAQ_KEYS[id]),
      ];
      for (const key of keySets.flat()) {
        const value = get(locale, key);
        expect(value.trim().length, `${locale} ${key}`).toBeGreaterThan(0);
        expect(value, `${locale} ${key}`).not.toMatch(MARKUP);
      }
      // A gated answer's sentences are joined with one space, so each must be
      // a whole sentence with no padding of its own.
      for (const key of GATED_FAQ_KEYS.bot.slice(1)) {
        const value = get(locale, key);
        expect(value, `${locale} ${key}`).toBe(value.trim());
        expect(value, `${locale} ${key}`).toMatch(/[.!?]$/);
      }
    }
  });
});

describe("sitemap dates", () => {
  it("dates the legal pages with the date the documents themselves carry", () => {
    const lastmod = (path: string) =>
      new RegExp(
        `<loc>https://pqp\\.gg${path}</loc>\\s*<lastmod>([^<]+)</lastmod>`,
      ).exec(SITEMAP)?.[1];
    expect(lastmod("/privacy")).toBe("2026-09-29");
    expect(lastmod("/terms")).toBe("2026-09-27");
    expect(lastmod("/cookies")).toBe("2026-09-29");
  });
});

import { describe, expect, it } from "vitest";
import INDEX_HTML from "../../index.html?raw";
import en from "../locales/en/translation.json";
import es from "../locales/es/translation.json";
import ptBR from "../locales/pt-BR/translation.json";
import SITEMAP from "../../public/sitemap.xml?raw";
import LLMS from "../../public/llms.txt?raw";
import LLMS_FULL from "../../public/llms-full.txt?raw";
import INDEX_MD from "../../public/index.md?raw";

/**
 * What the home page is allowed to say, pinned where it was found wrong by the
 * 2026-09-30 reviews. Each of these is a claim that was false, stale or
 * missing in one language and fine in another, which is the shape a catalogue
 * drifts in.
 */

const catalogues = { "pt-BR": ptBR, en, es } as const;
const get = (locale: keyof typeof catalogues, key: string): string =>
  (catalogues[locale] as Record<string, string>)[key]!;

describe("landing search snippet", () => {
  for (const locale of Object.keys(catalogues) as (keyof typeof catalogues)[]) {
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

describe("landing claims", () => {
  it("never promises sound on every share, in any language", () => {
    // Hero, SEO and the screen pillar's headline said "with sound" flat out;
    // sound is a Chrome/Edge tab, or the whole computer on Windows 11 in the
    // desktop app (docs/DESKTOP.md). The caveat lives in `landing.screen.note`.
    for (const locale of Object.keys(catalogues) as (keyof typeof catalogues)[]) {
      for (const key of [
        "landing.hero.body",
        "landing.seo.description",
        "landing.screen.title",
      ]) {
        expect(get(locale, key), `${locale} ${key}`).not.toMatch(
          /com som\b|with sound|con sonido/i,
        );
      }
    }
    expect(get("en", "landing.screen.note")).toMatch(/Windows 11/);
    expect(get("pt-BR", "landing.screen.note")).toMatch(/Windows 11/);
    expect(get("es", "landing.screen.note")).toMatch(/Windows 11/);
  });

  it("calls the watch party early access next to the number", () => {
    expect(get("pt-BR", "landing.hero.body")).toMatch(/acesso antecipado/);
    expect(get("en", "landing.hero.body")).toMatch(/early access/);
    expect(get("es", "landing.hero.body")).toMatch(/acceso anticipado/);
  });

  it("says no card is needed in Portuguese too", () => {
    expect(ptBR["landing.hero.eyebrow"]).toMatch(/Sem cartão/);
    expect(en["landing.hero.eyebrow"]).toMatch(/No card/);
    expect(es["landing.hero.eyebrow"]).toMatch(/Sin tarjeta/);
  });

  it("does not talk about Discord's suspension on the home page", () => {
    // pqp-stay-away-from-discord-ban-topic: en and es never had it, pt-BR did.
    for (const locale of Object.keys(catalogues) as (keyof typeof catalogues)[]) {
      const body = get(locale, "landing.discord.screen.body");
      expect(body).not.toMatch(/17 de agosto|17 August|suspens|suspend/i);
    }
  });

  it("names Twitch next to the ways to sign up, in the hero and the FAQ", () => {
    for (const locale of Object.keys(catalogues) as (keyof typeof catalogues)[]) {
      expect(get(locale, "landing.hero.providers"), locale).toMatch(/Twitch/);
      expect(get(locale, "landing.faq.signin.a"), locale).toMatch(/Twitch/);
    }
  });

  it("keeps the ban out of the footer link to /tela too", () => {
    for (const locale of Object.keys(catalogues) as (keyof typeof catalogues)[]) {
      expect(get(locale, "footer.tela"), locale).not.toMatch(/Brasil|Brazil/);
    }
  });

  it("says who makes it, in all three languages", () => {
    expect(ptBR["footer.madeBy"]).toMatch(/dois irmãos/);
    expect(en["footer.madeBy"]).toMatch(/two brothers/);
    expect(es["footer.madeBy"]).toMatch(/dos hermanos/);
  });

  it("does not describe the Google Ads tag as cookie-less", () => {
    for (const locale of Object.keys(catalogues) as (keyof typeof catalogues)[]) {
      expect(get(locale, "landing.faq.data.a")).toMatch(/cookies/);
    }
  });
});

describe("Android wording", () => {
  it("the /android copy no longer says a large-room share is missing", () => {
    for (const locale of Object.keys(catalogues) as (keyof typeof catalogues)[]) {
      expect(get(locale, "androidPage.notYet")).not.toMatch(
        /sala grande|large room/i,
      );
      expect(get(locale, "androidPage.version")).not.toMatch(/0\.4\.0/);
    }
  });

  it("the machine-readable summaries say Google Play, not an APK beta", () => {
    for (const text of [LLMS, LLMS_FULL, INDEX_MD]) {
      expect(text).toMatch(/Google Play/);
      expect(text).not.toMatch(/APK beta|Android beta/);
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

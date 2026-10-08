import { validateHandle } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import REDIRECTS from "../../public/_redirects?raw";
import ROBOTS from "../../public/robots.txt?raw";
import SITEMAP from "../../public/sitemap.xml?raw";
import LLMS from "../../public/llms.txt?raw";
import mainSource from "../main.tsx?raw";
import en from "../locales/en/translation.json";
import es from "../locales/es/translation.json";
import ptBR from "../locales/pt-BR/translation.json";

/**
 * What the site says about who is behind pqp, and the plumbing that carries it.
 *
 * The decision behind the copy: pqp may say it is made by two brothers and give
 * one address. It names no person, no country and no address, and it says it is
 * independent. This file is the guard on that decision, in all three languages.
 * The brackets in the patterns keep a grep of the repository for these words
 * pointed at copy, not at this guard.
 */

const CATALOGUES = { en, "pt-BR": ptBR, es } as const;

/** Every value this change adds or rewrites. */
const KEYS = [
  "contactPage.seo.title",
  "contactPage.seo.description",
  "contactPage.eyebrow",
  "contactPage.title",
  "contactPage.lead",
  "contactPage.who.title",
  "contactPage.who.body",
  "contactPage.contact.title",
  "contactPage.contact.body",
  "contactPage.independent.title",
  "contactPage.independent.body",
  "contactPage.links.title",
  "footer.copyright",
  "footer.madeBy",
  "footer.independent",
] as const;

function values(locale: keyof typeof CATALOGUES): [string, string][] {
  const catalogue = CATALOGUES[locale] as Record<string, string>;
  return KEYS.map((key) => [key, catalogue[key]!]);
}

describe("the copy about who makes pqp", () => {
  for (const locale of Object.keys(CATALOGUES) as (keyof typeof CATALOGUES)[]) {
    describe(locale, () => {
      it("has every string", () => {
        for (const [key, value] of values(locale)) {
          expect(value, key).toBeTruthy();
        }
      });

      it("names nothing a person would need the rights to show", () => {
        const banned =
          /fi[l]me|ci[n]ema|s[ée]ri[e]s?\b|mo[v]ie|fi[l]m|pel[ií]cula|\bpe[l]is?\b|ne[t]flix|di[s]ney/i;
        const hits = values(locale).filter(([, v]) => banned.test(v));
        expect(hits).toEqual([]);
      });

      it("names no person, no country and no company other than the one it disowns", () => {
        const identifying =
          /rafael|andr[eé]|cammarano|guglielmi|brasil|brazil|reino unido|united kingdom|\bUK\b|england|inglaterra|portugal|\bltd\b|\bllc\b|\binc\b/i;
        const hits = values(locale).filter(([, v]) => identifying.test(v));
        expect(hits).toEqual([]);
      });

      it("has no em dash and no en dash", () => {
        expect(values(locale).filter(([, v]) => /[\u2014\u2013]/.test(v))).toEqual([]);
      });

      it("never calls the project a one-person effort", () => {
        // `solo` is an ordinary Spanish word, so it is only checked elsewhere.
        const pattern = locale === "es" ? /una sola persona|one person/i : /\bsolo\b|one person|uma pessoa/i;
        expect(values(locale).filter(([, v]) => pattern.test(v))).toEqual([]);
      });

      it("says two brothers, and says it is independent of Discord and any other company", () => {
        const c = CATALOGUES[locale] as Record<string, string>;
        const brothers = { en: /two brothers/, "pt-BR": /dois irmãos/, es: /dos hermanos/ }[locale];
        expect(c["contactPage.who.body"]).toMatch(brothers);
        expect(c["footer.madeBy"]).toMatch(brothers);
        for (const key of ["contactPage.independent.body", "footer.independent"]) {
          expect(c[key], key).toMatch(/independ/i);
          expect(c[key], key).toContain("Discord");
        }
      });
    });
  }

  it("says the independence sentence the brief asked for, in Portuguese", () => {
    expect(ptBR["contactPage.independent.body"]).toBe(
      "O pqp é um projeto independente e não é afiliado ao Discord nem a nenhuma outra empresa.",
    );
  });
});

describe("the plumbing of /contact and /vem/gratis", () => {
  it("reserves both spellings (and /about) so nobody can hold them as a handle", () => {
    for (const word of ["contact", "contato", "about"]) {
      expect(validateHandle(word), word).toBe("reserved");
    }
  });

  it("routes both spellings to the page", () => {
    expect(mainSource).toMatch(/path="\/contact"\s+element=\{<ContactPage \/>\}/);
    expect(mainSource).toMatch(/path="\/contato"\s+element=\{<ContactPage \/>\}/);
  });

  it("is in the sitemap, robots.txt and llms.txt", () => {
    expect(SITEMAP).toContain("<loc>https://pqp.gg/contact</loc>");
    // /contato is an alias that canonicalises to /contact, so it is not listed.
    expect(SITEMAP).not.toContain("https://pqp.gg/contato");
    expect(ROBOTS).toMatch(/^Allow: \/contact$/m);
    expect(ROBOTS).toMatch(/^Allow: \/contato$/m);
    expect(LLMS).toContain("https://pqp.gg/contact");
  });

  it("redirects /vem/gratis to /vem with a 301 that adds no query of its own", () => {
    // No query in the destination is what lets Pages carry the visitor's own
    // (`?lang=es`, campaign tags) across; a destination with one would not.
    expect(REDIRECTS).toMatch(/^\/vem\/gratis\s+\/vem\s+301$/m);
    expect(REDIRECTS).toMatch(/^\/vem\/gratis\/\s+\/vem\s+301$/m);
    expect(REDIRECTS).not.toMatch(/^\/vem\/gratis\S*\s+\S*\?/m);
    // The SPA catch-all stays last, and /vem itself is untouched.
    expect(REDIRECTS.trimEnd().endsWith("/*    /index.html   200")).toBe(true);
    expect(REDIRECTS).not.toMatch(/^\/vem\s/m);
  });

  it("redirects /vem/gratis in the router too, keeping search and hash", () => {
    expect(mainSource).toMatch(/path="\/vem\/gratis"\s+element=\{<VemGratisRedirect \/>\}/);
    expect(mainSource).toMatch(
      /<Navigate to=\{\{ pathname: "\/vem", search, hash \}\} replace \/>/,
    );
  });
});

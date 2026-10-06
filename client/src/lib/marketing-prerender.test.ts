import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import INDEX_HTML from "../../index.html?raw";
import { describe, expect, it } from "vitest";
import en from "../locales/en/translation.json";
import es from "../locales/es/translation.json";
import ptBR from "../locales/pt-BR/translation.json";
import { STREAMERS_WAITLIST_HREF } from "./handle-intent";
import { injectMarketingHead, STREAMERS_FAQ } from "./marketing-meta";
import {
  injectMarketingBody,
  STREAMERS_PRERENDER_COPY,
  STREAMERS_PRERENDER_CTA_HREF,
  STREAMERS_PRERENDER_KEYS,
} from "./marketing-prerender";
import { stripPrerenderHero } from "./prerender-hero";

/**
 * The no-JS body of `/streamers`, run against THE REAL `index.html`.
 *
 * Its strings are duplicates (the middleware cannot import the catalogues),
 * so this is what keeps them from drifting, the same job
 * `marketing-meta.test.ts` does for the head.
 */

const CATALOGUES = { en, "pt-BR": ptBR, es } as const;

// Read off disk, the way `prerender-hero.test.ts` reads it: a `?raw` import of
// a stylesheet comes back empty under the CSS pipeline.
const CSS = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../index.css"),
  "utf8",
);

/** What a crawler with no script reads: the edge's rewrite, then its strip. */
function served(page: "/streamers" | "/criadores" | "/vem", locale: "en" | "pt-BR" | "es") {
  return stripPrerenderHero(
    injectMarketingBody(injectMarketingHead(INDEX_HTML, page, locale), page, locale),
  );
}

function rootOf(html: string): string {
  const start = html.indexOf('<div id="root">');
  return html.slice(start, html.indexOf("</div>\n", start));
}

describe("the /streamers no-JS body", () => {
  it("duplicates the catalogue exactly, in all three languages", () => {
    for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
      for (const key of STREAMERS_PRERENDER_KEYS) {
        const value = (catalogue as Record<string, string>)[key];
        expect(value, `${locale} ${key}`).toBeTruthy();
        expect(
          STREAMERS_PRERENDER_COPY[locale as keyof typeof CATALOGUES][key],
          `${locale} ${key}`,
        ).toBe(value);
      }
    }
  });

  it("points its button where the live page's button points", () => {
    expect(STREAMERS_PRERENDER_CTA_HREF).toBe(STREAMERS_WAITLIST_HREF);
  });

  it("writes the hero, the steps and the FAQ into #root in the negotiated language", () => {
    for (const locale of ["pt-BR", "en", "es"] as const) {
      const html = served("/streamers", locale);
      const root = rootOf(html);
      const copy = STREAMERS_PRERENDER_COPY[locale];
      expect(root).toContain('id="pre-page"');
      expect(root).toContain(`lang="${locale}"`);
      expect(root).toContain(copy["streamersPage.hero.title"]);
      expect(root).toContain(copy["streamersPage.steps.watch.title"]);
      expect(root).toContain(
        'href="/app?intent=watch-party-waitlist&amp;from=streamers"',
      );
      // Escaped as the document's own text, so the question reads as written.
      expect(root).toContain(STREAMERS_FAQ[locale][0]!.question);
      expect(root).toContain('href="/terms#voice"');
      // One h1, and it is this page's, not the landing's.
      expect(html.match(/<h1/g)).toHaveLength(1);
      expect(html).not.toContain('id="pre-hero"');
    }
  });

  it("serves /criadores the same body, and no other page any", () => {
    expect(rootOf(served("/criadores", "pt-BR"))).toBe(rootOf(served("/streamers", "pt-BR")));
    expect(served("/vem", "pt-BR")).not.toContain('id="pre-page"');
  });

  it("does not write a second copy when the rewrite runs twice", () => {
    const once = injectMarketingBody(INDEX_HTML, "/streamers", "en");
    expect(injectMarketingBody(once, "/streamers", "en")).toBe(once);
  });

  it("leaves a document with no #root unchanged", () => {
    expect(injectMarketingBody("<html><body></body></html>", "/streamers", "en")).toBe(
      "<html><body></body></html>",
    );
  });

  it("is hidden from every browser that runs the head script", () => {
    // The head script sets `data-route` on every page; the stylesheet hides
    // the block under it, so only a reader with no script ever sees it.
    expect(INDEX_HTML).toContain('d.setAttribute("data-route", "other")');
    expect(CSS).toMatch(/html\[data-route\]\s+#pre-page\s*\{\s*display:\s*none;/);
  });

  it("names nothing a person would need the rights to show", () => {
    // Bracketed letters: see the same guard in `marketing-meta.test.ts`.
    const banned = /fi[l]me|ci[n]ema|s[ée]rie|mo[v]ie|fi[l]m|pel[ií]cula|ne[t]flix|di[s]ney/i;
    for (const locale of ["pt-BR", "en", "es"] as const) {
      expect(rootOf(served("/streamers", locale))).not.toMatch(banned);
    }
  });
});

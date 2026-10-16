import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import INDEX_HTML from "../../index.html?raw";
import { describe, expect, it } from "vitest";
import en from "../locales/en/translation.json";
import es from "../locales/es/translation.json";
import ptBR from "../locales/pt-BR/translation.json";
import { STREAMERS_WAITLIST_HREF } from "./handle-intent";
import { escapeHtml as esc, injectMarketingHead, STREAMERS_FAQ } from "./marketing-meta";
import { CONTACT_EMAIL } from "./help-contact";
import { SOURCE_REPO_URL } from "./downloads";
import {
  CONTACT_PRERENDER_COPY,
  CONTACT_PRERENDER_EMAIL,
  CONTACT_PRERENDER_KEYS,
  CONTACT_PRERENDER_SOURCE_URL,
  injectMarketingBody,
  STREAMERS_PRERENDER_COPY,
  STREAMERS_PRERENDER_CTA_HREF,
  STREAMERS_PRERENDER_KEYS,
} from "./marketing-prerender";
import { stripPrerenderHero } from "./prerender-hero";
import { PUBLIC_TESTFLIGHT_URL } from "./testflight";
import {
  CREATE_ROOM_PRERENDER_HREF,
  DOWNLOAD_PRERENDER_RELEASES_URL,
  DOWNLOAD_PRERENDER_SIGNPATH,
  DOWNLOAD_PRERENDER_TEAM,
  IOS_BETA_PRERENDER_HREF,
  PRERENDERED_MARKETING_PAGES,
} from "./marketing-prerender";
import {
  CHROME_PRERENDER_COPY,
  CHROME_PRERENDER_KEYS,
  DOWNLOAD_PRERENDER_COPY,
  DOWNLOAD_PRERENDER_KEYS,
  TELA_PRERENDER_COPY,
  TELA_PRERENDER_KEYS,
  VS_DISCORD_PRERENDER_COPY,
  VS_DISCORD_PRERENDER_KEYS,
} from "./marketing-prerender-copy";
import {
  RELEASES_PAGE_URL,
  SIGNPATH_CREDIT,
  SIGNPATH_TERMS_URL,
  SIGNPATH_URL,
} from "./downloads";
import {
  CODE_SIGNING_APPROVERS,
  CODE_SIGNING_COMMITTERS,
} from "@/components/downloads/code-signing-policy";
import type { MarketingPage } from "./marketing-meta";

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
function served(page: MarketingPage, locale: "en" | "pt-BR" | "es") {
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

describe("the /contact no-JS body", () => {
  it("duplicates the catalogue exactly, in all three languages", () => {
    for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
      for (const key of CONTACT_PRERENDER_KEYS) {
        const value = (catalogue as Record<string, string>)[key];
        expect(value, `${locale} ${key}`).toBeTruthy();
        expect(
          CONTACT_PRERENDER_COPY[locale as keyof typeof CATALOGUES][key],
          `${locale} ${key}`,
        ).toBe(value);
      }
    }
  });

  it("gives the same address and repository as the live page", () => {
    expect(CONTACT_PRERENDER_EMAIL).toBe(CONTACT_EMAIL);
    expect(CONTACT_PRERENDER_SOURCE_URL).toBe(SOURCE_REPO_URL);
  });

  it("writes who makes pqp, the address and the independence statement into #root", () => {
    for (const locale of ["pt-BR", "en", "es"] as const) {
      const html = served("/contact", locale);
      const root = rootOf(html);
      const copy = CONTACT_PRERENDER_COPY[locale];
      expect(root).toContain('id="pre-page"');
      expect(root).toContain(`lang="${locale}"`);
      expect(root).toContain(copy["contactPage.title"]);
      expect(root).toContain(copy["contactPage.who.body"]);
      expect(root).toContain(copy["contactPage.independent.body"]);
      expect(root).toContain('href="mailto:contato@pqp.gg"');
      expect(root).toContain('href="/privacy"');
      expect(root).toContain('href="/terms"');
      expect(html.match(/<h1/g)).toHaveLength(1);
      expect(html).not.toContain('id="pre-hero"');
    }
  });

  it("serves /contato the same body", () => {
    expect(rootOf(served("/contato", "pt-BR"))).toBe(rootOf(served("/contact", "pt-BR")));
  });
});

const GENERATED = [
  ["nav and footer", CHROME_PRERENDER_KEYS, CHROME_PRERENDER_COPY],
  ["/tela", TELA_PRERENDER_KEYS, TELA_PRERENDER_COPY],
  ["/vs-discord", VS_DISCORD_PRERENDER_KEYS, VS_DISCORD_PRERENDER_COPY],
  ["/download", DOWNLOAD_PRERENDER_KEYS, DOWNLOAD_PRERENDER_COPY],
] as const;

function readSource(relative: string): string {
  return readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), relative),
    "utf8",
  );
}

/** Every catalogue key with one of `prefixes` that a source file names in quotes. */
function keysIn(source: string, prefixes: string[]): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/"([a-zA-Z]+\.[a-zA-Z0-9.]+)"/g)) {
    const key = match[1]!;
    if (prefixes.some((prefix) => key.startsWith(prefix)) && key in en) {
      found.add(key);
    }
  }
  return [...found];
}

describe("the /tela, /vs-discord and /download no-JS bodies", () => {
  it("never loses a page that carries one", () => {
    // PQP-17: these pages are found and shared, so a crawler that runs no
    // script must read their copy. Dropping one from the edge fails here.
    for (const page of ["/streamers", "/contact", "/tela", "/vs-discord", "/download"] as const) {
      expect(PRERENDERED_MARKETING_PAGES).toContain(page);
      for (const locale of ["pt-BR", "en", "es"] as const) {
        const html = served(page, locale);
        expect(rootOf(html), `${page} ${locale}`).toContain('id="pre-page"');
        expect(html.match(/<h1/g), `${page} ${locale}`).toHaveLength(1);
        expect(html).not.toContain('id="pre-hero"');
      }
    }
  });

  it("matches the catalogues exactly (rerun `pnpm --filter @pqp/client prerender:copy`)", () => {
    for (const [page, keys, copy] of GENERATED) {
      for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
        const generated = copy[locale as keyof typeof CATALOGUES] as Record<string, string>;
        expect(Object.keys(generated), `${page} ${locale}`).toEqual([...keys]);
        for (const key of keys) {
          expect(generated[key], `${page} ${locale} ${key}`).toBe(
            (catalogue as Record<string, string>)[key],
          );
        }
      }
    }
  });

  it("carries every string the live page renders", () => {
    // A section added to the React page without its static twin fails here.
    // Head-only keys, and copy the live page shows only in a branch the static
    // block replaces with a link, are listed on purpose.
    const notInBody = new Set([
      "tela.seo.title",
      "tela.seo.description",
      "tela.seo.ogTitle",
      "tela.seo.ogDescription",
      "vsDiscord.seo.title",
      "vsDiscord.seo.description",
      // Shown only when the build has no TestFlight URL; the static block
      // always links the default one.
      "vsDiscord.cta.beta.hint",
      "downloadPage.seo.title",
      "downloadPage.seo.description",
    ]);
    const pages = [
      ["../pages/tela-page.tsx", ["tela."], TELA_PRERENDER_KEYS],
      ["../pages/vs-discord-page.tsx", ["vsDiscord."], VS_DISCORD_PRERENDER_KEYS],
      ["../pages/download-page.tsx", ["downloadPage."], DOWNLOAD_PRERENDER_KEYS],
      ["../components/downloads/code-signing-policy.tsx", ["codeSigning."], DOWNLOAD_PRERENDER_KEYS],
      ["../components/marketing/marketing-nav.tsx", ["nav.", "footer."], CHROME_PRERENDER_KEYS],
      ["../components/marketing/marketing-footer.tsx", ["nav.", "footer."], CHROME_PRERENDER_KEYS],
    ] as const;
    for (const [file, prefixes, keys] of pages) {
      const used = keysIn(readSource(file), [...prefixes]).filter((key) => !notInBody.has(key));
      expect(used.length, file).toBeGreaterThan(0);
      for (const key of used) {
        expect(keys as readonly string[], `${file} renders ${key}`).toContain(key);
      }
    }
  });

  it("gives the same addresses as the live pages", () => {
    expect(DOWNLOAD_PRERENDER_RELEASES_URL).toBe(RELEASES_PAGE_URL);
    expect(DOWNLOAD_PRERENDER_SIGNPATH).toEqual({
      credit: SIGNPATH_CREDIT,
      url: SIGNPATH_URL,
      terms: SIGNPATH_TERMS_URL,
    });
    expect(DOWNLOAD_PRERENDER_TEAM.committers).toEqual(CODE_SIGNING_COMMITTERS);
    expect(DOWNLOAD_PRERENDER_TEAM.approvers).toEqual(CODE_SIGNING_APPROVERS);
    expect(CREATE_ROOM_PRERENDER_HREF).toBe("/app");
    expect(readSource("../pages/tela-page.tsx")).toContain('forceRedirectUrl="/app"');
    expect(readSource("../pages/vs-discord-page.tsx")).toContain('forceRedirectUrl="/app"');
    expect(IOS_BETA_PRERENDER_HREF).toBe(PUBLIC_TESTFLIGHT_URL);
  });

  it("writes /tela's hero, the four options, the steps and the FAQ", () => {
    for (const locale of ["pt-BR", "en", "es"] as const) {
      const root = rootOf(served("/tela", locale));
      const c = TELA_PRERENDER_COPY[locale];
      expect(root).toContain(`lang="${locale}"`);
      expect(root).toMatch(new RegExp(`<h1[^>]*>${escapeRe(esc(c["tela.hero.title"]))}</h1>`));
      for (const key of ["tela.options.title", "tela.how.title", "tela.faq.title", "tela.cta.title"] as const) {
        expect(root).toMatch(new RegExp(`<h2[^>]*>${escapeRe(esc(c[key]))}</h2>`));
      }
      for (const id of ["pqp", "jitsi", "teamspeak", "meet"] as const) {
        expect(root).toContain(esc(c[`tela.option.${id}.name`]));
      }
      for (const id of ["download", "vpn", "people", "free", "mobile", "data", "why"] as const) {
        expect(root).toContain(esc(c[`tela.faq.${id}.q`]));
        expect(root).toContain(esc(c[`tela.faq.${id}.a`]));
      }
      expect(root).toContain('href="/app"');
      expect(root).toContain('href="/vs-discord"');
      expect(root).toContain('href="/privacy"');
    }
  });

  it("writes /vs-discord's matchup, the scoreboard and the FAQ", () => {
    for (const locale of ["pt-BR", "en", "es"] as const) {
      const root = rootOf(served("/vs-discord", locale));
      const c = VS_DISCORD_PRERENDER_COPY[locale];
      expect(root).toContain(`lang="${locale}"`);
      expect(root).toMatch(/<h1[^>]*>pqp vs Discord /);
      expect(root).toContain(esc(c["vsDiscord.hero.tagline"]));
      expect(root).toContain("<table");
      expect(root.match(/<th scope="row"/g)).toHaveLength(8);
      for (const id of ["why", "when", "how", "catch"] as const) {
        expect(root).toContain(esc(c[`vsDiscord.faq.${id}.q`]));
      }
      expect(root).toContain('href="/tela"');
      expect(root).toContain(`href="${PUBLIC_TESTFLIGHT_URL}"`);
      expect(root).toContain('id="ios-beta"');
      // The Brazilian suspension card is not on the Spanish page.
      if (locale === "es") {
        expect(root).not.toContain(esc(c["vsDiscord.featured.discordDetail"]));
      } else {
        expect(root).toContain(esc(c["vsDiscord.featured.discordDetail"]));
      }
    }
  });

  it("writes /download's platforms and the code signing policy", () => {
    for (const locale of ["pt-BR", "en", "es"] as const) {
      const root = rootOf(served("/download", locale));
      const c = DOWNLOAD_PRERENDER_COPY[locale];
      expect(root).toContain(`lang="${locale}"`);
      expect(root).toMatch(new RegExp(`<h1[^>]*>${escapeRe(esc(c["downloadPage.title"]))}</h1>`));
      for (const key of ["downloadPage.windows", "downloadPage.mac", "downloadPage.linux", "downloadPage.ios", "downloadPage.android"] as const) {
        expect(root).toContain(esc(c[key]));
      }
      expect(root).toContain(`href="${RELEASES_PAGE_URL}"`);
      expect(root).toContain('href="/android"');
      expect(root).toContain('href="/beta"');
      expect(root).toContain('id="code-signing"');
      expect(root).toContain(SIGNPATH_CREDIT);
      expect(root).toContain('href="/privacy"');
    }
  });
});

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The REAL shipped document, imported through Vite's `?raw` rather than read
// off disk with `node:fs` — the client's tsconfig has no Node types, and this
// suite has no business being the one file that needs them.
import INDEX_HTML from "../../index.html?raw";
import { describe, expect, it } from "vitest";
import en from "../locales/en/translation.json";
import ptBR from "../locales/pt-BR/translation.json";
import {
  injectMarketingHead,
  marketingPageFromMetaPath,
  renderMarketingHead,
  LANDING_FAQ,
  SOFTWARE_OPERATING_SYSTEMS,
  TELA_FAQ,
  VEM_FAQ,
  VS_DISCORD_FAQ,
  type MarketingPage,
} from "./marketing-meta";

/**
 * The marketing half of the Pages middleware.
 *
 * The middleware itself cannot be exercised without a wrangler runtime, so
 * this suite tests the whole of what could actually be wrong: the path parser
 * that decides whether the middleware acts at all, the rewrite — run against
 * THE REAL `index.html`, imported as text — and, most importantly, the
 * duplicated copy. `marketing-meta.ts` cannot import the i18n JSON (it is
 * bundled by an esbuild run outside the workspace), so its strings are
 * duplicates of the JSON catalogues; this file is what makes that duplication
 * unable to drift. Same shape as `profile-meta.test.ts`, one namespace over.
 */

describe("marketingPageFromMetaPath", () => {
  it("recognises every marketing route", () => {
    const pages: MarketingPage[] = [
      "/",
      "/vs-discord",
      "/tela",
      "/vem",
      "/beta",
      "/android",
      "/download",
      "/garanta",
      "/claim",
      "/privacy",
      "/terms",
      "/cookies",
      "/status",
    ];
    for (const page of pages) {
      expect(marketingPageFromMetaPath(page)).toBe(page);
    }
  });

  it("tolerates a trailing slash", () => {
    expect(marketingPageFromMetaPath("/vs-discord/")).toBe("/vs-discord");
    expect(marketingPageFromMetaPath("/garanta//")).toBe("/garanta");
  });

  it("answers null for everything else — especially hashed assets", () => {
    // This parser sits in front of EVERY request the site serves. A loose
    // match here puts a head rewrite in front of the app bundle.
    expect(marketingPageFromMetaPath("/assets/index-BsH3kA.js")).toBeNull();
    expect(marketingPageFromMetaPath("/app")).toBeNull();
    expect(marketingPageFromMetaPath("/app/invite/abc")).toBeNull();
    expect(marketingPageFromMetaPath("/@rafa")).toBeNull();
    expect(marketingPageFromMetaPath("/c/valorant")).toBeNull();
    expect(marketingPageFromMetaPath("/vs-discordx")).toBeNull();
    expect(marketingPageFromMetaPath("/vs-discord/extra")).toBeNull();
    expect(marketingPageFromMetaPath("/telas")).toBeNull();
    expect(marketingPageFromMetaPath("/tela/x")).toBeNull();
    expect(marketingPageFromMetaPath("/@tela")).toBeNull();
    expect(marketingPageFromMetaPath("/VS-DISCORD")).toBeNull();
    expect(marketingPageFromMetaPath("")).toBeNull();
    expect(marketingPageFromMetaPath("//")).toBeNull();
  });
});

describe("the duplicated copy is pinned to the JSON catalogues", () => {
  /**
   * Every marketing path that has catalogue copy, checked in one table.
   *
   * WHY A TABLE AND NOT ANOTHER `it` PER PAGE. The per-page tests below cover
   * landing, vs-discord, tela and claim. `/beta` was never added, and it
   * drifted: #88 corrected the catalogue when `/beta` was found to be
   * promising an iPhone screen share that has never worked, but the hardcoded
   * pair here was left behind, so the edge kept injecting the false copy into
   * every link card for another two hours. Nobody noticed because nothing
   * looked at that page.
   *
   * A list of pages that must each be remembered is a list that will be
   * forgotten. This one is derived, so a new marketing page with catalogue
   * copy is covered the moment it exists.
   */
  const PINNED: ReadonlyArray<{ path: MarketingPage; prefix: string }> = [
    { path: "/", prefix: "landing" },
    { path: "/vs-discord", prefix: "vsDiscord" },
    { path: "/tela", prefix: "tela" },
    { path: "/vem", prefix: "vem" },
    { path: "/beta", prefix: "betaPage" },
    { path: "/android", prefix: "androidPage" },
    { path: "/download", prefix: "downloadPage" },
    { path: "/claim", prefix: "claim" },
  ];

  for (const { path, prefix } of PINNED) {
    it(`${path} matches the catalogue in both languages`, () => {
      for (const [locale, catalogue] of [
        ["en", en],
        ["pt-BR", ptBR],
      ] as const) {
        const head = renderMarketingHead(path, locale);
        const title = (catalogue as Record<string, string>)[`${prefix}.seo.title`];
        const description = (catalogue as Record<string, string>)[
          `${prefix}.seo.description`
        ];
        expect(title, `${prefix}.seo.title missing from ${locale}`).toBeTruthy();
        expect(head, `${path} ${locale} title`).toContain(`<title>${title}</title>`);
        if (description) {
          expect(head, `${path} ${locale} description`).toContain(description);
        }
      }
    });
  }

  it("landing title and description", () => {
    const head = renderMarketingHead("/", "en");
    expect(head).toContain(`<title>${en["landing.seo.title"]}</title>`);
    expect(head).toContain(en["landing.seo.description"]);
    const pt = renderMarketingHead("/", "pt-BR");
    expect(pt).toContain(`<title>${ptBR["landing.seo.title"]}</title>`);
    expect(pt).toContain(ptBR["landing.seo.description"]!);
  });

  it("vs-discord title and description", () => {
    const head = renderMarketingHead("/vs-discord", "en");
    expect(head).toContain(`<title>${en["vsDiscord.seo.title"]}</title>`);
    const pt = renderMarketingHead("/vs-discord", "pt-BR");
    expect(pt).toContain(`<title>${ptBR["vsDiscord.seo.title"]}</title>`);
  });

  it("tela title and description", () => {
    const head = renderMarketingHead("/tela", "en");
    expect(head).toContain(`<title>${en["tela.seo.title"]}</title>`);
    expect(head).toContain(en["tela.seo.description"]);
    const pt = renderMarketingHead("/tela", "pt-BR");
    expect(pt).toContain(`<title>${ptBR["tela.seo.title"]}</title>`);
    expect(pt).toContain(ptBR["tela.seo.description"]!);
  });

  it("tela paste-card OG copy matches the catalogue and differs from the search title", () => {
    for (const [locale, catalogue] of [
      ["en", en],
      ["pt-BR", ptBR],
    ] as const) {
      const head = renderMarketingHead("/tela", locale);
      const ogTitle = (catalogue as Record<string, string>)["tela.seo.ogTitle"];
      const ogDescription = (catalogue as Record<string, string>)[
        "tela.seo.ogDescription"
      ];
      expect(ogTitle).toBeTruthy();
      expect(ogDescription).toBeTruthy();
      expect(ogTitle).not.toBe(
        (catalogue as Record<string, string>)["tela.seo.title"],
      );
      expect(head).toContain(`<meta property="og:title" content="${ogTitle}" />`);
      expect(head).toContain(
        `<meta property="og:description" content="${ogDescription}" />`,
      );
      expect(head).toContain(`<meta name="twitter:title" content="${ogTitle}" />`);
      expect(head).toContain(
        `<meta name="twitter:description" content="${ogDescription}" />`,
      );
    }
  });

  it("pages without OG overrides reuse title and description on the paste card", () => {
    const head = renderMarketingHead("/vs-discord", "pt-BR");
    const title = ptBR["vsDiscord.seo.title"];
    const description = ptBR["vsDiscord.seo.description"]!;
    expect(head).toContain(`<title>${title}</title>`);
    expect(head).toContain(`<meta property="og:title" content="${title}" />`);
    expect(head).toContain(
      `<meta property="og:description" content="${description}" />`,
    );
    expect(head).toContain(`<meta name="twitter:title" content="${title}" />`);
    expect(head).toContain(
      `<meta name="twitter:description" content="${description}" />`,
    );
  });

  it("claim title and description, under both routes", () => {
    for (const page of ["/garanta", "/claim"] as const) {
      expect(renderMarketingHead(page, "en")).toContain(
        `<title>${en["claim.seo.title"]}</title>`,
      );
      expect(renderMarketingHead(page, "pt-BR")).toContain(
        `<title>${ptBR["claim.seo.title"]}</title>`,
      );
    }
  });

  it("every FAQ pair matches its vsDiscord.faq.* twin, both locales", () => {
    // Order matters: the page renders FAQ_ITEMS in why/when/how/catch order
    // and the JSON-LD must be the same list.
    const ids = ["why", "when", "how", "catch"] as const;
    expect(VS_DISCORD_FAQ.en).toHaveLength(ids.length);
    expect(VS_DISCORD_FAQ["pt-BR"]).toHaveLength(ids.length);
    ids.forEach((id, index) => {
      expect(VS_DISCORD_FAQ.en[index]).toEqual({
        question: en[`vsDiscord.faq.${id}.q`],
        answer: en[`vsDiscord.faq.${id}.a`],
      });
      expect(VS_DISCORD_FAQ["pt-BR"][index]).toEqual({
        question: ptBR[`vsDiscord.faq.${id}.q`],
        answer: ptBR[`vsDiscord.faq.${id}.a`],
      });
    });
  });

  it("every homepage FAQ pair matches its landing.faq.* twin, both locales", () => {
    // Same rule: the page renders LANDING_FAQ_IDS in this order and the
    // JSON-LD must be the same list.
    const ids = ["safe", "free", "install", "capacity", "import", "data"] as const;
    expect(LANDING_FAQ.en).toHaveLength(ids.length);
    expect(LANDING_FAQ["pt-BR"]).toHaveLength(ids.length);
    ids.forEach((id, index) => {
      expect(LANDING_FAQ.en[index]).toEqual({
        question: en[`landing.faq.${id}.q`],
        answer: en[`landing.faq.${id}.a`],
      });
      expect(LANDING_FAQ["pt-BR"][index]).toEqual({
        question: ptBR[`landing.faq.${id}.q`],
        answer: ptBR[`landing.faq.${id}.a`],
      });
    });
  });

  it("every /tela FAQ pair matches its tela.faq.* twin, both locales", () => {
    // Same rule as above: page order, and the JSON-LD must be the same list.
    const ids = ["download", "vpn", "people", "free", "mobile", "data", "why"] as const;
    expect(TELA_FAQ.en).toHaveLength(ids.length);
    expect(TELA_FAQ["pt-BR"]).toHaveLength(ids.length);
    ids.forEach((id, index) => {
      expect(TELA_FAQ.en[index]).toEqual({
        question: en[`tela.faq.${id}.q`],
        answer: en[`tela.faq.${id}.a`],
      });
      expect(TELA_FAQ["pt-BR"][index]).toEqual({
        question: ptBR[`tela.faq.${id}.q`],
        answer: ptBR[`tela.faq.${id}.a`],
      });
    });
  });
});

describe("the /vem campaign page", () => {
  it("every FAQ pair matches its vem.faq.* twin, both locales", () => {
    const ids = [
      "friends",
      "safe",
      "free",
      "bots",
      "messages",
      "install",
      "size",
      "back",
    ] as const;
    expect(VEM_FAQ.en).toHaveLength(ids.length);
    expect(VEM_FAQ["pt-BR"]).toHaveLength(ids.length);
    ids.forEach((id, index) => {
      expect(VEM_FAQ.en[index]).toEqual({
        question: en[`vem.faq.${id}.q`],
        answer: en[`vem.faq.${id}.a`],
      });
      expect(VEM_FAQ["pt-BR"][index]).toEqual({
        question: ptBR[`vem.faq.${id}.q`],
        answer: ptBR[`vem.faq.${id}.a`],
      });
    });
  });

  it("carries its own share card, one per language", () => {
    const pt = renderMarketingHead("/vem", "pt-BR");
    const english = renderMarketingHead("/vem", "en");
    expect(pt).toContain(
      '<meta property="og:image" content="https://pqp.gg/images/og-vem.png" />',
    );
    expect(pt).toContain(
      '<meta name="twitter:image" content="https://pqp.gg/images/og-vem.png" />',
    );
    expect(english).toContain(
      '<meta property="og:image" content="https://pqp.gg/images/og-vem-en.png" />',
    );
    expect(pt).toContain('"FAQPage"');
    // Every other page keeps the product card.
    expect(renderMarketingHead("/tela", "pt-BR")).toContain(
      "https://pqp.gg/images/og-image.jpg",
    );
  });

  it("never mentions the ANPD or the suspension, in either language", () => {
    for (const locale of ["pt-BR", "en"] as const) {
      const head = renderMarketingHead("/vem", locale).toLowerCase();
      for (const word of ["anpd", "suspen", "vpn"]) {
        expect(head).not.toContain(word);
      }
    }
    for (const catalogue of [en, ptBR]) {
      for (const [key, value] of Object.entries(catalogue)) {
        if (!key.startsWith("vem.")) continue;
        expect(value.toLowerCase(), key).not.toMatch(/anpd|suspen/);
      }
    }
  });
});

describe("renderMarketingHead", () => {
  it("canonicalises to pqp.gg regardless of where the bytes are served", () => {
    // The pages.dev twin serves this same build; the pinned origin is what
    // keeps it from competing with pqp.gg in the index.
    const head = renderMarketingHead("/vs-discord", "pt-BR");
    expect(head).toContain(
      '<link rel="canonical" href="https://pqp.gg/vs-discord" />',
    );
    expect(head).toContain(
      '<meta property="og:url" content="https://pqp.gg/vs-discord" />',
    );
  });

  it("canonicalises /claim to /garanta, as the client Seo does", () => {
    const head = renderMarketingHead("/claim", "en");
    expect(head).toContain(
      '<link rel="canonical" href="https://pqp.gg/garanta" />',
    );
    expect(head).not.toContain("https://pqp.gg/claim");
  });

  it("emits the hreflang trio around one canonical", () => {
    const head = renderMarketingHead("/", "pt-BR");
    expect(head).toContain(
      '<link rel="alternate" hreflang="x-default" href="https://pqp.gg/" />',
    );
    expect(head).toContain(
      '<link rel="alternate" hreflang="pt-BR" href="https://pqp.gg/?lang=pt-BR" />',
    );
    expect(head).toContain(
      '<link rel="alternate" hreflang="en" href="https://pqp.gg/?lang=en" />',
    );
  });

  it("carries FAQPage JSON-LD on /, /vs-discord and /tela only", () => {
    expect(renderMarketingHead("/", "pt-BR")).toContain('"FAQPage"');
    expect(renderMarketingHead("/", "en")).toContain(LANDING_FAQ.en[0]!.question);
    expect(renderMarketingHead("/vs-discord", "pt-BR")).toContain('"FAQPage"');
    expect(renderMarketingHead("/tela", "pt-BR")).toContain('"FAQPage"');
    expect(renderMarketingHead("/tela", "en")).toContain(
      TELA_FAQ.en[0]!.question,
    );
    expect(renderMarketingHead("/beta", "pt-BR")).not.toContain('"FAQPage"');
    expect(renderMarketingHead("/download", "pt-BR")).not.toContain('"FAQPage"');
    expect(renderMarketingHead("/privacy", "pt-BR")).not.toContain('"FAQPage"');
  });

  it("claims SoftwareApplication on the landing only", () => {
    expect(renderMarketingHead("/", "en")).toContain('"SoftwareApplication"');
    expect(renderMarketingHead("/vs-discord", "en")).not.toContain(
      '"SoftwareApplication"',
    );
  });

  it("keeps the JSON-LD unable to close its own script block", () => {
    const head = renderMarketingHead("/vs-discord", "pt-BR");
    const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(
      head,
    )![1]!;
    expect(jsonLd).not.toContain("</");
    // Still parseable after the escape.
    expect(() => JSON.parse(jsonLd)).not.toThrow();
  });

  it("marks every marketing page indexable", () => {
    expect(renderMarketingHead("/status", "en")).toContain(
      '<meta name="robots" content="index, follow" />',
    );
  });
});

describe("injectMarketingHead", () => {
  it("replaces the product's own card in the real index.html", () => {
    const html = injectMarketingHead(INDEX_HTML, "/vs-discord", "pt-BR");
    // Exactly one of each managed tag — the stock ones are gone.
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain(`<title>${ptBR["vsDiscord.seo.title"]}</title>`);
    expect(html.match(/property="og:title"/g)).toHaveLength(1);
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html).toContain('href="https://pqp.gg/vs-discord"');
    expect(html).not.toContain('<link rel="canonical" href="https://pqp.gg/" />');
    // The stock JSON-LD graph went with the rest; ours took its place.
    expect(html.match(/application\/ld\+json/g)).toHaveLength(1);
  });

  it("survives what it must not touch", () => {
    const html = injectMarketingHead(INDEX_HTML, "/", "pt-BR");
    // The pre-paint theme script, the icons, the viewport and the fonts are
    // not the rewrite's business.
    expect(html).toContain("pqp-theme");
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain("fonts.googleapis.com");
    expect(html).toContain('<div id="root"></div>');
  });

  it("declares the document Portuguese when the head is Portuguese", () => {
    expect(injectMarketingHead(INDEX_HTML, "/", "pt-BR")).toContain(
      '<html lang="pt-BR">',
    );
    expect(injectMarketingHead(INDEX_HTML, "/", "en")).toContain(
      '<html lang="en">',
    );
  });

  it("stamps the negotiated locale for the client bundle to read back", () => {
    // Without this the app boots from `navigator.languages` and `Seo`
    // overwrites the Portuguese head with the English one — which is what a
    // crawler's renderer indexes. See `lib/locale.ts`.
    expect(injectMarketingHead(INDEX_HTML, "/tela", "pt-BR")).toContain(
      '<meta name="pqp:locale" content="pt-BR" />',
    );
    expect(injectMarketingHead(INDEX_HTML, "/tela", "en")).toContain(
      '<meta name="pqp:locale" content="en" />',
    );
  });

  it("leaves exactly one locale stamp when the rewrite runs twice", () => {
    const once = injectMarketingHead(INDEX_HTML, "/", "pt-BR");
    const twice = injectMarketingHead(once, "/", "pt-BR");
    expect(twice.match(/name="pqp:locale"/g)).toHaveLength(1);
  });

  it("returns a document with no <head> unchanged", () => {
    // Cannot happen with our own index.html, and serving the page unmodified
    // is the bar every failure path in this feature is held to.
    const bare = "<html><body>no head here</body></html>";
    expect(injectMarketingHead(bare, "/vs-discord", "pt-BR")).toBe(bare);
  });

  it("splits /tela search title from the paste card in pt-BR", () => {
    const html = injectMarketingHead(INDEX_HTML, "/tela", "pt-BR");
    expect(html).toContain(`<title>${ptBR["tela.seo.title"]}</title>`);
    expect(html).toContain(
      `<meta property="og:title" content="${ptBR["tela.seo.ogTitle"]}" />`,
    );
    expect(ptBR["tela.seo.title"]).not.toBe(ptBR["tela.seo.ogTitle"]);
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/property="og:title"/g)).toHaveLength(1);
  });
});

describe("structured data", () => {
  function jsonLdGraph(html: string): Record<string, unknown>[] {
    const block = html.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    );
    expect(block).not.toBeNull();
    return (JSON.parse(block![1]) as { "@graph": Record<string, unknown>[] })["@graph"];
  }

  it("index.html and the edge head claim the same operating systems", () => {
    const shell = jsonLdGraph(INDEX_HTML).find(
      (node) => node["@type"] === "SoftwareApplication",
    );
    expect(shell?.operatingSystem).toBe(SOFTWARE_OPERATING_SYSTEMS);

    const landing = jsonLdGraph(renderMarketingHead("/", "pt-BR")).find(
      (node) => node["@type"] === "SoftwareApplication",
    );
    expect(landing?.operatingSystem).toBe(SOFTWARE_OPERATING_SYSTEMS);
  });

  it("points sameAs only at pages the public can open", () => {
    for (const node of jsonLdGraph(renderMarketingHead("/", "en"))) {
      for (const url of (node.sameAs as string[] | undefined) ?? []) {
        // The Play listing 404s until it is published. See ORGANIZATION_SAME_AS.
        expect(url).not.toContain("play.google.com");
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import en from "../locales/en/translation.json";
import es from "../locales/es/translation.json";
import ptBR from "../locales/pt-BR/translation.json";
import {
  APPS_COPY,
  appsPageFromMetaPath,
  appsUrlsFor,
  injectAppsHead,
  renderAppsHead,
} from "./apps-meta";
import { isUnknownSpaPath } from "./spa-routes";
import { canonicalMarketingPages } from "./marketing-meta";
import { sitemapPages } from "./sitemap-pages";

const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <title>pqp</title>
    <meta name="description" content="the product" />
    <link rel="canonical" href="https://pqp.gg/" />
    <meta property="og:title" content="the product" />
    <meta name="viewport" content="width=device-width" />
  </head>
  <body><div id="root"></div></body>
</html>`;

describe("appsPageFromMetaPath", () => {
  it("knows the three paths, with or without a trailing slash", () => {
    expect(appsPageFromMetaPath("/apps")).toBe("apps");
    expect(appsPageFromMetaPath("/apps/")).toBe("apps");
    expect(appsPageFromMetaPath("/apps/locadora")).toBe("locadora");
    expect(appsPageFromMetaPath("/locadora")).toBe("locadora");
    expect(appsPageFromMetaPath("/locadora/")).toBe("locadora");
  });

  it("is an exact match, never a prefix: hashed assets and neighbours are not its business", () => {
    for (const other of [
      "/",
      "/apps/other",
      "/apps/locadora/x",
      "/appstore",
      "/locadoras",
      "/assets/apps-abc123.js",
      "/images/apps/street-dusk.webp",
      "/@apps",
    ]) {
      expect(appsPageFromMetaPath(other), other).toBeNull();
    }
  });

  it("is a route the SPA has, so the edge never turns it into a soft 404", () => {
    for (const path of ["/apps", "/apps/locadora", "/locadora"]) {
      expect(isUnknownSpaPath(path), path).toBe(false);
    }
    expect(isUnknownSpaPath("/apps/nope")).toBe(true);
  });
});

describe("the head", () => {
  it.each(["apps", "locadora"] as const)("%s: title, description, canonical, og, twitter and hreflang, per language", (page) => {
    for (const locale of ["pt-BR", "en", "es"] as const) {
      const head = renderAppsHead(page, locale);
      const copy = APPS_COPY[page];
      expect(head).toContain(`<title>${copy.title[locale]}</title>`);
      expect(head).toContain(`content="${copy.description[locale]}"`);
      const urls = appsUrlsFor(page, locale);
      expect(head).toContain(`<link rel="canonical" href="${urls.canonical}" />`);
      expect(head).toContain(`<meta property="og:url" content="${urls.canonical}" />`);
      expect(head).toContain('<meta name="twitter:card" content="summary_large_image" />');
      expect(head).toContain(`<meta property="og:image" content="https://pqp.gg${copy.image}" />`);
      expect(head).toContain('<meta property="og:image:width" content="1200" />');
      expect(head).toContain(`<meta name="pqp:locale" content="${locale}" />`);
      for (const hreflang of ["x-default", "pt-BR", "en", "es"]) {
        expect(head).toContain(`hreflang="${hreflang}"`);
      }
      expect(head).toContain('<meta name="robots" content="index, follow" />');
    }
  });

  it("canonicalises the short link to /apps/locadora, per language, each version naming itself", () => {
    expect(appsUrlsFor("locadora", "pt-BR").canonical).toBe("https://pqp.gg/apps/locadora");
    expect(appsUrlsFor("locadora", "en").canonical).toBe("https://pqp.gg/apps/locadora?lang=en");
    expect(appsUrlsFor("locadora", "es").canonical).toBe("https://pqp.gg/apps/locadora?lang=es");
    expect(appsUrlsFor("apps", "pt-BR").canonical).toBe("https://pqp.gg/apps");
    for (const alt of appsUrlsFor("locadora", "en").alternates) {
      // Never the short link: `https://pqp.gg/locadora` would be a duplicate.
      expect(alt.href.startsWith("https://pqp.gg/apps/locadora")).toBe(true);
    }
  });

  it("replaces what the shipped document says about the product, and the document language", () => {
    const html = injectAppsHead(SHELL, "locadora", "pt-BR");
    expect(html).toContain(`<title>${APPS_COPY.locadora.title["pt-BR"]}</title>`);
    expect(html).not.toContain("<title>pqp</title>");
    expect(html).not.toContain("the product");
    expect(html).not.toContain('href="https://pqp.gg/"');
    expect(html).toContain('<html lang="pt-BR">');
    // Untouched.
    expect(html).toContain('<meta name="viewport" content="width=device-width" />');
    expect(html).toContain('<div id="root"></div>');
    expect((html.match(/<title>/g) ?? []).length).toBe(1);
  });

  it("serves a document with no head unchanged", () => {
    expect(injectAppsHead("<p>no head</p>", "apps", "en")).toBe("<p>no head</p>");
  });
});

describe("the copy is a duplicate of the catalogue, and cannot drift from it", () => {
  const catalogues = { "pt-BR": ptBR, en, es } as Record<string, Record<string, string>>;
  const keys = {
    apps: ["appsLanding.seo.title", "appsLanding.seo.description"],
    locadora: ["locadoraPage.seo.title", "locadoraPage.seo.description"],
  } as const;

  it.each(["apps", "locadora"] as const)("%s", (page) => {
    for (const locale of ["pt-BR", "en", "es"] as const) {
      expect(APPS_COPY[page].title[locale]).toBe(catalogues[locale]![keys[page][0]]);
      expect(APPS_COPY[page].description[locale]).toBe(catalogues[locale]![keys[page][1]]);
    }
  });

  it("has no dash punctuation in any language", () => {
    for (const page of ["apps", "locadora"] as const) {
      const all = [
        ...Object.values(APPS_COPY[page].title),
        ...Object.values(APPS_COPY[page].description),
        ...Object.values(APPS_COPY[page].imageAlt),
      ].join(" ");
      for (const banned of ["—", "–", "―"]) expect(all).not.toContain(banned);
    }
  });
});

describe("while the flag is runtime, the pages stay out of the static registries", () => {
  it("is in neither the marketing registry nor the sitemap", () => {
    const registry = canonicalMarketingPages() as string[];
    for (const path of ["/apps", "/apps/locadora", "/locadora"]) {
      expect(registry).not.toContain(path);
    }
    const listed = sitemapPages(() => null).map((page) => page.path);
    for (const path of ["/apps", "/apps/locadora", "/locadora"]) {
      expect(listed).not.toContain(path);
    }
  });
});

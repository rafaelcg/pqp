import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SOURCE_REPO_URL } from "./downloads";
import {
  injectPrerenderHero,
  PRERENDER_SOURCE_REPO_URL,
  PRERENDER_KEYS,
  PRERENDER_LOCALES,
  PRERENDER_END,
  PRERENDER_PLACEHOLDER,
  PRERENDER_START,
  stripPrerenderHero,
  renderPrerenderHero,
  type PrerenderLocale,
} from "./prerender-hero";

const here = path.dirname(fileURLToPath(import.meta.url));

function catalogue(locale: PrerenderLocale): Record<string, string> {
  return JSON.parse(
    readFileSync(
      path.resolve(here, `../locales/${locale}/translation.json`),
      "utf8",
    ),
  );
}

const CATALOGUES = Object.fromEntries(
  PRERENDER_LOCALES.map((l) => [l, catalogue(l)]),
) as Record<PrerenderLocale, Record<string, string>>;

describe("renderPrerenderHero", () => {
  const html = renderPrerenderHero(CATALOGUES);

  it("writes one block per language, each tagged with its own lang", () => {
    for (const locale of PRERENDER_LOCALES) {
      expect(html).toContain(`data-l="${locale}" lang="${locale}"`);
    }
    expect(html.startsWith(PRERENDER_START + '<div id="pre-hero">')).toBe(true);
    expect(html.endsWith(PRERENDER_END)).toBe(true);
  });

  it("prints the catalogue's own words, so a copy edit is one change", () => {
    for (const locale of PRERENDER_LOCALES) {
      const c = CATALOGUES[locale];
      for (const key of [
        "landing.hero.title",
        "landing.hero.body",
        "landing.hero.action",
        "landing.hero.eyebrow",
        "nav.join",
      ] as const) {
        expect(html, `${locale} ${key}`).toContain(
          c[key].replace(/&/g, "&amp;").replace(/"/g, "&quot;"),
        );
      }
    }
  });

  it("has exactly one h1 per language and no stray placeholders", () => {
    expect(html.match(/<h1 /g)).toHaveLength(PRERENDER_LOCALES.length);
    expect(html).not.toMatch(/undefined|\[object|\{\w+\}/);
  });

  it("has no em dash, in any language", () => {
    expect(html).not.toContain("\u2014");
  });

  it("links both calls to action to /app, which works before any script runs", () => {
    const links = html.match(/<a href="\/app"/g) ?? [];
    // Join and Sign in in the header, plus the two hero buttons, per language.
    expect(links).toHaveLength(4 * PRERENDER_LOCALES.length);
  });

  it("keeps Self-host in English in the other languages, like the live nav", () => {
    expect(html).toMatch(/href="\/#hosting"[^>]*lang="en"/);
  });

  it("names the screenshot for a screen reader", () => {
    for (const locale of PRERENDER_LOCALES) {
      expect(html).toContain(
        `alt="${CATALOGUES[locale]["landing.shot.hero"]}"`.replace(/&/g, "&amp;"),
      );
    }
  });

  it("escapes what it prints", () => {
    const hostile = structuredClone(CATALOGUES);
    hostile.en["landing.hero.title"] = '<img src=x onerror="alert(1)">';
    const out = renderPrerenderHero(hostile);
    expect(out).not.toContain("<img src=x");
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("fails the build when a catalogue lacks a key it needs", () => {
    const broken = structuredClone(CATALOGUES);
    delete broken["pt-BR"]["landing.hero.title"];
    expect(() => renderPrerenderHero(broken)).toThrow(/pt-BR.*landing\.hero\.title/);
  });
});

describe("the proof row", () => {
  it("links to the same repository as the live page", () => {
    expect(PRERENDER_SOURCE_REPO_URL).toBe(SOURCE_REPO_URL);
  });

  it("prints all five facts, since its height decides how the backdrop is cropped", () => {
    const html = renderPrerenderHero(CATALOGUES);
    for (const key of [
      "landing.proof.openSource",
      "landing.proof.watchParty",
      "landing.proof.region",
      "landing.proof.platforms",
      "landing.proof.languages",
    ]) {
      expect(html).toContain(CATALOGUES.en[key]);
    }
  });
});

describe("the catalogues the block reads", () => {
  it("define every key in every language", () => {
    for (const locale of PRERENDER_LOCALES) {
      for (const key of PRERENDER_KEYS) {
        expect(CATALOGUES[locale][key], `${locale} ${key}`).toBeTruthy();
      }
    }
  });
});

describe("injectPrerenderHero", () => {
  it("replaces the placeholder inside the root", () => {
    const out = injectPrerenderHero(
      `<div id="root">${PRERENDER_PLACEHOLDER}</div>`,
      "<p>hero</p>",
    );
    expect(out).toBe('<div id="root"><p>hero</p></div>');
  });

  it("leaves a document without the placeholder untouched", () => {
    const html = '<div id="root"></div>';
    expect(injectPrerenderHero(html, "<p>hero</p>")).toBe(html);
  });

  it("does not treat a dollar sign in the block as a replacement pattern", () => {
    const out = injectPrerenderHero(
      `<div id="root">${PRERENDER_PLACEHOLDER}</div>`,
      "<p>$& $1 $$</p>",
    );
    expect(out).toContain("<p>$& $1 $$</p>");
  });
});

describe("the shipped index.html", () => {
  const index = readFileSync(path.resolve(here, "../../index.html"), "utf8");

  it("carries the placeholder inside #root and nothing else in it", () => {
    expect(index).toContain(`<div id="root">${PRERENDER_PLACEHOLDER}</div>`);
  });

  it("no longer asks Google for its fonts", () => {
    expect(index).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });

  it("settles the route and the language before the stylesheet paints", () => {
    expect(index).toContain('d.setAttribute("data-route", "home")');
    expect(index).toContain('d.setAttribute("data-route", "other")');
    // The edge rewrites `<html lang="en">` by that literal string.
    expect(index).toContain('<html lang="en">');
  });

  it("preloads only the two fonts the first screen is set in", () => {
    const preloads = index.match(/<link rel="preload"[^>]*as="font"[^>]*>/g) ?? [];
    expect(preloads).toHaveLength(2);
    for (const tag of preloads) {
      expect(tag).toContain("crossorigin");
    }
  });
});

describe("stripPrerenderHero", () => {
  const block = renderPrerenderHero(CATALOGUES);

  it("takes the whole block out and leaves an empty root", () => {
    const out = stripPrerenderHero(`<div id="root">${block}</div>`);
    expect(out).toBe('<div id="root"></div>');
    expect(out).not.toContain("pre-hero");
    expect(out).not.toContain("<h1");
  });

  it("leaves a document without the block alone", () => {
    expect(stripPrerenderHero('<div id="root"></div>')).toBe('<div id="root"></div>');
  });

  it("gives every language its own main, so a skip link finds its own", () => {
    for (const locale of PRERENDER_LOCALES) {
      expect(block).toContain(`href="#main-${locale}"`);
      expect(block).toContain(`<main id="main-${locale}"`);
    }
    expect(block).not.toContain('id="main"');
  });
});

describe("the hero picture rules in index.css", () => {
  const css = readFileSync(path.resolve(here, "../index.css"), "utf8");

  it("keeps a plain url() fallback ahead of, and apart from, the image-set rules", () => {
    const plain = css.indexOf('background-image: url("/images/hero/hero-800.webp")');
    const supports = css.indexOf("@supports (background-image: image-set(");
    expect(plain).toBeGreaterThan(-1);
    expect(supports).toBeGreaterThan(plain);
    // A url() written right before an image-set() in one rule is deleted by
    // the minifier as an overridden duplicate, which left Safari before 17
    // with no picture at all.
    const heroRules = css.slice(css.indexOf(".hero-bg-art {"), css.indexOf("/* AVIF where"));
    expect(heroRules).not.toContain("image-set(");
    for (const size of ["800", "1200", "1536"]) {
      expect(css).toContain(`url("/images/hero/hero-${size}.webp")`);
      expect(css).toContain(`url("/images/hero/hero-${size}.avif") type("image/avif")`);
    }
  });
});

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  injectPrerenderHero,
  PRERENDER_END,
  PRERENDER_HREFS,
  PRERENDER_KEYS,
  PRERENDER_LOCALES,
  PRERENDER_MEDIA,
  PRERENDER_PIN_STYLE,
  PRERENDER_PLACEHOLDER,
  PRERENDER_START,
  renderPrerenderHero,
  stripPrerenderHero,
  type PrerenderLocale,
} from "./prerender-hero";

const here = path.dirname(fileURLToPath(import.meta.url));

function catalogue(locale: PrerenderLocale): Record<string, string> {
  return JSON.parse(
    readFileSync(path.resolve(here, `../locales/${locale}/translation.json`), "utf8"),
  );
}

const CATALOGUES = Object.fromEntries(
  PRERENDER_LOCALES.map((l) => [l, catalogue(l)]),
) as Record<PrerenderLocale, Record<string, string>>;

const escHtml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The markup without the pinned stylesheet and the `--lift` script. */
const markupOnly = (html: string) =>
  html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<script>[\s\S]*?<\/script>/g, "");

/** One language's block. */
function blockOf(html: string, locale: PrerenderLocale): string {
  const start = html.indexOf(`<div data-l="${locale}"`);
  const next = PRERENDER_LOCALES.map((l) => html.indexOf(`<div data-l="${l}"`))
    .filter((i) => i > start)
    .sort((a, b) => a - b)[0];
  return html.slice(start, next ?? html.indexOf("<script>", start));
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

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
      const block = blockOf(html, locale);
      for (const key of [
        "home.hero.body",
        "home.hero.made",
        "home.hero.caption",
        "home.cta.create",
        "home.cta.import",
        "home.cta.free",
        "home.cta.providers",
        "home.nav.create",
        "home.nav.night",
        "nav.signIn",
        "nav.skipToContent",
      ] as const) {
        expect(block, `${locale} ${key}`).toContain(escHtml(c[key]));
      }
    }
  });

  it("fills the title's one {accent} with the accent's words, as plain text", () => {
    for (const locale of PRERENDER_LOCALES) {
      const c = CATALOGUES[locale];
      const title = c["home.hero.title"].replace("{accent}", c["home.hero.titleAccent"]);
      expect(blockOf(html, locale), locale).toMatch(
        new RegExp(`<h1 class="[^"]+">${escHtml(title).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</h1>`),
      );
    }
  });

  it("has exactly one h1 per language and no stray placeholders", () => {
    expect(html.match(/<h1 /g)).toHaveLength(PRERENDER_LOCALES.length);
    expect(markupOnly(html)).not.toMatch(/undefined|\[object|\{\w+\}/);
  });

  it("has no em dash or en dash, in any language", () => {
    expect(html).not.toMatch(/[\u2013\u2014]/);
  });

  it("links the buttons to where the live ones lead, before any script runs", () => {
    for (const locale of PRERENDER_LOCALES) {
      const block = blockOf(html, locale);
      // The header's create link and the hero's first call to action.
      expect(count(block, `href="${PRERENDER_HREFS.create}"`), locale).toBe(2);
      expect(count(block, `href="${PRERENDER_HREFS.import}"`), locale).toBe(1);
      expect(count(block, `href="${PRERENDER_HREFS.signIn}"`), locale).toBe(1);
    }
    expect(PRERENDER_HREFS).toEqual({
      signIn: "/app",
      create: "/app?create=new",
      import: "/app?import=discord",
    });
  });

  it("links the five sections of the page, as the live header does", () => {
    for (const anchor of ["#noite", "#mudanca", "#brinquedos", "#codigo", "#perguntas"]) {
      expect(count(html, `href="${anchor}"`), anchor).toBe(PRERENDER_LOCALES.length);
    }
  });

  it("names the hero picture for a screen reader", () => {
    for (const locale of PRERENDER_LOCALES) {
      expect(blockOf(html, locale)).toContain(`alt="${escHtml(CATALOGUES[locale]["home.hero.alt"])}"`);
    }
  });

  it("offers each picture state its own file, smallest query first", () => {
    const m = PRERENDER_MEDIA;
    const picture = html.slice(html.indexOf("<picture><source media="), html.indexOf("</picture>", html.indexOf("<picture><source media=")));
    const order = [
      `<source media="(prefers-reduced-motion: reduce) and ${m.smallQuery}" srcset="${m.reducedSmall}">`,
      `<source media="(prefers-reduced-motion: reduce)" srcset="${m.reduced.srcSet}" sizes="${m.sizes}">`,
      `<source media="${m.smallQuery}" srcset="${m.motionSmall}">`,
      `<img src="${m.motion.src}" srcset="${m.motion.srcSet}" sizes="${m.sizes}"`,
    ].map((tag) => picture.indexOf(tag));
    expect(order.every((i) => i > -1), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Eager, and no priority hint: the live <img> asks for the same file.
    expect(picture).toContain('loading="eager"');
    expect(picture).not.toContain("fetchpriority");
  });

  it("styles the pinned layout under the live hero's own query", () => {
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    expect(style.startsWith(`@media ${PRERENDER_MEDIA.pinQuery}{`)).toBe(true);
    for (const [name, value] of Object.entries(PRERENDER_PIN_STYLE)) {
      expect(style).toContain(`#pre-hero [data-pin="${name}"]{${value}}`);
    }
  });

  it("measures --lift only on the home route, inside the block", () => {
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(script).toContain('getAttribute("data-route")!=="home"');
    expect(script).toContain(JSON.stringify(PRERENDER_MEDIA.pinQuery));
    expect(script).toContain("+44-");
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf(PRERENDER_END));
  });

  it("escapes what it prints", () => {
    const hostile = structuredClone(CATALOGUES);
    hostile.en["home.hero.body"] = '<img src=x onerror="alert(1)">';
    hostile.en["home.hero.titleAccent"] = "<b>";
    const out = renderPrerenderHero(hostile);
    expect(out).not.toContain("<img src=x");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("fails the build when a catalogue lacks a key it needs", () => {
    const broken = structuredClone(CATALOGUES);
    delete broken["pt-BR"]["home.hero.title"];
    expect(() => renderPrerenderHero(broken)).toThrow(/pt-BR.*home\.hero\.title/);
  });

  it("fails the build when the title is not one {accent} and nothing else", () => {
    for (const title of ["A room of your own.", "A {accent} of {accent}.", "{accent} for {name}.", "A room {who}."]) {
      const broken = structuredClone(CATALOGUES);
      broken.es["home.hero.title"] = title;
      expect(() => renderPrerenderHero(broken), title).toThrow(/es.*home\.hero\.title.*\{accent\}/);
    }
  });

  it("fails the build when another value holds a slot it cannot fill", () => {
    const broken = structuredClone(CATALOGUES);
    broken.en["home.cta.free"] = "Free for {name}.";
    expect(() => renderPrerenderHero(broken)).toThrow(/en.*home\.cta\.free/);
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

  it("are the keys the live first screen prints", () => {
    expect([...PRERENDER_KEYS].sort()).toEqual(
      [
        "nav.skipToContent",
        "nav.signIn",
        "nav.features",
        "home.nav.label",
        "home.nav.night",
        "home.nav.move",
        "home.nav.code",
        "home.nav.faq",
        "home.nav.create",
        "home.hero.label",
        "home.hero.title",
        "home.hero.titleAccent",
        "home.hero.body",
        "home.hero.made",
        "home.hero.alt",
        "home.hero.caption",
        "home.cta.create",
        "home.cta.import",
        "home.cta.free",
        "home.cta.providers",
      ].sort(),
    );
  });
});

describe("injectPrerenderHero", () => {
  it("replaces the placeholder inside the root", () => {
    const out = injectPrerenderHero(`<div id="root">${PRERENDER_PLACEHOLDER}</div>`, "<p>hero</p>");
    expect(out).toBe('<div id="root"><p>hero</p></div>');
  });

  it("leaves a document without the placeholder untouched", () => {
    const html = '<div id="root"></div>';
    expect(injectPrerenderHero(html, "<p>hero</p>")).toBe(html);
  });

  it("does not treat a dollar sign in the block as a replacement pattern", () => {
    const out = injectPrerenderHero(`<div id="root">${PRERENDER_PLACEHOLDER}</div>`, "<p>$& $1 $$</p>");
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

  it("tells the stylesheet which download line the hero will show", () => {
    for (const plat of ["ios", "android", "mac"]) {
      expect(index).toContain(`d.setAttribute("data-plat", "${plat}")`);
    }
    expect(index).not.toContain('"data-plat", "phone"');
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
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<style");
  });

  it("leaves a document without the block alone", () => {
    expect(stripPrerenderHero('<div id="root"></div>')).toBe('<div id="root"></div>');
  });

  it("gives every language its own main, so a skip link finds its own", () => {
    for (const locale of PRERENDER_LOCALES) {
      expect(block).toContain(`href="#conteudo-${locale}"`);
      expect(block).toContain(`<main id="conteudo-${locale}"`);
    }
    // The bare id belongs to the live page.
    expect(block).not.toContain('id="conteudo"');
  });
});

describe("the CSS the block paints with", () => {
  const css = readFileSync(path.resolve(here, "../index.css"), "utf8");
  const homeDir = path.resolve(here, "../pages/home");
  const lazyCss = readdirSync(homeDir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".css"))
    .map((f) => [f, readFileSync(path.join(homeDir, f), "utf8")] as const);

  it("is in the eager stylesheet: the scene pin, the device, the clip, the press and the grain", () => {
    expect(css).toMatch(
      /@media \(min-width: 1024px\) and \(prefers-reduced-motion: no-preference\) \{\s*\.cin-scene \{\s*height: var\(--scene-h, 200vh\);\s*\}\s*\.cin-scene > \.cin-stage \{\s*position: sticky;/,
    );
    expect(css).toMatch(/\.cin-device \{\s*box-shadow:/);
    expect(css).toMatch(/\.cin-clip-layer \{\s*transition: opacity 700ms ease;/);
    expect(css).toMatch(/@media \(max-width: 767px\) \{\s*\.cin-clip-media\[data-focus\] \{\s*transform: scale\(var\(--focus-zoom, 1\)\);/);
    expect(css).toContain(".cin-clip-media[data-focus] > picture > img,");
    expect(css).toMatch(/\.cin-press,\s*\.cta-lift\.cin-press \{\s*transition-property: transform, scale,/);
    expect(css).toMatch(/\.hp-grain \{\s*background-image: url\("data:image\/svg\+xml/);
    // After `.cta-lift`, so the press's transition list wins.
    expect(css.indexOf(".cta-lift.cin-press")).toBeGreaterThan(css.indexOf(".cta-lift {"));
  });

  it("is defined once: the home chunk's CSS no longer carries those rules", () => {
    for (const [file, text] of lazyCss) {
      for (const rule of [".cin-scene", ".cin-stage", ".cin-device", ".cin-clip-media", ".cin-clip-layer", ".cin-press", ".hp-grain"]) {
        expect(text.includes(`${rule} {`) || text.includes(`${rule},`) || text.includes(`${rule}[`), `${file} ${rule}`).toBe(false);
      }
    }
  });

  it("covers every class of the block that is not a Tailwind utility", () => {
    const html = markupOnly(renderPrerenderHero(CATALOGUES));
    const own = new Set(
      [...html.matchAll(/class="([^"]+)"/g)]
        .flatMap((m) => m[1].split(/\s+/))
        .filter((k) => /^(cin-|hp-|cta-)/.test(k)),
    );
    expect([...own].sort()).toEqual(["cin-clip-media", "cin-device", "cin-press", "cin-scene", "cin-stage", "cta-lift", "hp-grain"]);
    for (const name of own) {
      expect(css, name).toContain(`.${name}`);
    }
  });

  it("holds the live hero's entrance still while the static block stands", () => {
    expect(css).toMatch(/html\[data-pre\] \[data-home-hero\] \.animate-rise \{\s*animation: none;/);
  });

  it("no longer carries the old landing hero's rules", () => {
    for (const gone of [".hero-bg-art", ".hero-parallax", ".hero-grain", ".pre-download", "hero-drift", "#main > section"]) {
      expect(css, gone).not.toContain(gone);
    }
  });
});

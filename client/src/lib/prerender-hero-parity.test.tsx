import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createIntentHref } from "@/lib/handle-intent";
import { loadLocale } from "@/lib/i18n";
import * as media from "@/pages/home/hero-media";
import { CREATE_INTENT, IMPORT_INTENT } from "@/pages/home/shared/auth-buttons";
import {
  PRERENDER_HREFS,
  PRERENDER_LOCALES,
  PRERENDER_MEDIA,
  PRERENDER_PIN_STYLE,
  PRERENDER_SCENE_HEIGHT,
  renderPrerenderHero,
  type PrerenderLocale,
} from "./prerender-hero";

/**
 * The static first screen (`prerender-hero.ts`) against the live hero it
 * stands in for (`pages/home/index.tsx`), element by element, in every
 * language and in every layout the live hero picks with script.
 *
 * The live page is rendered with `renderToStaticMarkup` under a fake
 * `matchMedia`; the static block is resolved for the same viewport the way a
 * browser would (its `pre-pin:` / `pre-unpin:` classes, its pinned
 * `<style>`, its `<picture>` sources). The two trees must then be the same,
 * apart from what differs on purpose, which the normalisers below name one
 * by one: the live buttons are links before React, the entrance animation and
 * the video are live only, the download line's contents arrive with the
 * bundle, and the ids belong to the live page.
 */

const flags = vi.hoisted(() => ({ locale: "en" as PrerenderLocale }));

vi.mock("@/lib/i18n", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...original,
    useTranslation: () => ({ ...original.useTranslation(), locale: flags.locale }),
  };
});
vi.mock("@/hooks/use-communities-enabled", () => ({ useCommunitiesEnabled: () => false }));
vi.mock("@/components/marketing/marketing-auth-ctas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/marketing/marketing-auth-ctas")>()),
  MarketingAuthGate: ({ children }: { children: (a: unknown) => unknown }) =>
    children({ signedIn: false, bypass: false, join() {}, signIn() {} }),
}));
vi.mock("@/components/marketing/marketing-footer", () => ({ MarketingFooter: () => null }));
// The sections under the hero are not part of the first screen.
vi.mock("@/pages/home/noite", async (o) => ({ ...(await o<object>()), Noite: () => null }));
vi.mock("@/pages/home/mudanca", async (o) => ({ ...(await o<object>()), Mudanca: () => null }));
vi.mock("@/pages/home/brinquedos", async (o) => ({ ...(await o<object>()), Brinquedos: () => null }));
vi.mock("@/pages/home/celular", async (o) => ({ ...(await o<object>()), Celular: () => null }));
vi.mock("@/pages/home/seu-arroba", async (o) => ({ ...(await o<object>()), SeuArroba: () => null }));
vi.mock("@/pages/home/sem-letra-miuda", async (o) => ({ ...(await o<object>()), SemLetraMiuda: () => null }));
vi.mock("@/pages/home/codigo", async (o) => ({ ...(await o<object>()), Codigo: () => null }));
vi.mock("@/pages/home/perguntas", async (o) => ({ ...(await o<object>()), Perguntas: () => null }));
vi.mock("@/pages/home/fim", async (o) => ({ ...(await o<object>()), Fim: () => null }));

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOGUES = Object.fromEntries(
  PRERENDER_LOCALES.map((l) => [
    l,
    JSON.parse(readFileSync(path.resolve(here, `../locales/${l}/translation.json`), "utf8")),
  ]),
) as Record<PrerenderLocale, Record<string, string>>;
const STATIC_HTML = renderPrerenderHero(CATALOGUES);
const INDEX_CSS = readFileSync(path.resolve(here, "../index.css"), "utf8");

/* ------------------------------------------------------------ Viewports */

interface Mode {
  name: string;
  width: number;
  reduced: boolean;
}

const MODES: Mode[] = [
  { name: "wide, pinned", width: 1440, reduced: false },
  { name: "1024, pinned", width: 1024, reduced: false },
  { name: "wide, reduced motion", width: 1440, reduced: true },
  { name: "1023", width: 1023, reduced: false },
  { name: "tablet", width: 800, reduced: false },
  { name: "tablet, reduced motion", width: 800, reduced: true },
  { name: "640", width: 640, reduced: false },
  { name: "639", width: 639, reduced: false },
  { name: "phone", width: 390, reduced: false },
  { name: "phone, reduced motion", width: 390, reduced: true },
];

/** A media query against a viewport. Throws on a feature it does not know. */
function matches(query: string, mode: Mode): boolean {
  return query.split(/\s+and\s+/).every((part) => {
    const p = part.trim();
    let m: RegExpExecArray | null;
    if ((m = /^\(min-width:\s*(\d+)px\)$/.exec(p))) return mode.width >= Number(m[1]);
    if ((m = /^\(max-width:\s*(\d+)px\)$/.exec(p))) return mode.width <= Number(m[1]);
    if (p === "(prefers-reduced-motion: no-preference)") return !mode.reduced;
    if (p === "(prefers-reduced-motion: reduce)") return mode.reduced;
    if (p === "(hover: hover)" || p === "(pointer: fine)") return true;
    throw new Error(`unknown media query part: ${p}`);
  });
}

const pinnedIn = (mode: Mode) => matches(PRERENDER_MEDIA.pinQuery, mode);
const phoneIn = (mode: Mode) => mode.width <= 639;

/* --------------------------------------------------------------- Parser */

interface El {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}
type Node = El | string;

const VOID = new Set(["img", "source", "link", "meta", "br", "hr", "input", "wbr"]);
const RAW = new Set(["script", "style"]);

function decode(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Enough HTML for markup this repository writes: quoted attributes only. */
function parse(html: string): El {
  const root: El = { tag: "#root", attrs: {}, children: [] };
  const stack: El[] = [root];
  const tag = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>/y;
  let i = 0;
  while (i < html.length) {
    if (html.startsWith("<!--", i)) {
      i = html.indexOf("-->", i) + 3;
      continue;
    }
    if (html[i] === "<") {
      tag.lastIndex = i;
      const m = tag.exec(html);
      if (!m) throw new Error(`cannot parse at ${html.slice(i, i + 80)}`);
      i = tag.lastIndex;
      const [, closing, rawName, rawAttrs] = m;
      const name = rawName.toLowerCase();
      if (closing) {
        const top = stack.pop();
        if (top?.tag !== name) throw new Error(`</${name}> closes <${top?.tag}>`);
        continue;
      }
      const attrs: Record<string, string> = {};
      for (const a of rawAttrs.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) {
        attrs[a[1].toLowerCase()] = decode(a[2] ?? "");
      }
      const el: El = { tag: name, attrs, children: [] };
      stack[stack.length - 1].children.push(el);
      if (RAW.has(name)) {
        const end = html.indexOf(`</${name}>`, i);
        el.children.push(html.slice(i, end));
        i = end + name.length + 3;
      } else if (!VOID.has(name)) {
        stack.push(el);
      }
      continue;
    }
    const next = html.indexOf("<", i);
    const end = next === -1 ? html.length : next;
    stack[stack.length - 1].children.push(decode(html.slice(i, end)));
    i = end;
  }
  if (stack.length !== 1) throw new Error(`unclosed <${stack[stack.length - 1].tag}>`);
  return root;
}

const isEl = (n: Node): n is El => typeof n !== "string";
const classes = (el: El) => (el.attrs.class ?? "").split(/\s+/).filter(Boolean);
const textOf = (n: Node): string => (isEl(n) ? n.children.map(textOf).join("") : n);

function find(el: El, test: (e: El) => boolean): El | undefined {
  if (test(el)) return el;
  for (const c of el.children) {
    if (isEl(c)) {
      const hit = find(c, test);
      if (hit) return hit;
    }
  }
  return undefined;
}

function findAll(el: El, test: (e: El) => boolean, out: El[] = []): El[] {
  if (test(el)) out.push(el);
  for (const c of el.children) if (isEl(c)) findAll(c, test, out);
  return out;
}

/** Rebuilds a tree bottom up; `fn` returns the replacement, or null to drop it. */
function rewrite(el: El, fn: (e: El) => El | null): El | null {
  const children: Node[] = [];
  for (const c of el.children) {
    if (!isEl(c)) {
      children.push(c);
      continue;
    }
    const next = rewrite(c, fn);
    if (next) children.push(next);
  }
  return fn({ ...el, attrs: { ...el.attrs }, children });
}

function setClasses(el: El, list: string[]): void {
  if (list.length) el.attrs.class = list.join(" ");
  else delete el.attrs.class;
}

const styleParts = (style: string | undefined) =>
  (style ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

/** The candidates a browser picks the hero file from. */
function pick(attrs: Record<string, string>): string {
  return attrs.srcset ? `${attrs.srcset} | ${attrs.sizes ?? ""}` : (attrs.src ?? "");
}

/** Attributes either side owns on purpose, never compared. */
const OWN = [
  "id",
  "data-discover",
  "data-home-hero",
  "data-pin",
  "data-pre-download",
  "data-pre-download-below",
];

/** The live hero's wrapper for the download line under the footage. */
const DOWNLOAD_BELOW_LIVE = "pointer-events-auto relative mt-5 flex justify-start";

function lines(el: El, depth = 0, out: string[] = []): string[] {
  const pad = "  ".repeat(depth);
  const attrs = Object.entries(el.attrs)
    .filter(([k]) => !OWN.includes(k))
    .map(([k, v]) => {
      if (k === "class") v = [...classes(el)].sort().join(" ");
      if (k === "style") v = styleParts(v).join(";");
      return `${k}="${v}"`;
    })
    .sort();
  out.push(`${pad}<${el.tag}${attrs.length ? " " + attrs.join(" ") : ""}>`);
  for (const c of el.children) {
    if (isEl(c)) lines(c, depth + 1, out);
    else out.push(`${pad}  ${JSON.stringify(c)}`);
  }
  return out;
}

/* ------------------------------------------------------------ Live side */

const matchMediaFor = (mode: Mode) => (q: string) => ({
  matches: matches(q, mode),
  addEventListener() {},
  removeEventListener() {},
});

async function renderLive(locale: PrerenderLocale, mode: Mode): Promise<El> {
  await loadLocale(locale);
  flags.locale = locale;
  vi.stubGlobal("window", { matchMedia: matchMediaFor(mode) });
  const { default: Home } = await import("@/pages/home/index");
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  );
  vi.unstubAllGlobals();
  const root = find(parse(html), (e) => e.tag === "div" && classes(e).includes("min-h-screen"));
  if (!root) throw new Error("live page has no root");
  return root;
}

function normaliseLive(root: El, locale: PrerenderLocale): El {
  const c = CATALOGUES[locale];
  const hrefByText: Record<string, string> = {
    [c["nav.signIn"]]: "/app",
    [c["home.nav.create"]]: createIntentHref(CREATE_INTENT),
    [c["home.cta.create"]]: createIntentHref(CREATE_INTENT),
    [c["home.cta.import"]]: createIntentHref(IMPORT_INTENT),
  };
  // The first screen: skip link, header, and the hero section of <main>.
  const main = root.children.find((n): n is El => isEl(n) && n.tag === "main");
  const hero = main?.children.find((n): n is El => isEl(n) && n.tag === "section");
  if (!main || !hero) throw new Error("live page has no hero");
  const first: El = {
    ...root,
    children: root.children
      .filter((n) => isEl(n) && (n.tag === "a" || n.tag === "header" || n.tag === "main"))
      .map((n) => (n === main ? { ...main, children: [hero] } : n)),
  };
  return rewrite(first, (el) => {
    // Live only: the entrance and the video the play control starts.
    if (el.tag === "video") return null;
    setClasses(el, classes(el).filter((k) => k !== "animate-rise"));
    // The download line's contents depend on the platform and arrive with
    // the bundle. The static block holds its room only: the box under the
    // buttons, or on a phone the wrapper under the footage.
    if (el.attrs.class === DOWNLOAD_BELOW_LIVE) el.children = [];
    if (el.attrs.class?.startsWith(media.HERO_DOWNLOAD_BOX)) el.children = [];
    if (el.tag === "button") {
      delete el.attrs.type;
      if ("aria-haspopup" in el.attrs || "title" in el.attrs) {
        // The language picker and the play control: a face only, until React.
        for (const k of ["aria-label", "aria-haspopup", "aria-expanded", "data-state", "title"]) {
          delete el.attrs[k];
        }
        return { ...el, tag: "span", attrs: { "aria-hidden": "true", ...el.attrs } };
      }
      const href = hrefByText[textOf(el)];
      if (!href) throw new Error(`no link for the live button "${textOf(el)}"`);
      return { ...el, tag: "a", attrs: { href, ...el.attrs } };
    }
    if (el.tag === "img" && "draggable" in el.attrs) {
      // The hero picture: the file is compared, the priority hints differ on
      // purpose (the static one is eager with no hint), and the reduced-motion
      // still is unlabelled because the video carries the label.
      el.attrs = { pick: pick(el.attrs), decoding: el.attrs.decoding, class: el.attrs.class };
    }
    return el;
  })!;
}

/* ---------------------------------------------------------- Static side */

function staticBlock(locale: PrerenderLocale): El {
  const block = find(parse(STATIC_HTML), (e) => e.attrs["data-l"] === locale);
  if (!block) throw new Error(`no static block for ${locale}`);
  return block;
}

function resolveStatic(block: El, locale: PrerenderLocale, mode: Mode): El {
  const pinned = pinnedIn(mode);
  return rewrite(block, (el) => {
    // What the layout variants and the pinned stylesheet leave in this viewport.
    const kept: string[] = [];
    for (const k of classes(el)) {
      if (k.startsWith("pre-pin:")) {
        if (pinned) kept.push(k.slice("pre-pin:".length));
      } else if (k.startsWith("pre-unpin:")) {
        if (!pinned) kept.push(k.slice("pre-unpin:".length));
      } else {
        kept.push(k);
      }
    }
    setClasses(el, kept);
    const pin = el.attrs["data-pin"] as keyof typeof PRERENDER_PIN_STYLE | undefined;
    if (pinned && pin && pin in PRERENDER_PIN_STYLE) {
      el.attrs.style = [...styleParts(el.attrs.style), PRERENDER_PIN_STYLE[pin]].join(";");
    }
    if (el.tag === "section") {
      // The scene's progress at rest. The live scene writes the same values
      // from script before its first paint.
      const style = styleParts(el.attrs.style).filter((s) => !s.startsWith("--p"));
      el.attrs.style = style.join(";");
    }
    if (classes(el).includes("motion-safe:hidden")) {
      if (!mode.reduced) return null;
      setClasses(el, classes(el).filter((k) => k !== "motion-safe:hidden"));
    }
    if ("data-pre-download" in el.attrs) {
      if (phoneIn(mode)) return null;
      setClasses(el, classes(el).filter((k) => k !== "hidden" && k !== "sm:block"));
    }
    if ("data-pre-download-below" in el.attrs) {
      if (!phoneIn(mode)) return null;
      setClasses(el, classes(el).filter((k) => k !== "sm:hidden"));
    }
    if (el.attrs.href === `#conteudo-${locale}`) el.attrs.href = "#conteudo";
    if (el.tag === "picture" && el.children.some((n) => isEl(n) && "draggable" in n.attrs)) {
      const img = el.children.find((n): n is El => isEl(n) && n.tag === "img")!;
      const source = el.children.find(
        (n): n is El => isEl(n) && n.tag === "source" && matches(n.attrs.media, mode),
      );
      const chosen = source ?? img;
      const { srcset, sizes } = chosen.attrs;
      // A source with one bare URL is that file, as the live `src` is.
      const file: Record<string, string> =
        srcset && !/\s\d+w/.test(srcset) ? { src: srcset } : { srcset, sizes, src: img.attrs.src };
      return {
        tag: "img",
        attrs: { pick: pick(file), decoding: img.attrs.decoding, class: img.attrs.class },
        children: [],
      };
    }
    return el;
  })!;
}

/* ---------------------------------------------------------------- Tests */

describe("the static first screen against the live hero", () => {
  afterAll(async () => {
    vi.unstubAllGlobals();
    await loadLocale("en");
  });

  for (const locale of PRERENDER_LOCALES) {
    for (const mode of MODES) {
      it(`${locale}, ${mode.name}: the same elements, classes, styles, words and picture`, async () => {
        const live = normaliseLive(await renderLive(locale, mode), locale);
        const stat = resolveStatic(staticBlock(locale), locale, mode);
        // The wrapper's own attributes differ (data-l, lang); its contents must not.
        const liveLines = lines(live).slice(1);
        const staticLines = lines(stat).slice(1);
        expect(staticLines).toEqual(liveLines);
      });
    }
  }

  it("prints the h1 the live page prints, in every language", async () => {
    for (const locale of PRERENDER_LOCALES) {
      const live = await renderLive(locale, MODES[0]);
      const liveH1 = find(live, (e) => e.tag === "h1")!;
      const staticH1 = find(staticBlock(locale), (e) => e.tag === "h1")!;
      expect(staticH1, locale).toEqual(liveH1);
    }
  });

  it("names the hero picture for a screen reader in every state", () => {
    for (const locale of PRERENDER_LOCALES) {
      const img = find(staticBlock(locale), (e) => e.tag === "img" && "draggable" in e.attrs)!;
      expect(img.attrs.alt).toBe(CATALOGUES[locale]["home.hero.alt"]);
    }
  });
});

describe("the static links", () => {
  it("are the links the live buttons build", () => {
    expect(PRERENDER_HREFS.create).toBe(createIntentHref(CREATE_INTENT));
    expect(PRERENDER_HREFS.import).toBe(createIntentHref(IMPORT_INTENT));
  });
});

describe("the values copied from hero-media.ts", () => {
  it("match the live hero's", () => {
    expect(PRERENDER_MEDIA.pinQuery).toBe(media.PIN_QUERY);
    expect(PRERENDER_MEDIA.smallQuery).toBe(media.SMALL_QUERY);
    expect(PRERENDER_MEDIA.frameWidth).toBe(media.HERO_FRAME_WIDTH);
    expect(PRERENDER_MEDIA.aspect).toBe(media.HERO_ASPECT.css);
    expect(PRERENDER_MEDIA.bodyUnpinned).toBe(media.HERO_BODY_UNPINNED);
    expect(PRERENDER_MEDIA.objectPosition).toBe(media.HERO_OBJECT_POSITION);
    expect(PRERENDER_MEDIA.sizes).toBe(media.HERO_SIZES);
    expect(PRERENDER_MEDIA.focus).toEqual(media.HERO_FOCUS);
    expect(PRERENDER_MEDIA.motion).toEqual({
      src: media.HERO_PICTURE.motion.src,
      srcSet: media.HERO_PICTURE.motion.srcSet,
    });
    expect(PRERENDER_MEDIA.motionSmall).toBe(media.HERO_PICTURE.motionSmall.src);
    expect(PRERENDER_MEDIA.reduced.srcSet).toBe(media.HERO_PICTURE.reduced.srcSet);
    expect(PRERENDER_MEDIA.reducedSmall).toBe(media.HERO_PICTURE.reducedSmall.src);
    expect(PRERENDER_MEDIA.sky).toEqual(media.HERO_SKY);
    expect(PRERENDER_MEDIA.downloadBox).toBe(media.HERO_DOWNLOAD_BOX);
  });

  it("include the unpinned frame classes, written out for Tailwind", () => {
    const body = find(staticBlock("en"), (e) => e.attrs["data-pin"] === "body")!;
    const unpinned = classes(body)
      .filter((k) => k.startsWith("pre-unpin:"))
      .map((k) => k.slice("pre-unpin:".length));
    expect(unpinned.join(" ")).toBe(PRERENDER_MEDIA.bodyUnpinned);
  });

  it("draw the scene with the live runway", () => {
    expect(STATIC_HTML).toContain(`--scene-h:${PRERENDER_SCENE_HEIGHT}`);
  });
});

describe("the layout variants and the Mac reserve in index.css", () => {
  it("pin exactly where the live hero pins", () => {
    expect(INDEX_CSS).toContain(`@custom-variant pre-pin (@media ${media.PIN_QUERY});`);
    expect(INDEX_CSS).toContain(`@custom-variant pre-unpin (@media not all and ${media.PIN_QUERY});`);
  });

  it("hold the download line's room under the footage on a phone, by store", () => {
    expect(INDEX_CSS).toMatch(
      /html\[data-plat="ios"\] #pre-hero \[data-pre-download-below\] \{\s*min-height: 2\.75rem;/,
    );
    expect(INDEX_CSS).toMatch(
      /html\[data-plat="android"\] #pre-hero \[data-pre-download-below\] \{\s*min-height: 3\.5rem;/,
    );
  });

  it("hold the taller download box on a Mac with a coarse pointer, as the live box does", () => {
    expect(media.HERO_DOWNLOAD_BOX_MAC_TOUCH).toBe("[@media(pointer:coarse)]:min-h-[5.25rem]");
    expect(INDEX_CSS).toMatch(
      /@media \(pointer: coarse\) \{\s*html\[data-plat="mac"\] #pre-hero \[data-pre-download\] \{\s*min-height: 5\.25rem;/,
    );
  });
});

describe("what stays on the live page", () => {
  it("leaves the live hooks to the live page", () => {
    expect(STATIC_HTML).not.toContain("data-home-hero");
    expect(STATIC_HTML).not.toContain("inicio-ctas");
    expect(STATIC_HTML).not.toMatch(/id="conteudo"/);
    expect(STATIC_HTML).not.toContain("animate-rise");
    expect(STATIC_HTML).not.toContain("cin-reveal");
  });

  it("finds every static image the live page loads", () => {
    const files = findAll(parse(STATIC_HTML), (e) => e.tag === "img" || e.tag === "source")
      .flatMap((e) => [e.attrs.src, ...(e.attrs.srcset ?? "").split(",").map((s) => s.trim().split(/\s+/)[0])])
      .filter(Boolean);
    for (const file of files) {
      expect(file).toMatch(/^\/(media\/home|images\/hero)\//);
    }
  });
});

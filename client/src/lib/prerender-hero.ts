/**
 * The home page's first screen, written into `index.html` at build time.
 *
 * WHY THIS EXISTS. The site is a static SPA: `index.html` ships an empty
 * `<div id="root">` and the visitor sees nothing until the JS bundle has been
 * downloaded, parsed and run. On a mid-range phone over a slow link that was a
 * blank dark screen for four to six seconds. The header, the headline, the two
 * calls to action and the hero picture do not need JavaScript to be drawn, so
 * they no longer wait for it: they are plain HTML and CSS in the first
 * response, styled by the same Tailwind classes the React page uses, and paint
 * as soon as the stylesheet does.
 *
 * HOW REACT TAKES OVER. `main.tsx` renders into `#root`, and React clears what
 * is inside a fresh root, so the static block is replaced by the live page in
 * one commit. Nothing is hydrated and nothing has to match node for node: the
 * block only has to LOOK the same, element for element, which is why it copies
 * the rendered markup of the `Nav` and `Hero` of `pages/home/index.tsx`
 * (header, copy, sky, grain, and the frame with its picture). Three rules keep
 * the swap invisible:
 *
 *   - the block draws no entrance (no `animate-rise`, no reveal wrapper), and
 *     the `data-pre` attribute `main.tsx` sets on `<html>` holds the live
 *     hero's entrance still too (`html[data-pre] [data-home-hero]` in
 *     `index.css`), so nothing fades in a second time;
 *   - the live hero picks its layout with script (`PIN_QUERY` in
 *     `hero-media.ts`), the block with CSS: a class prefixed `pre-pin:` applies
 *     only where the live hero pins, `pre-unpin:` only where it does not (the
 *     two variants are defined in `index.css`), and the live hero's inline
 *     styles of the pinned layout are one `<style>` under the same query;
 *   - the hero `<picture>` resolves to the file the live `<img>` draws in each
 *     of its four states (motion or reduced motion, wide or small), so the
 *     second request is a cache hit.
 *
 * The CSS the block needs is all in the eager stylesheet (`index.css`): the
 * scene pin, the device shadow, the phone focus crop, the button press and the
 * grain. The home chunk's own CSS arrives later and must not be needed here.
 *
 * Pinned, the frame starts just under the copy. The live hero measures that
 * distance (`--lift`) after layout; the short script at the end of the block
 * does the same for the static copy, and again when a font swap changes the
 * copy's height.
 *
 * Before React arrives the buttons are links: sign in goes to `/app`, the two
 * calls to action to the links `createIntentHref` builds for the live buttons
 * (`prerender-hero-parity.test.tsx` pins them), so an early click is not lost.
 *
 * THE LCP RULE. The static picture must never be a smaller or earlier LCP
 * candidate than the live one. The browser reports a new largest-contentful
 * paint candidate whenever a later element is strictly larger than the current
 * one, and the live page's copy of the picture is a new element, so if it came
 * out larger in the viewport it would replace the static one as the LCP, and
 * the LCP would then depend on the bundle. The static picture is the live
 * picture's exact box (same classes, same aspect, same pinned transform), so its
 * replacement is never strictly larger. Keep it that way when either changes.
 *
 * COPY. Every string comes from the locale catalogues at build time
 * (`vite.config.ts` reads `src/locales/*`), so a copy edit changes the
 * catalogue and nothing here. Only the STRUCTURE is duplicated: when the hero
 * markup in `pages/home/index.tsx` changes shape, mirror it here.
 * `prerender-hero-parity.test.tsx` renders the live hero in every language and
 * layout and fails on any difference; `prerender-hero.test.ts` fails when a key
 * this block reads disappears from a catalogue.
 *
 * IMPORT-FREE ON PURPOSE. `vite.config.ts` imports this file at config time,
 * so it holds plain copies of the values in `pages/home/hero-media.ts` (the
 * parity test fails when the two differ) and no React, no TSX, no alias.
 *
 * ONE BLOCK PER LANGUAGE, chosen by CSS on `<html lang>` (`index.css`). The
 * edge middleware already writes the negotiated language into `<html lang>`,
 * and the head script in `index.html` sets it on the home route for everything
 * else (`?lang=`, a saved preference, the browser's languages), with the same
 * precedence as `detectLocale()`. A crawler without JavaScript reads the block
 * of the language the edge served, and the other two are `display:none` and
 * tagged with their own `lang`.
 */

export type PrerenderLocale = "en" | "pt-BR" | "es";

export const PRERENDER_LOCALES: readonly PrerenderLocale[] = ["en", "pt-BR", "es"];

/** Catalogue keys the block reads. Exported so the test can pin them. */
export const PRERENDER_KEYS = [
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
] as const;

export type PrerenderKey = (typeof PRERENDER_KEYS)[number];
export type PrerenderCatalogue = Record<PrerenderKey, string>;

/**
 * The block is fenced by these two comments so the edge can take it out again.
 * `index.html` is one file for every route, and a visitor or crawler that does
 * not run JavaScript would otherwise read the home page hero as the body of
 * `/vs-discord`, `/privacy`, `/@handle` and every other page. The head
 * script hides it for browsers; `client/functions/_middleware.ts` removes it
 * for everybody on every path but `/` (`stripPrerenderHero`).
 */
export const PRERENDER_START = "<!--pqp:pre-hero:start-->";
export const PRERENDER_END = "<!--pqp:pre-hero:end-->";

/** `html` without the prerendered block. Unchanged when the block is absent. */
export function stripPrerenderHero(html: string): string {
  const start = html.indexOf(PRERENDER_START);
  if (start === -1) {
    return html;
  }
  const end = html.indexOf(PRERENDER_END, start);
  if (end === -1) {
    return html;
  }
  return html.slice(0, start) + html.slice(end + PRERENDER_END.length);
}

/** The comment in `index.html` this block replaces. */
export const PRERENDER_PLACEHOLDER = "<!--pqp:prerender-hero-->";

/**
 * Plain copies of `pages/home/hero-media.ts`, which the live hero reads. The
 * parity test compares every field, so a change there fails until it is
 * copied here.
 */
export const PRERENDER_MEDIA = {
  pinQuery: "(min-width: 1024px) and (prefers-reduced-motion: no-preference)",
  smallQuery: "(max-width: 1023px)",
  frameWidth: "min(92vw, 1440px, calc((100svh - 10rem) * 1.6000))",
  aspect: "16 / 10",
  bodyUnpinned: "aspect-[4/3] sm:aspect-[16/10]",
  objectPosition: "object-left-top sm:object-top",
  sizes: "(min-width: 1024px) min(92vw, 1440px), 100vw",
  focus: { x: 15, y: 58, zoom: 1.25 },
  motion: {
    src: "/media/home/call-join.webp",
    srcSet: "/media/home/call-join-960.webp 960w, /media/home/call-join.webp 1920w",
  },
  motionSmall: "/media/home/call-join-960.webp",
  reduced: {
    srcSet:
      "/media/home/still-call-join-960.webp 960w, /media/home/still-call-join-1440.webp 1440w, /media/home/still-call-join.webp 2880w",
  },
  reducedSmall: "/media/home/still-call-join-960.webp",
  sky: {
    avifSrcSet:
      "/images/hero/hero-800.avif 800w, /images/hero/hero-1200.avif 1200w, /images/hero/hero-1536.avif 1536w",
    src: "/images/hero/hero-1200.webp",
    srcSet:
      "/images/hero/hero-800.webp 800w, /images/hero/hero-1200.webp 1200w, /images/hero/hero-1536.webp 1536w",
    sizes: "100vw",
    width: 1536,
    height: 1024,
  },
  downloadBox: "min-h-[4rem]",
} as const;

/** The scene's runway, `height` on the live `Scene`. */
export const PRERENDER_SCENE_HEIGHT = "230vh";

/**
 * The live hero's inline styles in the pinned layout, as React writes them,
 * keyed by the `data-pin` name of the element that carries them. Unpinned, the
 * live elements have no style, and neither do these.
 */
export const PRERENDER_PIN_STYLE = {
  sky: "opacity:calc(1 - var(--p-sky) * 0.8);transform:translate3d(0, calc(var(--p-sky) * -10vh), 0);will-change:transform, opacity",
  copy: "opacity:calc(1 - var(--p-copy));transform:translate3d(0, calc(var(--p-copy) * -96px), 0) scale(calc(1 - var(--p-copy) * 0.05));will-change:transform, opacity",
  box: `width:${PRERENDER_MEDIA.frameWidth}`,
  frame:
    "transform:translate3d(0, calc((1 - var(--p-frame)) * var(--lift, 0px)), 0) scale(calc(0.68 + 0.32 * var(--p-frame))) perspective(1500px) rotateX(calc((1 - var(--p-frame)) * 24deg));transform-origin:50% 0%;will-change:transform",
  body: `aspect-ratio:${PRERENDER_MEDIA.aspect}`,
} as const;

/** The links the buttons are before React arrives. */
export const PRERENDER_HREFS = {
  signIn: "/app",
  create: "/app?create=new",
  import: "/app?import=discord",
} as const;

const LOCALE_CODE: Record<PrerenderLocale, string> = {
  en: "EN",
  "pt-BR": "PT",
  es: "ES",
};

/** `FlagChip` of `language-picker.tsx`, as it renders. */
const FLAG_SVG: Record<PrerenderLocale, string> = {
  en: '<svg viewBox="0 0 60 30" preserveAspectRatio="xMidYMid slice" class="h-full w-full" role="presentation"><rect width="60" height="30" class="fill-flag-uk-blue"></rect><path d="M0,0 L60,30 M60,0 L0,30" class="stroke-flag-uk-white" stroke-width="6"></path><path d="M0,0 L60,30 M60,0 L0,30" class="stroke-flag-uk-red" stroke-width="2.5"></path><path d="M30,0 V30 M0,15 H60" class="stroke-flag-uk-white" stroke-width="10"></path><path d="M30,0 V30 M0,15 H60" class="stroke-flag-uk-red" stroke-width="6"></path></svg>',
  "pt-BR":
    '<svg viewBox="0 0 20 14" class="h-full w-full" role="presentation"><rect width="20" height="14" class="fill-flag-br-green"></rect><polygon points="10,1.4 18.4,7 10,12.6 1.6,7" class="fill-flag-br-yellow"></polygon><circle cx="10" cy="7" r="3.1" class="fill-flag-br-blue"></circle><path d="M6.6,5.9 C8.2,7.9 11.8,7.9 13.6,9.4" class="stroke-flag-br-white" stroke-width="0.5" fill="none"></path><g class="fill-flag-br-white"><circle cx="8.1" cy="5.5" r="0.24"></circle><circle cx="9.4" cy="4.9" r="0.24"></circle><circle cx="11.1" cy="5.2" r="0.24"></circle><circle cx="12.1" cy="6.1" r="0.24"></circle><circle cx="8.6" cy="8.4" r="0.24"></circle><circle cx="10.4" cy="8.7" r="0.24"></circle></g></svg>',
  es: '<svg viewBox="0 0 20 14" class="h-full w-full" role="presentation"><rect width="20" height="14" class="fill-flag-es-red"></rect><rect y="3.5" width="20" height="7" class="fill-flag-es-yellow"></rect></svg>',
};

/* Lucide icons, as `lucide-react` renders them. */
const SVG_OPEN =
  'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const ICON_CHEVRON = `<svg ${SVG_OPEN} class="lucide lucide-chevron-down h-3 w-3 opacity-70" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>`;
const ICON_ARROW = `<svg ${SVG_OPEN} class="lucide lucide-arrow-right h-4 w-4" aria-hidden="true"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg>`;
const ICON_LOCK = `<svg ${SVG_OPEN} class="lucide lucide-lock h-2.5 w-2.5 shrink-0 opacity-70 sm:h-3 sm:w-3"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;
const ICON_RELOAD = `<svg ${SVG_OPEN} class="lucide lucide-rotate-cw ml-auto hidden h-3.5 w-3.5 text-paper-muted/50 sm:block"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path></svg>`;
const ICON_PLAY = `<svg ${SVG_OPEN} class="lucide lucide-play h-4 w-4" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>`;

/* Class strings, as the live page renders them (after `cn()`). */
const ROOT = "min-h-screen overflow-x-clip bg-ink text-paper [&_section]:scroll-mt-0";
const SKIP_LINK =
  "sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-full focus:bg-paper focus:px-5 focus:py-3 focus:text-sm focus:font-semibold focus:text-ink";
const HEADER =
  "sticky top-0 z-50 border-b transition-[background-color,border-color] duration-300 border-transparent bg-transparent";
const CONTAINER = "mx-auto w-full max-w-[1200px] px-5 sm:px-8";
const BETA =
  "inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-[0.14em] transition-[color,border-color,background-color] duration-[var(--duration-base)] border-accent/30 bg-accent/10 text-accent";
const NAV = "hidden min-w-0 items-center gap-5 text-sm text-paper-muted lg:flex";
const NAV_LINK = "whitespace-nowrap transition-colors hover:text-paper";
const PICKER =
  "shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium tracking-wide transition-colors duration-150 border-ink-4/60 text-paper-muted hover:border-ink-4 hover:text-paper hidden sm:inline-flex";
const FLAG =
  "inline-flex h-3.5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-[3px] border border-ink-4/70";
const SIGN_IN =
  "inline-flex h-10 items-center rounded-full px-3 text-sm font-medium text-paper-muted transition-colors hover:text-paper sm:h-9";
const NAV_CTA =
  "inline-flex h-10 items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink transition-colors hover:bg-signal sm:h-9";
const SKY =
  "pointer-events-none absolute inset-x-0 top-0 h-[74%] max-h-[56rem] overflow-hidden";
const SKY_IMG =
  "h-full w-full object-cover object-[50%_35%] [mask-image:linear-gradient(to_bottom,black_0%,black_40%,transparent_100%)]";
const SKY_BAND =
  "absolute inset-0 bg-ink/70 lg:bg-transparent lg:bg-gradient-to-r lg:from-ink lg:from-15% lg:via-ink/80 lg:via-50% lg:to-ink/10 lg:to-85%";
const SKY_FADE = "absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-b from-transparent to-ink";
const GRAIN =
  "hp-grain pointer-events-none absolute inset-0 opacity-70 [mask-image:linear-gradient(to_bottom,black_55%,transparent)]";
const H1 =
  "max-w-[17ch] font-display text-[clamp(2.75rem,min(6.4vw,10.6vh),5.75rem)] font-bold leading-[0.96] tracking-[-0.035em] text-balance";
const BODY =
  "mt-4 max-w-[36rem] text-base leading-relaxed text-paper-muted text-pretty sm:mt-6 sm:text-xl";
const CTAS = "mt-6 flex w-full flex-col gap-3 sm:mt-8 sm:w-auto sm:flex-row";
const BTN_PRIMARY =
  "cta-lift cin-press inline-flex h-12 items-center justify-center gap-2 rounded-full bg-signal px-6 text-[15px] font-semibold text-ink transition-[background-color,transform] hover:bg-signal-dim motion-safe:active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-ink w-full sm:w-auto";
const BTN_SECONDARY =
  "cta-lift cin-press inline-flex h-12 items-center justify-center gap-2 rounded-full px-6 text-[15px] font-medium text-paper ring-1 ring-inset ring-white/15 transition-colors hover:bg-white/[0.06] motion-safe:active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal w-full sm:w-auto";
const FREE_ROW = "mt-4 flex flex-col items-start gap-2 sm:mt-5";
const FREE_LINE = "max-w-[36rem] text-sm text-paper-muted";
const FRAME =
  "pointer-events-auto relative isolate data-settled:transform-none! data-settled:will-change-auto!";
const DEVICE = "cin-device relative isolate rounded-[14px] bg-ink-2 sm:rounded-[18px]";
const BAR =
  "relative flex h-8 items-center gap-3 border-b border-white/[0.06] bg-[linear-gradient(to_bottom,color-mix(in_oklch,var(--color-text)_6%,transparent),transparent)] px-3 sm:h-10 sm:px-4";
const BAR_DOT = "h-2 w-2 rounded-full sm:h-2.5 sm:w-2.5";
const BAR_URL =
  "absolute left-1/2 flex h-5 w-[min(44%,22rem)] -translate-x-1/2 items-center justify-center gap-1.5 rounded-md bg-white/[0.05] px-3 text-[10px] text-paper-muted ring-1 ring-inset ring-white/[0.05] sm:h-6 sm:text-[11px]";
const CLIP = "isolate block w-full overflow-hidden bg-ink-2 h-full absolute inset-0";
const CLIP_IMG = `absolute inset-0 h-full w-full object-cover ${PRERENDER_MEDIA.objectPosition}`;
const CONTROL =
  "absolute bottom-3 right-3 z-10 inline-flex h-10 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-inset ring-white/15 transition-colors hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal w-10 max-md:bottom-auto max-md:top-3 lg:bottom-auto lg:left-3 lg:right-auto lg:top-3";
const RING =
  "pointer-events-none absolute inset-0 z-[2] rounded-[inherit] ring-1 ring-inset ring-white/[0.09]";
const CAPTION = "mt-4 text-xs text-paper-muted sm:text-[13px]";

/*
 * The parts that differ between the two layouts, written out as whole class
 * names so Tailwind finds them in this file. `pre-pin:` is the live hero's
 * pinned branch, `pre-unpin:` the other one (`index.tsx`, the `pinned ? :`
 * class pairs).
 */
const STAGE = "cin-stage relative pre-unpin:pt-16";
const COPY =
  "z-10 data-faded:pointer-events-none pre-pin:absolute pre-pin:inset-x-0 pre-pin:top-0 pre-pin:pt-[calc(4rem+4.5vh)] pre-unpin:relative pre-unpin:pt-6 pre-unpin:sm:pt-16";
const WRAP =
  "px-5 pre-pin:pointer-events-none pre-pin:absolute pre-pin:inset-0 pre-pin:z-20 pre-pin:flex pre-pin:items-center pre-pin:justify-center pre-pin:pt-16 pre-unpin:mx-auto pre-unpin:w-full pre-unpin:max-w-[1200px] pre-unpin:sm:px-8 pre-unpin:relative pre-unpin:pb-14 pre-unpin:pt-4 pre-unpin:sm:pb-28 pre-unpin:sm:pt-10";
const BOX = "pointer-events-none relative w-full";
const DEVICE_BODY = "relative bg-ink pre-unpin:aspect-[4/3] pre-unpin:sm:aspect-[16/10]";
/*
 * The download line's room, empty until the live line arrives. From sm it is
 * the live box under the buttons, `min-h-[4rem]` (taller on a Mac with a coarse
 * pointer). Below sm the live line sits under the footage instead, in a
 * wrapper as tall as the store's pill or badge. Both heights by platform are in
 * `index.css`, keyed on the `data-plat` the head script sets.
 */
const DOWNLOAD = `hidden ${PRERENDER_MEDIA.downloadBox} sm:block`;
const DOWNLOAD_BELOW = "pointer-events-auto relative mt-5 flex justify-start sm:hidden";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SLOT = /\{(\w+)\}/g;

/**
 * The h1's words: `home.hero.title` with its one `{accent}` filled in, as
 * `rich()` does on the live page (the accent is plain text there too).
 * Throws on any other shape, since the static h1 could not follow it.
 */
function heroTitle(locale: PrerenderLocale, c: PrerenderCatalogue): string {
  const title = c["home.hero.title"];
  const slots = title.match(SLOT) ?? [];
  if (slots.length !== 1 || slots[0] !== "{accent}") {
    throw new Error(
      `prerender-hero: ${locale} "home.hero.title" must hold exactly one {accent} and no other slot`,
    );
  }
  const [before, after] = title.split("{accent}");
  return esc(before) + esc(c["home.hero.titleAccent"]) + esc(after);
}

/** The stylesheet for the pinned layout: the live inline styles, by query. */
function pinStyle(): string {
  const rules = Object.entries(PRERENDER_PIN_STYLE)
    .map(([name, style]) => `#pre-hero [data-pin="${name}"]{${style}}`)
    .join("");
  return `<style>@media ${PRERENDER_MEDIA.pinQuery}{${rules}}</style>`;
}

/**
 * Pinned, `--lift` the way the live hero measures it (`index.tsx`, the
 * `offsetWithin` effect): from the frame's place to 44 px under the copy. Only
 * for the block on screen, again when the copy's height changes (a font swap)
 * or the layout query flips, and never once React has replaced the block.
 * ES5, no dependencies, and silent on any error.
 */
function liftScript(): string {
  const query = JSON.stringify(PRERENDER_MEDIA.pinQuery);
  return `<script>(function(){try{var d=document,r=d.getElementById("pre-hero");if(!r||d.documentElement.getAttribute("data-route")!=="home"||!window.matchMedia)return;var mq=window.matchMedia(${query}),ro=null;function top(el,a){var t=0;while(el&&el!==a){t+=el.offsetTop;el=el.offsetParent}return t}function stop(){if(ro)ro.disconnect();ro=null;if(mq.removeEventListener)mq.removeEventListener("change",measure);else if(mq.removeListener)mq.removeListener(measure)}function measure(){if(!d.documentElement.contains(r)){stop();return}var b=r.querySelectorAll("[data-l]");for(var i=0;i<b.length;i++){var s=b[i].querySelector('[data-pin="stage"]'),c=b[i].querySelector('[data-pin="copy"]'),x=b[i].querySelector('[data-pin="box"]');if(!s||!c||!x)continue;if(!mq.matches||!b[i].getClientRects().length){s.style.removeProperty("--lift");continue}s.style.setProperty("--lift",Math.max(0,top(c,s)+c.offsetHeight+44-top(x,s))+"px")}}measure();if(window.ResizeObserver){ro=new ResizeObserver(measure);var o=r.querySelectorAll('[data-pin="stage"],[data-pin="copy"]');for(var j=0;j<o.length;j++)ro.observe(o[j])}if(mq.addEventListener)mq.addEventListener("change",measure);else if(mq.addListener)mq.addListener(measure)}catch(e){}})();</script>`;
}

function header(locale: PrerenderLocale, c: PrerenderCatalogue): string {
  const links = (
    [
      ["#noite", "home.nav.night"],
      ["#mudanca", "home.nav.move"],
      ["#brinquedos", "nav.features"],
      ["#codigo", "home.nav.code"],
      ["#perguntas", "home.nav.faq"],
    ] as const
  )
    .map(([href, key]) => `<a href="${href}" class="${NAV_LINK}">${esc(c[key])}</a>`)
    .join("");
  // The language picker's face only (`aria-hidden`): the live menu replaces it.
  const picker = `<span aria-hidden="true" class="${PICKER}"><span aria-hidden="true" class="${FLAG}">${FLAG_SVG[locale]}</span><span>${LOCALE_CODE[locale]}</span>${ICON_CHEVRON}</span>`;
  return `<header class="${HEADER}"><div class="${CONTAINER} flex h-16 items-center gap-6"><a href="/" class="inline-flex min-h-10 items-center gap-2 font-brand text-xl tracking-tight">pqp<span class="hidden min-[380px]:inline-flex"><span class="${BETA}">beta</span></span></a><nav aria-label="${esc(c["home.nav.label"])}" class="${NAV}">${links}</nav><div class="ml-auto flex items-center gap-2 sm:gap-3">${picker}<a href="${PRERENDER_HREFS.signIn}" class="${SIGN_IN}">${esc(c["nav.signIn"])}</a><a href="${PRERENDER_HREFS.create}" class="${NAV_CTA}">${esc(c["home.nav.create"])}</a></div></div></header>`;
}

function sky(): string {
  const s = PRERENDER_MEDIA.sky;
  return `<div aria-hidden="true" data-pin="sky" class="${SKY}"><picture><source type="image/avif" srcset="${s.avifSrcSet}" sizes="${s.sizes}"><img src="${s.src}" srcset="${s.srcSet}" sizes="${s.sizes}" alt="" width="${s.width}" height="${s.height}" decoding="async" fetchpriority="low" class="${SKY_IMG}"></picture><div class="${SKY_BAND}"></div><div class="${SKY_FADE}"></div></div>`;
}

/**
 * The hero picture in all four of the live states: reduced motion picks the
 * still of the full room, below 1024 px the small file with no `srcset`, and
 * the wide motion file is the fallback. Eager and with no `fetchpriority`, so
 * the live `<img>` (high priority only when wide) finds it in the cache.
 */
function heroPicture(c: PrerenderCatalogue): string {
  const m = PRERENDER_MEDIA;
  return `<picture><source media="(prefers-reduced-motion: reduce) and ${m.smallQuery}" srcset="${m.reducedSmall}"><source media="(prefers-reduced-motion: reduce)" srcset="${m.reduced.srcSet}" sizes="${m.sizes}"><source media="${m.smallQuery}" srcset="${m.motionSmall}"><img src="${m.motion.src}" srcset="${m.motion.srcSet}" sizes="${m.sizes}" alt="${esc(c["home.hero.alt"])}" loading="eager" decoding="async" draggable="false" class="${CLIP_IMG}"></picture>`;
}

function frame(c: PrerenderCatalogue): string {
  const f = PRERENDER_MEDIA.focus;
  const bar = `<div aria-hidden="true" class="${BAR}"><span class="flex shrink-0 gap-1.5"><span class="${BAR_DOT} bg-white/[0.16]"></span><span class="${BAR_DOT} bg-white/[0.12]"></span><span class="${BAR_DOT} bg-white/[0.08]"></span></span><span class="${BAR_URL}">${ICON_LOCK}<span class="truncate">pqp.gg/app</span></span>${ICON_RELOAD}</div>`;
  // The play control the live clip draws under reduced motion, face only.
  const control = `<span aria-hidden="true" class="${CONTROL} motion-safe:hidden">${ICON_PLAY}</span>`;
  const media = `<div class="cin-clip-media absolute inset-0" data-focus="" style="--focus-x:${f.x}%;--focus-y:${f.y}%;--focus-zoom:${f.zoom}">${heroPicture(c)}</div>`;
  return `<div data-pin="box" class="${BOX}"><div data-pin="frame" class="${FRAME}"><div style="--stagger:1"><div class="${DEVICE}"><div class="relative overflow-hidden rounded-[inherit]">${bar}<div data-pin="body" class="${DEVICE_BODY}"><div class="${CLIP}">${media}${control}</div></div><span aria-hidden="true" class="${RING}"></span></div></div><p class="${CAPTION}">${esc(c["home.hero.caption"])}</p></div></div></div>`;
}

function block(locale: PrerenderLocale, c: PrerenderCatalogue): string {
  const copy = `<div data-pin="copy" class="${COPY}"><div class="${CONTAINER} flex flex-col items-start"><h1 class="${H1}">${heroTitle(locale, c)}</h1><p class="${BODY}">${esc(c["home.hero.body"])}</p><div class="${CTAS}"><a href="${PRERENDER_HREFS.create}" class="${BTN_PRIMARY}">${esc(c["home.cta.create"])}${ICON_ARROW}</a><a href="${PRERENDER_HREFS.import}" class="${BTN_SECONDARY}">${esc(c["home.cta.import"])}</a></div><div class="${FREE_ROW}"><p class="${FREE_LINE}">${esc(c["home.cta.free"])} ${esc(c["home.hero.made"])} <span class="whitespace-nowrap">${esc(c["home.cta.providers"])}</span></p><div data-pre-download="" class="${DOWNLOAD}"></div></div></div></div>`;
  const section = `<section aria-label="${esc(c["home.hero.label"])}" class="cin-scene relative -mt-16" style="--scene-h:${PRERENDER_SCENE_HEIGHT};--p:0;--p-copy:0;--p-frame:0;--p-sky:0"><div data-pin="stage" class="${STAGE}">${sky()}<div aria-hidden="true" class="${GRAIN}"></div>${copy}<div class="${WRAP}">${frame(c)}<div data-pre-download-below="" class="${DOWNLOAD_BELOW}"></div></div></div></section>`;
  return `<div data-l="${locale}" lang="${locale}" class="${ROOT}"><a href="#conteudo-${locale}" class="${SKIP_LINK}">${esc(c["nav.skipToContent"])}</a>${header(locale, c)}<main id="conteudo-${locale}" tabindex="-1" class="outline-none">${section}</main></div>`;
}

/**
 * The whole block: the pinned stylesheet, one child per language, and the
 * `--lift` script.
 *
 * Throws when a catalogue lacks a key, when a value other than the title holds
 * a `{slot}`, or when the title is not one `{accent}` and nothing else: a
 * missing string would print `undefined` on the first screen of the site, and
 * a build that fails is the cheaper way to learn that.
 */
export function renderPrerenderHero(
  catalogues: Record<PrerenderLocale, Record<string, string>>,
): string {
  const blocks = PRERENDER_LOCALES.map((locale) => {
    const source = catalogues[locale];
    const picked = {} as PrerenderCatalogue;
    for (const key of PRERENDER_KEYS) {
      const value = source?.[key];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`prerender-hero: ${locale} catalogue has no "${key}"`);
      }
      if (key !== "home.hero.title" && new RegExp(SLOT).test(value)) {
        throw new Error(`prerender-hero: ${locale} "${key}" holds a {slot} the block cannot fill`);
      }
      picked[key] = value;
    }
    return block(locale, picked);
  });
  return `${PRERENDER_START}<div id="pre-hero">${pinStyle()}\n${blocks.join("\n")}\n${liftScript()}</div>${PRERENDER_END}`;
}

/**
 * Replace the placeholder in an `index.html` string.
 *
 * Returns the html untouched when the placeholder is absent, so a custom
 * `index.html` (a self-host's) keeps working without the block.
 */
export function injectPrerenderHero(html: string, block: string): string {
  return html.includes(PRERENDER_PLACEHOLDER)
    ? html.replace(PRERENDER_PLACEHOLDER, () => block)
    : html;
}

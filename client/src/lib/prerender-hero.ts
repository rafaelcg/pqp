/**
 * The landing page's first screen, written into `index.html` at build time.
 *
 * WHY THIS EXISTS. The site is a static SPA: `index.html` ships an empty
 * `<div id="root">` and the visitor sees nothing until the JS bundle has been
 * downloaded, parsed and run. On a mid-range phone over a slow link that was a
 * blank dark screen for four to six seconds, and Lighthouse measured the
 * headline as the largest contentful paint at 11 s. The words and the picture
 * do not need JavaScript to be drawn, so they no longer wait for it: the
 * header, the headline, the two calls to action and the product screenshot are
 * plain HTML and CSS in the first response, styled by the same Tailwind classes
 * the React page uses, and paint as soon as the stylesheet does.
 *
 * HOW REACT TAKES OVER. `main.tsx` renders into `#root`, and React clears what
 * is inside a fresh root, so the static block is simply replaced by the live
 * page in one commit. Nothing is hydrated and nothing has to match node for
 * node: the block only has to LOOK the same, which is why it borrows the
 * classes of `landing-page.tsx`, `marketing-nav.tsx` and
 * `marketing-auth-ctas.tsx`. Two rules keep the swap invisible:
 *
 *   - the blocks do not animate (`animate-rise`, `hero-parallax`), and the
 *     `data-pre` attribute the head script sets on `<html>` switches the same
 *     animations off for the React copy, so nothing fades in a second time;
 *   - the background picture is one CSS class (`hero-bg-art`) shared by both,
 *     so the two pick the same file and the second is a cache hit.
 *
 * Before React arrives the two buttons are links to `/app`, which is also what
 * the live buttons do when Clerk is not ready, so an early click is not lost.
 *
 * COPY. Every string comes from the locale catalogues at build time
 * (`vite.config.ts` reads `src/locales/*`), so a copy edit changes the catalogue
 * and nothing here. Only the STRUCTURE is duplicated: when the hero markup in
 * `landing-page.tsx` changes shape, mirror it here. `prerender-hero.test.ts`
 * fails when a key this block reads disappears from a catalogue.
 *
 * THE SCREENSHOT SITS FOUR PIXELS HIGHER than the live page's (`mt-[3.25rem]`
 * against `mt-14`), on purpose. It is the largest contentful paint on a phone,
 * and the browser reports a new candidate whenever a later element is strictly
 * larger than the current one. The live page's copy of the picture is a new
 * element, so if it came out a pixel taller in the viewport it would replace
 * the static one as the LCP, and the LCP would then depend on the bundle. A
 * static picture that shows four more pixels can never be beaten by its own
 * replacement, at the price of the picture settling four pixels lower when
 * React takes over.
 *
 * ONE BLOCK PER LANGUAGE, chosen by CSS on `<html lang>` (`index.css`). The edge
 * middleware already writes the negotiated language into `<html lang>`, and the
 * head script in `index.html` sets it on the home route for everything else
 * (`?lang=`, a saved preference, the browser's languages), with the same
 * precedence as `detectLocale()`. A crawler without JavaScript reads the block
 * of the language the edge served, and the other two are `display:none` and
 * tagged with their own `lang`.
 */

export type PrerenderLocale = "en" | "pt-BR" | "es";

export const PRERENDER_LOCALES: readonly PrerenderLocale[] = [
  "en",
  "pt-BR",
  "es",
];

/** Catalogue keys the block reads. Exported so the test can pin them. */
export const PRERENDER_KEYS = [
  "nav.join",
  "nav.signIn",
  "nav.features",
  "footer.vsDiscord",
  "nav.download",
  "nav.selfHost",
  "nav.skipToContent",
  "landing.hero.eyebrow",
  "landing.hero.title",
  "landing.hero.body",
  "landing.hero.action",
  "landing.hero.hint",
  "landing.hero.providers",
  "landing.shot.hero",
  "landing.proof.openSource",
  "landing.proof.watchParty",
  "landing.proof.region",
  "landing.proof.platforms",
  "landing.proof.languages",
] as const;

export type PrerenderKey = (typeof PRERENDER_KEYS)[number];
export type PrerenderCatalogue = Record<PrerenderKey, string>;

/** The comment in `index.html` this block replaces. */
export const PRERENDER_PLACEHOLDER = "<!--pqp:prerender-hero-->";

const LOCALE_CODE: Record<PrerenderLocale, string> = {
  en: "EN",
  "pt-BR": "PT",
  es: "ES",
};

/**
 * The flag chip of `language-picker.tsx`, without the SVG: a 20 by 14 box in
 * the flag's main colours. The live picker replaces it a moment later.
 */
const FLAG_STYLE: Record<PrerenderLocale, string> = {
  en: "background:var(--color-flag-uk-blue)",
  "pt-BR": "background:var(--color-flag-br-blue)",
  es: "background:linear-gradient(var(--color-flag-es-red) 25%,var(--color-flag-es-yellow) 25% 75%,var(--color-flag-es-red) 75%)",
};

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The screenshot under the hero, at the widths a phone, a laptop and a large
 * screen need (8, 15 and 21 kB against the 44 kB original, which stays as the
 * fallback `src`). `product-frames.tsx` passes the same two strings, so the
 * live page picks the same file and the cache answers.
 */
export const HERO_SHOT_SRCSET =
  "/images/product/hero-640.webp 640w, /images/product/hero-960.webp 960w, /images/product/hero-1280.webp 1280w, /images/product/hero.webp 1920w";
export const HERO_SHOT_SIZES = "(min-width: 1088px) 1024px, calc(100vw - 40px)";

/**
 * The row of five facts under the hero. It is here for its HEIGHT as much as its
 * words: the hero picture is `background-size: cover` over the whole section, so
 * a section that is shorter than the live page's would crop and scale the
 * picture differently, and the whole backdrop would visibly shift when React
 * took over. `href` is where the live page sends each one (`PROOF` in
 * `landing-page.tsx`); the source link is the repository, the same constant as
 * `SOURCE_REPO_URL` in `downloads.ts`, which `prerender-hero.test.ts` pins.
 */
export const PRERENDER_SOURCE_REPO_URL = "https://github.com/rafaelcg/pqp";

const PROOF_LINK =
  "inline-flex items-center text-[11px] font-medium uppercase tracking-[0.22em] text-white/70 underline decoration-transparent underline-offset-4 transition-colors duration-150 hover:text-white hover:decoration-white/70 [@media(pointer:coarse)]:min-h-11";

const NAV_LINK =
  "whitespace-nowrap text-xs font-medium uppercase tracking-[0.12em] transition-colors duration-150 lg:tracking-[0.18em] text-white/70 hover:text-white";

const SKIP_LINK =
  "sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-paper focus:px-5 focus:py-3 focus:text-sm focus:font-semibold focus:text-ink focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-signal";

const JOIN_BUTTON =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-control)] text-sm transition-[background,color,transform] duration-[var(--duration-fast)] font-semibold h-[var(--control-md)] px-4 py-2 cta-lift bg-white text-ink shadow-lg shadow-black/20 hover:bg-white/90";

const NAV_SIGN_IN =
  "hidden px-3 py-1.5 text-sm font-medium transition-colors duration-150 sm:inline text-white/85 hover:text-white";

const HERO_PRIMARY =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap transition-[background,color,transform] duration-[var(--duration-fast)] py-2 cta-lift h-11 rounded-full bg-white px-6 text-base font-semibold text-ink shadow-lg shadow-black/25 hover:bg-white/90";

const HERO_SECONDARY =
  "cta-lift inline-flex h-11 items-center rounded-full px-5 text-base font-medium text-white/90 ring-1 ring-white/40 backdrop-blur-sm hover:bg-white/15";

const EYEBROW =
  "font-display text-xs font-bold uppercase tracking-[0.22em] text-white/80";

function block(locale: PrerenderLocale, c: PrerenderCatalogue): string {
  // "Self-host" stays English in the other languages, on purpose, the same way
  // `marketing-nav.tsx` does it.
  const selfHostLang = locale === "en" ? "" : ' lang="en"';
  return `<div data-l="${locale}" lang="${locale}" class="min-h-full bg-ink text-paper">
<a href="#main" class="${SKIP_LINK}">${esc(c["nav.skipToContent"])}</a>
<div class="sticky top-0 z-30"><header class="relative z-20 flex h-16 items-center justify-between border-b px-5 sm:px-8 border-transparent bg-transparent"><a href="/" class="flex items-center gap-2 font-brand text-xl tracking-tight text-white">pqp<span class="inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-[0.14em] border-white/35 bg-white/10 text-white/85">beta</span></a><nav class="hidden min-w-0 shrink items-center gap-5 md:flex lg:gap-8"><a href="/#features" class="${NAV_LINK}">${esc(c["nav.features"])}</a><a href="/vs-discord" class="${NAV_LINK}">${esc(c["footer.vsDiscord"])}</a><a href="/download" class="${NAV_LINK}">${esc(c["nav.download"])}</a><a href="/#hosting" class="${NAV_LINK} hidden lg:inline"${selfHostLang}>${esc(c["nav.selfHost"])}</a></nav><div class="flex shrink-0 items-center gap-3"><span aria-hidden="true" class="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium tracking-wide border-white/25 bg-white/5 text-white/80"><span class="inline-flex h-3.5 w-5 shrink-0 overflow-hidden rounded-[3px] border border-ink-4/70" style="${FLAG_STYLE[locale]}"></span><span>${LOCALE_CODE[locale]}</span><span class="h-3 w-3"></span></span><div class="flex flex-wrap items-center justify-center gap-2"><a href="/app" class="${JOIN_BUTTON}">${esc(c["nav.join"])}</a><a href="/app" class="${NAV_SIGN_IN}">${esc(c["nav.signIn"])}</a></div></div></header></div>
<main id="main" tabindex="-1" class="outline-none"><section class="relative -mt-16 overflow-hidden"><div class="hero-parallax-still pointer-events-none absolute inset-0" aria-hidden="true"><div class="hero-bg-art absolute inset-0"></div></div><div class="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/60 via-black/45 to-ink" aria-hidden="true"></div><div class="hero-grain pointer-events-none absolute inset-0" aria-hidden="true"></div><div class="relative z-10 mx-auto flex max-w-6xl flex-col items-center px-5 pb-10 pt-28 text-center sm:px-8 sm:pt-36"><p class="${EYEBROW}">${esc(c["landing.hero.eyebrow"])}</p><h1 class="mt-5 max-w-4xl font-display text-4xl font-bold leading-[1.02] tracking-tight text-white sm:text-6xl md:text-7xl">${esc(c["landing.hero.title"])}</h1><p class="mt-6 max-w-2xl text-lg text-white/85 sm:text-xl">${esc(c["landing.hero.body"])}</p><div class="mt-9"><div class="flex flex-wrap items-center justify-center gap-2"><a href="/app" class="${HERO_PRIMARY}">${esc(c["landing.hero.action"])}</a><a href="/app" class="${HERO_SECONDARY}">${esc(c["nav.signIn"])}</a></div></div><p class="mt-4 max-w-md text-sm text-white/65">${esc(c["landing.hero.hint"])} ${esc(c["landing.hero.providers"])}</p><div class="pre-download mt-4"></div><div class="mt-[3.25rem] w-full"><figure class="overflow-hidden rounded-2xl border border-white/10 bg-ink-2 shadow-[var(--shadow-profile-card)] mx-auto w-full max-w-5xl"><img src="/images/product/hero.webp" srcset="${HERO_SHOT_SRCSET}" sizes="${HERO_SHOT_SIZES}" alt="${esc(c["landing.shot.hero"])}" width="1920" height="1080" class="block w-full object-cover h-auto object-left" fetchpriority="high" decoding="async"></figure></div></div><ul class="relative z-10 mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-x-8 gap-y-2 px-5 pb-10 sm:px-8"><li><a href="${PRERENDER_SOURCE_REPO_URL}" target="_blank" rel="noopener" class="${PROOF_LINK}">${esc(c["landing.proof.openSource"])}</a></li><li><a href="/watch-party" class="${PROOF_LINK}">${esc(c["landing.proof.watchParty"])}</a></li><li><a href="/#where" class="${PROOF_LINK}">${esc(c["landing.proof.region"])}</a></li><li><a href="/download" class="${PROOF_LINK}">${esc(c["landing.proof.platforms"])}</a></li><li><span class="text-[11px] font-medium uppercase tracking-[0.22em] text-white/70">${esc(c["landing.proof.languages"])}</span></li></ul></section></main>
</div>`;
}

/**
 * The whole block: one wrapper, one child per language.
 *
 * Throws when a catalogue lacks a key: a missing string would print
 * `undefined` on the first screen of the site, and a build that fails is the
 * cheaper way to learn that.
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
      picked[key] = value;
    }
    return block(locale, picked);
  });
  return `<div id="pre-hero">\n${blocks.join("\n")}\n</div>`;
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

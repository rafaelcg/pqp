/**
 * The edge's half of the pqp Apps pages: which paths they are, and the head
 * each one gets.
 *
 * THE SAME PROBLEM `marketing-meta.ts` SOLVES, with one difference that is the
 * whole reason this is a file of its own. The marketing pages always exist, so
 * they live in a registry the sitemap reads. These three exist only while the
 * runtime flag `apps_landing` is on (`GET /api/public/apps/config`), and a
 * sitemap is built into the bundle: listing them there would advertise pages
 * that can answer a redirect. So they stay out of that registry, the middleware
 * asks the flag before it writes a head (`client/functions/_middleware.ts`),
 * and with the flag off or unknown the shipped document is served untouched.
 *
 * `/apps`, `/apps/locadora` and `/locadora` are the three paths. The last is
 * the short link people type and paste, and it is the same page as
 * `/apps/locadora`, canonicalised there the way `/claim` is to `/garanta`.
 *
 * Constant copy, so nothing is fetched here. DELIBERATELY DEPENDENCY-FREE,
 * like its siblings (wrangler bundles the middleware outside the workspace);
 * the strings are duplicates of `appsLanding.seo.*` and `locadoraPage.seo.*`,
 * and `apps-meta.test.ts` pins each pair against the catalogues.
 *
 * AGPL / self-host: this only runs on a Pages deployment, and the flag is off
 * unless that deployment's API says otherwise, so a self-host is untouched.
 */

import {
  escapeHtml,
  injectHeadTags,
  type MarketingLocale,
} from "./marketing-meta";

const CANONICAL_ORIGIN = "https://pqp.gg";

export type AppsPage = "apps" | "locadora";

/** The canonical path of each page. */
export const APPS_PAGE_PATH: Record<AppsPage, string> = {
  apps: "/apps",
  locadora: "/apps/locadora",
};

/**
 * The page behind a path, or null for every other path.
 *
 * Exact-match, never a prefix test: this runs in front of every request the
 * site serves, including every hashed asset.
 */
export function appsPageFromMetaPath(pathname: string): AppsPage | null {
  const normalized =
    pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (normalized === "/apps") return "apps";
  if (normalized === "/apps/locadora" || normalized === "/locadora") {
    return "locadora";
  }
  return null;
}

type Text = Record<MarketingLocale, string>;

interface AppsCopy {
  title: Text;
  description: Text;
  /** Site-relative share card, 1200 x 630. */
  image: string;
  imageAlt: Text;
}

export const APPS_COPY: Record<AppsPage, AppsCopy> = {
  apps: {
    title: {
      "pt-BR": "pqp Apps | Apps pra tua call",
      en: "pqp Apps | Apps for your call",
      es: "pqp Apps | Apps para tu llamada",
    },
    description: {
      "pt-BR":
        "Pequenos apps que abrem dentro do canal de voz do teu servidor. Começa pela Locadora, com a tua prateleira de jogos retrô em pixel art.",
      en: "Small apps that open inside your server's voice channel. Starting with Locadora, your own retro game shelf in pixel art.",
      es: "Pequeñas apps que se abren dentro del canal de voz de tu servidor. Empieza con Locadora, tu propio estante de juegos retro en pixel art.",
    },
    image: "/images/og-apps.jpg",
    imageAlt: {
      "pt-BR": "Rua de bairro ao entardecer, com a fachada de neon da Locadora, em pixel art.",
      en: "A neighbourhood street at dusk with the Locadora neon storefront, in pixel art.",
      es: "Una calle de barrio al atardecer con la fachada de neón de la Locadora, en pixel art.",
    },
  },
  locadora: {
    title: {
      "pt-BR": "Locadora no pqp | Teus jogos retrô na call",
      en: "Locadora on pqp | Your retro games on the call",
      es: "Locadora en pqp | Tus juegos retro en la llamada",
    },
    description: {
      "pt-BR":
        "Monta tua prateleira de pixel art com os teus jogos de NES, SNES, Game Boy e GBA e joga na call com a galera por perto. O arquivo do jogo nunca sai do teu aparelho.",
      en: "Build a pixel-art shelf of your own NES, SNES, Game Boy and GBA games and play on the call with your friends around. The game file never leaves your device.",
      es: "Arma tu estante de pixel art con tus propios juegos de NES, SNES, Game Boy y GBA y juega en la llamada con tus amigos cerca. El archivo del juego nunca sale de tu dispositivo.",
    },
    image: "/images/og-locadora.jpg",
    imageAlt: {
      "pt-BR": "Arte de capa da Locadora: letreiro de neon, cartuchos e controles num pôr do sol retrô.",
      en: "Locadora key art: a neon sign, cartridges and controllers over a retro sunset.",
      es: "Arte de portada de Locadora: letrero de neón, cartuchos y controles sobre un atardecer retro.",
    },
  },
};

/**
 * The canonical URL and the hreflang set for one page in one language, in the
 * convention the marketing pages use: Portuguese at the bare path, English and
 * Spanish at `?lang=`, each declaring itself canonical, the bare path as
 * `x-default`. Shared with the client `Seo`, so the head the edge writes and
 * the head the browser leaves behind cannot disagree.
 */
export function appsUrlsFor(
  page: AppsPage,
  locale: MarketingLocale,
): { canonical: string; alternates: { hreflang: string; href: string }[] } {
  const base = `${CANONICAL_ORIGIN}${APPS_PAGE_PATH[page]}`;
  const withLang = (l: MarketingLocale) =>
    l === "pt-BR" ? base : `${base}?lang=${l}`;
  return {
    canonical: withLang(locale),
    alternates: [
      { hreflang: "x-default", href: base },
      { hreflang: "pt-BR", href: withLang("pt-BR") },
      { hreflang: "en", href: withLang("en") },
      { hreflang: "es", href: withLang("es") },
    ],
  };
}

/** Every tag the rewrite writes for one page, as one string. */
export function renderAppsHead(
  page: AppsPage,
  locale: MarketingLocale,
): string {
  const copy = APPS_COPY[page];
  const { canonical, alternates } = appsUrlsFor(page, locale);
  const title = copy.title[locale];
  const description = copy.description[locale];
  const image = `${CANONICAL_ORIGIN}${copy.image}`;
  const alt = copy.imageAlt[locale];
  const e = escapeHtml;
  return [
    `<title>${e(title)}</title>`,
    `<meta name="description" content="${e(description)}" />`,
    `<link rel="canonical" href="${e(canonical)}" />`,
    ...alternates.map(
      (a) =>
        `<link rel="alternate" hreflang="${a.hreflang}" href="${e(a.href)}" />`,
    ),
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="pqp" />`,
    `<meta property="og:url" content="${e(canonical)}" />`,
    `<meta property="og:title" content="${e(title)}" />`,
    `<meta property="og:description" content="${e(description)}" />`,
    `<meta property="og:image" content="${e(image)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${e(alt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${e(title)}" />`,
    `<meta name="twitter:description" content="${e(description)}" />`,
    `<meta name="twitter:image" content="${e(image)}" />`,
    `<meta name="twitter:image:alt" content="${e(alt)}" />`,
    `<meta name="robots" content="index, follow" />`,
    `<meta name="pqp:locale" content="${locale}" />`,
  ].join("\n    ");
}

/**
 * Rewrite a document's head for one of the pages. Returns the html unchanged
 * when it has no `<head>`, the failure every injector here is held to.
 */
export function injectAppsHead(
  html: string,
  page: AppsPage,
  locale: MarketingLocale,
): string {
  return injectHeadTags(html, renderAppsHead(page, locale), locale);
}

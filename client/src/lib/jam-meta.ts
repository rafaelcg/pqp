/**
 * Edge meta for the public jam site (jam.pqp.gg, and `/jam` on any host).
 *
 * THE SAME PROBLEM `community-meta.ts` SOLVES, for a song. The jam site is a
 * page of its own (`client/jam-site/index.html`) that sets its head in the
 * browser, which no unfurler runs, so a song pasted into WhatsApp would read
 * "pqp jam" and nothing else. This writes the head at the edge: the song's
 * title, who played, what it still needs and, when it has one that passed the
 * image scanner, its cover.
 *
 * WHAT IS DECIDED HERE
 *  - A song that the API does not answer for (404: not public, hidden, taken
 *    down, or the flag is off, which the API does not tell apart) gets the
 *    site's generic card, `noindex`, and `no-store`. Nothing about a song that
 *    is not public is ever named.
 *  - The home is indexable only while the flag is on. Off, it is `noindex`.
 *  - The canonical address is always `https://jam.pqp.gg/...`, whichever mount
 *    served the page, so `/jam/m/<id>` on pqp.gg is not a second page.
 *  - The image is the song's cover only when the API says it has a public one
 *    (`coverUrl` is non-null: public song, cover passed the scanner), and then
 *    it is OUR address for it, `<api>/api/public/jams/<id>/cover`, never the
 *    signed URL the JSON carries for the page's own player. A signed URL
 *    expires within the hour (`mediaExpiresAt`), so an unfurl that WhatsApp, X
 *    or Discord cached and re-reads later would be broken; the route serves the
 *    current object from our origin, cacheable, 404 for anything not public
 *    (server `jam-public-routes.ts`, the Baú cover's pattern, PR 1260). The cover
 *    is a square, so its card is `summary`, and its size is not known here so
 *    none is stated (a wrong one is worse than none).
 *  - Everything else (a song with no cover yet, which until the scanner runs is
 *    every song; the home; a page that is not public) gets the jam site's own
 *    1200x630 card, `client/public/images/og-jam.png` (pt-BR) and `og-jam-en.png`
 *    (English, which Spanish readers get), drawn by
 *    `client/scripts/og-image/jam-template.html`. It carries the true size,
 *    type and an `alt`, and is `summary_large_image`. It names no song, so it
 *    reveals nothing about a page that is not public.
 *  - No signed URL may reach a tag. `renderJamHead` never reads `coverUrl` as an
 *    address, only as "there is a cover", and a test fails on any `X-Amz` or
 *    `sig=` in a head.
 *
 *  - Text a person typed (title, artist, who played, who started it) is stripped of
 *    bidi override, embedding and isolate controls before it reaches a tag. The
 *    server strips them from new input (`cleanLine` in `@pqp/shared`), but a song
 *    stored before PR 1710 may still hold a right-to-left override, and the edge
 *    writes the head from what the API returns. A `<title>` cannot hold an
 *    isolate in any way a tab or an unfurler honours, so it is stripped, not
 *    isolated. The character list is `lib/bidi.ts`'s, not a copy of it.
 *
 * DELIBERATELY DEPENDENCY-FREE, like `community-meta.ts`: wrangler bundles the
 * middleware outside the pnpm workspace (`./bidi` has no imports either).
 */

import { bidiClean } from "./bidi";
import { escapeHtml, MANAGED_TAGS } from "./community-meta";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type JamTarget =
  | { kind: "home"; mount: "host" | "path" }
  | { kind: "song"; mount: "host" | "path"; songId: string };

/**
 * The jam page an address names, or null. Pure string checks: this runs in
 * front of every request the site serves. `hostname` makes `jam.*` a mount of
 * its own (`/` and `/m/<id>`); anywhere else the mount is `/jam`.
 */
export function jamTargetFromMetaPath(hostname: string, pathname: string): JamTarget | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (/^jam\./i.test(hostname)) {
    if (path === "/") return { kind: "home", mount: "host" };
    const song = path.match(/^\/m\/([^/]+)$/);
    return song && UUID.test(song[1]!) ? { kind: "song", mount: "host", songId: song[1]!.toLowerCase() } : null;
  }
  if (path === "/jam") return { kind: "home", mount: "path" };
  const song = path.match(/^\/jam\/m\/([^/]+)$/);
  return song && UUID.test(song[1]!) ? { kind: "song", mount: "path", songId: song[1]!.toLowerCase() } : null;
}

/**
 * Where a request to `jam.*` that is not the jam site goes: the same path on the
 * main site, or null when the jam site answers it. The host serves the whole
 * app's build (a Pages project has one asset set), so without this
 * `jam.pqp.gg/download` is an indexable duplicate of `pqp.gg/download`. The
 * site's own addresses are `/` and `/m/<id>`; a static asset (anything under
 * `/assets/`, `/icons/`, `/images/`, or a file with an extension: the icon, the
 * manifest, robots) is the site's too, because its page loads them from here.
 */
export function jamHostRedirect(where: {
  protocol: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
}): string | null {
  if (!/^jam\./i.test(where.hostname)) return null;
  const path = where.pathname.length > 1 ? where.pathname.replace(/\/+$/, "") : where.pathname;
  if (path === "/" || /^\/m\/[^/]+$/.test(path)) return null;
  if (/^\/(assets|icons|images)\//.test(path) || /\/[^/]*\.[a-z0-9]{2,12}$/i.test(path)) return null;
  const host = where.hostname.replace(/^jam\./i, "");
  return `${where.protocol}//${host}${where.port ? `:${where.port}` : ""}${where.pathname}${where.search}`;
}

export interface JamSongMeta {
  id: string;
  title: string;
  artist: string | null;
  coverUrl: string | null;
  needs: string[];
  parts: Array<{ instrument: string; person: { name: string } }>;
  startedBy: { name: string; handle: string | null };
}

export interface JamMetaOptions {
  locale: "pt-BR" | "en";
  /** The origin the page was served from, for the site's own card pictures (`/images/og-jam*.png`). */
  siteOrigin: string;
  /** The API's origin, for a song's cover address. Null: no cover is offered, the card is. */
  apiOrigin: string | null;
}

/** The size the jam card is drawn at (`client/scripts/og-image/jam-template.html`). */
export const JAM_CARD_WIDTH = 1200;
export const JAM_CARD_HEIGHT = 630;

/** The jam card in a language: `og-jam.png` for Portuguese, `og-jam-en.png` for English. */
export function jamCardImagePath(locale: "pt-BR" | "en"): string {
  return locale === "pt-BR" ? "/images/og-jam.png" : "/images/og-jam-en.png";
}

/** What the card's picture says, for `og:image:alt`. Words, not a filename. */
const CARD_ALT = {
  "pt-BR": "pqp jam: um mosaico de instrumentos e a frase Toca junto.",
  en: "pqp jam: a mosaic of instruments and the words Play along.",
} as const;

const NAMES: Record<"pt-BR" | "en", Record<string, string>> = {
  "pt-BR": { guitar: "guitarra", bass: "baixo", drums: "bateria", vocals: "voz", keys: "teclado", other: "outro instrumento" },
  en: { guitar: "guitar", bass: "bass", drums: "drums", vocals: "vocals", keys: "keys", other: "another instrument" },
};

function list(items: string[], locale: "pt-BR" | "en"): string {
  if (items.length <= 1) return items.join("");
  const last = items[items.length - 1]!;
  return `${items.slice(0, -1).join(", ")} ${locale === "pt-BR" ? "e" : "and"} ${last}`;
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/**
 * The song as the head may say it: every piece of text a person typed with its
 * bidi controls dropped. A name that was only controls ends up empty and falls
 * out of the lists below like any other empty one.
 */
export function cleanJamSong(song: JamSongMeta): JamSongMeta {
  return {
    ...song,
    title: bidiClean(song.title).trim(),
    artist: song.artist === null ? null : bidiClean(song.artist).trim() || null,
    parts: song.parts.map((part) => ({ ...part, person: { name: bidiClean(part.person.name) } })),
    startedBy: {
      name: bidiClean(song.startedBy.name),
      handle: song.startedBy.handle === null ? null : bidiClean(song.startedBy.handle) || null,
    },
  };
}

/** The card's words for a song. No em dashes, `tu` in Portuguese. */
export function jamSongCardText(input: JamSongMeta, locale: "pt-BR" | "en"): { title: string; description: string } {
  const song = cleanJamSong(input);
  const names = NAMES[locale];
  const people = [...new Set(song.parts.map((part) => part.person.name.trim()).filter(Boolean))];
  const needs = song.needs.map((instrument) => names[instrument] ?? names.other!);
  const by = song.startedBy.handle ? `@${song.startedBy.handle}` : song.startedBy.name;
  const played =
    people.length > 0
      ? locale === "pt-BR"
        ? // "tocou" for one person, "tocaram" for more: the verb agrees with the list.
          `${list(people, locale)} ${people.length === 1 ? "tocou" : "tocaram"}.`
        : `Played by ${list(people, locale)}.`
      : locale === "pt-BR"
        ? `Começada por ${by}.`
        : `Started by ${by}.`;
  const missing =
    needs.length > 0
      ? locale === "pt-BR"
        ? ` Falta ${list(needs, locale)}: grava a tua parte.`
        : ` Needs ${list(needs, locale)}: record your part.`
      : "";
  return {
    title: song.title === "" ? "pqp jam" : clip(`${song.title} · pqp jam`, 90),
    description: clip(`${played}${missing}`, 200),
  };
}

const HOME_TEXT = {
  "pt-BR": {
    title: "pqp jam: músicas que qualquer pessoa ouve e toca junto",
    description: "Ouve as jams, vê quem tocou o quê e grava a parte que falta. Sem conta pra ouvir.",
  },
  en: {
    title: "pqp jam: songs anybody can listen to and play along with",
    description: "Listen to the jams, see who played what and record the part that is missing. No account to listen.",
  },
} as const;

/** The stable address a song's cover is served from, or null when the page has no cover to offer. */
export function jamCoverAddress(apiOrigin: string | null, songId: string): string | null {
  return apiOrigin ? `${apiOrigin.replace(/\/+$/, "")}/api/public/jams/${songId}/cover` : null;
}

interface CardImage {
  url: string;
  alt: string;
  /** Set for the site's own card, whose size and type are ours to state. */
  card: boolean;
}

function cardImage(options: JamMetaOptions): CardImage {
  return {
    url: `${options.siteOrigin}${jamCardImagePath(options.locale)}`,
    alt: CARD_ALT[options.locale],
    card: true,
  };
}

interface Card {
  title: string;
  description: string;
  url: string;
  image: CardImage;
  noindex: boolean;
  jsonLd?: object;
}

function renderHead(card: Card, locale: "pt-BR" | "en"): string {
  // Last line of defence: whatever reaches a tag has no bidi control in it.
  const e = (value: string) => escapeHtml(bidiClean(value));
  const lines = [
    `<title>${e(card.title)}</title>`,
    `<meta name="description" content="${e(card.description)}" />`,
    `<meta name="pqp:locale" content="${locale}" />`,
    card.noindex
      ? `<meta name="robots" content="noindex, nofollow" />`
      : `<meta name="robots" content="index, follow" />`,
    ...(card.noindex ? [] : [`<link rel="canonical" href="${e(card.url)}" />`]),
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="pqp jam" />`,
    ...(card.noindex ? [] : [`<meta property="og:url" content="${e(card.url)}" />`]),
    `<meta property="og:title" content="${e(card.title)}" />`,
    `<meta property="og:description" content="${e(card.description)}" />`,
    `<meta property="og:locale" content="${locale === "pt-BR" ? "pt_BR" : "en_US"}" />`,
    `<meta property="og:image" content="${e(card.image.url)}" />`,
    ...(card.image.card
      ? [
          `<meta property="og:image:type" content="image/png" />`,
          `<meta property="og:image:width" content="${JAM_CARD_WIDTH}" />`,
          `<meta property="og:image:height" content="${JAM_CARD_HEIGHT}" />`,
        ]
      : []),
    `<meta property="og:image:alt" content="${e(card.image.alt)}" />`,
    `<meta name="twitter:card" content="${card.image.card ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:title" content="${e(card.title)}" />`,
    `<meta name="twitter:description" content="${e(card.description)}" />`,
    `<meta name="twitter:image" content="${e(card.image.url)}" />`,
    `<meta name="twitter:image:alt" content="${e(card.image.alt)}" />`,
  ];
  if (card.jsonLd) {
    // `</script>` inside a JSON string would close the block early.
    lines.push(`<script type="application/ld+json">${JSON.stringify(card.jsonLd).replace(/</g, "\\u003c")}</script>`);
  }
  return lines.join("\n    ");
}

/** The head for one song, or for the home, or for a page that is not public. */
export function renderJamHead(
  input: { target: JamTarget; song: JamSongMeta | null; enabled: boolean },
  options: JamMetaOptions,
): { head: string; noindex: boolean } {
  const { target, enabled } = input;
  const song = input.song ? cleanJamSong(input.song) : null;
  const generic = HOME_TEXT[options.locale];
  const canonical =
    target.kind === "song" ? `https://jam.pqp.gg/m/${target.songId}` : "https://jam.pqp.gg/";
  if (target.kind === "song" && song && enabled) {
    const text = jamSongCardText(song, options.locale);
    // `coverUrl` says only THAT the song has a public cover. The address in the
    // tag is ours and stable; the signed URL in it never leaves this function.
    const cover = song.coverUrl ? jamCoverAddress(options.apiOrigin, target.songId) : null;
    const image: CardImage = cover
      ? { url: cover, alt: song.title, card: false }
      : cardImage(options);
    const card: Card = {
      ...text,
      url: canonical,
      image,
      noindex: false,
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "MusicRecording",
        name: song.title,
        url: canonical,
        ...(song.artist ? { byArtist: { "@type": "MusicGroup", name: song.artist } } : {}),
        image: image.url,
      },
    };
    return { head: renderHead(card, options.locale), noindex: false };
  }
  // The home while on, and every page that is not a public song.
  const indexable = target.kind === "home" && enabled;
  const card: Card = {
    title: generic.title,
    description: generic.description,
    url: canonical,
    image: cardImage(options),
    noindex: !indexable,
  };
  return { head: renderHead(card, options.locale), noindex: !indexable };
}

/** Rewrite a document's head. Unchanged when it has none (a working page is the bar). */
export function injectJamHead(
  html: string,
  input: { target: JamTarget; song: JamSongMeta | null; enabled: boolean },
  options: JamMetaOptions,
): { html: string; noindex: boolean } {
  if (html.indexOf("<head>") === -1) {
    return { html, noindex: false };
  }
  const { head, noindex } = renderJamHead(input, options);
  const stripped = html.replace(MANAGED_TAGS, "");
  const insertAt = stripped.indexOf("<head>") + "<head>".length;
  return {
    html: stripped.slice(0, insertAt) + "\n    " + head + stripped.slice(insertAt),
    noindex,
  };
}

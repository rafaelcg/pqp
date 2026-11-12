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
 *  - The image is the cover when it is an absolute https URL (a square, so the
 *    card is `summary`), else the site's own 1200x630 card
 *    (`summary_large_image`). There is no generated card: it needs a Worker
 *    with a font and an SVG-to-PNG step (`docs/HANDLES.md`, "Not built"). A
 *    cover URL is a signed address that expires (`mediaExpiresAt`, an hour at
 *    most): an unfurler that copies the picture on its first fetch (WhatsApp, X,
 *    Slack) keeps it, one that re-fetches later may find it gone. That is the
 *    known gap (`docs/JAM_SITE.md`); a stable cover address is a server change.
 *
 * DELIBERATELY DEPENDENCY-FREE, like `community-meta.ts`: wrangler bundles the
 * middleware outside the pnpm workspace.
 */

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
  /** The address of the site's own card picture, absolute. */
  fallbackImage: string;
}

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

/** The card's words for a song. No em dashes, `tu` in Portuguese. */
export function jamSongCardText(song: JamSongMeta, locale: "pt-BR" | "en"): { title: string; description: string } {
  const names = NAMES[locale];
  const people = [...new Set(song.parts.map((part) => part.person.name.trim()).filter(Boolean))];
  const needs = song.needs.map((instrument) => names[instrument] ?? names.other!);
  const by = song.startedBy.handle ? `@${song.startedBy.handle}` : song.startedBy.name;
  const played =
    people.length > 0
      ? locale === "pt-BR"
        ? `${list(people, locale)} tocaram.`
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
    title: clip(`${song.title} · pqp jam`, 90),
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

function imageOf(coverUrl: string | null, fallback: string): { url: string; isCover: boolean } {
  return coverUrl && coverUrl.startsWith("https://") ? { url: coverUrl, isCover: true } : { url: fallback, isCover: false };
}

interface Card {
  title: string;
  description: string;
  url: string;
  image: { url: string; isCover: boolean };
  noindex: boolean;
  jsonLd?: object;
}

function renderHead(card: Card, locale: "pt-BR" | "en"): string {
  const e = escapeHtml;
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
    `<meta property="og:image" content="${e(card.image.url)}" />`,
    `<meta name="twitter:card" content="${card.image.isCover ? "summary" : "summary_large_image"}" />`,
    `<meta name="twitter:title" content="${e(card.title)}" />`,
    `<meta name="twitter:description" content="${e(card.description)}" />`,
    `<meta name="twitter:image" content="${e(card.image.url)}" />`,
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
  const { target, song, enabled } = input;
  const generic = HOME_TEXT[options.locale];
  const canonical =
    target.kind === "song" ? `https://jam.pqp.gg/m/${target.songId}` : "https://jam.pqp.gg/";
  if (target.kind === "song" && song) {
    const text = jamSongCardText(song, options.locale);
    const image = imageOf(song.coverUrl, options.fallbackImage);
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
    image: { url: options.fallbackImage, isCover: false },
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

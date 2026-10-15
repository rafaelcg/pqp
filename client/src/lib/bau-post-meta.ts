import {
  absoluteImageUrl,
  escapeHtml,
  MANAGED_TAGS,
  type CommunityMeta,
} from "./community-meta";

/**
 * Server-side meta injection for `/c/<slug>/p/<postId>`, the card a shared Baú
 * post unfurls as on X, Reddit, WhatsApp, Telegram and Discord.
 *
 * THE SAME PROBLEM AS `community-meta.ts`, one path deeper, and the reason this
 * feature is worth shipping at all: the whole growth loop is somebody pasting
 * the link, and a static SPA's client-side `<head>` is invisible to every
 * unfurler. Without this the post would unfurl as the generic product card and
 * nobody would tap it.
 *
 * ITS OWN FILE, as every head builder here is. What differs from the community
 * card is what makes it a different card: the title and the description are the
 * POST's (the community's name is the caption, not the headline), the picture is
 * the post's own when it has one and the community banner when it does not, and
 * the page is an `article`, not a `website`. `og:image` is the API's STABLE cover
 * address, never a signed bucket URL, because a card is kept for weeks and a
 * signature lasts twelve hours (`coverUrl` in `publicBauPostSchema`).
 *
 * WHAT IT NEVER SAYS: an author, a comment, a member. The API does not send
 * them; this could not print them if it tried.
 *
 * DELIBERATELY DEPENDENCY-FREE, like its siblings: wrangler bundles the
 * middleware outside the pnpm workspace, so no `@pqp/shared` import.
 * `bau-post-meta.test.ts` pins `bauPostFromMetaPath` against the shared
 * `parseBauPublicPostPath` so the duplication cannot drift.
 */

/** Mirrors `COMMUNITY_SLUG_PATTERN` in @pqp/shared. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const POST_PATH =
  /^\/c\/([^/?#]+)\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

export interface BauPostTarget {
  slug: string;
  postId: string;
}

/**
 * The post in `/c/valorant-brasil/p/<uuid>`, or null for every other path.
 * Null is the middleware's "not my business" and has to be exactly that: this
 * runs in front of every request the site serves.
 */
export function bauPostFromMetaPath(pathname: string): BauPostTarget | null {
  const match = POST_PATH.exec(pathname);
  if (!match) {
    return null;
  }
  let slug: string;
  try {
    slug = decodeURIComponent(match[1]!).toLowerCase();
  } catch {
    return null;
  }
  if (!SLUG_PATTERN.test(slug)) {
    return null;
  }
  return { slug, postId: match[2]!.toLowerCase() };
}

/** The id of the `<script type="application/json">` the edge puts the answer in. */
export const BAU_POST_EMBED_ID = "pqp-bau-post";

/**
 * The public read's answer as an inert JSON block, for the page to read first.
 *
 * WHY. The middleware has already asked the API for this post to write the
 * card. Without this the SPA asks again, so one page view costs the API two
 * hits from the same few Cloudflare addresses, against a per-address bucket.
 * With it the page view costs one, and the page paints from the HTML it was
 * handed. `readPublicPostEmbed` (`lib/community-home/public-post-embed.ts`)
 * validates it against the shared schema and the page falls back to the
 * network on anything it does not like.
 *
 * `type="application/json"` is never executed, and the three characters that
 * could end or confuse the block (`<`, `>`, `&`), plus the two line separators a
 * script context treats as newlines, are written as escapes, so author-typed
 * text in the payload cannot close it (`</script>`) whatever it says.
 */
export function renderBauPostEmbed(payload: unknown): string {
  const json = JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<script type="application/json" id="${BAU_POST_EMBED_ID}">${json}</script>`;
}

export interface BauPostMeta extends BauPostTarget {
  title: string | null;
  teaser: string | null;
  /** This API's stable cover path, a YouTube poster, or null. */
  coverUrl: string | null;
  /**
   * What the API says its own cover is, each null when unknown (a YouTube
   * poster, a slow bucket, an older API). Null means "unknown", never "wrong":
   * a card built without them is the card this page always had.
   */
  coverType?: string | null;
  coverWidth?: number | null;
  coverHeight?: number | null;
  coverBytes?: number | null;
  /** ISO instant, for the structured data. */
  publishedAt: string | null;
  community: CommunityMeta;
  /** The API's whole answer, embedded for the page (`renderBauPostEmbed`). */
  embed?: unknown;
}

export interface BauPostMetaOptions {
  /** Where this page lives, for canonical and `og:url`. No trailing slash. */
  siteOrigin: string;
  /** Where relative image paths resolve against. No trailing slash. */
  apiOrigin: string;
  locale: "pt-BR" | "en";
}

/**
 * What X (and the unfurlers that follow its rules) will take as a card image:
 * jpg, png, webp or gif, at most 5 MB, and for `summary_large_image` at least
 * 300x157 (`summary`: 144x144). X crops a large card to about 2:1, so a picture
 * that is not close to 1.91:1 is still a large card, just cropped; a picture
 * BELOW the floor is not shown on one at all, which is the placeholder icon.
 * We cannot enlarge a picture here (no image library in an edge worker), so a
 * known-too-small cover is moved to the small card, and a known-unusable one
 * (wrong format, over 5 MB) is passed over for the next image.
 */
const CARD_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const CARD_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const LARGE_MIN = { width: 300, height: 157 };
const SMALL_MIN = { width: 144, height: 144 };

/** The site's own card, whose size is written in `index.html`. */
const SITE_CARD = { type: "image/jpeg", width: 1200, height: 630 };

interface CardImage {
  url: string;
  large: boolean;
  type: string | null;
  width: number | null;
  height: number | null;
}

/**
 * Whether the API's own cover can be this card's picture, and on which card.
 * Unknown facts pass: only a fact that says "X will not show this" rejects.
 */
function coverVerdict(post: BauPostMeta): "large" | "small" | "unusable" {
  const { coverType, coverWidth, coverHeight, coverBytes } = post;
  // Empty is a fact, not an absence: an object with no bytes is not a picture.
  if (coverBytes != null && (coverBytes === 0 || coverBytes > CARD_IMAGE_MAX_BYTES)) {
    return "unusable";
  }
  if (coverType != null && !CARD_IMAGE_TYPES.includes(coverType)) {
    return "unusable";
  }
  if (coverWidth != null && coverHeight != null) {
    if (coverWidth >= LARGE_MIN.width && coverHeight >= LARGE_MIN.height) {
      return "large";
    }
    if (coverWidth >= SMALL_MIN.width && coverHeight >= SMALL_MIN.height) {
      return "small";
    }
    return "unusable";
  }
  return "large";
}

const TITLE_MAX = 90;
const DESCRIPTION_MAX = 200;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) {
    return flat;
  }
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, "")}…`;
}

/**
 * The card's words. The post leads: its title is the headline, its teaser the
 * description, and the community is the line under them. A post with no title
 * is headed by the room it came from instead, because "Um post no Baú de X" is
 * the true thing to say and a blank is not.
 */
export function bauPostCardText(
  post: BauPostMeta,
  locale: "pt-BR" | "en",
): { title: string; description: string } {
  const pt = locale === "pt-BR";
  const name = post.community.name;
  const caption = pt ? `Baú de ${name} no pqp` : `Baú of ${name} on pqp`;

  const headline = post.title?.trim();
  const title = headline
    ? `${clip(headline, TITLE_MAX)} · ${name}`
    : pt
      ? `Um post no Baú de ${name}`
      : `A post in the Baú of ${name}`;

  const teaser = post.teaser?.trim();
  const description = teaser
    ? clip(teaser, DESCRIPTION_MAX)
    : pt
      ? `${caption}. Entra aí.`
      : `${caption}. Come in.`;
  return { title, description };
}

/** Every tag the rewrite manages, as one string. */
export function renderBauPostHead(
  post: BauPostMeta,
  options: BauPostMetaOptions,
): string {
  const { title, description } = bauPostCardText(post, options.locale);
  const url = `${options.siteOrigin}/c/${post.slug}/p/${post.postId}`;
  const cover = absoluteImageUrl(post.coverUrl, options.apiOrigin);
  const banner = absoluteImageUrl(post.community.bannerUrl, options.apiOrigin);
  const icon = absoluteImageUrl(post.community.iconUrl, options.apiOrigin);
  // The post's own picture, else the room's banner, else its square icon, else
  // the site's card. A wide card only when the picture is wide: a banner and a
  // post image are both fit for it, and so is the site's own 1200x630 card; a
  // square icon is not, and gets the small one.
  const verdict = cover ? coverVerdict(post) : "unusable";
  let chosen: CardImage;
  if (cover && verdict !== "unusable") {
    chosen = {
      url: cover,
      large: verdict === "large",
      type: post.coverType ?? null,
      width: post.coverWidth ?? null,
      height: post.coverHeight ?? null,
    };
  } else if (banner) {
    chosen = { url: banner, large: true, type: null, width: null, height: null };
  } else if (icon) {
    chosen = { url: icon, large: false, type: null, width: null, height: null };
  } else {
    chosen = {
      url: `${options.siteOrigin}/images/og-image.jpg`,
      large: true,
      ...SITE_CARD,
    };
  }
  const image = chosen.url;
  const large = chosen.large;
  // The size and format only when they are KNOWN: a tag that guesses is worse
  // than none, and an unfurler that has them can reserve the space and skip a
  // picture it would refuse before it downloads anything.
  const imageFacts = [
    ...(chosen.type ? [`<meta property="og:image:type" content="${escapeHtml(chosen.type)}" />`] : []),
    ...(chosen.width ? [`<meta property="og:image:width" content="${chosen.width}" />`] : []),
    ...(chosen.height ? [`<meta property="og:image:height" content="${chosen.height}" />`] : []),
  ];
  const e = escapeHtml;

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Article",
    url,
    headline: title,
    description,
    image,
    ...(post.publishedAt ? { datePublished: post.publishedAt } : {}),
    isPartOf: {
      "@type": "Organization",
      name: post.community.name,
      url: `${options.siteOrigin}/c/${post.community.slug}`,
    },
    // `</script>` inside a JSON string would close the block early; titles and
    // teasers are author-typed text, so this replace is load-bearing here.
  }).replace(/</g, "\\u003c");

  return [
    `<title>${e(title)}</title>`,
    `<meta name="description" content="${e(description)}" />`,
    `<link rel="canonical" href="${e(url)}" />`,
    `<link rel="alternate" hreflang="x-default" href="${e(url)}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="pqp" />`,
    `<meta property="og:url" content="${e(url)}" />`,
    `<meta property="og:title" content="${e(title)}" />`,
    `<meta property="og:description" content="${e(description)}" />`,
    `<meta property="og:image" content="${e(image)}" />`,
    ...imageFacts,
    `<meta property="og:image:alt" content="${e(post.title?.trim() || post.community.name)}" />`,
    `<meta name="twitter:card" content="${large ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:title" content="${e(title)}" />`,
    `<meta name="twitter:description" content="${e(description)}" />`,
    `<meta name="twitter:image" content="${e(image)}" />`,
    `<meta name="robots" content="index, follow" />`,
    `<script type="application/ld+json">${jsonLd}</script>`,
    ...(post.embed === undefined ? [] : [renderBauPostEmbed(post.embed)]),
  ].join("\n    ");
}

/**
 * Rewrite a document's head for one post. Returns the html unchanged when it
 * has no `<head>`: serving the page as it was is a working page, and that is the
 * bar every failure path in this feature is held to.
 */
export function injectBauPostHead(
  html: string,
  post: BauPostMeta,
  options: BauPostMetaOptions,
): string {
  if (html.indexOf("<head>") === -1) {
    return html;
  }
  const stripped = html.replace(MANAGED_TAGS, "");
  const insertAt = stripped.indexOf("<head>") + "<head>".length;
  return (
    stripped.slice(0, insertAt) +
    "\n    " +
    renderBauPostHead(post, options) +
    stripped.slice(insertAt)
  );
}

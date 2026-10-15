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

export interface BauPostMeta extends BauPostTarget {
  title: string | null;
  teaser: string | null;
  /** This API's stable cover path, a YouTube poster, or null. */
  coverUrl: string | null;
  /** ISO instant, for the structured data. */
  publishedAt: string | null;
  community: CommunityMeta;
}

export interface BauPostMetaOptions {
  /** Where this page lives, for canonical and `og:url`. No trailing slash. */
  siteOrigin: string;
  /** Where relative image paths resolve against. No trailing slash. */
  apiOrigin: string;
  locale: "pt-BR" | "en";
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
  const image = cover ?? banner ?? icon ?? `${options.siteOrigin}/images/og-image.jpg`;
  const large = Boolean(cover ?? banner) || !icon;
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
    `<meta property="og:image:alt" content="${e(post.title?.trim() || post.community.name)}" />`,
    `<meta name="twitter:card" content="${large ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:title" content="${e(title)}" />`,
    `<meta name="twitter:description" content="${e(description)}" />`,
    `<meta name="twitter:image" content="${e(image)}" />`,
    `<meta name="robots" content="index, follow" />`,
    `<script type="application/ld+json">${jsonLd}</script>`,
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

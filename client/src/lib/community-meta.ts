/**
 * Server-side meta injection for `/c/<slug>`, and the reason a community link
 * pasted into a WhatsApp group is worth anything.
 *
 * THE SAME PROBLEM `profile-meta.ts` SOLVES, one namespace over. This is a
 * static SPA: every route is served the same `index.html`, whose head describes
 * the product, and `Seo` fixes that in the browser — which is worth nothing to
 * WhatsApp, Instagram, Twitter, Discord and Google's first pass, none of which
 * run the script. A community page whose entire job is "somebody shares this
 * and strangers walk in" cannot unfurl as the generic product card.
 *
 * ITS OWN FILE RATHER THAN A GENERALISATION OF `profile-meta.ts`, and the
 * decision is worth stating because the two files rhyme so closely. What they
 * do not share is the part that matters: a profile's image is a SQUARE avatar,
 * so its card is `summary` and a wide crop would put a band across somebody's
 * eyes; a community's image is a 3:1 BANNER, so its card is
 * `summary_large_image` and a small square crop would throw away the picture
 * the owner chose. One function with a flag would have made that difference an
 * argument rather than a fact, and the flag would be wrong half the time it was
 * passed. The path parsers differ for the same kind of reason and the JSON-LD
 * type is `Organization` rather than `ProfilePage`.
 *
 * DELIBERATELY DEPENDENCY-FREE. It is bundled by wrangler's esbuild in a CI job
 * that installs wrangler *outside* the pnpm workspace, so an import of
 * `@pqp/shared` here would make the deploy depend on workspace resolution
 * working in a temp directory. `community-meta.test.ts` pins
 * `communitySlugFromMetaPath` against the shared `communitySlugFromPath`
 * instead, so the duplication cannot drift without failing the suite.
 */

/** Mirrors `COMMUNITY_SLUG_PATTERN` in @pqp/shared — see the note above. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export interface CommunityMeta {
  slug: string;
  name: string;
  tagline: string | null;
  category: string;
  memberCount: number;
  iconUrl: string | null;
  bannerUrl: string | null;
}

export interface CommunityMetaOptions {
  /** Where this page lives, for canonical and `og:url`. No trailing slash. */
  siteOrigin: string;
  /** Where relative image paths resolve against. No trailing slash. */
  apiOrigin: string;
  /** Portuguese unless the request says otherwise — see `preferredLocale`. */
  locale: "pt-BR" | "en";
}

/**
 * The slug in `/c/valorant-brasil`, or null for every other path.
 *
 * Null is the middleware's "not my business" answer and it has to be exactly
 * that: this runs in front of EVERY request to the site, so a parser that is
 * loose here starts rewriting the landing page's head.
 */
export function communitySlugFromMetaPath(pathname: string): string | null {
  const match = /^\/c\/([^/?#]+)\/?$/.exec(pathname);
  if (!match) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  const candidate = decoded.toLowerCase();
  return SLUG_PATTERN.test(candidate) ? candidate : null;
}

/**
 * The pt-BR label for a category slug, for the card only.
 *
 * A SECOND COPY of what `communities.category.*` says in the app catalogue, and
 * knowingly so: the catalogue is a TypeScript module in the client bundle and
 * this file must stay importable by an esbuild run outside the workspace. Ten
 * words is a cheap duplication and the failure mode of it drifting is a card
 * that says "Games" where the app says "Jogos" — not a broken page. An unknown
 * slug falls through to the slug itself rather than to a blank, so a category
 * added in the app before it is added here still renders something true.
 */
const CATEGORY_LABELS: Record<string, { pt: string; en: string }> = {
  games: { pt: "Games", en: "Games" },
  musica: { pt: "Música", en: "Music" },
  futebol: { pt: "Futebol", en: "Football" },
  estudos: { pt: "Estudos", en: "Study" },
  anime: { pt: "Anime", en: "Anime" },
  tech: { pt: "Tech", en: "Tech" },
  humor: { pt: "Humor", en: "Humour" },
  "series-filmes": { pt: "Séries e filmes", en: "Series & film" },
  corre: { pt: "Corre", en: "Hustle" },
  geral: { pt: "Geral", en: "General" },
};

function categoryLabel(slug: string, locale: "pt-BR" | "en"): string {
  const entry = CATEGORY_LABELS[slug];
  if (!entry) {
    return slug;
  }
  return locale === "pt-BR" ? entry.pt : entry.en;
}

/**
 * The card's words.
 *
 * THE TAGLINE LEADS when there is one, and that is the whole editorial
 * decision here. A community's tagline is the joke, and the joke is what makes
 * somebody tap; the member count and the category are the caption under it. If
 * there is no tagline the count leads instead, because "1.240 membros · Games"
 * is at least a reason, and the name is already in the title.
 *
 * Short on purpose. WhatsApp truncates a description at roughly 120 characters
 * and Twitter at 200, and a 140-character tagline plus a count plus a category
 * plus a call to action is over both — so the tail is dropped rather than the
 * tagline when the two cannot both fit.
 */
export function communityCardText(
  community: CommunityMeta,
  locale: "pt-BR" | "en",
): { title: string; description: string } {
  const pt = locale === "pt-BR";
  const title = pt
    ? `${community.name} — comunidade no pqp`
    : `${community.name} — a community on pqp`;

  const members = community.memberCount.toLocaleString(pt ? "pt-BR" : "en-US");
  const facts = pt
    ? `${members} ${community.memberCount === 1 ? "membro" : "membros"} · ${categoryLabel(community.category, locale)}`
    : `${members} ${community.memberCount === 1 ? "member" : "members"} · ${categoryLabel(community.category, locale)}`;
  const tail = pt ? "Entra aí." : "Come in.";

  const lead = community.tagline?.trim();
  const description = lead
    ? `${lead} · ${facts}`
    : `${facts} — ${tail}`;

  return { title, description };
}

/** `&`, `<`, `>` and `"` — everything that can escape an attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * An image as an absolute https URL, or null.
 *
 * Three shapes arrive and only two can go in an `og:image`: an absolute https
 * URL, and this API's own `/api/servers/<id>/{icon,banner}` path, which has to
 * be resolved against the API origin because the page is served from a
 * different host than the picture. Anything else — `http:`, a data URI, junk —
 * becomes null and the site's own card image stands in, because an unfurl with
 * a broken image is worse than one with a generic image.
 */
export function absoluteImageUrl(
  url: string | null,
  apiOrigin: string,
): string | null {
  if (!url) {
    return null;
  }
  if (url.startsWith("https://")) {
    return url;
  }
  if (url.startsWith("/") && apiOrigin) {
    return `${apiOrigin.replace(/\/+$/, "")}${url}`;
  }
  return null;
}

/**
 * Every tag the rewrite manages, as one string.
 *
 * `summary_large_image` WHEN AND ONLY WHEN THERE IS A BANNER, which is the one
 * place this file makes a decision `profile-meta.ts` does not get to make. A
 * banner is 3:1 and a wide card is exactly the shape it was cropped for. With
 * no banner the image is the community's square icon (or the site's own card),
 * and a wide card would stretch a 512px square across 1200 — so it falls back
 * to `summary`, which crops nothing.
 */
export function renderCommunityHead(
  community: CommunityMeta,
  options: CommunityMetaOptions,
): string {
  const { title, description } = communityCardText(community, options.locale);
  const url = `${options.siteOrigin}/c/${community.slug}`;
  const banner = absoluteImageUrl(community.bannerUrl, options.apiOrigin);
  const icon = absoluteImageUrl(community.iconUrl, options.apiOrigin);
  const image = banner ?? icon ?? `${options.siteOrigin}/images/og-image.jpg`;
  const e = escapeHtml;

  // `Organization` rather than `ProfilePage`: this page is about a group, and
  // the one number on it that is genuinely a number is how many people are in
  // it. `memberOf` and `member` are deliberately absent — the page carries no
  // member list and the structured data must not imply one exists.
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Organization",
    url,
    name: community.name,
    ...(community.tagline ? { description: community.tagline } : {}),
    ...(image ? { image } : {}),
    interactionStatistic: {
      "@type": "InteractionCounter",
      interactionType: "https://schema.org/JoinAction",
      userInteractionCount: community.memberCount,
    },
    // `</script>` inside a JSON string would close the block early. It cannot
    // occur in any field above today; this replace is what keeps that true when
    // somebody adds a field a user controls.
  }).replace(/</g, "\\u003c");

  return [
    `<title>${e(title)}</title>`,
    `<meta name="description" content="${e(description)}" />`,
    `<link rel="canonical" href="${e(url)}" />`,
    `<link rel="alternate" hreflang="x-default" href="${e(url)}" />`,
    `<link rel="alternate" hreflang="pt-BR" href="${e(url)}?lang=pt-BR" />`,
    `<link rel="alternate" hreflang="en" href="${e(url)}?lang=en" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="pqp" />`,
    `<meta property="og:url" content="${e(url)}" />`,
    `<meta property="og:title" content="${e(title)}" />`,
    `<meta property="og:description" content="${e(description)}" />`,
    `<meta property="og:image" content="${e(image)}" />`,
    `<meta property="og:image:alt" content="${e(community.name)}" />`,
    `<meta name="twitter:card" content="${banner ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:title" content="${e(title)}" />`,
    `<meta name="twitter:description" content="${e(description)}" />`,
    `<meta name="twitter:image" content="${e(image)}" />`,
    `<meta name="robots" content="index, follow" />`,
    `<script type="application/ld+json">${jsonLd}</script>`,
  ].join("\n    ");
}

/**
 * Tags the shipped `index.html` already carries that describe the PRODUCT.
 *
 * Removed rather than left in place, because a document with two `og:title`
 * tags is one where the crawler picks one and it is usually the first — which
 * would make the rewrite a no-op that looks like it worked. The pattern is the
 * same narrow one `profile-meta.ts` uses: it names only the social/SEO
 * vocabulary, so the icons, the theme colour, the viewport, the pre-paint theme
 * script and the font preconnects all survive untouched.
 */
const MANAGED_TAGS =
  /[ \t]*(?:<title>[\s\S]*?<\/title>|<meta\s+(?:name|property)="(?:description|robots|og:[a-zA-Z:]+|twitter:[a-zA-Z:]+|profile:[a-zA-Z:]+)"[\s\S]*?\/>|<link\s+rel="canonical"[^>]*\/>|<link\s+rel="alternate"[^>]*\/>|<script type="application\/ld\+json">[\s\S]*?<\/script>)\n?/g;

/**
 * Rewrite a document's head for one community.
 *
 * Returns the html unchanged when it has no `<head>` — which cannot happen with
 * our own index.html, and is the correct answer if it ever does: serving the
 * page unmodified is a working page, and that is the bar every failure path in
 * this feature is held to.
 */
export function injectCommunityHead(
  html: string,
  community: CommunityMeta,
  options: CommunityMetaOptions,
): string {
  const headIndex = html.indexOf("<head>");
  if (headIndex === -1) {
    return html;
  }
  const stripped = html.replace(MANAGED_TAGS, "");
  const insertAt = stripped.indexOf("<head>") + "<head>".length;
  return (
    stripped.slice(0, insertAt) +
    "\n    " +
    renderCommunityHead(community, options) +
    stripped.slice(insertAt)
  );
}

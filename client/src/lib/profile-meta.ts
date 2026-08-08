/**
 * Server-side meta injection for `/@handle`, and the reason this product's
 * profile pages can be shared at all.
 *
 * THE PROBLEM. This is a static SPA. Every route is served the same
 * `index.html`, whose `<title>` and Open Graph tags describe the product. The
 * `Seo` component fixes that in the browser by writing to `document.head` — and
 * that is worth nothing to the audience this feature exists for, because
 * WhatsApp, Instagram, Twitter, Discord and Google's first pass all read the
 * bytes and never run the script. So `pqp.gg/@rafa` pasted into a group chat
 * unfurls as "pqp — group chat you own" with a stock image: the same card for
 * every person on the service, which is precisely the opposite of the thing
 * being shared.
 *
 * THE FIX lives in a Cloudflare Pages middleware (`client/functions/`), which
 * runs at the edge in front of the static asset, fetches the profile JSON, and
 * rewrites the head before the bytes leave. This module is the pure half of
 * that: parse the path, build the tags, rewrite the document. It is here rather
 * than in `functions/` so it is covered by the client's typecheck, lint and unit
 * suite — the middleware around it is twenty lines of plumbing that cannot be
 * unit-tested without a wrangler runtime, and everything that could actually be
 * wrong is in this file.
 *
 * DELIBERATELY DEPENDENCY-FREE. It is bundled by wrangler's esbuild in a CI job
 * that installs wrangler *outside* the pnpm workspace, so an import of
 * `@pqp/shared` here would make the deploy depend on workspace resolution
 * working in a temp directory. `profile-meta.test.ts` pins `handleFromMetaPath`
 * against the shared `handleFromPath` instead, so the duplication cannot drift
 * without failing the suite.
 */

/** Mirrors `HANDLE_PATTERN` in @pqp/shared — see the note above on why. */
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,18}[a-z0-9]$/;

export interface ProfileMeta {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  badges: { name: string }[];
  depoimentoCount: number;
}

export interface MetaOptions {
  /** Where this page lives, for canonical and `og:url`. No trailing slash. */
  siteOrigin: string;
  /** Where relative avatar paths resolve against. No trailing slash. */
  apiOrigin: string;
  /** Portuguese unless the request says otherwise — see `preferredLocale`. */
  locale: "pt-BR" | "en";
}

/**
 * The handle in `/@rafa`, or null for every other path.
 *
 * Null is the middleware's "not my business" answer and it has to be exactly
 * that: this runs in front of EVERY request to the site, so a parser that is
 * loose here starts rewriting the landing page's head.
 */
export function handleFromMetaPath(pathname: string): string | null {
  const match = /^\/@([^/?#]+)\/?$/.exec(pathname);
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
  return HANDLE_PATTERN.test(candidate) ? candidate : null;
}

/**
 * Which language to write the card in.
 *
 * `?lang=` wins because it is the crawlable, shareable way to force one — the
 * same contract `lib/locale.ts` gives the app. Otherwise `Accept-Language`,
 * because the person who will read this card is whoever the link was sent to,
 * and their browser is the only signal available at the edge. Portuguese is the
 * default rather than the fallback: this is a Brazilian product, and an English
 * card shown to a Brazilian audience is the wrong default in the common case.
 */
export function preferredLocale(
  search: string,
  acceptLanguage: string | null,
): "pt-BR" | "en" {
  const forced = new URLSearchParams(search).get("lang");
  if (forced) {
    return forced.toLowerCase().startsWith("pt") ? "pt-BR" : "en";
  }
  if (acceptLanguage && /(^|,)\s*en\b/i.test(acceptLanguage)) {
    // Only when English actually outranks Portuguese; a `pt-BR,en;q=0.8`
    // header is a Portuguese reader with a fallback, not an English one.
    const first = acceptLanguage.split(",")[0]?.trim().toLowerCase() ?? "";
    if (first.startsWith("en")) {
      return "en";
    }
  }
  return "pt-BR";
}

/**
 * The card's words.
 *
 * Short on purpose. WhatsApp truncates a description at roughly 120 characters
 * and Twitter at 200, and a badge list is exactly the sort of thing that pushes
 * the interesting part off the end — so the communities are summarised as a
 * count once there are more than two of them.
 */
export function profileCardText(
  profile: ProfileMeta,
  locale: "pt-BR" | "en",
): { title: string; description: string } {
  const pt = locale === "pt-BR";
  const title = pt
    ? `${profile.displayName} (@${profile.handle}) no pqp`
    : `${profile.displayName} (@${profile.handle}) on pqp`;

  const parts: string[] = [];
  if (profile.badges.length === 1) {
    parts.push(profile.badges[0]!.name);
  } else if (profile.badges.length === 2) {
    parts.push(`${profile.badges[0]!.name}, ${profile.badges[1]!.name}`);
  } else if (profile.badges.length > 2) {
    // "membro de 5 comunidades", not a bare "5 comunidades". The page now
    // renders the badges as a proud grid rather than a chip row, and the card
    // is the one-line trailer for it: the interesting fact is BELONGING, and
    // the number on its own reads like a statistic about the account.
    parts.push(
      pt
        ? `membro de ${profile.badges.length} comunidades`
        : `member of ${profile.badges.length} communities`,
    );
  }
  if (profile.depoimentoCount > 0) {
    parts.push(
      pt
        ? `${profile.depoimentoCount} depoimento${profile.depoimentoCount === 1 ? "" : "s"}`
        : `${profile.depoimentoCount} testimonial${profile.depoimentoCount === 1 ? "" : "s"}`,
    );
  }

  const tail = pt
    ? "Me adiciona no pqp."
    : "Add me on pqp.";
  const description = parts.length
    ? `${parts.join(" · ")} — ${tail}`
    : pt
      ? `Garanta o seu @ no pqp.gg. ${tail}`
      : `Claim your @ on pqp.gg. ${tail}`;

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
 * An avatar as an absolute https URL, or null.
 *
 * Three shapes arrive here and only two of them can be put in an `og:image`:
 * an absolute https URL (a preset or a typed link), and this API's own
 * `/api/avatars/<id>` path, which has to be resolved against the API origin
 * because the page is served from a different host than the picture. Anything
 * else — `http:`, a data URI, junk — becomes null and the site's own card image
 * stands in. An unfurl with a broken image is worse than an unfurl with a
 * generic one.
 */
export function absoluteAvatarUrl(
  avatarUrl: string | null,
  apiOrigin: string,
): string | null {
  if (!avatarUrl) {
    return null;
  }
  if (avatarUrl.startsWith("https://")) {
    return avatarUrl;
  }
  if (avatarUrl.startsWith("/") && apiOrigin) {
    return `${apiOrigin.replace(/\/+$/, "")}${avatarUrl}`;
  }
  return null;
}

/**
 * Every tag the rewrite manages, as one string.
 *
 * Ordered head-first-things-first: title, description, canonical, then the two
 * social vocabularies, then the structured data. `og:image:alt` is included
 * because a card with no alt text is a card a screen reader announces as a URL.
 */
export function renderProfileHead(
  profile: ProfileMeta,
  options: MetaOptions,
): string {
  const { title, description } = profileCardText(profile, options.locale);
  const url = `${options.siteOrigin}/@${profile.handle}`;
  const image =
    absoluteAvatarUrl(profile.avatarUrl, options.apiOrigin) ??
    `${options.siteOrigin}/images/og-image.jpg`;
  const e = escapeHtml;

  // `ProfilePage` rather than `Person`: the page is about a persona on a
  // service, and claiming a real-world Person for a pseudonymous handle is a
  // claim this product cannot stand behind. `interactionStatistic` carries the
  // depoimento count, which is the only number here that is actually a number.
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    url,
    mainEntity: {
      "@type": "Person",
      name: profile.displayName,
      alternateName: `@${profile.handle}`,
      identifier: profile.handle,
      ...(absoluteAvatarUrl(profile.avatarUrl, options.apiOrigin)
        ? { image: absoluteAvatarUrl(profile.avatarUrl, options.apiOrigin) }
        : {}),
    },
    ...(profile.depoimentoCount > 0
      ? {
          interactionStatistic: {
            "@type": "InteractionCounter",
            interactionType: "https://schema.org/CommentAction",
            userInteractionCount: profile.depoimentoCount,
          },
        }
      : {}),
    // `</script>` inside a JSON string would close the block early. It cannot
    // occur in any field above today; the replace below is what keeps that true
    // when somebody adds a field that a user controls.
  }).replace(/</g, "\\u003c");

  return [
    `<title>${e(title)}</title>`,
    `<meta name="description" content="${e(description)}" />`,
    `<link rel="canonical" href="${e(url)}" />`,
    `<link rel="alternate" hreflang="x-default" href="${e(url)}" />`,
    `<link rel="alternate" hreflang="pt-BR" href="${e(url)}?lang=pt-BR" />`,
    `<link rel="alternate" hreflang="en" href="${e(url)}?lang=en" />`,
    `<meta property="og:type" content="profile" />`,
    `<meta property="og:site_name" content="pqp" />`,
    `<meta property="og:url" content="${e(url)}" />`,
    `<meta property="og:title" content="${e(title)}" />`,
    `<meta property="og:description" content="${e(description)}" />`,
    `<meta property="og:image" content="${e(image)}" />`,
    `<meta property="og:image:alt" content="${e(profile.displayName)}" />`,
    `<meta property="profile:username" content="${e(profile.handle)}" />`,
    // `summary`, not `summary_large_image`: the image is a square avatar, and a
    // wide card crops a square into a band across somebody's eyes.
    `<meta name="twitter:card" content="summary" />`,
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
 * They are removed rather than left in place, because a document with two
 * `og:title` tags is a document where the crawler picks one and it is usually
 * the first — which would make the rewrite a no-op that looks like it worked.
 * The pattern is deliberately narrow: it names only the social/SEO vocabulary,
 * so the icons, the theme colour, the viewport, the pre-paint theme script and
 * the font preconnects all survive untouched.
 */
const MANAGED_TAGS =
  /[ \t]*(?:<title>[\s\S]*?<\/title>|<meta\s+(?:name|property)="(?:description|robots|og:[a-zA-Z:]+|twitter:[a-zA-Z:]+|profile:[a-zA-Z:]+)"[\s\S]*?\/>|<link\s+rel="canonical"[^>]*\/>|<link\s+rel="alternate"[^>]*\/>|<script type="application\/ld\+json">[\s\S]*?<\/script>)\n?/g;

/**
 * Rewrite a document's head for one profile.
 *
 * Returns the html unchanged when it has no `<head>` — which cannot happen with
 * our own index.html, and is the correct answer if it ever does: serving the
 * page unmodified is a working page, and that is the bar every failure path in
 * this feature is held to.
 */
export function injectProfileHead(
  html: string,
  profile: ProfileMeta,
  options: MetaOptions,
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
    renderProfileHead(profile, options) +
    stripped.slice(insertAt)
  );
}

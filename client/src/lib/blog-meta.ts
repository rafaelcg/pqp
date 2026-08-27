/**
 * Server-side meta injection for `/blog` and `/blog/<slug>`.
 *
 * THE FOURTH HEAD BUILDER, and the same argument as the other three. This is a
 * static SPA: every blog URL is served the same `index.html`, whose head
 * describes the landing page and, worst of all, canonicalises to `https://pqp.gg/`.
 * A release note that nobody can share is not a release note, and the moment
 * one is pasted into a group chat the unfurler reads the bytes, not the script
 * that would have fixed them. So the bytes get fixed here, at the edge.
 *
 * WHY A SEPARATE MODULE FROM `marketing-meta`. The marketing pages are a closed
 * set of ten paths whose copy is a constant in that file. Posts are a list that
 * grows, their titles live in `blog/posts.ts` next to the prose, and they need
 * `BlogPosting` structured data with a date on it rather than the `WebPage` and
 * `FAQPage` the marketing pages emit. Folding the two together would mean one
 * builder with a discriminated union running through every line of it, which is
 * the shape the community and profile builders were also deliberately not
 * given.
 *
 * `escapeHtml` is the one thing imported rather than copied. The middleware
 * already loads `marketing-meta` unconditionally, so sharing it costs no bytes
 * and removes a fourth place for an escaping bug to hide.
 */

import { escapeHtml } from "./marketing-meta";
import { POSTS, postBySlug, type BlogLocale, type BlogPost } from "./blog/posts";

const CANONICAL_ORIGIN = "https://pqp.gg";

/** Whose name goes on a release note. There is one person. */
const AUTHOR = "Rafael Cammarano Guglielmi";

export type BlogTarget =
  | { kind: "index" }
  | { kind: "post"; post: BlogPost };

/**
 * The blog surface behind a path, or null for every other path.
 *
 * Same contract as `marketingPageFromMetaPath`, and the same reason it has to
 * be cheap: this runs in front of every request the site serves, including
 * every hashed asset under `/assets/`. It is a prefix check followed by an
 * exact lookup against the published slugs, so `/blog/anything-else` is null
 * rather than a post-shaped head for a page that will render "not found".
 */
export function blogTargetFromMetaPath(pathname: string): BlogTarget | null {
  const normalized =
    pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (normalized === "/blog") {
    return { kind: "index" };
  }
  if (!normalized.startsWith("/blog/")) {
    return null;
  }
  const post = postBySlug(normalized.slice("/blog/".length));
  return post ? { kind: "post", post } : null;
}

const INDEX_COPY: Record<BlogLocale, { title: string; description: string }> = {
  "pt-BR": {
    title: "Notas de versão · pqp",
    description:
      "O que mudou no pqp e quando. Cada nota conta o que passou a funcionar, o que ainda não funciona e por quê.",
  },
  en: {
    title: "Release notes · pqp",
    description:
      "What changed in pqp and when. Each note says what started working, what still does not, and why.",
  },
};

function jsonLdForIndex(locale: BlogLocale): string {
  const copy = INDEX_COPY[locale];
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Blog",
    name: copy.title,
    description: copy.description,
    url: `${CANONICAL_ORIGIN}/blog`,
    inLanguage: locale,
    publisher: { "@type": "Organization", name: "pqp", url: CANONICAL_ORIGIN },
    blogPost: POSTS.map((post) => ({
      "@type": "BlogPosting",
      headline: post.title[locale],
      datePublished: post.date,
      url: `${CANONICAL_ORIGIN}/blog/${post.slug}`,
    })),
  });
}

function jsonLdForPost(post: BlogPost, locale: BlogLocale): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title[locale],
    description: post.summary[locale],
    url: `${CANONICAL_ORIGIN}/blog/${post.slug}`,
    // No `dateModified`: a release note describes a day, and quietly restamping
    // one because a typo was fixed would misdate the thing it reports.
    datePublished: post.date,
    inLanguage: locale,
    author: { "@type": "Person", name: AUTHOR },
    publisher: { "@type": "Organization", name: "pqp", url: CANONICAL_ORIGIN },
    image: `${CANONICAL_ORIGIN}/images/og-image.jpg`,
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": `${CANONICAL_ORIGIN}/blog/${post.slug}`,
    },
  });
}

export function renderBlogHead(
  target: BlogTarget,
  locale: BlogLocale,
): string {
  const isPost = target.kind === "post";
  const url = isPost
    ? `${CANONICAL_ORIGIN}/blog/${target.post.slug}`
    : `${CANONICAL_ORIGIN}/blog`;
  const title = isPost
    ? `${target.post.title[locale]} · pqp`
    : INDEX_COPY[locale].title;
  const description = isPost
    ? target.post.summary[locale]
    : INDEX_COPY[locale].description;
  const image = `${CANONICAL_ORIGIN}/images/og-image.jpg`;
  const e = escapeHtml;

  return [
    `<title>${e(title)}</title>`,
    `<meta name="description" content="${e(description)}" />`,
    `<link rel="canonical" href="${e(url)}" />`,
    `<link rel="alternate" hreflang="x-default" href="${e(url)}" />`,
    `<link rel="alternate" hreflang="pt-BR" href="${e(url)}?lang=pt-BR" />`,
    `<link rel="alternate" hreflang="en" href="${e(url)}?lang=en" />`,
    // `article` rather than `website` for a post: it is what puts the date and
    // the byline on the card in every unfurler that shows them.
    `<meta property="og:type" content="${isPost ? "article" : "website"}" />`,
    `<meta property="og:site_name" content="pqp" />`,
    `<meta property="og:url" content="${e(url)}" />`,
    `<meta property="og:title" content="${e(title)}" />`,
    `<meta property="og:description" content="${e(description)}" />`,
    `<meta property="og:image" content="${e(image)}" />`,
    ...(isPost
      ? [
          `<meta property="article:published_time" content="${e(target.post.date)}" />`,
          `<meta property="article:author" content="${e(AUTHOR)}" />`,
        ]
      : []),
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${e(title)}" />`,
    `<meta name="twitter:description" content="${e(description)}" />`,
    `<meta name="twitter:image" content="${e(image)}" />`,
    `<meta name="robots" content="index, follow" />`,
    // The locale this document was negotiated in, for the client bundle to
    // read back. `detectLocale()` prefers it over `navigator.languages`,
    // which is what stops a crawler's English renderer overwriting this
    // head with the English one. See `lib/locale.ts`.
    `<meta name="pqp:locale" content="${locale}" />`,
    `<script type="application/ld+json">${
      isPost ? jsonLdForPost(target.post, locale) : jsonLdForIndex(locale)
    }</script>`,
  ].join("\n    ");
}

/**
 * Every tag this module owns, so a second injection cannot leave two titles in
 * one document. Deliberately the same shape as the copy in `marketing-meta`,
 * `profile-meta` and `community-meta`: each builder strips what it writes, and
 * only ever one of them runs on a given request.
 */
const MANAGED_TAGS =
  /[ \t]*(?:<title>[\s\S]*?<\/title>|<meta\s+(?:name|property)="(?:description|robots|pqp:locale|og:[a-zA-Z:]+|twitter:[a-zA-Z:]+|article:[a-zA-Z:_]+)"[\s\S]*?\/>|<link\s+rel="canonical"[^>]*\/>|<link\s+rel="alternate"[^>]*\/>|<script type="application\/ld\+json">[\s\S]*?<\/script>)\n?/g;

/**
 * Rewrite a document's head for the blog index or one post.
 *
 * Returns the html unchanged when it has no `<head>`, which is the same bar
 * every failure path in this feature is held to: a page that unfurls badly is a
 * bad day, a page that 500s at the edge is a dead link.
 */
export function injectBlogHead(
  html: string,
  target: BlogTarget,
  locale: BlogLocale,
): string {
  if (html.indexOf("<head>") === -1) {
    return html;
  }
  let stripped = html.replace(MANAGED_TAGS, "");
  if (locale === "pt-BR") {
    stripped = stripped.replace('<html lang="en">', '<html lang="pt-BR">');
  }
  const insertAt = stripped.indexOf("<head>") + "<head>".length;
  return (
    stripped.slice(0, insertAt) +
    "\n    " +
    renderBlogHead(target, locale) +
    stripped.slice(insertAt)
  );
}

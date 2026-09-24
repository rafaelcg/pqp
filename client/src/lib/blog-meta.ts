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
import {
  ARTICLES,
  articleBySlug,
  articleFaq,
  articleSummary,
  articleTitle,
  type BlogArticle,
} from "./blog/articles";
import {
  POSTS,
  postBySlug,
  postLocale,
  postSummary,
  postTitle,
  type BlogLocale,
  type BlogPost,
  type BlogReadLocale,
} from "./blog/posts";

const CANONICAL_ORIGIN = "https://pqp.gg";

/** Whose name goes on a release note. There is one person. */
const AUTHOR = "Rafael Cammarano Guglielmi";

export type BlogTarget =
  | { kind: "index" }
  | { kind: "post"; post: BlogPost }
  | { kind: "article"; article: BlogArticle };

/**
 * The blog surface behind a path, or null for every other path.
 *
 * Same contract as `marketingPageFromMetaPath`, and the same reason it has to
 * be cheap: this runs in front of every request the site serves, including
 * every hashed asset under `/assets/`. It is a prefix check followed by an
 * exact lookup against the published slugs, so `/blog/anything-else` is null
 * rather than a post-shaped head for a page that will render "not found".
 * Release notes are checked first, then guides — the two lists cannot share a
 * slug (`articles.test.ts` pins that), so the order only decides which lookup
 * runs when a slug is not in either.
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
  const slug = normalized.slice("/blog/".length);
  const post = postBySlug(slug);
  if (post) {
    return { kind: "post", post };
  }
  const article = articleBySlug(slug);
  return article ? { kind: "article", article } : null;
}

const INDEX_COPY: Record<BlogLocale, { title: string; description: string }> = {
  "pt-BR": {
    title: "Blog · pqp",
    description:
      "Guias pra tirar mais do pqp, e notas de versão de tudo que mudou no produto e quando.",
  },
  en: {
    title: "Blog · pqp",
    description:
      "Guides to get more out of pqp, and release notes for everything that changed and when.",
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
    blogPost: [
      ...ARTICLES.map((article) => ({
        "@type": "Article",
        headline: articleTitle(article, locale),
        datePublished: article.date,
        dateModified: article.updated,
        url: `${CANONICAL_ORIGIN}/blog/${article.slug}`,
      })),
      ...POSTS.map((post) => ({
        "@type": "BlogPosting",
        headline: post.title[locale],
        datePublished: post.date,
        url: `${CANONICAL_ORIGIN}/blog/${post.slug}`,
      })),
    ],
  });
}

function jsonLdForPost(post: BlogPost, locale: BlogReadLocale): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: postTitle(post, locale),
    description: postSummary(post, locale),
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

/**
 * A guide's structured data: `Article` (it has a `dateModified`, unlike a
 * release note, because a guide is corrected in place rather than describing
 * one day), its own `FAQPage` built from the exact questions the article
 * renders (same rule `marketing-meta.ts` holds `/vs-discord` and `/tela`
 * to), and a `BreadcrumbList` so a result can show "pqp › Blog › <title>"
 * instead of a bare URL. One `@graph` so all three ship in a single script
 * tag, same shape as `marketing-meta.ts`'s `jsonLdFor`.
 */
function jsonLdForArticle(article: BlogArticle, locale: BlogLocale): string {
  const url = `${CANONICAL_ORIGIN}/blog/${article.slug}`;
  const faq = articleFaq(article, locale);
  const graph: Record<string, unknown>[] = [
    {
      "@type": "Article",
      headline: articleTitle(article, locale),
      description: articleSummary(article, locale),
      url,
      datePublished: article.date,
      dateModified: article.updated,
      inLanguage: locale,
      author: { "@type": "Person", name: AUTHOR },
      publisher: { "@type": "Organization", name: "pqp", url: CANONICAL_ORIGIN },
      image: `${CANONICAL_ORIGIN}/images/og-image.jpg`,
      mainEntityOfPage: { "@type": "WebPage", "@id": url },
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "pqp", item: `${CANONICAL_ORIGIN}/` },
        { "@type": "ListItem", position: 2, name: "Blog", item: `${CANONICAL_ORIGIN}/blog` },
        { "@type": "ListItem", position: 3, name: articleTitle(article, locale), item: url },
      ],
    },
  ];
  if (faq.length > 0) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: faq.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer },
      })),
    });
  }
  // `</script>` inside a JSON string would close the block early. Cannot
  // happen in any field above today, an FAQ answer is free text somebody will
  // eventually paste HTML into; the escape is what keeps that harmless.
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(
    /</g,
    "\\u003c",
  );
}

/**
 * The language a post's card is written in for this request. Spanish only for
 * a Spanish reader of a post that has Spanish copy; every other post keeps the
 * English card a Spanish reader has always had.
 */
function postCardLocale(
  post: BlogPost,
  locale: BlogLocale,
  servedLocale: string,
): BlogReadLocale {
  return postLocale(post, servedLocale === "es" ? "es" : locale);
}

export function renderBlogHead(
  target: BlogTarget,
  locale: BlogLocale,
  /**
   * The app language to stamp, when it differs from the copy's: most posts
   * exist in Portuguese and English only, so a Spanish reader gets the English
   * post while the chrome around it should still boot in Spanish. A post with
   * Spanish copy is served in Spanish to that reader instead.
   */
  servedLocale: string = locale,
): string {
  const isPost = target.kind === "post";
  const isArticle = target.kind === "article";
  const url =
    target.kind === "post"
      ? `${CANONICAL_ORIGIN}/blog/${target.post.slug}`
      : target.kind === "article"
        ? `${CANONICAL_ORIGIN}/blog/${target.article.slug}`
        : `${CANONICAL_ORIGIN}/blog`;
  const postCopy =
    target.kind === "post"
      ? postCardLocale(target.post, locale, servedLocale)
      : locale;
  const title = isPost
    ? `${postTitle(target.post, postCopy)} · pqp`
    : isArticle
      ? `${articleTitle(target.article, locale)} · pqp`
      : INDEX_COPY[locale].title;
  const description = isPost
    ? postSummary(target.post, postCopy)
    : isArticle
      ? articleSummary(target.article, locale)
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
    ...(isPost && target.post.title.es
      ? [`<link rel="alternate" hreflang="es" href="${e(url)}?lang=es" />`]
      : []),
    // `article` rather than `website` for a post or a guide: it is what puts
    // the date and the byline on the card in every unfurler that shows them.
    `<meta property="og:type" content="${isPost || isArticle ? "article" : "website"}" />`,
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
    ...(isArticle
      ? [
          `<meta property="article:published_time" content="${e(target.article.date)}" />`,
          `<meta property="article:modified_time" content="${e(target.article.updated)}" />`,
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
    `<meta name="pqp:locale" content="${servedLocale}" />`,
    `<script type="application/ld+json">${
      isPost
        ? jsonLdForPost(target.post, postCopy)
        : isArticle
          ? jsonLdForArticle(target.article, locale)
          : jsonLdForIndex(locale)
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
  servedLocale: string = locale,
): string {
  if (html.indexOf("<head>") === -1) {
    return html;
  }
  let stripped = html.replace(MANAGED_TAGS, "");
  if (locale === "pt-BR") {
    stripped = stripped.replace('<html lang="en">', '<html lang="pt-BR">');
  } else if (
    target.kind === "post" &&
    postCardLocale(target.post, locale, servedLocale) === "es"
  ) {
    stripped = stripped.replace('<html lang="en">', '<html lang="es">');
  }
  const insertAt = stripped.indexOf("<head>") + "<head>".length;
  return (
    stripped.slice(0, insertAt) +
    "\n    " +
    renderBlogHead(target, locale, servedLocale) +
    stripped.slice(insertAt)
  );
}

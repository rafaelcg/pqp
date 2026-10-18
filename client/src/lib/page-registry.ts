/**
 * Every page whose words a reader without JavaScript should get, in one list.
 *
 * WHY A REGISTRY. The site is a static SPA, so a crawler that does not run the
 * bundle (Bing's first pass, the unfurlers, and above all the AI fetchers) reads
 * a head over an empty `#root`. Five marketing pages already get a body written
 * at the edge (`marketing-prerender.ts`); the guides and the release notes did
 * not, and they are the content. This is the one place that says which pages
 * exist, in which languages, where their markdown twin lives and what the
 * fragment the build emits for them is called, so the build (`static-pages.ts`),
 * the edge (`functions/_middleware.ts`, `blog-meta.ts`,
 * `markdown-negotiation.ts`) and the generators that follow (sitemap, feed)
 * cannot disagree about it.
 *
 * ADDING A KIND OF PAGE (a `/compare` page, say): give it an entry here and a
 * renderer in `static-pages.ts`. Nothing else enumerates pages.
 *
 * DEPENDENCY-FREE apart from the two lists the middleware already bundles
 * (`blog/posts.ts`, `blog/articles.ts`): wrangler bundles the middleware outside
 * the workspace, and esbuild has no loader for `.md`, so this module names the
 * files and never reads them.
 */

import { ARTICLES, type BlogArticle } from "./blog/articles";
import { POSTS, type BlogPost } from "./blog/posts";

/** The three languages the site speaks. */
export type PageLocale = "pt-BR" | "en" | "es";

export type RegisteredPage =
  | { kind: "blog-index"; path: "/blog"; locales: readonly PageLocale[]; lastmod: string }
  | {
      kind: "post";
      path: string;
      slug: string;
      post: BlogPost;
      locales: readonly PageLocale[];
      lastmod: string;
    }
  | {
      kind: "article";
      path: string;
      slug: string;
      article: BlogArticle;
      locales: readonly PageLocale[];
      lastmod: string;
    };

/** The languages that have a written body for a release note. */
export function postLocales(post: BlogPost): readonly PageLocale[] {
  return post.title.es ? ["pt-BR", "en", "es"] : ["pt-BR", "en"];
}

/** The languages that have a written body for a guide. */
export function articleLocales(article: BlogArticle): readonly PageLocale[] {
  return article.locales;
}

/** The newest of a set of `YYYY-MM-DD` dates (they sort as strings). */
function newest(dates: readonly string[]): string {
  return dates.reduce((a, b) => (a >= b ? a : b));
}

/**
 * The blog surfaces: the index, each release note, each guide. Newest content
 * drives the index's `lastmod`, so it moves when (and only when) a page is
 * added to or changed under it.
 */
export function blogPages(): RegisteredPage[] {
  const dates = [
    ...POSTS.map((post) => post.date),
    ...ARTICLES.map((article) => article.updated),
  ];
  return [
    {
      kind: "blog-index",
      path: "/blog",
      locales: ["pt-BR", "en"],
      lastmod: newest(dates),
    },
    ...ARTICLES.map(
      (article): RegisteredPage => ({
        kind: "article",
        path: `/blog/${article.slug}`,
        slug: article.slug,
        article,
        locales: articleLocales(article),
        lastmod: article.updated,
      }),
    ),
    ...POSTS.map(
      (post): RegisteredPage => ({
        kind: "post",
        path: `/blog/${post.slug}`,
        slug: post.slug,
        post,
        locales: postLocales(post),
        lastmod: post.date,
      }),
    ),
  ];
}

/**
 * Where the build writes the fragment (the page's words, as HTML) the edge
 * writes into `#root`. A `.json` file rather than `.html` on purpose: Pages
 * answers `/x.html` with a 308 to `/x`, so an asset fetch for it would follow a
 * redirect to the SPA shell instead of returning the fragment.
 */
export function fragmentPath(page: { path: string }, locale: PageLocale): string {
  const key = page.path === "/blog" ? "index" : page.path.slice("/blog/".length);
  return `prerender/blog/${key}.${locale}.json`;
}

/**
 * The markdown twin of a page in one language, as a site path. Portuguese is
 * the bare name because it is the language the bare canonical URL is in; the
 * other two carry their code, like the `?lang=` alternates do.
 */
export function markdownTwinPath(page: { path: string }, locale: PageLocale): string {
  const base = page.path === "/blog" ? "/blog" : page.path;
  return locale === "pt-BR" ? `${base}.md` : `${base}.${locale}.md`;
}

/** The registered page behind a path, or null. A plain lookup, no I/O. */
export function registeredBlogPage(pathname: string): RegisteredPage | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return blogPages().find((page) => page.path === normalized) ?? null;
}

/**
 * The language a page is actually served in for a reader who asked for
 * `wanted`: that language when the page has a body in it, English when it does
 * not and the reader wanted Spanish (the long-standing fallback), Portuguese
 * for anything else.
 */
export function pageLocaleFor(
  page: { locales: readonly PageLocale[] },
  wanted: PageLocale,
): PageLocale {
  if (page.locales.includes(wanted)) {
    return wanted;
  }
  if (wanted === "es" && page.locales.includes("en")) {
    return "en";
  }
  return "pt-BR";
}

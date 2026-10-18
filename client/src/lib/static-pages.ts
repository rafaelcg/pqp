/**
 * The words of every blog page, rendered at BUILD time for readers that run no
 * JavaScript.
 *
 * WHAT THIS PRODUCES. For each page in `page-registry.ts` and each language it
 * has, two files:
 *
 *   - a FRAGMENT (`prerender/blog/<slug>.<locale>.json`): the page's `<main>`
 *     as semantic HTML, with the language it is in. The Pages middleware reads
 *     it through the asset binding and writes it into `#root` between the
 *     site's plain nav and footer, the same way it already does for
 *     `/vs-discord` (`marketing-prerender.ts`). The fragment is not a page: it
 *     is not linked, not in the sitemap, and `_headers` marks it `noindex`.
 *   - a MARKDOWN TWIN (`/blog/<slug>.md`, `.en.md`, `.es.md`): the same words as
 *     markdown, for the agents that ask for it (`Accept: text/markdown`, or the
 *     `<link rel="alternate" type="text/markdown">` in the head).
 *
 * WHY AT BUILD TIME, AND WHY NOT IN THE MIDDLEWARE. The prose is `.md`, and
 * wrangler bundles the middleware with esbuild, which has no loader for it
 * (`blog/bodies.ts` has the story: a `?raw` import in that graph failed a
 * production deploy after CI was green). The build already has the prose, so it
 * writes the HTML once and the edge only concatenates strings.
 *
 * SAME RENDERER AS THE PAGE. The body goes through the `react-markdown` and
 * `remark-gfm` the live page uses (`blog-post-page.tsx`), rendered to a string,
 * so a table, a list or a link comes out the way the browser draws it and there
 * is no second markdown dialect to drift. No dependency is added.
 *
 * NO HYDRATION. `main.tsx` calls `createRoot`, not `hydrateRoot`: React clears
 * `#root` and draws the live page, and a head script hides the block before the
 * first paint in any browser that runs JavaScript (`index.css`, `#pre-page`).
 * So the block can be plain HTML that does not match the React tree node for
 * node, and nobody with a script ever sees it, flashes it or shifts around it.
 *
 * Build-time only: nothing the edge imports may import this file (it pulls in
 * `react-dom/server`). Relative imports only, because `vite.config.ts` loads it
 * without the `@` alias.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { articleFaq, articleSummary, articleTitle } from "./blog/articles";
import { formatPostDate } from "./blog/format";
import { postSummary, postTitle, type BlogLocale } from "./blog/posts";
import { escapeHtml } from "./marketing-meta";
import { marketingMain, PRERENDERED_MARKETING_PAGES } from "./marketing-prerender";
import {
  blogPages,
  fragmentPath,
  markdownTwinPath,
  type PageLocale,
  type RegisteredPage,
} from "./page-registry";

const ORIGIN = "https://pqp.gg";

/** A file the build writes, by its path under the output directory. */
export interface StaticFile {
  path: string;
  content: string;
}

/** Where the build gets what it does not own: the prose and the catalogues. */
export interface StaticSources {
  /** The markdown of one page in one language, or null when there is none. */
  body(slug: string, locale: PageLocale): string | null;
  /** One locale's i18n catalogue, flat. */
  catalogue(locale: PageLocale): Record<string, string>;
}

/** What the edge reads out of a fragment file. */
export interface Fragment {
  lang: PageLocale;
  html: string;
}

const e = escapeHtml;

const COMPONENTS: Components = {
  // The live page draws a figure with an expand button; with no script the
  // picture and its caption are what matters.
  img: ({ src, alt, title }) =>
    src ? createElement("img", { src, alt: alt ?? "", title, loading: "lazy" }) : null,
};

/** Markdown to HTML with the renderer the live page uses. */
export function renderMarkdownToHtml(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins: [remarkGfm], components: COMPONENTS },
      markdown,
    ),
  );
}

/** A site-relative link or image made absolute, for a twin read away from the site. */
export function absolutizeMarkdown(markdown: string): string {
  return markdown.replace(/\]\((\/[^)\s]*)/g, (_all, href: string) => `](${ORIGIN}${href}`);
}

function t(catalogue: Record<string, string>, key: string, fallback: string): string {
  return catalogue[key] ?? fallback;
}

/** The body language of a page for the blog's two-language lists. */
function listLocale(locale: PageLocale): BlogLocale {
  return locale === "pt-BR" ? "pt-BR" : "en";
}

function titleOf(page: RegisteredPage, locale: PageLocale): string {
  if (page.kind === "post") return postTitle(page.post, locale);
  if (page.kind === "article") return articleTitle(page.article, listLocale(locale));
  return "Blog";
}

function summaryOf(page: RegisteredPage, locale: PageLocale): string {
  if (page.kind === "post") return postSummary(page.post, locale);
  if (page.kind === "article") return articleSummary(page.article, listLocale(locale));
  return "";
}

function dateLine(page: RegisteredPage, locale: PageLocale, c: Record<string, string>): string {
  if (page.kind === "post") {
    return formatPostDate(page.post.date, locale);
  }
  if (page.kind === "article") {
    return t(c, "blog.article.updated", "Updated {date}").replace(
      "{date}",
      formatPostDate(page.article.updated, listLocale(locale)),
    );
  }
  return "";
}

function isoDate(page: RegisteredPage): string {
  return page.kind === "post"
    ? page.post.date
    : page.kind === "article"
      ? page.article.updated
      : page.lastmod;
}

function faqOf(page: RegisteredPage, locale: PageLocale) {
  return page.kind === "article" ? articleFaq(page.article, listLocale(locale)) : [];
}

function pageHtml(
  page: RegisteredPage,
  locale: PageLocale,
  body: string,
  c: Record<string, string>,
): string {
  const faq = faqOf(page, locale);
  return [
    `<main class="mx-auto max-w-2xl">`,
    `<article>`,
    `<p><a href="/blog" class="text-sm underline">${e(t(c, "blog.back", "See everything"))}</a></p>`,
    `<h1 class="mt-6 font-display text-3xl font-bold">${e(titleOf(page, locale))}</h1>`,
    `<p class="mt-4 text-sm text-text-secondary"><time datetime="${e(isoDate(page))}">${e(dateLine(page, locale, c))}</time></p>`,
    `<div class="blog-prose mt-10">${renderMarkdownToHtml(body)}</div>`,
    faq.length > 0
      ? `<section class="mt-14"><h2 class="font-display text-xl font-semibold">${e(t(c, "blog.article.faqHeading", "Frequently asked questions"))}</h2><dl class="mt-6">${faq
          .map(
            (item) =>
              `<div class="mt-4"><dt class="font-medium">${e(item.question)}</dt><dd class="mt-2 text-text-secondary">${e(item.answer)}</dd></div>`,
          )
          .join("")}</dl></section>`
      : "",
    `</article>`,
    `</main>`,
  ].join("");
}

function indexHtml(locale: PageLocale, c: Record<string, string>): string {
  const lang = listLocale(locale);
  const pages = blogPages();
  const articles = pages.filter((p) => p.kind === "article");
  const posts = pages.filter((p) => p.kind === "post");
  const item = (page: RegisteredPage) =>
    `<li class="mt-6"><article><h3 class="font-display text-xl font-semibold"><a href="${e(page.path)}">${e(titleOf(page, lang))}</a></h3><p class="mt-2 text-text-secondary">${e(summaryOf(page, lang))}</p><p class="mt-1 text-sm text-text-secondary"><time datetime="${e(isoDate(page))}">${e(formatPostDate(isoDate(page), lang))}</time></p></article></li>`;
  return [
    `<main class="mx-auto max-w-2xl">`,
    `<h1 class="font-display text-3xl font-bold">${e(t(c, "blog.hero.title", "Blog"))}</h1>`,
    `<p class="mt-4 text-text-secondary">${e(t(c, "blog.hero.lede", ""))}</p>`,
    `<section class="mt-14"><h2 class="font-display text-xs font-semibold uppercase tracking-[0.14em]">${e(t(c, "blog.guides.heading", "Guides"))}</h2><p class="mt-2 text-sm text-text-secondary">${e(t(c, "blog.guides.lede", ""))}</p><ol>${articles.map(item).join("")}</ol></section>`,
    `<section class="mt-14"><h2 class="font-display text-xs font-semibold uppercase tracking-[0.14em]">${e(t(c, "blog.notes.heading", "Release notes"))}</h2><p class="mt-2 text-sm text-text-secondary">${e(t(c, "blog.notes.lede", ""))}</p><ol>${posts.map(item).join("")}</ol></section>`,
    `</main>`,
  ].join("");
}

function pageMarkdown(
  page: RegisteredPage,
  locale: PageLocale,
  body: string,
  c: Record<string, string>,
): string {
  const lines = [
    `# ${titleOf(page, locale)}`,
    ``,
    `Canonical: ${ORIGIN}${page.path}`,
    `Language: ${locale}`,
    `${page.kind === "article" ? "Updated" : "Published"}: ${isoDate(page)}`,
    ``,
    absolutizeMarkdown(body.trim()),
  ];
  const faq = faqOf(page, locale);
  if (faq.length > 0) {
    lines.push(``, `## ${t(c, "blog.article.faqHeading", "Frequently asked questions")}`);
    for (const item of faq) {
      lines.push(``, `### ${item.question}`, ``, item.answer);
    }
  }
  return lines.join("\n") + "\n";
}

function indexMarkdown(locale: PageLocale, c: Record<string, string>): string {
  const lang = listLocale(locale);
  const pages = blogPages();
  const list = (kind: "article" | "post") =>
    pages
      .filter((p) => p.kind === kind)
      .map(
        (p) =>
          `- [${titleOf(p, lang)}](${ORIGIN}${p.path}) (${isoDate(p)}): ${summaryOf(p, lang)}`,
      );
  return (
    [
      `# ${t(c, "blog.hero.title", "Blog")}`,
      ``,
      `Canonical: ${ORIGIN}/blog`,
      `Language: ${lang}`,
      ``,
      t(c, "blog.hero.lede", ""),
      ``,
      `## ${t(c, "blog.guides.heading", "Guides")}`,
      ``,
      ...list("article"),
      ``,
      `## ${t(c, "blog.notes.heading", "Release notes")}`,
      ``,
      ...list("post"),
    ].join("\n") + "\n"
  );
}

/**
 * Every file the build writes for the blog, or throws naming the page that has
 * no words. A page in the registry without a body file would otherwise ship as
 * an empty `#root` again and nothing would say so.
 */
export function buildBlogStaticFiles(sources: StaticSources): StaticFile[] {
  const files: StaticFile[] = [];
  for (const page of blogPages()) {
    for (const locale of page.locales) {
      const c = sources.catalogue(locale);
      let html: string;
      let markdown: string;
      if (page.kind === "blog-index") {
        html = indexHtml(locale, c);
        markdown = indexMarkdown(locale, c);
      } else {
        const body = sources.body(page.slug, locale);
        if (body === null || body.trim() === "") {
          throw new Error(
            `static-pages: ${page.path} has no ${locale} body (expected src/content/blog/${page.slug}.${locale}.md)`,
          );
        }
        html = pageHtml(page, locale, body, c);
        markdown = pageMarkdown(page, locale, body, c);
      }
      const fragment: Fragment = { lang: locale, html };
      files.push({ path: fragmentPath(page, locale), content: JSON.stringify(fragment) });
      files.push({ path: markdownTwinPath(page, locale).slice(1), content: markdown });
    }
  }
  assertStaticBodies(files);
  return files;
}

/** The visible text of an HTML string: tags gone, entities left, whitespace folded. */
export function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Least visible characters a page's static body must carry to count as a body. */
export const MIN_STATIC_BODY_CHARS = 200;

/**
 * The build check: fails when a fragment has an empty or token body, no
 * `<h1>`, or no internal link (a page nothing links out of is a dead end for a
 * crawler that follows what it reads). The empty `#root`
 * this whole mechanism exists to remove looks exactly like a successful build,
 * so the build is where it has to be caught.
 */
export function assertStaticBodies(files: readonly StaticFile[]): void {
  const problems: string[] = [];
  for (const file of files) {
    if (!file.path.startsWith("prerender/")) continue;
    const fragment = JSON.parse(file.content) as Fragment;
    const text = visibleText(fragment.html);
    if (text.length < MIN_STATIC_BODY_CHARS) {
      problems.push(`${file.path}: only ${text.length} visible characters`);
    }
    if (!/<h1[ >]/.test(fragment.html)) {
      problems.push(`${file.path}: no <h1>`);
    }
    if (!/<a [^>]*href="\/[^"]*"/.test(fragment.html)) {
      problems.push(`${file.path}: no internal link`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`static-pages: empty or incomplete static body\n  ${problems.join("\n  ")}`);
  }
}

/**
 * The same bar for the marketing pages that carry a no-JS body
 * (`marketing-prerender.ts`): in every language, each must render a heading and
 * at least `MIN_STATIC_BODY_CHARS` of visible text. A copy edit or a catalogue
 * key that comes back empty would otherwise ship a page that looks fine in a
 * browser and says nothing to a crawler.
 */
export function assertMarketingBodies(): void {
  const problems: string[] = [];
  for (const page of PRERENDERED_MARKETING_PAGES) {
    for (const locale of ["pt-BR", "en", "es"] as const) {
      const main = marketingMain(page, locale);
      const length = main === null ? 0 : visibleText(main).length;
      if (length < MIN_STATIC_BODY_CHARS) {
        problems.push(`${page} (${locale}): only ${length} visible characters`);
      } else if (!/<h1[ >]/.test(main!)) {
        problems.push(`${page} (${locale}): no <h1>`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`static-pages: empty marketing body\n  ${problems.join("\n  ")}`);
  }
}

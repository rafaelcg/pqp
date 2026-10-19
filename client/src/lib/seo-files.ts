/**
 * `sitemap.xml` and the release-note Atom feeds, as strings.
 *
 * Pure: the build (`pqp-seo-files` in `vite.config.ts`) feeds these the pages
 * and the rendered release-note HTML and writes the result, and the tests feed
 * them anything they like. What is listed comes from `sitemap-pages.ts`; this
 * file only knows how to write it down correctly (escaping, dates, the
 * namespaces).
 *
 * GOOGLE READS BOTH AS SITEMAPS. A sitemap may be an Atom or RSS feed, which is
 * why `robots.txt` lists `/feed.xml` beside `/sitemap.xml`: a crawler that only
 * ever reads `robots.txt` still learns about a release note the day it ships.
 */

import { BLOG_AUTHOR } from "./blog-meta";
import { POSTS, postSummary, postTitle } from "./blog/posts";
import { markdownTwinPath, type PageLocale } from "./page-registry";
import type { SitemapPage } from "./sitemap-pages";

const ORIGIN = "https://pqp.gg";

/** Characters XML 1.0 cannot carry at all, even escaped. */
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/** Text for an XML text node or a double-quoted attribute. */
export function xmlEscape(value: string): string {
  return value
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `value` is a real calendar day written `YYYY-MM-DD`. */
export function isDay(value: string): boolean {
  if (!DAY.test(value)) {
    return false;
  }
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

function loc(path: string): string {
  return path === "/" ? `${ORIGIN}/` : `${ORIGIN}${path}`;
}

/**
 * The sitemap. `<lastmod>` is written only for a real day, `<priority>` with one
 * decimal, and every alternate (the page itself included, as the protocol
 * requires) as an `xhtml:link`. There is no `<changefreq>`: Google ignores it
 * and the old file claimed "weekly" for pages that had not moved in a month.
 */
export function renderSitemap(pages: readonly SitemapPage[]): string {
  const urls = pages.map((page) => {
    const lines = [`  <url>`, `    <loc>${xmlEscape(loc(page.path))}</loc>`];
    if (page.lastmod !== null) {
      if (!isDay(page.lastmod)) {
        throw new Error(`sitemap: ${page.path} has an invalid lastmod "${page.lastmod}"`);
      }
      lines.push(`    <lastmod>${page.lastmod}</lastmod>`);
    }
    lines.push(`    <priority>${page.priority.toFixed(1)}</priority>`);
    for (const alt of page.alternates) {
      lines.push(
        `    <xhtml:link rel="alternate" hreflang="${xmlEscape(alt.hreflang)}" href="${xmlEscape(alt.href)}" />`,
      );
    }
    lines.push(`  </url>`);
    return lines.join("\n");
  });
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!-- Generated at build time from the page registries (src/lib/sitemap-pages.ts). Do not edit. -->`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">`,
    ...urls,
    `</urlset>`,
    ``,
  ].join("\n");
}

/**
 * A day as an Atom timestamp. Release notes are dated by the day they reached
 * people, with no clock: noon UTC lands on the same calendar day in every time
 * zone from UTC-11 to UTC+11, which is every place a reader of this is.
 */
export function atomDateTime(day: string): string {
  if (!isDay(day)) {
    throw new Error(`feed: "${day}" is not a YYYY-MM-DD day`);
  }
  return `${day}T12:00:00Z`;
}

export interface FeedEntry {
  /** A stable IRI, never reused. */
  id: string;
  title: string;
  /** The HTML page. */
  link: string;
  /** The markdown twin, when there is one. */
  markdownLink?: string;
  summary: string;
  /** The full note as HTML; made absolute and escaped by the renderer. */
  contentHtml: string;
  /** `YYYY-MM-DD`. */
  date: string;
}

export interface FeedOptions {
  lang: string;
  title: string;
  subtitle: string;
  /** Where this feed lives. */
  selfUrl: string;
  /** The page a human reads it on. */
  siteUrl: string;
  author: string;
  entries: readonly FeedEntry[];
}

/** Root-relative links and pictures made absolute, for a reader away from the site. */
export function absolutizeHtml(html: string): string {
  return html.replace(/\b(href|src)="\/(?!\/)/g, `$1="${ORIGIN}/`);
}

/** An Atom 1.0 feed, newest entry first, `<updated>` from the newest entry. */
export function renderAtomFeed(options: FeedOptions): string {
  const entries = [...options.entries].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const updated = entries.length > 0 ? atomDateTime(entries[0]!.date) : "1970-01-01T00:00:00Z";
  const e = xmlEscape;
  const body = entries.map((entry) =>
    [
      `  <entry>`,
      `    <id>${e(entry.id)}</id>`,
      `    <title>${e(entry.title)}</title>`,
      `    <link rel="alternate" type="text/html" href="${e(entry.link)}" />`,
      ...(entry.markdownLink
        ? [`    <link rel="alternate" type="text/markdown" href="${e(entry.markdownLink)}" />`]
        : []),
      `    <published>${atomDateTime(entry.date)}</published>`,
      `    <updated>${atomDateTime(entry.date)}</updated>`,
      `    <author><name>${e(options.author)}</name></author>`,
      `    <summary type="text">${e(entry.summary)}</summary>`,
      `    <content type="html">${e(absolutizeHtml(entry.contentHtml))}</content>`,
      `  </entry>`,
    ].join("\n"),
  );
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${e(options.lang)}">`,
    `  <id>${e(options.selfUrl)}</id>`,
    `  <title>${e(options.title)}</title>`,
    `  <subtitle>${e(options.subtitle)}</subtitle>`,
    `  <link rel="self" type="application/atom+xml" href="${e(options.selfUrl)}" />`,
    `  <link rel="alternate" type="text/html" href="${e(options.siteUrl)}" />`,
    `  <updated>${updated}</updated>`,
    `  <author><name>${e(options.author)}</name></author>`,
    `  <generator>pqp.gg build</generator>`,
    ...body,
    `</feed>`,
    ``,
  ].join("\n");
}

/** The two languages the release notes are always written in, and their feed. */
export const FEEDS: Record<
  "pt-BR" | "en",
  { path: string; title: string; subtitle: string }
> = {
  "pt-BR": {
    path: "/feed.xml",
    title: "pqp: notas de versão",
    subtitle: "O que mudou no pqp, no dia em que mudou.",
  },
  en: {
    path: "/feed.en.xml",
    title: "pqp: release notes",
    subtitle: "What changed in pqp, on the day it changed.",
  },
};

/**
 * The feed of one language, from the release notes. `renderBody` turns a note's
 * markdown into HTML (the build passes the renderer the page uses); `readBody`
 * reads the markdown. A note with no body fails the build rather than shipping
 * an entry with nothing in it.
 */
export function releaseNoteFeed(
  locale: "pt-BR" | "en",
  readBody: (slug: string, locale: PageLocale) => string | null,
  renderBody: (markdown: string) => string,
): string {
  const feed = FEEDS[locale];
  return renderAtomFeed({
    lang: locale,
    title: feed.title,
    subtitle: feed.subtitle,
    selfUrl: `${ORIGIN}${feed.path}`,
    siteUrl: `${ORIGIN}/blog`,
    author: BLOG_AUTHOR,
    entries: POSTS.map((post) => {
      const markdown = readBody(post.slug, locale);
      if (markdown === null || markdown.trim() === "") {
        throw new Error(`feed: ${post.slug} has no ${locale} body`);
      }
      const path = `/blog/${post.slug}`;
      return {
        id: `${ORIGIN}${path}`,
        title: postTitle(post, locale),
        link: `${ORIGIN}${path}`,
        markdownLink: `${ORIGIN}${markdownTwinPath({ path }, locale)}`,
        summary: postSummary(post, locale),
        contentHtml: renderBody(markdown),
        date: post.date,
      };
    }),
  });
}

/**
 * Every URL the sitemap lists, from the registries that decide what exists.
 *
 * WHY THIS IS NOT A FILE ANYMORE. `public/sitemap.xml` was edited by hand, and
 * by 2026-10-16 it said the home page was last modified on the 30th of
 * September, the privacy policy on the 29th (the document says the 12th of
 * October) and gave a third of its URLs no date at all: a `lastmod` a crawler
 * learns to ignore is worse than none. The list now comes from the same two
 * places the head and the edge already read: the marketing pages that answer for
 * themselves (`canonicalMarketingPages` in `marketing-meta.ts`) and the blog
 * (`page-registry.ts`). A page added to either appears here, with its
 * language alternates, and a release note's date is the note's own.
 *
 * NOT LISTED, ON PURPOSE. App routes (`/app/*` is `noindex`), profiles
 * (`/@handle`) and communities (`/c/<slug>`): a complete, machine-readable list
 * of every person on the service is exactly the enumeration surface the profile
 * endpoint refuses to be, so those are found the way they are meant to be, when
 * somebody shares one and the edge makes it unfurl. `/claim` and the other
 * aliases are left out because their own head disclaims them (they canonicalise
 * elsewhere), and a sitemap is a list of the URLs we want indexed.
 *
 * Edge-safe and pure: the dates of the marketing pages are a callback, because
 * where they come from (git, a document's own date) is the build's business.
 */

import {
  canonicalMarketingPages,
  marketingUrlsFor,
  type MarketingPage,
} from "./marketing-meta";
import { blogPages, pageAlternates, type Alternate } from "./page-registry";

/** One URL the sitemap lists. */
export interface SitemapPage {
  path: string;
  /** `YYYY-MM-DD`, or null when nobody can say (never invented). */
  lastmod: string | null;
  priority: number;
  alternates: Alternate[];
}

/** How much a page matters to the site, by path; anything else gets a default. */
const PRIORITY: Record<string, number> = {
  "/": 1.0,
  "/vs-discord": 0.9,
  "/vem": 0.9,
  "/tela": 0.9,
  "/garanta": 0.9,
  "/contact": 0.4,
  "/privacy": 0.3,
  "/terms": 0.3,
  "/cookies": 0.2,
  "/status": 0.2,
  "/blog": 0.7,
};
const DEFAULT_PRIORITY = 0.8;

/**
 * Pages that exist on the hosted site but have no entry in `marketing-meta`.
 * `/apoie` is the donations page, there only while the build has a sponsor URL
 * or a Pix key (`support-links.ts`), which a sitemap file cannot know, so it
 * keeps the one line it had.
 */
export const EXTRA_PAGES: readonly { path: string; priority: number }[] = [
  { path: "/apoie", priority: 0.4 },
];

/**
 * `lastmodFor` answers a marketing page's date (the blog's come from the
 * content); returning null leaves `<lastmod>` out rather than guessing.
 */
export function sitemapPages(
  lastmodFor: (path: string) => string | null,
): SitemapPage[] {
  const marketing = canonicalMarketingPages().map(
    (page: MarketingPage): SitemapPage => ({
      path: page,
      lastmod: lastmodFor(page),
      priority: PRIORITY[page] ?? DEFAULT_PRIORITY,
      alternates: marketingUrlsFor(page, "pt-BR").alternates,
    }),
  );
  const extra = EXTRA_PAGES.map(
    (page): SitemapPage => ({
      path: page.path,
      lastmod: lastmodFor(page.path),
      priority: page.priority,
      alternates: [],
    }),
  );
  const blog = blogPages().map(
    (page): SitemapPage => ({
      path: page.path,
      lastmod: page.lastmod,
      priority:
        PRIORITY[page.path] ??
        (page.kind === "article" ? 0.7 : page.kind === "post" ? 0.6 : DEFAULT_PRIORITY),
      alternates: pageAlternates(page),
    }),
  );
  return [...marketing, ...extra, ...blog];
}

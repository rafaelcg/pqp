import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARTICLES,
  articleBySlug,
  articleFaq,
  articleSummary,
  articleTitle,
} from "./articles";
import { loadArticleBody, SLUGS_WITH_ARTICLE_BODIES } from "./article-bodies";
import { POSTS } from "./posts";

describe("ARTICLES", () => {
  it("has unique, URL-safe slugs", () => {
    const slugs = ARTICLES.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it("never shares a slug with a release note", () => {
    // The two lists share one URL namespace (`/blog/<slug>`); a slug in both
    // would make `blogTargetFromMetaPath` silently prefer whichever list it
    // checks first.
    const postSlugs = new Set(POSTS.map((p) => p.slug));
    for (const article of ARTICLES) {
      expect(postSlugs.has(article.slug)).toBe(false);
    }
  });

  it("carries a real date, an updated date, and Portuguese copy on every article", () => {
    for (const article of ARTICLES) {
      expect(article.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(article.date))).toBe(false);
      expect(article.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // An article is corrected in place, so `updated` can move forward of
      // `date` but never sit before the day it was first published.
      expect(article.updated >= article.date).toBe(true);
      expect(article.title["pt-BR"].trim().length).toBeGreaterThan(0);
      // The summary doubles as the meta description; past ~160 characters
      // search results truncate it mid-sentence, tighter than a release
      // note's 200 because a guide's summary also has to work as a card
      // blurb next to a shorter guide title.
      expect(article.summary["pt-BR"].length).toBeLessThanOrEqual(200);
    }
  });

  it("declares English only where it actually wrote English copy", () => {
    for (const article of ARTICLES) {
      const hasEnglishTitle = article.title.en !== undefined;
      const hasEnglishSummary = article.summary.en !== undefined;
      const declaresEnglish = article.locales.includes("en");
      expect(hasEnglishTitle).toBe(declaresEnglish);
      expect(hasEnglishSummary).toBe(declaresEnglish);
    }
  });

  it("falls back every FAQ answer to Portuguese for a locale with no English", () => {
    for (const article of ARTICLES) {
      const en = articleFaq(article, "en");
      const pt = articleFaq(article, "pt-BR");
      expect(en.length).toBe(pt.length);
      expect(en.length).toBe(article.faq.length);
      if (!article.locales.includes("en")) {
        expect(en).toEqual(pt);
      }
    }
  });

  it("has at least one FAQ item on every article, matching what the page renders", () => {
    for (const article of ARTICLES) {
      expect(article.faq.length).toBeGreaterThan(0);
    }
  });

  it("can load a body for every declared locale, and falls back for the rest", () => {
    return Promise.all(
      ARTICLES.flatMap((article) =>
        (["pt-BR", "en"] as const).map(async (locale) => {
          const body = await loadArticleBody(article.slug, locale);
          expect(body, `${article.slug} ${locale}`).toBeTruthy();
          expect(body!.length).toBeGreaterThan(200);
        }),
      ),
    );
  });

  it("has no importer for a slug that is not in ARTICLES", () => {
    const slugs = new Set(ARTICLES.map((a) => a.slug));
    for (const slug of SLUGS_WITH_ARTICLE_BODIES) {
      expect(slugs.has(slug)).toBe(true);
    }
  });

  it("has no em dashes in any article body, in either language", () => {
    return Promise.all(
      ARTICLES.flatMap((article) =>
        (["pt-BR", "en"] as const).map(async (locale) => {
          const body = await loadArticleBody(article.slug, locale);
          expect(body, `${article.slug} ${locale}`).not.toContain("—");
        }),
      ),
    );
  });

  it("has no em dashes in any title, summary, or FAQ item", () => {
    for (const article of ARTICLES) {
      for (const locale of ["pt-BR", "en"] as const) {
        expect(articleTitle(article, locale)).not.toContain("—");
        expect(articleSummary(article, locale)).not.toContain("—");
        for (const item of articleFaq(article, locale)) {
          expect(item.question).not.toContain("—");
          expect(item.answer).not.toContain("—");
        }
      }
    }
  });

  it("points every markdown image at a file that exists", async () => {
    // `!` in front is what makes this an image rather than an ordinary link:
    // guides cross-link to each other's `/blog/<slug>` pages in prose (posts
    // never do), and a plain link to a sibling guide is not a file on disk.
    const publicDir = fileURLToPath(new URL("../../../public", import.meta.url));
    const hrefs = new Set<string>();
    await Promise.all(
      ARTICLES.flatMap((article) =>
        (["pt-BR", "en"] as const).map(async (locale) => {
          const body = await loadArticleBody(article.slug, locale);
          for (const match of body!.matchAll(
            /!\[[^\]]*]\((\/blog\/[^)\s]+)(?:\s+"[^"]*")?\)/g,
          )) {
            hrefs.add(match[1]!);
          }
        }),
      ),
    );
    for (const href of hrefs) {
      expect(existsSync(join(publicDir, href.slice(1))), href).toBe(true);
    }
  });

  it("answers null for an unknown slug instead of throwing", async () => {
    expect(articleBySlug("nao-existe")).toBeNull();
    expect(await loadArticleBody("nao-existe", "pt-BR")).toBeNull();
  });
});

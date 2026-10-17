// @vitest-environment jsdom
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ARTICLES } from "./blog/articles";
import { POSTS } from "./blog/posts";
import { blogTargetFromMetaPath, renderBlogHead } from "./blog-meta";
import { canonicalMarketingPages, marketingUrlsFor } from "./marketing-meta";
import { blogPages, pageAlternates } from "./page-registry";
import {
  absolutizeHtml,
  atomDateTime,
  FEEDS,
  isDay,
  releaseNoteFeed,
  renderAtomFeed,
  renderSitemap,
  xmlEscape,
  type FeedEntry,
} from "./seo-files";
import { sitemapPages, type SitemapPage } from "./sitemap-pages";
import {
  gitLastModified,
  legalUpdatedDay,
  marketingLastmod,
  realProbe,
  type Probe,
} from "./source-dates";
import { renderMarkdownToHtml } from "./static-pages";

const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const body = (slug: string, locale: string) =>
  readFileSync(path.resolve(client, `src/content/blog/${slug}.${locale}.md`), "utf8");

/** Parse as XML and fail on anything a strict parser would reject. */
function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  expect(doc.getElementsByTagName("parsererror"), xml.slice(0, 200)).toHaveLength(0);
  return doc;
}

const NO_GIT: Probe = { git: () => null, read: () => null };

describe("xml helpers", () => {
  it("escapes the five characters and drops the ones XML cannot carry", () => {
    expect(xmlEscape(`a & b < c > d "e" 'f'`)).toBe("a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;");
    expect(xmlEscape("ok\u0000\u0008\u000B\u001Fend")).toBe("okend");
    expect(xmlEscape("tab\tnewline\nstays")).toBe("tab\tnewline\nstays");
  });

  it("knows a real day from a plausible one", () => {
    expect(isDay("2026-10-16")).toBe(true);
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("2026-13-01")).toBe(false);
    expect(isDay("16 October 2026")).toBe(false);
    expect(isDay("2026-10-16T00:00:00Z")).toBe(false);
  });

  it("stamps a release day at noon UTC, so it is the same day almost everywhere", () => {
    expect(atomDateTime("2026-09-29")).toBe("2026-09-29T12:00:00Z");
    expect(() => atomDateTime("2026-09-31")).toThrow();
  });

  it("makes root-relative links absolute and leaves the rest", () => {
    expect(
      absolutizeHtml(`<a href="/blog/x">x</a><img src="/blog/x/a.webp"><a href="https://e.com/a">e</a><a href="//cdn.e.com/a">c</a><a href="#top">t</a>`),
    ).toBe(
      `<a href="https://pqp.gg/blog/x">x</a><img src="https://pqp.gg/blog/x/a.webp"><a href="https://e.com/a">e</a><a href="//cdn.e.com/a">c</a><a href="#top">t</a>`,
    );
  });
});

describe("the dates a marketing page gets", () => {
  it("reads the date a legal document carries", () => {
    expect(legalUpdatedDay(`  updated: "12 October 2026",`)).toBe("2026-10-12");
    expect(legalUpdatedDay(`  updated: "9 January 2027",`)).toBe("2027-01-09");
    expect(legalUpdatedDay(`  updated: "31 February 2026",`)).toBeNull();
    expect(legalUpdatedDay(`  updated: "12 Octobre 2026",`)).toBeNull();
    expect(legalUpdatedDay(`nothing here`)).toBeNull();
  });

  it("uses the document's own date for a policy, and git for the other pages", () => {
    const probe: Probe = {
      git: (args) => (args[0] === "rev-parse" ? "false" : "2026-10-01"),
      read: (file) => (file.endsWith("privacy.en.tsx") ? `  updated: "12 October 2026",` : null),
    };
    expect(marketingLastmod(probe, "/privacy")).toBe("2026-10-12");
    expect(marketingLastmod(probe, "/tela")).toBe("2026-10-01");
  });

  it("moves a page's date when its copy changes in a catalogue, and no other page's", () => {
    const calls: (readonly string[])[] = [];
    const probe: Probe = {
      git(args) {
        if (args[0] === "rev-parse") return "false";
        calls.push(args);
        // The page file last changed on the 1st; a `vsDiscord.` catalogue line on the 9th.
        return args.some((a) => a.startsWith("-G")) ? "2026-10-09" : "2026-10-01";
      },
      read: () => null,
    };
    expect(marketingLastmod(probe, "/vs-discord")).toBe("2026-10-09");
    const copyCall = calls.find((c) => c.some((a) => a.startsWith("-G")))!;
    const pattern = copyCall.find((a) => a.startsWith("-G"))!.slice(2);
    // The regex matches that page's lines in a catalogue and nobody else's.
    expect(new RegExp(pattern).test(`  "vsDiscord.hero.title": "x",`)).toBe(true);
    expect(new RegExp(pattern).test(`  "tela.hero.title": "x",`)).toBe(false);
    expect(new RegExp(pattern).test(`  "vsDiscordish.x": "x",`)).toBe(false);
    expect(copyCall.slice(copyCall.indexOf("--") + 1)).toEqual([
      "src/locales/pt-BR/translation.json",
      "src/locales/en/translation.json",
      "src/locales/es/translation.json",
    ]);
    // The file's own newer date still wins over an older copy edit.
    const newerFile: Probe = {
      git: (args) =>
        args[0] === "rev-parse" ? "false" : args.some((a) => a.startsWith("-G")) ? "2026-09-01" : "2026-10-05",
      read: () => null,
    };
    expect(marketingLastmod(newerFile, "/vs-discord")).toBe("2026-10-05");
  });

  it("finds the real last catalogue edit of a page in this repository's history", () => {
    // Skipped where the clone is shallow (the generator itself then says nothing).
    const probe = realProbe(client);
    if (probe.git(["rev-parse", "--is-shallow-repository"]) !== "false") return;
    const copy = gitLastModified(probe, [], ["vsDiscord"]);
    expect(copy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("says nothing rather than guess: a shallow clone, no git, or an unknown page", () => {
    const shallow: Probe = {
      git: (args) => (args[0] === "rev-parse" ? "true" : "2026-10-16"),
      read: () => null,
    };
    expect(gitLastModified(shallow, ["src/pages/tela-page.tsx"])).toBeNull();
    expect(marketingLastmod(shallow, "/tela")).toBeNull();
    expect(marketingLastmod(NO_GIT, "/tela")).toBeNull();
    expect(marketingLastmod({ git: () => "false", read: () => null }, "/no-such-page")).toBeNull();
    // A date that is not a date is not a date.
    expect(
      gitLastModified({ git: (a) => (a[0] === "rev-parse" ? "false" : "yesterday"), read: () => null }, ["x"]),
    ).toBeNull();
  });
});

describe("the sitemap", () => {
  const pages = sitemapPages(() => "2026-10-01");
  const paths = pages.map((page) => page.path);
  const sitemap = renderSitemap(pages);

  it("is well-formed XML with one url per page", () => {
    const doc = parseXml(sitemap);
    expect(doc.getElementsByTagName("url")).toHaveLength(pages.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("lists every marketing page, the blog index, every guide and every release note", () => {
    for (const page of canonicalMarketingPages()) {
      expect(paths).toContain(page);
    }
    expect(paths).toContain("/blog");
    for (const article of ARTICLES) expect(paths).toContain(`/blog/${article.slug}`);
    for (const post of POSTS) expect(paths).toContain(`/blog/${post.slug}`);
    expect(sitemap).toContain("<loc>https://pqp.gg/</loc>");
  });

  it("leaves out app routes, profiles, communities, aliases and the machine files", () => {
    for (const path of paths) {
      expect(path, path).not.toMatch(/^\/(app|@|c\/|api|prerender|r\/)/);
      expect(path, path).not.toMatch(/\.(md|json|xml|txt)$/);
    }
    for (const alias of ["/claim", "/watchparty", "/criadores", "/contato"]) {
      expect(paths).not.toContain(alias);
    }
  });

  it("dates a blog page by its own content, never by the marketing callback", () => {
    for (const article of ARTICLES) {
      expect(pages.find((p) => p.path === `/blog/${article.slug}`)!.lastmod).toBe(article.updated);
    }
    for (const post of POSTS) {
      expect(pages.find((p) => p.path === `/blog/${post.slug}`)!.lastmod).toBe(post.date);
    }
    const newest = [...POSTS.map((p) => p.date), ...ARTICLES.map((a) => a.updated)].sort().at(-1);
    expect(pages.find((p) => p.path === "/blog")!.lastmod).toBe(newest);
  });

  it("omits lastmod when it cannot be known, and refuses one that is not a day", () => {
    const undated = renderSitemap(sitemapPages(() => null));
    expect(undated).toContain("<loc>https://pqp.gg/vs-discord</loc>\n    <priority>");
    const bad: SitemapPage = { path: "/x", lastmod: "soon", priority: 0.5, alternates: [] };
    expect(() => renderSitemap([bad])).toThrow(/invalid lastmod/);
  });

  it("declares the same language alternates as the page's own head", () => {
    for (const page of blogPages()) {
      const target = blogTargetFromMetaPath(page.path)!;
      const head = renderBlogHead(target, "pt-BR");
      const inHead = [...head.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)].map(
        (m) => ({ hreflang: m[1], href: m[2] }),
      );
      expect(pageAlternates(page), page.path).toEqual(inHead);
      expect(pages.find((p) => p.path === page.path)!.alternates).toEqual(inHead);
    }
  });

  it("declares Spanish only for the posts written in it, and the marketing set from marketing-meta", () => {
    const spanish = POSTS.filter((post) => post.title.es);
    expect(spanish.length).toBeGreaterThan(0);
    for (const post of POSTS) {
      const alts = pages.find((p) => p.path === `/blog/${post.slug}`)!.alternates;
      expect(alts.some((alt) => alt.hreflang === "es"), post.slug).toBe(Boolean(post.title.es));
    }
    for (const page of canonicalMarketingPages()) {
      expect(pages.find((p) => p.path === page)!.alternates).toEqual(
        marketingUrlsFor(page, "pt-BR").alternates,
      );
    }
  });

  it("writes every alternate as an xhtml:link, escaped", () => {
    const xml = renderSitemap([
      { path: "/a", lastmod: "2026-10-01", priority: 1, alternates: [{ hreflang: "en", href: "https://pqp.gg/a?x=1&lang=en" }] },
    ]);
    expect(xml).toContain(`hreflang="en" href="https://pqp.gg/a?x=1&amp;lang=en"`);
    parseXml(xml);
  });
});

describe("the release-note feeds", () => {
  const entry = (over: Partial<FeedEntry> = {}): FeedEntry => ({
    id: "https://pqp.gg/blog/a",
    title: "A & B <script>",
    link: "https://pqp.gg/blog/a",
    summary: `Fish & "chips" ]]> done`,
    contentHtml: `<p>hi <a href="/blog/b?x=1&y=2">b</a></p>\u0000`,
    date: "2026-09-27",
    ...over,
  });
  const options = {
    lang: "en",
    title: "T & T",
    subtitle: "s",
    selfUrl: "https://pqp.gg/feed.en.xml",
    siteUrl: "https://pqp.gg/blog",
    author: "A <b>",
  };

  it("escapes titles, summaries, content and the author, and is well-formed", () => {
    const xml = renderAtomFeed({ ...options, entries: [entry()] });
    const doc = parseXml(xml);
    expect(xml).not.toContain("<script>");
    expect(xml).not.toContain("\u0000");
    expect(doc.querySelector("entry > title")!.textContent).toBe("A & B <script>");
    expect(doc.querySelector("entry > summary")!.textContent).toBe(`Fish & "chips" ]]> done`);
    // The content is HTML carried as escaped text; decoded it is the HTML, made absolute.
    expect(doc.querySelector("entry > content")!.textContent).toBe(
      `<p>hi <a href="https://pqp.gg/blog/b?x=1&y=2">b</a></p>`,
    );
    expect(doc.querySelector("feed > author > name")!.textContent).toBe("A <b>");
  });

  it("orders newest first and dates the feed by its newest entry, at noon UTC", () => {
    const xml = renderAtomFeed({
      ...options,
      entries: [
        entry({ id: "https://pqp.gg/blog/old", date: "2026-09-03" }),
        entry({ id: "https://pqp.gg/blog/new", date: "2026-09-29" }),
        entry({ id: "https://pqp.gg/blog/mid", date: "2026-09-13" }),
      ],
    });
    const doc = parseXml(xml);
    expect([...doc.querySelectorAll("entry > id")].map((n) => n.textContent)).toEqual([
      "https://pqp.gg/blog/new",
      "https://pqp.gg/blog/mid",
      "https://pqp.gg/blog/old",
    ]);
    expect(doc.querySelector("feed > updated")!.textContent).toBe("2026-09-29T12:00:00Z");
    expect(doc.querySelector("entry > published")!.textContent).toBe("2026-09-29T12:00:00Z");
  });

  it("refuses an entry whose date is not a day", () => {
    expect(() => renderAtomFeed({ ...options, entries: [entry({ date: "2026-09-31" })] })).toThrow();
  });

  for (const locale of ["pt-BR", "en"] as const) {
    it(`builds the real ${locale} feed: every note, in its language, with absolute links`, () => {
      const xml = releaseNoteFeed(locale, (slug, l) => body(slug, l), renderMarkdownToHtml);
      const doc = parseXml(xml);
      expect(doc.documentElement.getAttribute("xml:lang")).toBe(locale);
      const ids = [...doc.querySelectorAll("entry > id")].map((n) => n.textContent);
      expect(ids).toHaveLength(POSTS.length);
      expect(new Set(ids).size).toBe(POSTS.length);
      expect(doc.querySelector('feed > link[rel="self"]')!.getAttribute("href")).toBe(
        `https://pqp.gg${FEEDS[locale].path}`,
      );
      const first = POSTS[0]!;
      expect(doc.querySelector("entry > title")!.textContent).toBe(first.title[locale]);
      expect(doc.querySelector("entry > summary")!.textContent).toBe(first.summary[locale]);
      expect(doc.querySelector("feed > updated")!.textContent).toBe(`${first.date}T12:00:00Z`);
      const twin = doc.querySelector('entry > link[type="text/markdown"]')!.getAttribute("href");
      expect(twin).toBe(
        locale === "pt-BR"
          ? `https://pqp.gg/blog/${first.slug}.md`
          : `https://pqp.gg/blog/${first.slug}.en.md`,
      );
      // Pictures in a note are site-relative in the markdown; a feed reader needs them absolute.
      expect(xml).not.toMatch(/src=&quot;\/(?!\/)/);
      expect(xml).toContain("https://pqp.gg/blog/automod-e-esconder-o-chat/automod-lista.webp");
      expect(xml).not.toContain("—");
    });
  }

  it("fails the build when a note has no body", () => {
    expect(() => releaseNoteFeed("en", () => null, renderMarkdownToHtml)).toThrow(/has no en body/);
  });

  const xmllint = spawnSync("xmllint", ["--version"]).error === undefined;
  it.skipIf(!xmllint)("passes xmllint when it is installed", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pqp-xml-"));
    const files: Record<string, string> = {
      "sitemap.xml": renderSitemap(sitemapPages(() => "2026-10-01")),
      "feed.xml": releaseNoteFeed("pt-BR", body, renderMarkdownToHtml),
      "feed.en.xml": releaseNoteFeed("en", body, renderMarkdownToHtml),
    };
    for (const [name, xml] of Object.entries(files)) {
      const file = path.join(dir, name);
      writeFileSync(file, xml);
      const result = spawnSync("xmllint", ["--noout", file], { encoding: "utf8" });
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
    }
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { onRequest } from "../../functions/_middleware";
import { ARTICLES, articleFaq } from "./blog/articles";
import { POSTS } from "./blog/posts";
import { injectBlogHead, blogTargetFromMetaPath } from "./blog-meta";
import { markdownTwinFor } from "./markdown-negotiation";
import { PRERENDERED_MARKETING_PAGES, marketingMain } from "./marketing-prerender";
import {
  blogPages,
  fragmentPath,
  markdownTwinPath,
  pageLocaleFor,
  registeredBlogPage,
} from "./page-registry";
import {
  absolutizeMarkdown,
  assertMarketingBodies,
  assertStaticBodies,
  buildBlogStaticFiles,
  MIN_STATIC_BODY_CHARS,
  renderMarkdownToHtml,
  visibleText,
  type Fragment,
  type StaticSources,
} from "./static-pages";

const here = path.dirname(fileURLToPath(import.meta.url));
const client = path.resolve(here, "../..");

function read(file: string): string | null {
  try {
    return readFileSync(path.resolve(client, file), "utf8");
  } catch {
    return null;
  }
}

const sources: StaticSources = {
  body: (slug, locale) => read(`src/content/blog/${slug}.${locale}.md`),
  catalogue: (locale) => ({
    ...JSON.parse(read("src/locales/en/translation.json")!),
    ...JSON.parse(read(`src/locales/${locale}/translation.json`)!),
  }),
};

const files = buildBlogStaticFiles(sources);
const byPath = new Map(files.map((file) => [file.path, file.content]));
const fragment = (p: string) => JSON.parse(byPath.get(p)!) as Fragment;

describe("the blog's static bodies", () => {
  it("writes a fragment and a markdown twin for every page in every language it has", () => {
    let expected = 0;
    for (const page of blogPages()) {
      for (const locale of page.locales) {
        expected += 1;
        expect(byPath.has(fragmentPath(page, locale)), fragmentPath(page, locale)).toBe(true);
        expect(byPath.has(markdownTwinPath(page, locale).slice(1))).toBe(true);
      }
    }
    expect(files).toHaveLength(expected * 2);
    // 6 guides + the posts + the index, and a Spanish post is a third language.
    expect(blogPages()).toHaveLength(1 + ARTICLES.length + POSTS.length);
  });

  it("puts real prose, a heading and a link on every page", () => {
    for (const page of blogPages()) {
      for (const locale of page.locales) {
        const f = fragment(fragmentPath(page, locale));
        expect(f.lang).toBe(locale);
        expect(visibleText(f.html).length, page.path + locale).toBeGreaterThanOrEqual(
          MIN_STATIC_BODY_CHARS,
        );
        expect(f.html).toMatch(/<h1[ >]/);
        expect(f.html).toMatch(/<a [^>]*href="\/[^"]+"/);
      }
    }
  });

  it("carries the first sentence of the prose, not just the head", () => {
    const body = sources.body("pqp-vs-discord-2026", "pt-BR")!;
    const first = body.split("\n")[0]!.slice(0, 40);
    const html = fragment("prerender/blog/pqp-vs-discord-2026.pt-BR.json").html;
    expect(visibleText(html)).toContain(first);
  });

  it("renders a markdown table as a table", () => {
    const html = fragment("prerender/blog/pqp-vs-discord-2026.en.json").html;
    expect(html).toContain("<table>");
    expect(html).toContain("<th>");
  });

  it("renders every FAQ question of a guide, asked the way the JSON-LD asks it", () => {
    for (const article of ARTICLES) {
      for (const locale of article.locales) {
        const html = fragment(fragmentPath({ path: `/blog/${article.slug}` }, locale)).html;
        const text = visibleText(html);
        for (const item of articleFaq(article, locale === "pt-BR" ? "pt-BR" : "en")) {
          // The text is HTML-escaped once; compare on the decoded form.
          const decoded = text.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
          expect(decoded, `${article.slug} ${item.question}`).toContain(item.question);
        }
      }
    }
  });

  it("dates a release note by its day and a guide by its update", () => {
    const post = POSTS[0]!;
    const html = fragment(fragmentPath({ path: `/blog/${post.slug}` }, "pt-BR")).html;
    expect(html).toContain(`<time datetime="${post.date}">`);
    const article = ARTICLES[0]!;
    const g = fragment(fragmentPath({ path: `/blog/${article.slug}` }, "pt-BR")).html;
    expect(g).toContain(`<time datetime="${article.updated}">`);
  });

  it("keeps the three languages apart: Spanish only where a post was written in it", () => {
    const spanish = POSTS.filter((post) => post.title.es);
    expect(spanish.length).toBeGreaterThan(0);
    for (const post of spanish) {
      expect(byPath.has(`prerender/blog/${post.slug}.es.json`)).toBe(true);
    }
    for (const post of POSTS.filter((p) => !p.title.es)) {
      expect(byPath.has(`prerender/blog/${post.slug}.es.json`)).toBe(false);
    }
    for (const article of ARTICLES) {
      expect(byPath.has(`prerender/blog/${article.slug}.es.json`)).toBe(false);
      expect(byPath.has(`prerender/blog/${article.slug}.en.json`)).toBe(
        article.locales.includes("en"),
      );
    }
  });

  it("lists every guide and release note, as links, on the index", () => {
    const html = fragment("prerender/blog/index.pt-BR.json").html;
    for (const page of blogPages()) {
      if (page.kind !== "blog-index") {
        expect(html, page.path).toContain(`href="${page.path}"`);
      }
    }
  });

  it("does not let prose inject markup", () => {
    const html = renderMarkdownToHtml("hello <script>alert(1)</script> **bold** & more");
    expect(html).not.toContain("<script");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("&amp;");
  });

  it("makes a twin's own links absolute, so it reads away from the site", () => {
    expect(absolutizeMarkdown("see [the guide](/blog/x) and ![a](/blog/x/a.webp)")).toBe(
      "see [the guide](https://pqp.gg/blog/x) and ![a](https://pqp.gg/blog/x/a.webp)",
    );
    expect(absolutizeMarkdown("[ext](https://example.com/a)")).toBe("[ext](https://example.com/a)");
    const twin = byPath.get("blog/pqp-vs-discord-2026.md")!;
    expect(twin).toContain("Canonical: https://pqp.gg/blog/pqp-vs-discord-2026");
    expect(twin).not.toMatch(/\]\(\/[a-z]/);
  });

  it("writes no em dash anywhere it generates", () => {
    for (const file of files) {
      expect(file.content, file.path).not.toContain("—");
    }
  });
});

describe("the build check", () => {
  it("fails when a page has no prose", () => {
    expect(() =>
      buildBlogStaticFiles({ ...sources, body: () => null }),
    ).toThrow(/has no pt-BR body/);
    expect(() =>
      buildBlogStaticFiles({ ...sources, body: () => "   \n" }),
    ).toThrow(/has no pt-BR body/);
  });

  it("fails when a body is too thin to be one", () => {
    expect(() =>
      assertStaticBodies([
        {
          path: "prerender/blog/x.pt-BR.json",
          content: JSON.stringify({ lang: "pt-BR", html: `<main><h1>x</h1><a href="/blog">b</a></main>` }),
        },
      ]),
    ).toThrow(/visible characters/);
  });

  it("fails when a page has no heading or no way out", () => {
    const long = "palavra ".repeat(60);
    expect(() =>
      assertStaticBodies([
        {
          path: "prerender/blog/x.pt-BR.json",
          content: JSON.stringify({ lang: "pt-BR", html: `<main><p>${long}</p></main>` }),
        },
      ]),
    ).toThrow(/no <h1>[\s\S]*no internal link/);
  });

  it("holds every marketing page that has a no-JS body to the same bar", () => {
    expect(PRERENDERED_MARKETING_PAGES.length).toBeGreaterThanOrEqual(5);
    expect(() => assertMarketingBodies()).not.toThrow();
    for (const page of PRERENDERED_MARKETING_PAGES) {
      expect(marketingMain(page, "en"), page).not.toBeNull();
    }
  });
});

describe("the registry and the edge agree", () => {
  it("names the twin the head links to", () => {
    const page = blogPages().find((p) => p.kind === "article")!;
    const html = injectBlogHead(
      `<html lang="en"><head></head><body></body></html>`,
      blogTargetFromMetaPath(page.path)!,
      "pt-BR",
    );
    expect(html).toContain(
      `<link rel="alternate" type="text/markdown" href="https://pqp.gg${page.path}.md" />`,
    );
    // No hreflang on it: it is not a language alternate of the page.
    expect(html).not.toMatch(/type="text\/markdown"[^>]*hreflang/);
  });

  it("links the English twin to an English reader and falls back where a body is missing", () => {
    const withEn = ARTICLES.find((a) => a.locales.includes("en"))!;
    const portugueseOnly = ARTICLES.find((a) => !a.locales.includes("en"))!;
    expect(markdownTwinFor(`/blog/${withEn.slug}`, "en")).toBe(`/blog/${withEn.slug}.en.md`);
    expect(markdownTwinFor(`/blog/${withEn.slug}`, "es")).toBe(`/blog/${withEn.slug}.en.md`);
    expect(markdownTwinFor(`/blog/${portugueseOnly.slug}`, "en")).toBe(
      `/blog/${portugueseOnly.slug}.md`,
    );
    expect(markdownTwinFor("/blog", "pt-BR")).toBe("/blog.md");
    expect(markdownTwinFor("/blog/nao-existe")).toBeNull();
    const spanish = POSTS.find((p) => p.title.es)!;
    expect(markdownTwinFor(`/blog/${spanish.slug}`, "es")).toBe(`/blog/${spanish.slug}.es.md`);
    expect(pageLocaleFor(registeredBlogPage(`/blog/${spanish.slug}`)!, "es")).toBe("es");
  });

  it("keeps the browser-only renderer out of everything the edge imports", () => {
    for (const file of [
      "src/lib/page-registry.ts",
      "src/lib/markdown-negotiation.ts",
      "src/lib/marketing-prerender.ts",
      "src/lib/blog-meta.ts",
      "functions/_middleware.ts",
    ]) {
      const source = read(file)!;
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      expect(imports.join(" "), file).not.toMatch(/static-pages|react-dom|react-markdown|remark/);
    }
  });
});

describe("the middleware", () => {
  const SHELL = readFileSync(path.resolve(client, "index.html"), "utf8");

  function ctx(pathAndQuery: string, headers: Record<string, string> = {}, withAssets = true) {
    return {
      request: new Request(`https://pqp.gg${pathAndQuery}`, { headers }),
      env: withAssets
        ? {
            ASSETS: {
              fetch: async (input: string | URL | Request) => {
                const key = new URL(new Request(input).url).pathname.slice(1);
                const content = byPath.get(key);
                return content === undefined
                  ? new Response("nope", { status: 404 })
                  : new Response(content, {
                      headers: {
                        "content-type": key.endsWith(".json")
                          ? "application/json"
                          : "text/markdown; charset=utf-8",
                      },
                    });
              },
            },
          }
        : {},
      next: async () =>
        new Response(SHELL, { headers: { "content-type": "text/html; charset=utf-8" } }),
    };
  }

  it("writes a guide's words into #root, in the language asked for, with its head", async () => {
    const pt = await (await onRequest(ctx("/blog/pqp-vs-discord-2026"))).text();
    expect(pt).toContain('<div id="root"><div id="pre-page" lang="pt-BR"');
    expect(pt).toContain("<h1");
    expect(pt).toContain("alternativa de código aberto ao Discord");
    expect(pt.match(/<h1/g)).toHaveLength(1);
    expect(pt).toContain('<link rel="canonical" href="https://pqp.gg/blog/pqp-vs-discord-2026" />');
    // Written once, and the home hero is not left behind it.
    expect(pt.match(/id="pre-page"/g)).toHaveLength(1);
    expect(pt).not.toContain("pre-hero");

    const en = await (await onRequest(ctx("/blog/pqp-vs-discord-2026?lang=en"))).text();
    expect(en).toContain('<div id="pre-page" lang="en"');
    expect(en).toContain("honest comparison");
  });

  it("serves a Portuguese-only guide to an English reader in Portuguese, saying so", async () => {
    const guide = ARTICLES.find((a) => !a.locales.includes("en"))!;
    const body = await (await onRequest(ctx(`/blog/${guide.slug}?lang=en`))).text();
    expect(body).toContain('<div id="pre-page" lang="pt-BR"');
  });

  it("gives a Spanish reader the Spanish body only where there is one", async () => {
    const spanish = POSTS.find((p) => p.title.es)!;
    const es = await (await onRequest(ctx(`/blog/${spanish.slug}?lang=es`))).text();
    expect(es).toContain('<div id="pre-page" lang="es"');
    const other = POSTS.find((p) => !p.title.es)!;
    const fallback = await (await onRequest(ctx(`/blog/${other.slug}?lang=es`))).text();
    expect(fallback).toContain('<div id="pre-page" lang="en"');
  });

  it("writes the index with every page linked", async () => {
    const body = await (await onRequest(ctx("/blog"))).text();
    expect(body).toContain('<div id="pre-page"');
    for (const page of blogPages()) {
      if (page.kind !== "blog-index") {
        expect(body, page.path).toContain(`href="${page.path}"`);
      }
    }
  });

  it("never lets the optional nav lookup slow or fail a blog page", async () => {
    // The communities lookup behind the nav's optional links goes to the API.
    // One that never answers must cost the page at most the short bound, and
    // one that throws must cost it nothing: the body is written either way.
    const never = vi.fn(() => new Promise<Response>(() => undefined));
    const boom = vi.fn(() => Promise.reject(new Error("network")));
    for (const stub of [never, boom]) {
      vi.stubGlobal("fetch", stub);
      try {
        const c = ctx("/blog/pqp-vs-discord-2026?lang=en");
        const started = Date.now();
        const res = await onRequest({
          ...c,
          env: { ...c.env, PQP_API_URL: "https://api.example.test" },
        });
        const body = await res.text();
        expect(res.status).toBe(200);
        expect(body).toContain('<div id="pre-page" lang="en"');
        expect(Date.now() - started).toBeLessThan(2500);
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it("serves the page as it was when the fragment is not there", async () => {
    const body = await (await onRequest(ctx("/blog/pqp-vs-discord-2026", {}, false))).text();
    expect(body).not.toContain('id="pre-page"');
    expect(body).toContain('<link rel="canonical" href="https://pqp.gg/blog/pqp-vs-discord-2026" />');
  });

  it("answers Accept: text/markdown with the twin in the reader's language", async () => {
    const res = await onRequest(
      ctx("/blog/pqp-vs-discord-2026", { accept: "text/markdown", "accept-language": "en-US,en;q=0.9" }),
    );
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("vary")).toContain("accept-language");
    const text = await res.text();
    expect(text.startsWith("# pqp vs Discord in 2026")).toBe(true);
    expect(text).toContain("Language: en");
  });

  it("does not hand a browser markdown", async () => {
    const res = await onRequest(
      ctx("/blog/pqp-vs-discord-2026", { accept: "text/html,application/xhtml+xml,*/*;q=0.8" }),
    );
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});

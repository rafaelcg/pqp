// The REAL shipped document, the same way `marketing-meta.test.ts` gets it.
import INDEX_HTML from "../../index.html?raw";
import { describe, expect, it } from "vitest";
import {
  blogTargetFromMetaPath,
  injectBlogHead,
  renderBlogHead,
} from "./blog-meta";
import { POSTS } from "./blog/posts";
import { loadPostBody } from "./blog/bodies";
import en from "../locales/en/translation.json";
import ptBR from "../locales/pt-BR/translation.json";

/**
 * The blog half of the Pages middleware, plus the post index behind it.
 *
 * Same shape and same reasoning as `marketing-meta.test.ts`: the middleware
 * cannot run outside wrangler, so what is tested is everything that could
 * actually be wrong without it. The path parser that decides whether the
 * middleware acts, the rewrite against the real `index.html`, the duplicated
 * index copy, and the invariants of `POSTS` that a page silently depends on.
 */

describe("blogTargetFromMetaPath", () => {
  it("recognises the index, with or without a trailing slash", () => {
    expect(blogTargetFromMetaPath("/blog")).toEqual({ kind: "index" });
    expect(blogTargetFromMetaPath("/blog/")).toEqual({ kind: "index" });
  });

  it("recognises every published post", () => {
    for (const post of POSTS) {
      expect(blogTargetFromMetaPath(`/blog/${post.slug}`)).toEqual({
        kind: "post",
        post,
      });
    }
  });

  it("answers null for a slug that does not exist", () => {
    // Not a post-shaped head for a page that will render "not found": the
    // unfurl would advertise a headline nobody can read.
    expect(blogTargetFromMetaPath("/blog/nao-existe")).toBeNull();
    expect(blogTargetFromMetaPath("/blog/beta-no-iphone/extra")).toBeNull();
  });

  it("keeps its hands off every other path", () => {
    // This runs in front of every request the site serves. A prefix match that
    // was slightly too eager would rewrite a hashed asset into HTML.
    for (const path of [
      "/",
      "/tela",
      "/blogue",
      "/blogging",
      "/assets/index-abc123.js",
      "/@rafa",
      "/c/valorant",
      "/api/health",
    ]) {
      expect(blogTargetFromMetaPath(path)).toBeNull();
    }
  });
});

describe("renderBlogHead", () => {
  it("writes an article card with a date for a post", () => {
    const post = POSTS[0]!;
    const head = renderBlogHead({ kind: "post", post }, "pt-BR");
    expect(head).toContain(`<title>${post.title["pt-BR"]} · pqp</title>`);
    expect(head).toContain(
      `<link rel="canonical" href="https://pqp.gg/blog/${post.slug}" />`,
    );
    expect(head).toContain('<meta property="og:type" content="article" />');
    expect(head).toContain(
      `<meta property="article:published_time" content="${post.date}" />`,
    );
  });

  it("writes a website card with no article tags for the index", () => {
    const head = renderBlogHead({ kind: "index" }, "en");
    expect(head).toContain('<meta property="og:type" content="website" />');
    expect(head).not.toContain("article:published_time");
    expect(head).toContain('<link rel="canonical" href="https://pqp.gg/blog" />');
  });

  it("emits JSON-LD that parses, with the right type on each surface", () => {
    const read = (head: string) => {
      const match = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(
        head,
      );
      expect(match).not.toBeNull();
      return JSON.parse(match![1]!) as Record<string, unknown>;
    };

    const index = read(renderBlogHead({ kind: "index" }, "pt-BR"));
    expect(index["@type"]).toBe("Blog");
    expect((index.blogPost as unknown[]).length).toBe(POSTS.length);

    const post = read(
      renderBlogHead({ kind: "post", post: POSTS[0]! }, "pt-BR"),
    );
    expect(post["@type"]).toBe("BlogPosting");
    expect(post.datePublished).toBe(POSTS[0]!.date);
  });

  it("escapes copy rather than trusting it", () => {
    const head = renderBlogHead(
      {
        kind: "post",
        post: {
          slug: "x",
          date: "2026-01-01",
          title: { "pt-BR": '"</title><script>', en: "x" },
          summary: { "pt-BR": "y", en: "y" },
        },
      },
      "pt-BR",
    );
    expect(head).not.toContain("<script>a");
    expect(head).toContain("&lt;script&gt;");
  });
});

describe("injectBlogHead", () => {
  it("leaves exactly one title on the real index.html", () => {
    const out = injectBlogHead(INDEX_HTML, { kind: "index" }, "pt-BR");
    expect(out.match(/<title>/g)).toHaveLength(1);
    expect(out.match(/rel="canonical"/g)).toHaveLength(1);
  });

  it("corrects the document language for a Portuguese head", () => {
    const out = injectBlogHead(INDEX_HTML, { kind: "index" }, "pt-BR");
    expect(out).toContain('<html lang="pt-BR">');
    expect(injectBlogHead(INDEX_HTML, { kind: "index" }, "en")).toContain(
      '<html lang="en">',
    );
  });

  it("returns the document untouched when it has no head", () => {
    // Every failure path in this feature serves a working page.
    const html = "<p>no head here</p>";
    expect(injectBlogHead(html, { kind: "index" }, "en")).toBe(html);
  });
});

describe("index copy stays in step with the JSON catalogues", () => {
  // `blog-meta.ts` cannot import the JSON catalogues (it is bundled for the edge by
  // an esbuild run outside the workspace), so its strings are duplicates. This
  // is what stops the duplication drifting.
  it("matches English", () => {
    const head = renderBlogHead({ kind: "index" }, "en");
    expect(head).toContain(`<title>${en["blog.seo.title"]}</title>`);
    expect(head).toContain(
      `<meta name="description" content="${en["blog.seo.description"]}" />`,
    );
  });

  it("matches Portuguese", () => {
    const head = renderBlogHead({ kind: "index" }, "pt-BR");
    expect(head).toContain(`<title>${ptBR["blog.seo.title"]}</title>`);
    expect(head).toContain(
      `<meta name="description" content="${ptBR["blog.seo.description"]}" />`,
    );
  });
});

describe("the edge import graph", () => {
  // The bug this pins: wrangler bundles the Pages middleware with esbuild, not
  // Vite, and esbuild has no loader for `.md`. A `?raw` import anywhere in the
  // middleware's graph fails the deploy even inside a dynamic import the edge
  // would never run, because the bundler still parses it. CI builds the client
  // and never bundles the functions, so it went green and production did not.
  it("keeps markdown out of what the middleware imports", async () => {
    const posts = await import("./blog/posts?raw").then((m) => m.default);
    expect(posts).not.toContain(".md?raw");
    const meta = await import("./blog-meta?raw").then((m) => m.default);
    expect(meta).not.toContain(".md?raw");
    expect(meta).not.toContain("blog/bodies");
  });
});

describe("POSTS", () => {
  it("has unique slugs that are URL safe", () => {
    const slugs = POSTS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it("is ordered newest first", () => {
    // Nothing sorts at runtime, so a mistyped year would move a post rather
    // than fail anything. This is the thing that fails instead.
    const dates = POSTS.map((p) => p.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("carries a real date and both languages on every post", () => {
    for (const post of POSTS) {
      expect(post.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(post.date))).toBe(false);
      for (const locale of ["pt-BR", "en"] as const) {
        expect(post.title[locale].trim().length).toBeGreaterThan(0);
        expect(post.summary[locale].trim().length).toBeGreaterThan(0);
        // The summary is the meta description too; past about 160 characters
        // search results truncate it mid-sentence.
        expect(post.summary[locale].length).toBeLessThanOrEqual(200);
      }
    }
  });

  it("can load a body for every post in both languages", () => {
    // A post in the index with no importer renders an empty page, and nothing
    // else in the suite would notice.
    return Promise.all(
      POSTS.flatMap((post) =>
        (["pt-BR", "en"] as const).map(async (locale) => {
          const body = await loadPostBody(post.slug, locale);
          expect(body, `${post.slug} ${locale}`).toBeTruthy();
          expect(body!.length).toBeGreaterThan(200);
        }),
      ),
    );
  });

  it("has no em dashes in any post body", () => {
    // Project copy rule, and the one thing a reviewer reliably misses.
    return Promise.all(
      POSTS.flatMap((post) =>
        (["pt-BR", "en"] as const).map(async (locale) => {
          const body = await loadPostBody(post.slug, locale);
          expect(body, `${post.slug} ${locale}`).not.toContain("—");
        }),
      ),
    );
  });

  it("answers null for an unknown slug instead of throwing", async () => {
    expect(await loadPostBody("nao-existe", "pt-BR")).toBeNull();
  });
});

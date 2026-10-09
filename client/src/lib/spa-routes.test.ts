import { describe, expect, it } from "vitest";
import mainSource from "../main.tsx?raw";
import { POSTS as BLOG_POSTS } from "./blog/posts";
import { isUnknownSpaPath } from "./spa-routes";

/**
 * The edge answers a real 404 for a path the SPA has no route for. That is only
 * safe while the list of known paths agrees with the router, so this test reads
 * the router: a `<Route path>` added to `main.tsx` without `spa-routes.ts`
 * learning about it fails here, before it can ship as a page that renders and
 * silently drops out of search.
 */

function routePaths(): string[] {
  return [...mainSource.matchAll(/<Route[^>]*?\bpath="([^"]+)"/gs)].map(
    (m) => m[1]!,
  );
}

/** A concrete address for a route pattern. */
function sample(pattern: string): string | null {
  if (pattern === "*") return null; // the catch-all IS "unknown"
  if (pattern === "/:handleSegment") return "/@abc";
  if (pattern === "/blog/:slug") return `/blog/${BLOG_POSTS[0]!.slug}`;
  return pattern.replace(/\/\*$/, "/x").replace(/:[A-Za-z]+/g, "abc");
}

describe("isUnknownSpaPath", () => {
  it("found the routes to check", () => {
    // A regex that silently matched nothing would make the next test vacuous.
    expect(routePaths().length).toBeGreaterThan(20);
  });

  it("recognises every route main.tsx declares", () => {
    const missed: string[] = [];
    for (const pattern of routePaths()) {
      const path = sample(pattern);
      if (path && isUnknownSpaPath(path)) {
        missed.push(`${pattern} (${path})`);
      }
    }
    expect(missed).toEqual([]);
  });

  it("recognises the paths the edge and the redirects file own", () => {
    for (const path of [
      "/",
      "/vem",
      "/watch-party",
      "/streamers",
      "/criadores",
      "/contact",
      "/contato",
      "/vem/gratis",
      "/claim",
      "/app",
      "/app/server/123/channel/456",
      "/app/invite/abc",
      "/c/valorant",
      "/@rafa",
      "/r/x",
      "/index.html",
      "/health",
      "/up",
      "/privacy/",
    ]) {
      expect(isUnknownSpaPath(path), path).toBe(false);
    }
  });

  it("calls a real post known and an invented slug unknown", () => {
    expect(isUnknownSpaPath(`/blog/${BLOG_POSTS[0]!.slug}`)).toBe(false);
    expect(isUnknownSpaPath("/blog")).toBe(false);
    expect(isUnknownSpaPath("/blog/nao-existe")).toBe(true);
  });

  it("calls addresses nothing serves unknown", () => {
    for (const path of [
      "/nao-existe",
      "/en",
      "/es",
      "/pt-BR",
      "/favicon.png",
      "/c",
      "/c/a/b",
      "/@a/b",
      "/qa",
      "/vem/extra",
    ]) {
      expect(isUnknownSpaPath(path), path).toBe(true);
    }
  });
});

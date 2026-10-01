import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { onRequest } from "../../functions/_middleware";
import {
  injectPrerenderHero,
  PRERENDER_LOCALES,
  renderPrerenderHero,
} from "./prerender-hero";

/**
 * The prerendered landing hero is in `index.html`, which is one file for every
 * path. A reader that does not run JavaScript must get it on `/` and on no
 * other page, or the home hero becomes the body of `/vs-discord` and every
 * profile. The middleware is what removes it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogues = Object.fromEntries(
  PRERENDER_LOCALES.map((locale) => [
    locale,
    JSON.parse(
      readFileSync(path.resolve(here, `../locales/${locale}/translation.json`), "utf8"),
    ),
  ]),
) as Parameters<typeof renderPrerenderHero>[0];

const BUILT = injectPrerenderHero(
  readFileSync(path.resolve(here, "../../index.html"), "utf8"),
  renderPrerenderHero(catalogues),
);

function ctx(pathAndQuery: string, status = 200, method = "GET") {
  return {
    request: new Request(`https://pqp.gg${pathAndQuery}`, { method }),
    env: {},
    next: async () =>
      new Response(BUILT, {
        status,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  };
}

describe("the prerendered hero at the edge", () => {
  it("is kept on the home page, in every language", async () => {
    for (const query of ["/", "/?lang=pt-BR", "/?lang=es"]) {
      const body = await (await onRequest(ctx(query))).text();
      expect(body, query).toContain('id="pre-hero"');
      expect(body.match(/<h1/g), query).toHaveLength(3);
    }
  });

  it("is removed from every other page, so a no-JS reader gets an empty body", async () => {
    for (const p of [
      "/vs-discord",
      "/privacy",
      "/download",
      "/blog",
      "/@x",
      "/c/valorant",
      "/app",
      "/apoie",
      "/nao-existe",
      "/app/invite/abc",
    ]) {
      const res = await onRequest(ctx(p));
      const body = await res.text();
      expect(body, p).not.toContain("pre-hero");
      expect(body, p).not.toContain("<h1");
      expect(body, p).toContain('<div id="root"></div>');
    }
  });

  it("keeps the status and drops the stale content length", async () => {
    const res = await onRequest(ctx("/@x", 404));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-length")).toBeNull();
  });

  it("does not touch anything that is not an HTML GET", async () => {
    const res = await onRequest({
      request: new Request("https://pqp.gg/api/x"),
      env: {},
      next: async () =>
        new Response("{}", { headers: { "content-type": "application/json" } }),
    });
    expect(await res.text()).toBe("{}");
  });
});

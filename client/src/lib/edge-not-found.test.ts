import { describe, expect, it } from "vitest";
import { onRequest } from "../../functions/_middleware";

/**
 * The middleware's answer for addresses the SPA has no route for: a real 404
 * with `noindex`, body kept so a person still lands on the app. Everything
 * that is not "the shell answering for nothing" must pass through untouched.
 */

const SHELL =
  '<!doctype html><html lang="en"><head><title>x</title></head><body><div id="root"></div></body></html>';

function ctx(path: string, next: () => Response, method = "GET") {
  return {
    request: new Request(`https://pqp.gg${path}`, { method }),
    env: {},
    next: async () => next(),
  };
}

const html = () =>
  new Response(SHELL, { headers: { "content-type": "text/html; charset=utf-8" } });

describe("edge 404 for unknown paths", () => {
  it("turns the shell's 200 into a 404 with noindex, keeping the body", async () => {
    const res = await onRequest(ctx("/nao-existe", html));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain('<div id="root">');
  });

  it("does the same for an unknown blog slug and a guessed locale path", async () => {
    expect((await onRequest(ctx("/blog/nao-existe", html))).status).toBe(404);
    expect((await onRequest(ctx("/en", html))).status).toBe(404);
  });

  it("leaves real routes alone", async () => {
    for (const path of ["/app", "/app/server/1", "/c/valorant", "/@rafa", "/health", "/r/x"]) {
      const res = await onRequest(ctx(path, html));
      expect(res.status, path).toBe(200);
    }
  });

  it("rewrites the head of a marketing page and keeps it 200", async () => {
    const res = await onRequest(ctx("/?lang=en", html));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<link rel="canonical" href="https://pqp.gg/?lang=en" />');
    expect(res.headers.get("x-robots-tag")).toBeNull();
  });

  it("never touches a file that exists (not HTML) or a non-GET", async () => {
    const png = () => new Response("png", { headers: { "content-type": "image/png" } });
    expect((await onRequest(ctx("/images/whatever.png", png))).status).toBe(200);
    expect((await onRequest(ctx("/nao-existe", html, "POST"))).status).toBe(200);
  });

  it("passes a non-ok answer through as it is", async () => {
    const res = await onRequest(
      ctx("/nao-existe", () => new Response("no", { status: 500, headers: { "content-type": "text/html" } })),
    );
    expect(res.status).toBe(500);
  });
});

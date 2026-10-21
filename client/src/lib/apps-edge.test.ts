import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPS_COPY } from "./apps-meta";

/**
 * The Pages middleware on the pqp Apps paths. The flag decides everything:
 * off is a real redirect home, on is the page's own head in the visitor's
 * language, and "could not tell" serves the document untouched and leaves the
 * decision to the browser (which asks the same question). Each test imports a
 * fresh module, because the middleware remembers the answer per isolate.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(path.resolve(here, "../../index.html"), "utf8");

function ctx(pathname: string, headers: Record<string, string> = {}, method = "GET") {
  return {
    request: new Request(`https://pqp.gg${pathname}`, { method, headers }),
    env: {
      ASSETS: {
        fetch: async () =>
          new Response(JSON.stringify({ apiUrl: "https://api.test" }), {
            headers: { "content-type": "application/json" },
          }),
      },
    },
    next: async () => new Response(INDEX, { headers: { "content-type": "text/html" } }),
  };
}

async function freshMiddleware() {
  vi.resetModules();
  return (await import("../../functions/_middleware")).onRequest;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const PATHS = ["/apps", "/apps/locadora", "/locadora"];

describe("the Apps pages at the edge, flag off", () => {
  it.each(PATHS)("%s is a 302 to / with no body", async (pathname) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ enabled: false })));
    const onRequest = await freshMiddleware();
    const response = await onRequest(ctx(pathname));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("asks the public config, with no credential", async () => {
    const fetchMock = vi.fn(async () => Response.json({ enabled: false }));
    vi.stubGlobal("fetch", fetchMock);
    const onRequest = await freshMiddleware();
    await onRequest(ctx("/apps", { authorization: "Bearer nope", cookie: "a=b" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/api/public/apps/config",
      expect.anything(),
    );
    expect(JSON.stringify(fetchMock.mock.calls[0])).not.toMatch(/authorization|cookie/i);
  });

  it("a HEAD is answered as the GET is", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ enabled: false })));
    const onRequest = await freshMiddleware();
    const response = await onRequest(ctx("/apps", {}, "HEAD"));
    expect(response.status).toBe(302);
  });
});

describe("the Apps pages at the edge, flag on", () => {
  it.each([
    ["/apps", "apps"],
    ["/apps/locadora", "locadora"],
    ["/locadora", "locadora"],
  ] as const)("%s gets its own head, canonical to the long address", async (pathname, page) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ enabled: true })));
    const onRequest = await freshMiddleware();
    const response = await onRequest(ctx(pathname, { "accept-language": "en-US,en;q=0.9" }));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<title>${APPS_COPY[page].title.en}</title>`);
    const canonical = page === "apps" ? "https://pqp.gg/apps?lang=en" : "https://pqp.gg/apps/locadora?lang=en";
    expect(html).toContain(`<link rel="canonical" href="${canonical}" />`);
    expect(html).toContain("og:image");
    expect(html).toContain("hreflang=\"es\"");
    expect((html.match(/<title>/g) ?? []).length).toBe(1);
    expect(response.headers.get("vary")).toContain("accept-language");
  });

  it("speaks the visitor's language: Portuguese by default, Spanish and English when asked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ enabled: true })));
    const onRequest = await freshMiddleware();
    expect(await (await onRequest(ctx("/apps"))).text()).toContain(
      `<title>${APPS_COPY.apps.title["pt-BR"]}</title>`,
    );
    expect(await (await onRequest(ctx("/apps", { "accept-language": "es-AR" }))).text()).toContain(
      `<title>${APPS_COPY.apps.title.es}</title>`,
    );
    expect(await (await onRequest(ctx("/apps?lang=en"))).text()).toContain(
      `<title>${APPS_COPY.apps.title.en}</title>`,
    );
  });
});

describe("the Apps pages at the edge, flag unknown", () => {
  it.each([
    ["the API is down", async () => { throw new Error("api down"); }],
    ["an older API with no such route", async () => new Response("nope", { status: 404 })],
    ["a malformed answer", async () => Response.json({ enabled: "true" })],
  ])("%s: the document is served untouched, not redirected and not rewritten", async (_name, answer) => {
    vi.stubGlobal("fetch", vi.fn(answer));
    const onRequest = await freshMiddleware();
    const response = await onRequest(ctx("/apps/locadora"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    const html = await response.text();
    expect(html).not.toContain(APPS_COPY.locadora.title["pt-BR"]);
    expect(html).toContain("<head>");
  });

  it("a burst on a cold isolate costs one API call, not one per visitor", async () => {
    let release: (response: Response) => void = () => {};
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onRequest = await freshMiddleware();
    const burst = Promise.all([
      onRequest(ctx("/apps")),
      onRequest(ctx("/apps/locadora")),
      onRequest(ctx("/locadora")),
      onRequest(ctx("/apps")),
    ]);
    // Let every request reach the flag before the API answers.
    await new Promise((resolve) => setTimeout(resolve, 20));
    release(Response.json({ enabled: true }));
    const responses = await burst;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const response of responses) expect(response.status).toBe(200);
  });

  it("remembers the answer for the isolate, so a visit does not cost a request each", async () => {
    const fetchMock = vi.fn(async () => Response.json({ enabled: true }));
    vi.stubGlobal("fetch", fetchMock);
    const onRequest = await freshMiddleware();
    await onRequest(ctx("/apps"));
    await onRequest(ctx("/locadora"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("everything else is not its business", () => {
  it("a neighbouring path and an asset never reach the flag", async () => {
    const fetchMock = vi.fn(async () => Response.json({ enabled: false }));
    vi.stubGlobal("fetch", fetchMock);
    const onRequest = await freshMiddleware();
    for (const pathname of ["/apps/other", "/appstore", "/assets/apps-abc.js", "/images/apps/street-dusk.webp"]) {
      const response = await onRequest(ctx(pathname));
      expect(response.status, pathname).not.toBe(302);
    }
    expect(fetchMock).not.toHaveBeenCalledWith(
      "https://api.test/api/public/apps/config",
      expect.anything(),
    );
  });
});

describe("the guest player at the edge", () => {
  const PLAY = ["/locadora/jogar", "/apps/locadora/play"];

  it.each(PLAY)("%s redirects home while guest play is off, even with the landing on", async (pathname) => {
    for (const body of [{ enabled: true, guest: false }, { enabled: true }, { enabled: false, guest: true }]) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
      const onRequest = await freshMiddleware();
      const response = await onRequest(ctx(pathname));
      expect(response.status, JSON.stringify(body)).toBe(302);
      expect(response.headers.get("location")).toBe("/");
    }
  });

  it.each(PLAY)("%s gets the announcement card and stays out of search while it is on", async (pathname) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ enabled: true, guest: true })));
    const onRequest = await freshMiddleware();
    const response = await onRequest(ctx(pathname, { "accept-language": "pt-BR" }));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<title>${APPS_COPY.play.title["pt-BR"]}</title>`);
    expect(html).toContain('<link rel="canonical" href="https://pqp.gg/locadora/jogar" />');
    expect(html).toContain(`content="https://pqp.gg${APPS_COPY.play.image}"`);
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
  });

  it("the landing does not need guest play", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ enabled: true, guest: false })));
    const onRequest = await freshMiddleware();
    expect((await onRequest(ctx("/apps/locadora"))).status).toBe(200);
  });
});

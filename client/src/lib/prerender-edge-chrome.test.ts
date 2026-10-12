import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The middleware learns the footer's three run-time switches from
 * `/edge-config.json` and the API's public communities config. Each test
 * imports a fresh module, because the middleware remembers both per isolate.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(path.resolve(here, "../../index.html"), "utf8");

function ctx(edgeConfig: unknown) {
  return {
    request: new Request("https://pqp.gg/tela"),
    env: {
      ASSETS: {
        fetch: async () =>
          edgeConfig === null
            ? new Response("missing", { status: 404 })
            : new Response(JSON.stringify(edgeConfig), {
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

describe("the marketing chrome at the edge", () => {
  it("shows Communities, the support page and the Play label when all three are on", async () => {
    const fetchMock = vi.fn(async () => Response.json({ enabled: true }));
    vi.stubGlobal("fetch", fetchMock);
    const onRequest = await freshMiddleware();
    const body = await (
      await onRequest(ctx({ apiUrl: "https://api.test", supportPage: true, playStore: true }))
    ).text();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/api/public/communities/config",
      expect.anything(),
    );
    expect(body).toContain('<a href="/#communities">Comunidades</a>');
    expect(body).toContain('<a href="/apoie">');
    expect(body).toContain("Baixar na Google Play");
  });

  it("asks the API once per isolate, not once per request", async () => {
    const fetchMock = vi.fn(async () => Response.json({ enabled: true }));
    vi.stubGlobal("fetch", fetchMock);
    const onRequest = await freshMiddleware();
    const config = { apiUrl: "https://api.test", supportPage: false, playStore: true };
    await onRequest(ctx(config));
    await onRequest(ctx(config));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves every conditional link out when nothing answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("api down");
      }),
    );
    const onRequest = await freshMiddleware();
    const body = await (await onRequest(ctx(null))).text();
    expect(body).toContain('id="pre-page"');
    expect(body).toContain("<footer");
    expect(body).not.toContain('href="/#communities"');
    expect(body).not.toContain('href="/apoie"');
    expect(body).not.toContain("Baixar na Google Play");
  });

  it("leaves Communities out when the API says it is off or is too slow", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ enabled: false })));
    let onRequest = await freshMiddleware();
    const config = { apiUrl: "https://api.test", supportPage: true, playStore: true };
    expect(await (await onRequest(ctx(config))).text()).not.toContain('href="/#communities"');

    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    onRequest = await freshMiddleware();
    const started = Date.now();
    const body = await (await onRequest(ctx(config))).text();
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(body).not.toContain('href="/#communities"');
    expect(body).toContain('href="/apoie"');
  });

  it("asks a slow API once per isolate, while each page stops waiting on its own", async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onRequest = await freshMiddleware();
    const config = { apiUrl: "https://api.test", supportPage: false, playStore: false };
    const pending: Promise<unknown>[] = [];
    const slow = { ...ctx(config), waitUntil: (p: Promise<unknown>) => pending.push(p) };
    for (let i = 0; i < 2; i += 1) {
      const started = Date.now();
      expect(await (await onRequest(slow)).text()).not.toContain('href="/#communities"');
      expect(Date.now() - started).toBeLessThan(1_500);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await Promise.all(pending);
    await onRequest(slow);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("answers from the colo cache and refreshes a stale entry in the background", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("caches", {
      default: {
        match: async (key: string) => {
          const hit = store.get(key);
          return hit === undefined ? undefined : new Response(hit);
        },
        put: async (key: string, response: Response) => {
          store.set(key, await response.text());
        },
      },
    });
    const config = { apiUrl: "https://api.test", supportPage: false, playStore: false };

    const fetchMock = vi.fn(async () => Response.json({ enabled: true }));
    vi.stubGlobal("fetch", fetchMock);
    let onRequest = await freshMiddleware();
    expect(await (await onRequest(ctx(config))).text()).toContain('href="/#communities"');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    onRequest = await freshMiddleware();
    expect(await (await onRequest(ctx(config))).text()).toContain('href="/#communities"');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [key] = [...store.keys()];
    store.set(key, JSON.stringify({ enabled: true, at: Date.now() - 60 * 60_000 }));
    fetchMock.mockImplementation(async () => Response.json({ enabled: false }));
    const pending: Promise<unknown>[] = [];
    onRequest = await freshMiddleware();
    const stale = { ...ctx(config), waitUntil: (p: Promise<unknown>) => pending.push(p) };
    expect(await (await onRequest(stale)).text()).toContain('href="/#communities"');
    await Promise.all(pending);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(store.get(key) ?? "{}").enabled).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jamSongCardText, jamTargetFromMetaPath, renderJamHead } from "./jam-meta";

/**
 * The public jam site at the edge: the right page for each address, a song's
 * own head (who played, what it needs, its cover), `noindex` for everything
 * that is not a public song or while the flag is off, and "could not tell"
 * serving the page as it is. Each middleware test imports a fresh module,
 * because the middleware remembers answers per isolate.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SHELL = readFileSync(path.resolve(here, "../../jam-site/index.html"), "utf8");
const ID = "0b8f2c1e-4d5a-4e6f-8a7b-1c2d3e4f5a6b";

const SONG = {
  song: {
    id: ID,
    title: "Minuano",
    artist: null,
    coverUrl: "https://media.example/cover.jpg?sig=1",
    needs: ["bass"],
    parts: [
      { instrument: "drums", person: { name: "Leco" } },
      { instrument: "guitar", person: { name: "Tchelo" } },
      { instrument: "vocals", person: { name: "Juju" } },
    ],
    startedBy: { name: "Leco", handle: "leco" },
  },
  tracks: [],
};

function ctx(url: string, headers: Record<string, string> = {}, method = "GET") {
  return {
    request: new Request(url, { method, headers }),
    env: {
      ASSETS: {
        fetch: async (input: Request | string | URL) => {
          const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
          if (target.pathname === "/edge-config.json") {
            return new Response(JSON.stringify({ apiUrl: "https://api.test" }), {
              headers: { "content-type": "application/json" },
            });
          }
          if (target.pathname === "/jam-site/") {
            return new Response(SHELL, { headers: { "content-type": "text/html" } });
          }
          return new Response("nope", { status: 404 });
        },
      },
    },
    next: async () => new Response("<html><head></head></html>", { headers: { "content-type": "text/html" } }),
  };
}

async function freshMiddleware() {
  vi.resetModules();
  return (await import("../../functions/_middleware")).onRequest;
}

function stubApi(routes: Record<string, () => Response | Promise<Response>>) {
  const mock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const handler = routes[url.pathname];
    if (!handler) return new Response("no", { status: 404 });
    return handler();
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("which address is the jam site", () => {
  it("knows both mounts and nothing else", () => {
    expect(jamTargetFromMetaPath("jam.pqp.gg", "/")).toEqual({ kind: "home", mount: "host" });
    expect(jamTargetFromMetaPath("jam.pqp.gg", `/m/${ID}`)).toEqual({ kind: "song", mount: "host", songId: ID });
    expect(jamTargetFromMetaPath("pqp.gg", "/jam")).toEqual({ kind: "home", mount: "path" });
    expect(jamTargetFromMetaPath("pqp.gg", "/jam/")).toEqual({ kind: "home", mount: "path" });
    expect(jamTargetFromMetaPath("pqp.gg", `/jam/m/${ID}`)).toEqual({ kind: "song", mount: "path", songId: ID });
    expect(jamTargetFromMetaPath("pqp.gg", "/")).toBeNull();
    expect(jamTargetFromMetaPath("pqp.gg", `/m/${ID}`)).toBeNull();
    expect(jamTargetFromMetaPath("jam.pqp.gg", "/privacy")).toBeNull();
    expect(jamTargetFromMetaPath("pqp.gg", "/jam/m/not-an-id")).toBeNull();
  });
});

describe("the card's words", () => {
  const song = SONG.song;
  it("says who played and what is missing, in tu", () => {
    const pt = jamSongCardText(song, "pt-BR");
    expect(pt.title).toBe("Minuano · pqp jam");
    expect(pt.description).toBe("Leco, Tchelo e Juju tocaram. Falta baixo: grava a tua parte.");
    expect(jamSongCardText(song, "en").description).toBe("Played by Leco, Tchelo and Juju. Needs bass: record your part.");
  });

  it("names the starter when no part is public and says nothing is missing when nothing is", () => {
    const text = jamSongCardText({ ...song, parts: [], needs: [] }, "pt-BR");
    expect(text.description).toBe("Começada por @leco.");
  });

  it("carries no em dash and escapes what a person typed", () => {
    const { head } = renderJamHead(
      { target: { kind: "song", mount: "host", songId: ID }, song: { ...song, title: 'a "b" <i>' }, enabled: true },
      { locale: "pt-BR", fallbackImage: "https://jam.pqp.gg/images/og-image.jpg" },
    );
    expect(head).not.toMatch(/[—–]/);
    expect(head).toContain("a &quot;b&quot; &lt;i&gt; · pqp jam");
    expect(head).not.toContain("<i>");
  });
});

describe("the middleware on a song", () => {
  it("writes the song's head on the host mount, canonical to jam.pqp.gg, with its cover", async () => {
    stubApi({ [`/api/public/jams/${ID}`]: () => Response.json(SONG) });
    const onRequest = await freshMiddleware();
    const response = await onRequest(ctx(`https://jam.pqp.gg/m/${ID}`, { "accept-language": "pt-BR" }));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Minuano · pqp jam</title>");
    expect(html).toContain(`<link rel="canonical" href="https://jam.pqp.gg/m/${ID}" />`);
    expect(html).toContain('<meta property="og:image" content="https://media.example/cover.jpg?sig=1" />');
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    expect(html).toContain("Falta baixo: grava a tua parte.");
    expect(html).toContain('<meta name="robots" content="index, follow" />');
    expect(html).not.toContain("noindex");
    expect(response.headers.get("x-robots-tag")).toBeNull();
    // The shell's own placeholders are gone, and its script is still there.
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain('<script type="module" src="/src/jam-site/entry.tsx">');
  });

  it("is the same page, canonical to the hosted address, on the /jam mount of another host", async () => {
    stubApi({ [`/api/public/jams/${ID}`]: () => Response.json(SONG) });
    const onRequest = await freshMiddleware();
    const html = await (await onRequest(ctx(`https://pqp.gg/jam/m/${ID}`, { "accept-language": "en-US" }))).text();
    expect(html).toContain(`<link rel="canonical" href="https://jam.pqp.gg/m/${ID}" />`);
    expect(html).toContain("Played by Leco, Tchelo and Juju. Needs bass: record your part.");
  });

  it("uses the site card when there is no cover, and a large card for it", async () => {
    stubApi({ [`/api/public/jams/${ID}`]: () => Response.json({ ...SONG, song: { ...SONG.song, coverUrl: null } }) });
    const onRequest = await freshMiddleware();
    const html = await (await onRequest(ctx(`https://jam.pqp.gg/m/${ID}`))).text();
    expect(html).toContain('<meta property="og:image" content="https://jam.pqp.gg/images/og-image.jpg" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  it("is generic, noindex and uncached for a song the API will not answer for", async () => {
    stubApi({ [`/api/public/jams/${ID}`]: () => new Response("{}", { status: 404 }) });
    const onRequest = await freshMiddleware();
    const response = await onRequest(ctx(`https://jam.pqp.gg/m/${ID}`));
    const html = await response.text();
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(html).not.toContain("Minuano");
    expect(html).not.toContain('rel="canonical"');
  });

  it("treats the 401 a switched-off flag answers like a 404", async () => {
    stubApi({ [`/api/public/jams/${ID}`]: () => new Response("{}", { status: 401 }) });
    const onRequest = await freshMiddleware();
    const response = await onRequest(ctx(`https://jam.pqp.gg/m/${ID}`));
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("serves the page untouched when the API cannot be reached", async () => {
    stubApi({ [`/api/public/jams/${ID}`]: () => new Response("boom", { status: 503 }) });
    const onRequest = await freshMiddleware();
    const html = await (await onRequest(ctx(`https://jam.pqp.gg/m/${ID}`))).text();
    expect(html).toBe(SHELL);
  });

  it("answers a HEAD as the GET is, without a body", async () => {
    stubApi({ [`/api/public/jams/${ID}`]: () => Response.json(SONG) });
    const onRequest = await freshMiddleware();
    const response = await onRequest(ctx(`https://jam.pqp.gg/m/${ID}`, {}, "HEAD"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
  });
});

describe("the middleware on the home", () => {
  it("is indexable while the flag is on", async () => {
    stubApi({ "/api/public/jams/config": () => Response.json({ enabled: true }) });
    const onRequest = await freshMiddleware();
    const response = await onRequest(ctx("https://jam.pqp.gg/", { "accept-language": "pt-BR" }));
    const html = await response.text();
    expect(html).toContain("<title>pqp jam: músicas que qualquer pessoa ouve e toca junto</title>");
    expect(html).toContain('<link rel="canonical" href="https://jam.pqp.gg/" />');
    expect(html).toContain('<meta name="robots" content="index, follow" />');
    expect(response.headers.get("x-robots-tag")).toBeNull();
  });

  it("is noindex while it is off", async () => {
    stubApi({ "/api/public/jams/config": () => Response.json({ enabled: false }) });
    const onRequest = await freshMiddleware();
    const response = await onRequest(ctx("https://pqp.gg/jam"));
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await response.text()).toContain('<meta name="robots" content="noindex, nofollow" />');
  });

  it("asks only the public config, with no credential", async () => {
    const mock = stubApi({ "/api/public/jams/config": () => Response.json({ enabled: true }) });
    const onRequest = await freshMiddleware();
    await onRequest(ctx("https://jam.pqp.gg/", { authorization: "Bearer nope", cookie: "a=b" }));
    expect(mock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mock.mock.calls[0])).not.toMatch(/authorization|cookie/i);
  });

  it("does not touch any other page of jam.pqp.gg", async () => {
    const mock = stubApi({});
    const onRequest = await freshMiddleware();
    const response = await onRequest(ctx("https://jam.pqp.gg/privacy"));
    expect(mock).not.toHaveBeenCalled();
    expect(await response.text()).toContain("<head>");
  });
});

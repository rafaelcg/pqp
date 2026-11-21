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
      { locale: "pt-BR", siteOrigin: "https://jam.pqp.gg", apiOrigin: "https://api.test" },
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
    // OUR address for the cover, never the signed one the JSON carries.
    expect(html).toContain(`<meta property="og:image" content="https://api.test/api/public/jams/${ID}/cover" />`);
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    expect(html).toContain('<meta property="og:image:alt" content="Minuano" />');
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

  it("uses the jam card, not the main pqp card, when there is no cover, and a large card for it", async () => {
    stubApi({ [`/api/public/jams/${ID}`]: () => Response.json({ ...SONG, song: { ...SONG.song, coverUrl: null } }) });
    const onRequest = await freshMiddleware();
    const html = await (await onRequest(ctx(`https://jam.pqp.gg/m/${ID}`))).text();
    expect(html).toContain('<meta property="og:image" content="https://jam.pqp.gg/images/og-jam.png" />');
    expect(html).toContain('<meta property="og:image:type" content="image/png" />');
    expect(html).toContain('<meta property="og:image:width" content="1200" />');
    expect(html).toContain('<meta property="og:image:height" content="630" />');
    expect(html).toMatch(/<meta property="og:image:alt" content="pqp jam: [^"]+" \/>/);
    expect(html).toContain('<meta name="twitter:image" content="https://jam.pqp.gg/images/og-jam.png" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain('<meta property="og:locale" content="pt_BR" />');
    expect(html).not.toContain("og-image.jpg");
  });

  it("picks the card's language the way every other public page does: Accept-Language, or ?lang=", async () => {
    stubApi({ [`/api/public/jams/${ID}`]: () => Response.json({ ...SONG, song: { ...SONG.song, coverUrl: null } }) });
    const onRequest = await freshMiddleware();
    const read = async (path: string, headers: Record<string, string> = {}) =>
      (await onRequest(ctx(`https://jam.pqp.gg${path}`, headers))).text();
    const en = await read(`/m/${ID}`, { "accept-language": "en-US,en;q=0.9" });
    expect(en).toContain('<meta property="og:image" content="https://jam.pqp.gg/images/og-jam-en.png" />');
    expect(en).toContain("Played by Leco, Tchelo and Juju.");
    expect(en).toContain('<meta property="og:locale" content="en_US" />');
    expect(en).toMatch(/og:image:alt" content="pqp jam: a mosaic/);
    // Spanish readers get the English card, like the words.
    expect(await read(`/m/${ID}`, { "accept-language": "es-MX" })).toContain("og-jam-en.png");
    // A Portuguese reader with an English fallback is still Portuguese.
    expect(await read(`/m/${ID}`, { "accept-language": "pt-BR,en;q=0.8" })).toContain("og-jam.png");
    // No language at all (several crawlers send none): Portuguese, as elsewhere.
    expect(await read(`/m/${ID}`)).toContain("og-jam.png");
    // `?lang=` beats the header.
    expect(await read(`/m/${ID}?lang=en`, { "accept-language": "pt-BR" })).toContain("og-jam-en.png");
  });

  it("never puts a signed URL in a tag, whatever shape the JSON's cover has", async () => {
    for (const coverUrl of [
      "https://bucket.example/jam/abc/cover.jpg?X-Amz-Signature=deadbeef&X-Amz-Expires=3600",
      "https://jam-media.pqp.gg/jam-media/TOKEN?e=1900000000&s=SIG",
      "https://media.example/cover.jpg?sig=1",
    ]) {
      stubApi({ [`/api/public/jams/${ID}`]: () => Response.json({ ...SONG, song: { ...SONG.song, coverUrl } }) });
      const onRequest = await freshMiddleware();
      const html = await (await onRequest(ctx(`https://jam.pqp.gg/m/${ID}`))).text();
      expect(html).not.toMatch(/X-Amz|sig=|SIG|TOKEN|deadbeef|bucket\.example|jam-media|media\.example/);
      // The JSON-LD names the same stable picture the tags do.
      expect(html).toContain(`"image":"https://api.test/api/public/jams/${ID}/cover"`);
    }
  });

  it("takes the API origin from the Worker's own setting when it has one", async () => {
    stubApi({ [`/api/public/jams/${ID}`]: () => Response.json(SONG) });
    const onRequest = await freshMiddleware();
    const context = ctx(`https://jam.pqp.gg/m/${ID}`);
    (context.env as Record<string, unknown>).PQP_API_URL = "https://api.pqp.gg/";
    const html = await (await onRequest(context)).text();
    expect(html).toContain(`<meta property="og:image" content="https://api.pqp.gg/api/public/jams/${ID}/cover" />`);
  });

  it("gives a private, an unpublished and an unknown song the same generic jam card, naming nothing", async () => {
    // The API answers all three with the one 404, so the edge cannot tell them apart.
    const heads: string[] = [];
    for (const otherId of [ID, "11111111-2222-4333-8444-555555555555", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]) {
      stubApi({ [`/api/public/jams/${otherId}`]: () => new Response('{"error":"Not found"}', { status: 404 }) });
      const onRequest = await freshMiddleware();
      const response = await onRequest(ctx(`https://jam.pqp.gg/m/${otherId}`));
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const html = await response.text();
      expect(html).toContain('<meta property="og:image" content="https://jam.pqp.gg/images/og-jam.png" />');
      expect(html).not.toContain("/cover");
      expect(html).not.toContain("Minuano");
      expect(html).not.toContain('rel="canonical"');
      heads.push(html.replaceAll(otherId, "ID"));
    }
    expect(heads[1]).toBe(heads[0]);
    expect(heads[2]).toBe(heads[0]);
  });

  it("with the flag off, a song and the home are noindex and carry the jam card, not a cover", async () => {
    // The flag off answers a song with the 401 of an unknown path and the config with enabled: false.
    stubApi({
      [`/api/public/jams/${ID}`]: () => new Response("{}", { status: 401 }),
      "/api/public/jams/config": () => Response.json({ enabled: false }),
    });
    const onRequest = await freshMiddleware();
    const song = await onRequest(ctx(`https://jam.pqp.gg/m/${ID}`, { "accept-language": "en" }));
    const songHtml = await song.text();
    expect(song.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(songHtml).toContain("og-jam-en.png");
    expect(songHtml).not.toContain("/cover");
    const home = await onRequest(ctx("https://jam.pqp.gg/", { "accept-language": "en" }));
    expect(home.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await home.text()).toContain("og-jam-en.png");
  });

  it("falls back to the card when the Worker does not know the API origin", async () => {
    const out = renderJamHead(
      { target: { kind: "song", mount: "host", songId: ID }, song: SONG.song, enabled: true },
      { locale: "en", siteOrigin: "https://jam.pqp.gg", apiOrigin: null },
    );
    expect(out.head).toContain("https://jam.pqp.gg/images/og-jam-en.png");
    expect(out.head).not.toContain("/cover");
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

  it("sends any other page of jam.pqp.gg to the main site, with no API call", async () => {
    const mock = stubApi({});
    const onRequest = await freshMiddleware();
    const response = await onRequest(ctx("https://jam.pqp.gg/privacy"));
    expect(mock).not.toHaveBeenCalled();
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://pqp.gg/privacy");
  });
});

describe("the jam cards on disk", () => {
  const png = (name: string) => readFileSync(path.resolve(here, "../../public/images", name));

  it.each(["og-jam.png", "og-jam-en.png"])("%s is a 1200x630 PNG small enough for WhatsApp", (name) => {
    const bytes = png(name);
    expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
    // IHDR: width and height are the first two big-endian words after the chunk name.
    expect(bytes.readUInt32BE(16)).toBe(1200);
    expect(bytes.readUInt32BE(20)).toBe(630);
    expect(bytes.length).toBeLessThan(300 * 1024);
  });

  it("the home carries the jam card in its language too", async () => {
    stubApi({ "/api/public/jams/config": () => Response.json({ enabled: true }) });
    const onRequest = await freshMiddleware();
    const html = await (await onRequest(ctx("https://jam.pqp.gg/", { "accept-language": "pt-BR" }))).text();
    expect(html).toContain('<meta property="og:image" content="https://jam.pqp.gg/images/og-jam.png" />');
    expect(html).not.toContain("og-image.jpg");
  });
});

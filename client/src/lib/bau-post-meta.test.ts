// The REAL shipped document, imported as text, so a change to `index.html` that
// breaks the rewrite fails here and not in production (see `community-meta.test.ts`).
import INDEX_HTML from "../../index.html?raw";
import { parseBauPublicPostPath } from "@pqp/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequest } from "../../functions/_middleware";
import {
  bauPostCardText,
  bauPostFromMetaPath,
  injectBauPostHead,
  renderBauPostHead,
  type BauPostMeta,
} from "./bau-post-meta";

/**
 * The `/c/<slug>/p/<postId>` half of the Pages middleware: the card a shared
 * Baú post unfurls as. Two layers, as for the community card: the pure head
 * builder against the real `index.html`, and the middleware itself with a
 * stubbed API, which is where "what happens when the API says 404 / is down"
 * lives.
 */

const POST_ID = "aa11bb22-cc33-4dd4-8ee5-ff6677889900";
const OPTIONS = {
  siteOrigin: "https://pqp.gg",
  apiOrigin: "https://api.pqp.gg",
  locale: "pt-BR" as const,
};

const POST: BauPostMeta = {
  slug: "mesa-da-tues",
  postId: POST_ID,
  title: "Patch 1.2 saiu",
  teaser: "A gente mexeu no mapa inteiro e ficou lindo.",
  coverUrl: `/api/public/communities/mesa-da-tues/posts/${POST_ID}/cover`,
  publishedAt: "2026-10-15T07:29:48.569Z",
  community: {
    slug: "mesa-da-tues",
    name: "Mesa da Tues",
    tagline: "A mesa de quem joga",
    category: "games",
    memberCount: 42,
    iconUrl: "/api/servers/abc/icon?v=1",
    bannerUrl: "/api/servers/abc/banner?v=1",
  },
};

describe("bauPostFromMetaPath", () => {
  it("agrees with the shared parser on every path either might see", () => {
    // The duplication is deliberate (the middleware must not import the
    // workspace package). This is what stops it drifting.
    const paths = [
      `/c/mesa-da-tues/p/${POST_ID}`,
      `/c/mesa-da-tues/p/${POST_ID}/`,
      `/c/MESA-DA-TUES/p/${POST_ID.toUpperCase()}`,
      "/c/mesa-da-tues",
      "/c/mesa-da-tues/p",
      "/c/mesa-da-tues/p/not-a-uuid",
      `/c/mesa-da-tues/p/${POST_ID}/extra`,
      `/c/-/p/${POST_ID}`,
      `/c/a/p/${POST_ID}`,
      `/c/%E0%A4%A/p/${POST_ID}`,
      `/app/c/mesa-da-tues/p/${POST_ID}`,
      `/@rafa/p/${POST_ID}`,
      "/",
    ];
    for (const path of paths) {
      expect(bauPostFromMetaPath(path), path).toEqual(parseBauPublicPostPath(path));
    }
  });
});

describe("the card's words", () => {
  it("leads with the post and names the room", () => {
    expect(bauPostCardText(POST, "pt-BR")).toEqual({
      title: "Patch 1.2 saiu · Mesa da Tues",
      description: "A gente mexeu no mapa inteiro e ficou lindo.",
    });
    expect(bauPostCardText(POST, "en").title).toBe("Patch 1.2 saiu · Mesa da Tues");
  });

  it("a post with no title is headed by its room, and one with no teaser says what it is", () => {
    const bare = { ...POST, title: null, teaser: null };
    expect(bauPostCardText(bare, "pt-BR")).toEqual({
      title: "Um post no Baú de Mesa da Tues",
      description: "Baú de Mesa da Tues no pqp. Entra aí.",
    });
    expect(bauPostCardText(bare, "en")).toEqual({
      title: "A post in the Baú of Mesa da Tues",
      description: "Baú of Mesa da Tues on pqp. Come in.",
    });
  });

  it("clips a long title and teaser at a word, not mid-word", () => {
    const long = { ...POST, title: "palavra ".repeat(40), teaser: "frase longa ".repeat(60) };
    const { title, description } = bauPostCardText(long, "pt-BR");
    expect(title.length).toBeLessThan(110);
    expect(description.length).toBeLessThanOrEqual(200);
    expect(description.endsWith("…")).toBe(true);
    expect(description).not.toMatch(/\s…$/);
  });
});

describe("renderBauPostHead", () => {
  it("is an article with the post's own picture on a large card", () => {
    const head = renderBauPostHead(POST, OPTIONS);
    expect(head).toContain('<meta property="og:type" content="article" />');
    expect(head).toContain(
      `<meta property="og:image" content="https://api.pqp.gg/api/public/communities/mesa-da-tues/posts/${POST_ID}/cover" />`,
    );
    expect(head).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(head).toContain(
      `<link rel="canonical" href="https://pqp.gg/c/mesa-da-tues/p/${POST_ID}" />`,
    );
    // The canonical is the bare address: a share's campaign never forks it.
    expect(head).not.toContain("utm_");
    expect(head).toContain('<meta name="robots" content="index, follow" />');
  });

  it("falls back to the banner, then the icon, then the site card", () => {
    const noCover = renderBauPostHead({ ...POST, coverUrl: null }, OPTIONS);
    expect(noCover).toContain('content="https://api.pqp.gg/api/servers/abc/banner?v=1"');
    expect(noCover).toContain("summary_large_image");

    const iconOnly = renderBauPostHead(
      { ...POST, coverUrl: null, community: { ...POST.community, bannerUrl: null } },
      OPTIONS,
    );
    expect(iconOnly).toContain('content="https://api.pqp.gg/api/servers/abc/icon?v=1"');
    // A square icon on a wide card would be stretched: the small card.
    expect(iconOnly).toContain('<meta name="twitter:card" content="summary" />');

    const nothing = renderBauPostHead(
      { ...POST, coverUrl: null, community: { ...POST.community, bannerUrl: null, iconUrl: null } },
      OPTIONS,
    );
    expect(nothing).toContain('content="https://pqp.gg/images/og-image.jpg"');
    // The site's own card is 1200x630, which is what the large card is for.
    expect(nothing).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  it("takes a YouTube poster as it is and refuses anything that is not https", () => {
    const yt = renderBauPostHead(
      { ...POST, coverUrl: "https://i.ytimg.com/vi/abc/hqdefault.jpg" },
      OPTIONS,
    );
    expect(yt).toContain('content="https://i.ytimg.com/vi/abc/hqdefault.jpg"');
    const bad = renderBauPostHead(
      { ...POST, coverUrl: "javascript:alert(1)", community: { ...POST.community, bannerUrl: null, iconUrl: null } },
      OPTIONS,
    );
    expect(bad).not.toContain("javascript:");
  });

  it("escapes author-typed text in every attribute and in the JSON-LD", () => {
    const hostile = {
      ...POST,
      title: '"><script>alert(1)</script>',
      teaser: "</script><img src=x onerror=alert(1)>",
    };
    const head = renderBauPostHead(hostile, OPTIONS);
    expect(head).not.toContain("<script>alert");
    expect(head).not.toContain("<img");
    // One script block only: the structured data, and it did not close early.
    expect(head.match(/<script/g)).toHaveLength(1);
    expect(head.match(/<\/script>/g)).toHaveLength(1);
  });

  it("names no author and no comment: nothing of either is in the head", () => {
    const head = renderBauPostHead(POST, OPTIONS);
    expect(head.toLowerCase()).not.toContain("author");
    expect(head.toLowerCase()).not.toContain("comment");
  });
});

describe("injectBauPostHead against the real index.html", () => {
  it("leaves exactly one of every managed tag and keeps the rest of the head", () => {
    const out = injectBauPostHead(INDEX_HTML, POST, OPTIONS);
    for (const tag of [
      /<title>/g,
      /property="og:title"/g,
      /property="og:image"/g,
      /name="twitter:card"/g,
      /rel="canonical"/g,
      /name="description"/g,
      /type="application\/ld\+json"/g,
    ]) {
      expect(out.match(tag), String(tag)).toHaveLength(1);
    }
    expect(out).toContain("<title>Patch 1.2 saiu · Mesa da Tues</title>");
    // What is not social vocabulary survives.
    expect(out).toContain('<meta name="viewport"');
    expect(out).toContain('rel="icon"');
  });

  it("returns a document with no head as it came", () => {
    expect(injectBauPostHead("<html><body>x</body></html>", POST, OPTIONS)).toBe(
      "<html><body>x</body></html>",
    );
  });
});

// ------------------------------------------------------------- middleware

function ctx(path: string, headers: Record<string, string> = {}) {
  return {
    request: new Request(`https://pqp.gg${path}`, { headers }),
    env: { PQP_API_URL: "https://api.test" },
    next: async () =>
      new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8" } }),
  };
}

const API_ANSWER = {
  post: {
    id: POST_ID,
    title: POST.title,
    body: "corpo inteiro que o card nao usa",
    teaser: POST.teaser,
    media: null,
    posterUrl: null,
    coverUrl: POST.coverUrl,
    likeCount: 3,
    commentCount: 1,
    publishedAt: POST.publishedAt,
  },
  community: POST.community,
};

describe("the middleware on /c/<slug>/p/<postId>", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the public read for this exact post and rewrites the head from it", async () => {
    const fetchMock = vi.fn(async () => Response.json(API_ANSWER));
    vi.stubGlobal("fetch", fetchMock);

    const res = await onRequest(ctx(`/c/Mesa-da-Tues/p/${POST_ID.toUpperCase()}?utm_source=x`));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      `https://api.test/api/public/communities/mesa-da-tues/posts/${POST_ID}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("vary")).toContain("accept-language");
    const body = await res.text();
    expect(body).toContain("<title>Patch 1.2 saiu · Mesa da Tues</title>");
    expect(body).toContain(
      `<meta property="og:image" content="https://api.test/api/public/communities/mesa-da-tues/posts/${POST_ID}/cover" />`,
    );
    // A campaign on the incoming URL never leaks into the canonical.
    expect(body).toContain(
      `<link rel="canonical" href="https://pqp.gg/c/mesa-da-tues/p/${POST_ID}" />`,
    );
    // The post's body is not on the card: it is only in the embedded answer.
    const [tags] = body.split('<script type="application/json"');
    expect(tags).not.toContain("corpo inteiro");
    expect(body).toContain('<script type="application/json" id="pqp-bau-post">');
    const embedded = body.match(/id="pqp-bau-post">([^<]*)<\/script>/)?.[1];
    expect(JSON.parse(embedded!)).toEqual(API_ANSWER);
  });

  it("an embedded post cannot break out of its block, whatever the author typed", async () => {
    const hostile = {
      ...API_ANSWER,
      post: { ...API_ANSWER.post, title: "</script><script>alert(1)</script>", body: "a & b < c" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(hostile)));
    const body = await (await onRequest(ctx(`/c/mesa-da-tues/p/${POST_ID}`))).text();
    expect(body).not.toContain("<script>alert");
    const embedded = body.match(/id="pqp-bau-post">([^<]*)<\/script>/)?.[1];
    expect(JSON.parse(embedded!)).toEqual(hostile);
  });

  it("answers in English when the reader leads with English", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...API_ANSWER, post: { ...API_ANSWER.post, title: null, teaser: null } })));
    const res = await onRequest(
      ctx(`/c/mesa-da-tues/p/${POST_ID}`, { "accept-language": "en-US,en;q=0.9" }),
    );
    expect(await res.text()).toContain("<title>A post in the Baú of Mesa da Tues</title>");
  });

  it("serves the page as it was when the API cannot be reached, with no robots header", async () => {
    for (const failing of [
      vi.fn(async () => new Response("boom", { status: 500 })),
      vi.fn(async () => {
        throw new Error("offline");
      }),
      vi.fn(async () => new Response("not json", { status: 200 })),
      vi.fn(async () => Response.json({ post: {}, community: {} })),
    ]) {
      vi.stubGlobal("fetch", failing);
      const res = await onRequest(ctx(`/c/mesa-da-tues/p/${POST_ID}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-robots-tag")).toBeNull();
      expect(await res.text()).toContain("<title>");
    }
  });

  it("a post the API says is not public stays the generic card, noindex, and is not cached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "Not found" }, { status: 404 })),
    );
    const res = await onRequest(ctx(`/c/mesa-da-tues/p/${POST_ID}`));
    // The person opening a dead link still gets the app, which draws its own 404.
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).not.toContain("Patch 1.2");
    expect(body).not.toContain("Mesa da Tues");
    expect(body).toContain('<div id="root">');
  });

  it("does not act on the community page, a malformed id or a POST", async () => {
    const fetchMock = vi.fn(async () => Response.json(API_ANSWER));
    vi.stubGlobal("fetch", fetchMock);
    await onRequest(ctx(`/c/mesa-da-tues/p/not-a-uuid`));
    const post = await onRequest({
      ...ctx(`/c/mesa-da-tues/p/${POST_ID}`),
      request: new Request(`https://pqp.gg/c/mesa-da-tues/p/${POST_ID}`, { method: "POST" }),
    });
    expect(post.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is a known SPA route, so the shell is not turned into a 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    const res = await onRequest(ctx(`/c/mesa-da-tues/p/not-a-uuid`));
    expect(res.status).toBe(200);
  });
});

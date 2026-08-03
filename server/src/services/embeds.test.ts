import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingHttpHeaders } from "node:http";

/**
 * `fetchAndCacheEmbed` is the orchestrator that ties the SSRF-guarded fetch
 * (proved correct on its own in `lib/safe-fetch.test.ts`) to HTML parsing and
 * the Postgres cache. Faking `safeFetch` here means these tests drive real
 * SQL against a real Postgres — the same TTL/failed-caching logic the create
 * path depends on — without needing a real HTTP origin to fetch from.
 */

vi.mock("../lib/safe-fetch.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/safe-fetch.js")>();
  return { ...actual, safeFetch: vi.fn() };
});

// TEST_DATABASE_URL wins — see the note in api.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { safeFetch } = await import("../lib/safe-fetch.js");
const {
  extractFirstUrl,
  fetchAndCacheEmbed,
  getCachedEmbed,
  getEmbedImageUrl,
  listEmbedsForMessages,
} = await import("./embeds.js");

function htmlResponse(
  body: string,
  options: { contentType?: string; statusCode?: number; finalUrl?: string } = {},
) {
  return {
    statusCode: options.statusCode ?? 200,
    headers: {
      "content-type": options.contentType ?? "text/html; charset=utf-8",
    } as IncomingHttpHeaders,
    body: Buffer.from(body, "utf8"),
    finalUrl: options.finalUrl ?? "https://example.com/article",
  };
}

describe("extractFirstUrl", () => {
  it("finds the first http(s) url and ignores surrounding prose", () => {
    expect(
      extractFirstUrl("check this out https://example.com/a and also https://example.com/b"),
    ).toBe("https://example.com/a");
  });

  it("returns null when the body has no url", () => {
    expect(extractFirstUrl("just some text, no links here")).toBeNull();
  });

  it("normalizes case and default port and strips a fragment", () => {
    // URL() lowercases the host, drops :443 as the scheme default, and the
    // fragment never reaches the origin — none of it should survive into the
    // string used as the cache key.
    expect(extractFirstUrl("see https://Example.COM:443/Path#section")).toBe(
      "https://example.com/Path",
    );
  });
});

describeDb("fetchAndCacheEmbed / cache reads", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    vi.mocked(safeFetch).mockReset();
    await getPool().query("TRUNCATE link_embeds");
  });

  it("parses og/twitter tags, decodes entities, and resolves a relative image against the page url", async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(
      htmlResponse(
        `<html><head>
           <meta property="og:title" content="Tom &amp; Jerry" />
           <meta property="og:description" content="A cartoon &mdash; sort of" />
           <meta property="og:site_name" content="Example Site" />
           <meta property="og:image" content="/thumb.png" />
         </head></html>`,
        { finalUrl: "https://example.com/article" },
      ),
    );

    const embed = await fetchAndCacheEmbed("https://example.com/article");

    expect(embed).toMatchObject({
      kind: "link",
      title: "Tom & Jerry",
      siteName: "Example Site",
    });
    // &mdash; is not in the small named-entity table, so it is left as-is
    // rather than mangled — an unrecognised entity must pass through intact.
    expect(embed?.description).toContain("A cartoon");
    expect(embed?.imageUrl).toBe(
      `/api/embeds/${await hashOf("https://example.com/article")}/image`,
    );
  });

  it("caches a page with no OG tags at all as a success, not a failure", async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(
      htmlResponse("<html><head><title>no og tags here</title></head></html>"),
    );

    const embed = await fetchAndCacheEmbed("https://example.com/bare");
    expect(embed).toMatchObject({
      kind: "link",
      title: null,
      description: null,
      imageUrl: null,
    });
    // A "success with nothing found" row is still cached under the short
    // FAILURE_TTL if it were mis-marked failed=true — it must instead be
    // immediately visible through the read-only cache path.
    expect(await getCachedEmbed("https://example.com/bare")).not.toBeNull();
  });

  it("caches an image response directly, without treating it as html", async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce({
      statusCode: 200,
      headers: { "content-type": "image/png" } as IncomingHttpHeaders,
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      finalUrl: "https://example.com/pic.png",
    });

    const embed = await fetchAndCacheEmbed("https://example.com/pic.png");
    expect(embed).toMatchObject({ kind: "image" });
    expect(embed?.imageUrl).toBe(
      `/api/embeds/${await hashOf("https://example.com/pic.png")}/image`,
    );
    expect(await getEmbedImageUrl(await hashOf("https://example.com/pic.png"))).toBe(
      "https://example.com/pic.png",
    );
  });

  it("marks a non-html, non-image response as failed and returns null", async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce({
      statusCode: 200,
      headers: { "content-type": "application/pdf" } as IncomingHttpHeaders,
      body: Buffer.from("%PDF-1.4"),
      finalUrl: "https://example.com/doc.pdf",
    });

    expect(await fetchAndCacheEmbed("https://example.com/doc.pdf")).toBeNull();
    expect(await getCachedEmbed("https://example.com/doc.pdf")).toBeNull();
  });

  it("marks a non-2xx response as failed and returns null", async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(
      htmlResponse("<html>not found</html>", { statusCode: 404 }),
    );
    expect(await fetchAndCacheEmbed("https://example.com/missing")).toBeNull();
  });

  it("marks failed and returns null when the fetch itself throws (blocked, timed out, too large)", async () => {
    vi.mocked(safeFetch).mockRejectedValueOnce(new Error("connection refused"));
    expect(await fetchAndCacheEmbed("https://example.com/down")).toBeNull();
    expect(await getCachedEmbed("https://example.com/down")).toBeNull();
  });

  it("getCachedEmbed hides a stale failed row past its (short) failure TTL", async () => {
    vi.mocked(safeFetch).mockRejectedValueOnce(new Error("boom"));
    await fetchAndCacheEmbed("https://example.com/flaky");
    expect(await getCachedEmbed("https://example.com/flaky")).toBeNull();

    // Backdate the row past FAILURE_TTL_MS (1 hour) directly via SQL — the
    // same seeding approach used for the pinned-messages cap tests, so this
    // proves the TTL check rather than racing a real hour of wall clock.
    await getPool().query(
      `UPDATE link_embeds SET fetched_at = NOW() - INTERVAL '2 hours' WHERE url = $1`,
      ["https://example.com/flaky"],
    );
    vi.mocked(safeFetch).mockResolvedValueOnce(
      htmlResponse(`<meta property="og:title" content="Back up" />`),
    );
    const refetched = await fetchAndCacheEmbed("https://example.com/flaky");
    expect(refetched).toMatchObject({ title: "Back up" });
  });

  it("listEmbedsForMessages batches across messages sharing one url in a single query", async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(
      htmlResponse(`<meta property="og:title" content="Shared link" />`, {
        finalUrl: "https://example.com/shared",
      }),
    );
    await fetchAndCacheEmbed("https://example.com/shared");

    const byMessage = await listEmbedsForMessages([
      { id: "11111111-1111-4111-8111-111111111111", body: "see https://example.com/shared" },
      { id: "22222222-2222-4222-8222-222222222222", body: "same link! https://example.com/shared" },
      { id: "33333333-3333-4333-8333-333333333333", body: "no link in this one" },
    ]);

    expect(byMessage.get("11111111-1111-4111-8111-111111111111")).toMatchObject([
      { title: "Shared link" },
    ]);
    expect(byMessage.get("22222222-2222-4222-8222-222222222222")).toMatchObject([
      { title: "Shared link" },
    ]);
    expect(byMessage.has("33333333-3333-4333-8333-333333333333")).toBe(false);
    // One fetch to populate the cache, one query to read it back for both
    // messages — not one lookup per message.
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it("listEmbedsForMessages omits a failed cache entry", async () => {
    vi.mocked(safeFetch).mockRejectedValueOnce(new Error("boom"));
    await fetchAndCacheEmbed("https://example.com/broken-link");

    const byMessage = await listEmbedsForMessages([
      { id: "44444444-4444-4444-8444-444444444444", body: "https://example.com/broken-link" },
    ]);
    expect(byMessage.size).toBe(0);
  });
});

/** Mirrors the private `hashUrl` in embeds.ts so assertions can predict the
 * proxy path without exporting an internal only tests need. */
async function hashOf(url: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(url).digest("hex");
}

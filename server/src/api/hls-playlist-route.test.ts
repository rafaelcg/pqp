import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * `GET /api/voice/hls-playlist/:channelId/:startedAt` through `handleApi`:
 * the Bearer path is unchanged, and a request with NO Authorization header
 * is let through only when `?t=` verifies for that exact channel and
 * session (Safari's native player and iOS cannot send a header). Both paths
 * end in the same channel-access check, so a token minted for someone who
 * is not in the server is still a 403, not a way around membership.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

let actor: { id: string; clerk_id: string } | null = null;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  resolveAuthSession: async (header: string | undefined) =>
    header && actor ? { user: actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { mintHlsViewerToken } = await import("../voice/hls-viewer-token.js");
const { revokeHlsAccess, resetHlsRevocationsForTests } = await import(
  "../voice/hls-revocation.js"
);
const { resetHlsPlaylistCacheForTests } = await import(
  "../voice/hls-playlist-proxy.js"
);

const STARTED_AT = 1_700_000_000_000;
const PLAYLIST_BODY = [
  "#EXTM3U",
  "#EXT-X-TARGETDURATION:2",
  "#EXTINF:2.0,",
  `${STARTED_AT}_00000.ts`,
].join("\n");

let server: Server;
let baseUrl: string;

async function get(
  path: string,
  as: { id: string; clerk_id: string } | null,
): Promise<{ status: number; text: string; contentType: string | null }> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    headers: as ? { Authorization: "Bearer test" } : {},
  });
  return {
    status: response.status,
    text: await response.text(),
    contentType: response.headers.get("content-type"),
  };
}

/**
 * A request that SENDS a header the auth layer will reject: `actor` is null,
 * so the mocked `resolveAuthSession` answers null for any header, which is
 * exactly what an expired or malformed Clerk JWT does in production.
 *
 * `get` above cannot express this, because it ties "send a header" to "and it
 * works". That coupling is why every test in this file passed while the
 * product was broken.
 */
async function getWithDeadHeader(
  path: string,
  authorization = "Bearer expired.jwt.value",
): Promise<{ status: number; text: string; contentType: string | null }> {
  actor = null;
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: authorization },
  });
  return {
    status: response.status,
    text: await response.text(),
    contentType: response.headers.get("content-type"),
  };
}

describeDb("hls playlist route", () => {
  let owner: { id: string; clerk_id: string };
  let stranger: { id: string; clerk_id: string };
  let channelId: string;
  let otherChannelId: string;

  beforeAll(async () => {
    await initDb();
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => server.listen(0, done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    resetHlsPlaylistCacheForTests();
    resetHlsRevocationsForTests();
    process.env.LIVE_HLS_PUBLIC_BASE_URL = "https://live.example.test";
    process.env.LIVE_HLS_S3_BUCKET = "pqp-live-test";
    process.env.LIVE_HLS_S3_ACCESS_KEY_ID = "ak";
    process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY = "sk";
    process.env.LIVE_HLS_S3_ENDPOINT = "https://s3.example.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        // The proxy's own read is a presigned endpoint-form GET (no public
        // base needed); the old public-base form is kept for the fallback.
        if (
          url.startsWith("https://live.example.test/") ||
          url.includes("s3.example.test/")
        ) {
          return new Response(PLAYLIST_BODY, { status: 200 });
        }
        return realFetch(input, init);
      }),
    );
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, server_invites, server_bans,
                channel_reads, message_mentions, message_reactions,
                message_attachments, user_blocks, dm_pairs, link_embeds,
                hls_sessions
       RESTART IDENTITY CASCADE`,
    );
    owner = await upsertUser({
      clerkId: "clerk_owner",
      displayName: "Owner",
      avatarUrl: null,
    });
    stranger = await upsertUser({
      clerkId: "clerk_stranger",
      displayName: "Stranger",
      avatarUrl: null,
    });
    actor = owner;
    const created = await realFetch(`${baseUrl}/api/servers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test",
      },
      body: JSON.stringify({ name: "Stream" }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      channels: { id: string; type: string }[];
    };
    const voice = body.channels.filter((c) => c.type === "voice");
    channelId = voice[0]!.id;
    otherChannelId =
      voice[1]?.id ?? body.channels.find((c) => c.id !== channelId)!.id;
    for (const id of [channelId, otherChannelId]) {
      await getPool().query(
        `INSERT INTO hls_sessions (channel_id, object_prefix, started_at)
         VALUES ($1, $2, to_timestamp($3 / 1000.0))`,
        [id, `live/${id}/${STARTED_AT}`, STARTED_AT],
      );
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LIVE_HLS_PUBLIC_BASE_URL;
    delete process.env.LIVE_HLS_S3_BUCKET;
    delete process.env.LIVE_HLS_S3_ACCESS_KEY_ID;
    delete process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY;
    delete process.env.LIVE_HLS_S3_ENDPOINT;
  });

  const realFetch = globalThis.fetch;

  function path(id: string, startedAt = STARTED_AT) {
    return `/api/voice/hls-playlist/${id}/${startedAt}`;
  }

  it("Bearer without a token still works", async () => {
    const r = await get(path(channelId), owner);
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("application/vnd.apple.mpegurl");
    expect(r.text).toContain("https://live.example.test/");
  });

  it("no header and no token is 401", async () => {
    expect((await get(path(channelId), null)).status).toBe(401);
  });

  it("a valid token with no header is allowed", async () => {
    const t = mintHlsViewerToken({
      userId: owner.id,
      channelId,
      startedAt: STARTED_AT,
    });
    const r = await get(`${path(channelId)}?t=${t}`, null);
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("application/vnd.apple.mpegurl");
    expect(r.text.split("\n")[3]).toMatch(/^https:\/\/live\.example\.test\//);
  });

  /**
   * THE SHAPE hls.js ACTUALLY SENDS, WITH THE HEADER FAILING.
   *
   * This is the stall that took an afternoon and a screenshot of Rafael's
   * network panel to find, and the reason it survived every test in this file
   * is that the file could not express it: `get` ties "send a header" to "and
   * it works", so the one shape that fails was unreachable.
   *
   * `handleApi` resolves a Bearer ahead of the router, so ANY `Authorization`
   * header had to succeed or the request was 401 before the capability in the
   * URL was ever looked at. hls.js attaches a Clerk JWT on top of `?t=`,
   * refreshes it every 30 s without `forceRefresh`, and a Clerk JWT lives
   * about 60, so roughly once a minute a playlist request carried a dead token
   * and was rejected. Every web viewer, every watch party, since the feature
   * shipped. Proved on production with the same URL and the same valid token:
   * token alone 200, token plus an expired Bearer 401, token plus garbage 401.
   *
   * A capability this server signed itself, naming its user, channel and
   * session, and minted only after a real access check, is strictly stronger
   * evidence than the header that was overruling it.
   */
  describe("a failed Bearer beside a valid capability", () => {
    it("serves the playlist, because the token is the stronger evidence", async () => {
      const t = mintHlsViewerToken({
        userId: owner.id,
        channelId,
        startedAt: STARTED_AT,
      });
      const r = await getWithDeadHeader(`${path(channelId)}?t=${t}`);
      expect(r.status).toBe(200);
      expect(r.contentType).toBe("application/vnd.apple.mpegurl");
      expect(r.text).toContain("#EXTM3U");
    });

    it("does the same for a header that is not even a JWT", async () => {
      const t = mintHlsViewerToken({
        userId: owner.id,
        channelId,
        startedAt: STARTED_AT,
      });
      expect(
        (await getWithDeadHeader(`${path(channelId)}?t=${t}`, "Bearer nonsense"))
          .status,
      ).toBe(200);
    });

    /**
     * The other direction, which must not have moved: without a capability
     * the header IS the only evidence, and a failed one is still a 401. The
     * fix widens exactly one door and nothing else.
     */
    it("is still 401 with a dead header and no token at all", async () => {
      expect((await getWithDeadHeader(path(channelId))).status).toBe(401);
    });

    it("is still 401 when the token names a different session", async () => {
      const t = mintHlsViewerToken({
        userId: owner.id,
        channelId,
        startedAt: STARTED_AT + 1,
      });
      expect(
        (await getWithDeadHeader(`${path(channelId)}?t=${t}`)).status,
      ).toBe(401);
    });

    it("is still 401 when the token is forged", async () => {
      const t = mintHlsViewerToken({
        userId: owner.id,
        channelId,
        startedAt: STARTED_AT,
      })!;
      const forged = `${t.slice(0, t.lastIndexOf(".") + 1)}deadbeef`;
      expect(
        (await getWithDeadHeader(`${path(channelId)}?t=${forged}`)).status,
      ).toBe(401);
    });
  });

  it("a token for another channel or another session is 401", async () => {
    const t = mintHlsViewerToken({
      userId: owner.id,
      channelId,
      startedAt: STARTED_AT,
    });
    expect((await get(`${path(otherChannelId)}?t=${t}`, null)).status).toBe(
      401,
    );
    expect(
      (await get(`${path(channelId, STARTED_AT + 1)}?t=${t}`, null)).status,
    ).toBe(401);
    expect((await get(`${path(channelId)}?t=${t}x`, null)).status).toBe(401);
  });

  /**
   * CONTRACT CHANGE, deliberate. This used to re-check channel access on every
   * playlist request, so a hand-minted token for a stranger was refused here.
   * It is now checked where the token is MINTED instead, which is once per
   * viewer per session rather than every 2 s, so the audience no longer costs
   * a database round trip each. Every mint path is gated: `GET /api/channels/:id/live`
   * calls `requireChannelAccess` first, `broadcastChannelLive` mints only for
   * users the channel audience contains, and the two `voice-stream` mints are
   * for a peer who already holds a seat in the room. So a token for someone
   * without access cannot be obtained, only fabricated, and fabricating one
   * needs the signing key.
   *
   * What still bounds it is revocation (`voice/hls-revocation.ts`), covered
   * below: access taken away after the mint refuses the token within about a
   * segment.
   */
  it("a token is honoured on its own, because access was checked when it was minted", async () => {
    const t = mintHlsViewerToken({
      userId: stranger.id,
      channelId,
      startedAt: STARTED_AT,
    });
    const r = await get(`${path(channelId)}?t=${t}`, null);
    expect(r.status).toBe(200);
  });

  it("a forged token is still refused: the signature is what is trusted", async () => {
    const t = mintHlsViewerToken({
      userId: stranger.id,
      channelId,
      startedAt: STARTED_AT,
    });
    // Same claims, one byte of the signature changed.
    const forged = `${t!.slice(0, -1)}${t!.slice(-1) === "A" ? "B" : "A"}`;
    expect((await get(`${path(channelId)}?t=${forged}`, null)).status).toBe(401);
  });

  /**
   * The render cache serves one body to every viewer of a session, which is
   * only safe while permission is decided OUTSIDE it. These are the tests
   * that hold that line: a warm cache must not become a way in.
   */
  describe("the render cache never stands in for permission", () => {
    it("a stranger is refused even when the body is already cached and warm", async () => {
      // Warm it with someone who may watch.
      expect((await get(path(channelId), owner)).status).toBe(200);
      // Now the same URL, same session, cache hot, from someone who may not.
      const denied = await get(path(channelId), stranger);
      expect([403, 404]).toContain(denied.status);
      // Not one byte of the cached playlist came back.
      expect(denied.text).not.toContain("#EXTM3U");
      expect(denied.text).not.toContain("live.example.test");
      expect(denied.contentType).not.toBe("application/vnd.apple.mpegurl");
    });

    it("an unauthenticated request is refused against a warm cache too", async () => {
      expect((await get(path(channelId), owner)).status).toBe(200);
      const anon = await get(path(channelId), null);
      expect(anon.status).toBe(401);
      expect(anon.text).not.toContain("#EXTM3U");
    });

    it("two DIFFERENT viewers get byte-identical bodies, which is what makes one cache entry legal", async () => {
      // The premise of caching per session rather than per viewer. Segment
      // URLs are signed with the BUCKET's credentials (`signRequest` takes no
      // viewer), so nothing in the body names the person who asked. Proved
      // here with the cache off between the two reads, so this is two real
      // renders agreeing rather than one body handed out twice.
      const second = await upsertUser({
        clerkId: "clerk_second_member",
        displayName: "Second",
        avatarUrl: null,
      });
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role)
         SELECT server_id, $1, 'member' FROM channels WHERE id = $2
         ON CONFLICT DO NOTHING`,
        [second.id, channelId],
      );
      resetHlsPlaylistCacheForTests();
      const a = await get(path(channelId), owner);
      resetHlsPlaylistCacheForTests();
      const b = await get(path(channelId), second);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(b.text).toBe(a.text);
    });

    it("the member still gets a complete, playable window from the cache", async () => {
      const first = await get(path(channelId), owner);
      const second = await get(path(channelId), owner);
      expect(second.status).toBe(200);
      expect(second.contentType).toBe("application/vnd.apple.mpegurl");
      // A hit is the same playable window, not a stub.
      expect(second.text).toBe(first.text);
      expect(second.text).toContain("#EXTM3U");
      const segment = second.text.split("\n")[3]!;
      expect(new URL(segment).searchParams.get("X-Amz-Signature")).toBeTruthy();
    });

    it("bounds how long anything may hold the playlist, and varies on the header", async () => {
      // Same URL for every Bearer viewer, so a shared cache that ignored the
      // header could hand one viewer another's body: `private` + `Vary`.
      actor = owner;
      const response = await fetch(`${baseUrl}${path(channelId)}`, {
        headers: { Authorization: "Bearer test" },
      });
      expect(response.status).toBe(200);
      const cacheControl = response.headers.get("cache-control") ?? "";
      expect(cacheControl).toContain("private");
      expect(cacheControl).toMatch(/max-age=1\b/);
      expect(response.headers.get("vary")).toContain("Authorization");
    });
  });

  /**
   * The reason watch mode works at all above a handful of viewers.
   *
   * Every viewer refetches this playlist every 2 s, and each fetch used to
   * re-ask the database whether the caller may see the channel: two queries,
   * per viewer, forever, drawn from the pool the rest of the app shares. A
   * healthy database serves that in 2 to 3 ms and does not fall over, so this
   * is not about an outage; it is about not spending a connection per viewer
   * per two seconds on a question that was already answered.
   *
   * The `?t=` token is signed by us and names this user, channel and session,
   * and is minted only after a real access check. So it IS the permission,
   * and these requests touch the database zero times.
   */
  describe("a verified token is the capability, so the playlist costs no queries", () => {
    beforeEach(() => {
      resetHlsRevocationsForTests();
    });

    function tokenFor(userId: string, channel = channelId, at?: number) {
      return mintHlsViewerToken({
        userId,
        channelId: channel,
        startedAt: STARTED_AT,
        now: at,
      });
    }

    it("serves a token-only request with ZERO database queries", async () => {
      const t = tokenFor(owner.id);
      // Warm: the first fetch of a session still costs its one session
      // lookup, which the render cache then holds for a second. Every viewer
      // after that, which at 500 viewers is 250 requests a second, costs
      // nothing at all.
      expect((await get(`${path(channelId)}?t=${t}`, null)).status).toBe(200);
      const spy = vi.spyOn(getPool(), "query");
      try {
        for (let i = 0; i < 5; i += 1) {
          const r = await get(`${path(channelId)}?t=${t}`, null);
          expect(r.status).toBe(200);
          expect(r.text).toContain("#EXTM3U");
        }
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("even a cold fetch costs ONE query for a ladder session", async () => {
      // Was: requireChannel + canAccessChannel + the session lookup, per
      // request, per viewer, every 2 seconds. Now the access pair is gone
      // entirely and the lookup is shared for a second.
      //
      // A ladder session's cold fetch is the rung listing and nothing else:
      // the master is built from those rows, so it does not then go and ask
      // whether the session exists.
      await getPool().query(
        `INSERT INTO hls_sessions (channel_id, object_prefix, started_at, rung)
         VALUES ($1, $2, to_timestamp($3 / 1000.0), $4)`,
        [channelId, `live/${channelId}/${STARTED_AT}-720p30`, STARTED_AT, "720p30"],
      );
      resetHlsPlaylistCacheForTests();
      const t = tokenFor(owner.id);
      const spy = vi.spyOn(getPool(), "query");
      try {
        expect((await get(`${path(channelId)}?t=${t}`, null)).status).toBe(200);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(String(spy.mock.calls[0]![0])).toContain("hls_sessions");
      } finally {
        spy.mockRestore();
      }
    });

    it("a PRE-LADDER session costs two cold, then none, and says so", async () => {
      // The one honest regression from the master playlist. A session with no
      // rung rows is asked about twice on a cold fetch: once for its rungs
      // (none) and once for the row itself. Both answers are cached for the
      // same second, so it is one extra query per session per second, and
      // only for sessions that started before the ladder shipped.
      resetHlsPlaylistCacheForTests();
      const t = tokenFor(owner.id);
      const spy = vi.spyOn(getPool(), "query");
      try {
        expect((await get(`${path(channelId)}?t=${t}`, null)).status).toBe(200);
        expect(spy).toHaveBeenCalledTimes(2);
        spy.mockClear();
        expect((await get(`${path(channelId)}?t=${t}`, null)).status).toBe(200);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("serves hls.js (header AND token) with zero queries too", async () => {
      // The browser path sends both. If the header won, every browser viewer
      // would still cost an access check every 2 s, which is the whole bug.
      const t = tokenFor(owner.id);
      expect((await get(`${path(channelId)}?t=${t}`, owner)).status).toBe(200);
      const spy = vi.spyOn(getPool(), "query");
      try {
        const r = await get(`${path(channelId)}?t=${t}`, owner);
        expect(r.status).toBe(200);
        expect(r.text).toContain("#EXTM3U");
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("a header-only request still pays for the access check", async () => {
      // Not a regression: identity is not permission, so this one must ask.
      const spy = vi.spyOn(getPool(), "query");
      try {
        expect((await get(path(channelId), owner)).status).toBe(200);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("refuses a revoked viewer within the window, even with a valid token", async () => {
      const t = tokenFor(owner.id, channelId, Date.now() - 5_000);
      expect((await get(`${path(channelId)}?t=${t}`, null)).status).toBe(200);

      // Banned, kicked, or the role lost VIEW: whatever it was, the same
      // eviction that drops them from the channel view revokes this.
      revokeHlsAccess(channelId, { onlyUserIds: [owner.id] });

      const denied = await get(`${path(channelId)}?t=${t}`, null);
      expect([403, 404]).toContain(denied.status);
      expect(denied.text).not.toContain("#EXTM3U");
      expect(denied.text).not.toContain("live.example.test");
    });

    it("a revocation does not hold out a token minted after it (banned, then unbanned)", async () => {
      revokeHlsAccess(channelId, { onlyUserIds: [owner.id] }, Date.now() - 1000);
      // Re-admitted: a fresh token postdates the revocation, so it works
      // without waiting anything out.
      const fresh = tokenFor(owner.id);
      expect((await get(`${path(channelId)}?t=${fresh}`, null)).status).toBe(200);
    });

    it("revoking one viewer does not cut off the rest of the audience", async () => {
      // Minted in the past on purpose: a revocation stamped in the same
      // millisecond as the token would be skipped as "older than the grant"
      // and this would pass without proving anything.
      const t = tokenFor(owner.id, channelId, Date.now() - 5_000);
      revokeHlsAccess(channelId, { onlyUserIds: ["someone-else"] });
      expect((await get(`${path(channelId)}?t=${t}`, null)).status).toBe(200);
    });

    it("refuses an expired token", async () => {
      const stale = mintHlsViewerToken({
        userId: owner.id,
        channelId,
        startedAt: STARTED_AT,
        now: Date.now() - 2 * 60 * 60 * 1000,
      });
      expect((await get(`${path(channelId)}?t=${stale}`, null)).status).toBe(401);
    });

    it("a token naming someone else does not become the Bearer caller's capability", async () => {
      // A member could otherwise paste somebody else's token onto their own
      // request and skip their own access check. A mismatch falls back to the
      // header, which is checked against the database as it always was: the
      // stranger is not in this server, so they are refused.
      const ownersToken = tokenFor(owner.id);
      const r = await get(`${path(channelId)}?t=${ownersToken}`, stranger);
      expect([403, 404]).toContain(r.status);
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The signed playlist proxy: rewrites a fetched playlist's segment lines
 * into absolute presigned URLs, each carrying `LIVE_HLS_URL_TTL_SECONDS` as
 * its `X-Amz-Expires`. The DB lookup and the raw fetch are faked; the
 * signing itself is real, so what this pins is the actual TTL that lands
 * on each URL and that only segment/media lines get rewritten.
 */

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const STARTED_AT = 1_700_000_000_000;
const OTHER_CHANNEL = "00000000-0000-4000-8000-0000000000bb";

const pool = vi.hoisted(() => ({
  rowCount: 1,
  query: vi.fn(async (_sql: string, _params?: unknown[]) => ({
    rowCount: pool.rowCount,
    rows: [],
  })),
}));
vi.mock("../db.js", () => ({ getPool: () => pool }));

const PLAYLIST_BODY = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:2",
  "#EXTINF:2.0,",
  `${STARTED_AT}_00000.ts`,
  "#EXTINF:2.0,",
  `${STARTED_AT}_00001.ts`,
].join("\n");

function enableHls() {
  process.env.LIVE_HLS_PUBLIC_BASE_URL = "https://live.example.test";
  process.env.LIVE_HLS_S3_BUCKET = "pqp-live-test";
  process.env.LIVE_HLS_S3_ACCESS_KEY_ID = "ak";
  process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY = "sk";
  process.env.LIVE_HLS_S3_ENDPOINT = "https://s3.example.test";
}

function disableHls() {
  delete process.env.LIVE_HLS_PUBLIC_BASE_URL;
  delete process.env.LIVE_HLS_S3_BUCKET;
  delete process.env.LIVE_HLS_S3_ACCESS_KEY_ID;
  delete process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY;
  delete process.env.LIVE_HLS_S3_ENDPOINT;
  delete process.env.LIVE_HLS_URL_TTL_SECONDS;
}

const {
  buildSignedPlaylist,
  HlsPlaylistNotFound,
  HlsPlaylistUnavailable,
  resolveHlsPlaylistViewer,
  HLS_PLAYLIST_CACHE_TTL_MS,
  resetHlsPlaylistCacheForTests,
} = await import("./hls-playlist-proxy.js");
const { mintHlsViewerToken } = await import("./hls-viewer-token.js");

describe("resolveHlsPlaylistViewer", () => {
  const USER = "00000000-0000-4000-8000-0000000000u1";

  it("a valid token with no Bearer names the user it was minted for", () => {
    const token = mintHlsViewerToken({
      userId: USER,
      channelId: CHANNEL,
      startedAt: STARTED_AT,
    });
    expect(token).not.toBeNull();
    expect(
      resolveHlsPlaylistViewer({
        bearerUserId: null,
        token,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      }),
    ).toEqual({ userId: USER, issuedAt: expect.any(Number) });
  });

  it("a token for another channel or another session is refused", () => {
    const token = mintHlsViewerToken({
      userId: USER,
      channelId: CHANNEL,
      startedAt: STARTED_AT,
    });
    expect(
      resolveHlsPlaylistViewer({
        bearerUserId: null,
        token,
        channelId: "00000000-0000-4000-8000-0000000000bb",
        startedAt: STARTED_AT,
      }),
    ).toBeNull();
    expect(
      resolveHlsPlaylistViewer({
        bearerUserId: null,
        token,
        channelId: CHANNEL,
        startedAt: STARTED_AT + 1,
      }),
    ).toBeNull();
    expect(
      resolveHlsPlaylistViewer({
        bearerUserId: null,
        token: `${token}x`,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      }),
    ).toBeNull();
  });

  it("no token and no Bearer is nobody", () => {
    expect(
      resolveHlsPlaylistViewer({
        bearerUserId: null,
        token: null,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      }),
    ).toBeNull();
  });

  /**
   * PRECEDENCE INVERTED, deliberately. The Bearer header used to win, which
   * meant hls.js (which sends both) still paid a per-request database access
   * check every 2 seconds per viewer. The token is the capability now, so a
   * valid one for THIS caller wins and the request touches no database.
   */
  it("a token naming the Bearer caller wins, and carries when it was minted", () => {
    const token = mintHlsViewerToken({
      userId: USER,
      channelId: CHANNEL,
      startedAt: STARTED_AT,
    });
    expect(
      resolveHlsPlaylistViewer({
        bearerUserId: USER,
        token,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      }),
    ).toEqual({ userId: USER, issuedAt: expect.any(Number) });
  });

  it("a token naming someone else falls back to the Bearer user, with no capability", () => {
    // `issuedAt: null` is what tells the route to run the access check: a
    // header proves who you are, never what you may watch.
    const token = mintHlsViewerToken({
      userId: USER,
      channelId: CHANNEL,
      startedAt: STARTED_AT,
    });
    expect(
      resolveHlsPlaylistViewer({
        bearerUserId: "bearer-user",
        token,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      }),
    ).toEqual({ userId: "bearer-user", issuedAt: null });
  });

  it("a Bearer caller with no token gets no capability either", () => {
    expect(
      resolveHlsPlaylistViewer({
        bearerUserId: "bearer-user",
        token: null,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      }),
    ).toEqual({ userId: "bearer-user", issuedAt: null });
  });
});

describe("buildSignedPlaylist", () => {
  beforeEach(() => {
    disableHls();
    enableHls();
    resetHlsPlaylistCacheForTests();
    pool.rowCount = 1;
    pool.query.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(PLAYLIST_BODY, { status: 200 })),
    );
  });

  afterEach(() => {
    disableHls();
    vi.unstubAllGlobals();
  });

  it("rewrites only the segment lines into absolute presigned URLs with the configured TTL", async () => {
    process.env.LIVE_HLS_URL_TTL_SECONDS = "120";
    const body = await buildSignedPlaylist(CHANNEL, STARTED_AT);
    const lines = body.split("\n");

    expect(lines[0]).toBe("#EXTM3U");
    expect(lines[1]).toBe("#EXT-X-VERSION:3");
    expect(lines[2]).toBe("#EXT-X-TARGETDURATION:2");
    expect(lines[3]).toBe("#EXTINF:2.0,");

    const segmentLine = lines[4]!;
    expect(segmentLine).toMatch(/^https:\/\/live\.example\.test\//);
    expect(segmentLine).toContain(`${STARTED_AT}_00000.ts`);
    const url = new URL(segmentLine);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");

    const secondSegmentLine = lines[6]!;
    expect(secondSegmentLine).toContain(`${STARTED_AT}_00001.ts`);
  });

  it("defaults the TTL to 900 seconds when LIVE_HLS_URL_TTL_SECONDS is unset", async () => {
    const body = await buildSignedPlaylist(CHANNEL, STARTED_AT);
    const segmentLine = body.split("\n")[4]!;
    const url = new URL(segmentLine);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
  });

  it("throws HlsPlaylistNotFound when no session row matches (e.g. cleaned up already)", async () => {
    pool.rowCount = 0;
    await expect(buildSignedPlaylist(CHANNEL, STARTED_AT)).rejects.toThrow(
      HlsPlaylistNotFound,
    );
  });

  it("throws HlsPlaylistUnavailable when Live HLS storage is not configured", async () => {
    disableHls();
    await expect(buildSignedPlaylist(CHANNEL, STARTED_AT)).rejects.toThrow(
      HlsPlaylistUnavailable,
    );
  });

  it("BROKEN GUARD: the session lookup is scoped to this exact channel_id + prefix, not just any live session", async () => {
    // Prove the query pool receives BOTH the channel id and the exact
    // object_prefix, not (say) "any session for this channel" -- which
    // would let a stale/guessed startedAt serve a different session's
    // stream. Simulated here by asserting the actual bound parameters.
    await buildSignedPlaylist(CHANNEL, STARTED_AT);
    const [, params] = pool.query.mock.calls[0]!;
    expect(params).toEqual([CHANNEL, `live/${CHANNEL}/${STARTED_AT}`]);
  });
});

/**
 * The playlist render cache. Every viewer refetches this route every 2 s, so
 * before this the audience cost landed on our own CPU: a Postgres lookup, an
 * upstream GET from R2 and a signature per segment line, PER VIEWER. The body
 * is identical for everyone watching one session (it carries no viewer
 * identity; segments are signed with the bucket's own credentials), so it is
 * rendered once per session per second instead.
 *
 * The property that matters most here is the one that is NOT cached:
 * permission. The cache key is the session and nothing else, and the route
 * runs `requireChannelAccess` before ever calling this, so a cached body can
 * never reach someone who could not have rendered it themselves. The
 * "BROKEN KEY" test below proves the key carries no viewer identity that
 * could be spoofed into a hit.
 */
describe("playlist render cache", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disableHls();
    enableHls();
    resetHlsPlaylistCacheForTests();
    pool.rowCount = 1;
    pool.query.mockClear();
    fetchMock = vi.fn(async () => new Response(PLAYLIST_BODY, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    disableHls();
    resetHlsPlaylistCacheForTests();
    vi.unstubAllGlobals();
  });

  it("two concurrent viewers of one session cost a single upstream fetch", async () => {
    const [a, b] = await Promise.all([
      buildSignedPlaylist(CHANNEL, STARTED_AT),
      buildSignedPlaylist(CHANNEL, STARTED_AT),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Byte-identical: this is why one body may serve both.
    expect(a).toBe(b);
    // And the DB lookup was not repeated either.
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("a whole room joining at once still costs one fetch", async () => {
    const bodies = await Promise.all(
      Array.from({ length: 50 }, () => buildSignedPlaylist(CHANNEL, STARTED_AT)),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Set(bodies).size).toBe(1);
  });

  it("a viewer inside the TTL is served the cached body, one after it is not", async () => {
    const now = 1_800_000_000_000;
    await buildSignedPlaylist(CHANNEL, STARTED_AT, now);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Still fresh.
    await buildSignedPlaylist(CHANNEL, STARTED_AT, now + HLS_PLAYLIST_CACHE_TTL_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past the TTL: rendered again, so the live window keeps moving.
    await buildSignedPlaylist(CHANNEL, STARTED_AT, now + HLS_PLAYLIST_CACHE_TTL_MS + 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not serve one session's playlist for another", async () => {
    await buildSignedPlaylist(CHANNEL, STARTED_AT);
    await buildSignedPlaylist(CHANNEL, STARTED_AT + 1);
    await buildSignedPlaylist(OTHER_CHANNEL, STARTED_AT);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not cache a failure: the next viewer retries rather than inheriting a 404", async () => {
    pool.rowCount = 0;
    await expect(buildSignedPlaylist(CHANNEL, STARTED_AT)).rejects.toThrow(
      HlsPlaylistNotFound,
    );
    pool.rowCount = 1;
    await expect(
      buildSignedPlaylist(CHANNEL, STARTED_AT),
    ).resolves.toContain("#EXTM3U");
  });

  it("the cached body still carries segment URLs that work for the viewer who gets it", async () => {
    process.env.LIVE_HLS_URL_TTL_SECONDS = "120";
    const first = await buildSignedPlaylist(CHANNEL, STARTED_AT);
    const second = await buildSignedPlaylist(CHANNEL, STARTED_AT);
    expect(second).toBe(first);
    // A cache hit is a complete, playable window, not a stub: same segments,
    // still absolute, still presigned with the configured expiry.
    const segment = second.split("\n")[4]!;
    const url = new URL(segment);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(segment).toContain(`${STARTED_AT}_00000.ts`);
  });

  it("BROKEN KEY: the cache key is the session, so it carries nothing a viewer could vary", async () => {
    // The guard this file exists for. `buildSignedPlaylist` is reachable only
    // behind `requireChannelAccess`, and it takes no viewer at all, so there
    // is no argument a caller could pass that turns one person's body into
    // another person's hit. Asserted structurally: two required parameters,
    // the channel and the session, and nothing that names a person.
    // (`Function.length` stops counting at the first default, so the
    // optional `now` is not included.)
    expect(buildSignedPlaylist.length).toBe(2);
    const a = await buildSignedPlaylist(CHANNEL, STARTED_AT);
    resetHlsPlaylistCacheForTests();
    const b = await buildSignedPlaylist(CHANNEL, STARTED_AT);
    // Two independent renders of the same session agree, which is the
    // premise that makes sharing one body between viewers correct.
    expect(a).toBe(b);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyHlsPartyPass } from "./hls-viewer-token.js";

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
const USER = "00000000-0000-4000-8000-0000000000cc";

const pool = vi.hoisted(() => ({
  rowCount: 1,
  query: vi.fn(async (_sql: string, _params?: unknown[]) => ({
    rowCount: pool.rowCount,
    rows: [] as { rung: string }[],
  })),
}));
/**
 * `DatabaseUnavailableError` has to exist on the mock (even though nothing
 * in this suite constructs it, other than the "A3.1" tests below) or
 * `error instanceof DatabaseUnavailableError` inside `hls-playlist-proxy.ts`'s
 * catch blocks throws on `undefined` for every other test in this file.
 * Defined inside `vi.hoisted` (not a plain top-level `class`) because
 * `vi.mock`'s factory is itself hoisted above ordinary module code — a class
 * declared below it in source would still be in its temporal dead zone when
 * the factory runs.
 */
const MockDatabaseUnavailableError = vi.hoisted(
  () =>
    class MockDatabaseUnavailableError extends Error {},
);
vi.mock("../db.js", () => ({
  getPool: () => pool,
  DatabaseUnavailableError: MockDatabaseUnavailableError,
}));

// Carries a real `#EXT-X-PROGRAM-DATE-TIME` per segment, matching what
// production's egress actually writes (BROADCAST_PIPELINE B0.2), so a test
// that forces two independent renders of the same session (cache reset in
// between) is not incidentally exercising the proxy's synthesised-PDT
// fallback, whose wall clock legitimately differs between two real renders.
const PLAYLIST_BODY = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:2",
  "#EXT-X-MEDIA-SEQUENCE:0",
  "#EXT-X-PROGRAM-DATE-TIME:2026-09-12T10:10:39.718Z",
  "#EXTINF:2.0,",
  `${STARTED_AT}_00000.ts`,
  "#EXT-X-PROGRAM-DATE-TIME:2026-09-12T10:10:41.718Z",
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
  buildMasterPlaylistFor,
  buildSignedPlaylist,
  HlsPlaylistNotFound,
  HlsPlaylistUnavailable,
  resolveHlsPlaylistViewer,
  HLS_PLAYLIST_CACHE_TTL_MS,
  STALE_ON_BREAKER_MAX_MS,
  HLS_LIVENESS_WAIT_MS,
  hlsPlaylistRendersWithoutDb,
  resetHlsPlaylistCacheForTests,
  segmentSigningTime,
  SEGMENT_URL_BUCKET_MAX_MS,
  HLS_KEEP_WARM_INTERVAL_MS,
  HLS_KEEP_WARM_IDLE_MS,
  hlsKeepWarmLoopsActive,
  hlsKeepWarmRenders,
  resolveHlsSessionId,
} = await import("./hls-playlist-proxy.js");
const { mintHlsViewerToken } = await import("./hls-viewer-token.js");
const { playlistLooksLive } = await import("@pqp/shared");

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
    expect(lines[3]).toBe("#EXT-X-MEDIA-SEQUENCE:0");
    // The egress's own `#EXT-X-PROGRAM-DATE-TIME`, copied through untouched
    // (BROADCAST_PIPELINE B0.2 -- production writes one already).
    expect(lines[4]).toBe("#EXT-X-PROGRAM-DATE-TIME:2026-09-12T10:10:39.718Z");
    expect(lines[5]).toBe("#EXTINF:2.0,");

    const segmentLine = lines[6]!;
    expect(segmentLine).toMatch(/^https:\/\/live\.example\.test\//);
    expect(segmentLine).toContain(`${STARTED_AT}_00000.ts`);
    const url = new URL(segmentLine);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");

    const secondSegmentLine = lines[9]!;
    expect(secondSegmentLine).toContain(`${STARTED_AT}_00001.ts`);
  });

  it("defaults the TTL to 900 seconds when LIVE_HLS_URL_TTL_SECONDS is unset", async () => {
    const body = await buildSignedPlaylist(CHANNEL, STARTED_AT);
    const segmentLine = body.split("\n")[6]!;
    const url = new URL(segmentLine);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
  });

  it("signs every segment for an immutable response, since a segment never changes once written", async () => {
    // The egress cannot set Cache-Control at PUT time (LiveKit egress 1.14's
    // S3Upload has no such field -- see the doc comment on
    // SEGMENT_CACHE_CONTROL). This is the fallback: an S3 `response-*`
    // override, signed into the URL, that makes THIS GET answer immutable
    // regardless of what (if anything) is stored on the object.
    const body = await buildSignedPlaylist(CHANNEL, STARTED_AT);
    // Index 6, not 5 -- the egress's #EXT-X-PROGRAM-DATE-TIME line (B0.2)
    // sits at index 4, same as the other tests in this file.
    const segmentLine = body.split("\n")[6]!;
    const url = new URL(segmentLine);
    expect(url.searchParams.get("response-cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
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
    await buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, now);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Still fresh.
    await buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, now + HLS_PLAYLIST_CACHE_TTL_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past the TTL: rendered again, so the live window keeps moving.
    await buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, now + HLS_PLAYLIST_CACHE_TTL_MS + 1);
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

  /**
   * A3.1 (docs/plans/ALWAYS_ON.md): the party keeps playing through a DB
   * blip. Distinct from the test above on purpose — a `DatabaseUnavailableError`
   * (the breaker is open) must fall back to the last good body, while a real
   * `HlsPlaylistNotFound` (the session actually ended) must still 404, or a
   * stale window would go on being served for a stream that is over.
   */
  /**
   * THE 2026-09-23 BLIP. Postgres was unreachable for 61 s. A replayed body
   * does not advance, so a live player sits on its last listed segment and
   * stalls; what keeps it playing is a FRESH render from storage, which the
   * egress goes on writing whatever the database is doing.
   */
  it("DB down: a session confirmed live keeps rendering FRESH from storage, so the window advances", async () => {
    const now = 1_800_000_000_000;
    const first = await buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, now);
    expect(first).not.toContain(`${STARTED_AT}_00002.ts`);

    pool.query.mockImplementation(async () => {
      throw new MockDatabaseUnavailableError();
    });
    try {
      fetchMock.mockImplementation(
        async () =>
          new Response(
            [
              PLAYLIST_BODY,
              "#EXT-X-PROGRAM-DATE-TIME:2026-09-12T10:10:43.718Z",
              "#EXTINF:2.0,",
              `${STARTED_AT}_00002.ts`,
            ].join("\n"),
            { status: 200 },
          ),
      );
      const during = await buildSignedPlaylist(
        CHANNEL,
        STARTED_AT,
        undefined,
        now + 90_000,
      );
      expect(during).toContain(`${STARTED_AT}_00002.ts`);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(hlsPlaylistRendersWithoutDb()).toBe(1);
    } finally {
      pool.query.mockReset();
      pool.query.mockImplementation(async () => ({
        rowCount: pool.rowCount,
        rows: [],
      }));
    }
  });

  it("DB down: a viewer's very first request is not served on trust nobody established", async () => {
    pool.query.mockImplementationOnce(async () => {
      throw new MockDatabaseUnavailableError();
    });
    await expect(buildSignedPlaylist(CHANNEL, STARTED_AT)).rejects.toThrow(
      MockDatabaseUnavailableError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DB down: past STALE_ON_BREAKER_MAX_MS since the last confirmation, the outage is reported rather than ridden out", async () => {
    const now = 1_800_000_000_000;
    await buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, now);
    pool.query.mockImplementationOnce(async () => {
      throw new MockDatabaseUnavailableError();
    });
    // Just inside the bound: still rendered.
    await expect(
      buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, now + STALE_ON_BREAKER_MAX_MS),
    ).resolves.toContain("#EXTM3U");
    pool.query.mockImplementationOnce(async () => {
      throw new MockDatabaseUnavailableError();
    });
    // Past it (and past the render cache's own TTL): the error propagates.
    await expect(
      buildSignedPlaylist(
        CHANNEL,
        STARTED_AT,
        undefined,
        now + STALE_ON_BREAKER_MAX_MS + HLS_PLAYLIST_CACHE_TTL_MS + 1,
      ),
    ).rejects.toThrow(MockDatabaseUnavailableError);
  });

  it("any DB failure counts, not only the breaker's: the seconds before it opens arrive as connection timeouts", async () => {
    const now = 1_800_000_000_000;
    await buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, now);
    pool.query.mockImplementationOnce(async () => {
      throw new Error("Connection terminated due to connection timeout");
    });
    await expect(
      buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, now + 5_000),
    ).resolves.toContain("#EXTM3U");
  });

  it("a SLOW database does not hold the playlist for query_timeout, and a late 'ended' still ends it", async () => {
    const now = 1_800_000_000_000;
    await buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, now);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let answer!: (value: { rowCount: number; rows: { id: string }[] }) => void;
      pool.query.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }) as never,
      );
      const render = buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, now + 2_000);
      await vi.advanceTimersByTimeAsync(HLS_LIVENESS_WAIT_MS);
      await expect(render).resolves.toContain("#EXTM3U");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // The lookup was never abandoned: it lands late, and says "over".
      answer({ rowCount: 0, rows: [] });
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
    // With the confirmation gone, the next render asks and waits again, and
    // a database that still cannot answer is now an error, not a free pass.
    pool.query.mockImplementationOnce(async () => {
      throw new MockDatabaseUnavailableError();
    });
    await expect(
      buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, now + 4_000),
    ).rejects.toThrow(MockDatabaseUnavailableError);
  });

  it("A3.1: a genuinely ended session still 404s even while the same error type is in play elsewhere", async () => {
    await buildSignedPlaylist(CHANNEL, STARTED_AT);
    pool.rowCount = 0;
    await expect(
      buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, Date.now() + HLS_PLAYLIST_CACHE_TTL_MS + 1),
    ).rejects.toThrow(HlsPlaylistNotFound);
  });

  it("one rendition ending does not take its siblings' outage fallback away", async () => {
    const now = 1_800_000_000_000;
    await buildSignedPlaylist(CHANNEL, STARTED_AT, "720p30", now);
    await buildSignedPlaylist(CHANNEL, STARTED_AT, "360p30", now);
    // 360p's row is ended (a ladder trimmed mid-party)...
    pool.query.mockImplementationOnce(async () => ({ rowCount: 0, rows: [] }));
    await expect(
      buildSignedPlaylist(CHANNEL, STARTED_AT, "360p30", now + 2_000),
    ).rejects.toThrow(HlsPlaylistNotFound);
    // ...then the database goes away: 720p still rides it out, 360p does not.
    pool.query.mockImplementationOnce(async () => {
      throw new MockDatabaseUnavailableError();
    });
    await expect(
      buildSignedPlaylist(CHANNEL, STARTED_AT, "720p30", now + 4_000),
    ).resolves.toContain("#EXTM3U");
    pool.query.mockImplementationOnce(async () => {
      throw new MockDatabaseUnavailableError();
    });
    await expect(
      buildSignedPlaylist(CHANNEL, STARTED_AT, "360p30", now + 4_000),
    ).rejects.toThrow(MockDatabaseUnavailableError);
  });

  it("refreshes against a slow database share ONE outstanding liveness query per rendition", async () => {
    const now = 1_800_000_000_000;
    await buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, now);
    expect(pool.query).toHaveBeenCalledTimes(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      pool.query.mockImplementation(() => new Promise(() => {}) as never);
      for (let i = 1; i <= 5; i += 1) {
        const render = buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, now + i * 2_000);
        await vi.advanceTimersByTimeAsync(HLS_LIVENESS_WAIT_MS);
        await expect(render).resolves.toContain("#EXTM3U");
      }
      // Five refreshes, five fresh renders from storage, one query.
      expect(pool.query).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
      pool.query.mockReset();
      pool.query.mockImplementation(async () => ({ rowCount: pool.rowCount, rows: [] }));
    }
  });

  it("the cached body still carries segment URLs that work for the viewer who gets it", async () => {
    process.env.LIVE_HLS_URL_TTL_SECONDS = "120";
    const first = await buildSignedPlaylist(CHANNEL, STARTED_AT);
    const second = await buildSignedPlaylist(CHANNEL, STARTED_AT);
    expect(second).toBe(first);
    // A cache hit is a complete, playable window, not a stub: same segments,
    // still absolute, still presigned with the configured expiry.
    const segment = second.split("\n")[6]!;
    const url = new URL(segment);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(segment).toContain(`${STARTED_AT}_00000.ts`);
  });

  it("BROKEN KEY: the cache key is the session, so it carries nothing a viewer could vary", async () => {
    // The guard this file exists for. `buildSignedPlaylist` is reachable only
    // behind `requireChannelAccess`, and it takes no viewer at all, so there
    // is no argument a caller could pass that turns one person's body into
    // another person's hit. Asserted structurally: three parameters, the
    // channel, the session and which RENDITION of it, and nothing that names
    // a person. (`Function.length` stops counting at the first default, so
    // the optional `now` is not included.)
    expect(buildSignedPlaylist.length).toBe(3);
    const a = await buildSignedPlaylist(CHANNEL, STARTED_AT);
    resetHlsPlaylistCacheForTests();
    const b = await buildSignedPlaylist(CHANNEL, STARTED_AT);
    // Two independent renders of the same session agree, which is the
    // premise that makes sharing one body between viewers correct.
    expect(a).toBe(b);
  });
});

/**
 * A SEGMENT KEEPS ITS URL FOR AS LONG AS IT IS LISTED.
 *
 * The native stall of 2026-09-12. RFC 8216 6.2.1 lets a live playlist append
 * and remove entries and do nothing else to them, because the URI is the
 * segment's identity. This proxy re-renders once a second and signed every
 * line with the clock of that render, so one segment arrived under a new
 * `X-Amz-Date` and a new signature every time: hls.js keys fragments by media
 * sequence and never saw it, `AVPlayer` keys on the URI and refetched its own
 * buffer every couple of seconds, which is the ten-to-fifteen second hitch.
 *
 * These tests read the URL that lands in the body, not the helper, because
 * the helper being right is not the property that broke.
 */
describe("segment URLs are stable across playlist refreshes", () => {
  /** `20260912T143650Z` to epoch milliseconds. */
  function amzDateMs(url: URL): number {
    const raw = url.searchParams.get("X-Amz-Date")!;
    const iso =
      `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` +
      `T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`;
    return Date.parse(iso);
  }

  function segmentUrls(body: string): string[] {
    return body.split("\n").filter((line) => line.startsWith("https://"));
  }

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

  it("two renders 1.5 s apart list the same segment under the same URL", async () => {
    // Well inside one bucket, and past `HLS_PLAYLIST_CACHE_TTL_MS` so this is
    // genuinely two renders rather than one body served twice: the upstream
    // fetch count is what proves the render ran again.
    const now = 1_800_000_000_000;
    const first = await buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, now);
    const second = await buildSignedPlaylist(
      CHANNEL,
      STARTED_AT,
      undefined,
      now + 1_500,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(segmentUrls(second)).toEqual(segmentUrls(first));
    expect(segmentUrls(first)).toHaveLength(2);
    // And the stamp is the render's own clock, bucketed. Asserted because
    // the render used to sign with `new Date()` regardless of what it was
    // told the time was, so the two bodies above agreeing would have proved
    // nothing but that the test ran fast.
    expect(amzDateMs(new URL(segmentUrls(first)[0]!))).toBe(
      segmentSigningTime(now, 900).getTime(),
    );
  });

  it("a whole window's worth of refreshes never restates a segment", async () => {
    const now = 1_800_000_000_000;
    const seen = new Set<string>();
    // 15 renders, one per second: a full 30 s window on the production cadence.
    for (let i = 0; i < 15; i++) {
      const body = await buildSignedPlaylist(
        CHANNEL,
        STARTED_AT,
        undefined,
        now + i * 1_100,
      );
      for (const url of segmentUrls(body)) {
        seen.add(url);
      }
    }
    expect(fetchMock).toHaveBeenCalledTimes(15);
    // Two segments in the fixture, so two URLs in total. Before the fix this
    // was one per segment per render: thirty.
    expect(seen.size).toBe(2);
  });

  it("crossing a bucket boundary keeps a still-listed segment's URL byte-identical", async () => {
    // The residual churn #494's bucket left behind: the same two segments are
    // still listed a whole bucket later, so the render past the boundary must
    // NOT restate them (AVPlayer would refetch its buffer). The memo freezes
    // the URL each segment was first handed out under.
    const bucket = SEGMENT_URL_BUCKET_MAX_MS;
    const now = Math.floor(1_800_000_000_000 / bucket) * bucket + 1_000;
    const before = await buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, now);
    const after = await buildSignedPlaylist(
      CHANNEL,
      STARTED_AT,
      undefined,
      now + bucket,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(segmentUrls(after)).toEqual(segmentUrls(before));

    // The frozen URL was signed in the FIRST bucket and is still live when
    // re-served a whole bucket later.
    const url = new URL(segmentUrls(after)[0]!);
    const signedAt = amzDateMs(url);
    const expires = Number(url.searchParams.get("X-Amz-Expires")) * 1_000;
    expect(signedAt).toBe(segmentSigningTime(now, 900).getTime());
    expect(signedAt + expires).toBeGreaterThan(now + bucket);
  });

  it("across a bucket boundary, a newly appearing segment is signed afresh and a departed one is dropped", async () => {
    process.env.LIVE_HLS_WINDOW_SEGMENTS = "3";
    const bucket = SEGMENT_URL_BUCKET_MAX_MS;
    const t0 = Math.floor(1_800_000_000_000 / bucket) * bucket + 1_000;

    const seg = (n: number) => `${STARTED_AT}_${String(n).padStart(5, "0")}.ts`;
    const advancing = (base: number) =>
      [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:2",
        `#EXT-X-MEDIA-SEQUENCE:${base}`,
        "#EXTINF:2.0,",
        seg(base),
        "#EXTINF:2.0,",
        seg(base + 1),
      ].join("\n");
    const urlFor = (body: string, n: number) =>
      segmentUrls(body).find((u) => u.includes(seg(n)));

    try {
      fetchMock.mockResolvedValueOnce(new Response(advancing(0), { status: 200 }));
      const first = await buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, t0);
      // A bucket later, the live window has slid to {1,2,3}: seg 1 stays, 2/3
      // are new, 0 has left the 3-segment window.
      fetchMock.mockResolvedValueOnce(new Response(advancing(2), { status: 200 }));
      const second = await buildSignedPlaylist(
        CHANNEL,
        STARTED_AT,
        undefined,
        t0 + bucket,
      );

      // Still listed: identical URL, signed in the first bucket.
      expect(urlFor(second, 1)).toBe(urlFor(first, 1));
      expect(amzDateMs(new URL(urlFor(second, 1)!))).toBe(
        segmentSigningTime(t0, 900).getTime(),
      );
      // Newly appearing: signed in the SECOND bucket.
      expect(amzDateMs(new URL(urlFor(second, 3)!))).toBe(
        segmentSigningTime(t0 + bucket, 900).getTime(),
      );
      // Departed: seg 0's URL is gone from the window entirely.
      expect(segmentUrls(second).some((u) => u.includes(seg(0)))).toBe(false);
    } finally {
      delete process.env.LIVE_HLS_WINDOW_SEGMENTS;
    }
  });

  it("resetHlsPlaylistCacheForTests clears the segment URL memo", async () => {
    const bucket = SEGMENT_URL_BUCKET_MAX_MS;
    const t0 = Math.floor(1_800_000_000_000 / bucket) * bucket + 1_000;
    const before = await buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, t0);
    resetHlsPlaylistCacheForTests();
    // Same two segments a bucket later: without the reset the memo would hand
    // back byte-identical URLs, so the only way these can differ is that the
    // reset cleared the memo and the segments were signed afresh.
    const after = await buildSignedPlaylist(
      CHANNEL,
      STARTED_AT,
      undefined,
      t0 + bucket,
    );
    expect(segmentUrls(after)).not.toEqual(segmentUrls(before));
  });

  it("the bucket is a third of the TTL, so a short TTL cannot outlive its bucket", () => {
    // Default: the cap wins, and it is exactly a third of 900 s.
    expect(segmentSigningTime(1_800_000_123_456, 900).getTime()).toBe(
      Math.floor(1_800_000_123_456 / SEGMENT_URL_BUCKET_MAX_MS) *
        SEGMENT_URL_BUCKET_MAX_MS,
    );
    // A shorter TTL shortens the bucket rather than minting dead URLs.
    expect(segmentSigningTime(1_800_000_123_456, 120).getTime()).toBe(
      Math.floor(1_800_000_123_456 / 40_000) * 40_000,
    );
    // Never below a second, so an absurd TTL degrades to the old behaviour
    // rather than to a divide by zero.
    expect(segmentSigningTime(1_800_000_123_456, 1).getTime()).toBe(
      1_800_000_123_000,
    );
  });
});

describe("segments at the edge (LIVE_HLS_SEGMENT_BASE_URL)", () => {
  const EDGE = "https://hls.example.test";
  let fetchMock: ReturnType<typeof vi.fn>;

  function segmentLines(body: string): string[] {
    return body.split("\n").filter((line) => line.startsWith("https://"));
  }

  beforeEach(() => {
    disableHls();
    enableHls();
    resetHlsPlaylistCacheForTests();
    pool.rowCount = 1;
    fetchMock = vi.fn(async () => new Response(PLAYLIST_BODY, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    delete process.env.LIVE_HLS_SEGMENT_BASE_URL;
    disableHls();
    resetHlsPlaylistCacheForTests();
    vi.unstubAllGlobals();
  });

  it("off by default: every segment line is still a presigned bucket URL", async () => {
    const body = await buildSignedPlaylist(CHANNEL, STARTED_AT);
    for (const line of segmentLines(body)) {
      expect(new URL(line).searchParams.get("X-Amz-Signature")).not.toBeNull();
    }
  });

  it("on: segment lines point at the edge route with a session capability, and nothing presigned", async () => {
    process.env.LIVE_HLS_SEGMENT_BASE_URL = EDGE;
    const { describeHlsSegmentToken } = await import("./hls-segment-token.js");
    const now = 1_800_000_000_000;
    const body = await buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, now);
    const lines = segmentLines(body);
    expect(lines).toHaveLength(2);
    for (const [index, line] of lines.entries()) {
      const url = new URL(line);
      const name = `${STARTED_AT}_0000${index}.ts`;
      expect(url.origin).toBe(EDGE);
      expect(url.pathname).toBe(`/api/voice/hls-segment/${CHANNEL}/${STARTED_AT}/${name}`);
      expect(url.searchParams.get("X-Amz-Signature")).toBeNull();
      expect(
        describeHlsSegmentToken(
          url.searchParams.get("s"),
          { channelId: CHANNEL, startedAt: STARTED_AT, name },
          now,
        ),
      ).toBeNull();
    }
  });

  it("on: a listed segment keeps one URL across renders and across a bucket boundary", async () => {
    process.env.LIVE_HLS_SEGMENT_BASE_URL = EDGE;
    const bucket = SEGMENT_URL_BUCKET_MAX_MS;
    const t0 = Math.floor(1_800_000_000_000 / bucket) * bucket + 1_000;
    const first = await buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, t0);
    const second = await buildSignedPlaylist(
      CHANNEL,
      STARTED_AT,
      undefined,
      t0 + HLS_PLAYLIST_CACHE_TTL_MS + 500,
    );
    const third = await buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, t0 + bucket);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(segmentLines(second)).toEqual(segmentLines(first));
    expect(segmentLines(third)).toEqual(segmentLines(first));
  });

  it("flipping the flag mid-session moves every listed segment on the next render, both ways", async () => {
    const t0 = 1_800_000_000_000;
    const presigned = await buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, t0);
    process.env.LIVE_HLS_SEGMENT_BASE_URL = EDGE;
    const edge = await buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, t0 + 2_000);
    expect(segmentLines(edge).every((line) => line.startsWith(`${EDGE}/`))).toBe(true);
    delete process.env.LIVE_HLS_SEGMENT_BASE_URL;
    const back = await buildSignedPlaylist(CHANNEL, STARTED_AT, undefined, t0 + 4_000);
    expect(segmentLines(back)).toEqual(segmentLines(presigned));
  });

  it("on, but with no key to sign with: falls back to presigned rather than serving dead links", async () => {
    process.env.LIVE_HLS_SEGMENT_BASE_URL = EDGE;
    const saved = process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_SECRET_KEY;
    try {
      const body = await buildSignedPlaylist(CHANNEL, STARTED_AT);
      for (const line of segmentLines(body)) {
        expect(new URL(line).searchParams.get("X-Amz-Signature")).not.toBeNull();
      }
    } finally {
      process.env.CLERK_SECRET_KEY = saved;
    }
  });
});

describe("buildMasterPlaylistFor", () => {
  let clock = 5_000_000;

  beforeEach(() => {
    enableHls();
    resetHlsPlaylistCacheForTests();
    pool.rowCount = 1;
    pool.query.mockReset();
    clock += 10_000;
  });

  afterEach(() => {
    disableHls();
    resetHlsPlaylistCacheForTests();
    pool.query.mockReset();
  });

  function rungRows(rungs: string[]) {
    pool.query.mockImplementation(async () => ({
      rowCount: rungs.length,
      rows: rungs.map((rung) => ({ rung })),
    }));
  }

  function master(token?: string, now = clock) {
    return buildMasterPlaylistFor({
      channelId: CHANNEL,
      startedAt: STARTED_AT,
      userId: USER,
      token,
      now,
    });
  }

  it("lists every rung the session recorded, lowest bitrate first", async () => {
    rungRows(["1080p30", "720p30"]);
    const lines = (await master())!.trim().split("\n");
    expect(lines[0]).toBe("#EXTM3U");
    expect(lines[2]).toContain("RESOLUTION=1280x720");
    expect(lines[3]).toBe(
      `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}/720p30`,
    );
    expect(lines[4]).toContain("RESOLUTION=1920x1080");
    expect(lines[5]).toBe(
      `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}/1080p30`,
    );
  });

  it("stamps the viewer's own token onto each variant", async () => {
    rungRows(["1080p30", "720p30"]);
    const body = await master("tok en/+");
    // Root-relative, and carrying its OWN query string: relative resolution
    // drops the master's query but keeps the variant's, which is the only
    // way a header-less player (Safari native, iOS) authorises the second
    // request.
    for (const line of body!.split("\n").filter((l) => l.startsWith("/api"))) {
      // `+` for a space, not `%20` -- built with URLSearchParams now (so a
      // party pass can be appended alongside the token, see below), which
      // serializes as application/x-www-form-urlencoded. Still round-trips
      // correctly: `url.searchParams.get` on the receiving end decodes `+`
      // back to a space the same way.
      expect(line).toContain("?t=tok+en%2F%2B");
    }
  });

  describe("the party pass on every variant", () => {
    afterEach(() => {
      delete process.env.LIVE_HLS_PLAYLIST_BASE_URL;
      delete process.env.LIVE_HLS_PARTY_PASS_TTL_MS;
    });

    /**
     * THE BUG THIS PINS. `stampViewerStream` stamps `?pp=` on the SESSION
     * url a viewer is initially handed, but once a session has run a
     * ladder, that session url IS this master -- and the URIs a player
     * actually polls every 2-4s are the VARIANT lines below, which used to
     * carry only `?t=`. A party pass that never reaches the edge Worker's
     * rendition route is dead weight: this is what makes it live there.
     */
    it("mints a fresh party pass and stamps it onto every rendition URI when the edge host is configured", async () => {
      process.env.LIVE_HLS_PLAYLIST_BASE_URL = "https://hls.pqp.gg";
      rungRows(["1080p30", "720p30"]);
      const mintedAt = clock;
      const body = await master("tok-en", mintedAt);
      const variantLines = body!.split("\n").filter((l) => l.startsWith("/api"));
      expect(variantLines.length).toBeGreaterThan(0);
      for (const line of variantLines) {
        const url = new URL(line, "https://hls.pqp.gg");
        expect(url.searchParams.get("t")).toBe("tok-en");
        const pass = url.searchParams.get("pp");
        expect(pass).toBeTruthy();
        // Verified at the SAME instant it was minted -- `master()`'s test
        // clock is nowhere near real time, so a default `now = Date.now()`
        // on the verify side would see every pass as already expired.
        expect(
          verifyHlsPartyPass(pass, { channelId: CHANNEL, startedAt: STARTED_AT }, mintedAt),
        ).toEqual({ userId: USER, issuedAt: mintedAt });
      }
    });

    it("mints no party pass, and omits ?pp= entirely, with no edge host configured", async () => {
      delete process.env.LIVE_HLS_PLAYLIST_BASE_URL;
      rungRows(["720p30"]);
      const body = await master("tok-en");
      const variantLines = body!.split("\n").filter((l) => l.startsWith("/api"));
      expect(variantLines.length).toBeGreaterThan(0);
      for (const line of variantLines) {
        expect(line).not.toContain("pp=");
      }
    });

    it("omits ?pp= when the pass is disabled by env, even with an edge host configured", async () => {
      process.env.LIVE_HLS_PLAYLIST_BASE_URL = "https://hls.pqp.gg";
      process.env.LIVE_HLS_PARTY_PASS_TTL_MS = "0";
      rungRows(["720p30"]);
      const body = await master("tok-en");
      for (const line of body!.split("\n").filter((l) => l.startsWith("/api"))) {
        expect(line).not.toContain("pp=");
        // The viewer token is still there -- same fallback shape as
        // stampViewerStream's own "disabled by env" case.
        expect(line).toContain("?t=tok-en");
      }
    });
  });

  it("only looks at rows of THIS session", async () => {
    rungRows(["720p30"]);
    await master();
    const params = pool.query.mock.calls[0]![1] as unknown[];
    expect(params[0]).toBe(CHANNEL);
    expect(params[1]).toBe(`live/${CHANNEL}/${STARTED_AT}-%`);
  });

  it("a rung this build does not know is left out rather than guessed at", async () => {
    rungRows(["720p30", "4320p60"]);
    const body = await master();
    expect(body!.match(/#EXT-X-STREAM-INF/g)).toHaveLength(1);
    expect(body).toContain("RESOLUTION=1280x720");
  });

  it("the master it generates reads as live to the client's own gate", async () => {
    // THE SEAM THIS PR BROKE ONCE. `useLiveHlsReady` will not attach a
    // playlist until `playlistLooksLive` says go, and a master has no
    // `#EXTINF`, so the stage sat on WebRTC forever and re-polled at 1 Hz
    // with every fetch returning a perfectly good master. Two correct
    // halves, one dead feature. Assert the actual generated body against
    // the actual gate rather than each side against its own idea.
    rungRows(["1080p30", "720p30"]);
    expect(playlistLooksLive((await master())!)).toBe(true);
  });

  it("a pre-ladder session has no rungs and gets no master", async () => {
    rungRows([]);
    expect(await master()).toBeNull();
  });

  it("reuses the rung list for a room that joins at once, then re-reads it", async () => {
    rungRows(["1080p30", "720p30"]);
    await master(undefined, clock);
    await master(undefined, clock + HLS_PLAYLIST_CACHE_TTL_MS - 1);
    expect(pool.query).toHaveBeenCalledTimes(1);
    await master(undefined, clock + HLS_PLAYLIST_CACHE_TTL_MS + 1);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it("STAMPEDE: five hundred viewers arriving at once cost one rung query, not five hundred", async () => {
    // Measured on staging 2026-09-12: 500 viewers ramping over 30 s put 500
    // copies of the rung query on a pool of 10, and 491 masters timed out.
    // The reads must coalesce while the first one is still in flight.
    let release!: (value: { rowCount: number; rows: { rung: string }[] }) => void;
    pool.query.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const arrivals = Array.from({ length: 500 }, () => master("tok", clock));
    expect(pool.query).toHaveBeenCalledTimes(1);
    release({ rowCount: 1, rows: [{ rung: "720p30" }] });
    const bodies = await Promise.all(arrivals);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain("/720p30?t=tok");
  });

  it("a rung query that fails is not remembered, so the next viewer retries", async () => {
    pool.query.mockImplementationOnce(async () => {
      throw new Error("Connection terminated due to connection timeout");
    });
    await expect(master(undefined, clock)).rejects.toThrow("connection timeout");
    rungRows(["720p30"]);
    expect(await master(undefined, clock)).toContain("/720p30");
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it("A3.1: the breaker being open still serves the master from the last known rung list", async () => {
    rungRows(["1080p30", "720p30"]);
    const first = await master(undefined, clock);
    expect(pool.query).toHaveBeenCalledTimes(1);

    pool.query.mockImplementationOnce(async () => {
      throw new MockDatabaseUnavailableError();
    });
    const stale = await master(undefined, clock + HLS_PLAYLIST_CACHE_TTL_MS + 1);
    expect(stale).toBe(first);

    // Not remembered as fresh: recovery is picked up on the very next poll.
    rungRows(["1080p30", "720p30", "360p30"]);
    const recovered = await master(
      undefined,
      clock + HLS_PLAYLIST_CACHE_TTL_MS + 2,
    );
    expect(recovered).toContain("/360p30");
  });

  it("a SLOW rung query does not hold the master behind a dead pool connection", async () => {
    rungRows(["1080p30", "720p30"]);
    const first = await master(undefined, clock);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      pool.query.mockImplementation(() => new Promise(() => {}) as never);
      const later = clock + HLS_PLAYLIST_CACHE_TTL_MS + 1;
      const pending = master(undefined, later);
      // A second viewer arriving while the first query hangs is not parked
      // on it either.
      const second = master(undefined, later + 10);
      await vi.advanceTimersByTimeAsync(HLS_LIVENESS_WAIT_MS);
      await expect(pending).resolves.toBe(first);
      await expect(second).resolves.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a rung list older than STALE_ON_BREAKER_MAX_MS is not served through an outage", async () => {
    rungRows(["720p30"]);
    await master(undefined, clock);
    pool.query.mockImplementationOnce(async () => {
      throw new MockDatabaseUnavailableError();
    });
    await expect(
      master(undefined, clock + STALE_ON_BREAKER_MAX_MS + 1),
    ).rejects.toThrow(MockDatabaseUnavailableError);
  });
});

/**
 * BROADCAST_PIPELINE B0.6: the telemetry route's own session identity, so an
 * accepted batch's `sessionId` is the SAME string `buildMasterPlaylistFor`
 * puts in `#EXT-X-PQP-SESSION` (both read it off this same `sessionRungs`
 * call, sharing its cache) rather than a `channelId:startedAt` pair that
 * reads the same to a human but never joins by equality against
 * `voice.hlsStarted` (a Farol finding, 2026-09-14).
 */
describe("resolveHlsSessionId", () => {
  beforeEach(() => {
    resetHlsPlaylistCacheForTests();
    pool.query.mockReset();
  });

  afterEach(() => {
    resetHlsPlaylistCacheForTests();
    pool.query.mockReset();
  });

  it("returns the lowest-bitrate rung's row id -- the same one buildMasterPlaylistFor tags", async () => {
    pool.query.mockImplementation(async () => ({
      rowCount: 2,
      rows: [
        { id: "row-1080", rung: "1080p30" },
        { id: "row-720", rung: "720p30" },
      ],
    }));
    await expect(
      resolveHlsSessionId(CHANNEL, STARTED_AT, 1_000),
    ).resolves.toBe("row-720");
  });

  it("is null when the session has no known rungs right now", async () => {
    pool.query.mockImplementation(async () => ({ rowCount: 0, rows: [] }));
    await expect(
      resolveHlsSessionId(CHANNEL, STARTED_AT, 1_000),
    ).resolves.toBeNull();
  });

  it("is null, never throws, when the lookup itself fails", async () => {
    pool.query.mockImplementation(async () => {
      throw new Error("pool exhausted");
    });
    await expect(
      resolveHlsSessionId(CHANNEL, STARTED_AT, 1_000),
    ).resolves.toBeNull();
  });

  it("shares sessionRungs' cache with buildMasterPlaylistFor -- one query serves both", async () => {
    pool.query.mockImplementation(async () => ({
      rowCount: 1,
      rows: [{ id: "row-720", rung: "720p30" }],
    }));
    await buildMasterPlaylistFor({
      channelId: CHANNEL,
      startedAt: STARTED_AT,
      userId: USER,
      now: 1_000,
    });
    await expect(
      resolveHlsSessionId(CHANNEL, STARTED_AT, 1_000),
    ).resolves.toBe("row-720");
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe("buildSignedPlaylist with a rung", () => {
  beforeEach(() => {
    enableHls();
    resetHlsPlaylistCacheForTests();
    pool.rowCount = 1;
    pool.query.mockImplementation(async () => ({ rowCount: 1, rows: [] }));
  });

  afterEach(() => {
    disableHls();
    resetHlsPlaylistCacheForTests();
    vi.unstubAllGlobals();
    pool.query.mockReset();
  });

  it("looks up and fetches that rendition's own objects", async () => {
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(url);
        return new Response(PLAYLIST_BODY, { status: 200 });
      }),
    );
    await buildSignedPlaylist(CHANNEL, STARTED_AT, "1080p30");
    const params = pool.query.mock.calls[0]![1] as unknown[];
    expect(params[1]).toBe(`live/${CHANNEL}/${STARTED_AT}-1080p30`);
    expect(fetched[0]).toContain(
      encodeURIComponent(`live/${CHANNEL}/${STARTED_AT}-1080p30.m3u8`).replace(
        /%2F/g,
        "/",
      ),
    );
  });

  it("caches per RENDITION, not per session", async () => {
    // The rungs of one ladder share a channel and a startedAt and differ
    // only here. A key without the rung would hand a viewer on 720p the
    // 1080p segment list: the cache that makes an audience cheap would
    // quietly serve everyone the wrong bitrate.
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(url);
        return new Response(PLAYLIST_BODY, { status: 200 });
      }),
    );
    const now = 9_000_000;
    await buildSignedPlaylist(CHANNEL, STARTED_AT, "1080p30", now);
    await buildSignedPlaylist(CHANNEL, STARTED_AT, "720p30", now);
    await buildSignedPlaylist(CHANNEL, STARTED_AT, "1080p30", now);
    expect(fetched).toHaveLength(2);
    expect(fetched[0]).toContain("1080p30.m3u8");
    expect(fetched[1]).toContain("720p30.m3u8");
  });
});

/**
 * KEEP-WARM. Production 2026-09-12 15:41Z: a rung nobody had polled for a
 * while came back with only the egress's own 5 entries, because the widened
 * history only advances when someone requests that exact rendition. These
 * tests run the loop forward with fake timers and never once request the
 * "cold" rung directly, so any growth they see can only have come from the
 * loop.
 */
describe("keep-warm loop", () => {
  function stubSessionRungs(rungs: string[]) {
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, rung FROM hls_sessions")) {
        return {
          rowCount: rungs.length,
          rows: rungs.map((rung, i) => ({ id: `session-${i}`, rung })),
        };
      }
      // The exists-check every render runs (`SELECT 1 FROM hls_sessions ...`),
      // scoped to a session that is live.
      return { rowCount: 1, rows: [] };
    });
  }

  /** A live playlist whose window slides forward by one segment per fetch. */
  function slidingFetchMock() {
    let call = 0;
    return vi.fn(async () => {
      call += 1;
      const lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:2",
        `#EXT-X-MEDIA-SEQUENCE:${call}`,
      ];
      for (let i = 0; i < 5; i++) {
        lines.push("#EXTINF:2.0,");
        lines.push(`seg_${call + i}.ts`);
      }
      return new Response(lines.join("\n") + "\n", { status: 200 });
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    disableHls();
    enableHls();
    resetHlsPlaylistCacheForTests();
    pool.query.mockReset();
  });

  afterEach(() => {
    resetHlsPlaylistCacheForTests();
    disableHls();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("rendering rung A once makes rung B's history grow over the next ticks without any request for B", async () => {
    stubSessionRungs(["720p30", "1080p30"]);
    vi.stubGlobal("fetch", slidingFetchMock());

    await buildSignedPlaylist(CHANNEL, STARTED_AT, "720p30");
    expect(hlsKeepWarmLoopsActive()).toBe(1);

    // Several warm ticks pass. Nobody ever asks for 1080p30 directly.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(HLS_KEEP_WARM_INTERVAL_MS);
    }
    expect(hlsKeepWarmRenders()).toBeGreaterThan(0);

    // The one and only request for rung B in this test, made AFTER the
    // ticks above: any window wider than the egress's own 5 segments proves
    // it came from the loop, not from this call.
    const body = await buildSignedPlaylist(CHANNEL, STARTED_AT, "1080p30");
    // Rewritten into absolute presigned URLs by this point, so match on the
    // segment name rather than the bare filename `widenLivePlaylist` wrote.
    const segments = body.split("\n").filter((line) => line.includes("seg_"));
    expect(segments.length).toBeGreaterThan(5);
  });

  it("stops once a render 404s (the session ended)", async () => {
    stubSessionRungs(["720p30"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(PLAYLIST_BODY, { status: 200 })),
    );

    await buildSignedPlaylist(CHANNEL, STARTED_AT, "720p30");
    expect(hlsKeepWarmLoopsActive()).toBe(1);

    // The session has ended: no rung rows, and the exists-check now misses.
    pool.query.mockImplementation(async () => ({ rowCount: 0, rows: [] }));

    await vi.advanceTimersByTimeAsync(HLS_KEEP_WARM_INTERVAL_MS);
    expect(hlsKeepWarmLoopsActive()).toBe(0);
  });

  it("stops after HLS_KEEP_WARM_IDLE_MS with no viewer request for any rung", async () => {
    stubSessionRungs(["720p30"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(PLAYLIST_BODY, { status: 200 })),
    );

    await buildSignedPlaylist(CHANNEL, STARTED_AT, "720p30");
    expect(hlsKeepWarmLoopsActive()).toBe(1);

    // No one asks for anything else. Past the idle window, the loop must
    // stop polling the bucket for an abandoned session on its own.
    await vi.advanceTimersByTimeAsync(HLS_KEEP_WARM_IDLE_MS + HLS_KEEP_WARM_INTERVAL_MS);
    expect(hlsKeepWarmLoopsActive()).toBe(0);
  });

  it("resetHlsPlaylistCacheForTests clears every running loop", async () => {
    stubSessionRungs(["720p30"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(PLAYLIST_BODY, { status: 200 })),
    );

    await buildSignedPlaylist(CHANNEL, STARTED_AT, "720p30");
    expect(hlsKeepWarmLoopsActive()).toBe(1);

    resetHlsPlaylistCacheForTests();
    expect(hlsKeepWarmLoopsActive()).toBe(0);

    // And it stays cleared: the interval itself was cancelled, not just the
    // bookkeeping map.
    await vi.advanceTimersByTimeAsync(HLS_KEEP_WARM_INTERVAL_MS * 3);
    expect(hlsKeepWarmLoopsActive()).toBe(0);
  });
});

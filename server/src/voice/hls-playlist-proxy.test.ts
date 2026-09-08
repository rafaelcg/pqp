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

const pool = vi.hoisted(() => ({
  rowCount: 1,
  query: vi.fn(async (_sql: string, _params?: unknown[]) => ({
    rowCount: pool.rowCount,
    rows: [] as { rung: string }[],
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
  buildMasterPlaylistFor,
  buildSignedPlaylist,
  HlsPlaylistNotFound,
  HlsPlaylistUnavailable,
  resolveHlsPlaylistViewer,
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
    ).toEqual({ userId: USER });
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

  it("the Bearer user wins over any token", () => {
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
    ).toEqual({ userId: "bearer-user" });
  });
});

describe("buildSignedPlaylist", () => {
  beforeEach(() => {
    disableHls();
    enableHls();
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

describe("buildMasterPlaylistFor", () => {
  beforeEach(() => {
    enableHls();
    pool.rowCount = 1;
    pool.query.mockReset();
  });

  afterEach(() => {
    disableHls();
    pool.query.mockReset();
  });

  function rungRows(rungs: string[]) {
    pool.query.mockImplementation(async () => ({
      rowCount: rungs.length,
      rows: rungs.map((rung) => ({ rung })),
    }));
  }

  it("lists every rung the session recorded, lowest bitrate first", async () => {
    rungRows(["1080p30", "720p30"]);
    const body = await buildMasterPlaylistFor({
      channelId: CHANNEL,
      startedAt: STARTED_AT,
    });
    const lines = body!.trim().split("\n");
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
    const body = await buildMasterPlaylistFor({
      channelId: CHANNEL,
      startedAt: STARTED_AT,
      token: "tok en/+",
    });
    // Root-relative, and carrying its OWN query string: relative resolution
    // drops the master's query but keeps the variant's, which is the only
    // way a header-less player (Safari native, iOS) authorises the second
    // request.
    for (const line of body!.split("\n").filter((l) => l.startsWith("/api"))) {
      expect(line).toContain("?t=tok%20en%2F%2B");
    }
  });

  it("only looks at rows of THIS session", async () => {
    rungRows(["720p30"]);
    await buildMasterPlaylistFor({ channelId: CHANNEL, startedAt: STARTED_AT });
    const params = pool.query.mock.calls[0]![1] as unknown[];
    expect(params[0]).toBe(CHANNEL);
    expect(params[1]).toBe(`live/${CHANNEL}/${STARTED_AT}-%`);
  });

  it("a rung this build does not know is left out rather than guessed at", async () => {
    rungRows(["720p30", "4320p60"]);
    const body = await buildMasterPlaylistFor({
      channelId: CHANNEL,
      startedAt: STARTED_AT,
    });
    expect(body!.match(/#EXT-X-STREAM-INF/g)).toHaveLength(1);
    expect(body).toContain("RESOLUTION=1280x720");
  });

  it("a pre-ladder session has no rungs and gets no master", async () => {
    rungRows([]);
    expect(
      await buildMasterPlaylistFor({
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      }),
    ).toBeNull();
  });
});

describe("buildSignedPlaylist with a rung", () => {
  beforeEach(() => {
    enableHls();
    pool.rowCount = 1;
    pool.query.mockImplementation(async () => ({ rowCount: 1, rows: [] }));
  });

  afterEach(() => {
    disableHls();
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
});

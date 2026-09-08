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

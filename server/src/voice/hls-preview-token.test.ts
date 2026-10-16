import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIVE_HLS_MODE_LL, LIVE_HLS_MODE_PARAM } from "@pqp/shared";
import {
  decodeHlsViewerToken,
  mintHlsPreviewToken,
  mintHlsViewerToken,
  stampPreviewStream,
  verifyHlsViewerToken,
} from "./hls-viewer-token.js";
import { resolveHlsPlaylistViewer } from "./hls-playlist-proxy.js";

/**
 * The signed-out live preview's capability (`"preview"` purpose). What is
 * pinned: it verifies only where a caller asks for it by name, it dies at the
 * end of the visitor's window, it never travels with a party pass or the
 * camera, and a signed-in caller holding one is served on their own Bearer.
 */

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const STARTED_AT = 1_700_000_000_000;
const USER = "11111111-1111-4111-8111-111111111111";
const NOW = 1_800_000_000_000;

function preview(expiresAt = NOW + 120_000): string {
  return mintHlsPreviewToken({
    visitorId: "visitor",
    channelId: CHANNEL,
    startedAt: STARTED_AT,
    expiresAt,
    now: NOW,
  })!;
}

describe("the preview token", () => {
  beforeEach(() => {
    process.env.CLERK_SECRET_KEY = "sk_test_hls_preview";
  });
  afterEach(() => {
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.DEV_AUTH_BYPASS;
    delete process.env.LIVE_HLS_PLAYLIST_BASE_URL;
  });

  it("is refused by every reader that does not ask for it", () => {
    const token = preview();
    const expected = { channelId: CHANNEL, startedAt: STARTED_AT };
    expect(decodeHlsViewerToken(token, NOW)).toBeNull();
    expect(verifyHlsViewerToken(token, expected, NOW)).toBeNull();
    expect(verifyHlsViewerToken(token, { ...expected, purpose: "live" }, NOW)).toBeNull();
    expect(verifyHlsViewerToken(token, { ...expected, purpose: "replay" }, NOW)).toBeNull();
    expect(
      verifyHlsViewerToken(token, { ...expected, allowPreview: true }, NOW),
    ).toEqual({ userId: "preview:visitor", issuedAt: NOW, preview: true });
  });

  it("leaves live and replay tokens exactly as they were", () => {
    const expected = { channelId: CHANNEL, startedAt: STARTED_AT };
    const live = mintHlsViewerToken({ userId: USER, ...expected, now: NOW })!;
    const replay = mintHlsViewerToken({ userId: USER, ...expected, now: NOW, purpose: "replay" })!;
    expect(verifyHlsViewerToken(live, expected, NOW)).toEqual({ userId: USER, issuedAt: NOW });
    expect(verifyHlsViewerToken(replay, { ...expected, purpose: "replay" }, NOW)).toEqual({
      userId: USER,
      issuedAt: NOW,
    });
    expect(verifyHlsViewerToken(replay, expected, NOW)).toEqual({ userId: USER, issuedAt: NOW });
    expect(decodeHlsViewerToken(live, NOW)?.userId).toBe(USER);
  });

  it("expires with the window, not an hour later", () => {
    const token = preview(NOW + 30_000);
    const expected = { channelId: CHANNEL, startedAt: STARTED_AT, allowPreview: true };
    expect(verifyHlsViewerToken(token, expected, NOW + 29_999)).not.toBeNull();
    expect(verifyHlsViewerToken(token, expected, NOW + 30_001)).toBeNull();
  });

  it("is not minted for a window that is already over", () => {
    expect(
      mintHlsPreviewToken({
        visitorId: "visitor",
        channelId: CHANNEL,
        startedAt: STARTED_AT,
        expiresAt: NOW,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("is not minted without a key", () => {
    delete process.env.CLERK_SECRET_KEY;
    expect(
      mintHlsPreviewToken({
        visitorId: "visitor",
        channelId: CHANNEL,
        startedAt: STARTED_AT,
        expiresAt: NOW + 1_000,
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe("stampPreviewStream", () => {
  beforeEach(() => {
    process.env.CLERK_SECRET_KEY = "sk_test_hls_preview";
  });
  afterEach(() => {
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.LIVE_HLS_PLAYLIST_BASE_URL;
  });

  const stream = {
    hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}`,
    startedAt: STARTED_AT,
    presenterPeerId: "peer-1",
    cameraHlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}/cam360p30`,
  };

  it("hands the film through the edge with the preview token and no party pass", () => {
    process.env.LIVE_HLS_PLAYLIST_BASE_URL = "https://hls.edge.test/";
    const stamped = stampPreviewStream(stream, "visitor", NOW + 60_000, NOW)!;
    expect(stamped.hlsUrl.startsWith(`https://hls.edge.test/api/voice/hls-playlist/${CHANNEL}/`)).toBe(
      true,
    );
    const url = new URL(stamped.hlsUrl);
    expect(url.searchParams.get("pp")).toBeNull();
    const claims = decodeHlsViewerToken(url.searchParams.get("t"), NOW, { allowPreview: true })!;
    expect(claims).toMatchObject({ purpose: "preview", channelId: CHANNEL, startedAt: STARTED_AT });
    // The film only: no camera, no presenter.
    expect(Object.keys(stamped).sort()).toEqual(["hlsUrl", "startedAt"]);
  });

  it("keeps an LL session's mode marker and appends the token after it", () => {
    const stamped = stampPreviewStream(
      {
        hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}?${LIVE_HLS_MODE_PARAM}=${LIVE_HLS_MODE_LL}`,
        startedAt: STARTED_AT,
        mode: "ll",
        partTargetMs: 500,
      },
      "visitor",
      NOW + 60_000,
      NOW,
    )!;
    expect(stamped.mode).toBe("ll");
    expect(stamped.partTargetMs).toBe(500);
    const url = new URL(stamped.hlsUrl, "http://x");
    expect(url.searchParams.get(LIVE_HLS_MODE_PARAM)).toBe(LIVE_HLS_MODE_LL);
    expect(url.searchParams.get("t")).toBeTruthy();
  });

  it("offers nothing for a raw bucket URL, which no token could cut off", () => {
    expect(
      stampPreviewStream(
        { hlsUrl: "https://bucket.example/live/x/index.m3u8", startedAt: STARTED_AT },
        "visitor",
        NOW + 60_000,
        NOW,
      ),
    ).toBeNull();
  });
});

describe("resolveHlsPlaylistViewer and a preview token", () => {
  beforeEach(() => {
    process.env.CLERK_SECRET_KEY = "sk_test_hls_preview";
  });
  afterEach(() => {
    delete process.env.CLERK_SECRET_KEY;
  });

  it("is a preview viewer only where the door asks, and never vetoes a Bearer", () => {
    const token = preview();
    const base = { channelId: CHANNEL, startedAt: STARTED_AT, token, now: NOW };
    expect(resolveHlsPlaylistViewer({ ...base, bearerUserId: null })).toBeNull();
    expect(
      resolveHlsPlaylistViewer({ ...base, bearerUserId: null, allowPreview: true }),
    ).toEqual({ userId: "preview:visitor", issuedAt: NOW, preview: true });
    // A signed-in page that still holds one: served on its own Bearer.
    expect(
      resolveHlsPlaylistViewer({ ...base, bearerUserId: USER, allowPreview: true }),
    ).toEqual({ userId: USER, issuedAt: null });
  });
});

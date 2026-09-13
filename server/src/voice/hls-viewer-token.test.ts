import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeHlsViewerToken,
  HLS_VIEWER_TOKEN_TTL_MS,
  mintHlsViewerToken,
  stampViewerStream,
  verifyHlsViewerToken,
} from "./hls-viewer-token.js";

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const STARTED_AT = 1_700_000_000_000;
const USER = "11111111-1111-4111-8111-111111111111";

describe("HLS viewer token", () => {
  beforeEach(() => {
    process.env.CLERK_SECRET_KEY = "sk_test_hls";
  });
  afterEach(() => {
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.DEV_AUTH_BYPASS;
    delete process.env.LIVE_HLS_PLAYLIST_BASE_URL;
  });

  it("round-trips the user for the same channel and session", () => {
    const token = mintHlsViewerToken({
      userId: USER,
      channelId: CHANNEL,
      startedAt: STARTED_AT,
    });
    expect(token).not.toBeNull();
    expect(
      verifyHlsViewerToken(token, { channelId: CHANNEL, startedAt: STARTED_AT }),
    ).toEqual({ userId: USER, issuedAt: expect.any(Number) });
  });

  it("is bound to the channel and the session, and expires", () => {
    const now = 1_000_000;
    const token = mintHlsViewerToken({
      userId: USER,
      channelId: CHANNEL,
      startedAt: STARTED_AT,
      now,
    })!;
    expect(
      verifyHlsViewerToken(token, { channelId: OTHER, startedAt: STARTED_AT }),
    ).toBeNull();
    expect(
      verifyHlsViewerToken(token, { channelId: CHANNEL, startedAt: STARTED_AT + 1 }),
    ).toBeNull();
    expect(
      verifyHlsViewerToken(
        token,
        { channelId: CHANNEL, startedAt: STARTED_AT },
        now + HLS_VIEWER_TOKEN_TTL_MS + 1,
      ),
    ).toBeNull();
  });

  it("refuses a tampered MAC and garbage", () => {
    const token = mintHlsViewerToken({
      userId: USER,
      channelId: CHANNEL,
      startedAt: STARTED_AT,
    })!;
    const tampered = `${token.slice(0, -2)}xx`;
    expect(
      verifyHlsViewerToken(tampered, { channelId: CHANNEL, startedAt: STARTED_AT }),
    ).toBeNull();
    expect(
      verifyHlsViewerToken("nope", { channelId: CHANNEL, startedAt: STARTED_AT }),
    ).toBeNull();
    expect(
      verifyHlsViewerToken(undefined, { channelId: CHANNEL, startedAt: STARTED_AT }),
    ).toBeNull();
  });

  it("stamps the proxy path per recipient and leaves a public URL alone", () => {
    const stream = {
      hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}`,
      startedAt: STARTED_AT,
      presenterPeerId: "peer-1",
      delaySeconds: 10,
    };
    const stamped = stampViewerStream(stream, USER);
    const url = new URL(stamped.hlsUrl, "https://api.example.test");
    expect(url.pathname).toBe(stream.hlsUrl);
    expect(
      verifyHlsViewerToken(url.searchParams.get("t"), {
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      }),
    ).toEqual({ userId: USER, issuedAt: expect.any(Number) });

    const publicStream = { ...stream, hlsUrl: "https://live.example.test/x.m3u8" };
    expect(stampViewerStream(publicStream, USER)).toEqual(publicStream);
  });

  it("stamps the camera playlist with the SAME token, not a second one", () => {
    // A SECOND CREDENTIAL IS A SECOND THING THAT CAN FAIL (pitfall 16). The
    // camera is a rendition of the same session, so it is the same capability:
    // one token, one expiry, one thing to get wrong.
    const stream = {
      hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}`,
      cameraHlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}/cam360p30`,
      startedAt: STARTED_AT,
      presenterPeerId: "peer-1",
      delaySeconds: 10,
    };
    const stamped = stampViewerStream(stream, USER);
    const film = new URL(stamped.hlsUrl, "https://api.example.test");
    const camera = new URL(stamped.cameraHlsUrl!, "https://api.example.test");
    expect(camera.pathname).toBe(stream.cameraHlsUrl);
    expect(camera.searchParams.get("t")).toBe(film.searchParams.get("t"));
    expect(
      verifyHlsViewerToken(camera.searchParams.get("t"), {
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      }),
    ).toEqual({ userId: USER, issuedAt: expect.any(Number) });
  });

  it("stamps the token BEFORE prepending the edge host, so the edge Worker gets a real token", () => {
    // THE BUG THIS PINS. An earlier version applied `LIVE_HLS_PLAYLIST_BASE_URL`
    // inside `viewerPlaylistUrl` (hls-egress.ts), before this function ever
    // saw the stream. That made `stream.hlsUrl` arrive here already absolute
    // (`https://hls.pqp.gg/...`), which is indistinguishable from the
    // `LIVE_HLS_SIGNED_URLS=false` raw-bucket case just below -- so
    // `stampViewerStream` took the "already public, leave it alone" branch
    // and handed out a `?t=`-less URL. Every request to the edge Worker then
    // 401'd "missing". The edge host now goes on HERE, after minting, so the
    // "is this already absolute" check only ever sees a genuinely public URL.
    process.env.LIVE_HLS_PLAYLIST_BASE_URL = "https://hls.pqp.gg";
    const stream = {
      hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}`,
      cameraHlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}/cam360p30`,
      startedAt: STARTED_AT,
      presenterPeerId: "peer-1",
      delaySeconds: 10,
    };
    const stamped = stampViewerStream(stream, USER);
    expect(stamped.hlsUrl.startsWith("https://hls.pqp.gg/api/voice/hls-playlist/")).toBe(
      true,
    );
    const film = new URL(stamped.hlsUrl);
    const camera = new URL(stamped.cameraHlsUrl!);
    expect(film.host).toBe("hls.pqp.gg");
    expect(film.pathname).toBe(stream.hlsUrl);
    expect(camera.host).toBe("hls.pqp.gg");
    expect(camera.pathname).toBe(stream.cameraHlsUrl);
    // The token verifies against the ORIGINAL channel/session, same as an
    // API-relative stamp -- the edge host is cosmetic to the capability.
    expect(
      verifyHlsViewerToken(film.searchParams.get("t"), {
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      }),
    ).toEqual({ userId: USER, issuedAt: expect.any(Number) });
    expect(camera.searchParams.get("t")).toBe(film.searchParams.get("t"));
  });

  it("strips a trailing slash from LIVE_HLS_PLAYLIST_BASE_URL, same as the public base URL", () => {
    process.env.LIVE_HLS_PLAYLIST_BASE_URL = "https://hls.pqp.gg/";
    const stream = {
      hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}`,
      startedAt: STARTED_AT,
      presenterPeerId: "peer-1",
      delaySeconds: 10,
    };
    const stamped = stampViewerStream(stream, USER);
    expect(stamped.hlsUrl.startsWith("https://hls.pqp.gg//")).toBe(false);
    expect(stamped.hlsUrl.startsWith(`https://hls.pqp.gg${stream.hlsUrl}`)).toBe(true);
  });

  it("leaves a stream with no camera exactly as it was", () => {
    const stream = {
      hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}`,
      startedAt: STARTED_AT,
      presenterPeerId: "peer-1",
      delaySeconds: 10,
    };
    expect(stampViewerStream(stream, USER).cameraHlsUrl).toBeUndefined();
  });

  it("has no key without Clerk or the dev bypass, and a dev key with it", () => {
    delete process.env.CLERK_SECRET_KEY;
    expect(
      mintHlsViewerToken({ userId: USER, channelId: CHANNEL, startedAt: STARTED_AT }),
    ).toBeNull();
    process.env.DEV_AUTH_BYPASS = "true";
    expect(
      mintHlsViewerToken({ userId: USER, channelId: CHANNEL, startedAt: STARTED_AT }),
    ).not.toBeNull();
  });

  describe("decodeHlsViewerToken", () => {
    // BROADCAST_PIPELINE B0.6: the telemetry route uses this, not
    // `verifyHlsViewerToken`, because it does not yet know which
    // channel/session to expect -- the whole point is to have the token NAME
    // it, rather than trusting a client-supplied string (Farol finding,
    // 2026-09-13).
    it("names the channel and session a valid token carries, with no expected pair to check against", () => {
      const token = mintHlsViewerToken({
        userId: USER,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      });
      expect(decodeHlsViewerToken(token)).toEqual({
        userId: USER,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
        issuedAt: expect.any(Number),
        purpose: "live",
      });
    });

    it("carries the replay purpose through", () => {
      const token = mintHlsViewerToken({
        userId: USER,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
        purpose: "replay",
      });
      expect(decodeHlsViewerToken(token)?.purpose).toBe("replay");
    });

    it("is null for a missing, malformed, tampered or expired token", () => {
      const now = 1_000_000;
      const token = mintHlsViewerToken({
        userId: USER,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
        now,
      })!;
      expect(decodeHlsViewerToken(null)).toBeNull();
      expect(decodeHlsViewerToken(undefined)).toBeNull();
      expect(decodeHlsViewerToken("not-a-token")).toBeNull();
      expect(decodeHlsViewerToken(`${token.slice(0, -2)}xx`)).toBeNull();
      expect(
        decodeHlsViewerToken(token, now + HLS_VIEWER_TOKEN_TTL_MS + 1),
      ).toBeNull();
    });

    it("agrees with verifyHlsViewerToken on the same token", () => {
      const token = mintHlsViewerToken({
        userId: USER,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      });
      const decoded = decodeHlsViewerToken(token);
      const verified = verifyHlsViewerToken(token, {
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      });
      expect(decoded?.userId).toBe(verified?.userId);
      expect(decoded?.issuedAt).toBe(verified?.issuedAt);
    });
  });
});

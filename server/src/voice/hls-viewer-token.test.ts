import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
    ).toEqual({ userId: USER });
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
    ).toEqual({ userId: USER });

    const publicStream = { ...stream, hlsUrl: "https://live.example.test/x.m3u8" };
    expect(stampViewerStream(publicStream, USER)).toEqual(publicStream);
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
});

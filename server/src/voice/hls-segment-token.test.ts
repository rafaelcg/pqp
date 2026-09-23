import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeHlsSegmentToken,
  edgeSegmentUrl,
  hlsSegmentBaseUrl,
  mintHlsSegmentToken,
  HLS_SEGMENT_ROUTE_PREFIX,
  HLS_SEGMENT_TOKEN_PARAM,
} from "./hls-segment-token.js";
import { mintHlsViewerToken } from "./hls-viewer-token.js";

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const STARTED_AT = 1_700_000_000_000;
const NOW = 1_800_000_000_000;
const NAME = `${STARTED_AT}-720p30_00042.ts`;

function mint(overrides: Partial<Parameters<typeof mintHlsSegmentToken>[0]> = {}) {
  return mintHlsSegmentToken({
    channelId: CHANNEL,
    startedAt: STARTED_AT,
    rung: "720p30",
    expiresAt: NOW + 60_000,
    ...overrides,
  });
}

const EXPECTED = { channelId: CHANNEL, startedAt: STARTED_AT, name: NAME };

describe("the segment capability", () => {
  const savedSecret = process.env.CLERK_SECRET_KEY;
  afterEach(() => {
    process.env.CLERK_SECRET_KEY = savedSecret;
    delete process.env.DEV_AUTH_BYPASS;
    delete process.env.LIVE_HLS_SEGMENT_BASE_URL;
  });

  it("verifies for the channel, session and rendition it was minted for", () => {
    expect(describeHlsSegmentToken(mint(), EXPECTED, NOW)).toBeNull();
  });

  it("is refused for another channel, another session, another rung, or after expiry", () => {
    const token = mint();
    expect(
      describeHlsSegmentToken(token, { ...EXPECTED, channelId: "other" }, NOW),
    ).toBe("wrong-channel");
    expect(
      describeHlsSegmentToken(token, { ...EXPECTED, startedAt: STARTED_AT + 1 }, NOW),
    ).toBe("wrong-session");
    expect(
      describeHlsSegmentToken(
        token,
        { ...EXPECTED, name: `${STARTED_AT}-1080p30_00042.ts` },
        NOW,
      ),
    ).toBe("wrong-rendition");
    expect(describeHlsSegmentToken(token, EXPECTED, NOW + 60_001)).toBe("expired");
  });

  it("a pre-ladder token (no rung) names only the bare session's segments", () => {
    const token = mint({ rung: undefined });
    expect(
      describeHlsSegmentToken(token, { ...EXPECTED, name: `${STARTED_AT}_00001.ts` }, NOW),
    ).toBeNull();
    expect(describeHlsSegmentToken(token, EXPECTED, NOW)).toBe("wrong-rendition");
  });

  it("a tampered payload, a missing token, and a viewer token all fail", () => {
    const token = mint()!;
    const [payload, mac] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ v: 1, k: "seg", c: CHANNEL, s: STARTED_AT, r: "720p30", e: NOW * 2 }),
    ).toString("base64url");
    expect(describeHlsSegmentToken(`${forged}.${mac}`, EXPECTED, NOW)).toBe("bad-signature");
    expect(describeHlsSegmentToken(payload, EXPECTED, NOW)).toBe("malformed");
    expect(describeHlsSegmentToken(null, EXPECTED, NOW)).toBe("missing");
    // A different derived key: a viewer's own `?t=` can never pass as this.
    const viewer = mintHlsViewerToken({
      userId: "u",
      channelId: CHANNEL,
      startedAt: STARTED_AT,
    });
    expect(describeHlsSegmentToken(viewer, EXPECTED, NOW)).toBe("bad-signature");
  });

  it("is signed with its own derived key, the value the edge Worker holds", () => {
    // Pins the derivation the operator repeats when setting
    // HLS_SEGMENT_TOKEN_SECRET on the Worker (README "Segments at the edge").
    const token = mint()!;
    const dot = token.lastIndexOf(".");
    const derived = createHmac("sha256", "sk_test_dummy")
      .update("pqp-hls-segment")
      .digest("base64url");
    const mac = createHmac("sha256", derived)
      .update(token.slice(0, dot))
      .digest("base64url");
    expect(token.slice(dot + 1)).toBe(mac);
  });

  it("mints nothing without a key", () => {
    delete process.env.CLERK_SECRET_KEY;
    expect(mint()).toBeNull();
    process.env.DEV_AUTH_BYPASS = "true";
    expect(mint()).not.toBeNull();
  });

  it("LIVE_HLS_SEGMENT_BASE_URL is off unless it is an http(s) URL", () => {
    expect(hlsSegmentBaseUrl()).toBeNull();
    process.env.LIVE_HLS_SEGMENT_BASE_URL = "  ";
    expect(hlsSegmentBaseUrl()).toBeNull();
    process.env.LIVE_HLS_SEGMENT_BASE_URL = "hls.pqp.gg";
    expect(hlsSegmentBaseUrl()).toBeNull();
    process.env.LIVE_HLS_SEGMENT_BASE_URL = "https://hls.pqp.gg/";
    expect(hlsSegmentBaseUrl()).toBe("https://hls.pqp.gg");
  });
});

describe("edgeSegmentUrl", () => {
  const input = {
    base: "https://hls.example.test",
    channelId: CHANNEL,
    startedAt: STARTED_AT,
    rung: "720p30",
    key: `live/${CHANNEL}/${NAME}`,
    signedAtMs: NOW,
    ttlSeconds: 900,
  };

  it("names the object by path and carries a capability that expires with the presigned TTL", () => {
    const url = new URL(edgeSegmentUrl(input)!);
    expect(url.origin).toBe("https://hls.example.test");
    expect(url.pathname).toBe(
      `${HLS_SEGMENT_ROUTE_PREFIX}/${CHANNEL}/${STARTED_AT}/${NAME}`,
    );
    const token = url.searchParams.get(HLS_SEGMENT_TOKEN_PARAM);
    expect(describeHlsSegmentToken(token, EXPECTED, NOW + 899_999)).toBeNull();
    expect(describeHlsSegmentToken(token, EXPECTED, NOW + 900_001)).toBe("expired");
    // Never the playlist path: the web client attaches a Bearer header there.
    expect(url.pathname.startsWith("/api/voice/hls-playlist/")).toBe(false);
  });

  it("is a pure function of its inputs, so two renders (or two machines) agree byte for byte", () => {
    expect(edgeSegmentUrl(input)).toBe(edgeSegmentUrl({ ...input }));
  });

  it("refuses a line the edge route could not name, so the caller presigns instead", () => {
    expect(edgeSegmentUrl({ ...input, key: `live/other/${NAME}` })).toBeNull();
    expect(edgeSegmentUrl({ ...input, key: `live/${CHANNEL}/sub/${NAME}` })).toBeNull();
    expect(
      edgeSegmentUrl({ ...input, key: `live/${CHANNEL}/${STARTED_AT}-1080p30_00001.ts` }),
    ).toBeNull();
    expect(
      edgeSegmentUrl({ ...input, key: `live/${CHANNEL}/${STARTED_AT}-720p30_live.m3u8` }),
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  chooseHlsEngine,
  isAutoplayRefusal,
  isOwnHlsPlaylistProxyUrl,
  resolveHlsUrl,
} from "./hls-playback";

describe("chooseHlsEngine", () => {
  it("prefers hls.js when Chrome claims native HLS but has MSE", () => {
    // Chrome 152 / macOS: canPlayType says "maybe", the native path then
    // never reaches loadedmetadata. This is the staging bug.
    expect(chooseHlsEngine({ nativeHls: "maybe", mseSupported: true })).toBe(
      "hlsjs",
    );
  });

  it("prefers hls.js on desktop Safari, which has both", () => {
    expect(
      chooseHlsEngine({ nativeHls: "probably", mseSupported: true }),
    ).toBe("hlsjs");
  });

  it("falls back to the native player where there is no MSE at all", () => {
    // Older iPhone Safari.
    expect(chooseHlsEngine({ nativeHls: "maybe", mseSupported: false })).toBe(
      "native",
    );
  });

  it("gives up when neither exists", () => {
    expect(chooseHlsEngine({ nativeHls: "", mseSupported: false })).toBe(
      "none",
    );
  });
});

describe("resolveHlsUrl", () => {
  it("leaves a full URL alone (LIVE_HLS_SIGNED_URLS=false / raw bucket)", () => {
    expect(resolveHlsUrl("https://live.example.test/live/c1/1.m3u8")).toBe(
      "https://live.example.test/live/c1/1.m3u8",
    );
    expect(resolveHlsUrl("http://live.example.test/live/c1/1.m3u8")).toBe(
      "http://live.example.test/live/c1/1.m3u8",
    );
  });

  it("prefixes an API-relative path (the signed playlist proxy) with the API base URL", () => {
    expect(resolveHlsUrl("/api/voice/hls-playlist/c1")).toBe(
      `${import.meta.env.VITE_API_URL ?? ""}/api/voice/hls-playlist/c1`,
    );
  });
});

describe("isOwnHlsPlaylistProxyUrl", () => {
  it("recognises our own signed playlist proxy and nothing else", () => {
    const own = resolveHlsUrl("/api/voice/hls-playlist/c1");
    expect(isOwnHlsPlaylistProxyUrl(own)).toBe(true);

    // A presigned R2 segment URL from the rewritten playlist: must NOT be
    // treated as our own route, or the Bearer header would leak to it.
    expect(
      isOwnHlsPlaylistProxyUrl(
        "https://r2.example.test/live/c1/1_00000.ts?X-Amz-Signature=abc",
      ),
    ).toBe(false);
    expect(isOwnHlsPlaylistProxyUrl("https://live.example.test/other")).toBe(
      false,
    );
  });

  it("BROKEN GUARD: a naive substring check would also match a segment URL that merely embeds the path", () => {
    // Proves the real check anchors on the start of the URL rather than
    // testing "does it contain this path anywhere" -- a presigned URL could
    // otherwise carry the literal proxy path in, say, a signed query value
    // and be misidentified as our own route.
    const decoy = `https://r2.example.test/evil?next=/api/voice/hls-playlist/c1`;
    const naiveCheck = decoy.includes("/api/voice/hls-playlist/");
    expect(naiveCheck).toBe(true);
    expect(isOwnHlsPlaylistProxyUrl(decoy)).toBe(false);
  });
});

describe("isAutoplayRefusal", () => {
  it("recognises the gesture refusal and nothing else", () => {
    const refused = Object.assign(new Error("no gesture"), {
      name: "NotAllowedError",
    });
    expect(isAutoplayRefusal(refused)).toBe(true);
    expect(isAutoplayRefusal(new Error("decode"))).toBe(false);
    expect(isAutoplayRefusal(null)).toBe(false);
  });
});

describe("isOwnHlsPlaylistProxyUrl with the viewer token", () => {
  it("still matches once the playlist URL carries its own ?t= token", () => {
    const own = resolveHlsUrl(
      "/api/voice/hls-playlist/c1/1700000000000?t=viewer-token",
    );
    expect(isOwnHlsPlaylistProxyUrl(own)).toBe(true);
    expect(isOwnHlsPlaylistProxyUrl(`${own}&x=1`)).toBe(true);
  });
});

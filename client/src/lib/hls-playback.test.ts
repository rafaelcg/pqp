import { describe, expect, it } from "vitest";
import {
  chooseHlsEngine,
  hasHlsViewerToken,
  hlsSessionKey,
  isAutoplayRefusal,
  isOwnHlsPlaylistProxyUrl,
  resolveHlsUrl,
  sameHlsSession,
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

/**
 * WHICH URL CHANGES MEAN THE VIEWER HAS TO MOVE, and it is very few of them.
 *
 * `hlsUrl` carries a per-viewer signed `?t=` token and the server restamps it
 * on the audience keyframe, every 30 seconds while a channel is live. So the
 * string a viewer holds changes twice a minute for a stream that has not
 * changed at all, and `HlsWatchPlayer` re-attached its `<video>` on any change
 * of `src`: **every seatless web viewer rebuffered every 30 seconds, for the
 * whole film, on every watch party there has ever been.**
 *
 * iOS was given exactly this rule when the audience half was written
 * (`WatchStreamSwap` swaps on `startedAt`, on a failure and on the token
 * clock). The web was never given it, and because the symptom is identical on
 * both platforms it read as the stream being broken rather than as one
 * platform missing a guard. Rafael reported the stream stopping every few
 * seconds to minutes on web and iOS; this is the web half.
 */
describe("hlsSessionKey", () => {
  const SESSION = "https://api.example.test/api/voice/hls-playlist/ch-1/1788962552321";

  it("ignores the per-viewer token, which is the only thing that usually moves", () => {
    expect(sameHlsSession(`${SESSION}?t=aaa`, `${SESSION}?t=bbb`)).toBe(true);
  });

  it("separates two sessions on the same channel", () => {
    const later = "https://api.example.test/api/voice/hls-playlist/ch-1/1788963814707";
    expect(sameHlsSession(`${SESSION}?t=aaa`, `${later}?t=aaa`)).toBe(false);
  });

  it("separates two channels", () => {
    const other = "https://api.example.test/api/voice/hls-playlist/ch-2/1788962552321";
    expect(sameHlsSession(SESSION, other)).toBe(false);
  });

  it("separates a rung playlist from the master it belongs to", () => {
    expect(sameHlsSession(SESSION, `${SESSION}/720p30`)).toBe(false);
  });

  it("treats a raw bucket URL, which has no token to strip, as its own key", () => {
    const raw = "https://live.example.test/live/ch-1/1788962552321.m3u8";
    expect(hlsSessionKey(raw)).toBe(raw);
    expect(sameHlsSession(raw, raw)).toBe(true);
  });

  it("says nothing is nothing", () => {
    expect(hlsSessionKey(null)).toBeNull();
    expect(sameHlsSession(null, null)).toBe(true);
    expect(sameHlsSession(null, SESSION)).toBe(false);
  });
});

/**
 * WHETHER TO ATTACH A BEARER HEADER, which is the client half of the stall.
 *
 * The header was called belt and braces in the code that added it. It was the
 * only strap that could break: `handleApi` resolves a Bearer ahead of the
 * router, so a Clerk JWT that expired in the last few seconds turned a request
 * the `?t=` capability would have served into a 401. `hls.js` refreshes its
 * cached JWT every 30 s without `forceRefresh` and a Clerk JWT lives about 60,
 * so roughly once a minute every web viewer's playlist request was rejected,
 * and the player stalled and recovered, over and over.
 *
 * The server no longer lets a failed Bearer veto a good capability either.
 * Both halves: either alone fixes today, and the pair is what stops it coming
 * back the next time somebody adds a header for safety.
 */
describe("hasHlsViewerToken", () => {
  const PROXY = "https://api.example.test/api/voice/hls-playlist/ch-1/17889";

  it("sees the capability that makes a header unnecessary", () => {
    expect(hasHlsViewerToken(`${PROXY}?t=abc.def`)).toBe(true);
  });

  it("sees it beside other parameters, in any order", () => {
    expect(hasHlsViewerToken(`${PROXY}?x=1&t=abc.def`)).toBe(true);
    expect(hasHlsViewerToken(`${PROXY}?t=abc.def&x=1`)).toBe(true);
  });

  /**
   * The case that must still get a header: a deployment with no viewer key
   * mints no token, and there the Bearer is the only door there is.
   */
  it("says no when there is no token, so the header still goes on", () => {
    expect(hasHlsViewerToken(PROXY)).toBe(false);
    expect(hasHlsViewerToken(`${PROXY}?x=1`)).toBe(false);
  });

  it("is not fooled by a parameter that merely starts with t", () => {
    expect(hasHlsViewerToken(`${PROXY}?token=abc`)).toBe(false);
    expect(hasHlsViewerToken(`${PROXY}?tt=abc`)).toBe(false);
  });
});

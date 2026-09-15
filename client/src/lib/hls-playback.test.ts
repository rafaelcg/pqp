import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chooseHlsEngine,
  createHlsTelemetryQueue,
  encodeToPaintLatencyMs,
  getHlsRebuildCount,
  hasHlsViewerToken,
  hlsFallbackRungLabel,
  hlsRungFromPlaylistUrl,
  hlsSessionKey,
  hlsTelemetryIdentityFromToken,
  hlsTelemetrySessionKey,
  hlsViewerTokenFromUrl,
  isAutoplayRefusal,
  isOwnHlsPlaylistProxyUrl,
  nextFreshPlaylistUrl,
  recordHlsRebuild,
  resetHlsRebuildCountForTest,
  resolveHlsUrl,
  resolveLiveHlsStream,
  sameHlsSession,
  sampleVideoPlaybackQuality,
  sendHlsTelemetryBatch,
  shouldAdoptHlsSource,
  withFreshHlsToken,
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

describe("shouldAdoptHlsSource", () => {
  const SESSION =
    "https://api.example.test/api/voice/hls-playlist/ch-1/1788962552321";

  it("adopts the first URL, because nothing is attached yet", () => {
    expect(shouldAdoptHlsSource(null, `${SESSION}?t=aaa`)).toBe(true);
  });

  it("does not re-attach on a restamped ?t= of the same session", () => {
    const attached = hlsSessionKey(`${SESSION}?t=aaa`);
    expect(shouldAdoptHlsSource(attached, `${SESSION}?t=bbb`)).toBe(false);
    expect(shouldAdoptHlsSource(attached, `${SESSION}?t=aaa`)).toBe(false);
  });

  it("re-attaches when the egress actually restarted", () => {
    const attached = hlsSessionKey(`${SESSION}?t=aaa`);
    const later =
      "https://api.example.test/api/voice/hls-playlist/ch-1/1788963814707?t=aaa";
    expect(shouldAdoptHlsSource(attached, later)).toBe(true);
  });
});

/**
 * THE BUG THIS EXISTS FOR (Farol review, PR 570). A same-session `src`
 * restamp (the server refreshes `?t=` on every audience keyframe) must not
 * re-attach hls.js, but it still has to reach the loader some way -- the
 * first cut of the ladder rework just returned on that branch and dropped
 * the fresher token on the floor until `reconnect()`'s own poll happened to
 * pick it up.
 */
describe("nextFreshPlaylistUrl", () => {
  const SESSION =
    "https://api.example.test/api/voice/hls-playlist/ch-1/1788962552321";

  it("is null on an attach -- nothing to restamp, the caller re-attaches instead", () => {
    expect(nextFreshPlaylistUrl(null, `${SESSION}?t=aaa`)).toBeNull();
    const later =
      "https://api.example.test/api/voice/hls-playlist/ch-1/1788963814707?t=aaa";
    const attached = hlsSessionKey(`${SESSION}?t=aaa`);
    expect(nextFreshPlaylistUrl(attached, later)).toBeNull();
  });

  it("hands back a same-session restamp, for the loader token ref", () => {
    const attached = hlsSessionKey(`${SESSION}?t=aaa`);
    expect(nextFreshPlaylistUrl(attached, `${SESSION}?t=bbb`)).toBe(
      `${SESSION}?t=bbb`,
    );
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

/**
 * B1.3, item 3: the loader-level alternative to rebuilding hls.js for a
 * routine token restamp.
 */
describe("withFreshHlsToken", () => {
  const SESSION = "https://api.example.test/api/voice/hls-playlist/ch-1/1788962552321";

  it("swaps the token on the exact master URL", () => {
    expect(withFreshHlsToken(`${SESSION}?t=old`, `${SESSION}?t=new`)).toBe(
      `${SESSION}?t=new`,
    );
  });

  it("swaps the token on a rung's own playlist, which is not sameHlsSession", () => {
    // The live stream's actual repeated fetch: a rung's media playlist,
    // never the master. `sameHlsSession` alone would miss this on purpose.
    expect(sameHlsSession(SESSION, `${SESSION}/720p30`)).toBe(false);
    expect(
      withFreshHlsToken(`${SESSION}/720p30?t=old`, `${SESSION}?t=new`),
    ).toBe(`${SESSION}/720p30?t=new`);
  });

  it("leaves a different channel or session alone", () => {
    const otherChannel =
      "https://api.example.test/api/voice/hls-playlist/ch-2/1788962552321?t=old";
    expect(withFreshHlsToken(otherChannel, `${SESSION}?t=new`)).toBe(
      otherChannel,
    );
    const laterSession =
      "https://api.example.test/api/voice/hls-playlist/ch-1/1788963814707?t=old";
    expect(withFreshHlsToken(laterSession, `${SESSION}?t=new`)).toBe(
      laterSession,
    );
  });

  it("leaves the URL alone when the fresh URL carries no token at all", () => {
    expect(withFreshHlsToken(`${SESSION}?t=old`, SESSION)).toBe(
      `${SESSION}?t=old`,
    );
  });

  it("is a no-op once the URL already carries the freshest token", () => {
    expect(withFreshHlsToken(`${SESSION}?t=new`, `${SESSION}?t=new`)).toBe(
      `${SESSION}?t=new`,
    );
  });

  it("preserves other query parameters on the request", () => {
    expect(
      withFreshHlsToken(`${SESSION}?x=1&t=old`, `${SESSION}?t=new`),
    ).toBe(`${SESSION}?x=1&t=new`);
  });
});

describe("hlsViewerTokenFromUrl", () => {
  const PROXY = "https://api.example.test/api/voice/hls-playlist/ch-1/17889";

  it("reads the token out", () => {
    expect(hlsViewerTokenFromUrl(`${PROXY}?t=abc.def`)).toBe("abc.def");
  });

  it("finds it beside other parameters, in any order", () => {
    expect(hlsViewerTokenFromUrl(`${PROXY}?x=1&t=abc.def`)).toBe("abc.def");
    expect(hlsViewerTokenFromUrl(`${PROXY}?t=abc.def&x=1`)).toBe("abc.def");
  });

  it("is null with no query string, no t, or a look-alike parameter", () => {
    expect(hlsViewerTokenFromUrl(PROXY)).toBeNull();
    expect(hlsViewerTokenFromUrl(`${PROXY}?x=1`)).toBeNull();
    expect(hlsViewerTokenFromUrl(`${PROXY}?token=abc`)).toBeNull();
  });
});

describe("sampleVideoPlaybackQuality", () => {
  it("reads dropped and total frames when the engine reports them", () => {
    expect(
      sampleVideoPlaybackQuality({
        getVideoPlaybackQuality: () => ({
          droppedVideoFrames: 3,
          totalVideoFrames: 180,
        }),
      }),
    ).toEqual({ droppedVideoFrames: 3, totalVideoFrames: 180 });
    expect(sampleVideoPlaybackQuality({})).toBeNull();
  });
});

describe("resolveLiveHlsStream", () => {
  const stream = {
    hlsUrl: "/api/voice/hls-playlist/c/1?t=tok",
    startedAt: 1,
    presenterPeerId: "p1",
  };

  it("resolves both playlists, not just the film", () => {
    // THE FOUR DOORS. A stream arrives through `voice-stream`,
    // `channel-live`, the one-shot `GET /api/channels/:id/live` and the
    // player's own reconnect. Resolving field by field at each is how one of
    // them ends up API-relative and unplayable at exactly one of them,
    // during somebody's film.
    const resolved = resolveLiveHlsStream({
      ...stream,
      cameraHlsUrl: "/api/voice/hls-playlist/c/1/cam360p30?t=tok",
    });
    expect(resolved.hlsUrl).toBe(resolveHlsUrl(stream.hlsUrl));
    expect(resolved.cameraHlsUrl).toBe(
      resolveHlsUrl("/api/voice/hls-playlist/c/1/cam360p30?t=tok"),
    );
  });

  it("leaves a stream with no camera exactly as it was", () => {
    // Optional on the wire: an older server, iOS and Android all send a
    // stream with no camera at all, and must go on working untouched.
    const resolved = resolveLiveHlsStream<{
      hlsUrl: string;
      cameraHlsUrl?: string;
    }>(stream);
    expect(resolved).toEqual({ ...stream, hlsUrl: resolveHlsUrl(stream.hlsUrl) });
    expect(resolved.cameraHlsUrl).toBeUndefined();
  });

  it("passes an already absolute URL through untouched", () => {
    const absolute = {
      ...stream,
      hlsUrl: "https://live.example.test/a.m3u8",
      cameraHlsUrl: "https://live.example.test/cam.m3u8",
    };
    expect(resolveLiveHlsStream(absolute)).toEqual(absolute);
  });
});

/**
 * B1: how often the recovery ladder had to give up and tear the whole
 * player down, for B0's telemetry hook to read. A module-level counter
 * (like `stats` above), not per-render state, so it survives the rebuild it
 * is counting.
 */
describe("the hls rebuild counter", () => {
  it("starts at zero and counts every rebuild recorded since", () => {
    resetHlsRebuildCountForTest();
    expect(getHlsRebuildCount()).toBe(0);
    expect(recordHlsRebuild()).toBe(1);
    expect(recordHlsRebuild()).toBe(2);
    expect(getHlsRebuildCount()).toBe(2);
  });

  it("resets cleanly for the next test file's run", () => {
    resetHlsRebuildCountForTest();
    expect(getHlsRebuildCount()).toBe(0);
  });
});

describe("hlsTelemetrySessionKey", () => {
  it("extracts channel and startedAt from a media playlist URL", () => {
    expect(
      hlsTelemetrySessionKey(
        "https://api.example.test/api/voice/hls-playlist/chan-1/1700000000000/720p30?t=abc",
      ),
    ).toBe("chan-1:1700000000000");
  });

  it("extracts channel and startedAt from a master (no-rung) playlist URL", () => {
    expect(
      hlsTelemetrySessionKey(
        "https://api.example.test/api/voice/hls-playlist/chan-1/1700000000000?t=abc",
      ),
    ).toBe("chan-1:1700000000000");
  });

  it("falls back to the query-stripped URL for a supported non-proxy stream (LIVE_HLS_SIGNED_URLS=false)", () => {
    // Farol finding, 2026-09-13: this used to return null, which meant a
    // deployment running unsigned public bucket URLs sent no telemetry at
    // all despite playing the stream just fine.
    expect(
      hlsTelemetrySessionKey("https://live.example.test/live/chan-1/a.m3u8?x=1"),
    ).toBe("https://live.example.test/live/chan-1/a.m3u8");
  });

  it("is null only when there is nothing at all to key on", () => {
    expect(hlsTelemetrySessionKey("")).toBeNull();
  });
});

describe("hlsRungFromPlaylistUrl", () => {
  it("extracts the rung path segment", () => {
    expect(
      hlsRungFromPlaylistUrl(
        "https://api.example.test/api/voice/hls-playlist/chan-1/1700000000000/720p30",
      ),
    ).toBe("720p30");
  });

  it("is null for a master (no-rung) URL", () => {
    expect(
      hlsRungFromPlaylistUrl(
        "https://api.example.test/api/voice/hls-playlist/chan-1/1700000000000",
      ),
    ).toBeNull();
  });

  it("is null for null, undefined or an unrelated URL", () => {
    expect(hlsRungFromPlaylistUrl(null)).toBeNull();
    expect(hlsRungFromPlaylistUrl(undefined)).toBeNull();
    expect(hlsRungFromPlaylistUrl("https://live.example.test/a.ts")).toBeNull();
  });
});

describe("hlsFallbackRungLabel", () => {
  it("builds a <height>p<framerate> label matching the server's own rung naming", () => {
    expect(hlsFallbackRungLabel({ height: 720, framerate: 30 })).toBe("720p30");
    expect(hlsFallbackRungLabel({ height: 1080, framerate: 60 })).toBe("1080p60");
  });

  it("rounds a non-integer framerate", () => {
    expect(hlsFallbackRungLabel({ height: 720, framerate: 29.97 })).toBe("720p30");
  });

  it("is null when height or framerate is missing, zero, or the level itself is missing", () => {
    expect(hlsFallbackRungLabel({ height: 720 })).toBeNull();
    expect(hlsFallbackRungLabel({ framerate: 30 })).toBeNull();
    expect(hlsFallbackRungLabel({ height: 0, framerate: 30 })).toBeNull();
    expect(hlsFallbackRungLabel(null)).toBeNull();
    expect(hlsFallbackRungLabel(undefined)).toBeNull();
  });
});

describe("hlsTelemetryIdentityFromToken", () => {
  it("reads the sub claim out of a JWT-shaped token, unverified", () => {
    const payload = btoa(JSON.stringify({ sub: "user_abc123" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const token = `header.${payload}.signature`;
    expect(hlsTelemetryIdentityFromToken(token)).toBe("user_abc123");
  });

  it("falls back to the raw token when it does not look like a JWT", () => {
    expect(hlsTelemetryIdentityFromToken("dev-local-token")).toBe(
      "dev-local-token",
    );
    expect(hlsTelemetryIdentityFromToken("dev-local-token:bob")).toBe(
      "dev-local-token:bob",
    );
  });

  it("falls back to the raw token when the JWT-shaped string has no readable sub", () => {
    const payload = btoa(JSON.stringify({ nope: true }));
    const token = `header.${payload}.signature`;
    expect(hlsTelemetryIdentityFromToken(token)).toBe(token);
  });

  it("is null for a null token", () => {
    expect(hlsTelemetryIdentityFromToken(null)).toBeNull();
  });

  it("is deterministic for the same token", () => {
    const token = "dev-local-token:alice";
    expect(hlsTelemetryIdentityFromToken(token)).toBe(
      hlsTelemetryIdentityFromToken(token),
    );
  });
});

describe("encodeToPaintLatencyMs", () => {
  it("computes latency from a fragment's PDT and the painted media time", () => {
    const frag = { programDateTimeMs: 1_000_000, startSeconds: 10 };
    // The painted frame is 2s into this fragment, so its own wall clock is
    // 1_000_000 + 2000 = 1_002_000. "Now" is 1_010_000, so latency is 8_000.
    expect(encodeToPaintLatencyMs(frag, 12, 1_010_000)).toBe(8_000);
  });

  it("is null when the fragment carries no usable PDT", () => {
    expect(encodeToPaintLatencyMs({ programDateTimeMs: 0, startSeconds: 0 }, 5, 1_000)).toBeNull();
    expect(
      encodeToPaintLatencyMs({ programDateTimeMs: NaN, startSeconds: 0 }, 5, 1_000),
    ).toBeNull();
  });

  it("floors a negative result (clock skew) at zero rather than reporting it", () => {
    const frag = { programDateTimeMs: 1_000_000, startSeconds: 0 };
    // The painted media time's own wall clock (1_005_000) is AFTER "now"
    // (1_000_000): impossible without clock skew between browser and egress.
    expect(encodeToPaintLatencyMs(frag, 5, 1_000_000)).toBe(0);
  });

  it("defaults `now` to the real clock when not given", () => {
    const frag = { programDateTimeMs: Date.now() - 5_000, startSeconds: 0 };
    const latency = encodeToPaintLatencyMs(frag, 0);
    expect(latency).not.toBeNull();
    expect(latency!).toBeGreaterThan(4_000);
    expect(latency!).toBeLessThan(6_000);
  });
});

describe("createHlsTelemetryQueue", () => {
  let tick: (() => void) | null = null;

  function fakeTimers() {
    return {
      setInterval: ((fn: () => void) => {
        tick = fn;
        return 1 as unknown as ReturnType<typeof window.setInterval>;
      }) as typeof window.setInterval,
      clearInterval: (() => {
        tick = null;
      }) as typeof window.clearInterval,
    };
  }

  beforeEach(() => {
    tick = null;
  });

  it("does not send anything on push -- only the timer flushes", () => {
    const send = vi.fn();
    const queue = createHlsTelemetryQueue({ sessionId: "s1", send, ...fakeTimers() });
    queue.push({ rung: "720p30", latencyMs: 1_000 });
    expect(send).not.toHaveBeenCalled();
    queue.stop();
  });

  it("flushes the buffered batch on the interval and clears it after", () => {
    const send = vi.fn();
    const queue = createHlsTelemetryQueue({ sessionId: "s1", send, ...fakeTimers() });
    queue.push({ rung: "720p30", latencyMs: 1_000 });
    queue.push({ rung: "720p30", latencyMs: 2_000 });
    tick!();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      {
        sessionId: "s1",
        samples: [
          { rung: "720p30", latencyMs: 1_000 },
          { rung: "720p30", latencyMs: 2_000 },
        ],
      },
      null,
    );
    // The buffer was cleared: a second tick with nothing new sends nothing.
    tick!();
    expect(send).toHaveBeenCalledTimes(1);
    queue.stop();
  });

  it("an empty buffer never sends an empty batch", () => {
    const send = vi.fn();
    const queue = createHlsTelemetryQueue({ sessionId: "s1", send, ...fakeTimers() });
    tick!();
    expect(send).not.toHaveBeenCalled();
    queue.stop();
  });

  it("manual flush() bypasses the timer, for an unmount", () => {
    const send = vi.fn();
    const queue = createHlsTelemetryQueue({ sessionId: "s1", send, ...fakeTimers() });
    queue.push({ rung: "720p30", latencyMs: 1_000 });
    queue.flush();
    expect(send).toHaveBeenCalledTimes(1);
    queue.stop();
  });

  it("stop() clears the timer and drops anything still buffered", () => {
    const clearInterval = vi.fn();
    const send = vi.fn();
    const queue = createHlsTelemetryQueue({
      sessionId: "s1",
      send,
      setInterval: fakeTimers().setInterval,
      clearInterval,
    });
    queue.push({ rung: "720p30", latencyMs: 1_000 });
    queue.stop();
    expect(clearInterval).toHaveBeenCalled();
    // Nothing left to flush even if something called flush() after stop.
    queue.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("forwards sessionToken on every flush when one was given", () => {
    const send = vi.fn();
    const queue = createHlsTelemetryQueue({
      sessionId: "s1",
      sessionToken: "abc.def",
      send,
      ...fakeTimers(),
    });
    queue.push({ rung: "720p30", latencyMs: 1_000 });
    tick!();
    expect(send).toHaveBeenCalledWith(
      {
        sessionId: "s1",
        sessionToken: "abc.def",
        samples: [{ rung: "720p30", latencyMs: 1_000 }],
      },
      null,
    );
    queue.stop();
  });

  it("omits sessionToken entirely rather than sending it as null", () => {
    const send = vi.fn();
    const queue = createHlsTelemetryQueue({
      sessionId: "s1",
      sessionToken: null,
      send,
      ...fakeTimers(),
    });
    queue.push({ rung: "720p30", latencyMs: 1_000 });
    tick!();
    const [sent] = send.mock.calls[0]!;
    expect(sent).not.toHaveProperty("sessionToken");
    queue.stop();
  });

  /**
   * Farol finding, 2026-09-14: the unmount flush used to await an async
   * token getter before calling `fetch`, which a page that is unloading is
   * not guaranteed to resume -- the final samples were silently lost. The
   * queue now caches a plain token value and reads it synchronously.
   */
  describe("token caching", () => {
    it("sends the token given at creation, with no async lookup", () => {
      const send = vi.fn();
      const queue = createHlsTelemetryQueue({
        sessionId: "s1",
        token: "token-at-creation",
        send,
        ...fakeTimers(),
      });
      queue.push({ rung: "720p30", latencyMs: 1_000 });
      tick!();
      expect(send).toHaveBeenCalledWith(expect.anything(), "token-at-creation");
      queue.stop();
    });

    it("sends null when no token was given and none was set", () => {
      const send = vi.fn();
      const queue = createHlsTelemetryQueue({ sessionId: "s1", send, ...fakeTimers() });
      queue.push({ rung: "720p30", latencyMs: 1_000 });
      tick!();
      expect(send).toHaveBeenCalledWith(expect.anything(), null);
      queue.stop();
    });

    it("setToken updates what the NEXT flush sends, without touching an already-buffered flush", () => {
      const send = vi.fn();
      const queue = createHlsTelemetryQueue({
        sessionId: "s1",
        token: "old-token",
        send,
        ...fakeTimers(),
      });
      queue.push({ rung: "720p30", latencyMs: 1_000 });
      queue.setToken("fresh-token");
      tick!();
      expect(send).toHaveBeenCalledWith(expect.anything(), "fresh-token");
      queue.stop();
    });

    it("flush() (the unmount path) also uses the cached token synchronously", () => {
      const send = vi.fn();
      const queue = createHlsTelemetryQueue({
        sessionId: "s1",
        token: "unmount-token",
        send,
        ...fakeTimers(),
      });
      queue.push({ rung: "720p30", latencyMs: 1_000 });
      queue.flush();
      expect(send).toHaveBeenCalledWith(expect.anything(), "unmount-token");
    });
  });
});

describe("sendHlsTelemetryBatch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the telemetry endpoint with a Bearer token when one is available", async () => {
    const fetchMock = vi.fn(
      async (_url?: string | URL | Request, _init?: RequestInit) =>
        new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    sendHlsTelemetryBatch(
      { sessionId: "s1", samples: [{ rung: "720p30", latencyMs: 1_000 }] },
      "token-abc",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/live-hls/telemetry");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer token-abc",
    });
  });

  it("calls fetch synchronously -- nothing is awaited before it, so an unmount flush is not lost", () => {
    // Farol finding, 2026-09-14: this used to take an async token getter and
    // await it before calling fetch, which a page unloading between the
    // await and the fetch is free to never resume. `token` is now a plain
    // value, and this test's whole point is that `fetch` has already been
    // called by the time this line runs, with no `await` in between.
    const fetchMock = vi.fn(
      async () => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    sendHlsTelemetryBatch(
      { sessionId: "s1", samples: [{ rung: "720p30", latencyMs: 1_000 }] },
      "token-abc",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never throws when the fetch itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(() =>
      sendHlsTelemetryBatch(
        { sessionId: "s1", samples: [{ rung: "720p30", latencyMs: 1_000 }] },
        "token-abc",
      ),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("omits the Authorization header entirely when there is no token", async () => {
    const fetchMock = vi.fn(
      async (_url?: string | URL | Request, _init?: RequestInit) =>
        new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    sendHlsTelemetryBatch(
      { sessionId: "s1", samples: [{ rung: "720p30", latencyMs: 1_000 }] },
      null,
    );
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).not.toHaveProperty("Authorization");
  });
});

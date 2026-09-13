import { describe, expect, it } from "vitest";
import {
  BEHIND_LIVE_THRESHOLD_SECONDS,
  HLS_ABR_DEFAULT_ESTIMATE_BPS,
  HLS_BACK_BUFFER_LENGTH_SECONDS,
  HLS_CATCH_UP_MAX_PLAYBACK_RATE,
  HLS_EGRESS_WINDOW_SEGMENTS,
  HLS_LIVE_SEGMENT_SECONDS,
  HLS_LIVE_SYNC_DURATION_COUNT,
  HLS_LIVE_WINDOW_SECONDS,
  HLS_PLAYER_CUSHION_SECONDS,
  applyHlsRecoveryStep,
  buildMediaSessionMetadata,
  catchUpPlaybackRate,
  effectiveLiveSyncDurationCount,
  endToEndDelaySeconds,
  hasSafariPresentationMode,
  hlsLivePlayerConfig,
  hlsLiveSyncFitsWindow,
  isBehindLive,
  isPipAvailable,
  jumpToLiveTime,
  liveSeekTarget,
  mediaSeekableEnd,
  reloadHlsLevelPlaylist,
  resolveLiveEdge,
  secondsBehindCatchUpTarget,
  secondsBehindLive,
  type HlsRecoveryHandle,
} from "./hls-live-edge";

describe("hlsLivePlayerConfig", () => {
  it("sits 20 s behind live with 48 s of tolerance, inside the proxy's 60 s window", () => {
    const config = hlsLivePlayerConfig();
    expect(config.liveSyncDurationCount).toBe(5);
    expect(config.liveMaxLatencyDurationCount).toBe(12);
    expect(
      config.liveSyncDurationCount * HLS_LIVE_SEGMENT_SECONDS,
    ).toBeLessThan(HLS_LIVE_WINDOW_SECONDS);
    expect(hlsLiveSyncFitsWindow(config)).toBe(true);
    expect(config.startLevel).toBe(-1);
    expect(config.backBufferLength).toBe(HLS_BACK_BUFFER_LENGTH_SECONDS);
    expect(config.backBufferLength).toBeLessThanOrEqual(HLS_LIVE_WINDOW_SECONDS);
    expect(HLS_ABR_DEFAULT_ESTIMATE_BPS).toBeGreaterThanOrEqual(2_500_000);
  });

  it("leaves a segment of slack on the egress's native five-segment window", () => {
    // The egress itself always keeps five segments (LiveKit's fixed
    // `defaultLivePlaylistWindow`), which at 4 s is a 20 s window. The raw
    // 5-count sync point would land on its OLDEST entry with zero slack, so
    // a slow poll ages it out and hls.js re-syncs or stalls; the effective
    // count caps it to leave one listed segment behind the sync point.
    const effective = effectiveLiveSyncDurationCount(HLS_EGRESS_WINDOW_SEGMENTS);
    expect(effective).toBe(HLS_EGRESS_WINDOW_SEGMENTS - 1);
    expect(HLS_EGRESS_WINDOW_SEGMENTS - effective).toBeGreaterThanOrEqual(1);
  });

  it("refuses a sync that would join on the oldest segment of the window", () => {
    expect(
      hlsLiveSyncFitsWindow({
        liveSyncDurationCount: 15,
        liveMaxLatencyDurationCount: 16,
        maxBufferLength: 8,
        maxMaxBufferLength: 10,
        backBufferLength: 10,
        startLevel: 0,
      }),
    ).toBe(false);
  });

  it("refuses an infinite back-buffer, which kept a whole party in the SourceBuffer", () => {
    const config = hlsLivePlayerConfig();
    expect(
      hlsLiveSyncFitsWindow({ ...config, backBufferLength: Number.POSITIVE_INFINITY }),
    ).toBe(false);
  });
});

describe("effectiveLiveSyncDurationCount", () => {
  it("is a no-op on the production 15-segment window", () => {
    expect(effectiveLiveSyncDurationCount(15)).toBe(HLS_LIVE_SYNC_DURATION_COUNT);
  });

  it("caps to one segment of slack on the legacy five-segment window", () => {
    expect(effectiveLiveSyncDurationCount(HLS_EGRESS_WINDOW_SEGMENTS)).toBe(4);
  });

  it("never exceeds the listed depth minus one", () => {
    expect(effectiveLiveSyncDurationCount(3)).toBe(2);
    expect(effectiveLiveSyncDurationCount(6)).toBe(HLS_LIVE_SYNC_DURATION_COUNT);
  });

  it("keeps the configured count when the playlist is too short to offer slack", () => {
    // A just-started egress (one segment) or an unreadable count: hls.js
    // clamps to what exists rather than us subtracting below 1.
    expect(effectiveLiveSyncDurationCount(1)).toBe(HLS_LIVE_SYNC_DURATION_COUNT);
    expect(effectiveLiveSyncDurationCount(Number.NaN)).toBe(
      HLS_LIVE_SYNC_DURATION_COUNT,
    );
  });
});

describe("endToEndDelaySeconds", () => {
  it("adds the player cushion to the pipeline delay the server reports", () => {
    expect(endToEndDelaySeconds(10)).toBe(10 + HLS_PLAYER_CUSHION_SECONDS);
  });

  it("is the cushion alone when no wire value is present", () => {
    // The floor: pipeline unknown, but the player still sits ~20 s back.
    expect(endToEndDelaySeconds(undefined)).toBe(HLS_PLAYER_CUSHION_SECONDS);
    expect(endToEndDelaySeconds(null)).toBe(HLS_PLAYER_CUSHION_SECONDS);
    expect(endToEndDelaySeconds(0)).toBe(HLS_PLAYER_CUSHION_SECONDS);
  });

  it("reflects the cushion rather than under-reporting the pipeline alone", () => {
    // The bug: a 10 s pipeline was shown as 10 s even though viewers are
    // ~30 s behind. The total must exceed the pipeline figure.
    expect(endToEndDelaySeconds(10)).toBeGreaterThan(10);
  });
});

describe("secondsBehindLive", () => {
  it("is zero when caught up or ahead", () => {
    expect(secondsBehindLive(10, 10)).toBe(0);
    expect(secondsBehindLive(12, 10)).toBe(0);
  });

  it("is the gap when behind", () => {
    expect(secondsBehindLive(0, 15)).toBe(15);
  });
});

/**
 * THE BUG THIS EXISTS FOR (Farol review, PR 570). The player sits
 * `HLS_PLAYER_CUSHION_SECONDS` (~20 s) behind the live edge ON PURPOSE, so
 * `catchUpPlaybackRate(secondsBehindLive(...))` flagged every ordinary
 * viewer sitting exactly where the design put them -- `> 6 s` is 1.2x on
 * that curve, and an untouched viewer's raw distance from the edge is ~20 s.
 * `secondsBehindCatchUpTarget` measures from the cushioned target instead,
 * so only genuine drift PAST the cushion is ever non-zero.
 */
describe("secondsBehindCatchUpTarget", () => {
  it("is zero for a viewer sitting exactly at the player's own cushion", () => {
    // The common case this bug broke: liveEdge=100, cushion=20 -> target=80.
    // A viewer sitting right at 80 has not drifted at all.
    expect(secondsBehindCatchUpTarget(80, 100, HLS_PLAYER_CUSHION_SECONDS)).toBe(
      0,
    );
    expect(catchUpPlaybackRate(secondsBehindCatchUpTarget(80, 100))).toBe(1);
  });

  it("is zero for a viewer sitting closer to live than the cushion", () => {
    expect(secondsBehindCatchUpTarget(95, 100)).toBe(0);
  });

  it("is the drift PAST the cushioned target when a viewer falls behind it", () => {
    // target = 100 - 20 = 80; sitting at 74 is 6 s past the intended point.
    expect(secondsBehindCatchUpTarget(74, 100)).toBe(6);
    expect(catchUpPlaybackRate(secondsBehindCatchUpTarget(74, 100))).toBe(1.1);
  });

  it("honors a custom cushion, not just the player's default", () => {
    // cushion 5 -> target = 95.
    expect(secondsBehindCatchUpTarget(95, 100, 5)).toBe(0);
    expect(secondsBehindCatchUpTarget(85, 100, 5)).toBe(10);
  });

  it("is zero on garbage input rather than a negative or NaN rate", () => {
    expect(secondsBehindCatchUpTarget(Number.NaN, 100)).toBe(0);
    expect(secondsBehindCatchUpTarget(50, Number.NaN)).toBe(0);
  });
});

describe("jumpToLiveTime", () => {
  it("lands one segment behind the live edge", () => {
    expect(jumpToLiveTime(20, 2)).toBe(18);
    expect(jumpToLiveTime(1, 2)).toBe(0);
  });
});

describe("resolveLiveEdge", () => {
  it("prefers the larger clock when liveSync is a leftover first-window value", () => {
    // Playing at ~48 s of a growing timeline; startLoad reset liveSync to 8.
    expect(resolveLiveEdge(8, 48)).toBe(48);
  });

  it("uses liveSync when seekable is empty", () => {
    expect(resolveLiveEdge(46, Number.NaN)).toBe(46);
  });

  it("uses seekable when liveSync is missing", () => {
    expect(resolveLiveEdge(null, 48)).toBe(48);
    expect(resolveLiveEdge(undefined, 48)).toBe(48);
  });

  it("is null when neither clock is finite", () => {
    expect(resolveLiveEdge(null, Number.NaN)).toBeNull();
    expect(resolveLiveEdge(Number.POSITIVE_INFINITY, Number.NaN)).toBeNull();
  });
});

describe("mediaSeekableEnd", () => {
  it("reads the last seekable end", () => {
    expect(
      mediaSeekableEnd({
        seekable: { length: 1, end: () => 48 },
      }),
    ).toBe(48);
  });

  it("is NaN when nothing is seekable yet", () => {
    expect(
      Number.isNaN(
        mediaSeekableEnd({
          seekable: { length: 0, end: () => 0 },
        }),
      ),
    ).toBe(true);
  });
});

describe("liveSeekTarget", () => {
  it("lands near the real edge, not a stale 8 s liveSync", () => {
    expect(
      liveSeekTarget({
        currentTime: 46,
        liveSyncPosition: 8,
        seekableEnd: 48,
      }),
    ).toBe(44);
  });

  it("refuses a rewind bigger than the live window when seekable is empty", () => {
    // startLoad left liveSync at 8; duration/seekable not readable yet.
    expect(
      liveSeekTarget({
        currentTime: 70,
        liveSyncPosition: 8,
        seekableEnd: Number.NaN,
      }),
    ).toBeNull();
  });

  it("still allows a small catch-up toward live", () => {
    expect(
      liveSeekTarget({
        currentTime: 38,
        liveSyncPosition: 46,
        seekableEnd: 48,
      }),
    ).toBe(44);
  });
});

describe("isBehindLive", () => {
  it("is false within the player's own ~20 s cushion", () => {
    // The player deliberately sits ~20 s behind live; that cushion alone
    // must not trip the "you fell behind" state.
    expect(isBehindLive(0, BEHIND_LIVE_THRESHOLD_SECONDS)).toBe(false);
  });

  it("is true once the playhead drifts past the threshold", () => {
    expect(isBehindLive(0, BEHIND_LIVE_THRESHOLD_SECONDS + 0.01)).toBe(true);
  });

  it("accepts a custom threshold", () => {
    expect(isBehindLive(0, 5, 3)).toBe(true);
    expect(isBehindLive(0, 2, 3)).toBe(false);
  });
});

describe("buildMediaSessionMetadata", () => {
  it("uses the community name and cover when given", () => {
    const meta = buildMediaSessionMetadata({
      title: "Movie night",
      communityName: "QG",
      coverUrl: "https://example.com/icon.png",
    });
    expect(meta.title).toBe("Movie night");
    expect(meta.artist).toBe("QG");
    expect(meta.album).toBe("QG");
    expect(meta.artwork).toEqual([
      { src: "https://example.com/icon.png", sizes: "512x512" },
    ]);
  });

  it("falls back to pqp with no artwork when there is no community or cover", () => {
    const meta = buildMediaSessionMetadata({ title: "Movie night" });
    expect(meta.artist).toBe("pqp");
    expect(meta.album).toBe("pqp");
    expect(meta.artwork).toEqual([]);
  });
});

describe("isPipAvailable", () => {
  it("requires the enabled flag and no disable attribute", () => {
    expect(
      isPipAvailable({
        pictureInPictureEnabled: true,
        disablePictureInPicture: false,
      }),
    ).toBe(true);
    expect(
      isPipAvailable({
        pictureInPictureEnabled: false,
        disablePictureInPicture: false,
      }),
    ).toBe(false);
    expect(
      isPipAvailable({
        pictureInPictureEnabled: true,
        disablePictureInPicture: true,
      }),
    ).toBe(false);
  });
});

describe("hasSafariPresentationMode", () => {
  it("is false for a plain object", () => {
    expect(hasSafariPresentationMode({})).toBe(false);
    expect(hasSafariPresentationMode(null)).toBe(false);
  });

  it("reads Safari's webkitSupportsPresentationMode", () => {
    const el = {
      webkitSupportsPresentationMode: (mode: string) =>
        mode === "picture-in-picture",
    };
    expect(hasSafariPresentationMode(el)).toBe(true);
  });

  it("is false when Safari reports the mode unsupported", () => {
    const el = { webkitSupportsPresentationMode: () => false };
    expect(hasSafariPresentationMode(el)).toBe(false);
  });
});

/**
 * B1.1: a curve, not the flat `maxLiveSyncPlaybackRate: 1.5` that pitched
 * music and was reverted. Every tier stays at or under 1.2x.
 */
describe("catchUpPlaybackRate", () => {
  it("is 1.0x at and inside the cushion", () => {
    expect(catchUpPlaybackRate(0)).toBe(1);
    expect(catchUpPlaybackRate(0.5)).toBe(1);
    expect(catchUpPlaybackRate(1)).toBe(1);
  });

  it("ramps gently as the distance grows", () => {
    expect(catchUpPlaybackRate(1.5)).toBe(1.05);
    expect(catchUpPlaybackRate(3)).toBe(1.05);
    expect(catchUpPlaybackRate(3.5)).toBe(1.1);
    expect(catchUpPlaybackRate(6)).toBe(1.1);
    expect(catchUpPlaybackRate(6.5)).toBe(HLS_CATCH_UP_MAX_PLAYBACK_RATE);
  });

  it("never goes faster than 1.2x, however far behind", () => {
    expect(catchUpPlaybackRate(30)).toBe(HLS_CATCH_UP_MAX_PLAYBACK_RATE);
    expect(catchUpPlaybackRate(600)).toBe(HLS_CATCH_UP_MAX_PLAYBACK_RATE);
    expect(HLS_CATCH_UP_MAX_PLAYBACK_RATE).toBeLessThanOrEqual(1.2);
  });

  it("is 1.0x on garbage input rather than throwing", () => {
    expect(catchUpPlaybackRate(Number.NaN)).toBe(1);
    expect(catchUpPlaybackRate(-5)).toBe(1);
  });
});

describe("reloadHlsLevelPlaylist", () => {
  it("cycles a pinned level through Auto and back, so the pin survives", () => {
    const calls: string[] = [];
    const hls: HlsRecoveryHandle = {
      currentLevel: 2,
      stopLoad: () => calls.push("stopLoad"),
      startLoad: (pos) => calls.push(`startLoad(${pos})`),
    };
    reloadHlsLevelPlaylist(hls);
    expect(calls).toEqual(["stopLoad", "startLoad(-1)"]);
    expect(hls.currentLevel).toBe(2);
  });

  it("does not need a second assignment when already on Auto", () => {
    const hls: HlsRecoveryHandle = { currentLevel: -1 };
    // No stopLoad/startLoad on the handle: must not throw.
    expect(() => reloadHlsLevelPlaylist(hls)).not.toThrow();
    expect(hls.currentLevel).toBe(-1);
  });
});

describe("applyHlsRecoveryStep", () => {
  function fakeHls(): HlsRecoveryHandle & { calls: string[] } {
    const calls: string[] = [];
    return {
      currentLevel: 3,
      recoverMediaError: () => calls.push("recoverMediaError"),
      startLoad: (pos) => calls.push(`startLoad(${pos})`),
      stopLoad: () => calls.push("stopLoad"),
      calls,
    };
  }

  it("maps each ladder step to its hls.js call", () => {
    const a = fakeHls();
    applyHlsRecoveryStep(a, "recover-media-error");
    expect(a.calls).toEqual(["recoverMediaError"]);

    const b = fakeHls();
    applyHlsRecoveryStep(b, "start-load");
    expect(b.calls).toEqual(["startLoad(-1)"]);

    const c = fakeHls();
    applyHlsRecoveryStep(c, "restart-load");
    expect(c.calls).toEqual(["stopLoad", "startLoad(-1)"]);

    const d = fakeHls();
    applyHlsRecoveryStep(d, "reload-level");
    expect(d.calls).toEqual(["stopLoad", "startLoad(-1)"]);
    expect(d.currentLevel).toBe(3);
  });

  it("is a no-op on a null handle -- a not-yet-attached or torn-down player", () => {
    expect(() => applyHlsRecoveryStep(null, "start-load")).not.toThrow();
    expect(() => applyHlsRecoveryStep(undefined, "reload-level")).not.toThrow();
  });
});

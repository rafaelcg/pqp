import { describe, expect, it } from "vitest";
import {
  BEHIND_LIVE_THRESHOLD_SECONDS,
  HLS_ABR_DEFAULT_ESTIMATE_BPS,
  HLS_BACK_BUFFER_LENGTH_SECONDS,
  HLS_LIVE_SEGMENT_SECONDS,
  HLS_LIVE_WINDOW_SECONDS,
  buildMediaSessionMetadata,
  hasSafariPresentationMode,
  hlsLivePlayerConfig,
  hlsLiveSyncFitsWindow,
  isBehindLive,
  isPipAvailable,
  jumpToLiveTime,
  liveSeekTarget,
  mediaSeekableEnd,
  resolveLiveEdge,
  secondsBehindLive,
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

  it("still lands on the oldest listed segment, not past it, on an API that serves only the egress's native window", () => {
    // The egress itself always keeps five segments (LiveKit's fixed
    // `defaultLivePlaylistWindow`), which at 4 s is a 20 s window — the
    // same 20 s the player now sits behind live by design. An older API
    // that predates the proxy's 60 s widening still lists exactly enough
    // to cover the sync point; it is tight (no slack for a slow poll) but
    // not negative, which is what would force an immediate re-sync.
    const config = hlsLivePlayerConfig();
    const egressWindowSegments = 5;
    expect(egressWindowSegments - config.liveSyncDurationCount).toBe(0);
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

describe("secondsBehindLive", () => {
  it("is zero when caught up or ahead", () => {
    expect(secondsBehindLive(10, 10)).toBe(0);
    expect(secondsBehindLive(12, 10)).toBe(0);
  });

  it("is the gap when behind", () => {
    expect(secondsBehindLive(0, 15)).toBe(15);
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

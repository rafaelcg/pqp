import { describe, expect, it } from "vitest";
import {
  BEHIND_LIVE_THRESHOLD_SECONDS,
  HLS_LIVE_SEGMENT_SECONDS,
  HLS_LIVE_WINDOW_SECONDS,
  buildMediaSessionMetadata,
  hasSafariPresentationMode,
  hlsLivePlayerConfig,
  hlsLiveSyncFitsWindow,
  isBehindLive,
  isPipAvailable,
  jumpToLiveTime,
  secondsBehindLive,
} from "./hls-live-edge";

describe("hlsLivePlayerConfig", () => {
  it("sits a little further from the edge than the old 3 segments, still inside the 10 s window", () => {
    const config = hlsLivePlayerConfig();
    expect(config.liveSyncDurationCount).toBeGreaterThan(3);
    expect(
      config.liveSyncDurationCount * HLS_LIVE_SEGMENT_SECONDS,
    ).toBeLessThan(HLS_LIVE_WINDOW_SECONDS);
    expect(hlsLiveSyncFitsWindow(config)).toBe(true);
    expect(config.startLevel).toBe(0);
  });

  it("refuses a sync that would join on the oldest segment of the window", () => {
    expect(
      hlsLiveSyncFitsWindow({
        liveSyncDurationCount: 5,
        liveMaxLatencyDurationCount: 6,
        maxBufferLength: 8,
        maxMaxBufferLength: 10,
        startLevel: 0,
      }),
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

describe("isBehindLive", () => {
  it("is false within the egress delay itself", () => {
    // The stream is always ~10s behind the presenter; that alone must not
    // trip the "you fell behind" state.
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

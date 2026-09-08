import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EncodingOptionsPreset } from "livekit-server-sdk";
import {
  isLiveHlsEnabled,
  liveHlsConfig,
  liveHlsStreamFor,
  reconcileLiveHls,
  resetLiveHlsForTests,
  setLiveHlsTestHooks,
} from "./hls-egress.js";

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";

function enableHls() {
  process.env.LIVE_HLS_ENABLED = "true";
  process.env.LIVEKIT_URL = "wss://sfu.example.test";
  process.env.LIVEKIT_API_KEY = "key";
  process.env.LIVEKIT_API_SECRET = "secret";
  process.env.LIVE_HLS_PUBLIC_BASE_URL = "https://live.example.test";
  process.env.LIVE_HLS_S3_BUCKET = "pqp-live-test";
  process.env.LIVE_HLS_S3_ACCESS_KEY_ID = "ak";
  process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY = "sk";
  process.env.LIVE_HLS_S3_ENDPOINT = "https://s3.example.test";
  process.env.LIVE_HLS_DELAY_SECONDS = "10";
}

function disableHls() {
  delete process.env.LIVE_HLS_ENABLED;
  delete process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
  delete process.env.LIVE_HLS_PUBLIC_BASE_URL;
  delete process.env.LIVE_HLS_S3_BUCKET;
  delete process.env.LIVE_HLS_S3_ACCESS_KEY_ID;
  delete process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY;
  delete process.env.LIVE_HLS_S3_ENDPOINT;
  delete process.env.LIVE_HLS_S3_REGION;
  delete process.env.LIVE_HLS_S3_FORCE_PATH_STYLE;
  delete process.env.LIVE_HLS_DELAY_SECONDS;
}

describe("live HLS egress", () => {
  beforeEach(() => {
    resetLiveHlsForTests();
    disableHls();
  });

  afterEach(() => {
    resetLiveHlsForTests();
    disableHls();
  });

  it("is off unless the flag and the dedicated bucket are both set", () => {
    expect(isLiveHlsEnabled()).toBe(false);
    enableHls();
    expect(isLiveHlsEnabled()).toBe(true);
    expect(liveHlsConfig()).toEqual({ enabled: true, delaySeconds: 10 });
    delete process.env.LIVE_HLS_S3_BUCKET;
    expect(isLiveHlsEnabled()).toBe(false);
  });

  it("does not start when the flag is off, even if a presenter is sharing", async () => {
    const start = vi.fn();
    setLiveHlsTestHooks({
      egress: {
        startTrackCompositeEgress: start,
        stopEgress: vi.fn(),
      },
      findTracks: async () => ({ videoTrackId: "TR_V" }),
    });
    expect(await reconcileLiveHls(CHANNEL, "peer-1")).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it("starts on the first sharer and is a no-op if they keep sharing", async () => {
    enableHls();
    const start = vi.fn(async () => ({ egressId: "EG_1" }));
    const stop = vi.fn();
    setLiveHlsTestHooks({
      egress: { startTrackCompositeEgress: start, stopEgress: stop },
      findTracks: async () => ({
        videoTrackId: "TR_V",
        audioTrackId: "TR_A",
      }),
    });

    const first = await reconcileLiveHls(CHANNEL, "peer-1");
    expect(first?.presenterPeerId).toBe("peer-1");
    expect(first?.hlsUrl).toMatch(
      /^https:\/\/live\.example\.test\/live\/00000000-0000-4000-8000-0000000000aa\/\d+\.m3u8$/,
    );
    expect(liveHlsStreamFor(CHANNEL)).toEqual(first);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![2]).toEqual(
      expect.objectContaining({
        videoTrackId: "TR_V",
        audioTrackId: "TR_A",
        encodingOptions: EncodingOptionsPreset.H264_1080P_30,
      }),
    );
    const output = start.mock.calls[0]![1] as {
      livePlaylistName: string;
      playlistName: string;
    };
    expect(output.livePlaylistName).toMatch(/^\d+\.m3u8$/);
    expect(output.playlistName).toMatch(/^\d+-index\.m3u8$/);

    const again = await reconcileLiveHls(CHANNEL, "peer-1");
    expect(again).toEqual(first);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it("stops when nobody is sharing", async () => {
    enableHls();
    const stop = vi.fn();
    setLiveHlsTestHooks({
      egress: {
        startTrackCompositeEgress: async () => ({ egressId: "EG_1" }),
        stopEgress: stop,
      },
      findTracks: async () => ({ videoTrackId: "TR_V" }),
    });
    await reconcileLiveHls(CHANNEL, "peer-1");
    expect(await reconcileLiveHls(CHANNEL, null)).toBeNull();
    expect(stop).toHaveBeenCalledWith("EG_1");
    expect(liveHlsStreamFor(CHANNEL)).toBeNull();
  });

  it("does not start when the SFU has no screen track yet", async () => {
    enableHls();
    const start = vi.fn();
    setLiveHlsTestHooks({
      egress: {
        startTrackCompositeEgress: start,
        stopEgress: vi.fn(),
      },
      findTracks: async () => null,
    });
    expect(await reconcileLiveHls(CHANNEL, "peer-1")).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });
});

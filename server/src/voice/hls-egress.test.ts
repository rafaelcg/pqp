import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EncodingOptionsPreset } from "livekit-server-sdk";
import {
  type LiveHlsEgressApi,
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

  it("falls back to the raw public bucket URL when LIVE_HLS_SIGNED_URLS=false", async () => {
    enableHls();
    process.env.LIVE_HLS_SIGNED_URLS = "false";
    setLiveHlsTestHooks({
      egress: {
        startTrackCompositeEgress: vi.fn(async () => ({ egressId: "EG_1" })),
        stopEgress: vi.fn(),
      },
      findTracks: async () => ({ videoTrackId: "TR_V" }),
    });
    const stream = await reconcileLiveHls(CHANNEL, "peer-1");
    expect(stream?.hlsUrl).toMatch(
      /^https:\/\/live\.example\.test\/live\/00000000-0000-4000-8000-0000000000aa\/\d+\.m3u8$/,
    );
    delete process.env.LIVE_HLS_SIGNED_URLS;
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
    const start = vi.fn<LiveHlsEgressApi["startTrackCompositeEgress"]>(
      async () => ({ egressId: "EG_1" }),
    );
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
    // Signed by default (LIVE_HLS_SIGNED_URLS unset): an API-relative path
    // to the playlist proxy, not the raw bucket URL. See
    // `hls-playlist-proxy.test.ts` for what that proxy actually returns.
    expect(first?.hlsUrl).toMatch(
      /^\/api\/voice\/hls-playlist\/00000000-0000-4000-8000-0000000000aa\/\d+$/,
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

  it("restarts on a new screen track sid from the same presenter", async () => {
    enableHls();
    let egressN = 0;
    const start = vi.fn<LiveHlsEgressApi["startTrackCompositeEgress"]>(
      async () => ({ egressId: `EG_${(egressN += 1)}` }),
    );
    const stop = vi.fn();
    let videoTrackId = "TR_V1";
    setLiveHlsTestHooks({
      egress: { startTrackCompositeEgress: start, stopEgress: stop },
      findTracks: async () => ({ videoTrackId, audioTrackId: "TR_A" }),
    });

    const first = await reconcileLiveHls(CHANNEL, "peer-1");
    expect(first).not.toBeNull();
    // The presenter republished: a quality pick that changed the top layer,
    // or the room crossing the large-room line. Same peer, new sid.
    videoTrackId = "TR_V2";
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await reconcileLiveHls(CHANNEL, "peer-1");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith("EG_1");
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[1]![2]).toEqual(
      expect.objectContaining({ videoTrackId: "TR_V2" }),
    );
    expect(second?.presenterPeerId).toBe("peer-1");
    expect(second?.hlsUrl).not.toBe(first?.hlsUrl);
    expect(liveHlsStreamFor(CHANNEL)).toEqual(second);

    // Same sid again: nothing moves.
    const third = await reconcileLiveHls(CHANNEL, "peer-1");
    expect(third).toEqual(second);
    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("keeps the egress when the SFU cannot be asked which sid is live", async () => {
    enableHls();
    const start = vi.fn<LiveHlsEgressApi["startTrackCompositeEgress"]>(
      async () => ({ egressId: "EG_1" }),
    );
    const stop = vi.fn();
    let calls = 0;
    setLiveHlsTestHooks({
      egress: { startTrackCompositeEgress: start, stopEgress: stop },
      findTracks: async () => {
        calls += 1;
        if (calls > 1) {
          throw new Error("ListParticipants: 503");
        }
        return { videoTrackId: "TR_V1", audioTrackId: "TR_A" };
      },
    });

    const first = await reconcileLiveHls(CHANNEL, "peer-1");
    const again = await reconcileLiveHls(CHANNEL, "peer-1");
    expect(again).toEqual(first);
    expect(stop).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
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

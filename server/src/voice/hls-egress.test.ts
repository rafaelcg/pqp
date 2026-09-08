import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EgressStatus } from "livekit-server-sdk";
import {
  type LiveHlsEgressApi,
  HLS_MAX_RESTARTS,
  checkLiveHlsHealth,
  internalPlaylistUrl,
  isLiveHlsFailed,
  setLiveHlsChangeListener,
  stopActiveEgressesForRoom,
  isLiveHlsEnabled,
  isLiveHlsEnabledForServer,
  liveHlsConfig,
  liveHlsLadder,
  liveHlsRungsFor,
  liveHlsServerAllowlist,
  setLiveHlsSfuLoadReader,
  liveHlsStreamFor,
  reconcileLiveHls,
  resetLiveHlsForTests,
  setLiveHlsTestHooks,
} from "./hls-egress.js";

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("../lib/log.js", () => ({ logEvent }));

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const SERVER = "00000000-0000-4000-8000-0000000000ee";
const OTHER_SERVER = "00000000-0000-4000-8000-0000000000ff";

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
  // Most of this suite pins the behaviour of ONE rendition, which is still a
  // supported deployment (`LIVE_HLS_LADDER=720p30`, and what `LIVE_HLS_PRESET`
  // means). The ladder has its own describe block below, which sets its own.
  process.env.LIVE_HLS_LADDER = "720p30";
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
  delete process.env.LIVE_HLS_SERVER_ALLOWLIST;
  delete process.env.LIVE_HLS_PRESET;
  delete process.env.LIVE_HLS_LADDER;
  delete process.env.LIVE_HLS_MAX_LADDER_MBPS;
  delete process.env.VOICE_PROMOTION_MAX_SFU_MBPS;
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
    expect(liveHlsConfig()).toEqual({
      enabled: true,
      delaySeconds: 10,
      // The presenter's client reads the top of this to decide whether to
      // publish past the large-room cap.
      ladder: [
        { name: "720p30", width: 1280, height: 720, videoKbps: 1800 },
      ],
      allowlisted: false,
    });
    delete process.env.LIVE_HLS_S3_BUCKET;
    expect(isLiveHlsEnabled()).toBe(false);
  });

  it("needs no public base in signed mode, and still hands out working viewer URLs", async () => {
    enableHls();
    delete process.env.LIVE_HLS_PUBLIC_BASE_URL;
    // Signed mode is the default: the private bucket is read through
    // presigned URLs only, which is how production runs.
    expect(isLiveHlsEnabled()).toBe(true);
    setLiveHlsTestHooks({
      egress: {
        startTrackCompositeEgress: vi.fn(async () => ({ egressId: "EG_1" })),
        stopEgress: vi.fn(),
      },
      findTracks: async () => ({ videoTrackId: "TR_V" }),
    });
    const stream = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    expect(stream?.hlsUrl).toBe(
      `/api/voice/hls-playlist/${CHANNEL}/${stream?.startedAt}`,
    );
    // What this process itself reads is a presigned, endpoint-form GET on
    // the bucket, never the (absent) public base.
    const internal = new URL(internalPlaylistUrl(CHANNEL, stream!.startedAt));
    expect(internal.host).toBe("pqp-live-test.s3.example.test");
    expect(internal.pathname).toBe(`/live/${CHANNEL}/${stream!.startedAt}.m3u8`);
    expect(internal.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });

  it("is off without a public base only when LIVE_HLS_SIGNED_URLS=false", () => {
    enableHls();
    delete process.env.LIVE_HLS_PUBLIC_BASE_URL;
    process.env.LIVE_HLS_SIGNED_URLS = "false";
    expect(isLiveHlsEnabled()).toBe(false);
    process.env.LIVE_HLS_PUBLIC_BASE_URL = "https://live.example.test";
    expect(isLiveHlsEnabled()).toBe(true);
    delete process.env.LIVE_HLS_SIGNED_URLS;
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
    const stream = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
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
    expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).toBeNull();
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

    const first = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
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
        encodingOptions: expect.objectContaining({
          width: 1280,
          height: 720,
          videoBitrate: 1800,
        }),
      }),
    );
    const output = start.mock.calls[0]![1] as {
      livePlaylistName: string;
      playlistName: string;
    };
    expect(output.livePlaylistName).toMatch(/^\d+-720p30\.m3u8$/);
    expect(output.playlistName).toMatch(/^\d+-720p30-index\.m3u8$/);

    const again = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
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

    const first = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    expect(first).not.toBeNull();
    // The presenter republished: a quality pick that changed the top layer,
    // or the room crossing the large-room line. Same peer, new sid.
    videoTrackId = "TR_V2";
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
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
    const third = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
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

    const first = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    const again = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
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
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    expect(await reconcileLiveHls(CHANNEL, null, SERVER)).toBeNull();
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
    expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  describe("LIVE_HLS_SERVER_ALLOWLIST", () => {
    it("unset or empty means every server, but never a conversation", () => {
      enableHls();
      expect(isLiveHlsEnabledForServer(SERVER)).toBe(true);
      expect(isLiveHlsEnabledForServer(OTHER_SERVER)).toBe(true);
      expect(isLiveHlsEnabledForServer(null)).toBe(true);
      process.env.LIVE_HLS_SERVER_ALLOWLIST = " , ";
      expect(liveHlsServerAllowlist()).toBeNull();
      expect(isLiveHlsEnabledForServer(OTHER_SERVER)).toBe(true);
    });

    it("set means only the listed ids, trimmed", () => {
      enableHls();
      process.env.LIVE_HLS_SERVER_ALLOWLIST = ` ${SERVER} , other-id`;
      expect(liveHlsServerAllowlist()).toEqual(new Set([SERVER, "other-id"]));
      expect(isLiveHlsEnabledForServer(SERVER)).toBe(true);
      expect(isLiveHlsEnabledForServer(OTHER_SERVER)).toBe(false);
      expect(isLiveHlsEnabledForServer(null)).toBe(false);
      expect(isLiveHlsEnabledForServer(undefined)).toBe(false);
    });

    it("is never on when the global flag is off", () => {
      process.env.LIVE_HLS_SERVER_ALLOWLIST = SERVER;
      expect(isLiveHlsEnabledForServer(SERVER)).toBe(false);
    });

    it("liveHlsConfig(serverId) reflects the list; without one it is the global flag", () => {
      enableHls();
      process.env.LIVE_HLS_SERVER_ALLOWLIST = SERVER;
      expect(liveHlsConfig(SERVER)).toEqual({
        enabled: true,
        delaySeconds: 10,
        ladder: [expect.objectContaining({ name: "720p30" })],
        allowlisted: true,
      });
      expect(liveHlsConfig(OTHER_SERVER)).toEqual({
        enabled: false,
        delaySeconds: 10,
        ladder: [expect.objectContaining({ name: "720p30" })],
        allowlisted: true,
      });
      expect(liveHlsConfig()).toEqual({
        enabled: true,
        delaySeconds: 10,
        ladder: [expect.objectContaining({ name: "720p30" })],
        allowlisted: true,
      });
    });

    it("reconcile does not start an egress for an unlisted server, and stops one that was running", async () => {
      enableHls();
      const start = vi.fn<LiveHlsEgressApi["startTrackCompositeEgress"]>(
        async () => ({ egressId: "EG_1" }),
      );
      const stop = vi.fn();
      setLiveHlsTestHooks({
        egress: { startTrackCompositeEgress: start, stopEgress: stop },
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });
      process.env.LIVE_HLS_SERVER_ALLOWLIST = SERVER;
      expect(await reconcileLiveHls(CHANNEL, "peer-1", OTHER_SERVER)).toBeNull();
      expect(await reconcileLiveHls(CHANNEL, "peer-1", null)).toBeNull();
      expect(start).not.toHaveBeenCalled();

      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).not.toBeNull();
      expect(start).toHaveBeenCalledTimes(1);

      // The operator narrows the list mid-stream: the next reconcile stops it.
      process.env.LIVE_HLS_SERVER_ALLOWLIST = OTHER_SERVER;
      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).toBeNull();
      expect(stop).toHaveBeenCalledWith("EG_1");
      expect(liveHlsStreamFor(CHANNEL)).toBeNull();
    });
  });

  describe("the ladder", () => {
    function fakeEgress(started: string[]) {
      const start = vi.fn<LiveHlsEgressApi["startTrackCompositeEgress"]>(
        async (_room, _output, opts) => {
          const options = opts.encodingOptions as { height?: number };
          started.push(String(options?.height ?? "?"));
          return { egressId: `EG_${started.length}` };
        },
      );
      return start;
    }

    async function startLadder(ladder: string | undefined) {
      resetLiveHlsForTests();
      enableHls();
      if (ladder === undefined) {
        delete process.env.LIVE_HLS_LADDER;
      } else {
        process.env.LIVE_HLS_LADDER = ladder;
      }
      const heights: string[] = [];
      const start = fakeEgress(heights);
      setLiveHlsTestHooks({
        egress: { startTrackCompositeEgress: start, stopEgress: vi.fn() },
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });
      const stream = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
      return { stream, heights, start };
    }

    it("defaults to 1080p30 + 720p30, started lowest rung first", async () => {
      const { stream, heights } = await startLadder(undefined);
      expect(stream).not.toBeNull();
      // Lowest first: a viewer is never left with nothing while the
      // expensive rendition is still spinning up.
      expect(heights).toEqual(["720", "1080"]);
      expect(liveHlsRungsFor(CHANNEL).map((rung) => rung.name)).toEqual([
        "720p30",
        "1080p30",
      ]);
    });

    it("a one-entry ladder is exactly the old single-rendition behaviour", async () => {
      const { heights } = await startLadder("720p30");
      expect(heights).toEqual(["720"]);
    });

    it("LIVE_HLS_PRESET still names a one-rung ladder", async () => {
      resetLiveHlsForTests();
      enableHls();
      delete process.env.LIVE_HLS_LADDER;
      process.env.LIVE_HLS_PRESET = "1080p30";
      expect(liveHlsLadder().map((rung) => rung.name)).toEqual(["1080p30"]);
    });

    it("each rung gets its own object prefix and playlists", async () => {
      const { start } = await startLadder("480p30,1080p30");
      const prefixes = start.mock.calls.map(
        (call) => (call[1] as { filenamePrefix: string }).filenamePrefix,
      );
      expect(prefixes[0]).toMatch(/\/\d+-480p30$/);
      expect(prefixes[1]).toMatch(/\/\d+-1080p30$/);
      const names = start.mock.calls.map(
        (call) => (call[1] as { livePlaylistName: string }).livePlaylistName,
      );
      expect(names[0]).toMatch(/^\d+-480p30\.m3u8$/);
      expect(names[1]).toMatch(/^\d+-1080p30\.m3u8$/);
    });

    it("garbage in the list logs once and still starts a ladder", async () => {
      logEvent.mockClear();
      const { heights } = await startLadder("4k,720p30");
      expect(heights).toEqual(["720"]);
      expect(logEvent).toHaveBeenCalledWith(
        "voice.hlsLadderInvalid",
        expect.objectContaining({ value: "4k", using: ["720p30"] }),
      );
    });

    it("refuses a rung over the ladder budget and logs the refusal", async () => {
      resetLiveHlsForTests();
      enableHls();
      process.env.LIVE_HLS_LADDER = "1080p30,720p30";
      // One rung's worth: the lowest starts anyway, the second is refused.
      process.env.LIVE_HLS_MAX_LADDER_MBPS = "150";
      logEvent.mockClear();
      const heights: string[] = [];
      setLiveHlsTestHooks({
        egress: {
          startTrackCompositeEgress: fakeEgress(heights),
          stopEgress: vi.fn(),
        },
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });
      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).not.toBeNull();
      expect(heights).toEqual(["720"]);
      expect(logEvent).toHaveBeenCalledWith(
        "voice.hlsRungRefused",
        expect.objectContaining({
          rung: "1080p30",
          refusal: "ladder-budget",
        }),
      );
      expect(logEvent).toHaveBeenCalledWith(
        "voice.hlsStarted",
        expect.objectContaining({
          started: ["720p30"],
          refused: ["1080p30:ladder-budget"],
        }),
      );
    });

    it("the lowest rung starts even when the budget is zero", async () => {
      resetLiveHlsForTests();
      enableHls();
      process.env.LIVE_HLS_LADDER = "1080p30,720p30";
      process.env.LIVE_HLS_MAX_LADDER_MBPS = "0";
      const heights: string[] = [];
      setLiveHlsTestHooks({
        egress: {
          startTrackCompositeEgress: fakeEgress(heights),
          stopEgress: vi.fn(),
        },
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });
      const stream = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
      expect(stream).not.toBeNull();
      expect(heights).toEqual(["720"]);
    });

    it("the WebRTC already on the box can refuse a rung on its own", async () => {
      resetLiveHlsForTests();
      enableHls();
      process.env.LIVE_HLS_LADDER = "1080p30,720p30";
      process.env.VOICE_PROMOTION_MAX_SFU_MBPS = "320";
      const heights: string[] = [];
      setLiveHlsTestHooks({
        egress: {
          startTrackCompositeEgress: fakeEgress(heights),
          stopEgress: vi.fn(),
        },
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });
      // 150 (the rung about to start) + 150 (the one already counted) + 60
      // of cameras is over 320.
      setLiveHlsSfuLoadReader(async () => 60);
      logEvent.mockClear();
      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).not.toBeNull();
      expect(heights).toEqual(["720"]);
      expect(logEvent).toHaveBeenCalledWith(
        "voice.hlsRungRefused",
        expect.objectContaining({ refusal: "box-budget" }),
      );
    });

    it("a rung that fails to start does not take the stream down with it", async () => {
      resetLiveHlsForTests();
      enableHls();
      process.env.LIVE_HLS_LADDER = "1080p30,720p30";
      let call = 0;
      const start = vi.fn<LiveHlsEgressApi["startTrackCompositeEgress"]>(
        async () => {
          call += 1;
          if (call === 2) {
            throw new Error("egress busy");
          }
          return { egressId: `EG_${call}` };
        },
      );
      setLiveHlsTestHooks({
        egress: { startTrackCompositeEgress: start, stopEgress: vi.fn() },
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });
      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).not.toBeNull();
      expect(liveHlsRungsFor(CHANNEL).map((rung) => rung.name)).toEqual([
        "720p30",
      ]);
    });

    it("stopping the share stops every rung", async () => {
      resetLiveHlsForTests();
      enableHls();
      process.env.LIVE_HLS_LADDER = "1080p30,720p30";
      const stop = vi.fn();
      const heights: string[] = [];
      setLiveHlsTestHooks({
        egress: {
          startTrackCompositeEgress: fakeEgress(heights),
          stopEgress: stop,
        },
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });
      await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
      await reconcileLiveHls(CHANNEL, null, SERVER);
      expect(stop.mock.calls.map((call) => call[0])).toEqual(["EG_1", "EG_2"]);
    });
  });

  describe("egress health monitor", () => {
    /**
     * A fake LiveKit whose `ListEgress` answer the test flips: every egress
     * this fake started is `active` until the test marks it dead, which is
     * exactly what `docker stop lk-egress` looked like from the API in the
     * 2026-09-07 QA (status FAILED, or the id gone after an SFU restart).
     */
    function fakeLiveKit() {
      let n = 0;
      const statuses = new Map<string, EgressStatus>();
      const start = vi.fn<LiveHlsEgressApi["startTrackCompositeEgress"]>(
        async () => {
          const egressId = `EG_${(n += 1)}`;
          statuses.set(egressId, EgressStatus.EGRESS_ACTIVE);
          return { egressId };
        },
      );
      const stop = vi.fn(async (egressId: string) => {
        statuses.set(egressId, EgressStatus.EGRESS_COMPLETE);
      });
      const list = vi.fn(async (opts: { egressId?: string; roomName?: string }) =>
        [...statuses.entries()]
          .filter(([id]) => !opts.egressId || id === opts.egressId)
          .map(([egressId, status]) => ({ egressId, status })),
      );
      return {
        api: {
          startTrackCompositeEgress: start,
          stopEgress: stop,
          listEgress: list,
        } satisfies LiveHlsEgressApi,
        start,
        stop,
        list,
        kill(egressId: string, how: "failed" | "forgotten" = "failed") {
          if (how === "forgotten") {
            statuses.delete(egressId);
          } else {
            statuses.set(egressId, EgressStatus.EGRESS_FAILED);
          }
        },
      };
    }

    /** What `ws/voice.ts` does when told: reconcile again, presenter still sharing. */
    function listenerThatReconciles(presenter: string | null = "peer-1") {
      const calls: string[] = [];
      setLiveHlsChangeListener((channelId, reason) => {
        calls.push(reason);
        void reconcileLiveHls(channelId, presenter, SERVER);
      });
      return calls;
    }

    /**
     * Advance the fake clock AND drain what the timer set off.
     *
     * The restart chain is timer -> change listener -> the per-channel
     * reconcile queue -> StartEgress -> the session row -> the readiness
     * probe. Every link is a promise, so the timer landing is not the same
     * instant as the room being back, and `advanceTimersByTimeAsync` only
     * drains as far as it happens to. Counting on a particular number of
     * microtask ticks is how a suite passes on one machine and fails on the
     * CI runner (it did, on this branch, when the ladder added one await to
     * that chain). So: land the timer, then drain until it settles.
     */
    async function advance(ms: number): Promise<void> {
      await vi.advanceTimersByTimeAsync(ms);
      for (let tick = 0; tick < 20; tick += 1) {
        await Promise.resolve();
      }
    }

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-08T20:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("restarts an egress that ended abnormally, once, with a new playlist URL", async () => {
      enableHls();
      const lk = fakeLiveKit();
      setLiveHlsTestHooks({
        egress: lk.api,
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });
      const heard = listenerThatReconciles();

      const first = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
      expect(first).not.toBeNull();

      // Inside the grace period nothing is held against a fresh egress.
      lk.kill("EG_1");
      await advance(5_000);
      expect(await checkLiveHlsHealth()).toEqual([]);

      await advance(15_000);
      expect(await checkLiveHlsHealth()).toEqual([
        { channelId: CHANNEL, outcome: "scheduled" },
      ]);
      // The room is gone right away (viewers must not be handed the dead
      // URL), the restart itself waits for the backoff.
      expect(liveHlsStreamFor(CHANNEL)).toBeNull();
      expect(heard).toEqual([]);
      await advance(2_000);
      expect(heard).toEqual(["egress-ended"]);
      await advance(1);

      const second = liveHlsStreamFor(CHANNEL);
      expect(second).not.toBeNull();
      expect(second?.hlsUrl).not.toBe(first?.hlsUrl);
      expect(lk.start).toHaveBeenCalledTimes(2);
      // The dead one is not "stopped" again: it is already gone.
      expect(lk.stop).not.toHaveBeenCalled();

      // Healthy again: a further pass does nothing.
      await advance(20_000);
      expect(await checkLiveHlsHealth()).toEqual([]);
      expect(lk.start).toHaveBeenCalledTimes(2);
    });

    it("restarts when the playlist stops moving even though LiveKit still says active", async () => {
      // `docker stop lk-egress`: ListEgress keeps answering ACTIVE for the
      // dead id (1.13.6 / egress 1.14.1 verified 2026-09-08), so only the
      // playlist can tell. Twenty seconds of the same sequence is dead.
      enableHls();
      const lk = fakeLiveKit();
      let sequence = 1;
      setLiveHlsTestHooks({
        egress: lk.api,
        findTracks: async () => ({ videoTrackId: "TR_V" }),
        playlistProbe: () =>
          `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXTINF:2,\nseg_${sequence}.ts\n`,
      });
      const heard = listenerThatReconciles();
      await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

      // Moving: two passes, sequence advancing, nothing happens.
      await advance(20_000);
      expect(await checkLiveHlsHealth()).toEqual([]);
      sequence += 1;
      await advance(10_000);
      expect(await checkLiveHlsHealth()).toEqual([]);

      // Frozen: the same shape for 20 s.
      await advance(10_000);
      expect(await checkLiveHlsHealth()).toEqual([]);
      await advance(10_000);
      expect(await checkLiveHlsHealth()).toEqual([
        { channelId: CHANNEL, outcome: "scheduled" },
      ]);
      await advance(2_001);
      expect(heard).toEqual(["egress-ended"]);
      expect(lk.start).toHaveBeenCalledTimes(2);
    });

    it("retries a StartEgress that threw, with backoff, under the same cap", async () => {
      enableHls();
      const lk = fakeLiveKit();
      lk.start.mockRejectedValueOnce(new Error("twirp: request timed out"));
      setLiveHlsTestHooks({
        egress: lk.api,
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });
      const heard = listenerThatReconciles();
      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).toBeNull();
      expect(heard).toEqual([]);
      await advance(2_001);
      expect(heard).toEqual(["start-failed"]);
      expect(lk.start).toHaveBeenCalledTimes(2);
      expect(liveHlsStreamFor(CHANNEL)).not.toBeNull();
    });

    it("treats an egress LiveKit no longer lists as ended", async () => {
      enableHls();
      const lk = fakeLiveKit();
      setLiveHlsTestHooks({
        egress: lk.api,
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });
      listenerThatReconciles();
      await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
      lk.kill("EG_1", "forgotten");
      await advance(20_000);
      expect(await checkLiveHlsHealth()).toEqual([
        { channelId: CHANNEL, outcome: "scheduled" },
      ]);
    });

    it("leaves the egress alone when LiveKit cannot be asked", async () => {
      enableHls();
      const lk = fakeLiveKit();
      lk.list.mockRejectedValue(new Error("ListEgress: 503"));
      setLiveHlsTestHooks({
        egress: lk.api,
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });
      const first = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
      await advance(20_000);
      expect(await checkLiveHlsHealth()).toEqual([]);
      expect(liveHlsStreamFor(CHANNEL)).toEqual(first);
    });

    it("gives up after the cap, tells the listener, and refuses to start until the share stops", async () => {
      enableHls();
      const lk = fakeLiveKit();
      setLiveHlsTestHooks({
        egress: lk.api,
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });
      const heard = listenerThatReconciles();
      await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

      for (let round = 1; round <= HLS_MAX_RESTARTS; round += 1) {
        lk.kill(`EG_${round}`);
        await advance(20_000);
        expect(await checkLiveHlsHealth()).toEqual([
          { channelId: CHANNEL, outcome: "scheduled" },
        ]);
        // Backoff grows (2 s, 4 s, 8 s) and stays under the 15 s cap.
        await advance(15_000);
        expect(lk.start).toHaveBeenCalledTimes(round + 1);
      }
      expect(heard).toEqual(["egress-ended", "egress-ended", "egress-ended"]);

      // The fourth death inside five minutes is the end of the road.
      lk.kill(`EG_${HLS_MAX_RESTARTS + 1}`);
      await advance(20_000);
      expect(await checkLiveHlsHealth()).toEqual([
        { channelId: CHANNEL, outcome: "failed" },
      ]);
      expect(heard.at(-1)).toBe("failed");
      expect(isLiveHlsFailed(CHANNEL)).toBe(true);
      // The listener's reconcile ran and was refused: no fifth egress, and
      // viewers get null.
      await advance(1);
      expect(lk.start).toHaveBeenCalledTimes(HLS_MAX_RESTARTS + 1);
      expect(liveHlsStreamFor(CHANNEL)).toBeNull();
      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).toBeNull();
      expect(lk.start).toHaveBeenCalledTimes(HLS_MAX_RESTARTS + 1);

      // Stopping the share resets the budget; the next share starts clean.
      await reconcileLiveHls(CHANNEL, null, SERVER);
      expect(isLiveHlsFailed(CHANNEL)).toBe(false);
      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).not.toBeNull();
      expect(lk.start).toHaveBeenCalledTimes(HLS_MAX_RESTARTS + 2);
    });

    it("tears down an egress whose playlist never went live instead of handing out its URL", async () => {
      enableHls();
      const lk = fakeLiveKit();
      setLiveHlsTestHooks({
        egress: lk.api,
        findTracks: async () => ({ videoTrackId: "TR_V" }),
        playlistReady: false,
      });
      const heard = listenerThatReconciles();
      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).toBeNull();
      expect(liveHlsStreamFor(CHANNEL)).toBeNull();
      expect(lk.stop).toHaveBeenCalledWith("EG_1");
      // and a retry is on the clock, under the same cap
      await advance(2_001);
      expect(heard).toEqual(["playlist-not-ready"]);
      expect(lk.start).toHaveBeenCalledTimes(2);
    });

    it("stopActiveEgressesForRoom stops only the live ones", async () => {
      enableHls();
      const lk = fakeLiveKit();
      setLiveHlsTestHooks({ egress: lk.api });
      await lk.api.startTrackCompositeEgress("room", {} as never, {
        videoTrackId: "x",
      });
      await lk.api.startTrackCompositeEgress("room", {} as never, {
        videoTrackId: "y",
      });
      lk.kill("EG_1");
      expect(await stopActiveEgressesForRoom("room")).toEqual(["EG_2"]);
      expect(lk.stop).toHaveBeenCalledTimes(1);
    });
  });
});

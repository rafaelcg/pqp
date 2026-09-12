import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EgressStatus, TrackSource } from "livekit-server-sdk";
import {
  hlsSegmentSeconds,
  type LiveHlsEgressApi,
  HLS_MAX_RESTARTS,
  ORPHAN_STOP_BACKOFF_FIRST_MS,
  checkLiveHlsHealth,
  internalPlaylistUrl,
  isLiveHlsFailed,
  setLiveHlsChangeListener,
  listActiveEgresses,
  isLiveHlsEnabled,
  isLiveHlsEnabledForServer,
  liveHlsActivity,
  liveHlsConfig,
  liveHlsConfigForServer,
  liveHlsLadder,
  liveHlsRungsFor,
  liveHlsServerAllowlist,
  resolveLiveHlsForServer,
  setLiveHlsSfuLoadReader,
  liveHlsStreamFor,
  maxLiveHlsSessions,
  DEFAULT_MAX_HLS_SESSIONS,
  pickScreenTracks,
  reconcileLiveHls,
  resetLiveHlsForTests,
  setLiveHlsTestHooks,
} from "./hls-egress.js";

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("../lib/log.js", () => ({ logEvent }));

/**
 * No real Postgres on this suite's path.
 *
 * `recordSessionStarted` / `recordSessionEnded` write the retention rows, and
 * this file drives the restart machinery on a fake clock. A real query is
 * neither a timer nor a microtask, so `advanceTimersByTimeAsync` cannot wait
 * for it: the suite passed here and failed on the CI runner purely on how
 * fast the database answered. What the rows contain is `hls-cleanup.test.ts`
 * and `hls-playlist-proxy.test.ts`'s job; this file is about the egress.
 */
/**
 * `servers.live_hls_enabled` for whatever `liveHlsServerOverride` asks about.
 * `present: false` is a server row that does not exist at all, which must not
 * be confused with a row whose column is NULL.
 */
const overrideRow = vi.hoisted(() => ({
  value: null as boolean | null,
  present: true,
}));
const query = vi.hoisted(() =>
  vi.fn(async (sql: string) => {
    if (typeof sql === "string" && sql.includes("live_hls_enabled")) {
      return {
        rowCount: overrideRow.present ? 1 : 0,
        rows: overrideRow.present ? [{ live_hls_enabled: overrideRow.value }] : [],
      };
    }
    return { rowCount: 0, rows: [] };
  }),
);
vi.mock("../db.js", () => ({ getPool: () => ({ query }) }));

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const SERVER = "00000000-0000-4000-8000-0000000000ee";
const OTHER_SERVER = "00000000-0000-4000-8000-0000000000ff";
const OTHER_CHANNEL = "00000000-0000-4000-8000-0000000000bb";

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
  delete process.env.LIVE_HLS_MAX_SESSIONS;
  delete process.env.LIVE_HLS_REAP_ORPHANS;
  delete process.env.VOICE_PROMOTION_MAX_SFU_MBPS;
}

describe("live HLS egress", () => {
  beforeEach(() => {
    resetLiveHlsForTests();
    disableHls();
    overrideRow.value = null;
    overrideRow.present = true;
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
        { name: "720p30", width: 1280, height: 720, framerate: 30, videoKbps: 3200 },
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
          videoBitrate: 3200,
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

  /**
   * A NEW PEER ID IS NOT NECESSARILY A NEW PRESENTER.
   *
   * LiveKit identities are peer ids, and a reconnect that reconstructs or cold
   * joins gets a fresh one, so the room reports a different presenter for
   * plainly the same person. Production logged
   * `voice.hlsStopped reason=presenter-changed` on a party with exactly one
   * person sharing. Every one of those is a new `startedAt`, a new playlist
   * URL and a rebuffer for the whole audience, to say the same picture again.
   *
   * Sids are unique per publication, so this cannot confuse two people: a
   * genuine second presenter has a track this session was never bound to,
   * which is the case directly below.
   */
  it("adopts a changed peer id onto the running session when the track is the same", async () => {
    enableHls();
    const start = vi.fn<LiveHlsEgressApi["startTrackCompositeEgress"]>(
      async () => ({ egressId: "EG_1" }),
    );
    const stop = vi.fn();
    setLiveHlsTestHooks({
      egress: { startTrackCompositeEgress: start, stopEgress: stop },
      findTracks: async () => ({ videoTrackId: "TR_V" }),
    });

    const first = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    const again = await reconcileLiveHls(CHANNEL, "peer-2", SERVER);

    // Same session, same playlist: nobody rebuffers.
    expect(again?.startedAt).toBe(first?.startedAt);
    expect(again?.hlsUrl).toBe(first?.hlsUrl);
    // But the room's idea of who is presenting has moved, or the next
    // reconcile would think it had changed all over again.
    expect(again?.presenterPeerId).toBe("peer-2");
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it("still restarts for a genuinely different presenter, who has a different track", async () => {
    enableHls();
    let egressN = 0;
    const start = vi.fn<LiveHlsEgressApi["startTrackCompositeEgress"]>(
      async () => ({ egressId: `EG_${(egressN += 1)}` }),
    );
    const stop = vi.fn();
    let videoTrackId = "TR_V1";
    setLiveHlsTestHooks({
      egress: { startTrackCompositeEgress: start, stopEgress: stop },
      findTracks: async () => ({ videoTrackId }),
    });

    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    videoTrackId = "TR_V2";
    const second = await reconcileLiveHls(CHANNEL, "peer-2", SERVER);

    // Not compared on `startedAt`: two restarts inside one millisecond share
    // it, and a timestamp is not what makes these two different sessions
    // anyway. The egress calls are.
    expect(second?.presenterPeerId).toBe("peer-2");
    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledWith("EG_1");
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
    it("unset or empty means every server", async () => {
      enableHls();
      expect(await isLiveHlsEnabledForServer(SERVER)).toBe(true);
      expect(await isLiveHlsEnabledForServer(OTHER_SERVER)).toBe(true);
      expect(await isLiveHlsEnabledForServer(null)).toBe(true);
      process.env.LIVE_HLS_SERVER_ALLOWLIST = " , ";
      expect(liveHlsServerAllowlist()).toBeNull();
      expect(await isLiveHlsEnabledForServer(OTHER_SERVER)).toBe(true);
    });

    it("set means only the listed ids, trimmed", async () => {
      enableHls();
      process.env.LIVE_HLS_SERVER_ALLOWLIST = ` ${SERVER} , other-id`;
      expect(liveHlsServerAllowlist()).toEqual(new Set([SERVER, "other-id"]));
      expect(await isLiveHlsEnabledForServer(SERVER)).toBe(true);
      expect(await isLiveHlsEnabledForServer(OTHER_SERVER)).toBe(false);
      expect(await isLiveHlsEnabledForServer(null)).toBe(false);
      expect(await isLiveHlsEnabledForServer(undefined)).toBe(false);
    });

    it("is never on when the global flag is off", async () => {
      process.env.LIVE_HLS_SERVER_ALLOWLIST = SERVER;
      expect(await isLiveHlsEnabledForServer(SERVER)).toBe(false);
    });

    it("liveHlsConfigForServer reflects the list; without a server it is the global flag", async () => {
      enableHls();
      process.env.LIVE_HLS_SERVER_ALLOWLIST = SERVER;
      expect(await liveHlsConfigForServer(SERVER)).toEqual({
        enabled: true,
        delaySeconds: 10,
        ladder: [expect.objectContaining({ name: "720p30" })],
        allowlisted: true,
      });
      expect(await liveHlsConfigForServer(OTHER_SERVER)).toEqual({
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

  /**
   * The allowlist as DATA: `servers.live_hls_enabled`.
   *
   * EVERY TEST HERE RUNS WITH `LIVE_HLS_SERVER_ALLOWLIST` SET, because that
   * is how production is configured (PR #428 made it the rollout switch) and
   * because a resolution rule tested only against the unset case would prove
   * nothing about the machine this runs on. That is pitfall 12 verbatim: the
   * flag that changes the code path has to be the flag the tests exercise.
   */
  describe("servers.live_hls_enabled, the per-server row", () => {
    describe("resolveLiveHlsForServer, the whole matrix", () => {
      it("the master switch is above everything, TRUE row included", () => {
        // LIVE_HLS_ENABLED off: no bucket, no LiveKit, nothing to turn on.
        expect(resolveLiveHlsForServer(SERVER, true)).toBe(false);
        expect(resolveLiveHlsForServer(SERVER, false)).toBe(false);
        expect(resolveLiveHlsForServer(SERVER, null)).toBe(false);
      });

      it("a TRUE row beats an allowlist that leaves the server out", () => {
        enableHls();
        process.env.LIVE_HLS_SERVER_ALLOWLIST = OTHER_SERVER;
        expect(resolveLiveHlsForServer(SERVER, null)).toBe(false);
        expect(resolveLiveHlsForServer(SERVER, true)).toBe(true);
      });

      it("a FALSE row beats an allowlist that names the server", () => {
        enableHls();
        process.env.LIVE_HLS_SERVER_ALLOWLIST = SERVER;
        expect(resolveLiveHlsForServer(SERVER, null)).toBe(true);
        expect(resolveLiveHlsForServer(SERVER, false)).toBe(false);
      });

      it("a FALSE row beats no allowlist at all, which is the kill switch", () => {
        enableHls();
        delete process.env.LIVE_HLS_SERVER_ALLOWLIST;
        expect(resolveLiveHlsForServer(SERVER, null)).toBe(true);
        expect(resolveLiveHlsForServer(SERVER, false)).toBe(false);
      });

      it("NULL is the whole compatibility promise: the environment, unchanged", () => {
        enableHls();
        process.env.LIVE_HLS_SERVER_ALLOWLIST = SERVER;
        expect(resolveLiveHlsForServer(SERVER, null)).toBe(true);
        expect(resolveLiveHlsForServer(OTHER_SERVER, null)).toBe(false);
        delete process.env.LIVE_HLS_SERVER_ALLOWLIST;
        expect(resolveLiveHlsForServer(SERVER, null)).toBe(true);
        expect(resolveLiveHlsForServer(OTHER_SERVER, null)).toBe(true);
      });
    });

    it("isLiveHlsEnabledForServer reads the row, and the row decides", async () => {
      enableHls();
      process.env.LIVE_HLS_SERVER_ALLOWLIST = OTHER_SERVER;

      overrideRow.value = null;
      expect(await isLiveHlsEnabledForServer(SERVER)).toBe(false);

      overrideRow.value = true;
      expect(await isLiveHlsEnabledForServer(SERVER)).toBe(true);

      overrideRow.value = false;
      expect(await isLiveHlsEnabledForServer(OTHER_SERVER)).toBe(false);
    });

    it("a server row that does not exist falls back to the environment", async () => {
      enableHls();
      process.env.LIVE_HLS_SERVER_ALLOWLIST = SERVER;
      overrideRow.present = false;
      expect(await isLiveHlsEnabledForServer(SERVER)).toBe(true);
      expect(await isLiveHlsEnabledForServer(OTHER_SERVER)).toBe(false);
    });

    it("a failed read falls back to the environment rather than revoking", async () => {
      enableHls();
      process.env.LIVE_HLS_SERVER_ALLOWLIST = SERVER;
      query.mockRejectedValueOnce(new Error("pool exhausted"));
      // The database is the source of truth and it just refused to answer.
      // A live event must not lose its stream over that: the answer this
      // deployment had before the column existed is the safe one.
      expect(await isLiveHlsEnabledForServer(SERVER)).toBe(true);
    });

    it("liveHlsConfigForServer answers from the row, and says it was confined", async () => {
      enableHls();
      delete process.env.LIVE_HLS_SERVER_ALLOWLIST;
      overrideRow.value = false;
      const config = await liveHlsConfigForServer(SERVER);
      expect(config.enabled).toBe(false);
      // No environment allowlist at all, so `allowlisted` is only true
      // because somebody decided about this server. The client says "off for
      // this server" rather than "off everywhere" on the strength of it.
      expect(config.allowlisted).toBe(true);
      expect(liveHlsConfig().allowlisted).toBe(false);
    });

    it("turning a server off stops a running egress, with the env still listing it", async () => {
      enableHls();
      // Production's shape: the variable is set and names this server.
      process.env.LIVE_HLS_SERVER_ALLOWLIST = SERVER;
      const start = vi.fn<LiveHlsEgressApi["startTrackCompositeEgress"]>(
        async () => ({ egressId: "EG_9" }),
      );
      const stop = vi.fn();
      setLiveHlsTestHooks({
        egress: { startTrackCompositeEgress: start, stopEgress: stop },
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });

      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).not.toBeNull();
      expect(start).toHaveBeenCalledTimes(1);

      // The operator flips the row to FALSE on the dashboard. No deploy, no
      // restart, and the environment variable is untouched and still says yes.
      overrideRow.value = false;
      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).toBeNull();
      expect(stop).toHaveBeenCalledWith("EG_9");
      expect(liveHlsStreamFor(CHANNEL)).toBeNull();
    });

    it("turning a server on starts one the environment would have refused", async () => {
      enableHls();
      process.env.LIVE_HLS_SERVER_ALLOWLIST = OTHER_SERVER;
      const start = vi.fn<LiveHlsEgressApi["startTrackCompositeEgress"]>(
        async () => ({ egressId: "EG_10" }),
      );
      setLiveHlsTestHooks({
        egress: { startTrackCompositeEgress: start, stopEgress: vi.fn() },
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });

      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).toBeNull();
      expect(start).not.toHaveBeenCalled();

      overrideRow.value = true;
      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).not.toBeNull();
      expect(start).toHaveBeenCalledTimes(1);
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

    it("defaults to a single 720p30 rung", async () => {
      const { stream, heights } = await startLadder(undefined);
      expect(stream).not.toBeNull();
      expect(heights).toEqual(["720"]);
      expect(liveHlsRungsFor(CHANNEL).map((rung) => rung.name)).toEqual([
        "720p30",
      ]);
    });

    it("refuses a 1080 rung when the published source is 720", async () => {
      resetLiveHlsForTests();
      enableHls();
      process.env.LIVE_HLS_LADDER = "1080p60,720p60@3200,480p30";
      const heights: string[] = [];
      setLiveHlsTestHooks({
        egress: {
          startTrackCompositeEgress: fakeEgress(heights),
          stopEgress: vi.fn(),
        },
        findTracks: async () => ({ videoTrackId: "TR_V", sourceHeight: 720 }),
      });
      await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
      expect(heights).toEqual(["480", "720"]);
    });

    it("prefers the capture height the host announced over LiveKit's declared layer", async () => {
      // PR 460 froze declared layers at 1080 while the window was 480.
      // LiveKit then reported track.height = 1080 and the ladder started
      // 1080/720 rungs that upscaled. The host's getSettings() is the pixels.
      resetLiveHlsForTests();
      enableHls();
      process.env.LIVE_HLS_LADDER = "1080p60,720p60@3200,480p30";
      const heights: string[] = [];
      setLiveHlsTestHooks({
        egress: {
          startTrackCompositeEgress: fakeEgress(heights),
          stopEgress: vi.fn(),
        },
        findTracks: async () => ({ videoTrackId: "TR_V", sourceHeight: 1080 }),
      });
      await reconcileLiveHls(CHANNEL, "peer-1", SERVER, 480);
      expect(heights).toEqual(["480"]);
    });

    it("stops a leftover egress from a previous session on the same channel", async () => {
      resetLiveHlsForTests();
      enableHls();
      process.env.LIVE_HLS_LADDER = "720p30";
      const stopEgress = vi.fn();
      setLiveHlsTestHooks({
        egress: {
          startTrackCompositeEgress: fakeEgress([]),
          stopEgress,
          listEgress: async () => [
            {
              egressId: "EG_OLD",
              status: EgressStatus.EGRESS_ACTIVE,
              roomName: CHANNEL,
            },
            {
              egressId: "EG_1",
              status: EgressStatus.EGRESS_ACTIVE,
              roomName: CHANNEL,
            },
          ],
        },
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });
      await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
      expect(stopEgress).toHaveBeenCalledWith("EG_OLD");
      expect(stopEgress).not.toHaveBeenCalledWith("EG_1");
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

  /**
   * The guard the ladder budget cannot be: `decideLadder`'s first rule starts
   * the lowest rung whatever the budget says, so N parties cost N floor rungs
   * and nothing ever refuses the Nth. On the 4-core media box that is about
   * 0.51 of a core each after the first party's 1.39 (`docs/CAPACITY.md`,
   * measured 2026-09-09), so the count has to stop somewhere.
   */
  describe("LIVE_HLS_MAX_SESSIONS", () => {
    const CHANNEL_B = "00000000-0000-4000-8000-0000000000bb";
    const CHANNEL_C = "00000000-0000-4000-8000-0000000000cc";

    function fakeStack() {
      let started = 0;
      const start = vi.fn<LiveHlsEgressApi["startTrackCompositeEgress"]>(
        async () => {
          started += 1;
          return { egressId: `EG_${started}` };
        },
      );
      const findTracks = vi.fn(async () => ({ videoTrackId: "TR_V" }));
      setLiveHlsTestHooks({
        egress: { startTrackCompositeEgress: start, stopEgress: vi.fn() },
        findTracks,
      });
      return { start, findTracks };
    }

    it("defaults to three, and an operator can raise or lower it", () => {
      expect(DEFAULT_MAX_HLS_SESSIONS).toBe(3);
      expect(maxLiveHlsSessions()).toBe(3);
      process.env.LIVE_HLS_MAX_SESSIONS = "8";
      expect(maxLiveHlsSessions()).toBe(8);
      // Junk and zero fall back rather than turning the guard off.
      process.env.LIVE_HLS_MAX_SESSIONS = "0";
      expect(maxLiveHlsSessions()).toBe(3);
      process.env.LIVE_HLS_MAX_SESSIONS = "lots";
      expect(maxLiveHlsSessions()).toBe(3);
    });

    it("refuses the party past the cap, and logs why", async () => {
      resetLiveHlsForTests();
      enableHls();
      process.env.LIVE_HLS_MAX_SESSIONS = "2";
      const { findTracks } = fakeStack();
      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).not.toBeNull();
      expect(await reconcileLiveHls(CHANNEL_B, "peer-2", SERVER)).not.toBeNull();
      logEvent.mockClear();
      const probesBefore = findTracks.mock.calls.length;
      expect(await reconcileLiveHls(CHANNEL_C, "peer-3", SERVER)).toBeNull();
      expect(liveHlsStreamFor(CHANNEL_C)).toBeNull();
      expect(logEvent).toHaveBeenCalledWith(
        "voice.hlsSessionsCapped",
        expect.objectContaining({
          channelId: CHANNEL_C,
          sessions: 2,
          maxSessions: 2,
        }),
      );
      // Refused BEFORE the track probe. `findScreenTracks` polls LiveKit
      // sixteen times over six seconds, and the box that is already running
      // its cap is the last one that should be spending that.
      expect(findTracks.mock.calls.length).toBe(probesBefore);
      // The two that got in are untouched: the cap refuses, it never evicts.
      expect(liveHlsStreamFor(CHANNEL)).not.toBeNull();
      expect(liveHlsStreamFor(CHANNEL_B)).not.toBeNull();
      // And the refused channel gets in once a slot frees.
      await reconcileLiveHls(CHANNEL_B, null, SERVER);
      expect(await reconcileLiveHls(CHANNEL_C, "peer-3", SERVER)).not.toBeNull();
    });

    it("counts what is running, so the dashboard can show the ceiling", async () => {
      resetLiveHlsForTests();
      enableHls();
      process.env.LIVE_HLS_MAX_SESSIONS = "2";
      fakeStack();
      expect(liveHlsActivity()).toMatchObject({ sessions: 0, maxSessions: 2 });
      await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
      expect(liveHlsActivity()).toMatchObject({ sessions: 1, maxSessions: 2 });
    });

    it("a presenter change in a session that is already running is not the Nth party", async () => {
      resetLiveHlsForTests();
      enableHls();
      process.env.LIVE_HLS_MAX_SESSIONS = "1";
      fakeStack();
      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).not.toBeNull();
      // The co-host takeover: same room, new presenter. The old egress is
      // stopped first, so this must not be refused by the cap it is inside.
      const taken = await reconcileLiveHls(CHANNEL, "peer-2", SERVER);
      expect(taken?.presenterPeerId).toBe("peer-2");
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

    it("listActiveEgresses reports only the live ones", async () => {
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
      const active = await listActiveEgresses();
      expect(active?.map((info) => info.egressId)).toEqual(["EG_2"]);
    });

    it("listActiveEgresses answers null when the media server cannot be asked", async () => {
      // Null is NOT "nothing running": the retention sweep must refuse to
      // delete rather than read this as permission.
      enableHls();
      const lk = fakeLiveKit();
      lk.list.mockRejectedValue(new Error("ListEgress: 503"));
      setLiveHlsTestHooks({ egress: lk.api });
      expect(await listActiveEgresses()).toBeNull();
    });

    /**
     * LEFTOVER TRANSCODES, which is the failure a stalling stream looks like
     * from the outside and the one `LIVE_HLS_MAX_SESSIONS` cannot see.
     *
     * A live watch party on 2026-09-09 logged two `voice.hlsStarted` for one
     * channel nine minutes apart, same presenter, nothing in between, and the
     * first pair's handlers were still on the media box two minutes after the
     * second pair started. Four transcoders on one room, on a four core box
     * that also carries the SFU and the TURN relay. The cap counts SESSIONS,
     * so three parties each leaking a ladder is twelve handlers under a limit
     * that reads as three.
     */
    describe("leftover transcodes on the same room", () => {
      /**
       * A `ListEgress` answer with one extra ACTIVE egress nobody owns.
       *
       * `room` is which room the answer CLAIMS it is in, which is a different
       * thing from which room the request asked about: the third case below
       * uses that gap to stand in for a LiveKit version, a proxy or a future
       * SDK that ignores `roomName` and answers with everything.
       */
      function withLeftover(
        lk: ReturnType<typeof fakeLiveKit>,
        id: string,
        room: string = CHANNEL,
      ) {
        let alive = true;
        return {
          ...lk.api,
          stopEgress: async (egressId: string) => {
            if (egressId === id) {
              alive = false;
              return;
            }
            await lk.api.stopEgress(egressId);
          },
          listEgress: async (opts: {
            egressId?: string;
            roomName?: string;
            active?: boolean;
          }) => {
            const mine = (await lk.list(opts)).map((info) => ({
              ...info,
              roomName: CHANNEL,
            }));
            return alive && !opts.egressId
              ? [
                  ...mine,
                  {
                    egressId: id,
                    status: EgressStatus.EGRESS_ACTIVE,
                    roomName: room,
                  },
                ]
              : mine;
          },
        } satisfies LiveHlsEgressApi;
      }

      it("stops one that is still running on a room this process is presenting", async () => {
        enableHls();
        const lk = fakeLiveKit();
        // ONE fake, spied on. Two of them would each keep their own idea of
        // whether the leftover is still alive, so the stop would land on one
        // and the listing would keep offering it from the other.
        const api = withLeftover(lk, "EG_LEFTOVER");
        const stop = vi.fn(api.stopEgress);
        setLiveHlsTestHooks({
          egress: { ...api, stopEgress: stop },
          findTracks: async () => ({ videoTrackId: "TR_V" }),
        });
        await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

        // A leftover on THIS channel is a superseded session. Stopping it
        // at start is what keeps a zombie playlist from sitting next to
        // the real one. The monitor's orphan counter is for leftovers
        // that appear later, not for this.
        expect(stop).toHaveBeenCalledWith("EG_LEFTOVER");

        await advance(20_000);
        await checkLiveHlsHealth();

        expect(liveHlsActivity().orphansStopped).toBe(0);
        // And it is gone, so a second pass does not keep re-stopping it.
        await advance(10_000);
        await checkLiveHlsHealth();
        expect(liveHlsActivity().orphansStopped).toBe(0);
      });

      /**
       * The worst thing anything in this file could do. `roomName` goes into
       * the request, and if a LiveKit version, a proxy or a future SDK ignored
       * it, this loop would stop every other live party on the instance. The
       * answer's own `roomName` is re-checked, so an entry belonging to
       * somebody else's room is left alone however it got into the listing.
       */
      it("never crosses into another room, even if the listing ignores the filter", async () => {
        enableHls();
        const lk = fakeLiveKit();
        const api = withLeftover(lk, "EG_OTHER_ROOM", OTHER_CHANNEL);
        const stop = vi.fn(api.stopEgress);
        setLiveHlsTestHooks({
          egress: { ...api, stopEgress: stop },
          findTracks: async () => ({ videoTrackId: "TR_V" }),
        });
        await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

        await advance(20_000);
        await checkLiveHlsHealth();

        expect(stop).not.toHaveBeenCalledWith("EG_OTHER_ROOM");
        expect(liveHlsActivity().orphansStopped).toBe(0);
      });

      it("is off in one command, without a deploy", async () => {
        enableHls();
        process.env.LIVE_HLS_REAP_ORPHANS = "false";
        const lk = fakeLiveKit();
        const api = withLeftover(lk, "EG_LEFTOVER");
        const stop = vi.fn(api.stopEgress);
        setLiveHlsTestHooks({
          egress: { ...api, stopEgress: stop },
          findTracks: async () => ({ videoTrackId: "TR_V" }),
        });
        await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

        // Start-time superseded cleanup is not the monitor and is not
        // behind `LIVE_HLS_REAP_ORPHANS`. The flag only silences the
        // background hunt, so a leftover already on this channel when
        // the new session starts is still stopped.
        expect(stop).toHaveBeenCalledWith("EG_LEFTOVER");

        await advance(20_000);
        await checkLiveHlsHealth();

        expect(liveHlsActivity().orphansStopped).toBe(0);
      });

      it("never stops this session's own rungs", async () => {
        enableHls();
        process.env.LIVE_HLS_LADDER = "720p30,1080p30";
        const lk = fakeLiveKit();
        setLiveHlsTestHooks({
          egress: withLeftover(lk, "EG_LEFTOVER"),
          findTracks: async () => ({ videoTrackId: "TR_V" }),
        });
        await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

        await advance(20_000);
        await checkLiveHlsHealth();

        expect(lk.stop.mock.calls.map((call) => call[0])).toEqual([]);
        expect(liveHlsStreamFor(CHANNEL)).not.toBeNull();
      });

      /**
       * The same rule `listActiveEgresses` states for the retention sweep:
       * "could not ask" is not "nothing is running", and it is certainly not
       * permission to stop things.
       */
      it("does nothing when the listing cannot be fetched", async () => {
        enableHls();
        const lk = fakeLiveKit();
        const stop = vi.fn(async () => {});
        setLiveHlsTestHooks({
          egress: {
            startTrackCompositeEgress: lk.start,
            stopEgress: stop,
            listEgress: async () => {
              throw new Error("ListEgress: 503");
            },
          },
          findTracks: async () => ({ videoTrackId: "TR_V" }),
        });
        await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

        await advance(20_000);
        await checkLiveHlsHealth();

        expect(stop).not.toHaveBeenCalled();
        expect(liveHlsActivity().orphansStopped).toBe(0);
      });

      /**
       * Staging 2026-09-12: a leftover whose handler was already gone
       * (`StopEgress` → `no response from servers`, 3 s timeout) was retried
       * every 10 s for seven hours. The leftover never came back. The live
       * encode sat behind those RPCs, then the playlist check, then another
       * restart. One failure buys a minute of silence; a later pass after
       * the wait is allowed to try again.
       */
      it("does not retry a leftover StopEgress that just timed out", async () => {
        enableHls();
        const lk = fakeLiveKit();
        const leftover = withLeftover(lk, "EG_DEAD");
        const stop = vi.fn(async (egressId: string) => {
          if (egressId === "EG_DEAD") {
            throw new Error("twirp error unknown: request timed out");
          }
          return leftover.stopEgress(egressId);
        });
        setLiveHlsTestHooks({
          egress: { ...leftover, stopEgress: stop },
          findTracks: async () => ({ videoTrackId: "TR_V" }),
        });
        await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
        // Start-time superseded cleanup already tried once and failed.
        expect(
          stop.mock.calls.filter((call) => call[0] === "EG_DEAD"),
        ).toHaveLength(1);

        await advance(20_000);
        await checkLiveHlsHealth();
        await advance(10_000);
        await checkLiveHlsHealth();
        expect(
          stop.mock.calls.filter((call) => call[0] === "EG_DEAD"),
        ).toHaveLength(1);
        expect(liveHlsActivity().orphansStopped).toBe(0);

        await advance(ORPHAN_STOP_BACKOFF_FIRST_MS);
        await checkLiveHlsHealth();
        expect(
          stop.mock.calls.filter((call) => call[0] === "EG_DEAD"),
        ).toHaveLength(2);
      });
    });

    /**
     * A RUNG DECLARED DEAD BECAUSE ITS PLAYLIST STALLED IS STILL RUNNING.
     *
     * The two halves of "ended" are not the same fact. LiveKit saying so means
     * the handler is over and there is nothing to stop. The playlist not
     * moving for `PLAYLIST_STUCK_MS` means only that: the rule exists because
     * a killed egress node goes on being reported ACTIVE forever, and the
     * mirror case, a handler that is genuinely still transcoding while its
     * output stalled, was dropped from `rooms` and never stopped. It then
     * burned a core until somebody rebuilt the box, and `scheduleRestart`
     * started a fresh ladder beside it on the way out.
     */
    describe("stopping what it declares dead", () => {
      function frozenPlaylist(lk: ReturnType<typeof fakeLiveKit>) {
        setLiveHlsTestHooks({
          egress: lk.api,
          findTracks: async () => ({ videoTrackId: "TR_V" }),
          playlistProbe: () =>
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2,\nseg_1.ts\n",
        });
      }

      it("stops a primary whose playlist stalled while LiveKit still calls it active", async () => {
        enableHls();
        const lk = fakeLiveKit();
        frozenPlaylist(lk);
        listenerThatReconciles();
        await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

        await advance(20_000);
        await checkLiveHlsHealth();
        await advance(20_000);
        expect(await checkLiveHlsHealth()).toEqual([
          { channelId: CHANNEL, outcome: "scheduled" },
        ]);

        expect(lk.stop).toHaveBeenCalledWith("EG_1");
      });

      it("stops a secondary rung in the same state rather than only forgetting it", async () => {
        enableHls();
        process.env.LIVE_HLS_LADDER = "720p30,1080p30";
        const lk = fakeLiveKit();
        frozenPlaylist(lk);
        listenerThatReconciles();
        await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

        await advance(20_000);
        await checkLiveHlsHealth();
        await advance(20_000);
        await checkLiveHlsHealth();

        // Both rungs: the secondary through the per-rung loop, the primary
        // through the session teardown under it.
        expect(lk.stop.mock.calls.map((call) => call[0]).sort()).toEqual([
          "EG_1",
          "EG_2",
        ]);
      });

      /**
       * The other direction, and the reason `stillRunning` exists rather than
       * an unconditional stop: an egress LiveKit has already reported as
       * finished needs no RPC, and asking would log a failure about a session
       * that ended perfectly normally.
       */
      it("does not call stop on an egress LiveKit already reported as finished", async () => {
        enableHls();
        const lk = fakeLiveKit();
        setLiveHlsTestHooks({
          egress: lk.api,
          findTracks: async () => ({ videoTrackId: "TR_V" }),
        });
        listenerThatReconciles();
        await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
        lk.kill("EG_1");

        await advance(20_000);
        expect(await checkLiveHlsHealth()).toEqual([
          { channelId: CHANNEL, outcome: "scheduled" },
        ]);

        expect(lk.stop).not.toHaveBeenCalledWith("EG_1");
      });
    });

    /**
     * WHY THE SESSION RESTARTED, WHICH THE LOG COULD NOT ANSWER.
     *
     * Three of `stopRoom`'s callers logged nothing and a fourth logged only in
     * a branch a silent one pre-empted, so a live party produced two starts
     * and no explanation. During an event that is the difference between "the
     * host re-picked their share" and "the transcode is dying", which want
     * opposite responses.
     */
    describe("narrating the teardown", () => {
      it("says the share stopped", async () => {
        enableHls();
        setLiveHlsTestHooks({
          egress: {
            startTrackCompositeEgress: async () => ({ egressId: "EG_1" }),
            stopEgress: vi.fn(),
          },
          findTracks: async () => ({ videoTrackId: "TR_V" }),
        });
        await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
        logEvent.mockClear();

        await reconcileLiveHls(CHANNEL, null, SERVER);

        expect(logEvent).toHaveBeenCalledWith(
          "voice.hlsStopped",
          expect.objectContaining({
            channelId: CHANNEL,
            reason: "no-share",
            egressIds: ["EG_1"],
          }),
        );
      });

      it("says the presenter re-picked their screen", async () => {
        enableHls();
        let videoTrackId = "TR_V1";
        setLiveHlsTestHooks({
          egress: {
            startTrackCompositeEgress: async () => ({ egressId: "EG_1" }),
            stopEgress: vi.fn(),
          },
          findTracks: async () => ({ videoTrackId }),
        });
        await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
        logEvent.mockClear();
        videoTrackId = "TR_V2";

        await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

        expect(logEvent).toHaveBeenCalledWith(
          "voice.hlsStopped",
          expect.objectContaining({ reason: "screen-track-replaced" }),
        );
      });

      it("says the server is not allowlisted, which is a different sentence", async () => {
        enableHls();
        setLiveHlsTestHooks({
          egress: {
            startTrackCompositeEgress: async () => ({ egressId: "EG_1" }),
            stopEgress: vi.fn(),
          },
          findTracks: async () => ({ videoTrackId: "TR_V" }),
        });
        await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
        logEvent.mockClear();

        process.env.LIVE_HLS_SERVER_ALLOWLIST = OTHER_SERVER;
        await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

        expect(logEvent).toHaveBeenCalledWith(
          "voice.hlsStopped",
          expect.objectContaining({ reason: "not-allowlisted" }),
        );
      });
    });
  });

/**
 * WHICH TWO TRACKS THE HLS AUDIENCE ACTUALLY RECEIVES.
 *
 * Every other case in this file injects `findTracks`, so until `pickScreenTracks`
 * was pulled out of `defaultFindTracks` the real selection ran nowhere but
 * production. That is the shape CLAUDE.md pitfalls 9 and 12 are both about, and
 * it hid two things at once: the audience gets no microphone and no camera from
 * anybody, and with two people sharing the video and the audio could come from
 * two different ones.
 *
 * The participant shapes below are the real thing, not tidied. A live watch
 * party on `QG do pqp` was sampled on 2026-09-09 and the host's microphone came
 * back as `source: 0`, which is `SOURCE_UNKNOWN`, because the web client
 * published it without naming a source (fixed in `client/src/lib/livekit-session.ts`).
 * A picker written against `TrackSource.MICROPHONE` and tested against a mock
 * that tags it properly would pass here and find nothing there.
 */
describe("pickScreenTracks", () => {
  const MIC_AS_PRODUCTION_SENDS_IT = { source: 0, sid: "TR_mic" };

  it("takes the screen share and that share's own audio", () => {
    expect(
      pickScreenTracks([
        {
          identity: "peer-host",
          tracks: [
            MIC_AS_PRODUCTION_SENDS_IT,
            { source: TrackSource.SCREEN_SHARE, sid: "TR_screen" },
            { source: TrackSource.SCREEN_SHARE_AUDIO, sid: "TR_screen_audio" },
          ],
        },
      ]),
    ).toEqual({ videoTrackId: "TR_screen", audioTrackId: "TR_screen_audio" });
  });

  /**
   * The Saturday shape: a window or a whole screen, or a tab with the audio
   * box unticked. There is no `SCREEN_SHARE_AUDIO` track, so the egress has
   * nothing to put in its audio channel and the seatless audience watches a
   * silent film. The microphone sitting right there is NOT picked up, and this
   * asserts that rather than assuming it: a Track Composite egress takes one
   * audio sid and the film's audio has to be able to win it.
   */
  it("carries the published height when LiveKit stated it", () => {
    expect(
      pickScreenTracks([
        {
          identity: "peer-host",
          tracks: [
            {
              source: TrackSource.SCREEN_SHARE,
              sid: "TR_screen",
              height: 1078,
            },
          ],
        },
      ]),
    ).toEqual({
      videoTrackId: "TR_screen",
      audioTrackId: undefined,
      sourceHeight: 1078,
    });
  });

  it("leaves the audience silent rather than reaching for the microphone", () => {
    expect(
      pickScreenTracks([
        {
          identity: "peer-host",
          tracks: [
            MIC_AS_PRODUCTION_SENDS_IT,
            { source: TrackSource.SCREEN_SHARE, sid: "TR_screen" },
          ],
        },
      ]),
    ).toEqual({ videoTrackId: "TR_screen", audioTrackId: undefined });
  });

  it("never carries a camera", () => {
    const picked = pickScreenTracks([
      {
        identity: "peer-host",
        tracks: [
          { source: TrackSource.CAMERA, sid: "TR_cam" },
          { source: TrackSource.SCREEN_SHARE, sid: "TR_screen" },
        ],
      },
    ]);
    expect(picked?.videoTrackId).toBe("TR_screen");
  });

  it("is nothing at all when nobody is sharing", () => {
    expect(
      pickScreenTracks([
        { identity: "peer-host", tracks: [MIC_AS_PRODUCTION_SENDS_IT] },
      ]),
    ).toBeNull();
  });

  /**
   * `TrackInfo.source` arrives as the enum's numeric value over the wire and as
   * its NAME through some of the SDK's own shapes, and `isTrackSource` accepts
   * both. Dropping half of that reads as "nobody is sharing" forever.
   */
  it("reads a source given by name as well as by number", () => {
    expect(
      pickScreenTracks([
        {
          identity: "peer-host",
          tracks: [
            { source: "SCREEN_SHARE", sid: "TR_screen" },
            { source: "SCREEN_SHARE_AUDIO", sid: "TR_screen_audio" },
          ],
        },
      ]),
    ).toEqual({ videoTrackId: "TR_screen", audioTrackId: "TR_screen_audio" });
  });

  /**
   * TWO SHARERS, which a party with co-hosts can genuinely have: both hold
   * START_WATCH_PARTY, so the SFU refuses neither. The first version scanned
   * every participant into two variables, so the audience could have been sent
   * one person's picture over the other person's sound, decided by whatever
   * order `listParticipants` answered in.
   */
  it("takes both tracks from one participant, never one from each", () => {
    const picked = pickScreenTracks([
      {
        identity: "peer-cohost",
        tracks: [{ source: TrackSource.SCREEN_SHARE, sid: "TR_cohost_screen" }],
      },
      {
        identity: "peer-host",
        tracks: [
          { source: TrackSource.SCREEN_SHARE, sid: "TR_host_screen" },
          { source: TrackSource.SCREEN_SHARE_AUDIO, sid: "TR_host_audio" },
        ],
      },
    ]);
    // Without the presenter, the first sharer found wins and takes ONLY its
    // own audio with it, which here is none.
    expect(picked).toEqual({
      videoTrackId: "TR_cohost_screen",
      audioTrackId: undefined,
    });
  });

  it("follows the presenter the room decided on, not the first sharer listed", () => {
    expect(
      pickScreenTracks(
        [
          {
            identity: "peer-cohost",
            tracks: [
              { source: TrackSource.SCREEN_SHARE, sid: "TR_cohost_screen" },
            ],
          },
          {
            identity: "peer-host",
            tracks: [
              { source: TrackSource.SCREEN_SHARE, sid: "TR_host_screen" },
              { source: TrackSource.SCREEN_SHARE_AUDIO, sid: "TR_host_audio" },
            ],
          },
        ],
        "peer-host",
      ),
    ).toEqual({
      videoTrackId: "TR_host_screen",
      audioTrackId: "TR_host_audio",
    });
  });

  it("falls back to any sharer when the presenter is not in the listing yet", () => {
    expect(
      pickScreenTracks(
        [
          {
            identity: "peer-cohost",
            tracks: [
              { source: TrackSource.SCREEN_SHARE, sid: "TR_cohost_screen" },
            ],
          },
        ],
        "peer-host",
      )?.videoTrackId,
    ).toBe("TR_cohost_screen");
  });
});

/**
 * THE HOST HAS TO BE ABLE TO SEE THIS WHILE THEY ARE LIVE.
 *
 * A silent transcode is invisible from every seat that exists: the host hears
 * the film out of their own speakers, the seated room hears both the film and
 * every microphone over WebRTC, and the only people who can tell are the
 * seatless audience, who have no way to say so. So the server states it on the
 * stream, logs it, and counts it.
 */
describe("whether the transcode carries any audio", () => {
  it("says so on the stream and in the log when it does", async () => {
    enableHls();
    logEvent.mockClear();
    setLiveHlsTestHooks({
      egress: {
        startTrackCompositeEgress: async () => ({ egressId: "EG_1" }),
        stopEgress: vi.fn(),
      },
      findTracks: async () => ({
        videoTrackId: "TR_V",
        audioTrackId: "TR_A",
      }),
    });

    const stream = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    expect(stream?.hasAudio).toBe(true);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsStarted",
      expect.objectContaining({ audio: "screen" }),
    );
    expect(liveHlsActivity().silentSessions).toBe(0);
  });

  it("says so on the stream, in the log and on the dashboard when it does not", async () => {
    enableHls();
    logEvent.mockClear();
    setLiveHlsTestHooks({
      egress: {
        startTrackCompositeEgress: async () => ({ egressId: "EG_1" }),
        stopEgress: vi.fn(),
      },
      findTracks: async () => ({ videoTrackId: "TR_V" }),
    });

    const stream = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    expect(stream?.hasAudio).toBe(false);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsStarted",
      expect.objectContaining({ audio: "none" }),
    );
    // The number an operator can read DURING a party, rather than grepping
    // the log after it. `silentSessions` at `sessions` on a film night is the
    // whole audience hearing nothing.
    expect(liveHlsActivity()).toEqual(
      expect.objectContaining({ sessions: 1, silentSessions: 1 }),
    );
  });
});

});

describe("LIVE_HLS_SEGMENT_SECONDS", () => {
  afterEach(() => {
    delete process.env.LIVE_HLS_SEGMENT_SECONDS;
  });

  it("defaults to 2 s segments", () => {
    expect(hlsSegmentSeconds()).toBe(2);
  });

  it("reads the operator's length; 4 halves the playlist PUTs per second of media", () => {
    process.env.LIVE_HLS_SEGMENT_SECONDS = "4";
    expect(hlsSegmentSeconds()).toBe(4);
  });

  it("refuses nonsense and caps the absurd", () => {
    process.env.LIVE_HLS_SEGMENT_SECONDS = "0";
    expect(hlsSegmentSeconds()).toBe(2);
    process.env.LIVE_HLS_SEGMENT_SECONDS = "banana";
    expect(hlsSegmentSeconds()).toBe(2);
    process.env.LIVE_HLS_SEGMENT_SECONDS = "60";
    expect(hlsSegmentSeconds()).toBe(10);
  });
});

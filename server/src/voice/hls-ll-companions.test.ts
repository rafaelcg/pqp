import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EgressStatus } from "livekit-server-sdk";
import type { LiveHlsStream } from "@pqp/shared";

/**
 * A LOW-LATENCY BROADCAST RECORDS THE CAMERA AND THE VOICE TOO.
 *
 * The picture of an LL party is pqp-remux's, but the presenter's camera rung
 * and the host's mic archive are LiveKit egresses whichever way the film was
 * made, and "webcam + mic + stream" is what a past broadcast is. So an LL
 * session gets a companion (`llCompanions` in hls-egress.ts) that runs the
 * SAME camera and archive code a ladder room runs, under the LL row's own
 * `startedAt`, so `hls-history.ts` groups the three into one broadcast.
 *
 * `hls-remux.ts` is replaced here by a stand-in whose LL session is whatever
 * `ll.stream` says: what is pinned is this file's half, not the box's.
 */

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("../lib/log.js", () => ({ logEvent }));

const query = vi.hoisted(() =>
  vi.fn(async (_sql: string, _params?: unknown[]) => ({ rowCount: 0, rows: [] as unknown[] })),
);
vi.mock("../db.js", () => ({ getPool: () => ({ query }) }));

const ll = vi.hoisted(() => ({
  stream: null as LiveHlsStream | null,
  mode: "ll" as "ll" | "conventional",
  rebind: vi.fn(async (_channelId: string, _peerId: string, _detail?: unknown) => true),
}));
vi.mock("./hls-remux.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hls-remux.js")>();
  return {
    ...actual,
    resolveHlsModeForChannel: async () => ({ mode: ll.mode }),
    reconcileLlHlsNow: async (_channelId: string, presenterPeerId: string | null) =>
      presenterPeerId ? ll.stream : null,
    llStreamFor: () => ll.stream,
    llHasRoom: () => ll.stream !== null,
    stopLlSession: async () => {
      ll.stream = null;
    },
    sweepLlDemotions: async () => [],
    rebindLlForReplacedTrack: ll.rebind,
    // The real one writes the LL room's stream; here that stream is `ll.stream`.
    setLlCameraSlot: (
      _channelId: string,
      startedAt: number,
      slot: { cameraHlsUrl: string; cameraHasVideo: boolean; cameraHasVoiceAudio: boolean } | null,
    ) => {
      const current = ll.stream;
      if (!current || current.startedAt !== startedAt) {
        return false;
      }
      if (slot) {
        if (current.cameraHlsUrl === slot.cameraHlsUrl) {
          return false;
        }
        ll.stream = { ...current, ...slot };
        return true;
      }
      if (current.cameraHlsUrl === undefined) {
        return false;
      }
      const { cameraHlsUrl: _u, cameraHasVideo: _v, cameraHasVoiceAudio: _a, ...rest } = current;
      ll.stream = rest;
      return true;
    },
  };
});

const {
  adoptLiveHlsMicArchive,
  checkLiveHlsHealth,
  liveHlsActivity,
  micArchiveObjectKey,
  parkLlCompanion,
  reconcileLiveHls,
  resetLiveHlsForTests,
  setLiveHlsChangeListener,
  setLiveHlsTestHooks,
  setVoiceTrackSeparated,
} = await import("./hls-egress.js");
type LiveHlsEgressApi = import("./hls-egress.js").LiveHlsEgressApi;

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const SERVER = "00000000-0000-4000-8000-0000000000ee";
/** Now-ish, so the archive's window (`MIC_ARCHIVE_WAIT_MS`) is open. */
let STARTED_AT = Date.now();

function llStream(presenterPeerId = "peer-1"): LiveHlsStream {
  return {
    hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}?mode=ll`,
    startedAt: STARTED_AT,
    presenterPeerId,
    delaySeconds: 3,
    mode: "ll",
  };
}

function enableHls() {
  process.env.LIVE_HLS_ENABLED = "true";
  process.env.LIVEKIT_URL = "wss://sfu.example.test";
  process.env.LIVEKIT_API_KEY = "key";
  process.env.LIVEKIT_API_SECRET = "secret";
  process.env.LIVE_HLS_S3_BUCKET = "pqp-live-test";
  process.env.LIVE_HLS_S3_ACCESS_KEY_ID = "ak";
  process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY = "sk";
  process.env.LIVE_HLS_S3_ENDPOINT = "https://s3.example.test";
  process.env.LIVE_HLS_MIC_ARCHIVE = "true";
}

function disableHls() {
  for (const name of [
    "LIVE_HLS_ENABLED",
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "LIVE_HLS_S3_BUCKET",
    "LIVE_HLS_S3_ACCESS_KEY_ID",
    "LIVE_HLS_S3_SECRET_ACCESS_KEY",
    "LIVE_HLS_S3_ENDPOINT",
    "LIVE_HLS_MIC_ARCHIVE",
    "LIVE_HLS_VOICE_TRACK",
  ]) {
    delete process.env[name];
  }
}

function fakeLiveKit() {
  let n = 0;
  const statuses = new Map<string, EgressStatus>();
  const startComposite = vi.fn<LiveHlsEgressApi["startTrackCompositeEgress"]>(async () => {
    const egressId = `EG_${(n += 1)}`;
    statuses.set(egressId, EgressStatus.EGRESS_ACTIVE);
    return { egressId };
  });
  const startTrack = vi.fn<NonNullable<LiveHlsEgressApi["startTrackEgress"]>>(async () => {
    const egressId = `MIC_${(n += 1)}`;
    statuses.set(egressId, EgressStatus.EGRESS_ACTIVE);
    return { egressId };
  });
  const stop = vi.fn(async (egressId: string) => {
    statuses.set(egressId, EgressStatus.EGRESS_COMPLETE);
  });
  const list = vi.fn(async (opts: { egressId?: string; active?: boolean }) =>
    [...statuses.entries()]
      .filter(([id]) => !opts.egressId || id === opts.egressId)
      .filter(([, status]) => (opts.active ? status === EgressStatus.EGRESS_ACTIVE : true))
      .map(([egressId, status]) => ({ egressId, status, roomName: CHANNEL })),
  );
  return {
    api: {
      startTrackCompositeEgress: startComposite,
      startTrackEgress: startTrack,
      stopEgress: stop,
      listEgress: list,
    } satisfies LiveHlsEgressApi,
    startComposite,
    startTrack,
    stop,
    isActive: (egressId: string) => statuses.get(egressId) === EgressStatus.EGRESS_ACTIVE,
  };
}

function install(lk: ReturnType<typeof fakeLiveKit>) {
  setLiveHlsTestHooks({
    egress: lk.api,
    findTracks: async () => ({
      videoTrackId: "TR_SCREEN",
      cameraTrackId: "TR_CAM",
      micArchiveTrackId: "TR_MIC_ARCHIVE",
    }),
  });
}

/** `startRoom`-style camera reconciles run as the next link of the queue. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) {
    await Promise.resolve();
  }
}

/** Every row insert this suite made, as its object prefix. */
function insertedPrefixes(): string[] {
  return query.mock.calls
    .filter(([sql]) => sql.includes("INSERT INTO hls_sessions"))
    .map(([, params]) => (params as unknown[])[1] as string);
}

beforeEach(() => {
  resetLiveHlsForTests();
  disableHls();
  STARTED_AT = Date.now();
  ll.stream = llStream();
  ll.mode = "ll";
  ll.rebind.mockClear();
  logEvent.mockClear();
  query.mockClear();
});

afterEach(() => {
  resetLiveHlsForTests();
  disableHls();
});

describe("an LL broadcast's camera and mic archive", () => {
  it("starts both beside the LL session, under its startedAt, and kept by default", async () => {
    enableHls();
    const lk = fakeLiveKit();
    install(lk);

    const stream = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    // The film is still the LL session's, untouched.
    expect(stream).toEqual(llStream());
    // The archive, to the same `<startedAt>-mic.ogg` a ladder room writes.
    expect(lk.startTrack).toHaveBeenCalledTimes(1);
    expect(lk.startTrack.mock.calls[0]![1].filepath).toBe(
      micArchiveObjectKey(CHANNEL, STARTED_AT),
    );
    // The camera rung, and nothing else: no ladder rung for an LL party.
    expect(lk.startComposite).toHaveBeenCalledTimes(1);
    expect(lk.startComposite.mock.calls[0]![2].videoTrackId).toBe("TR_CAM");
    expect(insertedPrefixes().sort()).toEqual([
      `live/${CHANNEL}/${STARTED_AT}-cam360p30`,
      `live/${CHANNEL}/${STARTED_AT}-mic`,
    ]);
    for (const [sql] of query.mock.calls.filter(([sql]) =>
      sql.includes("INSERT INTO hls_sessions"),
    )) {
      // `keep_replay` is the tenth column and TRUE its tenth value.
      expect(sql).toMatch(/keep_replay, runs\)\s+VALUES \([^)]*\), \$4, \$5, \$6, \$7, \$8, \$9, TRUE,/);
    }
    expect(liveHlsActivity()).toMatchObject({ sessions: 0, micArchives: 1, cameraSessions: 1 });
  });

  it("states the camera on the LL stream the audience is handed, and asks for a push", async () => {
    // THE 2026-09-25 REHEARSAL: 773 s of camera recorded, and the only viewer
    // was shown the film alone, because the camera URL lived on the
    // companion's private copy of the stream and `llStreamFor` never had it.
    enableHls();
    const lk = fakeLiveKit();
    install(lk);
    const reasons: string[] = [];
    setLiveHlsChangeListener((_channelId, reason) => {
      reasons.push(reason);
    });

    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    expect(ll.stream?.cameraHlsUrl).toBe(
      `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}/cam360p30`,
    );
    expect(ll.stream?.cameraHasVideo).toBe(true);
    expect(ll.stream?.cameraHasVoiceAudio).toBe(false);
    // The LL film itself is untouched.
    expect(ll.stream?.hlsUrl).toBe(llStream().hlsUrl);
    expect(reasons).toEqual(["camera-started"]);

    // A resume rebuilds the LL stream without the camera; the next reconcile
    // states it again and hands back the stream that says so.
    ll.stream = llStream();
    const again = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    expect(again?.cameraHlsUrl).toBe(
      `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}/cam360p30`,
    );
  });

  it("takes the camera off the LL stream when the presenter closes it", async () => {
    enableHls();
    const lk = fakeLiveKit();
    install(lk);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    expect(ll.stream?.cameraHlsUrl).toBeTruthy();

    setLiveHlsTestHooks({
      egress: lk.api,
      findTracks: async () => ({
        videoTrackId: "TR_SCREEN",
        micArchiveTrackId: "TR_MIC_ARCHIVE",
      }),
    });
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    expect(ll.stream?.cameraHlsUrl).toBeUndefined();
  });

  it("is idempotent across reconciles: one camera, one archive", async () => {
    enableHls();
    const lk = fakeLiveKit();
    install(lk);

    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    expect(lk.startTrack).toHaveBeenCalledTimes(1);
    expect(lk.startComposite).toHaveBeenCalledTimes(1);
  });

  it("stops both when the share ends", async () => {
    enableHls();
    const lk = fakeLiveKit();
    install(lk);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    await reconcileLiveHls(CHANNEL, null, SERVER);
    await flush();

    expect(lk.stop.mock.calls.map(([id]) => id).sort()).toEqual(["EG_2", "MIC_1"]);
    expect(liveHlsActivity()).toMatchObject({ micArchives: 0, cameraSessions: 0 });
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlCompanionsStopped",
      expect.objectContaining({ channelId: CHANNEL, reason: "ll-stopped" }),
    );
  });

  it("stops both when the party falls back to the conventional ladder", async () => {
    enableHls();
    const lk = fakeLiveKit();
    install(lk);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    ll.mode = "conventional";
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    expect(lk.isActive("MIC_1")).toBe(false);
    expect(lk.isActive("EG_2")).toBe(false);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlCompanionsStopped",
      expect.objectContaining({ reason: "conventional-mode-selected" }),
    );
  });

  it("the monitor stops them once the LL session is gone, past the boot grace", async () => {
    enableHls();
    const lk = fakeLiveKit();
    install(lk);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    ll.stream = null;
    await checkLiveHlsHealth(Date.now());
    expect(lk.isActive("MIC_1")).toBe(true);

    await checkLiveHlsHealth(Date.now() + 61_000);
    expect(lk.isActive("MIC_1")).toBe(false);
    expect(lk.isActive("EG_2")).toBe(false);
  });

  it("never starts a second archive for a session it inherited", async () => {
    enableHls();
    const lk = fakeLiveKit();
    install(lk);
    // What the boot reconcile does for an LL broadcast's archive egress that
    // outlived the restart: park a companion and adopt the egress onto it.
    parkLlCompanion({
      channelId: CHANNEL,
      startedAt: STARTED_AT,
      presenterPeerId: "peer-1",
      videoTrackId: "TR_SCREEN",
    });
    expect(
      adoptLiveHlsMicArchive({
        channelId: CHANNEL,
        egressId: "MIC_OLD",
        startedAt: STARTED_AT,
        trackId: "TR_SCREEN",
      }),
    ).toBe(true);

    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    // The inherited one is kept; a second would overwrite `-mic.ogg`.
    expect(lk.startTrack).not.toHaveBeenCalled();
    expect(liveHlsActivity().micArchives).toBe(1);
  });

  it("an archive window that closed before the companion existed is not reopened", async () => {
    enableHls();
    const lk = fakeLiveKit();
    install(lk);
    // An LL session started long before this process built its companion.
    ll.stream = { ...llStream(), startedAt: Date.now() - 10 * 60_000 };

    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    expect(lk.startTrack).not.toHaveBeenCalled();
  });
});

describe("an LL broadcast's companions across a presenter track change", () => {
  function tracks(t: {
    screen: string;
    camera?: string;
    voice?: string;
  }) {
    return async () => ({
      videoTrackId: t.screen,
      cameraTrackId: t.camera ?? "TR_CAM",
      micArchiveTrackId: "TR_MIC_ARCHIVE",
      ...(t.voice ? { voiceTrackId: t.voice } : {}),
    });
  }

  it("a republished screen nudges the box to rebind, and the camera and archive ride through", async () => {
    enableHls();
    const lk = fakeLiveKit();
    install(lk);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    expect(ll.rebind).not.toHaveBeenCalled();

    // The presenter's client resumed after a deploy and republished.
    setLiveHlsTestHooks({ findTracks: tracks({ screen: "TR_SCREEN_2" }) });
    const stream = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    // The same LL session, still stating the camera that rode through.
    expect(stream).toMatchObject(llStream());
    expect(stream?.cameraHlsUrl).toContain("cam360p30");
    expect(ll.rebind).toHaveBeenCalledTimes(1);
    expect(ll.rebind).toHaveBeenCalledWith(CHANNEL, "peer-1", {
      videoFrom: "TR_SCREEN",
      videoTo: "TR_SCREEN_2",
    });
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsTrackReplaced",
      expect.objectContaining({ channelId: CHANNEL, mode: "ll", from: "TR_SCREEN", to: "TR_SCREEN_2" }),
    );
    // Nothing of the broadcast was stopped or started again.
    expect(lk.stop).not.toHaveBeenCalled();
    expect(lk.startTrack).toHaveBeenCalledTimes(1);
    expect(lk.startComposite).toHaveBeenCalledTimes(1);
    expect(logEvent).not.toHaveBeenCalledWith("voice.hlsLlCompanionsStopped", expect.anything());

    // Seen once is seen: the next roster event does not nudge again.
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    expect(ll.rebind).toHaveBeenCalledTimes(1);
  });

  it("a nudge the control API never heard is sent again on the next reconcile, and only until it lands", async () => {
    enableHls();
    const lk = fakeLiveKit();
    install(lk);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    setLiveHlsTestHooks({ findTracks: tracks({ screen: "TR_SCREEN_2" }) });
    ll.rebind.mockResolvedValueOnce(false);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    expect(ll.rebind).toHaveBeenCalledTimes(2);
    expect(ll.rebind.mock.calls[1]).toEqual([
      CHANNEL,
      "peer-1",
      { videoFrom: "TR_SCREEN", videoTo: "TR_SCREEN_2" },
    ]);
  });

  it("a moment with no screen track at all (between unpublish and publish) nudges nothing", async () => {
    enableHls();
    const lk = fakeLiveKit();
    install(lk);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    setLiveHlsTestHooks({ findTracks: tracks({ screen: "" }) });
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    expect(ll.rebind).not.toHaveBeenCalled();
  });

  it("a presenter rebound under a new peer id keeps the companions, and their separated voice", async () => {
    enableHls();
    process.env.LIVE_HLS_VOICE_TRACK = "true";
    const lk = fakeLiveKit();
    setLiveHlsTestHooks({ egress: lk.api, findTracks: tracks({ screen: "TR_SCREEN", voice: "TR_MIC" }) });
    setVoiceTrackSeparated(CHANNEL, "peer-1", true);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    expect(lk.startComposite).toHaveBeenCalledTimes(1);
    expect(lk.startComposite.mock.calls[0]![2].audioTrackId).toBe("TR_MIC");

    // The same person is back as peer-2 and the box was rebound: the LL
    // session is the same one (same startedAt), and their reconnect
    // republished the camera and the mic on new sids.
    ll.stream = llStream("peer-2");
    setLiveHlsTestHooks({
      findTracks: tracks({ screen: "TR_SCREEN_B", camera: "TR_CAM_B", voice: "TR_MIC_B" }),
    });
    const stream = await reconcileLiveHls(CHANNEL, "peer-2", SERVER);
    await flush();

    expect(stream?.startedAt).toBe(STARTED_AT);
    expect(logEvent).not.toHaveBeenCalledWith("voice.hlsLlCompanionsStopped", expect.anything());
    // The archive is not restarted (one file per broadcast); the camera
    // follows its new track, WITH the voice the presenter separated.
    expect(lk.startTrack).toHaveBeenCalledTimes(1);
    const last = lk.startComposite.mock.calls.at(-1)!;
    expect(last[2].videoTrackId).toBe("TR_CAM_B");
    expect(last[2].audioTrackId).toBe("TR_MIC_B");
    // A presenter change is the rebind path's business, not a track nudge.
    expect(ll.rebind).not.toHaveBeenCalled();
  });
});

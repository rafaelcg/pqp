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
  setLiveHlsTestHooks,
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
      expect(sql).toMatch(/keep_replay\)\s+VALUES \(.*, TRUE\)/);
    }
    expect(liveHlsActivity()).toMatchObject({ sessions: 0, micArchives: 1, cameraSessions: 1 });
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

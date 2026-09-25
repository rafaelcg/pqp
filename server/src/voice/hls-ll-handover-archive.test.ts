import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EgressStatus } from "livekit-server-sdk";
import type { LiveHlsStream } from "@pqp/shared";

/**
 * THE VOICE ARCHIVE ACROSS A PRESENTER RELOAD THAT LANDS ON THE OTHER MACHINE.
 *
 * Production rehearsal D, 2026-09-25: an LL party, the presenter's page
 * reloaded at T+7 and came back on the sibling API replica. The session was
 * handed over (`releaseLiveHlsSession`) and adopted there, the camera came back
 * in place, and the voice archive was gone for the WHOLE show: the history said
 * "gravação da voz desligada". Two things went wrong on the adopting machine:
 *
 *  1. The reload took the presenter out of LiveKit, so the archive's Track
 *     Egress had already ended when the adopter listed the active egresses.
 *     `adoptLlCompanionRows` skipped the open `mic` row (not listed) and never
 *     ended it either, and nothing else ever would: the row stayed open for
 *     ever, and the history only serves a row with `ended_at` set.
 *  2. The same function read "rows exist" as "never a second archive", so the
 *     presenter's new `mic-archive` track was never recorded after the reload.
 *     That rule predates in-place runs (#816): a run writes its own
 *     `-r<ms>.ogg`, so continuing is not overwriting.
 *
 * One module plays both machines here: the handover makes it forget the
 * session exactly as the releasing machine does, and it then adopts from the
 * rows the way the other one would. The rows live in a small in-memory table.
 */

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("../lib/log.js", () => ({ logEvent }));

interface FakeRow {
  id: string;
  channel_id: string;
  object_prefix: string;
  egress_id: string | null;
  rung: string | null;
  mode: string;
  presenter_peer_id: string | null;
  video_track_id: string | null;
  audio_track_id: string | null;
  instance_id: string | null;
  runs: unknown;
  ended: boolean;
}

const table = vi.hoisted(() => ({ rows: [] as FakeRow[], next: 0 }));

const query = vi.hoisted(() =>
  vi.fn(async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, " ");
    const byPrefix = (prefix: unknown) =>
      table.rows.find((row) => row.object_prefix === prefix);
    if (text.includes("INSERT INTO hls_sessions")) {
      const [channelId, prefix, , egressId, rung, presenter, video, audio, instance, runs] =
        params as [string, string, number, string, string, string, string, string | null, string, string | null];
      const existing = byPrefix(prefix);
      if (existing) {
        if (!text.includes("DO UPDATE")) {
          return { rowCount: 0, rows: [] };
        }
        Object.assign(existing, {
          egress_id: egressId,
          presenter_peer_id: presenter,
          video_track_id: video,
          audio_track_id: audio,
          instance_id: instance,
          runs: runs ? JSON.parse(runs) : null,
          ended: false,
        });
        return { rowCount: 1, rows: [{ id: existing.id }] };
      }
      const row: FakeRow = {
        id: `row-${(table.next += 1)}`,
        channel_id: channelId,
        object_prefix: prefix,
        egress_id: egressId,
        rung,
        mode: "conventional",
        presenter_peer_id: presenter,
        video_track_id: video,
        audio_track_id: audio,
        instance_id: instance,
        runs: runs ? JSON.parse(runs) : null,
        ended: false,
      };
      table.rows.push(row);
      return { rowCount: 1, rows: [{ id: row.id }] };
    }
    if (text.startsWith("SELECT id FROM hls_sessions WHERE object_prefix = $1")) {
      const row = byPrefix(params[0]);
      return { rowCount: row ? 1 : 0, rows: row ? [{ id: row.id }] : [] };
    }
    if (text.startsWith("SELECT runs FROM hls_sessions WHERE object_prefix = $1")) {
      const row = byPrefix(params[0]);
      return { rowCount: row ? 1 : 0, rows: row ? [{ runs: row.runs }] : [] };
    }
    if (text.includes("SELECT ended_at, instance_id, runs FROM hls_sessions")) {
      const row = byPrefix(params[0]);
      return {
        rowCount: row ? 1 : 0,
        rows: row
          ? [{ ended_at: row.ended ? new Date() : null, instance_id: row.instance_id, runs: row.runs }]
          : [],
      };
    }
    if (text.startsWith("UPDATE hls_sessions SET ended_at = NOW() WHERE object_prefix = $1")) {
      const row = byPrefix(params[0]);
      if (row && !row.ended) {
        row.ended = true;
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }
    if (text.startsWith("UPDATE hls_sessions SET ended_at = NOW() WHERE id = ANY")) {
      const ids = params[0] as string[];
      for (const row of table.rows) {
        if (ids.includes(row.id)) {
          row.ended = true;
        }
      }
      return { rowCount: ids.length, rows: [] };
    }
    if (text.startsWith("UPDATE hls_sessions SET ended_at = NOW() WHERE channel_id = $1")) {
      const [channelId, prefix] = params as [string, string];
      for (const row of table.rows) {
        if (
          row.channel_id === channelId &&
          (row.object_prefix === prefix || row.object_prefix.startsWith(`${prefix}-`))
        ) {
          row.ended = true;
        }
      }
      return { rowCount: 0, rows: [] };
    }
    if (text.includes("FROM hls_sessions WHERE channel_id = $1 AND ended_at IS NULL")) {
      // The open, non-LL rows an adopter looks through.
      const rows = table.rows.filter(
        (row) =>
          row.channel_id === params[0] &&
          !row.ended &&
          row.mode !== "ll" &&
          row.egress_id !== null,
      );
      return { rowCount: rows.length, rows };
    }
    if (text.startsWith("WITH film AS")) {
      // The handover: every open row of the channel this process owns is
      // stamped with the target.
      const [channelId, to, me] = params as [string, string, string];
      const moved = table.rows.filter(
        (row) =>
          row.channel_id === channelId &&
          !row.ended &&
          (row.instance_id === null || row.instance_id === me),
      );
      for (const row of moved) {
        row.instance_id = to;
      }
      return { rowCount: moved.length, rows: moved.map((row) => ({ id: row.id })) };
    }
    return { rowCount: 0, rows: [] as unknown[] };
  }),
);
vi.mock("../db.js", () => ({ getPool: () => ({ query }) }));

const ll = vi.hoisted(() => ({ stream: null as LiveHlsStream | null }));
vi.mock("./hls-remux.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hls-remux.js")>();
  return {
    ...actual,
    resolveHlsModeForChannel: async () => ({ mode: "ll" }),
    // The LL film itself is pqp-remux's and not what is pinned here: it is
    // whatever `ll.stream` says, rebound to the presenter this reconcile asks
    // for, exactly as `rebindLlSession` would.
    reconcileLlHlsNow: async (_channelId: string, presenterPeerId: string | null) => {
      if (!presenterPeerId) {
        ll.stream = null;
        return null;
      }
      if (ll.stream && ll.stream.presenterPeerId !== presenterPeerId) {
        ll.stream = { ...ll.stream, presenterPeerId };
      }
      return ll.stream;
    },
    llStreamFor: () => ll.stream,
    llHasRoom: () => ll.stream !== null,
    stopLlSession: async () => {
      ll.stream = null;
    },
    sweepLlDemotions: async () => [],
    rebindLlForReplacedTrack: async () => true,
    setLlCameraSlot: () => false,
  };
});

const {
  micArchiveObjectKey,
  reconcileLiveHls,
  releaseLiveHlsSession,
  checkLiveHlsHealth,
  resetLiveHlsForTests,
  setLiveHlsTestHooks,
} = await import("./hls-egress.js");
type LiveHlsEgressApi = import("./hls-egress.js").LiveHlsEgressApi;

const CHANNEL = "00000000-0000-4000-8000-0000000000ab";
const SERVER = "00000000-0000-4000-8000-0000000000ee";
let STARTED_AT = Date.now();

function enableHls() {
  Object.assign(process.env, {
    LIVE_HLS_ENABLED: "true",
    LIVEKIT_URL: "wss://sfu.example.test",
    LIVEKIT_API_KEY: "key",
    LIVEKIT_API_SECRET: "secret",
    LIVE_HLS_S3_BUCKET: "pqp-live-test",
    LIVE_HLS_S3_ACCESS_KEY_ID: "ak",
    LIVE_HLS_S3_SECRET_ACCESS_KEY: "sk",
    LIVE_HLS_S3_ENDPOINT: "https://s3.example.test",
    LIVE_HLS_MIC_ARCHIVE: "true",
  });
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
  const tracksOf = new Map<string, string>();
  const startComposite = vi.fn<LiveHlsEgressApi["startTrackCompositeEgress"]>(async () => {
    const egressId = `EG_${(n += 1)}`;
    statuses.set(egressId, EgressStatus.EGRESS_ACTIVE);
    return { egressId };
  });
  const startTrack = vi.fn<NonNullable<LiveHlsEgressApi["startTrackEgress"]>>(
    async (_room, _output, trackId) => {
      const egressId = `MIC_${(n += 1)}`;
      statuses.set(egressId, EgressStatus.EGRESS_ACTIVE);
      tracksOf.set(egressId, trackId);
      return { egressId };
    },
  );
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
    startTrack,
    /** The presenter left LiveKit: every egress bound to their tracks ends. */
    presenterLeft: () => {
      for (const [id, status] of statuses) {
        if (status === EgressStatus.EGRESS_ACTIVE) {
          statuses.set(id, EgressStatus.EGRESS_COMPLETE);
        }
      }
    },
    recordingTrack: () =>
      [...statuses.entries()]
        .filter(([id, status]) => id.startsWith("MIC_") && status === EgressStatus.EGRESS_ACTIVE)
        .map(([id]) => tracksOf.get(id)),
  };
}

const presenter = { tracks: {} as Record<string, string | undefined> };
function installTracks(lk: ReturnType<typeof fakeLiveKit>) {
  setLiveHlsTestHooks({
    egress: lk.api,
    findTracks: async () =>
      presenter.tracks.screen
        ? {
            videoTrackId: presenter.tracks.screen,
            ...(presenter.tracks.archive ? { micArchiveTrackId: presenter.tracks.archive } : {}),
            ...(presenter.tracks.camera ? { cameraTrackId: presenter.tracks.camera } : {}),
          }
        : null,
  });
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 40; tick += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let tick = 0; tick < 40; tick += 1) {
    await Promise.resolve();
  }
}

function micRow(): FakeRow | undefined {
  return table.rows.find((row) => row.rung === "mic");
}

/** The party up on "machine A", with the voice recording. */
async function goLiveOnA(lk: ReturnType<typeof fakeLiveKit>) {
  installTracks(lk);
  presenter.tracks = { screen: "TR_SCREEN_1", archive: "TR_ARCHIVE_1", camera: "TR_CAM_1" };
  await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
  await flush();
  expect(lk.recordingTrack()).toEqual(["TR_ARCHIVE_1"]);
  expect(micRow()?.ended).toBe(false);
}

/** The presenter's page reloads and comes back as peer-2 on "machine B". */
async function reloadOntoB(
  lk: ReturnType<typeof fakeLiveKit>,
  options: { monitorSawTheArchiveEndFirst?: boolean } = {},
) {
  lk.presenterLeft();
  presenter.tracks = {};
  if (options.monitorSawTheArchiveEndFirst) {
    await checkLiveHlsHealth(Date.now() + 20_000);
    await flush();
  }
  const released = await releaseLiveHlsSession({
    channelId: CHANNEL,
    startedAt: STARTED_AT,
    toInstanceId: "instance-b",
    presenterPeerId: "peer-1",
  });
  expect(released).toBe(true);
  // Machine B: the LL session is adopted under the new peer, and the
  // presenter's reloaded page publishes the share, the camera and a new
  // `mic-archive` track.
  presenter.tracks = { screen: "TR_SCREEN_2", archive: "TR_ARCHIVE_2", camera: "TR_CAM_2" };
  await reconcileLiveHls(CHANNEL, "peer-2", SERVER);
  await flush();
}

beforeEach(() => {
  resetLiveHlsForTests();
  disableHls();
  table.rows = [];
  table.next = 0;
  STARTED_AT = Date.now();
  // The LL film's own row (pqp-remux's, written by `hls-remux.ts`): what a
  // handover moves the session BY.
  table.rows.push({
    id: "row-ll",
    channel_id: CHANNEL,
    object_prefix: `live/${CHANNEL}/${STARTED_AT}-ll`,
    egress_id: null,
    rung: null,
    mode: "ll",
    presenter_peer_id: "peer-1",
    video_track_id: null,
    audio_track_id: null,
    instance_id: null,
    runs: null,
    ended: false,
  });
  ll.stream = {
    hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}?mode=ll`,
    startedAt: STARTED_AT,
    presenterPeerId: "peer-1",
    delaySeconds: 3,
    mode: "ll",
  };
  logEvent.mockClear();
  query.mockClear();
});

afterEach(() => {
  resetLiveHlsForTests();
  disableHls();
});

describe("the voice archive across a presenter reload onto the other machine (rehearsal D)", () => {
  it("keeps recording after the handover, as a new run of the same file", async () => {
    enableHls();
    const lk = fakeLiveKit();
    await goLiveOnA(lk);

    await reloadOntoB(lk);

    // The reloaded presenter's archive is recorded again, under its own run
    // name: never over the `<startedAt>-mic.ogg` machine A wrote.
    expect(lk.recordingTrack()).toEqual(["TR_ARCHIVE_2"]);
    const outputs = lk.startTrack.mock.calls.map(([, output]) => output.filepath);
    expect(outputs[0]).toBe(micArchiveObjectKey(CHANNEL, STARTED_AT));
    expect(outputs).toHaveLength(2);
    expect(outputs[1]).toMatch(new RegExp(`/${STARTED_AT}-mic-r\\d+\\.ogg$`));
    expect(micRow()?.ended).toBe(false);
    expect(micRow()?.runs).toEqual([
      { suffix: "", base: expect.any(Number) },
      { suffix: expect.stringMatching(/^-r\d+$/), base: expect.any(Number) },
    ]);
  });

  it("ends the voice row when the party ends, so the history offers the file", async () => {
    // The rehearsal's actual symptom: the `mic` row was never ended, and the
    // history only lists a row that has.
    enableHls();
    const lk = fakeLiveKit();
    await goLiveOnA(lk);
    await reloadOntoB(lk);

    await reconcileLiveHls(CHANNEL, null, SERVER);
    await flush();

    expect(micRow()?.ended).toBe(true);
    expect(lk.recordingTrack()).toEqual([]);
  });

  it("an archive the old machine already closed is continued too", async () => {
    // The other order of the same race: machine A's monitor saw the Track
    // Egress end (and closed the row) before the handover reached it.
    enableHls();
    const lk = fakeLiveKit();
    await goLiveOnA(lk);

    await reloadOntoB(lk, { monitorSawTheArchiveEndFirst: true });

    expect(lk.recordingTrack()).toEqual(["TR_ARCHIVE_2"]);
    const outputs = lk.startTrack.mock.calls.map(([, output]) => output.filepath);
    expect(outputs).toHaveLength(2);
    expect(outputs[1]).toMatch(new RegExp(`/${STARTED_AT}-mic-r\\d+\\.ogg$`));
  });

  it("an archive track that lands a beat after the share is still found by the monitor", async () => {
    // The browser publishes `mic-archive` after the share is up, so the
    // reconcile that adopts the session usually does not see it yet, and
    // publishing it is not a roster event the server hears about.
    enableHls();
    const lk = fakeLiveKit();
    await goLiveOnA(lk);
    lk.presenterLeft();
    presenter.tracks = {};
    await releaseLiveHlsSession({
      channelId: CHANNEL,
      startedAt: STARTED_AT,
      toInstanceId: "instance-b",
      presenterPeerId: "peer-1",
    });
    presenter.tracks = { screen: "TR_SCREEN_2", camera: "TR_CAM_2" };
    await reconcileLiveHls(CHANNEL, "peer-2", SERVER);
    await flush();
    expect(lk.recordingTrack()).toEqual([]);

    presenter.tracks = { ...presenter.tracks, archive: "TR_ARCHIVE_2" };
    await checkLiveHlsHealth(Date.now() + 20_000);
    await flush();

    expect(lk.recordingTrack()).toEqual(["TR_ARCHIVE_2"]);
    const outputs = lk.startTrack.mock.calls.map(([, output]) => output.filepath);
    expect(outputs[1]).toMatch(new RegExp(`/${STARTED_AT}-mic-r\\d+\\.ogg$`));
  });
});

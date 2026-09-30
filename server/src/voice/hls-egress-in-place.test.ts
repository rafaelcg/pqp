import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EgressStatus } from "livekit-server-sdk";
import {
  type LiveHlsEgressApi,
  adoptLiveHlsSession,
  checkLiveHlsHealth,
  liveHlsActivity,
  liveHlsStreamFor,
  reconcileLiveHls,
  resetLiveHlsForTests,
  setCameraCooldownMsForTests,
  setLiveHlsChangeListener,
  setLiveHlsPresenterIdentity,
  setLiveHlsTestHooks,
  setVoiceTrackSeparated,
  HLS_MAX_RESTARTS,
} from "./hls-egress.js";
import { CAMERA_RUNG_NAME } from "./hls-ladder.js";

/**
 * A WATCH PARTY'S LADDER RESTARTS IN PLACE.
 *
 * Production, 2026-09-24, one conventional show on channel `ad99074f`:
 *  - 07:42:32 `hlsEgressDied rung=480p30 error=Timestamping error on input
 *    streams`, 22 s after go-live, then `hlsStarted` with a NEW `startedAt`:
 *    every viewer re-attached;
 *  - 07:51:41, right after a rolling deploy's adoption, `hlsStopped
 *    reason=screen-track-replaced` and another new session.
 * Both were the same party. What this file pins: a restart of the ladder keeps
 * the session (same `startedAt`, same URL), writes a new egress run under its
 * own names with a durable media-sequence base on the row, and leaves the
 * camera and the host's voice archive running.
 */

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("../lib/log.js", () => ({ logEvent }));

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const SERVER = "00000000-0000-4000-8000-0000000000ee";

const query = vi.hoisted(() =>
  vi.fn(async (sql: string, _params?: unknown[]) => {
    if (typeof sql === "string" && sql.includes("live_hls_enabled")) {
      return { rowCount: 1, rows: [{ live_hls_enabled: null }] };
    }
    if (typeof sql === "string" && sql.includes("hls_sessions") && sql.includes("DISTINCT")) {
      return { rowCount: 1, rows: [{ channel_id: CHANNEL }] };
    }
    return { rowCount: 0, rows: [] };
  }),
);
vi.mock("../db.js", () => ({ getPool: () => ({ query }) }));

function enableHls() {
  process.env.LIVE_HLS_ENABLED = "true";
  process.env.LIVEKIT_URL = "wss://sfu.example.test";
  process.env.LIVEKIT_API_KEY = "key";
  process.env.LIVEKIT_API_SECRET = "secret";
  process.env.LIVE_HLS_S3_BUCKET = "pqp-live-test";
  process.env.LIVE_HLS_S3_ACCESS_KEY_ID = "ak";
  process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY = "sk";
  process.env.LIVE_HLS_S3_ENDPOINT = "https://s3.example.test";
  process.env.LIVE_HLS_LADDER = "480p30";
}

const ENV = [
  "LIVE_HLS_ENABLED",
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "LIVE_HLS_S3_BUCKET",
  "LIVE_HLS_S3_ACCESS_KEY_ID",
  "LIVE_HLS_S3_SECRET_ACCESS_KEY",
  "LIVE_HLS_S3_ENDPOINT",
  "LIVE_HLS_LADDER",
  "LIVE_HLS_CAMERA",
  "LIVE_HLS_VOICE_TRACK",
  "LIVE_HLS_MIC_ARCHIVE",
];

function fakeLiveKit() {
  let n = 0;
  const statuses = new Map<string, EgressStatus>();
  const start = vi.fn<LiveHlsEgressApi["startTrackCompositeEgress"]>(async () => {
    const egressId = `EG_${(n += 1)}`;
    statuses.set(egressId, EgressStatus.EGRESS_ACTIVE);
    return { egressId };
  });
  const startTrack = vi.fn<NonNullable<LiveHlsEgressApi["startTrackEgress"]>>(async () => {
    const egressId = `EG_${(n += 1)}`;
    statuses.set(egressId, EgressStatus.EGRESS_ACTIVE);
    return { egressId };
  });
  const stop = vi.fn(async (egressId: string) => {
    statuses.set(egressId, EgressStatus.EGRESS_COMPLETE);
  });
  const list = vi.fn(async (opts: { egressId?: string }) =>
    [...statuses.entries()]
      .filter(([id]) => !opts.egressId || id === opts.egressId)
      .map(([egressId, status]) => ({ egressId, status, roomName: CHANNEL })),
  );
  return {
    api: {
      startTrackCompositeEgress: start,
      startTrackEgress: startTrack,
      stopEgress: stop,
      listEgress: list,
    } satisfies LiveHlsEgressApi,
    start,
    startTrack,
    stop,
    kill(egressId: string) {
      statuses.set(egressId, EgressStatus.EGRESS_FAILED);
    },
  };
}

/** What each run's live playlist says, by run suffix: a moving body. */
let probeCalls = 0;
const written = new Map<string, number>();
const probed: { rung: string; runSuffix: string }[] = [];
function playlistProbe(_channelId: string, rung: string, runSuffix = ""): string {
  probeCalls += 1;
  probed.push({ rung, runSuffix });
  // The camera's playlist always moves, so the monitor never calls it stuck.
  const count = rung.startsWith("cam") ? probeCalls : (written.get(runSuffix) ?? 5);
  const first = Math.max(0, count - 5);
  const lines = ["#EXTM3U", "#EXT-X-TARGETDURATION:4", `#EXT-X-MEDIA-SEQUENCE:${first}`];
  for (let seq = first; seq < count; seq += 1) {
    lines.push("#EXTINF:4.0,", `x${runSuffix}_${String(seq).padStart(5, "0")}.ts`);
  }
  return lines.join("\n");
}

let tracks: {
  videoTrackId: string;
  cameraTrackId?: string;
  voiceTrackId?: string;
  micArchiveTrackId?: string;
} = { videoTrackId: "TR_SCREEN" };

function install(lk: ReturnType<typeof fakeLiveKit>) {
  setLiveHlsTestHooks({
    egress: lk.api,
    findTracks: async () => ({ ...tracks }),
    playlistProbe,
  });
}

function listener(presenter = "peer-1") {
  const heard: string[] = [];
  setLiveHlsChangeListener((channelId, reason) => {
    heard.push(reason);
    void reconcileLiveHls(channelId, presenter, SERVER);
  });
  return heard;
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let tick = 0; tick < 40; tick += 1) {
    await Promise.resolve();
  }
}

/** The `runs` JSON each row write carried for a ladder rung, in order. */
function runsWritten(rung = "480p30"): { suffix: string; base: number }[][] {
  return query.mock.calls
    .filter(([sql, params]) =>
      String(sql).includes("INSERT INTO hls_sessions") && (params as unknown[])[4] === rung,
    )
    .map(([, params]) => (params as unknown[])[9])
    .filter((json): json is string => typeof json === "string")
    .map((json) => JSON.parse(json) as { suffix: string; base: number }[]);
}

/** The egress id of the ladder rung started last (ids are `EG_<call order>`). */
function lastLadderEgressId(lk: ReturnType<typeof fakeLiveKit>): string {
  let last = -1;
  lk.start.mock.calls.forEach((call, index) => {
    if (!(call[1] as { filenamePrefix: string }).filenamePrefix.includes(CAMERA_RUNG_NAME)) {
      last = index;
    }
  });
  return `EG_${last + 1}`;
}

function ladderStarts(lk: ReturnType<typeof fakeLiveKit>) {
  return lk.start.mock.calls
    .map((call) => call[1] as { filenamePrefix: string; livePlaylistName: string; playlistName: string })
    .filter((output) => !output.filenamePrefix.includes(CAMERA_RUNG_NAME));
}

beforeEach(() => {
  resetLiveHlsForTests();
  for (const name of ENV) delete process.env[name];
  logEvent.mockClear();
  query.mockClear();
  probeCalls = 0;
  probed.length = 0;
  written.clear();
  tracks = { videoTrackId: "TR_SCREEN" };
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-24T07:42:10Z"));
});

afterEach(() => {
  vi.useRealTimers();
  resetLiveHlsForTests();
  for (const name of ENV) delete process.env[name];
});

describe("an egress that dies mid-party", () => {
  it("keeps the session: same URL, a new run based on what the old one wrote, camera and archive untouched", async () => {
    enableHls();
    process.env.LIVE_HLS_CAMERA = "true";
    process.env.LIVE_HLS_MIC_ARCHIVE = "true";
    tracks = { videoTrackId: "TR_SCREEN", cameraTrackId: "TR_CAM", micArchiveTrackId: "TR_ARCHIVE" };
    const lk = fakeLiveKit();
    install(lk);
    const heard = listener();

    const first = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await advance(0);
    expect(first).not.toBeNull();
    const cameraEgress = lk.start.mock.results[1]!;
    expect(lk.start).toHaveBeenCalledTimes(2); // ladder + camera
    expect(lk.startTrack).toHaveBeenCalledTimes(1); // the voice archive
    const cameraId = (await cameraEgress.value).egressId;
    const archiveId = (await lk.startTrack.mock.results[0]!.value).egressId;

    // 22 s after go-live: `Timestamping error on input streams`.
    written.set("", 6);
    lk.kill("EG_1");
    await advance(22_000);
    expect(await checkLiveHlsHealth()).toEqual([{ channelId: CHANNEL, outcome: "scheduled" }]);
    // Between runs the audience holds on the same stream.
    expect(liveHlsStreamFor(CHANNEL)?.hlsUrl).toBe(first!.hlsUrl);
    expect(liveHlsActivity().restartingSessions).toBe(1);

    await advance(2_001);
    expect(heard).toContain("egress-ended");

    const second = liveHlsStreamFor(CHANNEL);
    expect(second?.startedAt).toBe(first!.startedAt);
    expect(second?.hlsUrl).toBe(first!.hlsUrl);
    // Same prefix, run names of its own.
    const runs = ladderStarts(lk);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.filenamePrefix).toMatch(
      new RegExp(`^live/${CHANNEL}/${first!.startedAt}-480p30-r\\d+$`),
    );
    expect(runs[1]!.livePlaylistName).toMatch(new RegExp(`^${first!.startedAt}-480p30-r\\d+\\.m3u8$`));
    // The durable base: run 0 wrote 6 segments (0..5), run 1 starts at 6.
    const suffix = runs[1]!.filenamePrefix.split("-480p30")[1]!;
    expect(runsWritten().at(-1)).toEqual([
      { suffix: "", base: 0 },
      { suffix, base: 6 },
    ]);
    // Read AFTER the stop, from the run that was replaced.
    expect(probed).toContainEqual({ rung: "480p30", runSuffix: "" });
    // The camera and the archive carried on through it.
    expect(lk.stop).not.toHaveBeenCalledWith(cameraId);
    expect(lk.stop).not.toHaveBeenCalledWith(archiveId);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsRungRestartedInPlace",
      expect.objectContaining({ reason: "egress-ended", startedAt: first!.startedAt, bases: { "480p30": 6 } }),
    );
    expect(logEvent).not.toHaveBeenCalledWith("voice.hlsStopped", expect.anything());
    expect(liveHlsActivity()).toMatchObject({
      restartsInPlaceTotal: 1,
      restartsInPlaceByReason: { "egress-ended": 1 },
      restartingSessions: 0,
    });
  });

  it("restarts again and again under one session, then ends it for real when the budget runs out", async () => {
    enableHls();
    process.env.LIVE_HLS_CAMERA = "true";
    tracks = { videoTrackId: "TR_SCREEN", cameraTrackId: "TR_CAM" };
    const lk = fakeLiveKit();
    install(lk);
    listener();
    const first = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await advance(0);

    for (let round = 1; round <= HLS_MAX_RESTARTS; round += 1) {
      const runs = ladderStarts(lk);
      const current = runs.at(-1)!.filenamePrefix.split("-480p30")[1] ?? "";
      written.set(current, 3 + round);
      const ladderId = lastLadderEgressId(lk);
      lk.kill(ladderId);
      await advance(20_000);
      expect(await checkLiveHlsHealth()).toEqual([{ channelId: CHANNEL, outcome: "scheduled" }]);
      await advance(15_000);
      expect(liveHlsStreamFor(CHANNEL)?.hlsUrl).toBe(first!.hlsUrl);
      expect(liveHlsStreamFor(CHANNEL)?.startedAt).toBe(first!.startedAt);
    }
    const history = runsWritten().at(-1)!;
    expect(history).toHaveLength(HLS_MAX_RESTARTS + 1);
    // One monotonic sequence line: each run starts where the last one ended.
    expect(history.map((run) => run.base)).toEqual([0, 4, 4 + 5, 4 + 5 + 6]);
    expect(new Set(history.map((run) => run.suffix)).size).toBe(history.length);

    // The fourth death inside the window: the genuine end, camera and all.
    const lastLadder = lastLadderEgressId(lk);
    lk.kill(lastLadder);
    await advance(20_000);
    expect(await checkLiveHlsHealth()).toEqual([{ channelId: CHANNEL, outcome: "failed" }]);
    await advance(1);
    expect(liveHlsStreamFor(CHANNEL)).toBeNull();
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsStopped",
      expect.objectContaining({ reason: "restart-budget-exhausted" }),
    );
  });
});

describe("a restart nobody picks up", () => {
  it("is nudged again rather than left between runs forever", async () => {
    enableHls();
    const lk = fakeLiveKit();
    install(lk);
    const heard: string[] = [];
    // A push that goes nowhere: the presenter's machine is elsewhere, say.
    setLiveHlsChangeListener((_channel, reason) => heard.push(reason));
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    lk.kill("EG_1");
    await advance(20_000);
    await checkLiveHlsHealth();
    await advance(2_001);
    expect(heard).toEqual(["egress-ended"]);
    expect(liveHlsActivity().restartingSessions).toBe(1);
    await advance(60_000);
    await checkLiveHlsHealth();
    expect(heard).toEqual(["egress-ended"]);
    await advance(30_000);
    await checkLiveHlsHealth();
    expect(heard).toEqual(["egress-ended", "restart-stalled"]);
  });
});

describe("an attempt that does not finish", () => {
  it("a run whose row write failed is abandoned: stopped, and the rows put back", async () => {
    enableHls();
    const lk = fakeLiveKit();
    install(lk);
    const first = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (String(sql).includes("INSERT INTO hls_sessions")) {
        throw new Error("database_unavailable");
      }
      return original(sql, params);
    });
    tracks = { videoTrackId: "TR_NEW" };
    const stream = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    // Still the same session, still holding, the new egress stopped.
    expect(stream?.startedAt).toBe(first!.startedAt);
    expect(lk.stop).toHaveBeenCalledWith("EG_2");
    expect(liveHlsActivity().restartingSessions).toBe(1);
    const restore = query.mock.calls.find(([sql]) => String(sql).includes("SET runs = $2::jsonb"));
    expect(restore?.[1]).toEqual([
      `live/${CHANNEL}/${first!.startedAt}-480p30`,
      null,
      "EG_1",
    ]);
    expect(logEvent).not.toHaveBeenCalledWith("voice.hlsRungRestartedInPlace", expect.anything());
    query.mockImplementation(original);
  });

  it("a presenter reconnecting under a new peer id inside the backoff restarts now, for that peer", async () => {
    enableHls();
    const lk = fakeLiveKit();
    install(lk);
    setLiveHlsPresenterIdentity(() => "user-rafa");
    setLiveHlsChangeListener(() => {});
    const first = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    lk.kill("EG_1");
    await advance(20_000);
    expect(await checkLiveHlsHealth()).toEqual([{ channelId: CHANNEL, outcome: "scheduled" }]);
    // Inside the 2 s backoff, the same person is back as peer-1b.
    const again = await reconcileLiveHls(CHANNEL, "peer-1b", SERVER);
    expect(again?.startedAt).toBe(first!.startedAt);
    expect(again?.presenterPeerId).toBe("peer-1b");
    expect(liveHlsActivity().restartsInPlaceTotal).toBe(1);
  });
});

describe("a replaced screen track", () => {
  it("after a deploy's adoption, continues the adopted run's history instead of a new session (07:51:41)", async () => {
    enableHls();
    const lk = fakeLiveKit();
    install(lk);
    listener();
    const STARTED_AT = Date.parse("2026-09-24T07:43:01Z");
    // The new process adopted a ladder that had already restarted once.
    adoptLiveHlsSession({
      channelId: CHANNEL,
      egressId: "EG_ADOPTED",
      startedAt: STARTED_AT,
      presenterPeerId: "peer-1",
      videoTrackId: "TR_BEFORE_DEPLOY",
      audioTrackId: null,
      rung: "480p30",
      runs: [
        { suffix: "", base: 0 },
        { suffix: "-r1790235800000", base: 40 },
      ],
    });
    written.set("-r1790235800000", 9);
    // The presenter resumed and republished the screen on a new sid.
    tracks = { videoTrackId: "TR_AFTER_RESUME" };
    const stream = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

    expect(stream?.startedAt).toBe(STARTED_AT);
    expect(stream?.hlsUrl).toBe(`/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}`);
    expect(lk.stop).toHaveBeenCalledWith("EG_ADOPTED");
    // The ADOPTED run's playlist was the one counted, not the first run's.
    expect(probed).toContainEqual({ rung: "480p30", runSuffix: "-r1790235800000" });
    const history = runsWritten().at(-1)!;
    expect(history.slice(0, 2)).toEqual([
      { suffix: "", base: 0 },
      { suffix: "-r1790235800000", base: 40 },
    ]);
    expect(history[2]!.base).toBe(49);
    expect(lk.start.mock.calls[0]![2]).toEqual(
      expect.objectContaining({ videoTrackId: "TR_AFTER_RESUME" }),
    );
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsRungRestartedInPlace",
      expect.objectContaining({ reason: "screen-track-replaced", startedAt: STARTED_AT }),
    );
    expect(logEvent).not.toHaveBeenCalledWith("voice.hlsStopped", expect.anything());
  });

  it("a presenter back under a fresh peer id is still the same party; somebody else is not", async () => {
    enableHls();
    const lk = fakeLiveKit();
    install(lk);
    setLiveHlsPresenterIdentity((_channel, peerId) =>
      peerId === "peer-1" || peerId === "peer-1b" ? "user-rafa" : "user-other",
    );
    tracks = { videoTrackId: "TR_1" };
    const first = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

    // A reconnect that could not resume: new socket, new screen publication.
    tracks = { videoTrackId: "TR_2" };
    const again = await reconcileLiveHls(CHANNEL, "peer-1b", SERVER);
    expect(again?.startedAt).toBe(first!.startedAt);
    expect(again?.presenterPeerId).toBe("peer-1b");
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsRungRestartedInPlace",
      expect.objectContaining({ reason: "presenter-reconnected" }),
    );

    // A different person taking the screen is a different session.
    vi.setSystemTime(Date.now() + 5_000);
    tracks = { videoTrackId: "TR_3" };
    const other = await reconcileLiveHls(CHANNEL, "peer-2", SERVER);
    expect(other?.startedAt).not.toBe(first!.startedAt);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsStopped",
      expect.objectContaining({ reason: "presenter-changed" }),
    );
  });
});

describe("the camera across a restart", () => {
  it("an adopted camera with the host's voice keeps it: the declaration comes back with the row", async () => {
    enableHls();
    process.env.LIVE_HLS_CAMERA = "true";
    process.env.LIVE_HLS_VOICE_TRACK = "true";
    const lk = fakeLiveKit();
    install(lk);
    const STARTED_AT = Date.parse("2026-09-24T07:43:01Z");
    adoptLiveHlsSession({
      channelId: CHANNEL,
      egressId: "EG_LADDER",
      startedAt: STARTED_AT,
      presenterPeerId: "peer-1",
      videoTrackId: "TR_SCREEN",
      audioTrackId: null,
      rung: "480p30",
    });
    adoptLiveHlsSession({
      channelId: CHANNEL,
      egressId: "EG_CAM",
      startedAt: STARTED_AT,
      presenterPeerId: "peer-1",
      videoTrackId: "TR_CAM",
      audioTrackId: "TR_VOICE",
      rung: CAMERA_RUNG_NAME,
    });
    // The presenter never re-sends `set-voice-track-mode` after a deploy.
    tracks = { videoTrackId: "TR_SCREEN", cameraTrackId: "TR_CAM", voiceTrackId: "TR_VOICE" };
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await advance(0);
    expect(lk.stop).not.toHaveBeenCalledWith("EG_CAM");
    expect(lk.start).not.toHaveBeenCalled();
    expect(liveHlsStreamFor(CHANNEL)?.cameraHasVoiceAudio).toBe(true);
  });

  it("a separated voice declared by the old socket follows a reattached presenter", async () => {
    enableHls();
    process.env.LIVE_HLS_CAMERA = "true";
    process.env.LIVE_HLS_VOICE_TRACK = "true";
    const lk = fakeLiveKit();
    install(lk);
    tracks = { videoTrackId: "TR_SCREEN", cameraTrackId: "TR_CAM", voiceTrackId: "TR_VOICE" };
    setVoiceTrackSeparated(CHANNEL, "peer-1", true);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await advance(0);
    const cameraStarts = lk.start.mock.calls.length;
    // Same screen track, fresh peer id (a reconstructed session).
    await reconcileLiveHls(CHANNEL, "peer-1b", SERVER);
    await advance(0);
    expect(lk.start.mock.calls.length).toBe(cameraStarts);
    expect(liveHlsStreamFor(CHANNEL)?.cameraHasVoiceAudio).toBe(true);
  });

  it("a camera that dies once is back in seconds; a second death waits the full cooldown", async () => {
    enableHls();
    process.env.LIVE_HLS_CAMERA = "true";
    setCameraCooldownMsForTests(120_000);
    tracks = { videoTrackId: "TR_SCREEN", cameraTrackId: "TR_CAM" };
    const lk = fakeLiveKit();
    install(lk);
    listener();
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await advance(0);
    expect(lk.start).toHaveBeenCalledTimes(2);

    lk.kill("EG_2");
    await advance(20_000);
    await checkLiveHlsHealth();
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsCameraDied",
      expect.objectContaining({ cooldownMs: 3_000 }),
    );
    await advance(3_100);
    expect(lk.start).toHaveBeenCalledTimes(3);
    expect(liveHlsStreamFor(CHANNEL)?.cameraHlsUrl).toBeDefined();

    lk.kill("EG_3");
    await advance(20_000);
    await checkLiveHlsHealth();
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsCameraDied",
      expect.objectContaining({ cooldownMs: 120_000 }),
    );
    await advance(3_100);
    const cameraStarts = lk.start.mock.calls.filter((call) =>
      (call[1] as { filenamePrefix: string }).filenamePrefix.includes(CAMERA_RUNG_NAME),
    );
    expect(cameraStarts).toHaveLength(2);
  });
});

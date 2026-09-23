import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EgressStatus, TrackSource } from "livekit-server-sdk";
import {
  type LiveHlsEgressApi,
  adoptLiveHlsSession,
  checkLiveHlsHealth,
  liveHlsActivity,
  liveHlsStreamFor,
  pickScreenTracks,
  reconcileLiveHls,
  resetLiveHlsForTests,
  setLiveHlsChangeListener,
  setLiveHlsTestHooks,
  setVoiceTrackSeparated,
} from "./hls-egress.js";
import {
  CAMERA_RUNG_NAME,
  HLS_CAMERA_MBPS,
  HLS_RUNG_MBPS,
  HLS_VOICE_ONLY_MBPS,
  LADDER_RUNGS,
} from "./hls-ladder.js";

/**
 * THE PRESENTER'S CAMERA GETS A TRANSCODE OF ITS OWN, BESIDE THE LADDER.
 *
 * A watch party's audience is seatless: they never join the LiveKit room, so a
 * camera published into it reaches the seated participants over WebRTC and
 * reaches nobody on the playlist. And `TrackCompositeEgressRequest` carries one
 * video and one audio track, singular fields, so the running transcode cannot
 * be asked to also carry a face. The design and its costs are documented in
 * `docs/WATCH_PARTY.md`, "The presenter's camera, floating over the film".
 *
 * What this file exists to pin is the half that would be SILENT if it broke:
 *
 *  - the session is never restarted for a camera (a new `startedAt` is a new
 *    playlist path and a new token, so every viewer rebuffers — turning a
 *    webcam on must not do that to five hundred people);
 *  - `reapForeignEgresses` does not kill it every ten seconds, which is the
 *    same shape of failure this file's neighbours were bitten by twice;
 *  - it is NOT a ladder rung, so a viewer's ABR can never switch to it and
 *    watch a webcam instead of the film;
 *  - the camera dying does not take the film with it.
 */

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("../lib/log.js", () => ({ logEvent }));

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const SERVER = "00000000-0000-4000-8000-0000000000ee";
const OTHER_CHANNEL = "00000000-0000-4000-8000-0000000000bb";

/**
 * Channels the box-budget ghost filter (`activeBoxEgressCount`, PR #526)
 * should treat as having a live `hls_sessions` row. This suite's channel is
 * always live unless a test deliberately narrows the list, mirroring
 * `hls-egress.test.ts`'s own mock: without it, every fresh egress this file
 * starts would be misread as a "no live session" ghost and never counted,
 * which would make the box-budget tests below lie.
 */
const liveSessionChannelIds = vi.hoisted(() => ({
  ids: null as string[] | null, // null = "every channel is live"
}));
const query = vi.hoisted(() =>
  vi.fn(async (sql: string) => {
    if (typeof sql === "string" && sql.includes("live_hls_enabled")) {
      return { rowCount: 1, rows: [{ live_hls_enabled: null }] };
    }
    if (
      typeof sql === "string" &&
      sql.includes("hls_sessions") &&
      sql.includes("DISTINCT")
    ) {
      const ids = liveSessionChannelIds.ids ?? [CHANNEL, OTHER_CHANNEL];
      return { rowCount: ids.length, rows: ids.map((channel_id) => ({ channel_id })) };
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
  process.env.LIVE_HLS_LADDER = "720p30";
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
    "LIVE_HLS_LADDER",
    "LIVE_HLS_CAMERA",
    "LIVE_HLS_VOICE_TRACK",
    "LIVE_HLS_REAP_ORPHANS",
    "LIVE_HLS_MIC_ARCHIVE",
    "VOICE_PROMOTION_MAX_SFU_MBPS",
    "LIVE_HLS_SIGNED_URLS",
    "LIVE_HLS_PUBLIC_BASE_URL",
    "LIVE_HLS_PLAYLIST_BASE_URL",
  ]) {
    delete process.env[name];
  }
}

/** A LiveKit whose egresses stay ACTIVE until the test kills one. */
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
  // The voice archive's Track Egress: listed by LiveKit like any other.
  const startTrack = vi.fn<NonNullable<LiveHlsEgressApi["startTrackEgress"]>>(
    async () => {
      const egressId = `EG_${(n += 1)}`;
      statuses.set(egressId, EgressStatus.EGRESS_ACTIVE);
      return { egressId };
    },
  );
  const list = vi.fn(
    async (opts: { egressId?: string; roomName?: string; active?: boolean }) =>
      [...statuses.entries()]
        .filter(([id]) => !opts.egressId || id === opts.egressId)
        .map(([egressId, status]) => ({
          egressId,
          status,
          roomName: CHANNEL,
        })),
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
    list,
    kill(egressId: string) {
      statuses.set(egressId, EgressStatus.EGRESS_FAILED);
    },
  };
}

/** What the SFU reports for the presenter, camera optional. */
let cameraTrackId: string | null = null;
/** The sharer's ordinary microphone, optional (`LIVE_HLS_VOICE_TRACK`). */
let voiceTrackId: string | null = null;
/** The voice archive's publication, optional (`LIVE_HLS_MIC_ARCHIVE`). */
let micArchiveTrackId: string | null = null;

function install(lk: ReturnType<typeof fakeLiveKit>) {
  setLiveHlsTestHooks({
    egress: lk.api,
    findTracks: async () => ({
      videoTrackId: "TR_SCREEN",
      ...(cameraTrackId ? { cameraTrackId } : {}),
      ...(voiceTrackId ? { voiceTrackId } : {}),
      ...(micArchiveTrackId ? { micArchiveTrackId } : {}),
    }),
  });
}

/** Every `startTrackCompositeEgress` call's options, in order. */
function startedWith(lk: ReturnType<typeof fakeLiveKit>) {
  return lk.start.mock.calls.map((call) => call[2]);
}

/** The playlist names each start asked for, in order. */
function playlistNames(lk: ReturnType<typeof fakeLiveKit>) {
  return lk.start.mock.calls.map(
    (call) => (call[1] as { livePlaylistName: string }).livePlaylistName,
  );
}

/**
 * Drain pending microtasks.
 *
 * `startRoom` no longer awaits the camera before returning the film's own
 * stream (a camera-specific hang must never delay or abort the primary
 * result — see `voice.hlsCameraReconcileFailed` and the comment on
 * `reconcileCameraEgress`'s call site), so a brand-new room whose presenter
 * already has a camera on settles it a few microtask ticks AFTER
 * `reconcileLiveHls` resolves, not within the same tick. This is that wait,
 * for the tests that care what the camera ends up doing rather than only
 * what the film's own return value said at the instant it resolved.
 */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  resetLiveHlsForTests();
  disableHls();
  cameraTrackId = null;
  voiceTrackId = null;
  micArchiveTrackId = null;
  liveSessionChannelIds.ids = null;
  logEvent.mockClear();
  query.mockClear();
});

afterEach(() => {
  resetLiveHlsForTests();
  disableHls();
});

describe("the presenter's camera, beside the ladder", () => {
  it("starts a video-only 360p transcode under the same session prefix", async () => {
    enableHls();
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    install(lk);

    const started = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    // The camera is deliberately NOT part of this return value: `startRoom`
    // hands the film back the moment it is ready rather than waiting on a
    // camera-specific LiveKit RPC, box-budget probe and session-row write
    // that could hang. It settles a few microtask ticks later.
    await flush();
    const stream = liveHlsStreamFor(CHANNEL);

    expect(stream?.startedAt).toBe(started?.startedAt);
    expect(stream?.cameraHlsUrl).toBe(
      `/api/voice/hls-playlist/${CHANNEL}/${stream?.startedAt}/${CAMERA_RUNG_NAME}`,
    );
    // The ladder rung, then the camera. Two egresses, one session.
    expect(lk.start).toHaveBeenCalledTimes(2);
    expect(startedWith(lk)[1]).toEqual(
      expect.objectContaining({
        videoTrackId: "TR_CAM",
        encodingOptions: expect.objectContaining({
          width: 640,
          height: 360,
          framerate: 30,
          videoBitrate: 400,
        }),
      }),
    );
    // NO AUDIO TRACK AT ALL. The audience's sound comes off the main stream,
    // which is the only place it is mixed; a second audio channel two seconds
    // out of step with the first is worse than silence.
    expect(startedWith(lk)[1]!.audioTrackId).toBeUndefined();
    // Its own playlist objects, under this session's prefix, so retention and
    // the superseded-session sweep already cover it.
    expect(playlistNames(lk)[1]).toBe(
      `${stream!.startedAt}-${CAMERA_RUNG_NAME}.m3u8`,
    );
    expect(liveHlsActivity().cameraSessions).toBe(1);
  });

  it("does not edge-prefix the channel-wide camera URL either, when LIVE_HLS_PLAYLIST_BASE_URL is set", async () => {
    // Same reasoning as `hls-egress.test.ts`'s equivalent case: the edge host
    // is applied per recipient in `stampViewerStream`, after the token, never
    // here. See that file's test for the bug this pins.
    enableHls();
    process.env.LIVE_HLS_PLAYLIST_BASE_URL = "https://hls.pqp.gg";
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    install(lk);

    const started = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    const stream = liveHlsStreamFor(CHANNEL);

    expect(stream?.hlsUrl).toBe(
      `/api/voice/hls-playlist/${CHANNEL}/${started?.startedAt}`,
    );
    expect(stream?.cameraHlsUrl).toBe(
      `/api/voice/hls-playlist/${CHANNEL}/${stream?.startedAt}/${CAMERA_RUNG_NAME}`,
    );
  });

  it("reopens its own session row when the host turns the webcam back on", async () => {
    // THE ONE THAT WOULD HAVE 404ed FOR A WHOLE PARTY. The camera is the only
    // rendition that starts and stops INSIDE a session — that is the design,
    // because a new `startedAt` rebuffers the audience — so the second time it
    // starts it lands on the very `object_prefix` it already stamped
    // `ended_at`. `renderSignedPlaylist` refuses an ended session by design,
    // so with the ladder's `DO NOTHING` the second camera would transcode
    // perfectly and serve nobody, for as long as the party ran.
    enableHls();
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    install(lk);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    cameraTrackId = null;
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    cameraTrackId = "TR_CAM";
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    // The camera is the NEXT LINK of this channel's own reconcile queue, not
    // part of the return value above: it settles a few microtask ticks later.
    // See `flush`.
    await flush();

    const inserts = query.mock.calls
      .map((call) => String(call[0]))
      .filter((sql) => sql.includes("INSERT INTO hls_sessions"));
    const camera = inserts.filter((sql) => sql.includes("DO UPDATE"));
    const rungs = inserts.filter((sql) => sql.includes("DO NOTHING"));
    // Both camera starts reopen; the ladder rung never does, because a rung
    // that restarts always mints a new `startedAt` and `DO NOTHING` there is
    // pure idempotency.
    expect(camera).toHaveLength(2);
    expect(camera[0]).toContain("ended_at = NULL");
    expect(camera[0]).toContain("cleaned_at = NULL");
    expect(rungs).toHaveLength(1);
  });

  it("is never a ladder rung, so nobody's player can switch to a webcam", () => {
    // `sessionRungs` builds the master playlist's variants by looking each
    // stored rung up in this table. A camera in it is a variant a viewer's ABR
    // could climb down onto, and they would get a face instead of the film.
    expect(LADDER_RUNGS[CAMERA_RUNG_NAME]).toBeUndefined();
  });

  it("appears and disappears without ever restarting the session", async () => {
    enableHls();
    const lk = fakeLiveKit();
    install(lk);

    const before = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    expect(before?.cameraHlsUrl).toBeUndefined();
    expect(lk.start).toHaveBeenCalledTimes(1);

    // The host turns their webcam on mid-film. This is the whole promise: a
    // new `startedAt` is a new playlist path, a new viewer token and a new
    // master, so every viewer re-attaches and rebuffers.
    cameraTrackId = "TR_CAM";
    const on = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    // The camera is the NEXT LINK of this channel's own reconcile queue, not
    // part of the return value above: it settles a few microtask ticks
    // later. See `flush`.
    await flush();
    const onStream = liveHlsStreamFor(CHANNEL);
    expect(on?.startedAt).toBe(before!.startedAt);
    expect(on?.hlsUrl).toBe(before!.hlsUrl);
    expect(onStream?.cameraHlsUrl).toContain(CAMERA_RUNG_NAME);
    expect(lk.stop).not.toHaveBeenCalled();

    // And off again.
    cameraTrackId = null;
    const off = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    const offStream = liveHlsStreamFor(CHANNEL);
    expect(off?.startedAt).toBe(before!.startedAt);
    expect(off?.hlsUrl).toBe(before!.hlsUrl);
    expect(offStream?.cameraHlsUrl).toBeUndefined();
    expect(lk.stop).toHaveBeenCalledTimes(1);
    expect(lk.stop).toHaveBeenCalledWith("EG_2");
    expect(liveHlsActivity().cameraSessions).toBe(0);
  });

  it("rebinds to a republished camera and leaves the film alone", async () => {
    enableHls();
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM_1";
    install(lk);
    const first = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    // A device switch mints a new sid. A Track Composite egress is bound to
    // one sid and goes on running against a dead one, writing nothing.
    cameraTrackId = "TR_CAM_2";
    const after = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    // The camera is the NEXT LINK of this channel's own reconcile queue, not
    // part of the return value above: it settles a few microtask ticks
    // later. See `flush`.
    await flush();

    expect(after?.startedAt).toBe(first!.startedAt);
    expect(lk.stop).toHaveBeenCalledWith("EG_2");
    expect(lk.stop).not.toHaveBeenCalledWith("EG_1");
    expect(startedWith(lk)[2]).toEqual(
      expect.objectContaining({ videoTrackId: "TR_CAM_2" }),
    );
  });

  it("does not tear the camera down when the SFU could not be asked", async () => {
    enableHls();
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    install(lk);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

    // "Could not tell right now" is not "no camera". A momentary LiveKit
    // hiccup must not stop a running transcode and start another next push.
    setLiveHlsTestHooks({ egress: lk.api, findTracks: async () => null });
    const after = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

    expect(after?.cameraHlsUrl).toContain(CAMERA_RUNG_NAME);
    expect(lk.stop).not.toHaveBeenCalled();
  });

  /**
   * THE RACE THIS FILE'S OWN QUEUE EXISTS TO CLOSE. A previous revision ran
   * the camera step as a free-floating promise off `startRoom`'s return, so a
   * roster event landing while a brand-new room's camera start was still
   * awaiting LiveKit or its session-row write could reach `reconcileCameraEgress`
   * a second time for the same channel before the first call had finished —
   * two `startTrackCompositeEgress` calls, two egresses, one presenter.
   *
   * In this single-threaded design "overlapping" is two `reconcileLiveHls`
   * calls issued back to back, with no await between them — exactly what two
   * roster events landing on the same tick look like. `reconcileLiveHls`
   * itself is synchronous up to its first await, so both calls read and
   * update `reconcileQueue` before either's own reconcile logic has run,
   * which is what proves the chaining rather than the timing is what
   * serialises them.
   */
  it("starts exactly one camera egress when reconciles overlap", async () => {
    enableHls();
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    install(lk);

    const [first, second] = await Promise.all([
      reconcileLiveHls(CHANNEL, "peer-1", SERVER),
      reconcileLiveHls(CHANNEL, "peer-1", SERVER),
    ]);
    // The camera is the NEXT LINK of this channel's own reconcile queue, not
    // part of either return value above: it settles a few microtask ticks
    // later. See `flush`.
    await flush();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const cameraStarts = startedWith(lk).filter(
      (opts) => opts?.videoTrackId === "TR_CAM",
    );
    expect(cameraStarts).toHaveLength(1);
    expect(liveHlsActivity().cameraSessions).toBe(1);
  });

  /**
   * ITEM (b)/(c) FROM THE SAME REVIEW. The per-channel queue is what stops
   * another RECONCILE from running `reconcileCameraEgress` concurrently, but
   * the operator's rollback switch is read fresh on every check, not just
   * once when this call started. Flipping it off while THIS call's own
   * session-row write is still in flight must not let the write's success
   * resurrect a camera nobody wants any more — `cameraStillWanted`'s
   * post-write check is exactly what refuses that.
   */
  it("ends with no camera when it is disabled mid-write", async () => {
    enableHls();
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    install(lk);

    let releaseWrite: (() => void) | undefined;
    // The shared `query` mock is typed for the happy path; this test needs
    // to intercept one statement, so widen it locally.
    type LooseQuery = {
      getMockImplementation(): ((...args: unknown[]) => Promise<unknown>) | undefined;
      mockImplementation(fn: (...args: unknown[]) => Promise<unknown>): unknown;
    };
    const looseQuery = query as unknown as LooseQuery;
    const original = looseQuery.getMockImplementation();
    looseQuery.mockImplementation(async (sql: unknown, ...rest: unknown[]) => {
      if (typeof sql === "string" && sql.includes("DO UPDATE")) {
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
      }
      return original!(sql, ...rest);
    });

    try {
      const reconcile = reconcileLiveHls(CHANNEL, "peer-1", SERVER);
      await vi.waitFor(() => {
        expect(releaseWrite).toBeDefined();
      });
      // The operator disables the rollback switch while the camera's own
      // session row is mid-write.
      process.env.LIVE_HLS_CAMERA = "false";
      releaseWrite!();
      await reconcile;
      await flush();
    } finally {
      // Restore the shared mock for every test that runs after this one.
      looseQuery.mockImplementation(original!);
    }

    const stream = liveHlsStreamFor(CHANNEL);
    expect(stream?.cameraHlsUrl).toBeUndefined();
    // The egress LiveKit already reported started is stopped rather than
    // left running with no row and no advertisement — an orphan.
    expect(lk.stop).toHaveBeenCalledWith("EG_2");
    expect(liveHlsActivity().cameraSessions).toBe(0);
  });

  /**
   * A device switch during a *film* restart replaces the whole `RoomHls`
   * object (a new `startedAt`), so a camera start still chasing the OLD
   * room's identity must back off rather than hand the old presenter's
   * camera to the new session — `cameraStillWanted`'s room-identity check,
   * exercised end to end rather than by calling it directly.
   */
  it("ends with the new presenter's camera only when the presenter changes during start", async () => {
    enableHls();
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM_1";
    install(lk);

    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    expect(liveHlsStreamFor(CHANNEL)?.cameraHlsUrl).toContain(
      CAMERA_RUNG_NAME,
    );

    // The presenter changes cameras, and a second reconcile lands before the
    // first has had a chance to run — the same back-to-back shape as the
    // overlap test above, just with a track change in the middle.
    cameraTrackId = "TR_CAM_2";
    const after = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    expect(after?.startedAt).toBeDefined();
    const stream = liveHlsStreamFor(CHANNEL);
    expect(stream?.cameraHlsUrl).toContain(CAMERA_RUNG_NAME);
    // Exactly one camera egress running at the end, bound to the new track —
    // the old one stopped, never resurrected.
    expect(lk.stop).toHaveBeenCalledWith("EG_2");
    expect(lk.stop).not.toHaveBeenCalledWith("EG_1");
    expect(startedWith(lk).at(-1)).toEqual(
      expect.objectContaining({ videoTrackId: "TR_CAM_2" }),
    );
    expect(liveHlsActivity().cameraSessions).toBe(1);
  });

  it("stops with the session when the share ends", async () => {
    enableHls();
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    install(lk);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

    expect(await reconcileLiveHls(CHANNEL, null, SERVER)).toBeNull();

    // Both, and the camera's row was ended with the session's. An egress
    // whose row says ended and which is still transcoding is the orphan shape
    // this file's neighbours keep paying for.
    expect(lk.stop.mock.calls.map((call) => call[0]).sort()).toEqual([
      "EG_1",
      "EG_2",
    ]);
    expect(liveHlsActivity().cameraSessions).toBe(0);
  });

  it("never starts one with LIVE_HLS_CAMERA=false", async () => {
    enableHls();
    process.env.LIVE_HLS_CAMERA = "false";
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    install(lk);

    const stream = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

    expect(lk.start).toHaveBeenCalledTimes(1);
    expect(stream?.cameraHlsUrl).toBeUndefined();
    // The film is untouched: the rollback switch takes a face away, never a
    // rendition.
    expect(stream?.hlsUrl).toContain("/api/voice/hls-playlist/");
  });

  it("still advertises a camera URL when LIVE_HLS_SIGNED_URLS=false", async () => {
    // Unsigned is a supported configuration, not a degraded one: it must not
    // lose the camera on top of losing signing. Same raw-bucket-URL split
    // `viewerPlaylistUrl` already gives the film.
    enableHls();
    process.env.LIVE_HLS_SIGNED_URLS = "false";
    process.env.LIVE_HLS_PUBLIC_BASE_URL = "https://bucket.example.test";
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    install(lk);

    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    const stream = liveHlsStreamFor(CHANNEL);

    expect(stream?.cameraHlsUrl).toBeDefined();
    expect(stream?.cameraHlsUrl).toContain("https://bucket.example.test");
    expect(stream?.cameraHlsUrl).toContain(CAMERA_RUNG_NAME);
  });

  it("refuses the camera rather than the film when the box is full", async () => {
    enableHls();
    // Priced against the WHOLE box. Zero budget is the honest extreme: the
    // ladder's floor rung still starts (`decideLadder`'s first rule) and the
    // camera does not.
    process.env.VOICE_PROMOTION_MAX_SFU_MBPS = "0";
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    install(lk);

    const stream = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    expect(stream).not.toBeNull();
    expect(stream?.cameraHlsUrl).toBeUndefined();
    expect(lk.start).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsCameraRefused",
      expect.objectContaining({ refusal: "box-budget" }),
    );

    // ONCE, NOT ONCE PER ROSTER EVENT. `pushLiveHls` runs whenever anybody
    // joins or leaves, so a full box with a camera published would re-price
    // and re-log the same refusal for the whole party.
    logEvent.mockClear();
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    expect(logEvent).not.toHaveBeenCalledWith(
      "voice.hlsCameraRefused",
      expect.anything(),
    );
  });
});

describe("the camera and the machinery that stops things", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T20:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    for (let tick = 0; tick < 20; tick += 1) {
      await Promise.resolve();
    }
  }

  /**
   * THE ONE THAT WOULD HAVE BEEN SILENT AND TOTAL.
   *
   * `reapForeignEgresses` stops every ACTIVE egress in a room this process is
   * presenting that is not one of its own rungs. A camera missing from that
   * set is killed on the first monitor tick and started again on the next
   * reconcile, forever, with `liveHls.orphansStopped` climbing and the party
   * looking completely healthy.
   */
  it("is not reaped as a leftover by its own monitor", async () => {
    enableHls();
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    install(lk);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    // The camera settles a few microtask ticks after the film's own return
    // value, on purpose: see `flush`.
    await advance(0);
    expect(lk.start).toHaveBeenCalledTimes(2);

    await advance(20_000);
    await checkLiveHlsHealth();

    expect(lk.stop).not.toHaveBeenCalled();
    expect(liveHlsActivity().orphansStopped).toBe(0);
    expect(liveHlsActivity().cameraSessions).toBe(1);
  });

  it("gives a camera started mid-party its OWN grace period", async () => {
    enableHls();
    const lk = fakeLiveKit();
    install(lk);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

    // Half an hour into the film, the host turns their webcam on. The room's
    // own grace expired long ago; this egress is brand new and its playlist
    // has not been sampled by anything yet.
    await advance(30 * 60_000);
    cameraTrackId = "TR_CAM";
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    // The camera is the NEXT LINK of this channel's own reconcile queue, not
    // part of the return value above: it settles a few microtask ticks
    // later. See `flush`.
    await advance(0);
    expect(liveHlsActivity().cameraSessions).toBe(1);

    await advance(5_000);
    await checkLiveHlsHealth();

    expect(liveHlsActivity().cameraSessions).toBe(1);
    expect(lk.stop).not.toHaveBeenCalled();
  });

  it("does not restart a camera that just died, until it has cooled off", async () => {
    // THE LOOP THIS STOPS. A dead camera is dropped, the room is told, the
    // reconcile finds the presenter's camera still published and starts
    // another. On a box that is struggling — which is exactly when an egress
    // dies — that is die, restart, die, forever, on the machine that was
    // already too busy.
    enableHls();
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    install(lk);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    // The camera settles a few microtask ticks after the film's own return
    // value, on purpose: see `flush`. Waiting for it here (rather than
    // killing an egress id that does not exist yet) is what makes the kill
    // below land on the camera this call actually started.
    await advance(0);
    expect(lk.start).toHaveBeenCalledTimes(2);

    lk.kill("EG_2");
    await advance(20_000);
    await checkLiveHlsHealth();
    expect(liveHlsActivity().cameraSessions).toBe(0);

    // The presenter's camera is still published, so without a cooldown this
    // is where the second one starts.
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    expect(lk.start).toHaveBeenCalledTimes(2);

    await advance(2 * 60_000 + 1_000);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    // The camera is the NEXT LINK of this channel's own reconcile queue, not
    // part of the return value above: it settles a few microtask ticks
    // later. See `flush`.
    await advance(0);
    expect(lk.start).toHaveBeenCalledTimes(3);
    expect(liveHlsActivity().cameraSessions).toBe(1);
  });

  it("writes every camera run under its own names, so turning it off and on twice keeps all three", async () => {
    // 2026-09-23 production rehearsal: off and on again, and the second egress
    // numbered its segments from _00000 and rebuilt the -index.m3u8 under the
    // same names, overwriting the first run.
    enableHls();
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    install(lk);
    const stream = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await advance(0);
    for (const track of [null, "TR_CAM_2", null, "TR_CAM_3"]) {
      await advance(30_000);
      cameraTrackId = track;
      await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
      await advance(0);
    }
    const startedAt = stream!.startedAt;
    const cameraOutputs = lk.start.mock.calls
      .map((call) => call[1] as { filenamePrefix: string; playlistName: string; livePlaylistName: string })
      .filter((output) => output.filenamePrefix.includes(CAMERA_RUNG_NAME));
    expect(cameraOutputs).toHaveLength(3);
    const prefixes = cameraOutputs.map((output) => output.filenamePrefix);
    const indexes = cameraOutputs.map((output) => output.playlistName);
    expect(new Set(prefixes).size).toBe(3);
    expect(new Set(indexes).size).toBe(3);
    // The first run keeps the names the camera always had.
    expect(prefixes[0]).toBe(`live/${CHANNEL}/${startedAt}-${CAMERA_RUNG_NAME}`);
    expect(indexes[0]).toBe(`${startedAt}-${CAMERA_RUNG_NAME}-index.m3u8`);
    // Later runs sit UNDER the row's prefix (retention and keep_replay reach
    // them) with their own start time after it.
    for (const [i, prefix] of prefixes.slice(1).entries()) {
      expect(prefix).toMatch(
        new RegExp(`^live/${CHANNEL}/${startedAt}-${CAMERA_RUNG_NAME}-r\\d+$`),
      );
      expect(indexes[i + 1]).toBe(`${prefix.split("/").pop()}-index.m3u8`);
    }
    // One live playlist for every run: viewers follow one URL.
    expect(new Set(cameraOutputs.map((output) => output.livePlaylistName))).toEqual(
      new Set([`${startedAt}-${CAMERA_RUNG_NAME}.m3u8`]),
    );
  });

  it("retries a refused camera on its own when the cooldown runs out", async () => {
    // A presenter alone on stage makes no roster events, so a camera refused
    // for the box budget used to stay unrecorded for the rest of the show.
    enableHls();
    process.env.VOICE_PROMOTION_MAX_SFU_MBPS = "0";
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    install(lk);
    const heard: string[] = [];
    setLiveHlsChangeListener((channelId, reason) => {
      heard.push(reason);
      void reconcileLiveHls(channelId, "peer-1", SERVER);
    });
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await advance(0);
    expect(liveHlsActivity().cameraSessions).toBe(0);

    // The box frees up; nothing else happens in the room.
    delete process.env.VOICE_PROMOTION_MAX_SFU_MBPS;
    await advance(2 * 60_000 + 1_000);
    await advance(0);

    expect(heard).toContain("camera-cooldown-over");
    expect(liveHlsActivity().cameraSessions).toBe(1);
  });

  it("retries a dead camera on its own when the cooldown runs out", async () => {
    enableHls();
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    install(lk);
    const heard: string[] = [];
    setLiveHlsChangeListener((channelId, reason) => {
      heard.push(reason);
      void reconcileLiveHls(channelId, "peer-1", SERVER);
    });
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await advance(0);
    lk.kill("EG_2");
    await advance(20_000);
    await checkLiveHlsHealth();
    expect(liveHlsActivity().cameraSessions).toBe(0);
    const startsBefore = lk.start.mock.calls.length;

    await advance(2 * 60_000 + 1_000);
    await advance(0);

    expect(heard).toContain("camera-cooldown-over");
    expect(lk.start.mock.calls.length).toBe(startsBefore + 1);
    expect(liveHlsActivity().cameraSessions).toBe(1);
  });

  it("lets the host bring it straight back by closing the camera first", async () => {
    // Turning it off and on again is the first thing anybody does when
    // something looks broken. Holding them out for two minutes after they did
    // exactly the right thing would read as the feature being dead.
    enableHls();
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    install(lk);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    // The camera settles a few microtask ticks after the film's own return
    // value, on purpose: see `flush`. Waiting for it here (rather than
    // killing an egress id that does not exist yet) is what makes the kill
    // below land on the camera this call actually started.
    await advance(0);
    lk.kill("EG_2");
    await advance(20_000);
    await checkLiveHlsHealth();

    cameraTrackId = null;
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    cameraTrackId = "TR_CAM";
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    // The camera is the NEXT LINK of this channel's own reconcile queue, not
    // part of the return value above: it settles a few microtask ticks
    // later. See `flush`.
    await advance(0);

    expect(liveHlsActivity().cameraSessions).toBe(1);
  });

  it("drops a dead camera without taking the film with it", async () => {
    enableHls();
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    install(lk);
    const before = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    // The camera settles a few microtask ticks after the film's own return
    // value, on purpose: see `flush`. Waiting for it here (rather than
    // killing an egress id that does not exist yet) is what makes the kill
    // below land on the camera this call actually started.
    await advance(0);

    lk.kill("EG_2");
    await advance(20_000);
    // No channel restarted: the primary rung is untouched, so the film plays
    // on and only the PiP goes away.
    expect(await checkLiveHlsHealth()).toEqual([]);

    const after = liveHlsStreamFor(CHANNEL);
    expect(after?.startedAt).toBe(before!.startedAt);
    expect(after?.hlsUrl).toBe(before!.hlsUrl);
    expect(after?.cameraHlsUrl).toBeUndefined();
    expect(liveHlsActivity().cameraSessions).toBe(0);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsCameraDied",
      expect.objectContaining({ egressId: "EG_2" }),
    );
  });

  /**
   * THE PRESENTER WHOSE PUSH LANDS ON A HICCUP. A probe that could not ask
   * LiveKit at all is deliberately a silent no-op (a momentary
   * `listParticipants` failure must not tear a running transcode down), but
   * `pushLiveHls` otherwise only fires on a roster event or `set-camera` --
   * without a retry, a presenter unlucky enough to turn their camera on into
   * exactly that hiccup would get no camera until an unrelated event happened
   * to try again.
   */
  it("retries once on its own after a probe that could not ask", async () => {
    enableHls();
    const lk = fakeLiveKit();
    install(lk);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    expect(liveHlsActivity().cameraSessions).toBe(0);

    // The same wiring `ws/voice.ts` registers: a change fires another
    // reconcile for the same presenter.
    setLiveHlsChangeListener((channelId, _reason) => {
      void reconcileLiveHls(channelId, "peer-1", SERVER);
    });

    // The host turns their webcam on, and LiveKit cannot be asked at all on
    // this exact push.
    cameraTrackId = "TR_CAM";
    setLiveHlsTestHooks({ egress: lk.api, findTracks: async () => null });
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    expect(liveHlsActivity().cameraSessions).toBe(0);
    expect(lk.start).toHaveBeenCalledTimes(1); // only the film's own rung

    // LiveKit recovers before the retry fires, on its own, with no further
    // roster event or `set-camera` frame.
    install(lk);
    await advance(3_100);

    expect(liveHlsActivity().cameraSessions).toBe(1);
  });

  it("never stacks a second retry while one is already pending", async () => {
    enableHls();
    const lk = fakeLiveKit();
    install(lk);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

    let reconciles = 0;
    setLiveHlsChangeListener((channelId) => {
      reconciles += 1;
      void reconcileLiveHls(channelId, "peer-1", SERVER);
    });

    cameraTrackId = "TR_CAM";
    setLiveHlsTestHooks({ egress: lk.api, findTracks: async () => null });
    // Two pushes while LiveKit is unreachable, same as two roster events
    // arriving before the hiccup clears.
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

    install(lk);
    await advance(3_100);

    // One retry fired, not two: `cameraProbeRetryTimers` refused the second.
    expect(reconciles).toBe(1);
    expect(liveHlsActivity().cameraSessions).toBe(1);
  });
});

describe("adopting a camera across a deploy", () => {
  it("lands on the session it was filming, not on the ladder", () => {
    enableHls();
    const startedAt = 1_757_000_000_000;
    adoptLiveHlsSession({
      channelId: CHANNEL,
      egressId: "EG_1",
      startedAt,
      presenterPeerId: "peer-1",
      videoTrackId: "TR_SCREEN",
      rung: "720p30",
    });
    const adopted = adoptLiveHlsSession({
      channelId: CHANNEL,
      egressId: "EG_2",
      startedAt,
      presenterPeerId: "peer-1",
      videoTrackId: "TR_CAM",
      rung: CAMERA_RUNG_NAME,
    });

    expect(adopted?.cameraHlsUrl).toContain(CAMERA_RUNG_NAME);
    // And not as a rung: adopting it as one would put a 400 kbit/s webcam on
    // the master playlist as a 720p30 variant for the whole party.
    expect(liveHlsActivity()).toMatchObject({ rungs: 1, cameraSessions: 1 });
  });

  it("refuses a camera whose session did not come back", () => {
    enableHls();
    // A transcode with no room is a core of the media box spent on a webcam
    // nobody can reach. Null tells `reconcileStaleHlsSessions` to stop it.
    expect(
      adoptLiveHlsSession({
        channelId: OTHER_CHANNEL,
        egressId: "EG_9",
        startedAt: 1_757_000_000_000,
        presenterPeerId: "peer-1",
        videoTrackId: "TR_CAM",
        rung: CAMERA_RUNG_NAME,
      }),
    ).toBeNull();
    expect(liveHlsActivity().cameraSessions).toBe(0);
  });

  /**
   * BEFORE `audio_track_id` EXISTED, an adopted voice-only egress had
   * nowhere to keep its mic sid but `video_track_id`, so it came back
   * mislabelled as a silent camera row and cost one extra restart on the
   * very next reconcile tick to self-correct. This is what that fix buys:
   * the exact shape, restored, not guessed.
   */
  it("restores a camera+voice egress with both track ids and the right flags", () => {
    enableHls();
    process.env.LIVE_HLS_VOICE_TRACK = "true";
    const startedAt = 1_757_000_000_000;
    adoptLiveHlsSession({
      channelId: CHANNEL,
      egressId: "EG_1",
      startedAt,
      presenterPeerId: "peer-1",
      videoTrackId: "TR_SCREEN",
      rung: "720p30",
    });
    const adopted = adoptLiveHlsSession({
      channelId: CHANNEL,
      egressId: "EG_2",
      startedAt,
      presenterPeerId: "peer-1",
      videoTrackId: "TR_CAM",
      audioTrackId: "TR_MIC",
      rung: CAMERA_RUNG_NAME,
    });

    expect(adopted?.cameraHasVideo).toBe(true);
    expect(adopted?.cameraHasVoiceAudio).toBe(true);
  });

  it("restores a voice-only egress as audio-only, not as a silent camera", () => {
    enableHls();
    process.env.LIVE_HLS_VOICE_TRACK = "true";
    const startedAt = 1_757_000_000_000;
    adoptLiveHlsSession({
      channelId: CHANNEL,
      egressId: "EG_1",
      startedAt,
      presenterPeerId: "peer-1",
      videoTrackId: "TR_SCREEN",
      rung: "720p30",
    });
    const adopted = adoptLiveHlsSession({
      channelId: CHANNEL,
      egressId: "EG_2",
      startedAt,
      presenterPeerId: "peer-1",
      // No camera: the row's own `video_track_id` is empty for this shape.
      videoTrackId: "",
      audioTrackId: "TR_MIC",
      rung: CAMERA_RUNG_NAME,
    });

    expect(adopted?.cameraHlsUrl).toBeDefined();
    expect(adopted?.cameraHasVideo).toBe(false);
    expect(adopted?.cameraHasVoiceAudio).toBe(true);
  });

  it("refuses to adopt a voice-only row when LIVE_HLS_VOICE_TRACK is off, even with LIVE_HLS_CAMERA on", () => {
    enableHls();
    // The flag governing THIS row's shape, not the camera one — a voice-only
    // row must be judged against LIVE_HLS_VOICE_TRACK, never LIVE_HLS_CAMERA.
    const startedAt = 1_757_000_000_000;
    adoptLiveHlsSession({
      channelId: CHANNEL,
      egressId: "EG_1",
      startedAt,
      presenterPeerId: "peer-1",
      videoTrackId: "TR_SCREEN",
      rung: "720p30",
    });
    expect(
      adoptLiveHlsSession({
        channelId: CHANNEL,
        egressId: "EG_2",
        startedAt,
        presenterPeerId: "peer-1",
        videoTrackId: "",
        audioTrackId: "TR_MIC",
        rung: CAMERA_RUNG_NAME,
      }),
    ).toBeNull();
  });

  it("can adopt a voice-only row on a deployment with the camera flag off", () => {
    enableHls();
    process.env.LIVE_HLS_CAMERA = "false";
    process.env.LIVE_HLS_VOICE_TRACK = "true";
    const startedAt = 1_757_000_000_000;
    adoptLiveHlsSession({
      channelId: CHANNEL,
      egressId: "EG_1",
      startedAt,
      presenterPeerId: "peer-1",
      videoTrackId: "TR_SCREEN",
      rung: "720p30",
    });
    const adopted = adoptLiveHlsSession({
      channelId: CHANNEL,
      egressId: "EG_2",
      startedAt,
      presenterPeerId: "peer-1",
      videoTrackId: "",
      audioTrackId: "TR_MIC",
      rung: CAMERA_RUNG_NAME,
    });

    expect(adopted?.cameraHasVideo).toBe(false);
    expect(adopted?.cameraHasVoiceAudio).toBe(true);
  });
});

describe("pickScreenTracks and the camera", () => {
  it("takes the sharer's own camera in the same pass", () => {
    // One `listParticipants`, not two. The reconcile runs on every roster
    // event, and a second RPC there to learn something the first answer
    // already carried is a cost nobody would notice until a large party.
    expect(
      pickScreenTracks(
        [
          {
            identity: "peer-1",
            tracks: [
              { source: TrackSource.SCREEN_SHARE, sid: "TR_SCREEN" },
              { source: TrackSource.SCREEN_SHARE_AUDIO, sid: "TR_AUDIO" },
              { source: TrackSource.CAMERA, sid: "TR_CAM" },
            ],
          },
        ],
        "peer-1",
      ),
    ).toEqual({
      videoTrackId: "TR_SCREEN",
      audioTrackId: "TR_AUDIO",
      cameraTrackId: "TR_CAM",
    });
  });

  it("never takes somebody else's camera", () => {
    // A second person's webcam is a second transcode, which is the capacity
    // conversation this feature defers. The picker is already per participant
    // for the audio; this keeps the camera on the same rule.
    expect(
      pickScreenTracks(
        [
          { identity: "peer-2", tracks: [{ source: TrackSource.CAMERA, sid: "TR_THEIRS" }] },
          {
            identity: "peer-1",
            tracks: [{ source: TrackSource.SCREEN_SHARE, sid: "TR_SCREEN" }],
          },
        ],
        "peer-1",
      ),
    ).toEqual({ videoTrackId: "TR_SCREEN", audioTrackId: undefined });
  });
});

describe("box budget: a camera must never be priced twice", () => {
  it("does not charge an existing camera as a full ladder rung on top of its own weight", async () => {
    // LiveKit's `ListEgress` carries no rung name, only an id, a room and a
    // status, so the box-wide count (`activeBoxEgressCount`, PR #526) cannot
    // itself tell a camera egress from a ladder rendition: every active
    // egress on the box is one `HLS_RUNG_MBPS`. Both `decideLadder` and
    // `decideCameraEgress` ALSO add every running camera's real, smaller
    // weight separately (`runningCameraMbps`). Feeding either of them the raw
    // box count therefore double-charges every camera already running: once
    // as a full rendition, once again as a camera.
    enableHls();
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    install(lk);

    // CHANNEL: one ladder rung plus one camera, under whatever the default
    // budget is. Two active egresses, ONE real ladder rendition. The camera
    // settles a few microtask ticks after the film's own return value, on
    // purpose: see `flush`.
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    expect(liveHlsActivity()).toMatchObject({ rungs: 1, cameraSessions: 1 });

    // The budget a SECOND party's camera is decided against: enough for both
    // channels' one real rendition each plus both cameras' real (30%)
    // weight, but not enough if CHANNEL's already-running camera were ALSO
    // charged as a third full rendition on top of that.
    const correctBoxMbps = 2 * HLS_RUNG_MBPS + 2 * HLS_CAMERA_MBPS;
    const doubleCountedBoxMbps = 3 * HLS_RUNG_MBPS + 2 * HLS_CAMERA_MBPS;
    process.env.VOICE_PROMOTION_MAX_SFU_MBPS = String(
      Math.round((correctBoxMbps + doubleCountedBoxMbps) / 2),
    );

    // A second party, a second camera. Refused here would mean CHANNEL's
    // camera got charged twice.
    await reconcileLiveHls(OTHER_CHANNEL, "peer-2", SERVER);
    await flush();
    const stream = liveHlsStreamFor(OTHER_CHANNEL);

    expect(stream?.cameraHlsUrl).toContain(CAMERA_RUNG_NAME);
    expect(liveHlsActivity().cameraSessions).toBe(2);
    expect(logEvent).not.toHaveBeenCalledWith(
      "voice.hlsCameraRefused",
      expect.anything(),
    );
  });
});

describe("box budget: a camera is not priced against the egress it replaces", () => {
  it("starts the replacement even while LiveKit still lists the old camera as active", async () => {
    // 2026-09-23 20:13Z production rehearsal: a camera replaced 6 s after it
    // started, LiveKit's stop timed out, the old egress was still ACTIVE and
    // was priced as a full rung, and the replacement was refused at 651/600.
    enableHls();
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    install(lk);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    expect(liveHlsActivity().cameraSessions).toBe(1);
    // Room for the rung and one camera, not for the stuck one as a rung too.
    const fits = HLS_RUNG_MBPS + HLS_CAMERA_MBPS;
    const stuckAsRung = 2 * HLS_RUNG_MBPS + HLS_CAMERA_MBPS;
    process.env.VOICE_PROMOTION_MAX_SFU_MBPS = String(Math.round((fits + stuckAsRung) / 2));
    // The stop never lands: the old egress stays ACTIVE in the listing.
    lk.stop.mockImplementation(async () => {
      throw new Error("The operation was aborted due to timeout");
    });

    cameraTrackId = "TR_CAM_2";
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    expect(logEvent).not.toHaveBeenCalledWith(
      "voice.hlsCameraRefused",
      expect.anything(),
    );
    expect(liveHlsActivity().cameraSessions).toBe(1);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsCameraStopped",
      expect.objectContaining({ fromVideo: "TR_CAM", toVideo: "TR_CAM_2" }),
    );
  });
});

describe("box budget: the voice archive is not a video rendition", () => {
  it("starts the camera beside a ladder rung and a running -mic.ogg archive", async () => {
    // The 2026-09-23 production rehearsal: two rungs plus the archive plus
    // the camera priced at 629 against 600, with nothing else on the box,
    // because the archive's Track Egress was counted as a third 150 Mbit/s
    // rendition. Here: one rung and the archive, and a budget with room for
    // the rung and the camera but not for a phantom second rung.
    enableHls();
    process.env.LIVE_HLS_MIC_ARCHIVE = "true";
    const lk = fakeLiveKit();
    micArchiveTrackId = "TR_MIC_ARCHIVE";
    install(lk);
    const correctBoxMbps = HLS_RUNG_MBPS + HLS_CAMERA_MBPS;
    const archiveAsRungMbps = 2 * HLS_RUNG_MBPS + HLS_CAMERA_MBPS;
    process.env.VOICE_PROMOTION_MAX_SFU_MBPS = String(
      Math.round((correctBoxMbps + archiveAsRungMbps) / 2),
    );

    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    expect(lk.startTrack).toHaveBeenCalledTimes(1);
    expect(liveHlsActivity()).toMatchObject({ rungs: 1, cameraSessions: 0 });

    // The presenter turns the webcam on.
    cameraTrackId = "TR_CAM";
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    expect(liveHlsActivity().cameraSessions).toBe(1);
    expect(logEvent).not.toHaveBeenCalledWith(
      "voice.hlsCameraRefused",
      expect.anything(),
    );
  });
});

/**
 * `LIVE_HLS_VOICE_TRACK`: THE PRESENTER'S VOICE, RIDING THE SAME SLOT.
 *
 * Dark by default — every case above this block already pins that a camera
 * with a mic beside it still starts video-only when the flag is off, because
 * `findTracks` fixtures across this whole file never set `voiceTrackId` unless
 * a test in THIS block does. What is pinned here is the flag's own half: the
 * mic gets attached to the camera when there is one, an audio-only rung
 * starts when there is not, and turning the flag off mid-party tears either
 * back down to the pre-2026-09-13 shape rather than leaving a stale audio
 * track on a dead egress.
 */
describe("LIVE_HLS_VOICE_TRACK: the presenter's voice on the camera/voice slot", () => {
  it("stays video-only, silent, exactly as before, while the flag is off", async () => {
    enableHls();
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    voiceTrackId = "TR_MIC";
    install(lk);

    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    const stream = liveHlsStreamFor(CHANNEL);

    expect(startedWith(lk)[1]).toEqual(
      expect.objectContaining({ videoTrackId: "TR_CAM" }),
    );
    expect(startedWith(lk)[1]!.audioTrackId).toBeUndefined();
    expect(stream?.cameraHasVoiceAudio).toBeFalsy();
  });

  it("attaches the sharer's ordinary microphone to the camera, once the flag is on", async () => {
    enableHls();
    process.env.LIVE_HLS_VOICE_TRACK = "true";
    setVoiceTrackSeparated(CHANNEL, "peer-1", true);
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    voiceTrackId = "TR_MIC";
    install(lk);

    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    const stream = liveHlsStreamFor(CHANNEL);

    expect(startedWith(lk)[1]).toEqual(
      expect.objectContaining({
        videoTrackId: "TR_CAM",
        audioTrackId: "TR_MIC",
        encodingOptions: expect.objectContaining({ audioBitrate: expect.any(Number) }),
      }),
    );
    expect(startedWith(lk)[1]!.encodingOptions!.audioBitrate).toBeGreaterThan(0);
    // SAME SLOT, SAME URL. A viewer already holding `cameraHlsUrl` must not
    // see it move just because the presenter's mic joined it.
    expect(stream?.cameraHlsUrl).toBe(
      `/api/voice/hls-playlist/${CHANNEL}/${stream?.startedAt}/${CAMERA_RUNG_NAME}`,
    );
    expect(stream?.cameraHasVideo).toBe(true);
    expect(stream?.cameraHasVoiceAudio).toBe(true);
    expect(liveHlsActivity().cameraSessions).toBe(1);
  });

  it("starts an audio-only rung when the presenter has no camera but shares their voice", async () => {
    enableHls();
    process.env.LIVE_HLS_VOICE_TRACK = "true";
    setVoiceTrackSeparated(CHANNEL, "peer-1", true);
    const lk = fakeLiveKit();
    voiceTrackId = "TR_MIC";
    install(lk);

    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    const stream = liveHlsStreamFor(CHANNEL);

    expect(lk.start).toHaveBeenCalledTimes(2);
    expect(startedWith(lk)[1]).toEqual(
      expect.objectContaining({ audioTrackId: "TR_MIC" }),
    );
    // NO VIDEO TRACK AT ALL: there is no camera to bind one to.
    expect(startedWith(lk)[1]!.videoTrackId).toBeUndefined();
    expect(stream?.cameraHlsUrl).toBeDefined();
    expect(stream?.cameraHasVideo).toBe(false);
    expect(stream?.cameraHasVoiceAudio).toBe(true);
  });

  it("costs the box the cheaper voice-only rate with no camera, not a camera's rate", async () => {
    enableHls();
    process.env.LIVE_HLS_VOICE_TRACK = "true";
    setVoiceTrackSeparated(CHANNEL, "peer-1", true);
    const lk = fakeLiveKit();
    voiceTrackId = "TR_MIC";
    install(lk);
    // Tight enough for the ladder rung plus a voice-only slot, not for a full
    // camera slot on top of it.
    process.env.VOICE_PROMOTION_MAX_SFU_MBPS = String(
      Math.round(HLS_RUNG_MBPS + HLS_VOICE_ONLY_MBPS * 2),
    );

    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    expect(liveHlsActivity().cameraSessions).toBe(1);
    expect(logEvent).not.toHaveBeenCalledWith(
      "voice.hlsCameraRefused",
      expect.anything(),
    );
  });

  it("does nothing when the flag is on but the presenter shares no microphone", async () => {
    enableHls();
    process.env.LIVE_HLS_VOICE_TRACK = "true";
    const lk = fakeLiveKit();
    install(lk);

    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    // No camera, no mic: nothing to run beside the ladder rung.
    expect(lk.start).toHaveBeenCalledTimes(1);
    expect(liveHlsStreamFor(CHANNEL)?.cameraHlsUrl).toBeUndefined();
  });

  /**
   * THE BUG A FAROL REVIEW CAUGHT: `wantedAudio` used to be derived from
   * `LIVE_HLS_VOICE_TRACK` and the track's mere presence alone. Since the
   * ordinary microphone publication (and, at the time, even the picker
   * itself) does not know or care which mode the host is actually in, every
   * flagged host with a mic got attached regardless of choosing "junto".
   * `presenterWantsSeparatedVoice` (`setVoiceTrackSeparated`, sent by
   * `set-voice-track-mode`) is the fix: the flag and the track existing are
   * necessary but not sufficient — the presenter's OWN declaration has to
   * agree too.
   */
  it("never attaches the mic on the flag and the track alone: the presenter's own declaration is required", async () => {
    enableHls();
    process.env.LIVE_HLS_VOICE_TRACK = "true";
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    voiceTrackId = "TR_MIC";
    install(lk);
    // Deliberately NOT calling setVoiceTrackSeparated: the flag is on and
    // the named track exists (as it would if a publish raced a mode flip
    // back to "junto"), but the presenter never said "separada".

    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    const stream = liveHlsStreamFor(CHANNEL);

    expect(startedWith(lk)[1]).toEqual(
      expect.objectContaining({ videoTrackId: "TR_CAM" }),
    );
    expect(startedWith(lk)[1]!.audioTrackId).toBeUndefined();
    expect(stream?.cameraHasVoiceAudio).toBeFalsy();
  });

  it("attaches the mic once the presenter's declaration arrives, without restarting for the track alone", async () => {
    enableHls();
    process.env.LIVE_HLS_VOICE_TRACK = "true";
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    voiceTrackId = "TR_MIC";
    install(lk);

    // First reconcile: the track exists, the declaration does not yet.
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    expect(startedWith(lk)[1]!.audioTrackId).toBeUndefined();
    const egressCallsBeforeDeclaration = lk.start.mock.calls.length;

    // The declaration arrives (the WS handler calling this after
    // set-voice-track-mode). The NEXT reconcile is what picks it up — the
    // same "next roster event" cadence set-camera already relies on.
    setVoiceTrackSeparated(CHANNEL, "peer-1", true);
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    expect(startedWith(lk).at(-1)).toEqual(
      expect.objectContaining({ videoTrackId: "TR_CAM", audioTrackId: "TR_MIC" }),
    );
    // Exactly one restart of the slot for the declaration landing — not the
    // film's own ladder rung, which never had a reason to move.
    expect(lk.start.mock.calls.length).toBe(egressCallsBeforeDeclaration + 1);
  });

  /**
   * THE SECOND FAROL FINDING: a bare per-channel boolean survives the
   * presenter who set it. If peer-1 declares "separada" and then hands the
   * share to peer-2 (or simply leaves) without ever sending `separated:
   * false`, a channel-keyed flag with no owner would credit peer-2 with a
   * choice they never made. Storing the declaring peer's id fixes it: a
   * declaration only counts for the room's CURRENT presenter.
   */
  it("a new presenter's own share starts silent until THEY declare separada, even if the last presenter never did 'junto'", async () => {
    enableHls();
    process.env.LIVE_HLS_VOICE_TRACK = "true";
    setVoiceTrackSeparated(CHANNEL, "peer-1", true);
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    voiceTrackId = "TR_MIC";
    install(lk);

    // A fresh room where the ONLY declaration on file belongs to a peer
    // who is not the one presenting now.
    await reconcileLiveHls(CHANNEL, "peer-2", SERVER);
    await flush();

    expect(startedWith(lk).at(-1)).toEqual(
      expect.objectContaining({ videoTrackId: "TR_CAM" }),
    );
    expect(startedWith(lk).at(-1)!.audioTrackId).toBeUndefined();
    expect(liveHlsStreamFor(CHANNEL)?.cameraHasVoiceAudio).toBeFalsy();
  });

  it("clears a peer's own declaration on 'junto', but never clears somebody else's", async () => {
    enableHls();
    process.env.LIVE_HLS_VOICE_TRACK = "true";
    setVoiceTrackSeparated(CHANNEL, "peer-1", true);

    // A different peer's "junto" must not be able to erase peer-1's own
    // standing declaration — the setter only clears an entry it owns.
    setVoiceTrackSeparated(CHANNEL, "peer-2", false);
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    voiceTrackId = "TR_MIC";
    install(lk);

    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    expect(startedWith(lk).at(-1)!.audioTrackId).toBe("TR_MIC");
  });

  it("drops the mic and returns to a silent camera when the flag turns off mid-party", async () => {
    enableHls();
    process.env.LIVE_HLS_VOICE_TRACK = "true";
    setVoiceTrackSeparated(CHANNEL, "peer-1", true);
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    voiceTrackId = "TR_MIC";
    install(lk);

    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();
    expect(startedWith(lk)[1]!.audioTrackId).toBe("TR_MIC");

    delete process.env.LIVE_HLS_VOICE_TRACK;
    // A roster event / set-camera frame with nothing else changed still runs
    // the reconcile, which is what an operator flipping the switch mid-party
    // relies on: the next tick catches it, not a restart.
    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    expect(lk.start).toHaveBeenCalledTimes(3);
    expect(startedWith(lk)[2]).toEqual(
      expect.objectContaining({ videoTrackId: "TR_CAM" }),
    );
    expect(startedWith(lk)[2]!.audioTrackId).toBeUndefined();
    expect(liveHlsStreamFor(CHANNEL)?.cameraHasVoiceAudio).toBeFalsy();
  });

  it("advertises the flag through GET /api/live-hls/config, dark by default", async () => {
    enableHls();
    const { liveHlsConfig } = await import("./hls-egress.js");
    expect(liveHlsConfig().voiceTrack).toBe(false);
    process.env.LIVE_HLS_VOICE_TRACK = "true";
    expect(liveHlsConfig().voiceTrack).toBe(true);
  });

  /**
   * THE BUG: a fresh voice-only start was judged, right after starting it,
   * against `LIVE_HLS_CAMERA` — the WRONG flag for a slot with no video at
   * all — so it started and then immediately stopped itself, and a
   * presenter with no webcam could never use "separada" on a deployment
   * that happened to have the camera switch off. `cameraStillWanted` now
   * checks only the flag(s) the actual shape needs.
   */
  it("starts (and keeps) an audio-only rung when LIVE_HLS_CAMERA is off but LIVE_HLS_VOICE_TRACK is on", async () => {
    enableHls();
    process.env.LIVE_HLS_CAMERA = "false";
    process.env.LIVE_HLS_VOICE_TRACK = "true";
    setVoiceTrackSeparated(CHANNEL, "peer-1", true);
    const lk = fakeLiveKit();
    voiceTrackId = "TR_MIC";
    install(lk);

    await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    await flush();

    expect(lk.start).toHaveBeenCalledTimes(2);
    // A stop-right-after-start would show up as a second stopEgress call for
    // the same id, or the slot vanishing from liveHlsActivity.
    expect(lk.stop).not.toHaveBeenCalled();
    expect(liveHlsActivity().cameraSessions).toBe(1);
    const stream = liveHlsStreamFor(CHANNEL);
    expect(stream?.cameraHasVideo).toBe(false);
    expect(stream?.cameraHasVoiceAudio).toBe(true);
  });
});

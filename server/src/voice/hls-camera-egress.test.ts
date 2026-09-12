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
  setLiveHlsTestHooks,
} from "./hls-egress.js";
import { CAMERA_RUNG_NAME, LADDER_RUNGS } from "./hls-ladder.js";

/**
 * THE PRESENTER'S CAMERA GETS A TRANSCODE OF ITS OWN, BESIDE THE LADDER.
 *
 * A watch party's audience is seatless: they never join the LiveKit room, so a
 * camera published into it reaches the seated participants over WebRTC and
 * reaches nobody on the playlist. And `TrackCompositeEgressRequest` carries one
 * video and one audio track, singular fields, so the running transcode cannot
 * be asked to also carry a face. The design and its costs are
 * `docs/plans/WATCH_PARTY_CAMERA_PIP.md`.
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

const query = vi.hoisted(() =>
  vi.fn(async (sql: string) => {
    if (typeof sql === "string" && sql.includes("live_hls_enabled")) {
      return { rowCount: 1, rows: [{ live_hls_enabled: null }] };
    }
    return { rowCount: 0, rows: [] };
  }),
);
vi.mock("../db.js", () => ({ getPool: () => ({ query }) }));

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const SERVER = "00000000-0000-4000-8000-0000000000ee";
const OTHER_CHANNEL = "00000000-0000-4000-8000-0000000000bb";

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
    "LIVE_HLS_REAP_ORPHANS",
    "VOICE_PROMOTION_MAX_SFU_MBPS",
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
      stopEgress: stop,
      listEgress: list,
    } satisfies LiveHlsEgressApi,
    start,
    stop,
    list,
    kill(egressId: string) {
      statuses.set(egressId, EgressStatus.EGRESS_FAILED);
    },
  };
}

/** What the SFU reports for the presenter, camera optional. */
let cameraTrackId: string | null = null;

function install(lk: ReturnType<typeof fakeLiveKit>) {
  setLiveHlsTestHooks({
    egress: lk.api,
    findTracks: async () => ({
      videoTrackId: "TR_SCREEN",
      ...(cameraTrackId ? { cameraTrackId } : {}),
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

beforeEach(() => {
  resetLiveHlsForTests();
  disableHls();
  cameraTrackId = null;
  logEvent.mockClear();
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

    const stream = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

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
    expect(on?.startedAt).toBe(before!.startedAt);
    expect(on?.hlsUrl).toBe(before!.hlsUrl);
    expect(on?.cameraHlsUrl).toContain(CAMERA_RUNG_NAME);
    expect(lk.stop).not.toHaveBeenCalled();

    // And off again.
    cameraTrackId = null;
    const off = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
    expect(off?.startedAt).toBe(before!.startedAt);
    expect(off?.hlsUrl).toBe(before!.hlsUrl);
    expect(off?.cameraHlsUrl).toBeUndefined();
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

    // A device switch mints a new sid. A Track Composite egress is bound to
    // one sid and goes on running against a dead one, writing nothing.
    cameraTrackId = "TR_CAM_2";
    const after = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

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

    expect(stream).not.toBeNull();
    expect(stream?.cameraHlsUrl).toBeUndefined();
    expect(lk.start).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsCameraRefused",
      expect.objectContaining({ refusal: "box-budget" }),
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
    expect(liveHlsActivity().cameraSessions).toBe(1);

    await advance(5_000);
    await checkLiveHlsHealth();

    expect(liveHlsActivity().cameraSessions).toBe(1);
    expect(lk.stop).not.toHaveBeenCalled();
  });

  it("drops a dead camera without taking the film with it", async () => {
    enableHls();
    const lk = fakeLiveKit();
    cameraTrackId = "TR_CAM";
    install(lk);
    const before = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);

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

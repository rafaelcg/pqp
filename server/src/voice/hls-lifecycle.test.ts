import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EgressStatus } from "livekit-server-sdk";
import {
  checkLiveHlsHealth,
  egressAlreadyStopped,
  liveHlsStreamFor,
  reconcileLiveHls,
  resetLiveHlsForTests,
  setLiveHlsChangeListener,
  setLiveHlsPresenterCheck,
  setLiveHlsTestHooks,
  stopEgressById,
  type LiveHlsEgressApi,
} from "./hls-egress.js";

/**
 * THE 2026-09-17 LIFECYCLE INCIDENT, one test per race.
 *
 * Channel `d5559e70`, one person in two tabs. Inside forty seconds the log
 * shows a party end, a session stopped for `no-share`, a SECOND two-rung
 * ladder started for the presenter who had just left, that ladder's egresses
 * dying on `track ... not found`, a restart scheduled for the party that was
 * already over, and finally `voice.hlsStarted playlistReady=false
 * playlistWaitMs=52752` -- a start announced for a session that had no
 * playlist and no presenter. The viewer tab sat on "A transmissão travou,
 * reconectando" for minutes and recovered from nothing.
 *
 * Every test here is one of those lines, and every one of them fails on the
 * code that produced it. The fake stack is `hls-egress.test.ts`'s (no
 * Postgres, no LiveKit, a `ListEgress` whose answers the test flips), copied
 * rather than exported because the point of it is to be small.
 */

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("../lib/log.js", () => ({ logEvent }));

/**
 * A gate the session-row INSERT can be parked on, so a test can look at the
 * world from INSIDE `startRoom` -- after the room is published into `rooms`
 * and before its playlist has been proven. That window is up to forty-five
 * seconds in production and is the one a concurrent push reads.
 */
const insertGate = vi.hoisted(() => ({
  wait: null as Promise<void> | null,
  release: null as (() => void) | null,
  reached: null as (() => void) | null,
  arrived: null as Promise<void> | null,
}));
const query = vi.hoisted(() =>
  vi.fn(async (sql: string) => {
    if (typeof sql === "string" && sql.includes("live_hls_enabled")) {
      return { rowCount: 1, rows: [{ live_hls_enabled: null }] };
    }
    if (
      typeof sql === "string" &&
      sql.includes("INSERT INTO hls_sessions") &&
      insertGate.wait
    ) {
      insertGate.reached?.();
      await insertGate.wait;
    }
    return { rowCount: 0, rows: [] };
  }),
);
vi.mock("../db.js", () => ({ getPool: () => ({ query }) }));

/** Park the next session-row write until the returned `release` is called. */
function holdSessionRowWrite(): { arrived: Promise<void>; release: () => void } {
  const arrived = new Promise<void>((resolve) => {
    insertGate.reached = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    insertGate.release = resolve;
  });
  insertGate.wait = wait;
  insertGate.arrived = arrived;
  return {
    arrived,
    release: () => {
      insertGate.wait = null;
      insertGate.release?.();
    },
  };
}

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const SERVER = "00000000-0000-4000-8000-0000000000ee";

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
  process.env.LIVE_HLS_LADDER = "720p30";
}

function disableHls() {
  for (const name of [
    "LIVE_HLS_ENABLED",
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "LIVE_HLS_PUBLIC_BASE_URL",
    "LIVE_HLS_S3_BUCKET",
    "LIVE_HLS_S3_ACCESS_KEY_ID",
    "LIVE_HLS_S3_SECRET_ACCESS_KEY",
    "LIVE_HLS_S3_ENDPOINT",
    "LIVE_HLS_LADDER",
  ]) {
    delete process.env[name];
  }
}

function fakeLiveKit(options: { stopError?: string } = {}) {
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
    if (options.stopError) {
      throw new Error(options.stopError);
    }
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
    kill(egressId: string) {
      statuses.set(egressId, EgressStatus.EGRESS_FAILED);
    },
  };
}

/** Every `logEvent` payload logged under this name, in order. */
function logged(name: string): Record<string, unknown>[] {
  return logEvent.mock.calls
    .filter((call) => call[0] === name)
    .map((call) => (call[1] ?? {}) as Record<string, unknown>);
}

describe("watch party lifecycle", () => {
  beforeEach(() => {
    resetLiveHlsForTests();
    disableHls();
    logEvent.mockClear();
    insertGate.wait = null;
  });

  afterEach(() => {
    resetLiveHlsForTests();
    disableHls();
    vi.useRealTimers();
  });

  describe("a start for a presenter who is already gone", () => {
    it("never asks LiveKit for a rung when the room says they left", async () => {
      enableHls();
      const lk = fakeLiveKit();
      setLiveHlsTestHooks({
        egress: lk.api,
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });
      // The push decided this start before the party ended; by the time the
      // reconcile queue got to it, the room disagrees.
      setLiveHlsPresenterCheck(() => false);

      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).toBeNull();
      expect(lk.start).not.toHaveBeenCalled();
      expect(liveHlsStreamFor(CHANNEL)).toBeNull();
      expect(logged("voice.hlsStartCancelled")).toEqual([
        { channelId: CHANNEL, presenterPeerId: "peer-1", stage: "before-probe" },
      ]);
    });

    it("cancels a start whose presenter leaves DURING the track probe", async () => {
      enableHls();
      const lk = fakeLiveKit();
      let present = true;
      setLiveHlsTestHooks({
        egress: lk.api,
        // The probe is up to six seconds of polling LiveKit, and the SFU
        // still holds the track of somebody who has just hung up: it answers
        // perfectly well for a share that is over.
        findTracks: async () => {
          present = false;
          return { videoTrackId: "TR_V" };
        },
      });
      setLiveHlsPresenterCheck(() => present);

      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).toBeNull();
      expect(lk.start).not.toHaveBeenCalled();
      expect(logged("voice.hlsStartCancelled").at(-1)).toMatchObject({
        stage: "after-probe",
      });
    });

    it("tears the session down when the presenter leaves during the readiness wait", async () => {
      enableHls();
      const lk = fakeLiveKit();
      let present = true;
      setLiveHlsTestHooks({
        egress: lk.api,
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });
      setLiveHlsPresenterCheck(() => present);
      // `waitForLivePlaylist` is up to forty-five seconds; production spent
      // fifty-two of them on 2026-09-17 for a presenter who had left at the
      // start of it. The fake probe answers instantly, so the departure is
      // staged between the rung starting and the wait returning.
      lk.start.mockImplementation(async () => {
        present = false;
        return { egressId: "EG_1" };
      });

      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).toBeNull();
      expect(liveHlsStreamFor(CHANNEL)).toBeNull();
      // Started and then stopped: a ready playlist for a share that is over
      // is a rung still transcoding.
      expect(lk.stop).toHaveBeenCalledWith("EG_1");
      expect(logged("voice.hlsStartCancelled").at(-1)).toMatchObject({
        stage: "after-playlist-wait",
        playlistReady: true,
      });
      expect(logged("voice.hlsStopped").at(-1)).toMatchObject({
        reason: "presenter-gone",
      });
    });

    it("starts normally when nothing has changed under it", async () => {
      // The fail-open half, and the reason the check is narrow: a check that
      // says yes has to leave the ordinary path byte-for-byte alone.
      enableHls();
      const lk = fakeLiveKit();
      setLiveHlsTestHooks({
        egress: lk.api,
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });
      setLiveHlsPresenterCheck(() => true);

      const stream = await reconcileLiveHls(CHANNEL, "peer-1", SERVER);
      expect(stream?.presenterPeerId).toBe("peer-1");
      expect(liveHlsStreamFor(CHANNEL)).toEqual(stream);
      expect(logged("voice.hlsStartCancelled")).toEqual([]);
    });
  });

  describe("a restart for a party that is over", () => {
    it("is not scheduled, and the audience is told the stream is gone", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-17T19:20:00Z"));
      enableHls();
      const lk = fakeLiveKit();
      setLiveHlsTestHooks({
        egress: lk.api,
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });
      let present = true;
      setLiveHlsPresenterCheck(() => present);
      const heard: string[] = [];
      setLiveHlsChangeListener((_channelId, reason) => {
        heard.push(reason);
      });

      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).not.toBeNull();
      // The party ends and the presenter leaves; the egress notices its
      // track is gone a few seconds later, exactly as it did at 19:21:21.
      present = false;
      lk.kill("EG_1");
      await vi.advanceTimersByTimeAsync(20_000);

      expect(await checkLiveHlsHealth()).toEqual([
        { channelId: CHANNEL, outcome: "cancelled" },
      ]);
      expect(logged("voice.hlsRestartScheduled")).toEqual([]);
      expect(logged("voice.hlsRestartSkipped").at(-1)).toMatchObject({
        channelId: CHANNEL,
        cause: "presenter-gone",
        presenterPeerId: "peer-1",
      });
      // The seam the cap already uses: viewers are told, rather than left on
      // a playlist nobody is writing.
      expect(heard).toContain("presenter-gone");
      // And no second ladder for nobody.
      const startsAfter = lk.start.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(lk.start.mock.calls.length).toBe(startsAfter);
    });

    it("still restarts for a presenter who is genuinely still sharing", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-17T19:20:00Z"));
      enableHls();
      const lk = fakeLiveKit();
      setLiveHlsTestHooks({
        egress: lk.api,
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });
      setLiveHlsPresenterCheck(() => true);
      setLiveHlsChangeListener((channelId) => {
        void reconcileLiveHls(channelId, "peer-1", SERVER);
      });

      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).not.toBeNull();
      lk.kill("EG_1");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await checkLiveHlsHealth()).toEqual([
        { channelId: CHANNEL, outcome: "scheduled" },
      ]);
    });
  });

  describe("an egress that has already finished", () => {
    it("classifies LiveKit's refusal to stop it as already stopped", () => {
      expect(
        egressAlreadyStopped(
          new Error("egress with status EGRESS_COMPLETE cannot be stopped"),
        ),
      ).toBe(true);
      expect(egressAlreadyStopped(new Error("egress does not exist"))).toBe(
        true,
      );
      // A start failing on a vanished track is a REAL failure and a different
      // decision; nothing on a stop path produces it, and this guards the
      // day somebody reuses the helper.
      expect(egressAlreadyStopped(new Error("no response from servers"))).toBe(
        false,
      );
    });

    it("is not an error to retry, and clears the orphan backoff", async () => {
      enableHls();
      const lk = fakeLiveKit({
        stopError: "egress with status EGRESS_COMPLETE cannot be stopped",
      });
      setLiveHlsTestHooks({ egress: lk.api });

      expect(await stopEgressById("EG_X", CHANNEL)).toBe(true);
      expect(logged("voice.hlsStopFailed")).toEqual([]);
      expect(logged("voice.hlsStopNoop").at(-1)).toMatchObject({
        egressId: "EG_X",
      });
      // The backoff is what made this cost something: an id parked in it is
      // asked about again for an hour. A second ask goes through at once.
      lk.stop.mockClear();
      expect(await stopEgressById("EG_X", CHANNEL)).toBe(true);
      expect(lk.stop).toHaveBeenCalledTimes(1);
    });

    it("does not colour an ordinary teardown red", async () => {
      enableHls();
      const lk = fakeLiveKit({
        stopError: "egress with status EGRESS_COMPLETE cannot be stopped",
      });
      setLiveHlsTestHooks({
        egress: lk.api,
        findTracks: async () => ({ videoTrackId: "TR_V" }),
      });
      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).not.toBeNull();
      await reconcileLiveHls(CHANNEL, null, SERVER);

      expect(logged("voice.hlsStopFailed")).toEqual([]);
      expect(logged("voice.hlsStopNoop").length).toBeGreaterThan(0);
    });
  });

  describe("a session whose playlist never arrives", () => {
    it("is invisible to every other reader while it is still warming up", async () => {
      enableHls();
      const lk = fakeLiveKit();
      setLiveHlsTestHooks({
        egress: lk.api,
        findTracks: async () => ({ videoTrackId: "TR_V" }),
        playlistReady: false,
      });
      setLiveHlsPresenterCheck(() => true);
      const gate = holdSessionRowWrite();

      const first = reconcileLiveHls(CHANNEL, "peer-1", SERVER);
      await gate.arrived;
      // INSIDE the start: the rungs are running and the room is in `rooms`,
      // which is what the monitor and the reap need. To everybody else there
      // is nothing live here yet, because there is no playlist yet.
      expect(lk.start).toHaveBeenCalled();
      expect(liveHlsStreamFor(CHANNEL)).toBeNull();
      gate.release();

      expect(await first).toBeNull();
      // And after the wait times out, still nothing: the pre-fix behaviour
      // left the URL readable and parked every viewer behind the holding
      // screen for as long as they were willing to look at it.
      expect(liveHlsStreamFor(CHANNEL)).toBeNull();
      expect(logged("voice.hlsStarted").at(-1)).toMatchObject({
        playlistReady: false,
        announced: false,
      });
    });

    it("is not returned to a push that arrives while it is warming up", async () => {
      enableHls();
      const lk = fakeLiveKit();
      setLiveHlsTestHooks({
        egress: lk.api,
        findTracks: async () => ({ videoTrackId: "TR_V" }),
        playlistReady: false,
      });
      setLiveHlsPresenterCheck(() => true);
      const gate = holdSessionRowWrite();

      const first = reconcileLiveHls(CHANNEL, "peer-1", SERVER);
      await gate.arrived;
      // A roster event for the SAME presenter, which is the ordinary case:
      // somebody joining the party while the transcode warms up. It takes
      // the same-presenter branch and must not hand back a playlist that
      // does not exist.
      const second = reconcileLiveHls(CHANNEL, "peer-1", SERVER);
      gate.release();
      expect(await second).toBeNull();
      expect(await first).toBeNull();
    });

    it("says so on the line an operator greps", async () => {
      enableHls();
      const lk = fakeLiveKit();
      setLiveHlsTestHooks({
        egress: lk.api,
        findTracks: async () => ({ videoTrackId: "TR_V" }),
        playlistReady: true,
      });
      setLiveHlsPresenterCheck(() => true);
      expect(await reconcileLiveHls(CHANNEL, "peer-1", SERVER)).not.toBeNull();
      expect(logged("voice.hlsStarted").at(-1)).toMatchObject({
        playlistReady: true,
        announced: true,
      });
    });
  });
});

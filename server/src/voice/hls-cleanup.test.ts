import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Live HLS retention sweep (`sweepHlsSessions`). Real Postgres so the
 * SQL predicate itself is proved (which sessions are due, `keep_replay`
 * changing the window) rather than a mock of it; only the bucket is faked,
 * exactly like `services/attachments.test.ts` does for the same reason:
 * the signing itself is proved in `lib/s3.test.ts`.
 *
 * The critical property this file exists to pin: `deleteSessionObjects`
 * refuses to delete anything outside a session's own
 * `live/<channelId>/` prefix. Two of the tests below deliberately corrupt
 * that guard (a session row whose prefix claims a different channel, and a
 * bucket listing that "leaks" a key from another channel) and assert the
 * sweep refuses rather than silently deleting.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const bucket = vi.hoisted(() => ({
  // channelId/startedAt-agnostic: keyed by full object key.
  objects: new Set<string>(),
  deleted: [] as string[],
  /** Extra keys `listObjectKeys` should return regardless of prefix asked,
   * to simulate a bucket listing that leaks a stranger's key. */
  leakedKeys: [] as string[],
}));

vi.mock("../lib/s3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/s3.js")>();
  return {
    ...actual,
    listObjectKeys: async (prefix: string) => {
      const matching = [...bucket.objects].filter((key) =>
        key.startsWith(prefix),
      );
      return [...matching, ...bucket.leakedKeys];
    },
    deleteObject: async (key: string) => {
      bucket.deleted.push(key);
      bucket.objects.delete(key);
    },
  };
});

process.env.LIVE_HLS_S3_BUCKET = "pqp-live-test";
process.env.LIVE_HLS_S3_ACCESS_KEY_ID = "ak";
process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY = "sk";
process.env.LIVE_HLS_S3_ENDPOINT = "https://s3.example.test";

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { reconcileStaleHlsSessions, sweepHlsSessions } = await import(
  "./hls-cleanup.js"
);
const {
  resetLiveHlsForTests,
  setLiveHlsTestHooks,
  liveHlsStreamFor,
  liveHlsRungsFor,
} =
  await import("./hls-egress.js");

describeDb("sweepHlsSessions", () => {
  let channelA: string;
  let channelB: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(
      `TRUNCATE users, servers, channels, hls_sessions RESTART IDENTITY CASCADE`,
    );
    bucket.objects.clear();
    bucket.deleted.length = 0;
    bucket.leakedKeys.length = 0;
    delete process.env.LIVE_HLS_RETENTION_MINUTES;
    delete process.env.LIVE_HLS_REPLAY_HOURS;

    const user = await upsertUser({
      clerkId: "clerk_hls_cleanup",
      displayName: "Cleanup Tester",
      avatarUrl: null,
    });
    const server = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('test', $1) RETURNING id`,
      [user.id],
    );
    const serverId = server.rows[0]!.id;
    const channels = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position)
       VALUES ($1, 'a', 'voice', 0), ($1, 'b', 'voice', 1)
       RETURNING id`,
      [serverId],
    );
    channelA = channels.rows[0]!.id;
    channelB = channels.rows[1]!.id;
  });

  async function makeSession(options: {
    channelId: string;
    prefix: string;
    endedMinutesAgo: number | null;
    keepReplay?: boolean;
    egressId?: string;
    presenterPeerId?: string;
    videoTrackId?: string;
    rung?: string;
  }): Promise<string> {
    const endedAt =
      options.endedMinutesAgo === null
        ? null
        : new Date(Date.now() - options.endedMinutesAgo * 60_000);
    const row = await getPool().query<{ id: string }>(
      `INSERT INTO hls_sessions
         (channel_id, object_prefix, started_at, ended_at, keep_replay,
          egress_id, presenter_peer_id, video_track_id, rung)
       VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        options.channelId,
        options.prefix,
        endedAt,
        options.keepReplay ?? false,
        options.egressId ?? null,
        options.presenterPeerId ?? null,
        options.videoTrackId ?? null,
        options.rung ?? null,
      ],
    );
    return row.rows[0]!.id;
  }

  function seedObjects(prefix: string, count: number): void {
    for (let i = 0; i < count; i += 1) {
      bucket.objects.add(`${prefix}_${String(i).padStart(5, "0")}.ts`);
    }
    bucket.objects.add(`${prefix}.m3u8`);
  }

  it("cleans a plain (non-replay) session past LIVE_HLS_RETENTION_MINUTES and only that session's objects", async () => {
    process.env.LIVE_HLS_RETENTION_MINUTES = "10";
    const dueId = await makeSession({
      channelId: channelA,
      prefix: `live/${channelA}/1000`,
      endedMinutesAgo: 20,
    });
    const notYetDueId = await makeSession({
      channelId: channelA,
      prefix: `live/${channelA}/2000`,
      endedMinutesAgo: 2,
    });
    seedObjects(`live/${channelA}/1000`, 3);
    seedObjects(`live/${channelA}/2000`, 3);

    const cleaned = await sweepHlsSessions();

    expect(cleaned).toBe(1);
    expect(bucket.deleted.sort()).toEqual(
      [
        `live/${channelA}/1000_00000.ts`,
        `live/${channelA}/1000_00001.ts`,
        `live/${channelA}/1000_00002.ts`,
        `live/${channelA}/1000.m3u8`,
      ].sort(),
    );
    // The not-yet-due session's objects are untouched.
    expect(
      [...bucket.objects].filter((k) => k.startsWith(`live/${channelA}/2000`)),
    ).toHaveLength(4);

    const rows = await getPool().query<{
      id: string;
      cleaned_at: Date | null;
    }>(`SELECT id, cleaned_at FROM hls_sessions ORDER BY object_prefix`);
    const dueRow = rows.rows.find((r) => r.id === dueId)!;
    const notYetDueRow = rows.rows.find((r) => r.id === notYetDueId)!;
    expect(dueRow.cleaned_at).not.toBeNull();
    expect(notYetDueRow.cleaned_at).toBeNull();
  });

  it("respects keep_replay: uses LIVE_HLS_REPLAY_HOURS instead of the short window", async () => {
    process.env.LIVE_HLS_RETENTION_MINUTES = "10";
    process.env.LIVE_HLS_REPLAY_HOURS = "24";
    // Ended 30 minutes ago: long past the plain 10-minute window, nowhere
    // near the 24-hour replay window.
    const keptId = await makeSession({
      channelId: channelA,
      prefix: `live/${channelA}/3000`,
      endedMinutesAgo: 30,
      keepReplay: true,
    });
    seedObjects(`live/${channelA}/3000`, 2);

    const cleaned = await sweepHlsSessions();

    expect(cleaned).toBe(0);
    const row = await getPool().query<{ cleaned_at: Date | null }>(
      `SELECT cleaned_at FROM hls_sessions WHERE id = $1`,
      [keptId],
    );
    expect(row.rows[0]!.cleaned_at).toBeNull();
    expect(bucket.deleted).toHaveLength(0);

    // BROKEN-GUARD CHECK: flip the DB row to look like it exceeded the
    // 24-hour window and confirm the sweep *does* then clean it, proving
    // the keep_replay branch is the thing gating it, not some other reason
    // the row was skipped.
    await getPool().query(
      `UPDATE hls_sessions SET ended_at = NOW() - interval '25 hours' WHERE id = $1`,
      [keptId],
    );
    const cleanedAfter = await sweepHlsSessions();
    expect(cleanedAfter).toBe(1);
    expect(bucket.deleted.sort()).toEqual(
      [
        `live/${channelA}/3000_00000.ts`,
        `live/${channelA}/3000_00001.ts`,
        `live/${channelA}/3000.m3u8`,
      ].sort(),
    );
  });

  it("never deletes another channel's objects, even if a bucket listing leaks one", async () => {
    process.env.LIVE_HLS_RETENTION_MINUTES = "10";
    await makeSession({
      channelId: channelA,
      prefix: `live/${channelA}/4000`,
      endedMinutesAgo: 20,
    });
    seedObjects(`live/${channelA}/4000`, 2);
    // A stranger's object that a buggy/compromised bucket listing hands
    // back alongside the legitimate ones.
    bucket.leakedKeys.push(`live/${channelB}/9999_00000.ts`);
    bucket.objects.add(`live/${channelB}/9999_00000.ts`);

    await expect(sweepHlsSessions()).resolves.toBe(0);
    // Refused entirely (this session's own objects included), rather than
    // partially deleting and leaving the row unmarked -- a leaked key means
    // something is wrong with the listing, not "delete what looked safe".
    expect(bucket.deleted).toHaveLength(0);
    expect(bucket.objects.has(`live/${channelB}/9999_00000.ts`)).toBe(true);
  });

  it("BROKEN GUARD: a session row whose prefix does not match its own channel_id is refused, not swept", async () => {
    process.env.LIVE_HLS_RETENTION_MINUTES = "10";
    // Simulates the bug this guard exists for: a row that claims channelA
    // but whose prefix actually belongs to channelB.
    await makeSession({
      channelId: channelA,
      prefix: `live/${channelB}/5000`,
      endedMinutesAgo: 20,
    });
    seedObjects(`live/${channelB}/5000`, 2);

    await expect(sweepHlsSessions()).resolves.toBe(0);
    expect(bucket.deleted).toHaveLength(0);
    expect(
      [...bucket.objects].filter((k) => k.startsWith(`live/${channelB}/5000`)),
    ).toHaveLength(3);
  });

  it("does nothing when Live HLS storage is not configured", async () => {
    const bucketEnv = process.env.LIVE_HLS_S3_BUCKET;
    delete process.env.LIVE_HLS_S3_BUCKET;
    try {
      await makeSession({
        channelId: channelA,
        prefix: `live/${channelA}/6000`,
        endedMinutesAgo: 20,
      });
      await expect(sweepHlsSessions()).resolves.toBe(0);
    } finally {
      process.env.LIVE_HLS_S3_BUCKET = bucketEnv;
    }
  });

  it("deletes the egress manifest that sits beside the prefix, not under it", async () => {
    process.env.LIVE_HLS_RETENTION_MINUTES = "10";
    await makeSession({
      channelId: channelA,
      prefix: `live/${channelA}/7000`,
      endedMinutesAgo: 20,
      egressId: "EG_abc",
    });
    seedObjects(`live/${channelA}/7000`, 1);
    // The manifest the egress writes on finish. A prefix listing of
    // `live/<a>/7000` never returns it, which is the leftover the QA found.
    bucket.objects.add(`live/${channelA}/EG_abc.json`);

    await expect(sweepHlsSessions()).resolves.toBe(1);
    expect(bucket.deleted).toContain(`live/${channelA}/EG_abc.json`);
    expect(bucket.objects.has(`live/${channelA}/EG_abc.json`)).toBe(false);
  });

  /**
   * A live egress does not stop because the API restarted. The first version
   * of this ended the row and stopped the transcode, which killed a live watch
   * party on every deploy, and when a stop did not land it left an orphan
   * burning about a core of the media box (three were found by hand during
   * load testing). So: adopt what is still running, stop only what nobody
   * owns, and end only the rows with nothing behind them.
   */
  describe("reconcileStaleHlsSessions (boot)", () => {
    afterEach(() => {
      resetLiveHlsForTests();
    });

    /** A fake media server that reports whichever egresses the test says. */
    function mediaServer(
      running: { egressId: string; roomName: string }[],
      opts: { failList?: boolean } = {},
    ) {
      const stop = vi.fn(async () => {});
      setLiveHlsTestHooks({
        egress: {
          startTrackCompositeEgress: async () => ({ egressId: "unused" }),
          stopEgress: stop,
          listEgress: async () => {
            if (opts.failList) {
              throw new Error("ListEgress: 503");
            }
            return running.map((r) => ({
              egressId: r.egressId,
              status: 1,
              roomName: r.roomName,
            }));
          },
        },
      });
      return { stop };
    }

    it("RE-ADOPTS a session whose egress is still running, instead of ending it", async () => {
      const id = await makeSession({
        channelId: channelA,
        prefix: `live/${channelA}/8000`,
        // Marked ended by the process that died: the row is wrong, the media
        // box is right.
        endedMinutesAgo: 0,
        egressId: "EG_live",
        presenterPeerId: "peer-1",
        videoTrackId: "TR_V",
      });
      const { stop } = mediaServer([
        { egressId: "EG_live", roomName: channelA },
      ]);

      const result = await reconcileStaleHlsSessions();
      expect(result.adopted).toBe(1);
      expect(result.stopped).toBe(0);
      // The party keeps running: not stopped, and the room is ours again.
      expect(stop).not.toHaveBeenCalled();
      const stream = liveHlsStreamFor(channelA);
      expect(stream).not.toBeNull();
      expect(stream?.startedAt).toBe(8000);
      expect(stream?.presenterPeerId).toBe("peer-1");
      // And the row is open again, so retention will not come for it.
      const row = await getPool().query<{ ended_at: Date | null }>(
        `SELECT ended_at FROM hls_sessions WHERE id = $1`,
        [id],
      );
      expect(row.rows[0]!.ended_at).toBeNull();
    });

    it("adopts EVERY rung of a ladder, rather than stopping the party", async () => {
      // The dangerous shape of this merge. A ladder's prefixes end
      // `-1080p30`, and the boot reconcile reads `startedAt` out of the
      // prefix: a parser that cannot see past the rung answers NaN, calls the
      // row unadoptable, and STOPS a live egress. On every deploy, for every
      // watch party, which is the exact failure the adoption path was written
      // to prevent.
      for (const rung of ["720p30", "1080p30"]) {
        await makeSession({
          channelId: channelA,
          prefix: `live/${channelA}/8200-${rung}`,
          endedMinutesAgo: 0,
          egressId: `EG_${rung}`,
          presenterPeerId: "peer-1",
          videoTrackId: "TR_V",
          rung,
        });
      }
      const { stop } = mediaServer([
        { egressId: "EG_1080p30", roomName: channelA },
        { egressId: "EG_720p30", roomName: channelA },
      ]);

      const result = await reconcileStaleHlsSessions();
      expect(stop).not.toHaveBeenCalled();
      expect(result.stopped).toBe(0);
      expect(result.adopted).toBe(2);
      const stream = liveHlsStreamFor(channelA);
      expect(stream?.startedAt).toBe(8200);
      // Both rungs are in the room, not just whichever arrived last, and the
      // top one is what the presenter is told to publish for.
      expect(liveHlsRungsFor(channelA).map((r) => r.name)).toEqual([
        "720p30",
        "1080p30",
      ]);
      expect(stream?.topHeight).toBe(1080);
    });

    it("STOPS an egress no session row owns", async () => {
      const { stop } = mediaServer([
        { egressId: "EG_orphan", roomName: channelB },
      ]);
      const result = await reconcileStaleHlsSessions();
      expect(stop).toHaveBeenCalledWith("EG_orphan");
      expect(result.stopped).toBe(1);
      expect(result.adopted).toBe(0);
    });

    it("ends an open row whose egress is gone, so retention runs", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "10";
      const id = await makeSession({
        channelId: channelA,
        prefix: `live/${channelA}/8100`,
        endedMinutesAgo: null,
        egressId: "EG_dead",
        presenterPeerId: "peer-1",
      });
      mediaServer([]);
      const result = await reconcileStaleHlsSessions();
      expect(result.ended).toBe(1);
      expect(result.adopted).toBe(0);
      const row = await getPool().query<{ ended_at: Date | null }>(
        `SELECT ended_at FROM hls_sessions WHERE id = $1`,
        [id],
      );
      expect(row.rows[0]!.ended_at).not.toBeNull();
    });

    it("does nothing at all when the media server cannot be asked", async () => {
      // Ending rows blind would let the sweep delete segments from under an
      // egress that is still writing them.
      const id = await makeSession({
        channelId: channelA,
        prefix: `live/${channelA}/8200`,
        endedMinutesAgo: null,
        egressId: "EG_unknown",
        presenterPeerId: "peer-1",
      });
      const { stop } = mediaServer([], { failList: true });
      const result = await reconcileStaleHlsSessions();
      expect(result).toEqual({ adopted: 0, ended: 0, stopped: 0 });
      expect(stop).not.toHaveBeenCalled();
      const row = await getPool().query<{ ended_at: Date | null }>(
        `SELECT ended_at FROM hls_sessions WHERE id = $1`,
        [id],
      );
      expect(row.rows[0]!.ended_at).toBeNull();
    });

    it("is a no-op with nothing open and nothing running", async () => {
      mediaServer([]);
      await expect(reconcileStaleHlsSessions()).resolves.toEqual({
        adopted: 0,
        ended: 0,
        stopped: 0,
      });
    });
  });

  describe("the sweep refuses to delete under a live egress", () => {
    afterEach(() => {
      resetLiveHlsForTests();
    });

    function mediaServer(
      running: string[],
      opts: { failList?: boolean } = {},
    ) {
      setLiveHlsTestHooks({
        egress: {
          startTrackCompositeEgress: async () => ({ egressId: "unused" }),
          stopEgress: async () => {},
          listEgress: async () => {
            if (opts.failList) {
              throw new Error("ListEgress: 503");
            }
            return running.map((egressId) => ({ egressId, status: 1 }));
          },
        },
      });
    }

    it("skips a due session whose egress is STILL RUNNING, however stale the row looks", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "10";
      await makeSession({
        channelId: channelA,
        prefix: `live/${channelA}/9100`,
        endedMinutesAgo: 60,
        egressId: "EG_still_writing",
      });
      seedObjects(`live/${channelA}/9100`, 3);
      mediaServer(["EG_still_writing"]);

      await expect(sweepHlsSessions()).resolves.toBe(0);
      // Not one segment deleted out from under a live stream.
      expect(bucket.deleted).toHaveLength(0);
      expect(
        [...bucket.objects].filter((k) => k.startsWith(`live/${channelA}/9100`)),
      ).toHaveLength(4);
    });

    it("still sweeps a due session whose egress has finished", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "10";
      await makeSession({
        channelId: channelA,
        prefix: `live/${channelA}/9200`,
        endedMinutesAgo: 60,
        egressId: "EG_finished",
      });
      seedObjects(`live/${channelA}/9200`, 2);
      mediaServer(["EG_somebody_else"]);
      await expect(sweepHlsSessions()).resolves.toBe(1);
      expect(bucket.deleted.length).toBeGreaterThan(0);
    });

    it("deletes nothing when the media server cannot be asked", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "10";
      await makeSession({
        channelId: channelA,
        prefix: `live/${channelA}/9300`,
        endedMinutesAgo: 60,
        egressId: "EG_unknown",
      });
      seedObjects(`live/${channelA}/9300`, 2);
      mediaServer([], { failList: true });
      await expect(sweepHlsSessions()).resolves.toBe(0);
      expect(bucket.deleted).toHaveLength(0);
    });
  });
});

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
const { resetLiveHlsForTests, setLiveHlsTestHooks } = await import(
  "./hls-egress.js"
);

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
  }): Promise<string> {
    const endedAt =
      options.endedMinutesAgo === null
        ? null
        : new Date(Date.now() - options.endedMinutesAgo * 60_000);
    const row = await getPool().query<{ id: string }>(
      `INSERT INTO hls_sessions
         (channel_id, object_prefix, started_at, ended_at, keep_replay, egress_id)
       VALUES ($1, $2, NOW(), $3, $4, $5)
       RETURNING id`,
      [
        options.channelId,
        options.prefix,
        endedAt,
        options.keepReplay ?? false,
        options.egressId ?? null,
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

  describe("reconcileStaleHlsSessions (boot)", () => {
    afterEach(() => {
      resetLiveHlsForTests();
    });

    it("ends every open row and stops the egress LiveKit still runs for it", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "10";
      const stop = vi.fn(async () => {});
      setLiveHlsTestHooks({
        egress: {
          startTrackCompositeEgress: async () => ({ egressId: "unused" }),
          stopEgress: stop,
          listEgress: async ({ roomName }) =>
            roomName === channelA
              ? [{ egressId: "EG_live", status: 1 }]
              : [],
        },
      });
      const openA = await makeSession({
        channelId: channelA,
        prefix: `live/${channelA}/8000`,
        endedMinutesAgo: null,
        egressId: "EG_live",
      });
      const openB = await makeSession({
        channelId: channelB,
        prefix: `live/${channelB}/8100`,
        endedMinutesAgo: null,
      });
      const closed = await makeSession({
        channelId: channelA,
        prefix: `live/${channelA}/8200`,
        endedMinutesAgo: 60,
      });

      await expect(reconcileStaleHlsSessions()).resolves.toBe(2);
      expect(stop).toHaveBeenCalledWith("EG_live");
      const rows = await getPool().query<{ id: string; ended_at: Date | null }>(
        `SELECT id, ended_at FROM hls_sessions ORDER BY started_at`,
      );
      const byId = new Map(rows.rows.map((row) => [row.id, row.ended_at]));
      expect(byId.get(openA)).not.toBeNull();
      expect(byId.get(openB)).not.toBeNull();
      // The already-closed row keeps its old timestamp (an hour ago), so
      // its retention clock is not restarted by the boot.
      expect(byId.get(closed)!.getTime()).toBeLessThan(Date.now() - 50 * 60_000);
      // and the freshly ended rows are not swept yet: the window starts now.
      await expect(sweepHlsSessions()).resolves.toBe(1);
    });

    it("is a no-op with nothing open", async () => {
      await expect(reconcileStaleHlsSessions()).resolves.toBe(0);
    });
  });
});

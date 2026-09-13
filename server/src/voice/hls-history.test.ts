import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The concurrency property `setWatchPartyKeepReplay`'s comment argues for:
 * a `SELECT ... FOR UPDATE` transaction, not a single CTE, because a CTE
 * referenced more than once is materialised once against the statement's
 * starting snapshot and is NOT re-evaluated by Postgres's lock-conflict
 * re-check (EvalPlanQual) after waiting on a row another transaction is
 * writing. This file proves the property directly: hold a row lock exactly
 * the way `sweepHlsSessions` would while it marks a row cleaned, and confirm
 * `setWatchPartyKeepReplay` -- called concurrently -- blocks on it and then
 * reports "unavailable" once the lock is released with the row cleaned,
 * rather than racing ahead on stale data.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { setWatchPartyKeepReplay } = await import("./hls-history.js");

const STARTED_AT = 1_700_000_020_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describeDb("setWatchPartyKeepReplay concurrency", () => {
  let channelId: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    delete process.env.LIVE_HLS_RETENTION_MINUTES;
    delete process.env.LIVE_HLS_REPLAY_HOURS;
    await getPool().query(
      `TRUNCATE users, servers, channels, hls_sessions RESTART IDENTITY CASCADE`,
    );
    const user = await upsertUser({
      clerkId: "clerk_hls_history_concurrency",
      displayName: "Concurrency Tester",
      avatarUrl: null,
    });
    const server = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('test', $1) RETURNING id`,
      [user.id],
    );
    const channel = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position)
       VALUES ($1, 'watch', 'voice', 0) RETURNING id`,
      [server.rows[0]!.id],
    );
    channelId = channel.rows[0]!.id;
    await getPool().query(
      `INSERT INTO hls_sessions
         (channel_id, object_prefix, started_at, ended_at, keep_replay, rung)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), NOW() - interval '3 minutes', FALSE, '720p30')`,
      [channelId, `live/${channelId}/${STARTED_AT}-720p30`, STARTED_AT],
    );
  });

  it("blocks behind a concurrent cleanup holding the row lock, then sees the cleaned result", async () => {
    process.env.LIVE_HLS_RETENTION_MINUTES = "10";
    const cleaner = await getPool().connect();
    try {
      // Simulate `sweepHlsSessions` mid-cleanup: it has already decided this
      // row is due and is holding its lock, but has not committed yet.
      await cleaner.query("BEGIN");
      await cleaner.query(
        `SELECT id FROM hls_sessions WHERE channel_id = $1 FOR UPDATE`,
        [channelId],
      );

      const keepReplayCall = setWatchPartyKeepReplay(
        channelId,
        STARTED_AT,
        true,
      );

      // Give the call a moment to reach its own `FOR UPDATE` and block on
      // the cleaner's lock -- if it did NOT block, this proves nothing, so
      // the assertion after the release is what actually matters.
      await sleep(150);

      await cleaner.query(`UPDATE hls_sessions SET cleaned_at = NOW()`);
      await cleaner.query("COMMIT");

      const result = await keepReplayCall;
      expect(result).toBe("unavailable");

      const row = await getPool().query<{
        cleaned_at: Date | null;
        keep_replay: boolean;
      }>(`SELECT cleaned_at, keep_replay FROM hls_sessions WHERE channel_id = $1`, [
        channelId,
      ]);
      // The row stays cleaned AND keep_replay is untouched -- the write
      // never happened, which is the whole point.
      expect(row.rows[0]!.cleaned_at).not.toBeNull();
      expect(row.rows[0]!.keep_replay).toBe(false);
    } finally {
      cleaner.release();
    }
  });

  it("succeeds normally once the concurrent transaction rolls back instead", async () => {
    process.env.LIVE_HLS_RETENTION_MINUTES = "10";
    const other = await getPool().connect();
    try {
      await other.query("BEGIN");
      await other.query(
        `SELECT id FROM hls_sessions WHERE channel_id = $1 FOR UPDATE`,
        [channelId],
      );
      const keepReplayCall = setWatchPartyKeepReplay(
        channelId,
        STARTED_AT,
        true,
      );
      await sleep(150);
      // The other transaction changes its mind and never touches the row.
      await other.query("ROLLBACK");

      const result = await keepReplayCall;
      expect(result).toBe("ok");
    } finally {
      other.release();
    }
  });
});

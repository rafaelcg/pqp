import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * `reportQueueStats`: the 24 hour promise as a number. Rows are inserted by
 * hand with backdated `created_at` so every figure is known; nothing here goes
 * through `createReport`, which stamps NOW().
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { reportQueueStats } = await import("./report-queue.js");

describeDb("reportQueueStats against Postgres", () => {
  let reporter: string;
  let reported: string[];

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    const make = (name: string) =>
      upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null });
    const people = await Promise.all(["rep", "a", "b", "c", "d"].map(make));
    reporter = people[0]!.id;
    reported = people.slice(1).map((person) => person.id);
  });

  /** A user report filed from no place (instance queue), `hoursAgo` old. */
  async function file(
    target: string,
    hoursAgo: number,
    status: "open" | "actioned" | "dismissed" = "open",
    reporterId: string | null = reporter,
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO reports
         (reporter_id, subject_type, context_kind, reported_user_id, reason,
          status, resolved_by, resolved_at, created_at)
       VALUES ($1, 'user', 'none', $2, 'spam', $3,
               NULL,
               CASE WHEN $3 = 'open' THEN NULL ELSE NOW() END,
               NOW() - ($4 || ' hours')::interval)`,
      [reporterId, target, status, String(hoursAgo)],
    );
  }

  it("is all zeroes, never null, when there are no reports", async () => {
    expect(await reportQueueStats()).toEqual({
      open: 0,
      actioned: 0,
      dismissed: 0,
      last24h: 0,
      oldestOpenAgeSeconds: 0,
      openOver12h: 0,
      openOver24h: 0,
    });
  });

  it("reads the age of the OLDEST open report, not the newest", async () => {
    await file(reported[0]!, 30);
    await file(reported[1]!, 13);
    await file(reported[2]!, 1);
    const stats = await reportQueueStats();
    expect(stats.open).toBe(3);
    // 30 hours, give or take the milliseconds the test itself took.
    expect(stats.oldestOpenAgeSeconds).toBeGreaterThanOrEqual(30 * 3600);
    expect(stats.oldestOpenAgeSeconds).toBeLessThan(30 * 3600 + 60);
    expect(stats.openOver12h).toBe(2);
    expect(stats.openOver24h).toBe(1);
  });

  it("ignores a report that has been resolved, however old", async () => {
    await file(reported[0]!, 100, "actioned");
    await file(reported[1]!, 90, "dismissed");
    await file(reported[2]!, 2);
    const stats = await reportQueueStats();
    expect(stats.open).toBe(1);
    expect(stats.actioned).toBe(1);
    expect(stats.dismissed).toBe(1);
    expect(stats.oldestOpenAgeSeconds).toBeGreaterThanOrEqual(2 * 3600);
    expect(stats.oldestOpenAgeSeconds).toBeLessThan(2 * 3600 + 60);
    expect(stats.openOver12h).toBe(0);
    expect(stats.openOver24h).toBe(0);
  });

  it("drops to 0 the moment the last open one is closed", async () => {
    await file(reported[0]!, 50, "actioned");
    const stats = await reportQueueStats();
    expect(stats.open).toBe(0);
    expect(stats.oldestOpenAgeSeconds).toBe(0);
  });

  it("counts an automated report (no reporter) like any other", async () => {
    await file(reported[0]!, 26, "open", null);
    const stats = await reportQueueStats();
    expect(stats.open).toBe(1);
    expect(stats.openOver24h).toBe(1);
  });

  it("counts a report in a server's own queue, not only the instance's", async () => {
    const pool = getPool();
    const owner = reported[0]!;
    const { createServer: createChatServer } = await import("./servers.js");
    const created = await createChatServer("Mesa", owner);
    const channel = await pool.query<{ id: string }>(
      `SELECT id FROM channels WHERE server_id = $1 AND type = 'text' LIMIT 1`,
      [created.server.id],
    );
    // A user report filed inside a server carries that server's id.
    await pool.query(
      `INSERT INTO reports
         (reporter_id, subject_type, context_kind, reported_user_id, server_id,
          channel_id, reason, created_at)
       VALUES ($1, 'user', 'server', $2, $3, $4, 'harassment',
               NOW() - interval '25 hours')`,
      [reporter, reported[1], created.server.id, channel.rows[0]!.id],
    );
    const stats = await reportQueueStats();
    expect(stats.open).toBe(1);
    expect(stats.openOver24h).toBe(1);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * `sweepMessageRetention` runs unconditionally on the whole `servers` table,
 * so these drive real SQL against a real Postgres rather than mocking
 * anything — the thing worth proving is the WHERE clause itself: which rows
 * survive a sweep and which don't.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { sweepMessageRetention } = await import("./retention.js");

describeDb("sweepMessageRetention", () => {
  let userId: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(
      `TRUNCATE users, servers, channels, messages RESTART IDENTITY CASCADE`,
    );
    const user = await upsertUser({
      clerkId: "clerk_retention",
      displayName: "Retention Tester",
      avatarUrl: null,
    });
    userId = user.id;
  });

  async function makeServer(retentionDays: number | null) {
    const server = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id, message_retention_days)
       VALUES ('test', $1, $2) RETURNING id`,
      [userId, retentionDays],
    );
    const serverId = server.rows[0]!.id;
    const channel = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position) VALUES ($1, 'general', 'text', 0) RETURNING id`,
      [serverId],
    );
    return { serverId, channelId: channel.rows[0]!.id };
  }

  async function postMessage(
    channelId: string,
    options: { age: string; pinned?: boolean },
  ) {
    const result = await getPool().query<{ id: string }>(
      `INSERT INTO messages (channel_id, author_id, body, created_at, pinned_at, pinned_by)
       VALUES ($1, $2, 'hi', NOW() - $3::interval, $4, $5)
       RETURNING id`,
      [
        channelId,
        userId,
        options.age,
        options.pinned ? new Date() : null,
        options.pinned ? userId : null,
      ],
    );
    return result.rows[0]!.id;
  }

  async function messageIds(channelId: string): Promise<string[]> {
    const result = await getPool().query<{ id: string }>(
      `SELECT id FROM messages WHERE channel_id = $1`,
      [channelId],
    );
    return result.rows.map((row) => row.id);
  }

  it("deletes messages older than the server's retention window, and nothing newer", async () => {
    const { channelId } = await makeServer(30);
    await postMessage(channelId, { age: "31 days" });
    const recent = await postMessage(channelId, { age: "1 day" });

    const deleted = await sweepMessageRetention();
    expect(deleted).toBe(1);
    expect(await messageIds(channelId)).toEqual([recent]);
  });

  it("never touches a pinned message, no matter how old", async () => {
    const { channelId } = await makeServer(30);
    const pinned = await postMessage(channelId, { age: "10 years", pinned: true });

    await sweepMessageRetention();
    expect(await messageIds(channelId)).toEqual([pinned]);
  });

  it("leaves a server with no retention policy completely alone", async () => {
    const { channelId } = await makeServer(null);
    const ancient = await postMessage(channelId, { age: "10 years" });

    const deleted = await sweepMessageRetention();
    expect(deleted).toBe(0);
    expect(await messageIds(channelId)).toEqual([ancient]);
  });

  it("applies each server's own window independently", async () => {
    const strict = await makeServer(7);
    const lenient = await makeServer(365);
    await postMessage(strict.channelId, { age: "10 days" });
    const lenientSameAge = await postMessage(lenient.channelId, { age: "10 days" });

    await sweepMessageRetention();
    expect(await messageIds(strict.channelId)).toEqual([]);
    expect(await messageIds(lenient.channelId)).toEqual([lenientSameAge]);
  });
});

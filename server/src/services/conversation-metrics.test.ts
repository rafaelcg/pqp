import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbUser } from "../db.js";

/**
 * `conversations` on `GET /api/admin/metrics`, on a real Postgres.
 *
 * Rows are written with SQL at the ages each case needs, because the thing
 * under test is what the queries make of the tables. One case reads the whole
 * admin payload, so the block is proved to be wired, not only computed.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
delete process.env.CLUSTER_BUS;

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { openConversation } = await import("./dms.js");
const { createServer: createPqpServer } = await import("./servers.js");
const { conversationMetrics } = await import("./conversation-metrics.js");
const { getAdminMetrics, resetAdminMetricsCache } = await import("./metrics.js");

describeDb("conversation metrics", () => {
  let alice: DbUser;
  let bob: DbUser;
  let carol: DbUser;
  let dave: DbUser;
  let dm: string;
  let group: string;
  let serverChannel: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    resetAdminMetricsCache();
    await getPool().query(
      `TRUNCATE users, servers, channels, messages, server_members
       RESTART IDENTITY CASCADE`,
    );
    alice = await upsertUser({ clerkId: "clerk_alice", displayName: "Alice", avatarUrl: null });
    bob = await upsertUser({ clerkId: "clerk_bob", displayName: "Bob", avatarUrl: null });
    carol = await upsertUser({ clerkId: "clerk_carol", displayName: "Carol", avatarUrl: null });
    dave = await upsertUser({ clerkId: "clerk_dave", displayName: "Dave", avatarUrl: null });
    const created = await createPqpServer("Sala", alice.id);
    for (const member of [bob, carol, dave]) {
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [created.server.id, member.id],
      );
    }
    serverChannel = (
      await getPool().query<{ id: string }>(
        `SELECT id FROM channels WHERE server_id = $1 AND type = 'text' ORDER BY position LIMIT 1`,
        [created.server.id],
      )
    ).rows[0]!.id;
    dm = (await openConversation(alice.id, [bob.id])).channelId;
    group = (await openConversation(alice.id, [bob.id, carol.id])).channelId;
  });

  async function say(channel: string, author: DbUser, hoursAgo: number): Promise<void> {
    await getPool().query(
      `INSERT INTO messages (channel_id, author_id, body, created_at)
       VALUES ($1, $2, 'oi', now() - $3::interval)`,
      [channel, author.id, `${hoursAgo} hours`],
    );
  }

  it("counts distinct conversation senders over 1 and 7 days against everyone who wrote", async () => {
    await say(dm, alice, 1); // today, conversation
    await say(dm, alice, 2); // same person twice: still one
    await say(group, bob, 30); // this week, not today
    await say(serverChannel, carol, 1); // a server channel only: active, not a DM sender
    await say(dm, dave, 24 * 9); // older than a week: nowhere

    const metrics = await conversationMetrics();
    expect(metrics.senders1d).toBe(1);
    expect(metrics.senders7d).toBe(2);
    expect(metrics.activeSenders7d).toBe(3);
  });

  it("leaves out the house cast and webhooks", async () => {
    await getPool().query(`UPDATE users SET is_character = TRUE WHERE id = $1`, [bob.id]);
    await say(dm, bob, 1);
    const metrics = await conversationMetrics();
    expect(metrics.senders1d).toBe(0);
    expect(metrics.activeSenders7d).toBe(0);
  });

  it("counts conversations opened in the last 24 hours by kind, and a reopened 1:1 is not new", async () => {
    expect((await conversationMetrics()).created24h).toEqual({ dm: 1, group: 1 });
    // The same pair again: `dm_pairs` hands back the existing channel.
    await openConversation(bob.id, [alice.id]);
    expect((await conversationMetrics()).created24h).toEqual({ dm: 1, group: 1 });
    await getPool().query(
      `UPDATE channels SET created_at = now() - interval '2 days' WHERE id = $1`,
      [group],
    );
    expect((await conversationMetrics()).created24h).toEqual({ dm: 1, group: 0 });
  });

  it("asks of accounts 8 to 14 days old whether they sent a DM in their first week", async () => {
    await getPool().query(
      `UPDATE users SET created_at = now() - interval '10 days' WHERE id IN ($1, $2, $3)`,
      [alice.id, bob.id, carol.id],
    );
    // dave is brand new: outside the cohort whatever he does.
    await say(dm, alice, 24 * 9); // day 1 of alice's life, in a DM: counts
    await say(serverChannel, bob, 24 * 9); // bob only wrote in a server
    await say(group, carol, 24 * 1); // carol's DM came on day 9: too late
    await say(dm, dave, 1);

    const metrics = await conversationMetrics();
    expect(metrics.newcomers).toEqual({ eligible: 3, dmWithin7d: 1 });
  });

  it("rides on the admin metrics payload", async () => {
    await say(dm, alice, 1);
    const payload = await getAdminMetrics();
    expect(payload.conversations).toMatchObject({
      senders1d: 1,
      senders7d: 1,
      activeSenders7d: 1,
      created24h: { dm: 1, group: 1 },
    });
  });
});

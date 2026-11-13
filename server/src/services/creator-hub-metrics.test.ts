import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The creator-hub block of `GET /api/admin/metrics`: counts from tables that
 * already exist, and the two process counters a later change increments.
 * Seeded by hand so every number is known; the block's own 30 s cache is
 * dropped between cases.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer: createChatServer } = await import("./servers.js");
const {
  creatorHubMetrics,
  recordCreatorHubEvent,
  resetCreatorHubStatsForTests,
} = await import("./creator-hub-metrics.js");

describe("recordCreatorHubEvent", () => {
  beforeEach(() => resetCreatorHubStatsForTests());

  it("bumps the matching counter and nothing else", async () => {
    recordCreatorHubEvent("ctaView");
    recordCreatorHubEvent("ctaView");
    recordCreatorHubEvent("supportClick");
    const block = await creatorHubMetrics();
    expect(block.process).toEqual({ ctaViews: 2, supportClicks: 1 });
  });
});

describeDb("creatorHubMetrics against Postgres", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    resetCreatorHubStatsForTests();
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
  });

  it("is all zeroes, never null, on an empty database", async () => {
    const block = await creatorHubMetrics();
    expect(block.process).toEqual({ ctaViews: 0, supportClicks: 0 });
    expect(block.db).toEqual({
      servers: { bauOn: 0, withPosts: 0, withMembersOnlyPosts: 0, withVipHolders: 0 },
      posts: {
        total: 0,
        published: 0,
        membersOnly: 0,
        membersOnlyShare: null,
        published7d: 0,
      },
      vip: { holders: 0, topServers: [] },
      follows: {
        total: 0,
        active: 0,
        paused: 0,
        creators: 0,
        deliveries: { pending: 0, delivered: 0, retracted: 0, dead: 0, delivered7d: 0 },
      },
      joins7d: { total: 0, withRef: 0, bySource: {} },
    });
  });

  it("counts what the tables hold", async () => {
    const pool = getPool();
    const make = (name: string) =>
      upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null });
    const [owner, fan1, fan2, fan3] = await Promise.all(
      ["owner", "fan1", "fan2", "fan3"].map(make),
    );
    const creator = (await createChatServer("Criadora", owner!.id)).server.id;
    const plain = (await createChatServer("Mesa comum", owner!.id)).server.id;
    const target = (await createChatServer("Fã clube", owner!.id)).server.id;
    await pool.query(`UPDATE servers SET community_home_enabled = TRUE WHERE id = $1`, [
      creator,
    ]);

    // Posts: three published (one members-only), one draft.
    await pool.query(
      `INSERT INTO community_home_posts
         (server_id, author_id, title, body, visibility, status, published_at)
       VALUES ($1, $2, 'a', 'a', 'free', 'published', NOW()),
              ($1, $2, 'b', 'b', 'free', 'published', NOW() - interval '30 days'),
              ($1, $2, 'c', 'c', 'members', 'published', NOW()),
              ($1, $2, 'd', 'd', 'free', 'draft', NULL)`,
      [creator, owner!.id],
    );

    // VIP: two holders on the creator's server, one on the plain one.
    for (const [server, user] of [
      [creator, fan1],
      [creator, fan2],
      [plain, fan3],
    ] as const) {
      await pool.query(
        `INSERT INTO server_members (server_id, user_id, role, joined_at, join_source, join_ref)
         VALUES ($1, $2, 'member', NOW(), $3, $4) ON CONFLICT DO NOTHING`,
        [
          server,
          user!.id,
          server === creator ? "community_address" : "invite",
          user === fan2 ? "convite" : null,
        ],
      );
      await pool.query(
        `INSERT INTO member_roles (server_id, user_id, role_id)
         SELECT $1, $2, id FROM roles WHERE server_id = $1 AND system_key = 'vip'`,
        [server, user!.id],
      );
    }

    // Follows: one active, one paused, deliveries in two states.
    const channels = await pool.query<{ id: string; server_id: string }>(
      `SELECT DISTINCT ON (server_id) id, server_id FROM channels
        WHERE server_id = ANY($1) AND type = 'text' ORDER BY server_id, id`,
      [[target, plain]],
    );
    const follows: string[] = [];
    for (const [i, channel] of channels.rows.entries()) {
      const row = await pool.query<{ id: string }>(
        `INSERT INTO bau_follows
           (source_server_id, target_server_id, target_channel_id, created_by, paused_at, paused_reason)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          creator,
          target,
          channel.id,
          owner!.id,
          i === 0 ? null : new Date(),
          i === 0 ? null : "permissions",
        ],
      );
      follows.push(row.rows[0]!.id);
    }
    expect(follows.length).toBe(2);
    const post = await pool.query<{ id: string }>(
      `SELECT id FROM community_home_posts WHERE server_id = $1 LIMIT 1`,
      [creator],
    );
    await pool.query(
      `INSERT INTO bau_follow_deliveries (post_id, follow_id, source_server_id, status, delivered_at)
       VALUES ($1, $2, $3, 'delivered', NOW()), ($1, $4, $3, 'pending', NULL)`,
      [post.rows[0]!.id, follows[0], creator, follows[1]],
    );

    const block = await creatorHubMetrics();
    const db = block.db!;
    expect(db.servers).toEqual({
      bauOn: 1,
      withPosts: 1,
      withMembersOnlyPosts: 1,
      withVipHolders: 2,
    });
    expect(db.posts).toMatchObject({
      total: 4,
      published: 3,
      membersOnly: 1,
      published7d: 2,
    });
    expect(db.posts.membersOnlyShare).toBeCloseTo(1 / 3);
    expect(db.vip.holders).toBe(3);
    expect(db.vip.topServers.map((s) => [s.name, s.holders])).toEqual([
      ["Criadora", 2],
      ["Mesa comum", 1],
    ]);
    expect(db.follows).toMatchObject({ total: 2, active: 1, paused: 1, creators: 1 });
    expect(db.follows.deliveries).toEqual({
      pending: 1,
      delivered: 1,
      retracted: 0,
      dead: 0,
      delivered7d: 1,
    });
    // Joins count only servers whose Baú is on: the creator's two, one tagged.
    expect(db.joins7d).toEqual({
      total: 2,
      withRef: 1,
      bySource: { community_address: 2 },
    });
  });
});

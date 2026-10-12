import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * `GET /api/servers/:id/home/latest`, the sidebar preview, pinned where it
 * matters:
 *
 *   * `isNew` IS THE UNREAD RULE. The count and every post's flag come from
 *     one statement, own posts are never new, and opening the Baú clears both.
 *   * AUTHORIZED LIKE THE FEED. A stranger, a server with Baú off, the
 *     instance flag off and the preview's own flag off are all refused, and a
 *     draft or a post still scheduled for later never shows.
 *   * A LOCKED POST LEAKS NOTHING: no author, no body, no uploaded media.
 *   * VIP OFF HIDES members-only posts from the cards AND the count.
 *   * A blocked person's comment is not counted.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

let actor: { id: string; clerk_id: string } | null = null;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  resolveAuthSession: async () =>
    actor ? { user: actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("../api/index.js");
const { upsertUser } = await import("./users.js");
const { createServer: createChatServer } = await import("./servers.js");
const { communityHomeLatestResponseSchema, parseCommunityHomeLatestLimit } =
  await import("@pqp/shared");

let httpServer: Server;
let baseUrl: string;

type Person = { id: string; clerk_id: string };

async function call<T = Record<string, unknown>>(
  as: Person,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

type Latest = {
  unread: number;
  lastSeenAt: string | null;
  posts: Array<{
    postId: string;
    title: string | null;
    teaser: string | null;
    author: { id: string; displayName: string } | null;
    mediaKind: string | null;
    mediaUrl: string | null;
    locked: boolean;
    pinned: boolean;
    likeCount: number;
    commentCount: number;
    publishedAt: string | null;
    isNew: boolean;
  }>;
};

describe("parseCommunityHomeLatestLimit", () => {
  it("defaults, and clamps into 1..10 instead of refusing", () => {
    expect(parseCommunityHomeLatestLimit(null)).toBe(3);
    expect(parseCommunityHomeLatestLimit("banana")).toBe(3);
    expect(parseCommunityHomeLatestLimit("1")).toBe(1);
    expect(parseCommunityHomeLatestLimit("0")).toBe(1);
    expect(parseCommunityHomeLatestLimit("-4")).toBe(1);
    expect(parseCommunityHomeLatestLimit("99")).toBe(10);
  });
});

describeDb("Baú latest preview", () => {
  let owner: Person;
  let member: Person;
  let vip: Person;
  let stranger: Person;
  let serverId: string;

  beforeAll(async () => {
    await initDb();
    httpServer = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    resetApiRateLimits();
    process.env.COMMUNITY_HOME_ENABLED = "true";
    process.env.COMMUNITY_HOME_VIP_ENABLED = "true";
    delete process.env.BAU_LATEST_PREVIEW;

    const makeUser = (name: string) =>
      upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null });
    owner = await makeUser("owner");
    member = await makeUser("member");
    vip = await makeUser("vip");
    stranger = await makeUser("stranger");

    const created = await createChatServer("Mesa da Tues", owner.id);
    serverId = created.server.id;
    for (const person of [member, vip]) {
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role)
         VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
        [serverId, person.id],
      );
    }
    await getPool().query(
      `INSERT INTO member_roles (server_id, user_id, role_id)
       SELECT $1, $2, id FROM roles WHERE server_id = $1 AND system_key = 'vip'
       ON CONFLICT DO NOTHING`,
      [serverId, vip.id],
    );
    await getPool().query(
      `UPDATE servers SET community_home_enabled = TRUE WHERE id = $1`,
      [serverId],
    );
  });

  afterEach(() => {
    delete process.env.COMMUNITY_HOME_ENABLED;
    delete process.env.COMMUNITY_HOME_VIP_ENABLED;
    delete process.env.BAU_LATEST_PREVIEW;
  });

  const base = () => `/api/servers/${serverId}/home`;

  async function publish(post: Record<string, unknown>, as: Person = owner) {
    const res = await call<{ post: { id: string } }>(as, "POST", `${base()}/posts`, {
      status: "published",
      ...post,
    });
    expect(res.status).toBe(201);
    return res.body.post;
  }

  /** Published posts written straight to the table, `minutesAgo` apart. */
  async function seed(
    rows: Array<{ title: string; minutesAgo: number; author?: Person; visibility?: string }>,
  ): Promise<void> {
    for (const row of rows) {
      await getPool().query(
        `INSERT INTO community_home_posts
           (server_id, author_id, title, body, visibility, status, published_at)
         VALUES ($1, $2, $3, 'corpo', $4, 'published', NOW() - ($5 || ' minutes')::interval)`,
        [
          serverId,
          (row.author ?? owner).id,
          row.title,
          row.visibility ?? "free",
          String(row.minutesAgo),
        ],
      );
    }
  }

  async function latest(as: Person, query = ""): Promise<Latest> {
    const res = await call<Latest>(as, "GET", `${base()}/latest${query}`);
    expect(res.status).toBe(200);
    // The wire shape is the shared schema, so iOS and Android can follow it.
    expect(() => communityHomeLatestResponseSchema.parse(res.body)).not.toThrow();
    return res.body;
  }

  async function unreadCount(as: Person): Promise<number> {
    const res = await call<{ count: number }>(as, "GET", `${base()}/unread`);
    expect(res.status).toBe(200);
    return res.body.count;
  }

  it("an empty Baú answers zero, no stamp and no posts", async () => {
    expect(await latest(member)).toEqual({ unread: 0, lastSeenAt: null, posts: [] });
  });

  it("isNew is the unread rule: own posts never, opening the Baú clears both", async () => {
    await seed([
      { title: "velho", minutesAgo: 30 },
      { title: "do membro", minutesAgo: 20, author: member },
      { title: "novo", minutesAgo: 10 },
    ]);

    const first = await latest(member);
    expect(first.lastSeenAt).toBeNull();
    // Newest first.
    expect(first.posts.map((p) => [p.title, p.isNew])).toEqual([
      ["novo", true],
      ["do membro", false],
      ["velho", true],
    ]);
    expect(first.unread).toBe(2);
    // The badge's own endpoint agrees with the preview.
    expect(await unreadCount(member)).toBe(first.unread);
    expect(first.posts.filter((p) => p.isNew)).toHaveLength(first.unread);

    expect((await call(member, "POST", `${base()}/read`)).status).toBe(200);
    const seen = await latest(member);
    expect(seen.unread).toBe(0);
    expect(seen.lastSeenAt).not.toBeNull();
    expect(seen.posts.every((p) => !p.isNew)).toBe(true);
    // Seen posts stay: the row keeps showing the last one, just not as new.
    expect(seen.posts).toHaveLength(3);

    await publish({ title: "depois", body: "x" });
    const after = await latest(member);
    expect(after.unread).toBe(1);
    expect(after.posts[0]).toMatchObject({ title: "depois", isNew: true });
    expect(after.posts.slice(1).every((p) => !p.isNew)).toBe(true);
    expect(await unreadCount(member)).toBe(1);

    // The author's own post is never new to the author.
    const mine = await latest(owner);
    expect(mine.posts.find((p) => p.title === "depois")!.isNew).toBe(false);
    expect(mine.unread).toBe(await unreadCount(owner));
  });

  it("limits to 3 by default, honours ?limit=, and still counts every unread", async () => {
    await seed(
      Array.from({ length: 12 }, (_, i) => ({ title: `post ${i + 1}`, minutesAgo: i + 1 })),
    );
    const three = await latest(member);
    expect(three.posts.map((p) => p.title)).toEqual(["post 1", "post 2", "post 3"]);
    expect(three.unread).toBe(12);
    expect(three.posts.every((p) => p.isNew)).toBe(true);

    expect((await latest(member, "?limit=1")).posts).toHaveLength(1);
    expect((await latest(member, "?limit=50")).posts).toHaveLength(10);
  });

  it("does not move the pinned post to the front", async () => {
    await seed([
      { title: "antigo fixado", minutesAgo: 60 },
      { title: "recente", minutesAgo: 1 },
    ]);
    const pinned = await getPool().query<{ id: string }>(
      `SELECT id FROM community_home_posts WHERE title = 'antigo fixado'`,
    );
    expect(
      (
        await call(owner, "POST", `${base()}/posts/${pinned.rows[0]!.id}/pin`, {
          pinned: true,
        })
      ).status,
    ).toBe(200);
    const res = await latest(member);
    expect(res.posts.map((p) => [p.title, p.pinned])).toEqual([
      ["recente", false],
      ["antigo fixado", true],
    ]);
  });

  it("leaves drafts and posts scheduled for later out", async () => {
    await publish({ title: "no ar", body: "x" });
    await call(owner, "POST", `${base()}/posts`, {
      status: "draft",
      title: "rascunho",
      body: "x",
    });
    await getPool().query(
      `INSERT INTO community_home_posts
         (server_id, author_id, title, body, status, scheduled_at)
       VALUES ($1, $2, 'mais tarde', 'x', 'scheduled', NOW() + interval '1 day')`,
      [serverId, owner.id],
    );
    const res = await latest(member);
    expect(res.posts.map((p) => p.title)).toEqual(["no ar"]);
    expect(res.unread).toBe(1);
  });

  it("a members-only post is locked for a member: no author, no body, no media", async () => {
    await publish({
      title: "Só VIP",
      body: "o segredo inteiro",
      teaser: "dá uma olhada",
      visibility: "members",
      youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
    });
    const res = await latest(member);
    const card = res.posts[0]!;
    expect(card.locked).toBe(true);
    expect(card.author).toBeNull();
    expect(card.title).toBe("Só VIP");
    expect(card.teaser).toBe("dá uma olhada");
    // Only the public YouTube poster ever reaches a locked reader, as in chat.
    expect(card.mediaKind).toBe("youtube");
    expect(card.mediaUrl).toMatch(/^https:\/\/i\.ytimg\.com\//);
    expect(JSON.stringify(res)).not.toContain("o segredo inteiro");
    // Still counts as new: the feed draws the lock, so the badge may promise it.
    expect(card.isNew).toBe(true);
    expect(res.unread).toBe(1);

    const unlocked = await latest(vip);
    expect(unlocked.posts[0]!.locked).toBe(false);
    expect(unlocked.posts[0]!.author?.displayName).toBe("owner");
  });

  it("with VIP off, members-only posts are neither shown nor counted", async () => {
    await seed([
      { title: "livre", minutesAgo: 10 },
      { title: "vip", minutesAgo: 5, visibility: "members" },
    ]);
    expect((await latest(member)).unread).toBe(2);

    process.env.COMMUNITY_HOME_VIP_ENABLED = "false";
    for (const viewer of [member, vip, owner]) {
      const res = await latest(viewer);
      expect(res.posts.map((p) => p.title)).toEqual(["livre"]);
    }
    expect((await latest(member)).unread).toBe(1);
    expect(await unreadCount(member)).toBe(1);
  });

  it("does not count a comment from someone the viewer blocked", async () => {
    const post = await publish({ title: "Papo", body: "x" });
    await call(member, "POST", `${base()}/posts/${post.id}/comments`, { body: "um" });
    await call(vip, "POST", `${base()}/posts/${post.id}/comments`, { body: "dois" });
    expect((await latest(member)).posts[0]!.commentCount).toBe(2);
    expect((await call(member, "POST", "/api/blocks", { userId: vip.id })).status).toBeLessThan(
      300,
    );
    expect((await latest(member)).posts[0]!.commentCount).toBe(1);
    expect((await latest(vip)).posts[0]!.commentCount).toBe(2);
  });

  it("refuses a stranger, a server with Baú off, and either flag off", async () => {
    await publish({ title: "x", body: "y" });

    const outsider = await call(stranger, "GET", `${base()}/latest`);
    expect(outsider.status).toBeGreaterThanOrEqual(403);
    expect(outsider.status).toBeLessThanOrEqual(404);

    process.env.BAU_LATEST_PREVIEW = "off";
    expect((await call(member, "GET", `${base()}/latest`)).status).toBe(404);
    // The fallback the client takes still answers.
    expect(await unreadCount(member)).toBe(1);
    delete process.env.BAU_LATEST_PREVIEW;
    expect((await call(member, "GET", `${base()}/latest`)).status).toBe(200);

    await getPool().query(
      `UPDATE servers SET community_home_enabled = FALSE WHERE id = $1`,
      [serverId],
    );
    expect((await call(member, "GET", `${base()}/latest`)).status).toBe(404);

    await getPool().query(
      `UPDATE servers SET community_home_enabled = TRUE WHERE id = $1`,
      [serverId],
    );
    delete process.env.COMMUNITY_HOME_ENABLED;
    expect((await call(member, "GET", `${base()}/latest`)).status).toBe(404);
  });

  it("walks the feed index for the newest posts", async () => {
    await seed(Array.from({ length: 20 }, (_, i) => ({ title: `p${i}`, minutesAgo: i })));
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      // A table this small would be scanned anyway; take that option away to
      // ask whether the index CAN serve the query, which is what production
      // needs once a server has thousands of posts.
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT p.id FROM community_home_posts p
          WHERE p.server_id = $1 AND p.status = 'published'
          ORDER BY p.published_at DESC, p.id DESC LIMIT 3`,
        [serverId],
      );
      await client.query("ROLLBACK");
      const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(text).toContain("idx_community_home_posts_feed");
      expect(text).not.toMatch(/^\s*->\s*Sort\b/m);
    } finally {
      client.release();
    }
  });
});

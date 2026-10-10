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
 * The push for a new Baú post (`bau_post_push`), on a real Postgres with only
 * the identity layer, the vendor transport and the socket probe stubbed.
 *
 * What is pinned is WHO is told and WHEN, because that is the whole risk of the
 * feature: it is the one Baú surface that interrupts people who are not
 * looking. The author is never told; a muted server is never told; a
 * members-only post reaches only the people who can open it; the flag off sends
 * nothing and, as importantly, does not queue the post up to be announced the
 * day the flag goes on; and a post is announced exactly once however many
 * times the claim runs.
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
const { savePushSubscription, setLiveSocketProbeForTests, setPushSenderForTests } =
  await import("./push.js");
const {
  pushPendingCommunityHomePosts,
  BAU_PUSH_FRESH_MS,
  BAU_PUSH_CLAIM_BATCH,
} = await import(
  "./community-home-push.js"
);
const { publishDueCommunityHomePosts } = await import("./community-home.js");
const { pushSkippedSnapshot, resetPushSkips } = await import("./push-skips.js");
const { blockUser } = await import("./blocks.js");
const { buildCommunityHomePostPushCopy } = await import("./push-copy.js");

type Person = { id: string; clerk_id: string };
type Sent = {
  userId: string;
  payload: { title: string; body: string; path: string; tag: string };
};

describe("the notice's copy", () => {
  it("is a sentence about one post and a count for several, in three languages", () => {
    const one = { serverName: "Filminho", titles: ["Regras novas"] };
    expect(buildCommunityHomePostPushCopy({ locale: "pt-BR", ...one })).toEqual({
      title: "Baú",
      body: "Post novo no Baú do Filminho: Regras novas",
    });
    expect(buildCommunityHomePostPushCopy({ locale: "en", ...one }).body).toBe(
      "New post in Filminho's Baú: Regras novas",
    );
    expect(buildCommunityHomePostPushCopy({ locale: "es", ...one }).body).toBe(
      "Post nuevo en el Baú de Filminho: Regras novas",
    );
    const many = { serverName: "Filminho", titles: ["a", null, "c"] };
    expect(buildCommunityHomePostPushCopy({ locale: "pt-BR", ...many }).body).toBe(
      "3 posts novos no Baú do Filminho",
    );
    expect(
      buildCommunityHomePostPushCopy({
        locale: "pt-BR",
        serverName: "Filminho",
        titles: [null],
      }).body,
    ).toBe("Post novo no Baú do Filminho");
  });

  it("uses no em dash", () => {
    for (const locale of ["pt-BR", "en", "es"] as const) {
      for (const titles of [[null], ["x"], ["x", "y"]]) {
        const { title, body } = buildCommunityHomePostPushCopy({
          locale,
          serverName: "S",
          titles,
        });
        expect(`${title}${body}`).not.toContain("—");
      }
    }
  });
});

describeDb("Baú new post push", () => {
  let httpServer: Server;
  let baseUrl: string;
  let owner: Person;
  let member: Person;
  let vip: Person;
  let other: Person;
  let serverId: string;
  let sent: Sent[];
  let online: Set<string>;

  async function call<T = Record<string, unknown>>(
    as: Person,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    actor = as;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
  }

  async function subscribe(userId: string): Promise<void> {
    await savePushSubscription(userId, {
      endpoint: `https://push.example.test/${userId}`,
      keys: { p256dh: "p", auth: "a" },
    });
  }

  /** A published post that nobody has announced yet, inserted directly. */
  async function insertPublished(
    fields: {
      title?: string | null;
      visibility?: "free" | "members";
      authorId?: string;
      publishedAt?: Date;
    } = {},
  ): Promise<string> {
    const res = await getPool().query<{ id: string }>(
      `INSERT INTO community_home_posts
         (server_id, author_id, title, body, visibility, status, published_at)
       VALUES ($1, $2, $3, 'corpo', $4, 'published', $5)
       RETURNING id`,
      [
        serverId,
        fields.authorId ?? owner.id,
        fields.title === undefined ? "Regras novas" : fields.title,
        fields.visibility ?? "free",
        fields.publishedAt ?? new Date(),
      ],
    );
    return res.rows[0]!.id;
  }

  async function setSettings(userId: string, settings: object): Promise<void> {
    await getPool().query(
      `INSERT INTO user_preferences (user_id, settings) VALUES ($1, $2::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET settings = EXCLUDED.settings`,
      [userId, JSON.stringify(settings)],
    );
  }

  const told = () => sent.map((s) => s.userId).sort();

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
    resetPushSkips();
    process.env.COMMUNITY_HOME_ENABLED = "true";
    process.env.COMMUNITY_HOME_VIP_ENABLED = "true";
    process.env.BAU_POST_PUSH = "true";
    process.env.VAPID_PUBLIC_KEY = "test-public-key";
    process.env.VAPID_PRIVATE_KEY = "test-private-key";
    process.env.VAPID_SUBJECT = "mailto:push@example.test";

    const makeUser = (name: string) =>
      upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null });
    owner = await makeUser("owner");
    member = await makeUser("member");
    vip = await makeUser("vip");
    other = await makeUser("other");
    const created = await createChatServer("Mesa da Tues", owner.id);
    serverId = created.server.id;
    for (const person of [member, vip, other]) {
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
    // The owner's own switch for this server.
    await getPool().query(
      `UPDATE servers SET community_home_enabled = TRUE WHERE id = $1`,
      [serverId],
    );
    for (const person of [owner, member, vip, other]) {
      await subscribe(person.id);
    }

    sent = [];
    online = new Set();
    setPushSenderForTests(async (subscription, payload) => {
      sent.push({
        userId: subscription.user_id,
        payload: JSON.parse(payload) as Sent["payload"],
      });
    });
    setLiveSocketProbeForTests((userId) => online.has(userId));
  });

  afterEach(() => {
    setPushSenderForTests(null);
    setLiveSocketProbeForTests(null);
    for (const name of [
      "COMMUNITY_HOME_ENABLED",
      "COMMUNITY_HOME_VIP_ENABLED",
      "BAU_POST_PUSH",
      "VAPID_PUBLIC_KEY",
      "VAPID_PRIVATE_KEY",
      "VAPID_SUBJECT",
    ]) {
      delete process.env[name];
    }
  });

  it("tells everybody but the author, in their language, with a path that opens the Baú", async () => {
    await setSettings(other.id, { locale: "en" });
    await insertPublished({ title: "Regras novas" });

    const pushed = await pushPendingCommunityHomePosts(serverId);

    expect(pushed).toBe(3);
    expect(told()).toEqual([member.id, vip.id, other.id].sort());
    const forMember = sent.find((s) => s.userId === member.id)!;
    expect(forMember.payload).toEqual({
      title: "Baú",
      body: "Post novo no Baú do Mesa da Tues: Regras novas",
      path: `/app/server/${serverId}/home`,
      tag: `bau:${serverId}`,
    });
    expect(sent.find((s) => s.userId === other.id)!.payload.body).toBe(
      "New post in Mesa da Tues's Baú: Regras novas",
    );
  });

  it("is wired to the publish route, and the author's own publish never reaches the author", async () => {
    const res = await call(owner, "POST", `/api/servers/${serverId}/home/posts`, {
      title: "Pelo caminho de verdade",
      body: "corpo",
      status: "published",
    });
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(sent.length).toBe(3));
    expect(told()).not.toContain(owner.id);
  });

  it("with the flag off sends nothing, and does not queue the post for the day it goes on", async () => {
    delete process.env.BAU_POST_PUSH;
    const id = await insertPublished();

    expect(await pushPendingCommunityHomePosts(serverId)).toBe(0);
    expect(sent).toEqual([]);
    const stamped = await getPool().query(
      `SELECT push_claimed_at FROM community_home_posts WHERE id = $1`,
      [id],
    );
    expect(stamped.rows[0].push_claimed_at).not.toBeNull();

    process.env.BAU_POST_PUSH = "true";
    expect(await pushPendingCommunityHomePosts(serverId)).toBe(0);
    expect(sent).toEqual([]);
  });

  it("announces a post once however many times the claim runs, unpublish and republish included", async () => {
    const id = await insertPublished();
    await pushPendingCommunityHomePosts(serverId);
    await pushPendingCommunityHomePosts();
    expect(sent.length).toBe(3);

    await getPool().query(
      `UPDATE community_home_posts SET status = 'draft' WHERE id = $1`,
      [id],
    );
    await pushPendingCommunityHomePosts();
    await getPool().query(
      `UPDATE community_home_posts SET status = 'published' WHERE id = $1`,
      [id],
    );
    await pushPendingCommunityHomePosts();
    expect(sent.length).toBe(3);
  });

  it("two machines claiming at the same moment announce it once", async () => {
    await insertPublished();
    const results = await Promise.all([
      pushPendingCommunityHomePosts(serverId),
      pushPendingCommunityHomePosts(serverId),
      pushPendingCommunityHomePosts(),
    ]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(3);
    expect(sent.length).toBe(3);
  });

  it("a muted server is not told, and the skip is counted", async () => {
    await setSettings(member.id, { notifications: { servers: { [serverId]: "none" } } });
    await setSettings(other.id, { notifications: { default: "none" } });
    await insertPublished();

    await pushPendingCommunityHomePosts(serverId);

    expect(told()).toEqual([vip.id]);
    expect(pushSkippedSnapshot().bau.muted).toBe(2);
  });

  it("honours an explicit 'only mentions' for this server, not the account-wide default", async () => {
    await setSettings(member.id, { notifications: { servers: { [serverId]: "mentions" } } });
    // The default `desktop_notify_default_on` writes for servers: not a mute.
    await setSettings(other.id, { notifications: { serverDefault: "mentions" } });
    await insertPublished();

    await pushPendingCommunityHomePosts(serverId);

    expect(told()).toEqual([vip.id, other.id].sort());
    expect(pushSkippedSnapshot().bau.level).toBe(1);
  });

  it("respects do-not-disturb and a socket in front of the person", async () => {
    await setSettings(member.id, { status: "dnd" });
    online.add(vip.id);
    await insertPublished();

    await pushPendingCommunityHomePosts(serverId);

    expect(told()).toEqual([other.id]);
    const skipped = pushSkippedSnapshot().bau;
    expect(skipped.dnd).toBe(1);
    expect(skipped.live_socket).toBe(1);
  });

  it("a members-only post reaches only the people who can open it", async () => {
    await insertPublished({ visibility: "members", title: "So pra VIP" });

    await pushPendingCommunityHomePosts(serverId);

    // The owner is the author; `member` and `other` would see a lock.
    expect(told()).toEqual([vip.id]);
  });

  it("a manager who is not the author is told about a members-only post", async () => {
    await getPool().query(
      `UPDATE server_members SET role = 'admin' WHERE server_id = $1 AND user_id = $2`,
      [serverId, member.id],
    );
    await insertPublished({ visibility: "members" });

    await pushPendingCommunityHomePosts(serverId);

    expect(told()).toEqual([member.id, vip.id].sort());
  });

  it("with the VIP flag off a members-only post is not announced at all", async () => {
    delete process.env.COMMUNITY_HOME_VIP_ENABLED;
    await insertPublished({ visibility: "members" });

    expect(await pushPendingCommunityHomePosts(serverId)).toBe(0);
    expect(sent).toEqual([]);
  });

  it("somebody who blocked the author is not told", async () => {
    await blockUser(member.id, owner.id);
    await insertPublished();

    await pushPendingCommunityHomePosts(serverId);

    expect(told()).toEqual([vip.id, other.id].sort());
    expect(pushSkippedSnapshot().bau.blocked).toBe(1);
  });

  it("a burst is one push per person that says how many, under one tag", async () => {
    await insertPublished({ title: "Um", publishedAt: new Date(Date.now() - 2000) });
    await insertPublished({ title: "Dois", publishedAt: new Date(Date.now() - 1000) });

    await pushPendingCommunityHomePosts(serverId);

    expect(sent.length).toBe(3);
    expect(sent[0]!.payload.body).toBe("2 posts novos no Baú do Mesa da Tues");
    expect(new Set(sent.map((s) => s.payload.tag))).toEqual(new Set([`bau:${serverId}`]));
  });

  it("a scheduled post announces when it goes live: by the sweep, or by a read's catch-up", async () => {
    const created = await call<{ post: { id: string } }>(
      owner,
      "POST",
      `/api/servers/${serverId}/home/posts`,
      {
        title: "Agendado",
        body: "corpo",
        status: "scheduled",
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
        scheduleTimezone: "UTC",
      },
    );
    expect(created.status).toBe(201);
    // Nothing yet: it is not published.
    await pushPendingCommunityHomePosts();
    expect(sent).toEqual([]);

    await getPool().query(
      `UPDATE community_home_posts SET scheduled_at = NOW() - INTERVAL '1 minute'
        WHERE id = $1`,
      [created.body.post.id],
    );
    // A member opens the unread count first: the read-time catch-up flips it
    // and the sweep's own publish finds nothing to do. The claim still sees it.
    await call(member, "GET", `/api/servers/${serverId}/home/unread`);
    expect(await publishDueCommunityHomePosts()).toEqual([]);

    await pushPendingCommunityHomePosts();
    expect(told()).toEqual([member.id, vip.id, other.id].sort());
    expect(sent[0]!.payload.body).toContain("Agendado");
  });

  it("a stale unannounced post is stamped and never announced", async () => {
    const id = await insertPublished({
      publishedAt: new Date(Date.now() - BAU_PUSH_FRESH_MS - 60_000),
    });

    expect(await pushPendingCommunityHomePosts(serverId)).toBe(0);
    expect(sent).toEqual([]);
    const stamped = await getPool().query(
      `SELECT push_claimed_at FROM community_home_posts WHERE id = $1`,
      [id],
    );
    expect(stamped.rows[0].push_claimed_at).not.toBeNull();
  });

  it("hands the claim back when the fan-out fails before anything was sent, then delivers on the next tick", async () => {
    const id = await insertPublished();
    const pool = getPool();
    const real = pool.query.bind(pool);
    let failuresLeft = 1;
    const spy = vi.spyOn(pool, "query").mockImplementation(((text: unknown, ...rest: unknown[]) => {
      if (
        failuresLeft > 0 &&
        typeof text === "string" &&
        text.includes("FROM user_preferences")
      ) {
        failuresLeft -= 1;
        return Promise.reject(new Error("connection terminated"));
      }
      return (real as (...args: unknown[]) => unknown)(text, ...rest);
    }) as never);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await pushPendingCommunityHomePosts(serverId)).toBe(0);
    } finally {
      spy.mockRestore();
      quiet.mockRestore();
    }
    expect(sent).toEqual([]);
    const row = await getPool().query(
      `SELECT push_claimed_at FROM community_home_posts WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].push_claimed_at).toBeNull();

    expect(await pushPendingCommunityHomePosts(serverId)).toBe(3);
    expect(sent.length).toBe(3);
  });

  it("hands the claim back when the subscription read fails, since no device was reached", async () => {
    const id = await insertPublished();
    const pool = getPool();
    const real = pool.query.bind(pool);
    let failuresLeft = 1;
    const spy = vi.spyOn(pool, "query").mockImplementation(((text: unknown, ...rest: unknown[]) => {
      if (
        failuresLeft > 0 &&
        typeof text === "string" &&
        text.includes("FROM push_subscriptions")
      ) {
        failuresLeft -= 1;
        return Promise.reject(new Error("connection terminated"));
      }
      return (real as (...args: unknown[]) => unknown)(text, ...rest);
    }) as never);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await pushPendingCommunityHomePosts(serverId);
    } finally {
      spy.mockRestore();
      quiet.mockRestore();
    }
    expect(sent).toEqual([]);
    const row = await getPool().query(
      `SELECT push_claimed_at FROM community_home_posts WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].push_claimed_at).toBeNull();
    expect(await pushPendingCommunityHomePosts(serverId)).toBe(3);
  });

  it("works a backlog off a bounded batch at a time, and stamps stale posts without announcing them", async () => {
    await getPool().query(
      `INSERT INTO community_home_posts
         (server_id, author_id, title, body, status, published_at)
       SELECT $1, $2, 'p' || g, 'corpo', 'published', NOW()
         FROM generate_series(1, $3) g`,
      [serverId, owner.id, BAU_PUSH_CLAIM_BATCH + 5],
    );
    await getPool().query(
      `INSERT INTO community_home_posts
         (server_id, author_id, title, body, status, published_at)
       SELECT $1, $2, 'velho' || g, 'corpo', 'published', NOW() - INTERVAL '3 hours'
         FROM generate_series(1, 10) g`,
      [serverId, owner.id],
    );
    const unannounced = async () =>
      Number(
        (
          await getPool().query(
            `SELECT COUNT(*)::int AS n FROM community_home_posts
              WHERE push_claimed_at IS NULL`,
          )
        ).rows[0].n,
      );

    await pushPendingCommunityHomePosts(serverId);
    // The stale ten are stamped for good; one batch of the fresh ones went out.
    expect(await unannounced()).toBe(5);
    expect(sent[0]!.payload.body).toBe(
      `${BAU_PUSH_CLAIM_BATCH} posts novos no Baú do Mesa da Tues`,
    );

    sent.length = 0;
    await pushPendingCommunityHomePosts(serverId);
    expect(await unannounced()).toBe(0);
    expect(sent[0]!.payload.body).toBe("5 posts novos no Baú do Mesa da Tues");
  });

  it("a server whose owner turned the Baú off announces nothing", async () => {
    await getPool().query(
      `UPDATE servers SET community_home_enabled = FALSE WHERE id = $1`,
      [serverId],
    );
    await insertPublished();
    expect(await pushPendingCommunityHomePosts(serverId)).toBe(0);
    expect(sent).toEqual([]);
  });

  it("the per-server override turns it on for one server while the global answer is off", async () => {
    delete process.env.BAU_POST_PUSH;
    await getPool().query(
      `INSERT INTO feature_flag_overrides (key, server_id, enabled) VALUES ('bau_post_push', $1, TRUE)`,
      [serverId],
    );
    const flags = await import("../lib/flags.js");
    await flags.startFeatureFlags();
    try {
      await insertPublished();
      await pushPendingCommunityHomePosts(serverId);
      expect(sent.length).toBe(3);
    } finally {
      await getPool().query(`DELETE FROM feature_flag_overrides`);
      flags.resetFeatureFlagsForTests();
    }
  });

  it("the whole instance flag off means no pushes at all, and no stamping", async () => {
    delete process.env.COMMUNITY_HOME_ENABLED;
    const id = await insertPublished();
    expect(await pushPendingCommunityHomePosts(serverId)).toBe(0);
    const row = await getPool().query(
      `SELECT push_claimed_at FROM community_home_posts WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].push_claimed_at).toBeNull();
  });

  describe("GET /api/community-home/unread", () => {
    it("counts every server the viewer is in at once, own posts and Baú-off servers left out", async () => {
      await insertPublished({ title: "um" });
      await insertPublished({ title: "dois" });
      await insertPublished({ title: "meu", authorId: member.id });
      const second = await createChatServer("Segunda", owner.id);
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [second.server.id, member.id],
      );
      // Baú is off on the second server: its post must not show up.
      await getPool().query(
        `INSERT INTO community_home_posts (server_id, author_id, title, body, status, published_at)
         VALUES ($1, $2, 'x', 'y', 'published', NOW())`,
        [second.server.id, owner.id],
      );

      const res = await call<{ servers: Record<string, number> }>(
        member,
        "GET",
        "/api/community-home/unread",
      );
      expect(res.status).toBe(200);
      expect(res.body.servers).toEqual({ [serverId]: 2 });

      // Opening the feed clears it.
      await call(member, "POST", `/api/servers/${serverId}/home/read`);
      const after = await call<{ servers: Record<string, number> }>(
        member,
        "GET",
        "/api/community-home/unread",
      );
      expect(after.body.servers).toEqual({});
    });

    it("404s with the instance flag off", async () => {
      delete process.env.COMMUNITY_HOME_ENABLED;
      expect((await call(member, "GET", "/api/community-home/unread")).status).toBe(404);
    });
  });
});

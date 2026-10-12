import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Forum channels PR 2: the guards every existing path needs before a forum
 * exists in production. Each one is pinned on a real Postgres, against the
 * rows a forum really leaves (a `forum` channel, posts that are `thread`
 * channels with a `forum_posts` row and a NULL root), written here by hand so
 * none of this depends on the forum service itself:
 *
 *   * THE SEND PATH. A message to a forum id is refused (`no-access`); a reply
 *     in a locked post is refused (`locked`) unless the sender is staff on the
 *     forum; a chat thread is untouched.
 *   * UNREAD. Posts get no row; the forum's row counts new posts by others
 *     after the forum cursor and the viewer's mentions inside posts after
 *     each post's cursor; and a forum of 500 posts and 10,000 messages answers
 *     the same number of rows as an empty one.
 *   * DELETE. A forum with 200 posts reads every attachment key in ONE query.
 *   * POSITIONS. A forum is numbered with the text channels.
 *   * RETENTION keeps a post's opening message.
 *   * SEARCH says which forum a hit inside a post belongs to.
 *   * THE GENERIC CHANNEL ROUTES refuse a forum post.
 *   * WEBHOOKS. An execute into a forum never writes a message into the
 *     forum row (with the flag off it is refused; forum PR 4's own tests,
 *     `api/forum-webhooks.test.ts`, cover the post it makes with the flag
 *     on); a webhook cannot be created on a category or a voice room.
 *   * MESSAGE DELETE is scoped to the message's channel.
 *   * AUTOMOD's channel exemption covers the channel's posts and threads.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const stubs = vi.hoisted(() => ({
  actor: null as { id: string; clerk_id: string } | null,
  storage: false,
  deletedKeys: [] as string[],
}));

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  forgetAuthUser: () => {},
  deleteClerkUser: async () => {},
  resolveAuthUser: async () => (stubs.actor ? { user: stubs.actor } : null),
  resolveAuthSession: async () =>
    stubs.actor ? { user: stubs.actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

// Storage "configured" only where a case asks for it, and deletes recorded
// instead of sent, so the delete case can count the key read without a bucket.
vi.mock("../lib/s3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/s3.js")>();
  return {
    ...actual,
    isStorageConfigured: () => stubs.storage,
    deleteObject: async (key: string) => {
      stubs.deletedKeys.push(key);
    },
  };
});

const { handleApi, resetApiRateLimits } = await import("../api/index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser, listUnread, markChannelRead } = await import("./users.js");
const {
  createServer: createPqpServer,
  createChannel,
  deleteChannel,
  moveChannel,
} = await import("./servers.js");
const chat = await import("../ws/chat.js");
const { postChannelMessage } = chat;
// Forum PR 1 bumps a post off the send path and exports this to wait for it.
// Read off the namespace so this file runs with or without PR 1 underneath;
// once PR 1 is on main it is always there.
const settleForumBumps =
  (chat as { settleForumBumps?: () => Promise<void> }).settleForumBumps ??
  (async () => {});
const { sweepMessageRetention } = await import("./retention.js");
const { searchMessages } = await import("./search.js");
const { assignRole, createRole, upsertChannelOverwrite } = await import("./roles.js");
const { createAutomodRule } = await import("./automod.js");
const { blockUser } = await import("./blocks.js");
const { createWebhook } = await import("./webhooks.js");
const { Permission, WEBHOOK_FORUM_THREAD_NAME_CODE } = await import("@pqp/shared");

type Account = Awaited<ReturnType<typeof upsertUser>>;

let http: Server;
let baseUrl: string;
let alice: Account; // owner
let bob: Account; // member
let carol: Account; // member
let serverId: string;
let generalId: string;
let forumId: string;

async function call(
  as: Account,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  stubs.actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: "Bearer test",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

async function insertForum(name = "ajuda"): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO channels (server_id, name, type, position)
     VALUES ($1, $2, 'forum', 50) RETURNING id`,
    [serverId, name],
  );
  return result.rows[0]!.id;
}

async function insertMessage(
  channelId: string,
  authorId: string,
  body: string,
  age = "0 seconds",
): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO messages (channel_id, author_id, body, created_at)
     VALUES ($1, $2, $3, NOW() - $4::interval) RETURNING id`,
    [channelId, authorId, body, age],
  );
  return result.rows[0]!.id;
}

/** A post as the forum service leaves it: thread channel, side row, opening message. */
async function insertPost(
  forum: string,
  author: Account,
  options: { title?: string; locked?: boolean; published?: boolean; age?: string } = {},
): Promise<{ postId: string; openingId: string }> {
  const age = options.age ?? "0 seconds";
  const channel = await getPool().query<{ id: string }>(
    `INSERT INTO channels (server_id, name, type, position, kind, parent_id, thread_root_message_id)
     VALUES ($1, $2, 'thread', 0, 'server', $3, NULL) RETURNING id`,
    [serverId, options.title ?? "Notebook não liga", forum],
  );
  const postId = channel.rows[0]!.id;
  const openingId = await insertMessage(postId, author.id, "o que eu tentei", age);
  await getPool().query(
    `INSERT INTO forum_posts
       (channel_id, forum_id, author_id, opening_message_id, created_at,
        published_at, last_activity_at, locked_at)
     VALUES ($1, $2, $3, $4, NOW() - $5::interval,
             CASE WHEN $6 THEN NOW() - $5::interval END, NOW() - $5::interval,
             CASE WHEN $7 THEN NOW() END)`,
    [postId, forum, author.id, openingId, age, options.published ?? true, options.locked ?? false],
  );
  return { postId, openingId };
}

async function insertChatThread(parentId: string, author: Account): Promise<string> {
  const root = await insertMessage(parentId, author.id, "puxa um fio");
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO channels (server_id, name, type, position, kind, parent_id, thread_root_message_id)
     VALUES ($1, 'fio', 'thread', 0, 'server', $2, $3) RETURNING id`,
    [serverId, parentId, root],
  );
  return result.rows[0]!.id;
}

async function joinServer(user: Account) {
  await getPool().query(
    `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
    [serverId, user.id],
  );
}

async function giveCargo(user: Account, permissions: bigint, onChannel?: string) {
  const role = await createRole(serverId, {
    name: `cargo_${Math.random().toString(36).slice(2, 8)}`,
    permissions: onChannel ? 0n : permissions,
  });
  await assignRole(serverId, user.id, role.id);
  if (onChannel) {
    await upsertChannelOverwrite(onChannel, serverId, "role", role.id, permissions, 0n);
  }
}

function unreadOf(rows: Awaited<ReturnType<typeof listUnread>>, channelId: string) {
  return rows.find((row) => row.channelId === channelId);
}

describeDb("forum guards", () => {
  beforeAll(async () => {
    await initDb();
    http = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => http.listen(0, done));
    baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => http.close(() => done()));
    await closePool();
  });

  beforeEach(async () => {
    // A reply in a post bumps it off the send path (forum PR 1); a bump still
    // in flight from the previous test deadlocks the TRUNCATE below.
    await settleForumBumps();
    resetApiRateLimits();
    stubs.storage = false;
    stubs.deletedKeys = [];
    await getPool().query(`TRUNCATE users, servers RESTART IDENTITY CASCADE`);
    const make = (name: string) =>
      upsertUser({ clerkId: `clerk_fg_${name}`, displayName: name, avatarUrl: null });
    alice = await make("alice");
    bob = await make("bob");
    carol = await make("carol");
    const created = await createPqpServer("Fórum", alice.id);
    serverId = created.server.id;
    generalId = created.channels.find((c) => c.type === "text")!.id;
    await joinServer(bob);
    await joinServer(carol);
    forumId = await insertForum();
  });

  // ------------------------------------------------------------ send path

  describe("the send path", () => {
    it("refuses a message to the forum itself and stores nothing", async () => {
      const result = await postChannelMessage({ author: bob, channelId: forumId, body: "oi" });
      expect(result).toEqual({ ok: false, reason: "no-access" });
      const rows = await getPool().query(`SELECT 1 FROM messages WHERE channel_id = $1`, [forumId]);
      expect(rows.rowCount).toBe(0);
    });

    it("takes a reply in an open post", async () => {
      const { postId } = await insertPost(forumId, alice);
      const result = await postChannelMessage({ author: bob, channelId: postId, body: "reinstala" });
      expect(result.ok).toBe(true);
    });

    it("refuses a member's reply in a locked post with `locked`", async () => {
      const { postId } = await insertPost(forumId, alice, { locked: true });
      const result = await postChannelMessage({ author: bob, channelId: postId, body: "e aí?" });
      expect(result).toEqual({ ok: false, reason: "locked" });
    });

    it("lets staff reply in a locked post: the owner, and a cargo scoped to the forum", async () => {
      const { postId } = await insertPost(forumId, bob, { locked: true });
      expect((await postChannelMessage({ author: alice, channelId: postId, body: "fechado" })).ok).toBe(true);

      await giveCargo(carol, Permission.MANAGE_MESSAGES, forumId);
      expect((await postChannelMessage({ author: carol, channelId: postId, body: "resolvido" })).ok).toBe(true);
    });

    it("leaves a chat thread alone", async () => {
      const threadId = await insertChatThread(generalId, alice);
      const result = await postChannelMessage({ author: bob, channelId: threadId, body: "no fio" });
      expect(result.ok).toBe(true);
    });

    it("answers a character's HTTP send into a locked post with 403", async () => {
      // The character door maps `locked` (PR 0); here it is reached for real.
      const { postId } = await insertPost(forumId, alice, { locked: true });
      await getPool().query(`UPDATE users SET is_character = TRUE WHERE id = $1`, [bob.id]);
      const character = { ...bob, is_character: true } as Account;
      const response = await call(character, "POST", `/api/channels/${postId}/messages`, {
        body: "oi",
      });
      expect(response.status).toBe(403);
      expect(response.body.error).toBe("This post is closed to replies");
    });
  });

  // ----------------------------------------------------------------- unread

  describe("listUnread", () => {
    it("gives posts no row and counts new posts by others on the forum", async () => {
      await markChannelRead(forumId, bob.id);
      const mine = await insertPost(forumId, bob);
      const theirs = await insertPost(forumId, alice);
      await insertPost(forumId, carol);
      await insertPost(forumId, alice, { published: false }); // a shell is never news

      const rows = await listUnread(serverId, bob.id);
      expect(unreadOf(rows, mine.postId)).toBeUndefined();
      expect(unreadOf(rows, theirs.postId)).toBeUndefined();
      expect(unreadOf(rows, forumId)).toEqual({ channelId: forumId, count: 2, mentions: 0 });
    });

    it("does not light the forum for a reply in a post the viewer never opened", async () => {
      const { postId } = await insertPost(forumId, alice, { age: "1 hour" });
      await markChannelRead(forumId, bob.id);
      await insertMessage(postId, carol.id, "também tô com isso");
      expect(unreadOf(await listUnread(serverId, bob.id), forumId)).toMatchObject({ count: 0 });
    });

    it("skips posts by someone the viewer blocked", async () => {
      await markChannelRead(forumId, bob.id);
      await insertPost(forumId, carol);
      await blockUser(bob.id, carol.id);
      expect(unreadOf(await listUnread(serverId, bob.id), forumId)).toMatchObject({ count: 0 });
    });

    it("rolls the viewer's mentions inside posts up to the forum, after each post's cursor", async () => {
      const { postId } = await insertPost(forumId, alice, { age: "1 hour" });
      const mention = await insertMessage(postId, alice.id, "@bob olha isso");
      await getPool().query(
        `INSERT INTO message_mentions (message_id, user_id) VALUES ($1, $2)`,
        [mention, bob.id],
      );
      // Never opened the post: measured from the forum cursor, which predates it.
      await markChannelRead(forumId, bob.id, new Date(Date.now() - 2 * 3600_000));
      expect(unreadOf(await listUnread(serverId, bob.id), forumId)).toMatchObject({ mentions: 1 });

      // Opening the post reads the mention.
      await markChannelRead(postId, bob.id);
      expect(unreadOf(await listUnread(serverId, bob.id), forumId)).toMatchObject({ mentions: 0 });
    });

    it("keeps chat threads in, so the client can still tell which are unread", async () => {
      const threadId = await insertChatThread(generalId, alice);
      await insertMessage(threadId, alice.id, "novidade");
      expect(unreadOf(await listUnread(serverId, bob.id), threadId)).toMatchObject({ count: 1 });
    });

    it("hides a private forum's row from a member who cannot see it", async () => {
      await getPool().query(`UPDATE channels SET is_private = TRUE WHERE id = $1`, [forumId]);
      await getPool().query(
        `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
         SELECT $1, 'role', r.id, 0, $2 FROM roles r WHERE r.server_id = $3 AND r.is_everyone`,
        [forumId, Permission.VIEW_CHANNEL.toString(), serverId],
      );
      await insertPost(forumId, alice);
      expect(unreadOf(await listUnread(serverId, bob.id), forumId)).toBeUndefined();
    });

    it("answers the same rows at 500 posts and 10,000 messages, capped at 99", async () => {
      const before = await listUnread(serverId, bob.id);
      await getPool().query(
        `WITH posts AS (
           INSERT INTO channels (server_id, name, type, position, kind, parent_id)
           SELECT $1, 'post ' || g, 'thread', 0, 'server', $2 FROM generate_series(1, 500) g
           RETURNING id
         ), sides AS (
           INSERT INTO forum_posts (channel_id, forum_id, author_id, published_at)
           SELECT id, $2, $3, NOW() FROM posts RETURNING channel_id
         )
         INSERT INTO messages (channel_id, author_id, body)
         SELECT s.channel_id, $3, 'resposta ' || g
           FROM sides s CROSS JOIN generate_series(1, 20) g`,
        [serverId, forumId, alice.id],
      );
      // Fifty of those replies mention bob, who never opened the forum.
      await getPool().query(
        `INSERT INTO message_mentions (message_id, user_id)
         SELECT m.id, $2 FROM messages m
           JOIN forum_posts fp ON fp.channel_id = m.channel_id
          WHERE fp.forum_id = $1
          LIMIT 50`,
        [forumId, bob.id],
      );
      const after = await listUnread(serverId, bob.id);
      expect(after.length).toBe(before.length);
      expect(unreadOf(after, forumId)).toEqual({ channelId: forumId, count: 99, mentions: 50 });

      if (process.env.FORUM_EXPLAIN) {
        // The PR's EXPLAIN: `FORUM_EXPLAIN=/tmp/plan.txt npx vitest run forum-guards`.
        const spy = vi.spyOn(getPool(), "query");
        await listUnread(serverId, bob.id);
        const [sql, params] = spy.mock.calls[0]! as unknown as [string, unknown[]];
        spy.mockRestore();
        const plan = await getPool().query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
        writeFileSync(
          process.env.FORUM_EXPLAIN,
          plan.rows.map((row: Record<string, string>) => row["QUERY PLAN"]).join("\n"),
        );
      }
    });
  });

  // -------------------------------------------------------- delete, position

  describe("deleteChannel", () => {
    it("deletes a forum of 200 posts with one attachment-key query", async () => {
      stubs.storage = true;
      const posts: string[] = [];
      for (let i = 0; i < 200; i++) {
        posts.push((await insertPost(forumId, alice, { title: `post ${i}` })).postId);
      }
      await getPool().query(
        `INSERT INTO message_attachments (channel_id, uploader_id, storage_key, filename, content_type, byte_size)
         SELECT p, $2, 'attachments/' || p, 'print.png', 'image/png', 10
           FROM unnest($1::uuid[]) AS p`,
        [posts, alice.id],
      );
      await getPool().query(
        `INSERT INTO forum_tags (forum_id, name) VALUES ($1, 'Dúvida')`,
        [forumId],
      );

      // Every statement, whether sent through the pool or on the client the
      // delete's transaction holds.
      const pool = getPool();
      const poolQuery = vi.spyOn(pool, "query");
      const clientQueries: { mock: { calls: unknown[][] }; mockRestore: () => void }[] = [];
      const realConnect = pool.connect.bind(pool);
      const connect = vi.spyOn(pool, "connect").mockImplementation((async () => {
        const client = await realConnect();
        clientQueries.push(vi.spyOn(client, "query"));
        return client;
      }) as unknown as typeof pool.connect);
      expect(await deleteChannel(forumId)).toBe(true);
      connect.mockRestore();
      const sqls = [poolQuery, ...clientQueries]
        .flatMap((spy) => spy.mock.calls.map(([sql]) => sql))
        .map((sql) => (typeof sql === "string" ? sql : String((sql as { text?: string })?.text)));
      poolQuery.mockRestore();
      for (const spy of clientQueries) {
        spy.mockRestore();
      }
      const keyReads = sqls.filter((sql) => sql.includes("FROM message_attachments"));
      expect(keyReads).toHaveLength(1);

      await vi.waitFor(() => expect(stubs.deletedKeys).toHaveLength(200));
      const left = await getPool().query(
        `SELECT (SELECT COUNT(*) FROM channels WHERE id = $1 OR parent_id = $1)::int AS channels,
                (SELECT COUNT(*) FROM forum_posts WHERE forum_id = $1)::int AS posts,
                (SELECT COUNT(*) FROM forum_tags WHERE forum_id = $1)::int AS tags`,
        [forumId],
      );
      expect(left.rows[0]).toEqual({ channels: 0, posts: 0, tags: 0 });
    });
  });

  describe("positions", () => {
    async function topLevel() {
      const rows = await getPool().query<{ id: string; type: string; position: number }>(
        `SELECT id, type, position FROM channels
          WHERE server_id = $1 AND parent_id IS NULL AND type IN ('text', 'forum')
          ORDER BY position`,
        [serverId],
      );
      return rows.rows;
    }

    it("numbers a new forum after the text channels, and a move reorders them as one list", async () => {
      await getPool().query(`DELETE FROM channels WHERE id = $1`, [forumId]);
      const forum = await createChannel(serverId, "ajuda", "forum");
      const text = await createChannel(serverId, "memes", "text");
      expect((await topLevel()).map((row) => [row.id, row.position])).toEqual([
        [generalId, 0],
        [forum.id, 1],
        [text.id, 2],
      ]);

      await moveChannel(serverId, forum.id, null, 0);
      expect((await topLevel()).map((row) => [row.id, row.position])).toEqual([
        [forum.id, 0],
        [generalId, 1],
        [text.id, 2],
      ]);
    });
  });

  // ------------------------------------------------------ retention, search

  it("retention keeps a post's opening message and sweeps its old replies", async () => {
    await getPool().query(`UPDATE servers SET message_retention_days = 30 WHERE id = $1`, [serverId]);
    const { postId, openingId } = await insertPost(forumId, alice, { age: "90 days" });
    const reply = await insertMessage(postId, bob.id, "resposta velha", "60 days");
    await sweepMessageRetention();
    const left = await getPool().query<{ id: string }>(
      `SELECT id FROM messages WHERE channel_id = $1`,
      [postId],
    );
    expect(left.rows.map((row) => row.id)).toEqual([openingId]);
    expect(left.rows.map((row) => row.id)).not.toContain(reply);
  });

  it("search names the forum a hit inside a post belongs to", async () => {
    const { postId } = await insertPost(forumId, alice);
    await insertMessage(postId, alice.id, "abacaxi no notebook");
    await insertMessage(generalId, alice.id, "abacaxi no geral");
    const found = await searchMessages(serverId, bob.id, "abacaxi", 10);
    const byChannel = new Map(found.results.map((hit) => [hit.channelId, hit.parentChannelId]));
    expect(byChannel.get(postId)).toBe(forumId);
    expect(byChannel.get(generalId)).toBeNull();
  });

  // ------------------------------------------------ generic channel routes

  describe("the generic channel routes", () => {
    it("refuse to rename or delete a forum post", async () => {
      const { postId } = await insertPost(forumId, bob);
      const renamed = await call(alice, "PATCH", `/api/channels/${postId}`, { name: "outro" });
      expect(renamed.status).toBe(400);
      const deleted = await call(alice, "DELETE", `/api/channels/${postId}`);
      expect(deleted.status).toBe(400);
      const still = await getPool().query(`SELECT name FROM channels WHERE id = $1`, [postId]);
      expect(still.rows[0]).toEqual({ name: "Notebook não liga" });
    });

    it("say nothing about the id to a caller without MANAGE_CHANNELS", async () => {
      const { postId } = await insertPost(forumId, bob);
      expect((await call(bob, "DELETE", `/api/channels/${postId}`)).status).toBe(403);
    });

    it("still rename and delete a chat thread, and the forum itself", async () => {
      const threadId = await insertChatThread(generalId, alice);
      expect((await call(alice, "PATCH", `/api/channels/${threadId}`, { name: "novo" })).status).toBe(200);
      expect((await call(alice, "DELETE", `/api/channels/${threadId}`)).status).toBe(200);
      expect((await call(alice, "PATCH", `/api/channels/${forumId}`, { topic: "Regras" })).status).toBe(200);
    });
  });

  // -------------------------------------------------------------- webhooks

  describe("webhooks", () => {
    it("are refused on a category, a voice room and a thread, and allowed on text and forum", async () => {
      const category = await createChannel(serverId, "Geral", "category");
      const voice = await createChannel(serverId, "Lobby", "voice");
      const { postId } = await insertPost(forumId, alice, { locked: true });
      for (const id of [category.id, voice.id, postId]) {
        const response = await call(alice, "POST", `/api/channels/${id}/webhooks`, { name: "RSS" });
        expect(response.status).toBe(400);
      }
      for (const id of [generalId, forumId]) {
        const response = await call(alice, "POST", `/api/channels/${id}/webhooks`, { name: "RSS" });
        expect(response.status).toBe(201);
      }
    });

    it("refuse an execute into a forum while forums are off, and write nothing", async () => {
      const created = await call(alice, "POST", `/api/channels/${forumId}/webhooks`, { name: "RSS" });
      const url = (created.body.webhook as { url: string }).url;
      const response = await fetch(`${baseUrl}${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Notícia nova", thread_name: "Notícia nova" }),
      });
      expect(response.status).toBe(403);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("forum_channels_off");
      expect(body.code).not.toBe(WEBHOOK_FORUM_THREAD_NAME_CODE);
      const rows = await getPool().query(`SELECT 1 FROM messages WHERE channel_id = $1`, [forumId]);
      expect(rows.rowCount).toBe(0);
    });

    it("refuse an execute from a webhook that already sat on a forum post", async () => {
      // Made before the create route refused threads: straight through the service.
      const { postId } = await insertPost(forumId, alice, { locked: true });
      const legacy = await createWebhook(postId, serverId, "Velho", null, alice.id);
      const response = await fetch(`${baseUrl}/api/webhooks/${legacy.id}/${legacy.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "passando por cima do cadeado" }),
      });
      expect(response.status).toBe(400);
      const rows = await getPool().query(
        `SELECT 1 FROM messages WHERE channel_id = $1 AND body LIKE 'passando%'`,
        [postId],
      );
      expect(rows.rowCount).toBe(0);
    });

    it("still execute into a text channel", async () => {
      const created = await call(alice, "POST", `/api/channels/${generalId}/webhooks`, { name: "CI" });
      const url = (created.body.webhook as { url: string }).url;
      const response = await fetch(`${baseUrl}${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "build verde" }),
      });
      expect(response.status).toBe(200);
    });
  });

  // ---------------------------------------------------------- moderation

  it("message delete follows the channel: a cargo scoped to the forum moderates its posts only", async () => {
    await giveCargo(carol, Permission.MANAGE_MESSAGES, forumId);
    const { postId } = await insertPost(forumId, alice);
    const inPost = await insertMessage(postId, bob.id, "spam");
    const inGeneral = await insertMessage(generalId, bob.id, "spam");

    expect((await call(carol, "DELETE", `/api/messages/${inGeneral}`)).status).toBe(403);
    expect((await call(carol, "DELETE", `/api/messages/${inPost}`)).status).toBe(200);
  });

  it("an AutoMod channel exemption covers the channel's posts and threads", async () => {
    await createAutomodRule(serverId, {
      kind: "keywords",
      enabled: true,
      keywords: ["batata"],
      allowList: [],
      mentionLimit: 5,
      exemptRoleIds: [],
      exemptChannelIds: [forumId, generalId],
      customMessage: "",
      alertChannelId: null,
      timeoutMinutes: 0,
      blockPqpInvites: false,
    });
    const { postId } = await insertPost(forumId, alice);
    const threadId = await insertChatThread(generalId, alice);
    const other = (await createChannel(serverId, "outro", "text")).id;

    expect((await postChannelMessage({ author: bob, channelId: postId, body: "batata" })).ok).toBe(true);
    expect((await postChannelMessage({ author: bob, channelId: threadId, body: "batata" })).ok).toBe(true);
    expect(await postChannelMessage({ author: bob, channelId: other, body: "batata" })).toMatchObject({
      ok: false,
      reason: "automod",
    });

    // The edit path does not know the parent and reads it itself.
    const mine = await insertMessage(postId, bob.id, "oi");
    const edited = await call(bob, "PATCH", `/api/messages/${mine}`, { body: "batata" });
    expect(edited.status).toBe(200);
  });
});

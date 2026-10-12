import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forumPostSummarySchema,
  Permission,
  WEBHOOK_DEDUPLICATED_HEADER,
  WEBHOOK_FORUM_THREAD_NAME_CODE,
  type ForumPostSummary,
} from "@pqp/shared";

/**
 * Forum PR 4 (plan §7): an execute on a forum's webhook makes a post. Run
 * against the real `handleWebhookExecute` over HTTP on a real Postgres, with
 * the flag set the way production sets it (a per-server override row) and
 * `read_cache` at its production default.
 *
 * The payloads in `fixtures/webhook-forum/` are each written from a real
 * tool's output (MonitoRSS's own payload builder, n8n's and Zapier's request
 * shapes), not from our schema, because the point is the shapes we did not
 * design. Each file says where its shape comes from.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
delete process.env.FORUM_CHANNELS;
delete process.env.READ_CACHE;

const stubs = vi.hoisted(() => ({
  actor: null as { id: string; clerk_id: string } | null,
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

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { createServer: createPqpServer, createChannel } = await import(
  "../services/servers.js"
);
const { resetChatRateLimits, settleForumBumps } = await import("../ws/chat.js");
const { resetReadCacheForTests } = await import("../lib/read-cache.js");
const { resetSharedRateLimit } = await import("../lib/cluster-rate-limit.js");
const { resetFeatureFlagsForTests, setServerFlagOverride, startFeatureFlags } =
  await import("../lib/flags.js");
const { assignRole, createRole, upsertChannelOverwrite } = await import(
  "../services/roles.js"
);
const { executeWebhookIntoOpenPost, getWebhook } = await import("../services/webhooks.js");

type Actor = { id: string; clerk_id: string };

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "webhook-forum");

interface Fixture {
  source: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
}

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Fixture;
}

let http: Server;
let baseUrl: string;
let alice: Actor;
let bob: Actor;
let serverId: string;
let forumId: string;
let generalId: string;
let tags: Record<string, string>;

interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

async function call<T = Record<string, unknown>>(
  as: Actor,
  method: string,
  path: string,
  body?: unknown,
): Promise<Reply<T>> {
  await settleForumBumps();
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
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T, headers: response.headers };
}

interface ExecuteAnswer {
  id?: string;
  channel_id?: string;
  message: { id: string; channelId: string; authorName: string; body: string } | null;
  post?: ForumPostSummary;
  ignored_tags?: string[];
  error?: string;
  code?: number;
  reason?: string;
  retry_after?: number;
}

/** POST a payload to a webhook URL with no Clerk session, as a tool does. */
async function execute(
  url: string,
  payload: Fixture | Record<string, unknown>,
  extra: { query?: Record<string, string>; headers?: Record<string, string> } = {},
): Promise<Reply<ExecuteAnswer>> {
  const isFixture = "source" in payload && "body" in payload;
  const body = isFixture ? (payload as Fixture).body : payload;
  const query = { ...(isFixture ? (payload as Fixture).query : {}), ...extra.query };
  const headers = { ...(isFixture ? (payload as Fixture).headers : {}), ...extra.headers };
  const search = new URLSearchParams(query).toString();
  const response = await fetch(`${baseUrl}${url}${search ? `?${search}` : ""}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as ExecuteAnswer,
    headers: response.headers,
  };
}

async function makeWebhook(channel = forumId, name = "RSS"): Promise<{ id: string; url: string }> {
  const reply = await call<{ webhook: { id: string; url: string } }>(
    alice,
    "POST",
    `/api/channels/${channel}/webhooks`,
    { name },
  );
  expect(reply.status).toBe(201);
  return reply.body.webhook;
}

async function putSettings(
  webhookId: string,
  settings: { allowedTagIds: string[] | null; defaultTagIds: string[]; dedupeWindowHours: number },
  as: Actor = alice,
) {
  return call<{ settings: typeof settings; error?: string }>(
    as,
    "PUT",
    `/api/webhooks/${webhookId}/forum-settings`,
    settings,
  );
}

async function postCount(forum = forumId): Promise<number> {
  const result = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM forum_posts WHERE forum_id = $1`,
    [forum],
  );
  return result.rows[0]!.n;
}

async function messageCount(channelId: string): Promise<number> {
  const result = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages WHERE channel_id = $1`,
    [channelId],
  );
  return result.rows[0]!.n;
}

async function giveCargo(user: Actor, permissions: bigint, onChannel?: string) {
  const role = await createRole(serverId, {
    name: `cargo_${Math.random().toString(36).slice(2, 8)}`,
    permissions: onChannel ? 0n : permissions,
  });
  await assignRole(serverId, user.id, role.id);
  if (onChannel) {
    await upsertChannelOverwrite(onChannel, serverId, "role", role.id, permissions, 0n);
  }
}

describeDb("webhooks into a forum", () => {
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
    resetFeatureFlagsForTests();
    await closePool();
  });

  beforeEach(async () => {
    await new Promise((done) => setTimeout(done, 50));
    resetApiRateLimits();
    resetChatRateLimits();
    resetReadCacheForTests();
    resetFeatureFlagsForTests();
    await resetSharedRateLimit("forum-webhook-post");
    await getPool().query(
      `TRUNCATE users, servers, channels, messages, server_members, audit_log,
                feature_flags, feature_flag_overrides, feature_flag_audit
       RESTART IDENTITY CASCADE`,
    );
    alice = (await upsertUser({ clerkId: "clerk_fw_alice", displayName: "Alice", avatarUrl: null })) as Actor;
    bob = (await upsertUser({ clerkId: "clerk_fw_bob", displayName: "Bob", avatarUrl: null })) as Actor;
    const created = await createPqpServer("Feeds", alice.id);
    serverId = created.server.id;
    generalId = created.channels.find((channel) => channel.type === "text")!.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, bob.id],
    );
    await startFeatureFlags();
    await setServerFlagOverride("forum_channels", serverId, true, { kind: "dashboard" });
    forumId = (await createChannel(serverId, "noticias", "forum")).id;
    const put = await call<{ tags: Array<{ id: string; name: string }> }>(
      alice,
      "PUT",
      `/api/channels/${forumId}/forum-tags`,
      {
        tags: [
          { name: "Notícias", emoji: "📰", moderated: false },
          { name: "Lançamento", emoji: null, moderated: false },
          { name: "Dúvida", emoji: null, moderated: false },
          { name: "Oficial", emoji: null, moderated: true },
        ],
      },
    );
    expect(put.status).toBe(200);
    tags = Object.fromEntries(put.body.tags.map((tag) => [tag.name, tag.id]));
  });

  // ------------------------------------------------------- the fixtures

  it("monitorss-forum: titled from thread_name, snowflakes ignored, default tags applied", async () => {
    const webhook = await makeWebhook();
    expect(
      (await putSettings(webhook.id, {
        allowedTagIds: null,
        defaultTagIds: [tags["Notícias"]!],
        dedupeWindowHours: 72,
      })).status,
    ).toBe(200);

    const answer = await execute(webhook.url, fixture("monitorss-forum"));
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const post = forumPostSummarySchema.parse(answer.body.post);
    expect(post.title).toBe("Patch 1.4.2: correções de rede");
    expect(answer.body.ignored_tags).toEqual(["1092873465839202354", "1092873465839202355"]);
    expect(post.tagIds).toEqual([tags["Notícias"]]);
    expect(post.authorIsWebhook).toBe(true);
    expect(post.authorName).toBe("Notícias do Jogo");
    expect(post.authorAvatarUrl).toBe("https://jogo.example.com/rss-avatar.png");
    // Discord's starter-message rule: the answer's id IS the thread's id, so
    // MonitoRSS's follow-up to ?thread_id=<id> lands in this post.
    expect(answer.body.id).toBe(post.id);
    expect(answer.body.channel_id).toBe(post.id);
    expect(answer.body.message!.channelId).toBe(post.id);
    // Nothing in the forum row itself; one message, in the post.
    expect(await messageCount(forumId)).toBe(0);
    expect(await messageCount(post.id)).toBe(1);

    // A member sees it in the list.
    const list = await call<{ posts: ForumPostSummary[] }>(bob, "GET", `/api/channels/${forumId}/posts`);
    expect(list.body.posts.map((row) => row.id)).toEqual([post.id]);
  });

  it("monitorss-text-channel: no thread_name, titled from the embed's title", async () => {
    const webhook = await makeWebhook();
    const answer = await execute(webhook.url, fixture("monitorss-text-channel"));
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body.post!.title).toBe("Servidor de São Paulo volta amanhã");
    expect(answer.body.post!.tagIds).toEqual([]);
    expect(answer.body.ignored_tags).toBeUndefined();
  });

  it("n8n-http-request: titled from the first line with the link stripped; the row shows the override", async () => {
    const webhook = await makeWebhook();
    const answer = await execute(webhook.url, fixture("n8n-http-request"));
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body.post!.title).toBe("Nova temporada começa dia 20");
    expect(answer.body.post!.authorName).toBe("Blog do Jogo");
    expect(answer.body.post!.authorAvatarUrl).toBe("https://blog.example.com/avatar.png");
    expect(answer.body.post!.preview).toContain("Nova temporada");
  });

  it("n8n-with-tags: tag names resolve whatever the case and the accents", async () => {
    const webhook = await makeWebhook();
    const answer = await execute(webhook.url, fixture("n8n-with-tags"));
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body.post!.title).toBe("Trailer da expansão");
    expect(new Set(answer.body.post!.tagIds)).toEqual(
      new Set([tags["Notícias"], tags["Lançamento"]]),
    );
    expect(answer.body.ignored_tags).toBeUndefined();
  });

  it("zapier-webhook: Discord's extra fields are accepted and ignored", async () => {
    const webhook = await makeWebhook();
    const answer = await execute(webhook.url, fixture("zapier-webhook"));
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body.post!.title).toBe("Live hoje às 21h");
  });

  it("embed-without-title: Discord's 220001, naming thread_name, and nothing written", async () => {
    const webhook = await makeWebhook();
    const answer = await execute(webhook.url, fixture("embed-without-title"));
    expect(answer.status).toBe(400);
    expect(answer.body.code).toBe(WEBHOOK_FORUM_THREAD_NAME_CODE);
    expect((answer.body as unknown as Record<string, unknown>).message).toContain("thread_name");
    expect(await postCount()).toBe(0);
    expect(await messageCount(forumId)).toBe(0);
  });

  it("moderated-tag: a staff-only tag is ignored unless the allowlist names it", async () => {
    const webhook = await makeWebhook();
    const first = await execute(webhook.url, fixture("moderated-tag"));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.post!.tagIds).toEqual([tags["Lançamento"]]);
    expect(first.body.ignored_tags).toEqual(["Oficial"]);

    await putSettings(webhook.id, {
      allowedTagIds: [tags["Oficial"]!, tags["Lançamento"]!],
      defaultTagIds: [],
      dedupeWindowHours: 72,
    });
    const second = await execute(webhook.url, {
      ...fixture("moderated-tag").body,
      thread_name: "Versão 2.1",
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(new Set(second.body.post!.tagIds)).toEqual(
      new Set([tags["Oficial"], tags["Lançamento"]]),
    );
    expect(second.body.ignored_tags).toBeUndefined();

    // With an allowlist, a tag left off it is refused even when it is open.
    const third = await execute(webhook.url, {
      content: "Pergunta",
      thread_name: "Pergunta frequente",
      applied_tags: ["Dúvida"],
    });
    expect(third.body.post!.tagIds).toEqual([]);
    expect(third.body.ignored_tags).toEqual(["Dúvida"]);
  });

  it("thread-id-reply: lands in this forum's post; a locked post refuses; another forum's post is 404", async () => {
    const webhook = await makeWebhook();
    const created = await execute(webhook.url, fixture("monitorss-forum"));
    const postId = created.body.id!;
    const reply = fixture("thread-id-reply");

    const answer = await execute(webhook.url, reply, { query: { thread_id: postId } });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body.message!.channelId).toBe(postId);
    expect(answer.body.channel_id).toBe(postId);
    expect(answer.body.id).toBe(answer.body.message!.id);
    expect(answer.body.post!.replyCount).toBe(1);
    expect(await postCount()).toBe(1);
    expect(await messageCount(postId)).toBe(2);

    // Another forum's post: 404, nothing written there.
    const otherForum = (await createChannel(serverId, "outro", "forum")).id;
    const otherHook = await makeWebhook(otherForum);
    const otherPost = (await execute(otherHook.url, { content: "x", thread_name: "Outro" })).body.id!;
    const cross = await execute(webhook.url, reply, { query: { thread_id: otherPost } });
    expect(cross.status).toBe(404);
    expect(await messageCount(otherPost)).toBe(1);
    // Garbage and a plain channel id are 404 too.
    expect((await execute(webhook.url, reply, { query: { thread_id: "nope" } })).status).toBe(404);
    expect((await execute(webhook.url, reply, { query: { thread_id: generalId } })).status).toBe(404);

    // Locked: refused like a person's reply.
    const locked = await call(alice, "PATCH", `/api/forum-posts/${postId}`, { locked: true });
    expect(locked.status).toBe(200);
    const refused = await execute(webhook.url, reply, { query: { thread_id: postId } });
    expect(refused.status).toBe(403);
    expect(refused.body.reason).toBe("locked");
    expect(await messageCount(postId)).toBe(2);
  });

  it("the reply INSERT itself refuses a locked post, whatever the route read before it", async () => {
    const webhook = await makeWebhook();
    const postId = (await execute(webhook.url, fixture("monitorss-forum"))).body.id!;
    const row = await getWebhook(webhook.id);
    // Locked AFTER any read a route could have made: only the statement's own
    // check stands between the reply and the lock.
    await getPool().query(`UPDATE forum_posts SET locked_at = NOW() WHERE channel_id = $1`, [postId]);
    expect(await executeWebhookIntoOpenPost(row!, { content: "atrasado" }, postId)).toBeNull();
    expect(await messageCount(postId)).toBe(1);

    await getPool().query(`UPDATE forum_posts SET locked_at = NULL WHERE channel_id = $1`, [postId]);
    expect(await executeWebhookIntoOpenPost(row!, { content: "agora sim" }, postId)).not.toBeNull();
    expect(await messageCount(postId)).toBe(2);
  });

  // ------------------------------------------------------------- dedupe

  it("the same item twice gives one post, the second answered with the dedupe header", async () => {
    const webhook = await makeWebhook();
    const first = await execute(webhook.url, fixture("monitorss-forum"));
    expect(first.headers.get(WEBHOOK_DEDUPLICATED_HEADER)).toBeNull();
    const second = await execute(webhook.url, fixture("monitorss-forum"));
    expect(second.status).toBe(200);
    expect(second.headers.get(WEBHOOK_DEDUPLICATED_HEADER)).toBe("1");
    expect(second.body.post!.id).toBe(first.body.post!.id);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.message!.id).toBe(first.body.message!.id);
    expect(await postCount()).toBe(1);
    expect(await messageCount(first.body.post!.id)).toBe(1);
  });

  it("the same title with a different link gives two posts", async () => {
    const webhook = await makeWebhook();
    await execute(webhook.url, { content: "Notas https://a.example.com/1", thread_name: "Patch notes" });
    const other = await execute(webhook.url, {
      content: "Notas https://a.example.com/2",
      thread_name: "Patch notes",
    });
    expect(other.headers.get(WEBHOOK_DEDUPLICATED_HEADER)).toBeNull();
    expect(await postCount()).toBe(2);
  });

  it("utm_* parameters and a #fragment do not defeat the key", async () => {
    const webhook = await makeWebhook();
    await execute(webhook.url, { content: "https://a.example.com/item?id=7", thread_name: "Item" });
    const repeat = await execute(webhook.url, {
      content: "https://a.example.com/item?utm_source=rss&id=7&utm_campaign=x#comments",
      thread_name: "  item ",
    });
    expect(repeat.headers.get(WEBHOOK_DEDUPLICATED_HEADER)).toBe("1");
    expect(await postCount()).toBe(1);
  });

  it("Idempotency-Key wins over the derived key", async () => {
    const webhook = await makeWebhook();
    await execute(webhook.url, { content: "um", thread_name: "Título A" }, {
      headers: { "Idempotency-Key": "guid-1" },
    });
    // Same key, another title: the same item to the tool, so one post.
    const sameKey = await execute(webhook.url, { content: "dois", thread_name: "Título B" }, {
      headers: { "Idempotency-Key": "guid-1" },
    });
    expect(sameKey.headers.get(WEBHOOK_DEDUPLICATED_HEADER)).toBe("1");
    // Another key, the very same item: two items to the tool, two posts.
    const otherKey = await execute(webhook.url, { content: "um", thread_name: "Título A" }, {
      headers: { "Idempotency-Key": "guid-2" },
    });
    expect(otherKey.headers.get(WEBHOOK_DEDUPLICATED_HEADER)).toBeNull();
    expect(await postCount()).toBe(2);
  });

  it("a repeat after the window posts again, and window 0 never dedupes", async () => {
    const webhook = await makeWebhook();
    await execute(webhook.url, fixture("monitorss-forum"));
    await getPool().query(
      `UPDATE forum_posts SET created_at = created_at - INTERVAL '73 hours' WHERE forum_id = $1`,
      [forumId],
    );
    const later = await execute(webhook.url, fixture("monitorss-forum"));
    expect(later.headers.get(WEBHOOK_DEDUPLICATED_HEADER)).toBeNull();
    expect(await postCount()).toBe(2);

    await putSettings(webhook.id, { allowedTagIds: null, defaultTagIds: [], dedupeWindowHours: 0 });
    const off = await execute(webhook.url, fixture("monitorss-forum"));
    expect(off.headers.get(WEBHOOK_DEDUPLICATED_HEADER)).toBeNull();
    expect(await postCount()).toBe(3);
  });

  it("dedupe is per forum: a second webhook carrying the same story posts it once", async () => {
    const site = await makeWebhook(forumId, "Site");
    const aggregator = await makeWebhook(forumId, "Agregador");
    await execute(site.url, fixture("monitorss-forum"));
    const again = await execute(aggregator.url, fixture("monitorss-forum"));
    expect(again.headers.get(WEBHOOK_DEDUPLICATED_HEADER)).toBe("1");
    expect(await postCount()).toBe(1);
  });

  it("concurrent identical executes on separate connections make one post", async () => {
    const webhook = await makeWebhook();
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => execute(webhook.url, fixture("n8n-with-tags"))),
    );
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(answers.map((answer) => answer.body.post!.id)).size).toBe(1);
    expect(
      answers.filter((answer) => answer.headers.get(WEBHOOK_DEDUPLICATED_HEADER) === "1"),
    ).toHaveLength(4);
    expect(await postCount()).toBe(1);
  });

  // -------------------------------------------------------- rate limits

  it("the post bucket: 10, then 429 with Retry-After and retry_after; a repeat costs nothing", async () => {
    const webhook = await makeWebhook();
    for (let i = 0; i < 10; i += 1) {
      const answer = await execute(webhook.url, { content: `item ${i}`, thread_name: `Item ${i}` });
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    }
    // A repeat is answered from the window, not refused by the bucket.
    const repeat = await execute(webhook.url, { content: "item 3", thread_name: "Item 3" });
    expect(repeat.status).toBe(200);
    expect(repeat.headers.get(WEBHOOK_DEDUPLICATED_HEADER)).toBe("1");

    const refused = await execute(webhook.url, { content: "item 11", thread_name: "Item 11" });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    expect(refused.body.retry_after).toBe(60);
    expect(await postCount()).toBe(10);

    // Replies spend only the per-process limiter.
    const reply = await execute(webhook.url, { content: "mais" }, {
      query: { thread_id: repeat.body.post!.id },
    });
    expect(reply.status).toBe(200);
  });

  it("the per-process execute limiter answers Discord's retry_after too", async () => {
    const webhook = await makeWebhook(generalId);
    let last: Reply<ExecuteAnswer> | null = null;
    for (let i = 0; i < 21; i += 1) {
      last = await execute(webhook.url, { content: `build ${i}` });
    }
    expect(last!.status).toBe(429);
    expect(typeof last!.body.retry_after).toBe("number");
    expect(last!.headers.get("Retry-After")).toBe(String(last!.body.retry_after));
  });

  // --------------------------------------------------------------- flag

  it("flag off: a new post is 403 and nothing is written; a reply still lands", async () => {
    const webhook = await makeWebhook();
    const created = await execute(webhook.url, fixture("monitorss-forum"));
    await setServerFlagOverride("forum_channels", serverId, false, { kind: "dashboard" });

    const refused = await execute(webhook.url, fixture("n8n-with-tags"));
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("forum_channels_off");
    expect(await postCount()).toBe(1);

    const reply = await execute(webhook.url, { content: "ainda dá pra responder" }, {
      query: { thread_id: created.body.id! },
    });
    expect(reply.status).toBe(200);
  });

  // ----------------------------------------------------------- settings

  it("lists a forum's webhooks with their settings and the forum's tags; a text channel's with none", async () => {
    const webhook = await makeWebhook();
    const list = await call<{
      webhooks: Array<{ id: string; forumSettings?: unknown }>;
      forumTags: Array<{ id: string }> | null;
    }>(alice, "GET", `/api/channels/${forumId}/webhooks`);
    expect(list.body.webhooks[0]!.forumSettings).toEqual({
      allowedTagIds: null,
      defaultTagIds: [],
      dedupeWindowHours: 72,
    });
    expect(list.body.forumTags!.map((tag) => tag.id)).toEqual(Object.values(tags));

    await makeWebhook(generalId, "CI");
    const text = await call<{ webhooks: Array<{ forumSettings?: unknown }>; forumTags: unknown }>(
      alice,
      "GET",
      `/api/channels/${generalId}/webhooks`,
    );
    expect(text.body.forumTags).toBeNull();
    expect(text.body.webhooks[0]!.forumSettings).toBeUndefined();
    expect(webhook.id).toBeTruthy();
  });

  it("PUT forum-settings: validated, audited, and refused off a forum", async () => {
    const webhook = await makeWebhook();
    const saved = await putSettings(webhook.id, {
      allowedTagIds: [tags["Notícias"]!, tags["Notícias"]!],
      defaultTagIds: [tags["Notícias"]!],
      dedupeWindowHours: 24,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toEqual({
      allowedTagIds: [tags["Notícias"]],
      defaultTagIds: [tags["Notícias"]],
      dedupeWindowHours: 24,
    });
    const audit = await getPool().query<{ action: string }>(
      `SELECT action FROM audit_log WHERE target_id = $1 ORDER BY created_at`,
      [webhook.id],
    );
    expect(audit.rows.map((row) => row.action)).toContain("webhook.forum_settings");

    const unknown = await putSettings(webhook.id, {
      allowedTagIds: null,
      defaultTagIds: ["00000000-0000-4000-8000-000000000000"],
      dedupeWindowHours: 24,
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe("forum_tag_unknown");

    const tooLong = await putSettings(webhook.id, {
      allowedTagIds: null,
      defaultTagIds: [],
      dedupeWindowHours: 721,
    });
    expect(tooLong.status).toBe(400);

    const ci = await makeWebhook(generalId, "CI");
    expect(
      (await putSettings(ci.id, { allowedTagIds: null, defaultTagIds: [], dedupeWindowHours: 0 }))
        .status,
    ).toBe(400);
  });

  it("webhook routes follow the channel's overwrites: MANAGE_CHANNELS on the forum is enough, elsewhere it is not", async () => {
    const webhook = await makeWebhook();
    const settings = { allowedTagIds: null, defaultTagIds: [], dedupeWindowHours: 24 };
    expect((await call(bob, "GET", `/api/channels/${forumId}/webhooks`)).status).toBe(403);
    expect((await putSettings(webhook.id, settings, bob)).status).toBe(403);

    await giveCargo(bob, Permission.MANAGE_CHANNELS, forumId);
    expect((await call(bob, "GET", `/api/channels/${forumId}/webhooks`)).status).toBe(200);
    expect((await putSettings(webhook.id, settings, bob)).status).toBe(200);
    // The overwrite names the forum, not the server.
    expect((await call(bob, "GET", `/api/channels/${generalId}/webhooks`)).status).toBe(403);
    expect((await call(bob, "DELETE", `/api/webhooks/${webhook.id}`)).status).toBe(200);
  });

  it("deleting the webhook deletes its forum settings", async () => {
    const webhook = await makeWebhook();
    await putSettings(webhook.id, { allowedTagIds: null, defaultTagIds: [], dedupeWindowHours: 24 });
    expect((await call(alice, "DELETE", `/api/webhooks/${webhook.id}`)).status).toBe(200);
    const rows = await getPool().query(
      `SELECT 1 FROM webhook_forum_settings WHERE webhook_id = $1`,
      [webhook.id],
    );
    expect(rows.rowCount).toBe(0);
  });
});

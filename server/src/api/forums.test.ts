import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forumPostDetailResponseSchema,
  forumPostListResponseSchema,
  forumPostSummarySchema,
  forumTagSchema,
  Permission,
  type ForumPostListResponse,
  type ForumPostSummary,
} from "@pqp/shared";

/**
 * Forum channels PR 1, end to end over HTTP on a real Postgres: the list (both
 * halves, filters, keyset, pins, search), the detail, the create (with every
 * gate in plan §1.5), the per-field patch, delete, tags, settings and
 * follows. Flags are set the way production sets them, as rows read after
 * `startFeatureFlags()`, with `read_cache` at its production default (on), so
 * the cache invalidation is exercised rather than bypassed (pitfall 12).
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
const { upsertUser, markChannelRead } = await import("../services/users.js");
const { createServer: createPqpServer } = await import("../services/servers.js");
const { resetChatRateLimits, postChannelMessage, settleForumBumps } = await import(
  "../ws/chat.js"
);
const { resetReadCacheForTests } = await import("../lib/read-cache.js");
const { resetSharedRateLimit } = await import("../lib/cluster-rate-limit.js");
const { createAutomodRule, invalidateAutomodCache } = await import(
  "../services/automod.js"
);
const { issueTimeout } = await import("../services/sanctions.js");
const { createRemoteAttachment } = await import("../services/attachments.js");
const { sweepForumPostShells, resetUnaccentProbeForTests, createForumPostShell } =
  await import("../services/forums.js");
const { resetFeatureFlagsForTests, setServerFlagOverride, startFeatureFlags } =
  await import("../lib/flags.js");

type Actor = { id: string; clerk_id: string; username: string | null };

let http: Server;
let baseUrl: string;
let alice: Actor;
let bob: Actor;
let carol: Actor;
let serverId: string;
let forumId: string;

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
  // A reply's bump runs off the send path; let it land before reading.
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
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
    headers: response.headers,
  };
}

let nonceCounter = 0;
async function post(
  as: Actor,
  title: string,
  extra: Record<string, unknown> = {},
  forum = forumId,
): Promise<
  Reply<{ post: ForumPostSummary; viewer: { following: boolean }; error?: string; reason?: string }>
> {
  nonceCounter += 1;
  return call(as, "POST", `/api/channels/${forum}/posts`, {
    title,
    body: `corpo de ${title}`,
    nonce: `n-${nonceCounter}`,
    ...extra,
  });
}

async function list(
  as: Actor,
  query = "",
  forum = forumId,
): Promise<ForumPostListResponse> {
  const reply = await call(as, "GET", `/api/channels/${forum}/posts${query}`);
  expect(reply.status).toBe(200);
  return forumPostListResponseSchema.parse(reply.body);
}

async function putTags(
  tags: Array<{ id?: string; name: string; emoji?: string | null; moderated: boolean }>,
) {
  const reply = await call<{ tags: Array<{ id: string; name: string }> }>(
    alice,
    "PUT",
    `/api/channels/${forumId}/forum-tags`,
    { tags },
  );
  expect(reply.status).toBe(200);
  return reply.body.tags;
}

async function join(user: Actor) {
  await getPool().query(
    `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
    [serverId, user.id],
  );
}

async function createForum(name = "ajuda", extra: Record<string, unknown> = {}) {
  const reply = await call<{ channel: { id: string } }>(
    alice,
    "POST",
    `/api/servers/${serverId}/channels`,
    { name, type: "forum", ...extra },
  );
  expect(reply.status).toBe(201);
  return reply.body.channel.id;
}

/** Let the post-commit writes of a previous test (AutoMod audit, push) land. */
const settle = () => new Promise((done) => setTimeout(done, 80));

describeDb("forum posts", () => {
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
    await settle();
    resetApiRateLimits();
    resetChatRateLimits();
    resetReadCacheForTests();
    resetFeatureFlagsForTests();
    invalidateAutomodCache();
    await resetSharedRateLimit("forum-post");
    await getPool().query(
      `TRUNCATE users, servers, channels, messages, server_members,
                channel_members, channel_reads, channel_overwrites,
                message_attachments, message_reactions, message_mentions,
                automod_rules, audit_log, member_timeouts,
                channel_slowmode_sends, feature_flags, feature_flag_overrides,
                feature_flag_audit
       RESTART IDENTITY CASCADE`,
    );
    alice = (await upsertUser({
      clerkId: "clerk_forum_alice",
      displayName: "Alice",
      avatarUrl: null,
    })) as Actor;
    bob = (await upsertUser({
      clerkId: "clerk_forum_bob",
      displayName: "Bob",
      avatarUrl: null,
    })) as Actor;
    carol = (await upsertUser({
      clerkId: "clerk_forum_carol",
      displayName: "Carol",
      avatarUrl: null,
    })) as Actor;
    serverId = (await createPqpServer("Fórum", alice.id)).server.id;
    await join(bob);
    await join(carol);
    await startFeatureFlags();
    await setServerFlagOverride("forum_channels", serverId, true, { kind: "dashboard" });
    forumId = await createForum();
  });

  // ------------------------------------------------------------- create

  it("creates a post with tags and an attachment staged on the forum", async () => {
    const [duvida] = await putTags([{ name: "Dúvida", emoji: "❓", moderated: false }]);
    // Staged against the FORUM id, as the composer does: it has no post id yet.
    const gif = await createRemoteAttachment({
      channelId: forumId,
      uploaderId: bob.id,
      url: "https://static.klipy.com/gifs/abc/print.png",
      filename: "print.png",
      contentType: "image/png",
      width: 640,
      height: 360,
    });

    const created = await post(bob, "  Notebook   não liga ", {
      tagIds: [duvida!.id],
      attachmentIds: [gif.id],
    });
    expect(created.status).toBe(201);
    const summary = forumPostSummarySchema.parse(created.body.post);
    expect(summary.title).toBe("Notebook não liga");
    expect(summary.tagIds).toEqual([duvida!.id]);
    expect(summary.authorId).toBe(bob.id);
    expect(summary.authorName).toBe("Bob");
    expect(summary.attachmentCount).toBe(1);
    expect(summary.openingKind).toBe("text");
    expect(summary.preview).toBe("corpo de   Notebook   não liga ".replace(/\s+/g, " ").trim());
    // The image became the card's thumbnail.
    expect(summary.thumbnailAttachmentId).toBe(gif.id);
    expect(summary.thumbnailUrl).toBe("https://static.klipy.com/gifs/abc/print.png");
    expect(summary.thumbnailWidth).toBe(640);

    // The attachment was re-homed to the post and claimed by its opening message.
    const row = await getPool().query<{ channel_id: string; message_id: string | null }>(
      `SELECT channel_id, message_id FROM message_attachments WHERE id = $1`,
      [gif.id],
    );
    expect(row.rows[0]?.channel_id).toBe(summary.id);
    expect(row.rows[0]?.message_id).not.toBeNull();

    // The author follows their own post.
    expect(created.body.viewer.following).toBe(
      true,
    );
    // The post is a thread under the forum with no origin message.
    const channel = await getPool().query<{
      type: string;
      parent_id: string;
      thread_root_message_id: string | null;
    }>(`SELECT type, parent_id, thread_root_message_id FROM channels WHERE id = $1`, [
      summary.id,
    ]);
    expect(channel.rows[0]).toEqual({
      type: "thread",
      parent_id: forumId,
      thread_root_message_id: null,
    });
  });

  it("a nonce retry answers the same post with 200, and writes nothing", async () => {
    const body = { title: "Mesma coisa", body: "oi", nonce: "retry-1" };
    const first = await call<{ post: ForumPostSummary }>(
      bob,
      "POST",
      `/api/channels/${forumId}/posts`,
      body,
    );
    expect(first.status).toBe(201);
    const second = await call<{ post: ForumPostSummary }>(
      bob,
      "POST",
      `/api/channels/${forumId}/posts`,
      body,
    );
    expect(second.status).toBe(200);
    expect(second.body.post.id).toBe(first.body.post.id);
    const count = await getPool().query(`SELECT 1 FROM forum_posts`);
    expect(count.rowCount).toBe(1);
  });

  it("AutoMod on the title refuses with the composer's own fields and writes nothing", async () => {
    await createAutomodRule(serverId, {
      kind: "keywords",
      enabled: true,
      keywords: ["golpe"],
      allowList: [],
      mentionLimit: 5,
      exemptRoleIds: [],
      exemptChannelIds: [],
      customMessage: "Sem golpe aqui.",
      alertChannelId: null,
      timeoutMinutes: 0,
      blockPqpInvites: false,
    } as Parameters<typeof createAutomodRule>[1]);

    const refused = await post(bob, "Golpe do pix");
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      error: "forum_post_rejected",
      reason: "automod",
      automodMessage: "Sem golpe aqui.",
      // The composer says "esse título", not "esse post".
      field: "title",
    });
    expect((await getPool().query(`SELECT 1 FROM forum_posts`)).rowCount).toBe(0);

    // AutoMod on the BODY: the shell is created and then removed, staged files
    // go back to the forum so the composer's retry can still use them.
    const gif = await createRemoteAttachment({
      channelId: forumId,
      uploaderId: bob.id,
      url: "https://static.klipy.com/gifs/abc/x.gif",
      filename: "x.gif",
      contentType: "image/gif",
    });
    const bodyHit = await call<{ reason: string; field?: string }>(
      bob,
      "POST",
      `/api/channels/${forumId}/posts`,
      { title: "Pergunta honesta", body: "isso é golpe", nonce: "b1", attachmentIds: [gif.id] },
    );
    expect(bodyHit.status).toBe(422);
    expect(bodyHit.body.reason).toBe("automod");
    expect(bodyHit.body.field).toBe("body");
    expect((await getPool().query(`SELECT 1 FROM forum_posts`)).rowCount).toBe(0);
    expect(
      (await getPool().query(`SELECT 1 FROM channels WHERE type = 'thread'`)).rowCount,
    ).toBe(0);
    const staged = await getPool().query<{ channel_id: string }>(
      `SELECT channel_id FROM message_attachments WHERE id = $1`,
      [gif.id],
    );
    expect(staged.rows[0]?.channel_id).toBe(forumId);

    // Staff walk through, as everywhere.
    expect((await post(alice, "Golpe: como reconhecer")).status).toBe(201);
  });

  it("the forum's slow mode is the interval between new posts, and staff walk through", async () => {
    await getPool().query(`UPDATE channels SET slowmode_seconds = 60 WHERE id = $1`, [
      forumId,
    ]);
    expect((await post(bob, "Primeiro")).status).toBe(201);
    const second = await post(bob, "Segundo");
    expect(second.status).toBe(422);
    expect(second.body.reason).toBe("slow-mode");
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post(alice, "Staff 1")).status).toBe(201);
    expect((await post(alice, "Staff 2")).status).toBe(201);
    // A reply inside a post reads the post's own interval (0), not the forum's.
    const first = (await list(bob)).posts.find((p) => p.title === "Primeiro")!;
    const reply = await postChannelMessage({
      author: bob as never,
      channelId: first.id,
      body: "respondendo",
    });
    expect(reply.ok).toBe(true);
  });

  it("five posts per ten minutes per person, then a refusal with a wait", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await post(bob, `Post ${i}`)).status).toBe(201);
    }
    const sixth = await post(bob, "Post 5");
    expect(sixth.status).toBe(422);
    expect(sixth.body.reason).toBe("rate-limited");
    expect(sixth.headers.get("retry-after")).toBe("120");
    // Somebody else's budget is their own.
    expect((await post(carol, "Outra pessoa")).status).toBe(201);
    expect(
      (await getPool().query(`SELECT 1 FROM forum_posts WHERE author_id = $1`, [bob.id]))
        .rowCount,
    ).toBe(5);
  });

  it("refuses a timed-out member, a member without SEND_MESSAGES, and allows an overwrite", async () => {
    await issueTimeout({ serverId, userId: carol.id, issuedBy: alice.id, minutes: 10 });
    expect((await post(carol, "Calada")).status).toBe(403);

    const everyone = await getPool().query<{ id: string }>(
      `SELECT id FROM roles WHERE server_id = $1 AND is_everyone`,
      [serverId],
    );
    await getPool().query(
      `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
       VALUES ($1, 'role', $2, 0, $3)`,
      [forumId, everyone.rows[0]!.id, Permission.SEND_MESSAGES.toString()],
    );
    const refused = await post(bob, "Só leitura");
    expect(refused.status).toBe(403);
    // The forum's overwrite governs replies inside its posts too: a post is a
    // thread, and a thread's permissions are its parent's.
    const announcement = (await post(alice, "Comunicado")).body.post.id;
    const reply = await postChannelMessage({
      author: bob as never,
      channelId: announcement,
      body: "posso?",
    });
    expect(reply).toMatchObject({ ok: false, reason: "cannot-send" });
    await getPool().query(
      `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
       VALUES ($1, 'member', $2, $3, 0)`,
      [forumId, bob.id, Permission.SEND_MESSAGES.toString()],
    );
    expect((await post(bob, "Agora pode")).status).toBe(201);
  });

  it("flag off: creating is 403 and writes nothing, reading and replying keep working", async () => {
    const created = await post(bob, "Antes de desligar");
    expect(created.status).toBe(201);
    await setServerFlagOverride("forum_channels", serverId, false, { kind: "dashboard" });

    const refused = await post(bob, "Depois");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("forum_channels_off");
    expect((await list(bob)).posts.map((p) => p.title)).toEqual(["Antes de desligar"]);
    const reply = await postChannelMessage({
      author: carol as never,
      channelId: created.body.post.id,
      body: "ainda respondo",
    });
    expect(reply.ok).toBe(true);
  });

  it("requires a tag when the forum says so, and refuses a staff-only tag from a member", async () => {
    const [bug, oficial] = await putTags([
      { name: "Bug", moderated: false },
      { name: "Oficial", moderated: true },
    ]);
    const settings = await call(alice, "PATCH", `/api/channels/${forumId}/forum-settings`, {
      requireTag: true,
    });
    expect(settings.body).toEqual({ settings: { requireTag: true, defaultSort: "activity" } });

    const untagged = await post(bob, "Sem tag");
    expect(untagged.status).toBe(422);
    expect(untagged.body.error).toBe("forum_tag_required");

    const moderated = await post(bob, "Com tag de staff", { tagIds: [oficial!.id] });
    expect(moderated.status).toBe(403);
    expect(moderated.body.error).toBe("forum_tag_moderated");

    const unknown = await post(bob, "Tag de outro lugar", {
      tagIds: ["00000000-0000-4000-8000-000000000000"],
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe("forum_tag_unknown");

    expect((await post(bob, "Com tag", { tagIds: [bug!.id] })).status).toBe(201);
    expect((await post(alice, "Anúncio", { tagIds: [oficial!.id] })).status).toBe(201);
  });

  it("does not make a tag required of somebody who has no tag they could pick", async () => {
    const on = await call(alice, "PATCH", `/api/channels/${forumId}/forum-settings`, {
      requireTag: true,
    });
    expect(on.status).toBe(200);

    // No tags at all: the composer has nothing to offer, so the rule cannot bind.
    const none = await post(bob, "Sem tags no fórum");
    expect(none.status).toBe(201);

    // Only a staff-only tag: binds staff (who can pick it), not a member.
    const [oficial] = await putTags([{ name: "Oficial", moderated: true }]);
    const member = await post(bob, "Só tem tag de staff");
    expect(member.status).toBe(201);
    const staff = await post(alice, "Staff precisa de tag");
    expect(staff.status).toBe(422);
    expect(staff.body.error).toBe("forum_tag_required");
    expect((await post(alice, "Staff com tag", { tagIds: [oficial!.id] })).status).toBe(201);

    // The moment a tag a member can use exists, the rule binds them again.
    await putTags([
      { id: oficial!.id, name: "Oficial", moderated: true },
      { name: "Bug", moderated: false },
    ]);
    const bound = await post(bob, "Agora precisa");
    expect(bound.status).toBe(422);
    expect(bound.body.error).toBe("forum_tag_required");
  });

  // --------------------------------------------------------------- list

  it("lists both orders, pages stably through equal timestamps, and keeps pins on page 1", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const created = await post(i % 2 === 0 ? bob : carol, `Post ${i}`);
      expect(created.status).toBe(201);
      ids.push(created.body.post.id);
    }
    // Four posts share one microsecond-exact instant in both orders, the case
    // a millisecond cursor would skip rows on.
    await getPool().query(
      `UPDATE forum_posts
          SET last_activity_at = date_trunc('second', NOW() - INTERVAL '1 day') + INTERVAL '123456 microseconds',
              created_at = date_trunc('second', NOW() - INTERVAL '1 day') + INTERVAL '123456 microseconds'
        WHERE channel_id = ANY($1::uuid[])`,
      [ids.slice(1, 5)],
    );
    resetReadCacheForTests();

    for (const sort of ["activity", "created"] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await list(
          bob,
          `?sort=${sort}&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        );
        if (pages > 0) {
          expect(page.pinned).toEqual([]);
          expect(page.counts).toBeNull();
        } else {
          expect(page.counts).toEqual({ posts: 7, open: 7 });
        }
        seen.push(...page.posts.map((p) => p.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(new Set(seen).size).toBe(7);
      expect(seen).toHaveLength(7);
    }

    // The newest is first by activity; a reply bumps an old post to the top.
    const oldest = ids[0]!;
    await postChannelMessage({ author: alice as never, channelId: oldest, body: "subindo" });
    const bumped = await list(bob, "?sort=activity");
    expect(bumped.posts[0]?.id).toBe(oldest);
    expect(bumped.posts[0]?.replyCount).toBe(1);
    // ...but not under "newest".
    const newest = await list(bob, "?sort=created");
    expect(newest.posts[0]?.id).toBe(ids[6]);

    // Pin two: they leave the list and sit on page 1, in pin order.
    for (const id of [ids[3]!, ids[1]!]) {
      expect(
        (await call(alice, "PATCH", `/api/forum-posts/${id}`, { pinned: true })).status,
      ).toBe(200);
    }
    const pinnedPage = await list(bob, "?limit=3");
    expect(pinnedPage.pinned.map((p) => p.id)).toEqual([ids[3], ids[1]]);
    expect(pinnedPage.posts.map((p) => p.id)).not.toContain(ids[3]);
    const second = await list(bob, `?limit=3&cursor=${pinnedPage.nextCursor}`);
    expect(second.pinned).toEqual([]);
    expect(second.posts.map((p) => p.id)).not.toContain(ids[1]);
    expect(pinnedPage.viewer.map((v) => v.postId)).toEqual(
      [...pinnedPage.pinned, ...pinnedPage.posts].map((p) => p.id),
    );

    // A cursor from the other order is refused, not misread.
    const wrong = await call(
      bob,
      "GET",
      `/api/channels/${forumId}/posts?sort=created&cursor=${pinnedPage.nextCursor}`,
    );
    expect(wrong.status).toBe(400);
  });

  it("filters: tags are AND, status, mine, and an accent-insensitive title search", async () => {
    const [bug, linux, docs] = await putTags([
      { name: "Bug", moderated: false },
      { name: "Linux", moderated: false },
      { name: "Docs", moderated: false },
    ]);
    const both = await post(bob, "Notebook não liga", { tagIds: [bug!.id, linux!.id] });
    const onlyBug = await post(carol, "Tela azul", { tagIds: [bug!.id] });
    const pinned = await post(alice, "Regras do fórum", { tagIds: [docs!.id] });
    const percent = await post(carol, "Bateria 100% e nada");
    await call(alice, "PATCH", `/api/forum-posts/${pinned.body.post.id}`, { pinned: true });
    await call(carol, "PATCH", `/api/forum-posts/${onlyBug.body.post.id}`, { resolved: true });

    const titles = (page: ForumPostListResponse) => page.posts.map((p) => p.title).sort();

    const andFilter = await list(bob, `?tag=${bug!.id}&tag=${linux!.id}`);
    expect(titles(andFilter)).toEqual(["Notebook não liga"]);
    // Pinned posts ignore the tag filter.
    expect(andFilter.pinned.map((p) => p.id)).toEqual([pinned.body.post.id]);
    expect(titles(await list(bob, `?tag=${bug!.id}`))).toEqual([
      "Notebook não liga",
      "Tela azul",
    ]);
    expect(titles(await list(bob, "?status=resolved"))).toEqual(["Tela azul"]);
    expect(titles(await list(bob, "?status=open"))).toEqual([
      "Bateria 100% e nada",
      "Notebook não liga",
    ]);
    expect(titles(await list(bob, "?mine=true"))).toEqual(["Notebook não liga"]);

    resetUnaccentProbeForTests();
    const search = await list(bob, "?q=NOTEBOOK%20nao%20liga");
    expect(search.posts.map((p) => p.id)).toEqual([both.body.post.id]);
    // Pins are hidden while searching, and a pinned post is found inline.
    expect(search.pinned).toEqual([]);
    expect((await list(bob, "?q=regras")).posts.map((p) => p.id)).toEqual([
      pinned.body.post.id,
    ]);
    // LIKE's metacharacters are literal.
    expect((await list(bob, "?q=100%25")).posts.map((p) => p.id)).toEqual([
      percent.body.post.id,
    ]);
    expect((await list(bob, "?q=_")).posts).toEqual([]);

    // A self-host without `unaccent`: the search degrades to case-insensitive
    // instead of failing, and similar posts still answer.
    resetUnaccentProbeForTests(false);
    try {
      expect((await list(bob, "?q=NOTEBOOK%20n%C3%A3o")).posts.map((p) => p.id)).toEqual([
        both.body.post.id,
      ]);
      expect((await list(bob, "?q=nao%20liga")).posts).toEqual([]);
      const similar = await call<{ posts: Array<{ id: string }> }>(
        bob,
        "GET",
        `/api/channels/${forumId}/posts/similar?title=notebook`,
      );
      expect(similar.body.posts.map((p) => p.id)).toEqual([both.body.post.id]);
    } finally {
      resetUnaccentProbeForTests();
    }
  });

  it("never lists a shell, and the shell sweep removes an old one and keeps a post", async () => {
    const published = await post(bob, "Publicado");
    expect(published.status).toBe(201);
    // A crashed create: the shell row, a staged file moved onto it, never published.
    const shell = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position, is_private, kind, parent_id)
       VALUES ($1, 'Fantasma', 'thread', 0, FALSE, 'server', $2) RETURNING id`,
      [serverId, forumId],
    );
    const shellId = shell.rows[0]!.id;
    await getPool().query(
      `INSERT INTO forum_posts (channel_id, forum_id, author_id, created_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '15 minutes')`,
      [shellId, forumId, carol.id],
    );
    const staged = await createRemoteAttachment({
      channelId: shellId,
      uploaderId: carol.id,
      url: "https://static.klipy.com/gifs/abc/y.gif",
      filename: "y.gif",
      contentType: "image/gif",
    });
    resetReadCacheForTests();
    expect((await list(bob)).posts.map((p) => p.title)).toEqual(["Publicado"]);
    expect((await call(bob, "GET", `/api/forum-posts/${shellId}`)).status).toBe(404);

    expect(await sweepForumPostShells()).toBe(1);
    expect(
      (await getPool().query(`SELECT 1 FROM channels WHERE id = $1`, [shellId])).rowCount,
    ).toBe(0);
    const back = await getPool().query<{ channel_id: string }>(
      `SELECT channel_id FROM message_attachments WHERE id = $1`,
      [staged.id],
    );
    expect(back.rows[0]?.channel_id).toBe(forumId);
    expect(await sweepForumPostShells()).toBe(0);
    expect((await list(bob)).posts).toHaveLength(1);
  });

  it("the per-viewer half: Novo, unread with a new-reply count, and the forum cursor", async () => {
    const created = await post(bob, "Pergunta");
    const postId = created.body.post.id;

    let page = await list(carol);
    expect(page.forumPreviousReadAt).toBeNull();
    expect(page.viewer[0]).toEqual({
      postId,
      lastReadAt: null,
      newReplyCount: 0,
      following: false,
    });

    await markChannelRead(postId, carol.id);
    await markChannelRead(forumId, carol.id);
    await postChannelMessage({ author: bob as never, channelId: postId, body: "mais info" });
    await postChannelMessage({ author: alice as never, channelId: postId, body: "resposta" });
    // Carol's own reply never counts as new for her.
    await postChannelMessage({ author: carol as never, channelId: postId, body: "valeu" });

    page = await list(carol);
    expect(page.forumPreviousReadAt).not.toBeNull();
    expect(page.viewer[0]?.lastReadAt).not.toBeNull();
    expect(page.viewer[0]?.newReplyCount).toBe(2);
  });

  it("a private forum's list, detail, posts and messages fail closed for a non-member", async () => {
    const privateForum = await createForum("staff", { isPrivate: true });
    const created = await post(alice, "Interno", {}, privateForum);
    expect(created.status).toBe(201);
    const postId = created.body.post.id;

    expect((await call(bob, "GET", `/api/channels/${privateForum}/posts`)).status).toBe(404);
    expect((await call(bob, "GET", `/api/forum-posts/${postId}`)).status).toBe(404);
    expect((await call(bob, "GET", `/api/channels/${postId}/messages`)).status).toBe(404);
    expect((await post(bob, "Entrando", {}, privateForum)).status).toBe(404);
    expect(
      (await call(bob, "GET", `/api/channels/${privateForum}/forum-tags`)).status,
    ).toBe(404);
    // A text channel is not a forum.
    const text = await call<{ channel: { id: string } }>(
      alice,
      "POST",
      `/api/servers/${serverId}/channels`,
      { name: "geral-2", type: "text" },
    );
    expect(
      (await call(alice, "GET", `/api/channels/${text.body.channel.id}/posts`)).status,
    ).toBe(404);
  });

  // ------------------------------------------------------ detail + patch

  it("the detail carries the accepted answer and the people who wrote", async () => {
    const created = await post(bob, "Como instalo?");
    const postId = created.body.post.id;
    const answer = await postChannelMessage({
      author: carol as never,
      channelId: postId,
      body: "Assim:   roda o instalador\n e reinicia",
    });
    await postChannelMessage({ author: bob as never, channelId: postId, body: "funcionou" });
    expect(answer.ok).toBe(true);
    const answerId = answer.ok ? answer.message.id : "";

    // Bob (OP) marks Carol's reply: the post becomes resolved.
    const marked = await call<{ post: ForumPostSummary }>(
      bob,
      "PATCH",
      `/api/forum-posts/${postId}`,
      { acceptedAnswerId: answerId },
    );
    expect(marked.status).toBe(200);
    expect(marked.body.post.acceptedAnswerId).toBe(answerId);
    expect(marked.body.post.resolvedAt).not.toBeNull();

    let detail = forumPostDetailResponseSchema.parse(
      (await call(alice, "GET", `/api/forum-posts/${postId}`)).body,
    );
    expect(detail.participantCount).toBe(2);
    expect(detail.acceptedAnswer).toMatchObject({
      messageId: answerId,
      deleted: false,
      authorId: carol.id,
      authorName: "Carol",
      excerpt: "Assim: roda o instalador e reinicia",
      // "Solução · marcada por Bob": the OP picked it.
      markedById: bob.id,
      markedByName: "Bob",
    });

    // Staff picking another answer becomes the one who marked it.
    const second = await postChannelMessage({
      author: carol as never,
      channelId: postId,
      body: "Ou atualiza o driver",
    });
    const secondId = second.ok ? second.message.id : "";
    expect(
      (await call(alice, "PATCH", `/api/forum-posts/${postId}`, { acceptedAnswerId: secondId }))
        .status,
    ).toBe(200);
    detail = forumPostDetailResponseSchema.parse(
      (await call(bob, "GET", `/api/forum-posts/${postId}`)).body,
    );
    expect(detail.acceptedAnswer).toMatchObject({ messageId: secondId, markedById: alice.id });
    // Back to Carol's first answer, marked by Bob again, for the rest below.
    await call(bob, "PATCH", `/api/forum-posts/${postId}`, { acceptedAnswerId: answerId });

    // The opening message cannot be the answer, nor can another post's reply.
    const opening = await getPool().query<{ opening_message_id: string }>(
      `SELECT opening_message_id FROM forum_posts WHERE channel_id = $1`,
      [postId],
    );
    const invalid = await call(bob, "PATCH", `/api/forum-posts/${postId}`, {
      acceptedAnswerId: opening.rows[0]!.opening_message_id,
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("forum_answer_invalid");

    // A deleted answer keeps its id and reads as deleted; the post stays resolved.
    await getPool().query(`DELETE FROM messages WHERE id = $1`, [answerId]);
    detail = forumPostDetailResponseSchema.parse(
      (await call(alice, "GET", `/api/forum-posts/${postId}`)).body,
    );
    expect(detail.acceptedAnswer).toMatchObject({ messageId: answerId, deleted: true });
    expect(detail.post.resolvedAt).not.toBeNull();

    // Reopening clears both.
    const reopened = await call<{ post: ForumPostSummary }>(
      bob,
      "PATCH",
      `/api/forum-posts/${postId}`,
      { resolved: false },
    );
    expect(reopened.body.post.resolvedAt).toBeNull();
    expect(reopened.body.post.acceptedAnswerId).toBeNull();
    const marker = await getPool().query<{ resolved_by: string | null }>(
      `SELECT resolved_by FROM forum_posts WHERE channel_id = $1`,
      [postId],
    );
    expect(marker.rows[0]?.resolved_by).toBeNull();

    // A deleted opening message: the post stays, the card says so.
    await getPool().query(`DELETE FROM messages WHERE id = $1`, [
      opening.rows[0]!.opening_message_id,
    ]);
    resetReadCacheForTests();
    const card = (await list(bob)).posts[0]!;
    expect(card.openingDeleted).toBe(true);
    expect(card.preview).toBeNull();
    expect(card.openingKind).toBeNull();
  });

  it("strips markdown from the card preview", async () => {
    // A MonitoRSS item opens with `**title**` and a link; the card must read
    // as words, not syntax. Same rules as the DM list preview.
    const created = await post(bob, "Patch 1.4.2", {
      body: "**Patch 1.4.2: correções de rede**\nVeja [o changelog](https://example.com/x) e roda `npm i`.\nhttps://example.com/p?utm_source=rss&utm_medium=feed",
    });
    expect(created.status).toBe(201);
    expect(created.body.post.preview).toBe(
      "Patch 1.4.2: correções de rede Veja o changelog e roda npm i. https://example.com/p?utm_source=rss&utm_medium=feed",
    );
    expect((await list(bob)).posts.find((one) => one.id === created.body.post.id)?.preview).toBe(
      "Patch 1.4.2: correções de rede Veja o changelog e roda npm i. https://example.com/p?utm_source=rss&utm_medium=feed",
    );
  });

  it("a post that is only a clip gives the card its video, never as the image thumbnail", async () => {
    // A remote row is the only attachment a test can mint without storage;
    // the remote helper takes image hosts only, so the row is made a video
    // afterwards, which is all the summary reads.
    const clip = await createRemoteAttachment({
      channelId: forumId,
      uploaderId: bob.id,
      url: "https://static.klipy.com/gifs/abc/clip.webp",
      filename: "clip.webp",
      contentType: "image/webp",
      width: 640,
      height: 360,
    });
    await getPool().query(
      `UPDATE message_attachments
          SET content_type = 'video/mp4', filename = 'clip.mp4'
        WHERE id = $1`,
      [clip.id],
    );
    const created = await post(bob, "Gravei o bug", { body: "", attachmentIds: [clip.id] });
    expect(created.status).toBe(201);
    const summary = forumPostSummarySchema.parse(created.body.post);
    expect(summary.thumbnailUrl).toBeNull();
    expect(summary.thumbnailVideoUrl).toBe("https://static.klipy.com/gifs/abc/clip.webp");
    expect(summary.openingKind).toBe("attachment");
    const listed = (await list(bob)).posts.find((one) => one.id === summary.id)!;
    expect(listed.thumbnailVideoUrl).toBe("https://static.klipy.com/gifs/abc/clip.webp");
  });

  it("patch permissions field by field, the pin cap, and the audit trail", async () => {
    const [bug, oficial] = await putTags([
      { name: "Bug", moderated: false },
      { name: "Oficial", moderated: true },
    ]);
    const bobs = (await post(bob, "Do Bob")).body.post.id;

    // Somebody else may not retitle, retag or resolve it, nor pin or lock anything.
    expect(
      (await call(carol, "PATCH", `/api/forum-posts/${bobs}`, { title: "Meu agora" })).status,
    ).toBe(403);
    expect(
      (await call(carol, "PATCH", `/api/forum-posts/${bobs}`, { resolved: true })).status,
    ).toBe(403);
    expect((await call(bob, "PATCH", `/api/forum-posts/${bobs}`, { pinned: true })).status).toBe(
      403,
    );
    expect((await call(bob, "PATCH", `/api/forum-posts/${bobs}`, { locked: true })).status).toBe(
      403,
    );

    // The author retitles and retags their own post; no audit row for that.
    const own = await call<{ post: ForumPostSummary }>(bob, "PATCH", `/api/forum-posts/${bobs}`, {
      title: "Do Bob, editado",
      tagIds: [bug!.id],
    });
    expect(own.status).toBe(200);
    expect(own.body.post.title).toBe("Do Bob, editado");
    expect(own.body.post.tagIds).toEqual([bug!.id]);
    // ...but not with a staff-only tag.
    const staffTag = await call(bob, "PATCH", `/api/forum-posts/${bobs}`, {
      tagIds: [bug!.id, oficial!.id],
    });
    expect(staffTag.status).toBe(403);
    expect(staffTag.body.error).toBe("forum_tag_moderated");

    // Staff puts the staff tag on; the author can then edit other tags and
    // keep it, but not take it off.
    expect(
      (
        await call(alice, "PATCH", `/api/forum-posts/${bobs}`, {
          tagIds: [bug!.id, oficial!.id],
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(bob, "PATCH", `/api/forum-posts/${bobs}`, { tagIds: [oficial!.id] })).status,
    ).toBe(200);
    expect(
      (await call(bob, "PATCH", `/api/forum-posts/${bobs}`, { tagIds: [] })).status,
    ).toBe(403);

    // Lock, then the pin cap: three, and the fourth is 409.
    expect(
      (await call(alice, "PATCH", `/api/forum-posts/${bobs}`, { locked: true })).status,
    ).toBe(200);
    const others = [];
    for (let i = 0; i < 3; i += 1) {
      others.push((await post(alice, `Fixo ${i}`)).body.post.id);
    }
    for (const id of others) {
      expect((await call(alice, "PATCH", `/api/forum-posts/${id}`, { pinned: true })).status).toBe(
        200,
      );
    }
    const fourth = await call(alice, "PATCH", `/api/forum-posts/${bobs}`, { pinned: true });
    expect(fourth.status).toBe(409);
    expect(fourth.body).toMatchObject({ error: "forum_pin_limit", max: 3 });
    // Pinning an already pinned post is a no-op, not a cap hit.
    expect(
      (await call(alice, "PATCH", `/api/forum-posts/${others[0]}`, { pinned: true })).status,
    ).toBe(200);

    const audit = await getPool().query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM audit_log WHERE action LIKE 'forum.%' ORDER BY created_at`,
    );
    const actions = audit.rows.map((row) => row.action);
    expect(actions.filter((a) => a === "forum.post_pin")).toHaveLength(3);
    expect(actions.filter((a) => a === "forum.post_lock")).toHaveLength(1);
    // Alice's tag edit on Bob's post is a staff edit; Bob's own edits are not.
    expect(actions.filter((a) => a === "forum.post_edit")).toHaveLength(1);
    expect(audit.rows.every((row) => row.actor_id === alice.id)).toBe(true);

    // A timed-out author cannot edit their post (the path names no server,
    // so the request gate cannot see it).
    await issueTimeout({ serverId, userId: bob.id, issuedBy: alice.id, minutes: 5 });
    expect(
      (await call(bob, "PATCH", `/api/forum-posts/${bobs}`, { title: "Calado" })).status,
    ).toBe(403);
  });

  it("delete is staff only and takes the post, its replies and its tags", async () => {
    const [bug] = await putTags([{ name: "Bug", moderated: false }]);
    const created = await post(bob, "Vai sumir", { tagIds: [bug!.id] });
    const postId = created.body.post.id;
    await postChannelMessage({ author: carol as never, channelId: postId, body: "uma resposta" });

    expect((await call(bob, "DELETE", `/api/forum-posts/${postId}`)).status).toBe(403);
    expect((await call(alice, "DELETE", `/api/forum-posts/${postId}`)).status).toBe(204);

    for (const sql of [
      `SELECT 1 FROM channels WHERE id = $1`,
      `SELECT 1 FROM forum_posts WHERE channel_id = $1`,
      `SELECT 1 FROM forum_post_tags WHERE post_id = $1`,
      `SELECT 1 FROM messages WHERE channel_id = $1`,
    ]) {
      expect((await getPool().query(sql, [postId])).rowCount).toBe(0);
    }
    expect((await list(bob)).posts).toEqual([]);
    const audit = await getPool().query<{ changes: Array<{ old: string }> }>(
      `SELECT changes FROM audit_log WHERE action = 'forum.post_delete'`,
    );
    expect(audit.rows[0]?.changes[0]?.old).toBe("Vai sumir");
    expect((await call(alice, "GET", `/api/forum-posts/${postId}`)).status).toBe(404);
  });

  // ------------------------------------------------------ tags, settings

  it("tags: create, swap names, reorder, delete, with post counts; staff only", async () => {
    expect(
      (
        await call(bob, "PUT", `/api/channels/${forumId}/forum-tags`, {
          tags: [{ name: "Minha", moderated: false }],
        })
      ).status,
    ).toBe(403);

    const [a, b, c] = await putTags([
      { name: "Dúvida", emoji: "❓", moderated: false },
      { name: "Bug", moderated: false },
      { name: "Sugestão", moderated: false },
    ]);
    await post(bob, "Com bug", { tagIds: [b!.id] });

    // Swap two names in one save, reorder, drop the third.
    const after = await putTags([
      { id: b!.id, name: "Dúvida", moderated: false },
      { id: a!.id, name: "Bug", emoji: null, moderated: true },
    ]);
    const parsed = after.map((tag) => forumTagSchema.parse(tag));
    expect(parsed.map((tag) => [tag.id, tag.name, tag.position, tag.postCount])).toEqual([
      [b!.id, "Dúvida", 0, 1],
      [a!.id, "Bug", 1, 0],
    ]);
    expect(parsed[1]?.moderated).toBe(true);
    expect(
      (await getPool().query(`SELECT 1 FROM forum_tags WHERE id = $1`, [c!.id])).rowCount,
    ).toBe(0);

    // A duplicate name (case-insensitive) is refused by the schema.
    const dup = await call(alice, "PUT", `/api/channels/${forumId}/forum-tags`, {
      tags: [
        { name: "Bug", moderated: false },
        { name: "bug", moderated: false },
      ],
    });
    expect(dup.status).toBe(400);
    // And accent-insensitive: "Dúvida" and "duvida" are one tag.
    const accented = await call(alice, "PUT", `/api/channels/${forumId}/forum-tags`, {
      tags: [
        { name: "Dúvida", moderated: false },
        { name: "duvida", moderated: false },
      ],
    });
    expect(accented.status).toBe(400);
    // An id from another forum is unknown here.
    const other = await createForum("outro");
    const foreign = await call<{ tags: Array<{ id: string }> }>(
      alice,
      "PUT",
      `/api/channels/${other}/forum-tags`,
      { tags: [{ name: "X", moderated: false }] },
    );
    const misplaced = await call(alice, "PUT", `/api/channels/${forumId}/forum-tags`, {
      tags: [{ id: foreign.body.tags[0]!.id, name: "X", moderated: false }],
    });
    expect(misplaced.status).toBe(400);

    const read = await call<{ tags: unknown[] }>(bob, "GET", `/api/channels/${forumId}/forum-tags`);
    expect(read.body.tags).toHaveLength(2);
    const audit = await getPool().query(
      `SELECT 1 FROM audit_log WHERE action = 'forum.tags_update' AND target_id = $1`,
      [forumId],
    );
    expect(audit.rowCount).toBe(2);
  });

  it("tags: icons and presets. A starter keeps its preset until renamed; an older client still works", async () => {
    const put = async (tags: Array<Record<string, unknown>>) => {
      const reply = await call<{ tags: unknown[] }>(
        alice,
        "PUT",
        `/api/channels/${forumId}/forum-tags`,
        { tags },
      );
      expect(reply.status).toBe(200);
      return reply.body.tags.map((tag) => forumTagSchema.parse(tag));
    };

    // A client that knows presets: the preset counts only when the name fits it.
    const created = await put([
      { name: "Question", preset: "question", icon: "question", emoji: "❓", moderated: false },
      { name: "Whatever", preset: "bug", icon: "bug", emoji: null, moderated: false },
      { name: "Custom", preset: null, icon: null, emoji: null, moderated: false },
    ]);
    expect(created.map((tag) => [tag.name, tag.preset, tag.icon])).toEqual([
      ["Question", "question", "question"],
      ["Whatever", null, "bug"],
      ["Custom", null, null],
    ]);
    const [question, whatever, custom] = created;

    // An unchanged name keeps the preset whatever else was edited; the icon
    // follows the request, and the request cannot move the preset by itself.
    const kept = await put([
      { id: question!.id, name: "Question", icon: "help", preset: "bug", moderated: true },
      { id: whatever!.id, name: "Whatever", moderated: false },
      { id: custom!.id, name: "Custom", moderated: false },
    ]);
    expect(kept[0]).toMatchObject({ preset: "question", icon: "help", moderated: true });
    // No `icon` in the request: an older client leaves the stored one alone.
    expect(kept[1]).toMatchObject({ preset: null, icon: "bug" });

    // A rename ends the localization.
    const renamed = await put([
      { id: question!.id, name: "Pergunte", icon: "help", moderated: true },
      { id: whatever!.id, name: "Whatever", moderated: false },
      { id: custom!.id, name: "Custom", moderated: false },
    ]);
    expect(renamed[0]).toMatchObject({ name: "Pergunte", preset: null });

    // An older client (no icon, no preset) creating the starter chips: the
    // name is recognised and the emoji becomes the nearest icon.
    await put([]);
    const legacy = await put([
      { name: "Dúvida", emoji: "❓", moderated: false },
      { name: "Lançamento", emoji: "🚀", moderated: false },
      { name: "Receitas", emoji: "🍲", moderated: false },
    ]);
    expect(legacy.map((tag) => [tag.preset, tag.icon, tag.emoji])).toEqual([
      ["question", "question", "❓"],
      ["release", "release", "🚀"],
      [null, null, "🍲"],
    ]);
    // ... and a changed emoji from such a client re-derives the icon, never
    // leaving an icon that disagrees with the glyph beside it.
    const swapped = await put([
      { id: legacy[0]!.id, name: "Dúvida", emoji: "💡", moderated: false },
      { id: legacy[1]!.id, name: "Lançamento", emoji: "🚀", moderated: false },
      { id: legacy[2]!.id, name: "Receitas", emoji: null, moderated: false },
    ]);
    expect(swapped.map((tag) => [tag.preset, tag.icon])).toEqual([
      ["question", "idea"],
      ["release", "release"],
      [null, null],
    ]);

    // An unknown icon key is refused; the GET carries the new fields.
    const bad = await call(alice, "PUT", `/api/channels/${forumId}/forum-tags`, {
      tags: [{ name: "X", icon: "not-an-icon", moderated: false }],
    });
    expect(bad.status).toBe(400);
    const read = await call<{ tags: Array<Record<string, unknown>> }>(
      bob,
      "GET",
      `/api/channels/${forumId}/forum-tags`,
    );
    expect(read.body.tags[0]).toMatchObject({ preset: "question", icon: "idea" });
  });

  it("two first saves of a forum's settings, queued on its lock, each audit what they changed", async () => {
    // Before a forum's first save there is no settings row for FOR UPDATE to
    // lock, which is why `updateForumSettings` takes a per-forum advisory
    // lock. The interleaving is fixed here rather than left to timing: the
    // test holds that same lock, lets "on" queue behind it, then "off", and
    // releases. Postgres grants a lock's waiters in queue order, so "on" runs
    // first against the defaults and "off" runs second against "on". Each
    // must audit its own change, read inside the lock.
    const forum = await createForum("corrida");
    const lockSql = `SELECT pg_advisory_xact_lock(hashtext('forum-settings:' || $1))`;
    const waiting = async () =>
      (
        await getPool().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted`,
        )
      ).rows[0]!.n;
    const untilWaiting = async (n: number) => {
      const deadline = Date.now() + 10_000;
      while ((await waiting()) < n) {
        if (Date.now() > deadline) {
          throw new Error(`never saw ${n} waiter(s) on the settings lock`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    const holder = await getPool().connect();
    let on: ReturnType<typeof call> | undefined;
    let off: ReturnType<typeof call> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query(lockSql, [forum]);
      on = call(alice, "PATCH", `/api/channels/${forum}/forum-settings`, { requireTag: true });
      await untilWaiting(1);
      off = call(alice, "PATCH", `/api/channels/${forum}/forum-settings`, {
        requireTag: false,
      });
      await untilWaiting(2);
    } finally {
      await holder.query("COMMIT").catch(() => {});
      holder.release();
    }
    expect((await on!).status).toBe(200);
    expect((await off!).status).toBe(200);

    const stored = await getPool().query<{ require_tag: boolean }>(
      `SELECT require_tag FROM forum_settings WHERE forum_id = $1`,
      [forum],
    );
    expect(stored.rows[0]?.require_tag).toBe(false);
    // By `id`, the insert order. NOT `created_at`: that is the transaction's
    // start time, and the save that waited longest on the lock started first.
    const trail = await getPool().query<{
      changes: Array<{ key: string; old: boolean; new: boolean }>;
    }>(
      `SELECT changes FROM audit_log
        WHERE action = 'forum.settings_update' AND target_id = $1
        ORDER BY id`,
      [forum],
    );
    expect(trail.rows.map((row) => row.changes)).toEqual([
      [{ key: "requireTag", old: false, new: true }],
      [{ key: "requireTag", old: true, new: false }],
    ]);
  });

  it("settings: defaults, the default sort is what an unsorted list uses, staff only", async () => {
    expect((await call(bob, "GET", `/api/channels/${forumId}/forum-settings`)).body).toEqual({
      settings: { requireTag: false, defaultSort: "activity" },
    });
    expect(
      (await call(bob, "PATCH", `/api/channels/${forumId}/forum-settings`, { requireTag: true }))
        .status,
    ).toBe(403);
    const old = (await post(bob, "Antigo")).body.post.id;
    const fresh = (await post(carol, "Novo")).body.post.id;
    await postChannelMessage({ author: alice as never, channelId: old, body: "bump" });
    expect((await list(bob)).posts.map((p) => p.id)).toEqual([old, fresh]);

    await call(alice, "PATCH", `/api/channels/${forumId}/forum-settings`, {
      defaultSort: "created",
    });
    expect((await list(bob)).posts.map((p) => p.id)).toEqual([fresh, old]);
  });

  it("follows: the author follows automatically, and stopping is remembered", async () => {
    const postId = (await post(bob, "Seguindo")).body.post.id;
    const off = await call<{ viewer: { following: boolean } }>(
      bob,
      "PUT",
      `/api/forum-posts/${postId}/follow`,
      { following: false },
    );
    expect(off.body.viewer.following).toBe(false);
    const row = await getPool().query<{ muted: boolean }>(
      `SELECT muted FROM forum_post_follows WHERE post_id = $1 AND user_id = $2`,
      [postId, bob.id],
    );
    expect(row.rows[0]?.muted).toBe(true);
    const on = await call<{ viewer: { following: boolean } }>(
      carol,
      "PUT",
      `/api/forum-posts/${postId}/follow`,
      { following: true },
    );
    expect(on.body.viewer.following).toBe(true);
  });

  it("similar posts share words with the title, resolved first", async () => {
    const open = (await post(bob, "Notebook não liga depois da atualização")).body.post.id;
    const solved = (await post(carol, "Notebook nao liga na tomada")).body.post.id;
    await post(carol, "Mouse sem fio parou");
    await call(carol, "PATCH", `/api/forum-posts/${solved}`, { resolved: true });

    const reply = await call<{ posts: ForumPostSummary[] }>(
      alice,
      "GET",
      `/api/channels/${forumId}/posts/similar?title=${encodeURIComponent("meu notebook não liga")}`,
    );
    expect(reply.status).toBe(200);
    expect(reply.body.posts.map((p) => p.id)).toEqual([solved, open]);
    const none = await call<{ posts: unknown[] }>(
      alice,
      "GET",
      `/api/channels/${forumId}/posts/similar?title=${encodeURIComponent("teclado")}`,
    );
    expect(none.body.posts).toEqual([]);
    expect(
      (await call(alice, "GET", `/api/channels/${forumId}/posts/similar?title=`)).status,
    ).toBe(400);
  });

  it("a post's thread channel is never visible without its forum_posts row", async () => {
    // The send path (forum PR 2) caches "a thread with no forum_posts row is a
    // chat thread" for the life of the process, so the two rows must commit
    // together: a reader on another connection may see both or neither, never
    // the channel alone. Poll for exactly that state on a second connection
    // while shells are created, nonce conflicts roll back and shells are
    // discarded.
    const orphanSql = `SELECT count(*)::int AS n
                         FROM channels c
                         LEFT JOIN forum_posts p ON p.channel_id = c.id
                        WHERE c.parent_id = $1 AND c.type = 'thread'
                          AND p.channel_id IS NULL`;
    let polling = true;
    let polls = 0;
    let orphansSeen = 0;
    const poller = (async () => {
      while (polling) {
        const result = await getPool().query<{ n: number }>(orphanSql, [forumId]);
        orphansSeen += result.rows[0]!.n;
        polls += 1;
      }
    })();

    // Waves of six, so the creates plus the poller stay inside the pool.
    for (let wave = 0; wave < 6; wave += 1) {
      await Promise.all(
        Array.from({ length: 6 }, (_, j) => {
          const i = wave * 6 + j;
          return createForumPostShell({
            forumId,
            serverId,
            authorId: bob.id,
            title: `Concorrente ${i}`,
            tagIds: [],
            // Every third shares a nonce with the one before it: the loser's
            // channel row is inserted, then rolled back with its forum_posts row.
            nonce: `race-${i - (i % 3 === 2 ? 1 : 0)}`,
          }).catch((error: unknown) => error);
        }),
      );
    }
    expect(await sweepForumPostShells()).toBe(0);
    await getPool().query(
      `UPDATE forum_posts SET created_at = NOW() - INTERVAL '15 minutes' WHERE forum_id = $1`,
      [forumId],
    );
    await sweepForumPostShells();
    polling = false;
    await poller;

    expect(polls).toBeGreaterThan(0);
    expect(orphansSeen).toBe(0);
    expect((await getPool().query<{ n: number }>(orphanSql, [forumId])).rows[0]!.n).toBe(0);
  });

  it("the post routes answer 404 for a chat thread", async () => {
    const text = await call<{ channel: { id: string } }>(
      alice,
      "POST",
      `/api/servers/${serverId}/channels`,
      { name: "geral-3", type: "text" },
    );
    const thread = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position, is_private, kind, parent_id)
       VALUES ($1, 'conversa', 'thread', 0, FALSE, 'server', $2) RETURNING id`,
      [serverId, text.body.channel.id],
    );
    const id = thread.rows[0]!.id;
    expect((await call(bob, "GET", `/api/forum-posts/${id}`)).status).toBe(404);
    expect((await call(alice, "PATCH", `/api/forum-posts/${id}`, { pinned: true })).status).toBe(
      404,
    );
    expect((await call(alice, "DELETE", `/api/forum-posts/${id}`)).status).toBe(404);
  });

  // ------------------------------------------------------------ hardening

  const golpeRule = (exemptChannelIds: string[] = []) =>
    createAutomodRule(serverId, {
      kind: "keywords",
      enabled: true,
      keywords: ["golpe"],
      allowList: [],
      mentionLimit: 5,
      exemptRoleIds: [],
      exemptChannelIds,
      customMessage: "",
      alertChannelId: null,
      timeoutMinutes: 0,
      blockPqpInvites: false,
    } as Parameters<typeof createAutomodRule>[1]);

  it("a post AutoMod refuses on its title costs no send budget", async () => {
    await golpeRule();
    // Twelve refusals: more than the whole send burst (10).
    for (let i = 0; i < 12; i += 1) {
      const refused = await post(bob, `Golpe ${i}`);
      expect(refused.status).toBe(422);
      expect(refused.body.reason).toBe("automod");
    }
    expect((await post(bob, "Pergunta honesta")).status).toBe(201);
  });

  it("an exempted forum covers its posts on edit too, without AutoMod looking the parent up", async () => {
    await golpeRule([forumId]);
    const created = await post(bob, "Sobre golpe", { body: "como evitar golpe" });
    expect(created.status).toBe(201);
    const reply = await postChannelMessage({
      author: bob as never,
      channelId: created.body.post.id,
      body: "resposta",
    });
    expect(reply.ok).toBe(true);
    const replyId = reply.ok ? reply.message.id : "";
    // The edit route hands AutoMod the parent it read in its access check.
    expect(
      (await call(bob, "PATCH", `/api/messages/${replyId}`, { body: "outro golpe" })).status,
    ).toBe(200);
    // An ordinary channel is still filtered on edit.
    const general = await getPool().query<{ id: string }>(
      `SELECT id FROM channels WHERE server_id = $1 AND type = 'text' LIMIT 1`,
      [serverId],
    );
    const plain = await postChannelMessage({
      author: bob as never,
      channelId: general.rows[0]!.id,
      body: "oi",
    });
    const plainId = plain.ok ? plain.message.id : "";
    expect(
      (await call(bob, "PATCH", `/api/messages/${plainId}`, { body: "golpe" })).status,
    ).toBe(422);
  });

  it("forum audit rows commit with their change: a failed audit undoes it, and the retry writes both", async () => {
    // Refuse chosen audit actions at the database, the way a real failure of
    // that INSERT would land: inside whatever transaction it runs in.
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS forum_test_audit_fail (action TEXT PRIMARY KEY);
      CREATE OR REPLACE FUNCTION forum_test_audit_fail() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM forum_test_audit_fail WHERE action = NEW.action) THEN
          RAISE EXCEPTION 'audit refused for the test';
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS forum_test_audit_fail ON audit_log;
      CREATE TRIGGER forum_test_audit_fail BEFORE INSERT ON audit_log
        FOR EACH ROW EXECUTE FUNCTION forum_test_audit_fail();`);
    const fail = (action: string) =>
      getPool().query(`INSERT INTO forum_test_audit_fail (action) VALUES ($1)`, [action]);
    const heal = () => getPool().query(`DELETE FROM forum_test_audit_fail`);
    const audits = async (action: string) =>
      (await getPool().query(`SELECT 1 FROM audit_log WHERE action = $1`, [action])).rowCount;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const postId = (await post(bob, "Vai ser fixado")).body.post.id;

      // Pin.
      await fail("forum.post_pin");
      expect(
        (await call(alice, "PATCH", `/api/forum-posts/${postId}`, { pinned: true })).status,
      ).toBe(500);
      const notPinned = await getPool().query<{ pinned_at: Date | null }>(
        `SELECT pinned_at FROM forum_posts WHERE channel_id = $1`,
        [postId],
      );
      expect(notPinned.rows[0]?.pinned_at).toBeNull();
      await heal();
      expect(
        (await call(alice, "PATCH", `/api/forum-posts/${postId}`, { pinned: true })).status,
      ).toBe(200);
      expect(await audits("forum.post_pin")).toBe(1);

      // Tags.
      await fail("forum.tags_update");
      const tagsRefused = await call(alice, "PUT", `/api/channels/${forumId}/forum-tags`, {
        tags: [{ name: "Bug", moderated: false }],
      });
      expect(tagsRefused.status).toBe(500);
      expect((await getPool().query(`SELECT 1 FROM forum_tags`)).rowCount).toBe(0);
      await heal();
      await putTags([{ name: "Bug", moderated: false }]);
      expect(await audits("forum.tags_update")).toBe(1);

      // Settings.
      await fail("forum.settings_update");
      expect(
        (
          await call(alice, "PATCH", `/api/channels/${forumId}/forum-settings`, {
            requireTag: true,
          })
        ).status,
      ).toBe(500);
      expect((await call(bob, "GET", `/api/channels/${forumId}/forum-settings`)).body).toEqual({
        settings: { requireTag: false, defaultSort: "activity" },
      });
      await heal();
      expect(
        (
          await call(alice, "PATCH", `/api/channels/${forumId}/forum-settings`, {
            requireTag: true,
          })
        ).status,
      ).toBe(200);
      expect(await audits("forum.settings_update")).toBe(1);

      // Delete: the post survives a failed audit, so the retry can still
      // delete it and write the row.
      await fail("forum.post_delete");
      expect((await call(alice, "DELETE", `/api/forum-posts/${postId}`)).status).toBe(500);
      expect((await call(bob, "GET", `/api/forum-posts/${postId}`)).status).toBe(200);
      await heal();
      expect((await call(alice, "DELETE", `/api/forum-posts/${postId}`)).status).toBe(204);
      expect(await audits("forum.post_delete")).toBe(1);
      expect((await call(bob, "GET", `/api/forum-posts/${postId}`)).status).toBe(404);
    } finally {
      error.mockRestore();
      await getPool().query(`
        DROP TRIGGER IF EXISTS forum_test_audit_fail ON audit_log;
        DROP FUNCTION IF EXISTS forum_test_audit_fail();
        DROP TABLE IF EXISTS forum_test_audit_fail;`);
    }
  });

  it("the cached first page shows a new post the moment it is published", async () => {
    await post(bob, "Primeiro");
    expect((await list(carol)).posts).toHaveLength(1);
    // Cached now; a write invalidates it on this process.
    await post(carol, "Segundo");
    expect((await list(carol)).posts.map((p) => p.title)).toEqual(["Segundo", "Primeiro"]);
  });
});

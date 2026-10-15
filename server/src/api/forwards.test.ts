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
import type { WebSocket } from "ws";

/**
 * ENCAMINHAR, on a real Postgres, through the HTTP door and the chat's own
 * fan-out. What this pins:
 *
 *   * THE FLAG IS A REAL SWITCH. Turned on by a `feature_flags` row after
 *     `startFeatureFlags()` (what the dashboard writes), never by the
 *     environment alone (CLAUDE.md pitfalls 9 and 12). Off: 404, and the
 *     config says so.
 *   * A FORWARD IS A MESSAGE. It lands in the channel through `postChannelMessage`,
 *     reaches a socket joined to the channel, reads back through the history
 *     route, parses with the shared schema and carries the fallback body an old
 *     client shows.
 *   * RESTRICTED NEVER LEAVES ITS SERVER. A members-only post and a private
 *     channel's message go to the same server and nowhere else, not even to a
 *     DM, and a refused DM target creates no conversation. A VIP snapshot never
 *     holds the body or the author, even when an unlocked reader forwards it.
 *   * NOBODY GETS PINGED BY A SNAPSHOT. `@everyone` never fires from a forward,
 *     and a name inside the snapshot or the fallback line mentions no one.
 *   * PERMISSIONS ARE THE CHAT'S. No SEND_MESSAGES, an invisible channel, slow
 *     mode and the send budget each refuse their own target and leave the rest.
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
const { handleApi, resetApiRateLimits } = await import("./index.js");
const { startFeatureFlags, setGlobalFlag, resetFeatureFlagsForTests } = await import(
  "../lib/flags.js"
);
const { upsertUser } = await import("../services/users.js");
const { createServer: createChatServer, createChannel, addChannelMember } = await import(
  "../services/servers.js"
);
const { createRole, assignRole, upsertChannelOverwrite } = await import(
  "../services/roles.js"
);
const { createMessage } = await import("../services/messages.js");
const chatModule = await import("../ws/chat.js");
const { handleChatMessage, resetChatRateLimits } = chatModule;
const {
  Permission,
  messageSchema,
  messageForwardSchema,
  isForwardFallbackBody,
  extractMentions,
  FORWARD_EXCERPT_MAX,
} = await import("@pqp/shared");
const { forwardExcerpt, dedupeForwardTargets, isStableYoutubePoster, defangMentionText } = await import(
  "../services/forwards.js"
);

type TestUser = { id: string; clerk_id: string };
type Frame = { type: string; message?: Record<string, unknown> };

let httpServer: Server;
let baseUrl: string;

async function call<T = Record<string, unknown>>(
  as: TestUser,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T; headers: Headers }> {
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
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
    headers: response.headers,
  };
}

type Result =
  | {
      ok: true;
      target: Record<string, string>;
      channelId: string;
      serverId: string | null;
      message: Record<string, unknown> & { id: string; body: string; forward?: Record<string, unknown> };
    }
  | { ok: false; target: Record<string, string>; reason: string; retryAfterMs?: number };

function recordingSocket() {
  const received: Frame[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => received.push(JSON.parse(payload) as Frame),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, received };
}

describe("forwardExcerpt", () => {
  it("is plain text, cut by characters, and never longer than the contract", () => {
    expect(forwardExcerpt("**oi** `x` [link](https://a.b) <:pqp:123e4567-e89b-12d3-a456-426614174000>")).toBe(
      "oi x link :pqp:",
    );
    expect(forwardExcerpt(null)).toBe("");
    const long = forwardExcerpt("palavra ".repeat(200));
    expect(Array.from(long).length).toBeLessThanOrEqual(FORWARD_EXCERPT_MAX);
    expect(long.endsWith("...")).toBe(true);
    // The schema counts UTF-16 units: 251 emoji are 502 of them and must be cut,
    // and a cut never lands inside a surrogate pair.
    const emoji = forwardExcerpt("\u{1F600}".repeat(251));
    expect(emoji.length).toBeLessThanOrEqual(FORWARD_EXCERPT_MAX);
    expect(emoji.includes("\uFFFD")).toBe(false);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji)).toBe(false);
    const mixed = forwardExcerpt(`${"a".repeat(496)}\u{1F600}\u{1F600}`);
    expect(mixed.length).toBeLessThanOrEqual(FORWARD_EXCERPT_MAX);
  });
});

describe("isStableYoutubePoster", () => {
  it("accepts only a public YouTube poster, never a signed bucket url", () => {
    expect(isStableYoutubePoster("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg")).toBe(true);
    expect(isStableYoutubePoster("https://bucket.example/p.jpg?X-Amz-Signature=abc")).toBe(false);
    expect(isStableYoutubePoster("http://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg")).toBe(false);
    expect(isStableYoutubePoster(null)).toBe(false);
  });
});

describe("dedupeForwardTargets", () => {
  it("drops repeats and keeps order", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    expect(
      dedupeForwardTargets([{ channelId: a }, { userId: b }, { channelId: a }, { userId: b }]),
    ).toEqual([{ channelId: a }, { userId: b }]);
  });
});

describeDb("POST /api/forwards", () => {
  let owner: TestUser;
  let member: TestUser;
  let friend: TestUser;
  let stranger: TestUser;
  let serverId: string;
  let generalId: string;
  let otherServerId: string;
  let otherGeneralId: string;
  let privateId: string;

  const makeUser = (name: string) =>
    upsertUser({ clerkId: `clerk_fw_${name}`, displayName: name, avatarUrl: null });

  async function flagOn(on: boolean | null) {
    await setGlobalFlag("forward_messages", on, { kind: "dashboard" });
  }

  beforeAll(async () => {
    await initDb();
    await startFeatureFlags();
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
    resetFeatureFlagsForTests();
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(
      `TRUNCATE users, feature_flags, feature_flag_overrides, feature_flag_audit RESTART IDENTITY CASCADE`,
    );
    resetApiRateLimits();
    resetChatRateLimits();
    process.env.COMMUNITY_HOME_ENABLED = "true";
    process.env.COMMUNITY_HOME_VIP_ENABLED = "true";
    await flagOn(true);

    owner = await makeUser("owner");
    member = await makeUser("member");
    friend = await makeUser("friend");
    stranger = await makeUser("stranger");

    const created = await createChatServer("QG", owner.id);
    serverId = created.server.id;
    for (const user of [member, friend]) {
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')
         ON CONFLICT DO NOTHING`,
        [serverId, user.id],
      );
    }
    await getPool().query(`UPDATE servers SET community_home_enabled = TRUE WHERE id = $1`, [
      serverId,
    ]);
    const channels = await getPool().query<{ id: string; type: string }>(
      `SELECT id, type FROM channels WHERE server_id = $1 ORDER BY position`,
      [serverId],
    );
    generalId = channels.rows.find((c) => c.type === "text")!.id;

    const other = await createChatServer("Outra", owner.id);
    otherServerId = other.server.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING`,
      [otherServerId, member.id],
    );
    const otherText = await getPool().query<{ id: string }>(
      `SELECT id FROM channels WHERE server_id = $1 AND type = 'text' LIMIT 1`,
      [otherServerId],
    );
    otherGeneralId = otherText.rows[0]!.id;

    const priv = await createChannel(serverId, "diretoria", "text", true);
    privateId = priv.id;
    await addChannelMember(privateId, owner.id);
  });

  afterEach(() => {
    delete process.env.COMMUNITY_HOME_ENABLED;
    delete process.env.COMMUNITY_HOME_VIP_ENABLED;
  });

  const home = () => `/api/servers/${serverId}/home`;

  async function publish(extra: Record<string, unknown> = {}): Promise<string> {
    const res = await call<{ post: { id: string } }>(owner, "POST", `${home()}/posts`, {
      status: "published",
      title: "Sessão 11",
      body: "o clip inteiro, com tudo que rolou",
      ...extra,
    });
    expect(res.status).toBe(201);
    return res.body.post.id;
  }

  const postSource = (postId: string) => ({
    kind: "bau_post" as const,
    id: postId,
    serverId,
  });

  async function forward(
    as: TestUser,
    source: unknown,
    targets: unknown[],
    extra: Record<string, unknown> = {},
  ) {
    return call<{ results: Result[] }>(as, "POST", "/api/forwards", {
      source,
      targets,
      ...extra,
    });
  }

  async function say(channelId: string, author: TestUser, body: string) {
    const created = await createMessage(channelId, author as never, body);
    return created!.id;
  }

  async function messageCount(channelId: string): Promise<number> {
    const r = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages WHERE channel_id = $1`,
      [channelId],
    );
    return r.rows[0]!.n;
  }

  async function mentionRows(): Promise<number> {
    const r = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM message_mentions`,
    );
    return r.rows[0]!.n;
  }

  // ------------------------------------------------------------------- flag

  it("flag off (the default) is a 404 and the config says off; on, the config says on", async () => {
    await flagOn(null);
    const postId = await publish();
    const off = await forward(owner, postSource(postId), [{ channelId: generalId }]);
    expect(off.status).toBe(404);
    expect(await messageCount(generalId)).toBe(0);
    expect((await call<{ enabled: boolean }>(owner, "GET", "/api/forwards/config")).body).toEqual({
      enabled: false,
    });
    await flagOn(true);
    expect((await call<{ enabled: boolean }>(owner, "GET", "/api/forwards/config")).body).toEqual({
      enabled: true,
    });
    const on = await forward(owner, postSource(postId), [{ channelId: generalId }]);
    expect(on.status).toBe(200);
    // And off again: a kill switch, not a one-way door.
    await flagOn(false);
    expect((await forward(owner, postSource(postId), [{ channelId: generalId }])).status).toBe(404);
  });

  // ------------------------------------------------------------- a Baú post

  it("forwards a free Baú post to a channel, another server and a DM, as a message", async () => {
    const postId = await publish();
    const viewer = recordingSocket();
    await handleChatMessage(
      { socket: viewer.socket, user: friend as never },
      { type: "join-channel", channelId: generalId },
    );

    const res = await forward(
      member,
      postSource(postId),
      [{ channelId: generalId }, { channelId: otherGeneralId }, { userId: friend.id }],
      { nonce: "dialog-1" },
    );
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
    const ok = res.body.results.filter((r): r is Extract<Result, { ok: true }> => r.ok);
    expect(ok).toHaveLength(3);

    const inGeneral = ok[0]!;
    expect(inGeneral.serverId).toBe(serverId);
    expect(ok[1]!.serverId).toBe(otherServerId);
    expect(ok[2]!.serverId).toBeNull();

    const forwardField = inGeneral.message.forward!;
    expect(messageForwardSchema.safeParse(forwardField).success).toBe(true);
    expect(forwardField).toMatchObject({
      v: 1,
      kind: "bau_post",
      sourceServerId: serverId,
      sourceServerName: "QG",
      sourceId: postId,
      title: "Sessão 11",
      excerpt: "o clip inteiro, com tudo que rolou",
      authorDisplayName: "owner",
    });
    expect(forwardField.url).toMatch(
      new RegExp(`^https?://[^/]+/app/server/${serverId}/bau/${postId}$`),
    );
    expect(forwardField.restricted).toBeUndefined();
    // Signed, expiring media urls are never stored; only a stable public one is.
    expect(forwardField.mediaThumbUrl).toBeUndefined();

    // No comment: the body is the fallback an old client shows.
    expect(inGeneral.message.body).toBe(
      `Encaminhado: Sessão 11 ${forwardField.url}`,
    );
    expect(isForwardFallbackBody(inGeneral.message.body, forwardField as never)).toBe(true);

    // The fan-out: a socket joined to the channel got the message with the card.
    const frames = viewer.received.filter((f) => f.type === "message-broadcast");
    expect(frames).toHaveLength(1);
    expect((frames[0]!.message as { forward?: unknown }).forward).toEqual(forwardField);
    expect(messageSchema.parse(frames[0]!.message).forward).toEqual(forwardField);

    // History, the way a reload reads it.
    const history = await call<{ messages: Array<Record<string, unknown>> }>(
      member,
      "GET",
      `/api/channels/${generalId}/messages`,
    );
    expect(history.body.messages).toHaveLength(1);
    expect(messageSchema.parse(history.body.messages[0]).forward).toEqual(forwardField);

    // The DM is a real 1:1 the friend is in; an ordinary message has no `forward` key at all.
    const dm = await call<{ messages: Array<Record<string, unknown>> }>(
      friend,
      "GET",
      `/api/channels/${ok[2]!.channelId}/messages`,
    );
    expect(dm.body.messages).toHaveLength(1);
    const plain = await say(generalId, member, "oi");
    const after = await call<{ messages: Array<Record<string, unknown>> }>(
      member,
      "GET",
      `/api/channels/${generalId}/messages`,
    );
    const plainRow = after.body.messages.find((m) => m.id === plain)!;
    expect("forward" in plainRow).toBe(false);
  });

  it("the comment becomes the body; the same nonce again posts nothing new", async () => {
    const postId = await publish();
    const send = () =>
      forward(member, postSource(postId), [{ channelId: generalId }], {
        comment: "  olha isso aqui  ",
        nonce: "retry-me",
      });
    const first = await send();
    const ok = first.body.results[0] as Extract<Result, { ok: true }>;
    expect(ok.message.body).toBe("olha isso aqui");
    expect(ok.message.forward).toBeDefined();
    const again = await send();
    expect((again.body.results[0] as Extract<Result, { ok: true }>).message.id).toBe(ok.message.id);
    expect(await messageCount(generalId)).toBe(1);
  });

  it("a draft, a scheduled post, an unknown post and a non-member are one 404", async () => {
    const draft = await call<{ post: { id: string } }>(owner, "POST", `${home()}/posts`, {
      status: "draft",
      title: "rascunho",
      body: "x",
    });
    const postId = await publish();
    expect((await forward(owner, postSource(draft.body.post.id), [{ channelId: generalId }])).status).toBe(404);
    expect(
      (await forward(owner, postSource("99999999-9999-4999-8999-999999999999"), [{ channelId: generalId }])).status,
    ).toBe(404);
    // Not a member of the QG: the post is not theirs to forward.
    expect((await forward(stranger, postSource(postId), [{ channelId: generalId }])).status).toBe(404);
    // Baú off for the server.
    await getPool().query(`UPDATE servers SET community_home_enabled = FALSE WHERE id = $1`, [serverId]);
    expect((await forward(owner, postSource(postId), [{ channelId: generalId }])).status).toBe(404);
    expect(await messageCount(generalId)).toBe(0);
  });

  it("a bad body is a 400: no targets, six targets, a post without its server, a target with both keys", async () => {
    const postId = await publish();
    const channels = [] as string[];
    for (let i = 0; i < 6; i += 1) {
      channels.push((await createChannel(serverId, `c${i}`, "text")).id);
    }
    expect((await forward(owner, postSource(postId), [])).status).toBe(400);
    expect(
      (await forward(owner, postSource(postId), channels.map((channelId) => ({ channelId })))).status,
    ).toBe(400);
    expect((await forward(owner, { kind: "bau_post", id: postId }, [{ channelId: generalId }])).status).toBe(400);
    expect(
      (await forward(owner, postSource(postId), [{ channelId: generalId, userId: friend.id }])).status,
    ).toBe(400);
    // Five is the ceiling and works.
    const five = await forward(owner, postSource(postId), channels.slice(0, 5).map((channelId) => ({ channelId })));
    expect(five.status).toBe(200);
    expect(five.body.results.every((r) => r.ok)).toBe(true);
  });

  it("duplicate targets are posted once", async () => {
    const postId = await publish();
    const res = await forward(owner, postSource(postId), [
      { channelId: generalId },
      { channelId: generalId },
    ]);
    expect(res.body.results).toHaveLength(1);
    expect(await messageCount(generalId)).toBe(1);
  });

  // ----------------------------------------------------------- restricted VIP

  it("a members-only post never leaves its server, and its card never holds the body or the author", async () => {
    const postId = await publish({
      visibility: "members",
      teaser: "só pra quem apoia",
      body: "segredo-do-clip",
    });
    const before = await getPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM channels`);
    const res = await forward(
      owner, // can unlock the post: the card must still be the locked view
      postSource(postId),
      [{ channelId: generalId }, { channelId: otherGeneralId }, { userId: friend.id }],
    );
    expect(res.status).toBe(200);
    const [same, elsewhere, dm] = res.body.results;
    expect(same!.ok).toBe(true);
    expect(elsewhere).toMatchObject({ ok: false, reason: "stays_in_server" });
    expect(dm).toMatchObject({ ok: false, reason: "stays_in_server" });

    // A refused person target opens no conversation.
    const afterChannels = await getPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM channels`);
    expect(afterChannels.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(await messageCount(otherGeneralId)).toBe(0);

    const snapshot = (same as Extract<Result, { ok: true }>).message.forward!;
    expect(snapshot.restricted).toBe(true);
    expect(snapshot.restrictedToServerId).toBe(serverId);
    expect(snapshot.excerpt).toBe("só pra quem apoia");
    expect(snapshot.authorDisplayName).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("segredo-do-clip");
  });

  it("a forward of a restricted forward stays in that server too; a free forward goes on", async () => {
    const vip = await publish({ visibility: "members", teaser: "teaser", body: "corpo" });
    const free = await publish({ title: "Livre" });
    const vipCard = (
      await forward(owner, postSource(vip), [{ channelId: generalId }])
    ).body.results[0] as Extract<Result, { ok: true }>;
    const freeCard = (
      await forward(owner, postSource(free), [{ channelId: generalId }])
    ).body.results[0] as Extract<Result, { ok: true }>;

    const again = await forward(
      member,
      { kind: "message", id: vipCard.message.id },
      [{ channelId: otherGeneralId }, { channelId: (await createChannel(serverId, "outro", "text")).id }],
    );
    expect(again.body.results[0]).toMatchObject({ ok: false, reason: "stays_in_server" });
    expect(again.body.results[1]!.ok).toBe(true);
    const chained = (again.body.results[1] as Extract<Result, { ok: true }>).message.forward!;
    // The original source, not the card message, and still restricted.
    expect(chained.sourceId).toBe(vip);
    expect(chained.restricted).toBe(true);

    const onward = await forward(
      member,
      { kind: "message", id: freeCard.message.id },
      [{ channelId: otherGeneralId }, { userId: friend.id }],
    );
    expect(onward.body.results.every((r) => r.ok)).toBe(true);
    expect(
      (onward.body.results[0] as Extract<Result, { ok: true }>).message.forward!.sourceId,
    ).toBe(free);
  });

  // ------------------------------------------------------------- a chat message

  it("forwards a chat message with a comment; the card names the channel and the author", async () => {
    const said = await say(generalId, owner, "a **atualização** saiu, vem ver https://pqp.gg");
    const res = await forward(
      member,
      { kind: "message", id: said },
      [{ channelId: otherGeneralId }],
      { comment: "gente, olhem" },
    );
    const ok = res.body.results[0] as Extract<Result, { ok: true }>;
    expect(ok.message.body).toBe("gente, olhem");
    expect(ok.message.forward).toMatchObject({
      kind: "message",
      sourceServerId: serverId,
      sourceServerName: "QG",
      sourceChannelName: expect.any(String),
      sourceId: said,
      authorDisplayName: "owner",
      excerpt: "a atualização saiu, vem ver https://pqp.gg",
    });
    expect(ok.message.forward!.url).toMatch(
      new RegExp(`^https?://[^/]+/app/server/${serverId}/channel/${generalId}/message/${said}$`),
    );
    expect(ok.message.forward!.title).toBeUndefined();
    expect(ok.message.forward!.restricted).toBeUndefined();
  });

  it("a message in a private channel stays in its server; one the caller cannot see is a 404", async () => {
    const secret = await say(privateId, owner, "plano da diretoria");
    const res = await forward(owner, { kind: "message", id: secret }, [
      { channelId: otherGeneralId },
      { userId: friend.id },
      { channelId: generalId },
    ]);
    expect(res.body.results[0]).toMatchObject({ ok: false, reason: "stays_in_server" });
    expect(res.body.results[1]).toMatchObject({ ok: false, reason: "stays_in_server" });
    expect(res.body.results[2]!.ok).toBe(true);
    expect(
      (res.body.results[2] as Extract<Result, { ok: true }>).message.forward!.restricted,
    ).toBe(true);
    // A member who is not in the private channel cannot even find the message.
    expect((await forward(member, { kind: "message", id: secret }, [{ channelId: generalId }])).status).toBe(404);
  });

  it("a DM message and a system message cannot be forwarded", async () => {
    const dm = await call<{ conversation: { channelId: string } }>(owner, "POST", "/api/dms", {
      userIds: [friend.id],
    });
    const dmMessage = await say(dm.body.conversation.channelId, owner, "só nós dois");
    const res = await forward(owner, { kind: "message", id: dmMessage }, [{ channelId: generalId }]);
    expect(res.status).toBe(422);
    expect(await messageCount(generalId)).toBe(0);

    const nudge = await say(generalId, owner, "x");
    await getPool().query(`UPDATE messages SET system_kind = 'nudge' WHERE id = $1`, [nudge]);
    expect((await forward(owner, { kind: "message", id: nudge }, [{ channelId: otherGeneralId }])).status).toBe(422);
  });

  // ----------------------------------------------------------- permissions

  it("each target answers for itself: no access, no SEND_MESSAGES, not a place a message goes", async () => {
    const postId = await publish();
    const noSend = await createChannel(serverId, "so-leitura", "text");
    const role = await createRole(serverId, { name: "Leitor", permissions: Permission.VIEW_CHANNEL });
    await assignRole(serverId, member.id, role.id);
    await upsertChannelOverwrite(noSend.id, serverId, "role", role.id, 0n, Permission.SEND_MESSAGES);
    const category = await createChannel(serverId, "Categoria", "category");

    const res = await forward(member, postSource(postId), [
      { channelId: privateId },
      { channelId: noSend.id },
      { channelId: category.id },
      { channelId: "99999999-9999-4999-8999-999999999999" },
      { channelId: generalId },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => (r.ok ? "ok" : r.reason))).toEqual([
      "no_access",
      "cannot_send",
      "bad_target",
      "no_access",
      "ok",
    ]);
    expect(await messageCount(privateId)).toBe(0);
    expect(await messageCount(noSend.id)).toBe(0);
    expect(await messageCount(generalId)).toBe(1);
  });

  it("slow mode applies as on a normal send: the second forward is refused with a retry time", async () => {
    const postId = await publish();
    await getPool().query(`UPDATE channels SET slowmode_seconds = 60 WHERE id = $1`, [generalId]);
    const first = await forward(member, postSource(postId), [{ channelId: generalId }]);
    expect(first.body.results[0]!.ok).toBe(true);
    const second = await forward(member, postSource(postId), [{ channelId: generalId }]);
    expect(second.body.results[0]).toMatchObject({ ok: false, reason: "slow_mode" });
    expect((second.body.results[0] as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    expect(await messageCount(generalId)).toBe(1);
  });

  it("a person who cannot be messaged is unreachable: self, and a block, with no tell", async () => {
    const postId = await publish();
    const self = await forward(owner, postSource(postId), [{ userId: owner.id }]);
    expect(self.body.results[0]).toMatchObject({ ok: false, reason: "unreachable" });
    await getPool().query(`INSERT INTO user_blocks (user_id, blocked_user_id) VALUES ($1, $2)`, [
      friend.id,
      member.id,
    ]);
    const blocked = await forward(member, postSource(postId), [{ userId: friend.id }]);
    expect(blocked.body.results[0]).toMatchObject({ ok: false, reason: "unreachable" });
  });

  // ------------------------------------------------------------ rate limits

  it("the request limiter answers 429 with Retry-After once its burst is spent", async () => {
    const postId = await publish();
    let last = 200;
    let headers: Headers | null = null;
    for (let i = 0; i < 12 && last !== 429; i += 1) {
      const res = await forward(owner, postSource(postId), [{ channelId: generalId }], {
        nonce: `n${i}`,
      });
      last = res.status;
      headers = res.headers;
    }
    expect(last).toBe(429);
    expect(Number(headers!.get("Retry-After"))).toBeGreaterThanOrEqual(1);
  });

  it("every target spends the chat's send budget: the sixth message of a burst is rate_limited", async () => {
    const postId = await publish();
    const channels: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      channels.push((await createChannel(serverId, `destino${i}`, "text")).id);
    }
    const targets = channels.map((channelId) => ({ channelId }));
    // The budget holds ten (`RATE_LIMIT_WS_MESSAGE_CAPACITY`): two forwards of five.
    const one = await forward(owner, postSource(postId), targets);
    const two = await forward(owner, postSource(postId), targets);
    expect(one.body.results.every((r) => r.ok)).toBe(true);
    expect(two.body.results.every((r) => r.ok)).toBe(true);
    const three = await forward(owner, postSource(postId), targets);
    const refused = three.body.results.filter((r) => !r.ok);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((r) => !r.ok && r.reason === "rate_limited")).toBe(true);
    expect((refused[0] as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------- mentions

  it("never pings: @everyone in the comment and names in the snapshot fire nothing", async () => {
    const postId = await publish({
      title: "Aviso para @member",
      body: "oi @member e @everyone e @here, leiam",
    });
    const before = await mentionRows();
    const res = await forward(owner, postSource(postId), [{ channelId: generalId }], {
      comment: "@everyone olha isso",
    });
    const ok = res.body.results[0] as Extract<Result, { ok: true }>;
    expect(ok.message.body).toBe("@everyone olha isso");
    expect(ok.message.mentionEveryone).toBe(false);
    expect(ok.message.mentionHere).toBe(false);
    expect(await mentionRows()).toBe(before);

    // No comment: the body is the fallback, which carries the title (a name in it).
    const silent = await forward(owner, postSource(postId), [{ channelId: generalId }]);
    const silentOk = silent.body.results[0] as Extract<Result, { ok: true }>;
    // The title's name is there to read, and inert to every client's scan.
    expect(silentOk.message.body).toContain("@\u200Bmember");
    expect(extractMentions(silentOk.message.body)).toEqual({
      usernames: [],
      everyone: false,
      here: false,
      roleNames: [],
    });
    expect(silentOk.message.mentionEveryone).toBe(false);
    expect(await mentionRows()).toBe(before);

    // The forwarder's own comment may still mention a person.
    const named = await forward(owner, postSource(postId), [{ channelId: generalId }], {
      comment: "@member, vê isso",
    });
    expect(named.body.results[0]!.ok).toBe(true);
    expect(await mentionRows()).toBe(before + 1);
  });

  it("a snapshot can never be turned on a mention by editing nothing: the stored column is the validated card", async () => {
    const postId = await publish();
    const res = await forward(owner, postSource(postId), [{ channelId: generalId }]);
    const ok = res.body.results[0] as Extract<Result, { ok: true }>;
    const row = await getPool().query<{ forward: unknown }>(
      `SELECT forward FROM messages WHERE id = $1`,
      [ok.message.id],
    );
    expect(messageForwardSchema.safeParse(row.rows[0]!.forward).success).toBe(true);
    // A row this build cannot parse goes out as an ordinary message.
    await getPool().query(`UPDATE messages SET forward = '{"v":2,"x":1}' WHERE id = $1`, [
      ok.message.id,
    ]);
    const history = await call<{ messages: Array<Record<string, unknown>> }>(
      owner,
      "GET",
      `/api/channels/${generalId}/messages`,
    );
    expect("forward" in history.body.messages[0]!).toBe(false);
    expect(messageSchema.parse(history.body.messages[0]).forward ?? null).toBeNull();
  });

  it("a private channel stamps the restriction on a card it carries on, so a later copy cannot leave", async () => {
    const free = await publish({ title: "Livre" });
    // A free card, posted into the private channel by someone who can see it.
    const inPrivate = (
      await forward(owner, postSource(free), [{ channelId: privateId }])
    ).body.results[0] as Extract<Result, { ok: true }>;
    expect(inPrivate.message.forward!.restricted).toBeUndefined();
    // Carried from the private channel into a public one of the same server.
    const carried = (
      await forward(owner, { kind: "message", id: inPrivate.message.id }, [
        { channelId: otherGeneralId },
        { channelId: generalId },
      ])
    ).body.results;
    expect(carried[0]).toMatchObject({ ok: false, reason: "stays_in_server" });
    const stamped = carried[1] as Extract<Result, { ok: true }>;
    expect(stamped.message.forward!.restricted).toBe(true);
    // And that copy, now in a public channel, still cannot leave the server.
    const again = await forward(owner, { kind: "message", id: stamped.message.id }, [
      { channelId: otherGeneralId },
      { userId: friend.id },
    ]);
    expect(again.body.results.map((r) => (r.ok ? "ok" : r.reason))).toEqual([
      "stays_in_server",
      "stays_in_server",
    ]);
  });

  it("a free card forwarded into ANOTHER server's private channel is restricted to that server, on the card and in the rule", async () => {
    const free = await publish({ title: "Livre" });
    const otherPrivate = await createChannel(otherServerId, "diretoria-outra", "text", true);
    await addChannelMember(otherPrivate.id, owner.id);
    const otherPublic = (await createChannel(otherServerId, "publico-outra", "text")).id;
    // Server A's free post, dropped into server B's private channel.
    const inB = (
      await forward(owner, postSource(free), [{ channelId: otherPrivate.id }])
    ).body.results[0] as Extract<Result, { ok: true }>;
    expect(inB.message.forward!.sourceServerId).toBe(serverId);
    expect(inB.message.forward!.restricted).toBeUndefined();
    // Carried on from B's private channel: restricted to B, not to its source A.
    const carried = (
      await forward(owner, { kind: "message", id: inB.message.id }, [
        { channelId: generalId },
        { userId: friend.id },
        { channelId: otherPublic },
      ])
    ).body.results;
    expect(carried.map((r) => (r.ok ? "ok" : r.reason))).toEqual([
      "stays_in_server",
      "stays_in_server",
      "ok",
    ]);
    const stamped = (carried[2] as Extract<Result, { ok: true }>).message.forward!;
    expect(stamped.sourceServerId).toBe(serverId);
    expect(stamped.restricted).toBe(true);
    expect(stamped.restrictedToServerId).toBe(otherServerId);
    // The stamped copy, now in a PUBLIC channel of B, still cannot go to A or a DM, and still goes inside B.
    const copy = (carried[2] as Extract<Result, { ok: true }>).message.id;
    const again = await forward(owner, { kind: "message", id: copy }, [
      { channelId: generalId },
      { userId: friend.id },
      { channelId: otherGeneralId },
    ]);
    expect(again.body.results.map((r) => (r.ok ? "ok" : r.reason))).toEqual([
      "stays_in_server",
      "stays_in_server",
      "ok",
    ]);
    expect(await messageCount(generalId)).toBe(0);
  });

  it("mention markup in the source becomes plain words in the card and the fallback body, and fires nothing", async () => {
    const role = await createRole(serverId, { name: "CargoVIP", permissions: Permission.VIEW_CHANNEL });
    const said = await say(
      generalId,
      owner,
      `oi <@${member.id}> e <@&${role.id}> em <#${generalId}> e <#${privateId}> e @member e @everyone`,
    );
    const before = await mentionRows();
    const res = await forward(owner, { kind: "message", id: said }, [{ channelId: otherGeneralId }]);
    const ok = res.body.results[0] as Extract<Result, { ok: true }>;
    const excerpt = ok.message.forward!.excerpt as string;
    expect(excerpt).toBe(
      "oi @\u200Bmember e @\u200BCargoVIP em #general e #unknown e @\u200Bmember e @\u200Beveryone",
    );
    // No markup left, anywhere the card or an old client would read it.
    expect(excerpt).not.toContain("<");
    expect(ok.message.body).not.toContain("<@");
    expect(ok.message.body).not.toContain("<#");
    // No client's mention scan finds anyone in the body of a forward with no comment.
    expect(extractMentions(ok.message.body)).toEqual({
      usernames: [],
      everyone: false,
      here: false,
      roleNames: [],
    });
    expect(ok.message.mentionEveryone).toBe(false);
    expect(ok.message.mentionHere).toBe(false);
    // And the server recorded no mention row for it.
    expect(await mentionRows()).toBe(before);
    // The private channel's name never travels in markup to another server.
    expect(JSON.stringify(res.body)).not.toContain("diretoria");
  });

  it("a hostile display name cannot bring mention markup back after it is resolved", async () => {
    const villain = await makeUser("villain");
    const id = "99999999-9999-4999-8999-999999999998";
    await getPool().query(`UPDATE users SET display_name = $2 WHERE id = $1`, [
      villain.id,
      `<@&${id}> <@!${id}> <#${id}> @everyone @here @member`,
    ]);
    const said = await say(generalId, owner, `oi <@${villain.id}>`);
    const before = await mentionRows();
    const res = await forward(owner, { kind: "message", id: said }, [{ channelId: otherGeneralId }]);
    const ok = res.body.results[0] as Extract<Result, { ok: true }>;
    const excerpt = ok.message.forward!.excerpt as string;
    for (const text of [excerpt, ok.message.body]) {
      expect(text).not.toMatch(/<[@#]/);
      expect(extractMentions(text)).toEqual({
        usernames: [],
        everyone: false,
        here: false,
        roleNames: [],
      });
    }
    expect(ok.message.mentionEveryone).toBe(false);
    expect(ok.message.mentionHere).toBe(false);
    expect(await mentionRows()).toBe(before);
  });

  it("the card url comes from PUBLIC_APP_URL, never from the request Origin header", async () => {
    const postId = await publish();
    const previous = process.env.PUBLIC_APP_URL;
    process.env.PUBLIC_APP_URL = "https://app.example.test/, https://other.example.test";
    try {
      actor = owner;
      const response = await fetch(`${baseUrl}/api/forwards`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({
          source: postSource(postId),
          targets: [{ channelId: generalId }],
        }),
      });
      const body = (await response.json()) as { results: Result[] };
      const ok = body.results[0] as Extract<Result, { ok: true }>;
      expect(ok.message.forward!.url).toBe(
        `https://app.example.test/app/server/${serverId}/bau/${postId}`,
      );
      expect(JSON.stringify(body)).not.toContain("evil.example");
    } finally {
      if (previous === undefined) {
        delete process.env.PUBLIC_APP_URL;
      } else {
        process.env.PUBLIC_APP_URL = previous;
      }
    }
  });

  it("a forward of a forward made before this fix is made inert too", async () => {
    const said = await say(generalId, owner, "plain");
    const first = (
      await forward(owner, { kind: "message", id: said }, [{ channelId: generalId }])
    ).body.results[0] as Extract<Result, { ok: true }>;
    // An old card whose snapshot still carries a raw name and markup.
    await getPool().query(
      `UPDATE messages SET forward = jsonb_set(forward, '{excerpt}', to_jsonb($2::text)) WHERE id = $1`,
      [first.message.id, `ping @member <@${member.id}>`],
    );
    const again = (
      await forward(owner, { kind: "message", id: first.message.id }, [{ channelId: otherGeneralId }])
    ).body.results[0] as Extract<Result, { ok: true }>;
    expect(again.message.forward!.excerpt).toBe("ping @\u200Bmember @\u200Bmember");
    expect(extractMentions(again.message.body).usernames).toEqual([]);
  });

  it("a retry of a request whose answer was lost gets the sent messages back, not rate_limited", async () => {
    const postId = await publish();
    const channels: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      channels.push((await createChannel(serverId, `retry${i}`, "text")).id);
    }
    const targets = channels.map((channelId) => ({ channelId }));
    const first = await forward(owner, postSource(postId), targets, { nonce: "A" });
    await forward(owner, postSource(postId), targets, { nonce: "B" });
    // The send budget (ten) is spent. Retrying A finds what A already sent.
    const retry = await forward(owner, postSource(postId), targets, { nonce: "A" });
    expect(retry.body.results.every((r) => r.ok)).toBe(true);
    expect(
      retry.body.results.map((r) => (r as Extract<Result, { ok: true }>).message.id),
    ).toEqual(first.body.results.map((r) => (r as Extract<Result, { ok: true }>).message.id));
    // A genuinely new request is still refused.
    const fresh = await forward(owner, postSource(postId), targets, { nonce: "C" });
    expect(fresh.body.results.every((r) => !r.ok && r.reason === "rate_limited")).toBe(true);
    expect(await messageCount(channels[0]!)).toBe(2);
  });

  it("partial success then a retry with the same nonce: the sent ones come back unchanged, the failed one goes out, nothing doubles", async () => {
    const postId = await publish();
    const a = (await createChannel(serverId, "parcial-a", "text")).id;
    const b = (await createChannel(serverId, "parcial-b", "text")).id;
    const c = (await createChannel(serverId, "parcial-c", "text")).id;
    const targets = [a, b, c].map((channelId) => ({ channelId }));
    // Make exactly the middle target fail before anything is stored there.
    const real = chatModule.postChannelMessage;
    const spy = vi.spyOn(chatModule, "postChannelMessage").mockImplementation(async (input) => {
      if (input.channelId === b) {
        throw new Error("database went away");
      }
      return real(input);
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    let first;
    try {
      first = await forward(owner, postSource(postId), targets, { nonce: "partial" });
    } finally {
      spy.mockRestore();
      quiet.mockRestore();
    }
    expect(first.status).toBe(200);
    expect(first.body.results.map((r) => (r.ok ? "ok" : r.reason))).toEqual([
      "ok",
      "unavailable",
      "ok",
    ]);
    const retry = await forward(owner, postSource(postId), targets, { nonce: "partial" });
    expect(retry.body.results.every((r) => r.ok)).toBe(true);
    const ids = (res: typeof first) =>
      res.body.results.map((r) => (r.ok ? r.message.id : null));
    expect(ids(retry)[0]).toBe(ids(first)[0]);
    expect(ids(retry)[2]).toBe(ids(first)[2]);
    for (const channelId of [a, b, c]) {
      expect(await messageCount(channelId)).toBe(1);
    }
  });

  it("a target that throws is that target's answer; the others still go out and report", async () => {
    const postId = await publish();
    const spy = vi
      .spyOn(chatModule, "postChannelMessage")
      .mockRejectedValueOnce(new Error("database went away"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const other = (await createChannel(serverId, "outro", "text")).id;
      const res = await forward(owner, postSource(postId), [
        { channelId: generalId },
        { channelId: other },
      ]);
      expect(res.status).toBe(200);
      const kinds = res.body.results.map((r) => (r.ok ? "ok" : r.reason)).sort();
      expect(kinds).toEqual(["ok", "unavailable"]);
    } finally {
      spy.mockRestore();
      quiet.mockRestore();
    }
  });

  it("a comment with a control character is a 400", async () => {
    const postId = await publish();
    const res = await forward(owner, postSource(postId), [{ channelId: generalId }], {
      comment: "oi\u0000 tchau",
    });
    expect(res.status).toBe(400);
  });
});

describe("defangMentionText", () => {
  it("resolves markup, falls back to a neutral word, and leaves nothing a mention scan matches", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const names = new Map([[`@${id}`, "Ana"]]);
    expect(defangMentionText(`<@${id}> <@!${id}> <@&${id}> <#${id}>`, names)).toBe(
      "@\u200BAna @\u200BAna @\u200Bunknown #unknown",
    );
    const out = defangMentionText("@bob @everyone @here e-mail a@b.co", new Map());
    expect(extractMentions(out)).toEqual({ usernames: [], everyone: false, here: false, roleNames: [] });
    // A resolved name that itself holds markup does not bring it back.
    const sneaky = new Map([[`@${id}`, `<@${id}> @everyone`]]);
    const sneakyOut = defangMentionText(`<@${id}>`, sneaky);
    expect(sneakyOut).not.toContain("<");
    expect(extractMentions(sneakyOut)).toEqual({ usernames: [], everyone: false, here: false, roleNames: [] });
    // Idempotent: an already inert text does not grow.
    expect(defangMentionText(out, new Map())).toBe(out);
  });
});

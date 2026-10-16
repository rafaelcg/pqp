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
 * SEGUIR, on a real Postgres, through the HTTP door and the delivery tick.
 *
 *   * THE FLAG IS READ FOR THE SOURCE. Turned on by a per-server override row
 *     after `startFeatureFlags()` (what the dashboard writes), never by the
 *     environment alone (CLAUDE.md pitfalls 9 and 12). Off, nothing is offered
 *     and nothing is delivered even for a follow that already exists.
 *   * A FOLLOW NEEDS AUTHORITY in the destination channel (MANAGE_WEBHOOKS or
 *     MANAGE_CHANNELS) and the delivery asks again; three failures pause it.
 *   * A DELIVERY IS A FORWARD CARD authored as the source, never a person, once
 *     per (post, follow), only for FREE posts published AFTER the follow.
 *   * EDITS UPDATE THE CARDS, DELETES (and un-publishing, and locking for
 *     members) REMOVE THEM.
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
const { startFeatureFlags, setGlobalFlag, setServerFlagOverride, resetFeatureFlagsForTests } =
  await import("../lib/flags.js");
const { upsertUser } = await import("./users.js");
const { createServer: createChatServer, createChannel } = await import("./servers.js");
const { createRole, assignRole, unassignRole, upsertChannelOverwrite } = await import("./roles.js");
const { handleChatMessage } = await import("../ws/chat.js");
const {
  computeMemberPermissions,
  computeMemberPermissionsForChannels,
  loadMemberPermissionContext,
  memberServerPermissions,
} = await import("./permissions.js");
const { createMessage } = await import("./messages.js");
const { createBauFollow, removeBauFollower, updateBauFollow } = await import("./bau-follow.js");
const { publishDueCommunityHomePosts } = await import("./community-home.js");
const {
  runBauFollowTick,
  resetBauFollowAuthorCacheForTests,
  BAU_FOLLOW_MAX_ATTEMPTS,
} = await import("./bau-follow-delivery.js");
const {
  Permission,
  messageForwardSchema,
  isForwardFallbackBody,
  forwardBodyComment,
  BAU_FOLLOW_MAX_PER_SERVER,
  BAU_FOLLOW_MAX_DELIVERIES_PER_POST_PER_MINUTE,
} = await import("@pqp/shared");

type TestUser = { id: string; clerk_id: string };
type Frame = { type: string; message?: Record<string, unknown>; messageId?: string };

let httpServer: Server;
let baseUrl: string;

async function call<T = Record<string, any>>(
  as: TestUser,
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

function recordingSocket() {
  const received: Frame[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => received.push(JSON.parse(payload) as Frame),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, received };
}

describeDb("Seguir: following a Baú into a channel", () => {
  let qgOwner: TestUser;
  let alice: TestUser; // owns the destination server, member of the QG
  let bob: TestUser; // member of the destination server only
  let carol: TestUser; // member of the QG, nothing else
  let qgId: string;
  let destId: string;
  let destChannelId: string;
  let destOwnerOnlyChannel: string;

  const makeUser = (name: string) =>
    upsertUser({ clerkId: `clerk_bf_${name}`, displayName: name, avatarUrl: null });

  async function sourceFlag(serverId: string, on: boolean | null) {
    await setServerFlagOverride("bau_follow", serverId, on, { kind: "dashboard" });
  }

  async function addMember(serverId: string, user: TestUser) {
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING`,
      [serverId, user.id],
    );
  }

  async function textChannel(serverId: string): Promise<string> {
    const rows = await getPool().query<{ id: string }>(
      `SELECT id FROM channels WHERE server_id = $1 AND type = 'text' ORDER BY position LIMIT 1`,
      [serverId],
    );
    return rows.rows[0]!.id;
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
    resetBauFollowAuthorCacheForTests();
    process.env.COMMUNITY_HOME_ENABLED = "true";
    process.env.COMMUNITY_HOME_VIP_ENABLED = "true";
    await setGlobalFlag("bau_follow", null, { kind: "dashboard" });

    qgOwner = await makeUser("qgowner");
    alice = await makeUser("alice");
    bob = await makeUser("bob");
    carol = await makeUser("carol");

    const qg = await createChatServer("QG", qgOwner.id);
    qgId = qg.server.id;
    // The QG: a public community (address) with its Baú on and "Permitir seguir" on.
    await getPool().query(
      `UPDATE servers SET community_home_enabled = TRUE, bau_follow_allowed = TRUE,
              is_community = TRUE, community_slug = 'qg-oficial'
        WHERE id = $1`,
      [qgId],
    );
    await addMember(qgId, alice);
    await addMember(qgId, carol);
    await sourceFlag(qgId, true);

    const dest = await createChatServer("Galera", alice.id);
    destId = dest.server.id;
    await addMember(destId, bob);
    destChannelId = await textChannel(destId);
    const second = await createChannel(destId, "avisos", "text", false);
    destOwnerOnlyChannel = second.id;
  });

  afterEach(async () => {
    // Whatever a publish route kicked is finished before the next test truncates.
    await runBauFollowTick();
    delete process.env.COMMUNITY_HOME_ENABLED;
    delete process.env.COMMUNITY_HOME_VIP_ENABLED;
  });

  const home = () => `/api/servers/${qgId}/home`;

  async function publish(extra: Record<string, unknown> = {}): Promise<string> {
    const res = await call<{ post: { id: string } }>(qgOwner, "POST", `${home()}/posts`, {
      status: "published",
      title: "Sessão 11",
      body: "o clip inteiro, com tudo que rolou",
      ...extra,
    });
    expect(res.status).toBe(201);
    return res.body.post.id;
  }

  async function follow(
    as: TestUser,
    channelId: string,
    rolePingId?: string | null,
  ): Promise<{ status: number; body: Record<string, any> }> {
    return call(as, "POST", `${home()}/follow`, { channelId, rolePingId: rolePingId ?? null });
  }

  async function cards(channelId: string) {
    const rows = await getPool().query<{
      id: string;
      body: string;
      forward: unknown;
      webhook_username: string | null;
      is_webhook: boolean;
      edited_at: Date | null;
    }>(
      `SELECT m.id, m.body, m.forward, m.webhook_username, u.is_webhook, m.edited_at
         FROM messages m JOIN users u ON u.id = m.author_id
        WHERE m.channel_id = $1 AND m.forward IS NOT NULL
        ORDER BY m.created_at`,
      [channelId],
    );
    return rows.rows;
  }

  async function messageCount(channelId: string): Promise<number> {
    const r = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages WHERE channel_id = $1`,
      [channelId],
    );
    return r.rows[0]!.n;
  }

  /** A tick, then whatever the post kick left in flight has settled. */
  async function tick() {
    return runBauFollowTick();
  }

  // ------------------------------------------------------------------- flag

  it("flag off for the source: nothing is offered, creating is a 404, and an existing follow delivers nothing", async () => {
    await sourceFlag(qgId, null);
    const state = await call(alice, "GET", `${home()}/follow`);
    expect(state.status).toBe(200);
    expect(state.body.enabled).toBe(false);
    expect((await call(alice, "GET", `${home()}/follow/destinations`)).status).toBe(404);
    expect((await follow(alice, destChannelId)).status).toBe(404);

    // A follow made while it was on, then the switch moves.
    await sourceFlag(qgId, true);
    expect((await follow(alice, destChannelId)).status).toBe(201);
    await sourceFlag(qgId, false);
    await publish();
    await tick();
    expect(await cards(destChannelId)).toHaveLength(0);
    // Waiting, not lost: flipped back on within the window, it goes out.
    await sourceFlag(qgId, true);
    await getPool().query(`UPDATE bau_follow_deliveries SET next_attempt_at = NOW()`);
    await tick();
    await tick();
    expect(await cards(destChannelId)).toHaveLength(1);
  });

  it("the flag is per SOURCE: on for the QG says nothing about another server", async () => {
    const other = await createChatServer("Outra comunidade", qgOwner.id);
    await getPool().query(
      `UPDATE servers SET community_home_enabled = TRUE, bau_follow_allowed = TRUE,
              is_community = TRUE, community_slug = 'outra-comunidade'
        WHERE id = $1`,
      [other.server.id],
    );
    await addMember(other.server.id, alice);
    const stateOther = await call(alice, "GET", `/api/servers/${other.server.id}/home/follow`);
    expect(stateOther.body.enabled).toBe(false);
    const stateQg = await call(alice, "GET", `${home()}/follow`);
    expect(stateQg.body.enabled).toBe(true);
    // Global on with an override off for the QG: the QG stays closed.
    await setGlobalFlag("bau_follow", true, { kind: "dashboard" });
    await sourceFlag(qgId, false);
    expect((await call(alice, "GET", `${home()}/follow`)).body.enabled).toBe(false);
    expect(
      (await call(alice, "GET", `/api/servers/${other.server.id}/home/follow`)).body.enabled,
    ).toBe(true);
  });

  // ------------------------------------------------------------ permissions

  it("setting a follow up needs MANAGE_WEBHOOKS or MANAGE_CHANNELS in the destination channel", async () => {
    // Bob is a plain member of the destination.
    await addMember(qgId, bob);
    const denied = await follow(bob, destChannelId);
    expect(denied.status).toBe(403);
    // A role with MANAGE_WEBHOOKS (and sight of the channel) is enough.
    const role = await createRole(destId, {
      name: "Integracoes",
      permissions: Permission.VIEW_CHANNEL | Permission.MANAGE_WEBHOOKS,
    });
    await assignRole(destId, bob.id, role.id);
    expect((await follow(bob, destChannelId)).status).toBe(201);
    // So is MANAGE_CHANNELS, on the other channel.
    const manager = await createRole(destId, {
      name: "Canais",
      permissions: Permission.VIEW_CHANNEL | Permission.MANAGE_CHANNELS,
    });
    await unassignRole(destId, bob.id, role.id);
    await assignRole(destId, bob.id, manager.id);
    expect((await follow(bob, destOwnerOnlyChannel)).status).toBe(201);
  });

  it("the destination picker follows the same per-channel test as creating a follow", async () => {
    type Destinations = { servers: Array<{ serverId: string; channels: Array<{ id: string }> }> };
    const destinationsFor = async (as: TestUser) =>
      (await call<Destinations>(as, "GET", `${home()}/follow/destinations`)).body.servers.find(
        (server) => server.serverId === destId,
      );
    await addMember(qgId, bob);
    await addMember(qgId, carol);
    await addMember(destId, carol);

    // Bob holds nothing: the server is not offered, and creating a follow is refused.
    expect(await destinationsFor(bob)).toBeUndefined();
    expect((await follow(bob, destOwnerOnlyChannel)).status).toBe(403);

    // MANAGE_WEBHOOKS granted by an overwrite on ONE channel, to a role Bob holds
    // that has no management bit of its own: that channel, and only it, is offered.
    const plain = await createRole(destId, { name: "Plain", permissions: Permission.VIEW_CHANNEL });
    await assignRole(destId, bob.id, plain.id);
    await upsertChannelOverwrite(destOwnerOnlyChannel, destId, "role", plain.id, Permission.MANAGE_WEBHOOKS, 0n);
    const offered = await destinationsFor(bob);
    expect(offered?.channels.map((channel) => channel.id)).toEqual([destOwnerOnlyChannel]);
    // ...and the follow the picker offered is accepted, the one it did not is not.
    expect((await follow(bob, destChannelId)).status).toBe(403);
    expect((await follow(bob, destOwnerOnlyChannel)).status).toBe(201);

    // The other direction: the bit server-wide, taken away on one channel by an
    // overwrite. The picker no longer offers that channel, and creating one there
    // is refused too (the delivery check would pause it).
    const manager = await createRole(destId, {
      name: "Integracoes",
      permissions: Permission.VIEW_CHANNEL | Permission.MANAGE_WEBHOOKS,
    });
    await assignRole(destId, carol.id, manager.id);
    expect((await destinationsFor(carol))?.channels.map((channel) => channel.id).sort()).toEqual(
      [destChannelId, destOwnerOnlyChannel].sort(),
    );
    await upsertChannelOverwrite(destChannelId, destId, "role", manager.id, 0n, Permission.MANAGE_WEBHOOKS);
    expect((await destinationsFor(carol))?.channels.map((channel) => channel.id)).toEqual([
      destOwnerOnlyChannel,
    ]);
    // The batched read is the one-channel read, channel for channel, for everyone.
    for (const who of [alice, bob, carol]) {
      const batched = await computeMemberPermissionsForChannels(
        destId,
        who.id,
        [destChannelId, destOwnerOnlyChannel].map((id) => ({ id, type: "text", parent_id: null })),
      );
      for (const channel of [destChannelId, destOwnerOnlyChannel]) {
        expect(batched.get(channel)).toBe(await computeMemberPermissions(destId, who.id, channel));
      }
      // The server-wide bits from the same context are the no-channel answer.
      expect(memberServerPermissions((await loadMemberPermissionContext(destId, who.id))!)).toBe(
        await computeMemberPermissions(destId, who.id),
      );
    }
    expect((await follow(carol, destChannelId)).status).toBe(403);
    await getPool().query(`DELETE FROM bau_follows WHERE target_channel_id = $1`, [destOwnerOnlyChannel]);
    expect((await follow(carol, destOwnerOnlyChannel)).status).toBe(201);
  });

  it("refuses a non-member of the source, the source's own channels, voice channels, and a duplicate", async () => {
    const stranger = await makeUser("stranger");
    expect((await follow(stranger, destChannelId)).status).toBeGreaterThanOrEqual(403);
    expect((await follow(qgOwner, await textChannel(qgId))).status).toBe(400);
    const voice = await getPool().query<{ id: string }>(
      `SELECT id FROM channels WHERE server_id = $1 AND type = 'voice' LIMIT 1`,
      [destId],
    );
    expect((await follow(alice, voice.rows[0]!.id)).status).toBe(404);
    expect((await follow(alice, destChannelId)).status).toBe(201);
    expect((await follow(alice, destChannelId)).status).toBe(409);
  });

  it("a role to ping must belong to the destination and be pingable", async () => {
    const hidden = await createRole(destId, {
      name: "Quieto",
      permissions: Permission.VIEW_CHANNEL,
      mentionable: false,
    });
    // The destination's owner may mention anyone, so even a plain role is fine for them...
    // ...but a role of ANOTHER server never is.
    const foreign = await createRole(qgId, { name: "Staff", permissions: Permission.VIEW_CHANNEL, mentionable: true });
    expect((await follow(alice, destChannelId, foreign.id)).status).toBe(400);
    expect((await follow(alice, destChannelId, hidden.id)).status).toBe(201);
    // A non-owner manager without MENTION_EVERYONE may only pick mentionable roles.
    await addMember(qgId, bob);
    const manager = await createRole(destId, {
      name: "Gerente",
      permissions: Permission.VIEW_CHANNEL | Permission.MANAGE_WEBHOOKS,
    });
    await assignRole(destId, bob.id, manager.id);
    expect((await follow(bob, destOwnerOnlyChannel, hidden.id)).status).toBe(400);
  });

  it("a destination server holds at most 20 follows", async () => {
    expect(BAU_FOLLOW_MAX_PER_SERVER).toBe(20);
    for (let i = 0; i < BAU_FOLLOW_MAX_PER_SERVER; i += 1) {
      const channel = await createChannel(destId, `c${i}`, "text", false);
      // The admin-action limiter is for a person, not for this loop.
      resetApiRateLimits();
      expect((await follow(alice, channel.id)).status).toBe(201);
    }
    resetApiRateLimits();
    const one = await createChannel(destId, "c-extra", "text", false);
    const over = await follow(alice, one.id);
    expect(over.status).toBe(409);
    expect(
      (await getPool().query(`SELECT 1 FROM bau_follows WHERE target_server_id = $1`, [destId])).rowCount,
    ).toBe(BAU_FOLLOW_MAX_PER_SERVER);
  });

  it("lists the viewer's destinations: only servers they may manage, never the source itself", async () => {
    const res = await call<{ servers: Array<{ serverId: string; channels: Array<{ id: string; following: boolean }> }> }>(
      alice,
      "GET",
      `${home()}/follow/destinations`,
    );
    expect(res.status).toBe(200);
    expect(res.body.servers.map((s) => s.serverId)).toEqual([destId]);
    await follow(alice, destChannelId);
    const after = await call<typeof res.body>(alice, "GET", `${home()}/follow/destinations`);
    const channels = after.body.servers[0]!.channels;
    expect(channels.find((c) => c.id === destChannelId)?.following).toBe(true);
    // Carol manages nothing anywhere.
    expect((await call<typeof res.body>(carol, "GET", `${home()}/follow/destinations`)).body.servers).toEqual([]);
  });

  // --------------------------------------------------------------- delivery

  it("delivers a free post as a forward card authored as the source, once, and never the backlog", async () => {
    const old = await publish({ title: "Antes de seguir" });
    expect((await follow(alice, destChannelId)).status).toBe(201);
    const postId = await publish();
    const viewer = recordingSocket();
    await handleChatMessage(
      { socket: viewer.socket, user: bob as never },
      { type: "join-channel", channelId: destChannelId },
    );

    await tick();
    // A second and third tick change nothing: the row is the dedupe.
    await tick();
    await tick();
    const rows = await cards(destChannelId);
    expect(rows).toHaveLength(1);
    const card = rows[0]!;
    expect(card.is_webhook).toBe(true);
    expect(card.webhook_username).toBe("QG");
    const forward = messageForwardSchema.parse(card.forward);
    expect(forward).toMatchObject({ v: 1, kind: "bau_post", sourceId: postId, sourceServerId: qgId, title: "Sessão 11" });
    expect(forward.restricted).toBeUndefined();
    expect(isForwardFallbackBody(card.body, forward)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(old);

    // Live: a socket in the channel got the message with `forward`.
    const broadcast = viewer.received.find((f) => f.type === "message-broadcast");
    expect(broadcast?.message?.forward).toMatchObject({ sourceId: postId });
    expect(broadcast?.message?.isWebhook).toBe(true);
    // And history reads it back through the real route.
    const history = await call<{ messages: Array<Record<string, any>> }>(
      bob,
      "GET",
      `/api/channels/${destChannelId}/messages`,
    );
    expect(history.body.messages.find((m) => m.forward)?.forward.sourceId).toBe(postId);
    // Nobody real authored it.
    const author = await getPool().query<{ author_id: string }>(
      `SELECT author_id FROM messages WHERE id = $1`,
      [card.id],
    );
    expect([alice.id, bob.id, qgOwner.id]).not.toContain(author.rows[0]!.author_id);
  });

  it("a members-only post never goes out, and neither does a draft", async () => {
    await follow(alice, destChannelId);
    await publish({ visibility: "members", title: "So pra VIP", teaser: "x" });
    await publish({ status: "draft", title: "Rascunho" });
    await tick();
    expect(await cards(destChannelId)).toHaveLength(0);
    const rows = await getPool().query(`SELECT 1 FROM bau_follow_deliveries`);
    expect(rows.rowCount).toBe(0);
  });

  it("a scheduled post is delivered when its time arrives", async () => {
    await follow(alice, destChannelId);
    const created = await call<{ post: { id: string } }>(qgOwner, "POST", `${home()}/posts`, {
      status: "scheduled",
      title: "Agendado",
      body: "vem ai",
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      scheduleTimezone: "America/Sao_Paulo",
    });
    expect(created.status).toBe(201);
    await tick();
    expect(await cards(destChannelId)).toHaveLength(0);
    await getPool().query(`UPDATE community_home_posts SET scheduled_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [
      created.body.post.id,
    ]);
    // The sweep that flips it (the API's 30 s tick), then the delivery tick.
    expect(await publishDueCommunityHomePosts()).toEqual([qgId]);
    await tick();
    const rows = await cards(destChannelId);
    expect(rows).toHaveLength(1);
    expect(messageForwardSchema.parse(rows[0]!.forward).title).toBe("Agendado");
  });

  it("a role ping mentions the role's members once, and only when the follow set one", async () => {
    const role = await createRole(destId, { name: "novidades", permissions: Permission.VIEW_CHANNEL, mentionable: true });
    await assignRole(destId, bob.id, role.id);
    await follow(alice, destChannelId, role.id);
    await follow(alice, destOwnerOnlyChannel);
    await publish();
    await tick();
    const pinged = await getPool().query<{ user_id: string; channel_id: string }>(
      `SELECT mm.user_id, m.channel_id FROM message_mentions mm JOIN messages m ON m.id = mm.message_id`,
    );
    expect(pinged.rows).toEqual([{ user_id: bob.id, channel_id: destChannelId }]);
    const withPing = (await cards(destChannelId))[0]!;
    // The mention alone on the first line, the fallback on its own line below.
    expect(withPing.body.startsWith("@novidades\nEncaminhado: ")).toBe(true);
    const parsed = messageForwardSchema.parse(withPing.forward);
    expect(forwardBodyComment(withPing.body, parsed)).toBe("@novidades");
    expect(isForwardFallbackBody(withPing.body, parsed)).toBe(true);
    const plain = (await cards(destOwnerOnlyChannel))[0]!;
    expect(plain.body.startsWith("Encaminhado: ")).toBe(true);
    // The snapshot never carries an @everyone through.
    const everyone = await publish({ title: "@everyone olha", body: "@here tambem" });
    await tick();
    // The role's one member was pinged by each delivery that carried the ping,
    // and nobody else was pinged by an @everyone or @here sitting in the post.
    const mentions = await getPool().query<{ user_id: string }>(
      `SELECT user_id FROM message_mentions`,
    );
    expect(mentions.rows.map((r) => r.user_id)).toEqual([bob.id, bob.id]);
    expect(everyone).toBeTruthy();
    const flags = await getPool().query<{ mention_everyone: boolean; mention_here: boolean }>(
      `SELECT mention_everyone, mention_here FROM messages WHERE forward IS NOT NULL`,
    );
    expect(flags.rows.every((r) => !r.mention_everyone && !r.mention_here)).toBe(true);
  });

  // ----------------------------------------------- edits, deletes, retraction

  it("an edit updates the delivered card (and tells the channel), an unchanged post does not", async () => {
    await follow(alice, destChannelId);
    const postId = await publish();
    await tick();
    const viewer = recordingSocket();
    await handleChatMessage(
      { socket: viewer.socket, user: bob as never },
      { type: "join-channel", channelId: destChannelId },
    );
    // A pin bumps updated_at but changes nothing the card shows.
    await call(qgOwner, "POST", `${home()}/posts/${postId}/pin`, {});
    await tick();
    expect((await cards(destChannelId))[0]!.edited_at).toBeNull();

    const patched = await call(qgOwner, "PATCH", `${home()}/posts/${postId}`, { title: "Sessão 11, corrigida" });
    expect(patched.status).toBe(200);
    await tick();
    const row = (await cards(destChannelId))[0]!;
    expect(messageForwardSchema.parse(row.forward).title).toBe("Sessão 11, corrigida");
    expect(row.body).toContain("Sessão 11, corrigida");
    expect(row.edited_at).not.toBeNull();
    expect(await messageCount(destChannelId)).toBe(1);
    const update = viewer.received.find((f) => f.type === "message-update");
    expect((update?.message?.forward as { title?: string })?.title).toBe("Sessão 11, corrigida");
  });

  it("deleting the post deletes its cards; so does un-publishing, and locking it for members", async () => {
    await follow(alice, destChannelId);
    const viewer = recordingSocket();
    await handleChatMessage(
      { socket: viewer.socket, user: bob as never },
      { type: "join-channel", channelId: destChannelId },
    );
    const a = await publish({ title: "A" });
    const b = await publish({ title: "B" });
    const c = await publish({ title: "C" });
    await tick();
    expect(await cards(destChannelId)).toHaveLength(3);

    await call(qgOwner, "DELETE", `${home()}/posts/${a}`);
    await call(qgOwner, "POST", `${home()}/posts/${b}/unpublish`, {});
    await call(qgOwner, "PATCH", `${home()}/posts/${c}`, { visibility: "members" });
    await tick();
    expect(await cards(destChannelId)).toHaveLength(0);
    expect(viewer.received.filter((f) => f.type === "message-delete")).toHaveLength(3);

    // Republished and made free again: the card comes back (its message was gone, so not a duplicate).
    await call(qgOwner, "POST", `${home()}/posts/${b}/publish`, {});
    await call(qgOwner, "PATCH", `${home()}/posts/${c}`, { visibility: "free" });
    await tick();
    await tick();
    const titles = (await cards(destChannelId)).map((r) => messageForwardSchema.parse(r.forward).title).sort();
    expect(titles).toEqual(["B", "C"]);
  });

  it("a card a destination moderator deleted by hand is not posted again", async () => {
    await follow(alice, destChannelId);
    await publish();
    await tick();
    const [card] = await cards(destChannelId);
    await getPool().query(`DELETE FROM messages WHERE id = $1`, [card!.id]);
    await tick();
    await tick();
    expect(await cards(destChannelId)).toHaveLength(0);
  });

  it("unfollowing stops future cards and leaves the delivered ones", async () => {
    const created = await follow(alice, destChannelId);
    await publish({ title: "Um" });
    await tick();
    const del = await call(alice, "DELETE", `/api/bau-follows/${created.body.follow.id}`);
    expect(del.status).toBe(200);
    await publish({ title: "Dois" });
    await tick();
    const rows = await cards(destChannelId);
    expect(rows).toHaveLength(1);
    expect(messageForwardSchema.parse(rows[0]!.forward).title).toBe("Um");
    // A person with no standing in the destination cannot even see it exists.
    const again = await follow(alice, destChannelId);
    expect((await call(carol, "DELETE", `/api/bau-follows/${again.body.follow.id}`)).status).toBe(404);
  });

  // ------------------------------------------------------ failures and pause

  it("retries a failing delivery with a backoff, does not retry early, and gives up after the last attempt", async () => {
    await follow(alice, destChannelId);
    // A real database failure on the insert: a trigger that refuses this card.
    await getPool().query(`
      CREATE OR REPLACE FUNCTION bau_test_refuse() RETURNS trigger AS $$
      BEGIN
        IF NEW.body LIKE '%FAILME%' THEN RAISE EXCEPTION 'refused for the test'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await getPool().query(
      `CREATE TRIGGER bau_test_refuse BEFORE INSERT ON messages
         FOR EACH ROW EXECUTE FUNCTION bau_test_refuse()`,
    );
    try {
      await publish({ title: "FAILME" });
      await tick();
      const row = await getPool().query<{ status: string; attempts: number; last_error: string; wait: number }>(
        `SELECT status, attempts, last_error,
                EXTRACT(EPOCH FROM (next_attempt_at - NOW()))::float AS wait
           FROM bau_follow_deliveries`,
      );
      expect(row.rows[0]).toMatchObject({ status: "pending", attempts: 1 });
      expect(row.rows[0]!.last_error).toContain("refused for the test");
      expect(row.rows[0]!.wait).toBeGreaterThan(1);
      // Not due yet: another tick does not touch it.
      expect((await tick()).failed).toBe(0);
      for (let i = 1; i < BAU_FOLLOW_MAX_ATTEMPTS; i += 1) {
        await getPool().query(`UPDATE bau_follow_deliveries SET next_attempt_at = NOW()`);
        await tick();
      }
      const done = await getPool().query<{ status: string; attempts: number }>(
        `SELECT status, attempts FROM bau_follow_deliveries`,
      );
      expect(done.rows[0]).toEqual({ status: "dead", attempts: BAU_FOLLOW_MAX_ATTEMPTS });
      expect(await cards(destChannelId)).toHaveLength(0);
    } finally {
      await getPool().query(`DROP TRIGGER IF EXISTS bau_test_refuse ON messages`);
    }
  });

  it("three permission failures pause the follow, tell the staff, and a resume starts clean", async () => {
    // Bob manages the destination through a role, then loses it.
    await addMember(qgId, bob);
    const role = await createRole(destId, {
      name: "Integracoes",
      permissions: Permission.VIEW_CHANNEL | Permission.MANAGE_WEBHOOKS,
    });
    await assignRole(destId, bob.id, role.id);
    const made = await follow(bob, destChannelId);
    expect(made.status).toBe(201);
    await publish({ title: "Entregue" });
    await tick();
    expect(await cards(destChannelId)).toHaveLength(1);

    await unassignRole(destId, bob.id, role.id);
    for (const title of ["Um", "Dois", "Tres"]) {
      await publish({ title });
    }
    await tick();
    const paused = await getPool().query<{ paused_at: Date | null; paused_reason: string | null }>(
      `SELECT paused_at, paused_reason FROM bau_follows WHERE id = $1`,
      [made.body.follow.id],
    );
    expect(paused.rows[0]!.paused_at).not.toBeNull();
    expect(paused.rows[0]!.paused_reason).toBe("permissions");
    // Nothing from those three went out. One notice, from the source, said why.
    const titles = (await cards(destChannelId)).map((r) => messageForwardSchema.parse(r.forward).title);
    expect(titles).toEqual(["Entregue"]);
    const notice = await getPool().query<{ body: string }>(
      `SELECT body FROM messages WHERE channel_id = $1 AND forward IS NULL`,
      [destChannelId],
    );
    expect(notice.rows).toHaveLength(1);
    expect(notice.rows[0]!.body).toContain("Seguir pausado");
    expect(notice.rows[0]!.body).not.toMatch(/você|\u2014/);
    const audit = await getPool().query(
      `SELECT 1 FROM audit_log WHERE server_id = $1 AND action = 'bau_follow.pause'`,
      [destId],
    );
    expect(audit.rowCount).toBe(1);
    // Paused: a new post does not go out either.
    await publish({ title: "Durante a pausa" });
    await tick();
    expect(await cards(destChannelId)).toHaveLength(1);

    // The channel's staff see it paused and may resume it; Bob may not.
    const listed = await call<{ follows: Array<{ status: string }> }>(alice, "GET", `/api/channels/${destChannelId}/bau-follows`);
    expect(listed.body.follows[0]!.status).toBe("paused");
    expect((await call(bob, "PATCH", `/api/bau-follows/${made.body.follow.id}`, { resume: true })).status).toBe(404);
    const resumed = await call(alice, "PATCH", `/api/bau-follows/${made.body.follow.id}`, { resume: true });
    expect(resumed.status).toBe(200);
    expect(resumed.body.follow.status).toBe("active");
    await tick();
    // What came and went during the pause is not carried; the next post is.
    expect(await cards(destChannelId)).toHaveLength(1);
    await publish({ title: "Depois" });
    await tick();
    const after = (await cards(destChannelId)).map((r) => messageForwardSchema.parse(r.forward).title);
    expect(after).toEqual(["Entregue", "Depois"]);
  });

  it("a creator who can still manage the channel but can no longer SEE it pauses the follow", async () => {
    await addMember(qgId, bob);
    const role = await createRole(destId, {
      name: "Integracoes",
      permissions: Permission.VIEW_CHANNEL | Permission.MANAGE_WEBHOOKS,
    });
    await assignRole(destId, bob.id, role.id);
    const made = await follow(bob, destChannelId);
    expect(made.status).toBe(201);
    // A channel overwrite takes sight away from the role, and leaves the management bit.
    await upsertChannelOverwrite(destChannelId, destId, "role", role.id, 0n, Permission.VIEW_CHANNEL);
    for (const title of ["Um", "Dois", "Tres"]) {
      await publish({ title });
    }
    await tick();
    expect(await cards(destChannelId)).toHaveLength(0);
    const paused = await getPool().query(`SELECT paused_at FROM bau_follows WHERE id = $1`, [
      made.body.follow.id,
    ]);
    expect(paused.rows[0]!.paused_at).not.toBeNull();
  });

  it("a block and a follow being made at once leave no follow behind (the same lock)", async () => {
    const first = await follow(alice, destChannelId);
    expect(first.status).toBe(201);
    // The service calls directly: the HTTP helper above shares one signed-in
    // identity, which two simultaneous requests would fight over.
    const [blocked, second] = await Promise.allSettled([
      removeBauFollower({
        sourceServerId: qgId,
        followId: first.body.follow.id,
        actorId: qgOwner.id,
        block: true,
      }),
      createBauFollow({
        sourceServerId: qgId,
        channelId: destOwnerOnlyChannel,
        rolePingId: null,
        actorId: alice.id,
      }),
    ]);
    expect(blocked.status).toBe("fulfilled");
    // Whichever ran first, the end state is the same: blocked, and nothing of that server follows.
    expect(second.status === "fulfilled" || String((second as PromiseRejectedResult).reason).includes("does not accept")).toBe(true);
    const left = await getPool().query(
      `SELECT 1 FROM bau_follows WHERE source_server_id = $1 AND target_server_id = $2`,
      [qgId, destId],
    );
    expect(left.rowCount).toBe(0);
    const block = await getPool().query(`SELECT 1 FROM bau_follow_blocks WHERE source_server_id = $1`, [qgId]);
    expect(block.rowCount).toBe(1);
  });

  it("a second resume of a follow that is no longer paused changes nothing and drops nothing", async () => {
    const made = await follow(alice, destChannelId);
    await getPool().query(
      `UPDATE bau_follows SET paused_at = NOW(), paused_reason = 'permissions' WHERE id = $1`,
      [made.body.follow.id],
    );
    await updateBauFollow({ followId: made.body.follow.id, actorId: alice.id, resume: true });
    const since = await getPool().query<{ since_at: Date }>(`SELECT since_at FROM bau_follows WHERE id = $1`, [
      made.body.follow.id,
    ]);
    // A post queued after the first resume...
    const postId = await publish({ title: "Entre as duas" });
    await tick();
    // Held back as a pending row (a retry waiting), the shape a resume would drop.
    await getPool().query(
      `UPDATE bau_follow_deliveries
          SET status = 'pending', message_id = NULL, next_attempt_at = NOW() + INTERVAL '1 hour'
        WHERE post_id = $1`,
      [postId],
    );
    // ...survives the second resume, which finds the follow already active.
    await updateBauFollow({ followId: made.body.follow.id, actorId: alice.id, resume: true });
    const after = await getPool().query<{ since_at: Date }>(`SELECT since_at FROM bau_follows WHERE id = $1`, [
      made.body.follow.id,
    ]);
    expect(after.rows[0]!.since_at.getTime()).toBe(since.rows[0]!.since_at.getTime());
    const queued = await getPool().query(
      `SELECT 1 FROM bau_follow_deliveries WHERE post_id = $1 AND status = 'pending'`,
      [postId],
    );
    expect(queued.rowCount).toBe(1);
  });

  it("the card links the public page when the post has one, the in-app address otherwise", async () => {
    process.env.COMMUNITIES_ENABLED = "true";
    try {
      await follow(alice, destChannelId);
      const first = await publish({ title: "Sem pagina publica" });
      await tick();
      const plain = messageForwardSchema.parse((await cards(destChannelId))[0]!.forward);
      expect(plain.url).toContain(`/app/server/${qgId}/bau/${first}`);

      await setServerFlagOverride("bau_public_posts", qgId, true, { kind: "dashboard" });
      const second = await publish({ title: "Com pagina publica" });
      await tick();
      const rows = await cards(destChannelId);
      const withPage = rows
        .map((r) => messageForwardSchema.parse(r.forward))
        .find((f) => f.sourceId === second)!;
      expect(withPage.url).toMatch(new RegExp(`/c/qg-oficial/p/${second}$`));
    } finally {
      delete process.env.COMMUNITIES_ENABLED;
    }
  });

  it("the service refuses a follow from somebody who is not a member of the source", async () => {
    const outsider = await makeUser("outsider");
    const dest2 = await createChatServer("Fora", outsider.id);
    const channel = await textChannel(dest2.server.id);
    await expect(
      createBauFollow({ sourceServerId: qgId, channelId: channel, rolePingId: null, actorId: outsider.id }),
    ).rejects.toThrow(/Not found/);
  });

  it("a reply to a card quotes its title, not the fallback line with the URL", async () => {
    const role = await createRole(destId, { name: "novidades", permissions: Permission.VIEW_CHANNEL, mentionable: true });
    await follow(alice, destChannelId, role.id);
    await publish({ title: "Sessão 11" });
    await tick();
    const [card] = await cards(destChannelId);
    await createMessage(destChannelId, bob as never, "boa", card!.id);
    const history = await call<{ messages: Array<{ body: string; replyTo: { excerpt: string } | null }> }>(
      bob,
      "GET",
      `/api/channels/${destChannelId}/messages`,
    );
    const reply = history.body.messages.find((m) => m.body === "boa");
    expect(reply?.replyTo?.excerpt).toContain("Sessão 11");
    expect(reply?.replyTo?.excerpt).not.toContain("Encaminhado");
    expect(reply?.replyTo?.excerpt).not.toContain("http");
  });

  // ------------------------------------------------- edits reach every card

  it.each([21, 160])("an edit reaches all %i delivered cards, however many there are", async (total) => {
    const servers: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      servers.push((await createChatServer(`Dest ${i}`, alice.id)).server.id);
    }
    const channelIds: string[] = [];
    for (let i = 0; i < total; i += 1) {
      const server = servers[i % servers.length]!;
      const ch = await createChannel(server, `ed-${i}`, "text", false);
      channelIds.push(ch.id);
      await getPool().query(
        `INSERT INTO bau_follows (source_server_id, target_server_id, target_channel_id, created_by)
         VALUES ($1, $2, $3, $4)`,
        [qgId, server, ch.id, alice.id],
      );
    }
    const postId = await publish({ title: "Antes" });
    const delivered = async () =>
      (
        await getPool().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM bau_follow_deliveries WHERE post_id = $1 AND status = 'delivered'`,
          [postId],
        )
      ).rows[0]!.n;
    // The per-minute quota paces a big audience; move its window along until all are out.
    for (let round = 0; round < 6 && (await delivered()) < total; round += 1) {
      for (let i = 0; i < 4; i += 1) {
        await tick();
      }
      await getPool().query(
        `UPDATE bau_follow_deliveries SET delivered_at = NOW() - INTERVAL '2 minutes' WHERE status = 'delivered'`,
      );
    }
    expect(await delivered()).toBe(total);

    const edit = await call(qgOwner, "PATCH", `${home()}/posts/${postId}`, { title: "Depois" });
    expect(edit.status).toBe(200);
    // One tick carries the whole edit (ten pages of a hundred), however many cards.
    await tick();
    await tick();
    const stale = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages WHERE forward IS NOT NULL AND forward->>'title' <> 'Depois'`,
    );
    expect(stale.rows[0]!.n).toBe(0);
    const updated = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages WHERE forward->>'title' = 'Depois'`,
    );
    expect(updated.rows[0]!.n).toBe(total);
    // And a synced row is no longer "stale": the versions match to the microsecond.
    const still = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM bau_follow_deliveries d JOIN community_home_posts p ON p.id = d.post_id
        WHERE d.status = 'delivered' AND p.updated_at > d.post_updated_at`,
    );
    expect(still.rows[0]!.n).toBe(0);
  }, 120_000);

  // ----------------------------------------------- who may follow a source

  it("a plain member of an ordinary (private) server cannot follow it; its staff can, with the owner's switch on", async () => {
    const priv = await createChatServer("Interno", qgOwner.id);
    const privId = priv.server.id;
    await getPool().query(
      `UPDATE servers SET community_home_enabled = TRUE, bau_follow_allowed = TRUE WHERE id = $1`,
      [privId],
    );
    await sourceFlag(privId, true);
    await addMember(privId, alice);
    await addMember(privId, bob);
    const stateOf = async (as: TestUser) =>
      (await call(as, "GET", `/api/servers/${privId}/home/follow`)).body.enabled;
    // A plain member sees nothing offered, and creating is a 404.
    expect(await stateOf(alice)).toBe(false);
    const refused = await call(alice, "POST", `/api/servers/${privId}/home/follow`, {
      channelId: destChannelId,
      rolePingId: null,
    });
    expect(refused.status).toBe(404);
    // Its Manage Server staff are offered it.
    expect(await stateOf(qgOwner)).toBe(true);
    const staffRole = await createRole(privId, { name: "Staff", permissions: Permission.VIEW_CHANNEL | Permission.MANAGE_SERVER });
    await assignRole(privId, bob.id, staffRole.id);
    expect(await stateOf(bob)).toBe(true);
    // The switch off closes it for everyone, staff included.
    expect(
      (await call(qgOwner, "PATCH", `/api/servers/${privId}/home/follow-config`, { allowed: false })).status,
    ).toBe(200);
    expect(await stateOf(qgOwner)).toBe(false);
  });

  it("the owner's switch gates a public community too, and moving it is audited and a plain member cannot move it", async () => {
    // The QG is public: a plain member follows while the switch is on...
    expect((await call(alice, "GET", `${home()}/follow`)).body.enabled).toBe(true);
    expect((await call(alice, "PATCH", `${home()}/follow-config`, { allowed: false })).status).toBe(403);
    const off = await call(qgOwner, "PATCH", `${home()}/follow-config`, { allowed: false });
    expect(off.status).toBe(200);
    expect(off.body.allowed).toBe(false);
    // ...and not once it is off (default for a server that never turned it on).
    expect((await call(alice, "GET", `${home()}/follow`)).body.enabled).toBe(false);
    expect((await follow(alice, destChannelId)).status).toBe(404);
    await call(qgOwner, "PATCH", `${home()}/follow-config`, { allowed: true });
    expect((await follow(alice, destChannelId)).status).toBe(201);
    const audit = await getPool().query<{ action: string }>(
      `SELECT action FROM audit_log WHERE server_id = $1 AND action LIKE 'bau_follow.%allow' ORDER BY created_at`,
      [qgId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["bau_follow.disallow", "bau_follow.allow"]);
  });

  it("switching it off stops deliveries (they wait), switching it back on sends them", async () => {
    await follow(alice, destChannelId);
    await call(qgOwner, "PATCH", `${home()}/follow-config`, { allowed: false });
    await publish({ title: "Durante" });
    await tick();
    expect(await cards(destChannelId)).toHaveLength(0);
    await call(qgOwner, "PATCH", `${home()}/follow-config`, { allowed: true });
    await getPool().query(`UPDATE bau_follow_deliveries SET next_attempt_at = NOW()`);
    await tick();
    await tick();
    expect(await cards(destChannelId)).toHaveLength(1);
  });

  it("a creator who loses Manage Server on a PRIVATE source loses the follow after three failures", async () => {
    const priv = await createChatServer("Interno 2", qgOwner.id);
    const privId = priv.server.id;
    await getPool().query(
      `UPDATE servers SET community_home_enabled = TRUE, bau_follow_allowed = TRUE WHERE id = $1`,
      [privId],
    );
    await sourceFlag(privId, true);
    await addMember(privId, alice);
    const staffRole = await createRole(privId, { name: "Staff", permissions: Permission.VIEW_CHANNEL | Permission.MANAGE_SERVER });
    await assignRole(privId, alice.id, staffRole.id);
    const made = await call(alice, "POST", `/api/servers/${privId}/home/follow`, {
      channelId: destChannelId,
      rolePingId: null,
    });
    expect(made.status).toBe(201);
    await unassignRole(privId, alice.id, staffRole.id);
    for (const title of ["A", "B", "C"]) {
      await call(qgOwner, "POST", `/api/servers/${privId}/home/posts`, {
        status: "published",
        title,
        body: "texto",
      });
    }
    await tick();
    expect(await cards(destChannelId)).toHaveLength(0);
    const row = await getPool().query(`SELECT paused_at FROM bau_follows WHERE id = $1`, [made.body.follow.id]);
    expect(row.rows[0]!.paused_at).not.toBeNull();
  });

  // ----------------------------------------- the destination's own say

  it("a destination's ban of the source identity is honoured and counts toward the pause", async () => {
    const made = await follow(alice, destChannelId);
    // The first card creates the identity; ban it in the destination.
    await publish({ title: "Primeiro" });
    await tick();
    expect(await cards(destChannelId)).toHaveLength(1);
    const identity = await getPool().query<{ id: string }>(
      `SELECT id FROM users WHERE clerk_id = $1`,
      [`bau-follow:${qgId}`],
    );
    await getPool().query(`INSERT INTO server_bans (server_id, user_id, banned_by) VALUES ($1, $2, $3)`, [
      destId,
      identity.rows[0]!.id,
      alice.id,
    ]);
    for (const title of ["Dois", "Tres", "Quatro"]) {
      await publish({ title });
    }
    await tick();
    expect(await cards(destChannelId)).toHaveLength(1);
    const row = await getPool().query<{ paused_at: Date | null; paused_reason: string | null }>(
      `SELECT paused_at, paused_reason FROM bau_follows WHERE id = $1`,
      [made.body.follow.id],
    );
    expect(row.rows[0]!.paused_at).not.toBeNull();
    // Said as what it is: the server banned the Baú, not "somebody lost a permission".
    expect(row.rows[0]!.paused_reason).toBe("banned");
    const audit = await getPool().query<{ reason: string }>(
      `SELECT reason FROM audit_log WHERE server_id = $1 AND action = 'bau_follow.pause'`,
      [destId],
    );
    expect(audit.rows.map((r) => r.reason)).toEqual(["banned"]);
    const notice = await getPool().query<{ body: string }>(
      `SELECT body FROM messages WHERE channel_id = $1 AND forward IS NULL`,
      [destChannelId],
    );
    expect(notice.rows).toHaveLength(1);
    expect(notice.rows[0]!.body).toContain("baniu");
    expect(notice.rows[0]!.body).not.toContain("perdeu a permissão");
    const listed = await call<{ follows: Array<{ pausedReason: string | null }> }>(
      alice,
      "GET",
      `/api/channels/${destChannelId}/bau-follows`,
    );
    expect(listed.body.follows[0]!.pausedReason).toBe("banned");
  });

  it("slow mode in the destination spaces the cards out instead of bypassing it", async () => {
    await follow(alice, destChannelId);
    await getPool().query(`UPDATE channels SET slowmode_seconds = 600 WHERE id = $1`, [destChannelId]);
    await publish({ title: "Um" });
    await tick();
    await publish({ title: "Dois" });
    await tick();
    expect(await cards(destChannelId)).toHaveLength(1);
    const waiting = await getPool().query<{ wait: number }>(
      `SELECT EXTRACT(EPOCH FROM (next_attempt_at - NOW()))::float AS wait
         FROM bau_follow_deliveries WHERE status = 'pending'`,
    );
    expect(waiting.rows).toHaveLength(1);
    expect(waiting.rows[0]!.wait).toBeGreaterThan(300);
  });

  it("nobody can send a friend request to the source identity", async () => {
    await follow(alice, destChannelId);
    await publish({ title: "Um" });
    await tick();
    const [card] = await cards(destChannelId);
    const author = await getPool().query<{ author_id: string }>(
      `SELECT author_id FROM messages WHERE id = $1`,
      [card!.id],
    );
    const res = await call(bob, "POST", "/api/friends", { userId: author.rows[0]!.author_id });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const rows = await getPool().query(`SELECT 1 FROM friendships`);
    expect(rows.rowCount).toBe(0);
  });

  // ------------------------------------------------------------- the source

  it("the source's staff see followers by server name, can remove one, and can block a server", async () => {
    await follow(alice, destChannelId);
    await follow(alice, destOwnerOnlyChannel);
    // Members cannot see the list; staff can.
    expect((await call(carol, "GET", `${home()}/followers`)).status).toBe(403);
    const list = await call<{ count: number; followers: Array<{ id: string; targetServerName: string }> }>(
      qgOwner,
      "GET",
      `${home()}/followers`,
    );
    expect(list.body.count).toBe(2);
    expect(list.body.followers.map((f) => f.targetServerName)).toEqual(["Galera", "Galera"]);
    expect(JSON.stringify(list.body)).not.toContain(alice.id);

    // Remove one: the other stays.
    expect((await call(qgOwner, "DELETE", `${home()}/followers/${list.body.followers[0]!.id}`)).status).toBe(200);
    expect((await call<{ count: number }>(qgOwner, "GET", `${home()}/followers`)).body.count).toBe(1);

    // Block the whole server: its remaining follow goes, and it cannot come back.
    const [rest] = (await call<{ followers: Array<{ id: string }> }>(qgOwner, "GET", `${home()}/followers`)).body.followers;
    expect((await call(qgOwner, "DELETE", `${home()}/followers/${rest!.id}?block=1`)).status).toBe(200);
    const blocked = await call<{ count: number; blocked: Array<{ serverId: string }> }>(qgOwner, "GET", `${home()}/followers`);
    expect(blocked.body.count).toBe(0);
    expect(blocked.body.blocked.map((b) => b.serverId)).toEqual([destId]);
    expect((await follow(alice, destChannelId)).status).toBe(403);
    expect(
      (await call<{ servers: unknown[] }>(alice, "GET", `${home()}/follow/destinations`)).body.servers,
    ).toEqual([]);
    expect((await call(qgOwner, "DELETE", `${home()}/follow-blocks/${destId}`)).status).toBe(200);
    expect((await follow(alice, destChannelId)).status).toBe(201);
  });

  // ------------------------------------------------------------------ limits

  it("delivers at most the per-minute cap of one post, the rest on the next minute", async () => {
    const cap = BAU_FOLLOW_MAX_DELIVERIES_PER_POST_PER_MINUTE;
    const total = cap + 5;
    const servers: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const s = await createChatServer(`Dest ${i}`, alice.id);
      servers.push(s.server.id);
    }
    const channelIds: string[] = [];
    for (let i = 0; i < total; i += 1) {
      const server = servers[i % servers.length]!;
      const ch = await createChannel(server, `seg-${i}`, "text", false);
      channelIds.push(ch.id);
      // Direct insert: the per-server maximum is the route's rule, not the job's.
      await getPool().query(
        `INSERT INTO bau_follows (source_server_id, target_server_id, target_channel_id, created_by)
         VALUES ($1, $2, $3, $4)`,
        [qgId, server, ch.id, alice.id],
      );
    }
    await publish();
    const deliveredRows = async () =>
      (
        await getPool().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM bau_follow_deliveries WHERE status = 'delivered'`,
        )
      ).rows[0]!.n;
    // Ticks until the batch size stops mattering: only the cap can hold it back.
    for (let i = 0; i < 4; i += 1) {
      await tick();
    }
    expect(await deliveredRows()).toBe(cap);
    // Within the same minute nothing more goes.
    await tick();
    expect(await deliveredRows()).toBe(cap);
    // A minute on, the remainder does.
    await getPool().query(`UPDATE bau_follow_deliveries SET delivered_at = NOW() - INTERVAL '2 minutes' WHERE status = 'delivered'`);
    await tick();
    expect(await deliveredRows()).toBe(total);
  });

  it("a post at its quota does not hold a later post back", async () => {
    const cap = BAU_FOLLOW_MAX_DELIVERIES_PER_POST_PER_MINUTE;
    const server = (await createChatServer("Dest fair", alice.id)).server.id;
    for (let i = 0; i < cap + 5; i += 1) {
      const ch = await createChannel(server, `fair-${i}`, "text", false);
      await getPool().query(
        `INSERT INTO bau_follows (source_server_id, target_server_id, target_channel_id, created_by)
         VALUES ($1, $2, $3, $4)`,
        [qgId, server, ch.id, alice.id],
      );
    }
    const first = await publish({ title: "Primeiro" });
    for (let i = 0; i < 4; i += 1) {
      await tick();
    }
    const delivered = async (postId: string) =>
      (
        await getPool().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM bau_follow_deliveries WHERE post_id = $1 AND status = 'delivered'`,
          [postId],
        )
      ).rows[0]!.n;
    expect(await delivered(first)).toBe(cap);
    // The first post is at its quota with five rows still due; a second one
    // arrives in the same minute and is served in full up to ITS quota.
    const second = await publish({ title: "Segundo" });
    for (let i = 0; i < 4; i += 1) {
      await tick();
    }
    expect(await delivered(second)).toBe(cap);
    expect(await delivered(first)).toBe(cap);  });
});

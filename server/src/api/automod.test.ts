import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * AutoMod end to end: the rule routes and who may call them, and that a
 * rule actually refuses a send on the shared create path (`postChannelMessage`,
 * the function both the socket frame and the character HTTP send land in).
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

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { invalidateAutomodCache, resetAutomodUser } = await import(
  "../services/automod.js"
);
const { postChannelMessage } = await import("../ws/index.js");
const { getUserById } = await import("../services/users.js");

let server: Server;
let baseUrl: string;

type Actor = { id: string; clerk_id: string };

async function call<T = Record<string, unknown>>(
  as: Actor | null,
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
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
  };
}

describeDb("automod", () => {
  let owner: Actor;
  let member: Actor;

  beforeAll(async () => {
    await initDb();
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => server.listen(0, done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(async () => {
    // A hit's audit and alert writes run after the refusal returns, so the
    // previous test may still be writing when this one truncates. Let them
    // land first or TRUNCATE deadlocks against them.
    await new Promise((done) => setTimeout(done, 120));
    resetApiRateLimits();
    invalidateAutomodCache();
    resetAutomodUser();
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, server_invites, server_bans,
                channel_reads, message_mentions, message_reactions,
                message_attachments, user_blocks, dm_pairs, link_embeds,
                automod_rules, audit_log, reports, member_timeouts, roles,
                member_roles
       RESTART IDENTITY CASCADE`,
    );
    owner = await upsertUser({
      clerkId: "clerk_owner",
      displayName: "Owner",
      avatarUrl: null,
    });
    member = await upsertUser({
      clerkId: "clerk_member",
      displayName: "Member",
      avatarUrl: null,
    });
  });

  async function makeServer() {
    const created = await call<{
      server: { id: string };
      channels: Array<{ id: string; type: string }>;
    }>(owner, "POST", "/api/servers", { name: "Hall" });
    expect(created.status).toBe(201);
    const serverId = created.body.server.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, member.id],
    );
    const text = created.body.channels.find((c) => c.type === "text")!;
    return { serverId, channelId: text.id };
  }

  const rulesPath = (serverId: string) =>
    `/api/servers/${serverId}/automod/rules`;

  /** Status-shaped like HTTP so the assertions read the same: 201 or 422. */
  async function send(as: Actor, channelId: string, body: string) {
    const author = await getUserById(as.id);
    const posted = await postChannelMessage({ author: author!, channelId, body });
    if (posted.ok) {
      return { status: 201, body: {} as { error?: string } };
    }
    return {
      status: posted.reason === "automod" ? 422 : 403,
      body: { error: posted.automodMessage ?? "Blocked by AutoMod" },
    };
  }

  it("owner manages rules, moderator reads, member sees nothing", async () => {
    const { serverId } = await makeServer();

    expect((await call(member, "GET", rulesPath(serverId))).status).toBe(403);
    expect(
      (
        await call(member, "POST", rulesPath(serverId), {
          kind: "keywords",
          keywords: ["x"],
        })
      ).status,
    ).toBe(403);

    const createdRule = await call<{ rule: { id: string; keywords: string[] } }>(
      owner,
      "POST",
      rulesPath(serverId),
      { kind: "keywords", keywords: [" scam* ", "scam*", "golpe"] },
    );
    expect(createdRule.status).toBe(201);
    expect(createdRule.body.rule.keywords).toEqual(["scam*", "golpe"]);

    const listed = await call<{ rules: Array<{ id: string }> }>(
      owner,
      "GET",
      rulesPath(serverId),
    );
    expect(listed.body.rules.map((r) => r.id)).toEqual([createdRule.body.rule.id]);

    const patched = await call<{ rule: { enabled: boolean; customMessage: string } }>(
      owner,
      "PATCH",
      `${rulesPath(serverId)}/${createdRule.body.rule.id}`,
      { enabled: false, customMessage: "  Sem golpe aqui  " },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.rule.enabled).toBe(false);
    expect(patched.body.rule.customMessage).toBe("Sem golpe aqui");

    expect(
      (
        await call(owner, "PATCH", `${rulesPath(serverId)}/${createdRule.body.rule.id}`, {})
      ).status,
    ).toBe(400);

    expect(
      (
        await call(owner, "DELETE", `${rulesPath(serverId)}/${createdRule.body.rule.id}`)
      ).status,
    ).toBe(200);
    expect(
      (
        await call(owner, "DELETE", `${rulesPath(serverId)}/${createdRule.body.rule.id}`)
      ).status,
    ).toBe(404);

    const audit = await getPool().query<{ action: string }>(
      `SELECT action FROM audit_log WHERE server_id = $1 ORDER BY id`,
      [serverId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      "automod.rule_create",
      "automod.rule_update",
      "automod.rule_delete",
    ]);
  });

  it("refuses a blocked word with the rule's copy, and lets a clean message through", async () => {
    const { serverId, channelId } = await makeServer();
    await call(owner, "POST", rulesPath(serverId), {
      kind: "keywords",
      keywords: ["golpe*"],
      allowList: ["golpe de mestre"],
      customMessage: "Aqui não.",
    });

    const blocked = await send(member, channelId, "isso é GOLPE puro");
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toBe("Aqui não.");

    const evasion = await send(member, channelId, "g​olpes");
    expect(evasion.status).toBe(422);

    const allowed = await send(member, channelId, "foi um golpe de mestre");
    expect(allowed.status).toBe(201);

    const clean = await send(member, channelId, "bom dia");
    expect(clean.status).toBe(201);

    const rows = await getPool().query<{ body: string }>(
      `SELECT body FROM messages WHERE channel_id = $1 ORDER BY created_at`,
      [channelId],
    );
    expect(rows.rows.map((r) => r.body)).toEqual([
      "foi um golpe de mestre",
      "bom dia",
    ]);
  });

  it("MANAGE_MESSAGES walks through, and a disabled rule does nothing", async () => {
    const { serverId, channelId } = await makeServer();
    const rule = await call<{ rule: { id: string } }>(owner, "POST", rulesPath(serverId), {
      kind: "keywords",
      keywords: ["golpe"],
    });

    expect((await send(owner, channelId, "golpe")).status).toBe(201);
    expect((await send(member, channelId, "golpe")).status).toBe(422);

    await call(owner, "PATCH", `${rulesPath(serverId)}/${rule.body.rule.id}`, {
      enabled: false,
    });
    expect((await send(member, channelId, "golpe")).status).toBe(201);
  });

  it("an edit is a send: the new body is checked too", async () => {
    const { serverId, channelId } = await makeServer();
    await call(owner, "POST", rulesPath(serverId), {
      kind: "keywords",
      keywords: ["golpe"],
      customMessage: "Nem editando.",
    });
    const author = await getUserById(member.id);
    const posted = await postChannelMessage({ author: author!, channelId, body: "oi" });
    expect(posted.ok).toBe(true);
    const messageId = posted.ok ? posted.message.id : "";

    const edited = await call<{ error?: string }>(
      member,
      "PATCH",
      `/api/messages/${messageId}`,
      { body: "oi golpe" },
    );
    expect(edited.status).toBe(422);
    expect(edited.body.error).toBe("Nem editando.");

    const kept = await getPool().query<{ body: string }>(
      `SELECT body FROM messages WHERE id = $1`,
      [messageId],
    );
    expect(kept.rows[0]!.body).toBe("oi");

    const clean = await call(member, "PATCH", `/api/messages/${messageId}`, {
      body: "oi de novo",
    });
    expect(clean.status).toBe(200);

    // The owner walks through on an edit exactly as on a send.
    const ownerPost = await postChannelMessage({
      author: (await getUserById(owner.id))!,
      channelId,
      body: "mod",
    });
    const ownerId = ownerPost.ok ? ownerPost.message.id : "";
    expect(
      (await call(owner, "PATCH", `/api/messages/${ownerId}`, { body: "golpe" })).status,
    ).toBe(200);
  });

  it("an exempt channel skips the rule", async () => {
    const { serverId, channelId } = await makeServer();
    await call(owner, "POST", rulesPath(serverId), {
      kind: "invite_links",
      exemptChannelIds: [channelId],
    });
    expect(
      (await send(member, channelId, "vem pro discord.gg/abcd")).status,
    ).toBe(201);

    const other = await call<{ channel: { id: string } }>(
      owner,
      "POST",
      `/api/servers/${serverId}/channels`,
      { name: "geral-2", type: "text" },
    );
    expect(other.status).toBe(201);
    expect(
      (await send(member, other.body.channel.id, "vem pro discord.gg/abcd")).status,
    ).toBe(422);
  });

  it("mention spam trips above the limit and logs the hit without the body", async () => {
    const { serverId, channelId } = await makeServer();
    await call(owner, "POST", rulesPath(serverId), {
      kind: "mention_spam",
      mentionLimit: 2,
    });
    expect((await send(member, channelId, "@a1 @b2 oi")).status).toBe(201);
    const blocked = await send(member, channelId, "@a1 @b2 @c3 segredo");
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toMatch(/AutoMod/);

    // The hit's audit row is written after the refusal; give it a tick.
    await new Promise((done) => setTimeout(done, 50));

    const audit = await getPool().query<{
      action: string;
      target_id: string;
      reason: string;
      changes: Array<{ key: string; new: unknown }>;
    }>(
      `SELECT action, target_id, reason, changes FROM audit_log
       WHERE server_id = $1 AND action = 'automod.block'`,
      [serverId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.target_id).toBe(member.id);
    expect(audit.rows[0]!.reason).toBe("mention_spam");
    expect(JSON.stringify(audit.rows[0]!.changes)).not.toContain("segredo");
  });

  it("a hit can post an alert and time the author out, as AutoMod", async () => {
    const { serverId, channelId } = await makeServer();
    const alerts = await call<{ channel: { id: string } }>(
      owner,
      "POST",
      `/api/servers/${serverId}/channels`,
      { name: "mod-log", type: "text" },
    );
    const alertChannelId = alerts.body.channel.id;

    // The alert channel has to be a text channel of this server.
    const foreign = await call(owner, "POST", "/api/servers", { name: "Other" });
    const foreignChannel = (foreign.body as { channels: Array<{ id: string; type: string }> })
      .channels.find((c) => c.type === "text")!.id;
    expect(
      (
        await call(owner, "POST", rulesPath(serverId), {
          kind: "keywords",
          keywords: ["golpe"],
          alertChannelId: foreignChannel,
        })
      ).status,
    ).toBe(400);

    const created = await call<{ rule: { id: string; alertChannelId: string; timeoutMinutes: number } }>(
      owner,
      "POST",
      rulesPath(serverId),
      { kind: "keywords", keywords: ["golpe"], alertChannelId, timeoutMinutes: 5 },
    );
    expect(created.status).toBe(201);
    expect(created.body.rule.alertChannelId).toBe(alertChannelId);
    expect(created.body.rule.timeoutMinutes).toBe(5);

    expect((await send(member, channelId, "golpe aqui")).status).toBe(422);
    await new Promise((done) => setTimeout(done, 100));

    const timeout = await getPool().query<{ issued_by: string; reason: string }>(
      `SELECT issued_by, reason FROM member_timeouts WHERE server_id = $1 AND user_id = $2`,
      [serverId, member.id],
    );
    expect(timeout.rows).toHaveLength(1);
    expect(timeout.rows[0]!.reason).toMatch(/AutoMod/);
    const issuer = await getPool().query<{ clerk_id: string; is_webhook: boolean }>(
      `SELECT clerk_id, is_webhook FROM users WHERE id = $1`,
      [timeout.rows[0]!.issued_by],
    );
    expect(issuer.rows[0]).toEqual({ clerk_id: "system:automod", is_webhook: true });

    const alert = await getPool().query<{ webhook_username: string; webhook_embeds: unknown }>(
      `SELECT webhook_username, webhook_embeds FROM messages WHERE channel_id = $1`,
      [alertChannelId],
    );
    expect(alert.rows).toHaveLength(1);
    expect(alert.rows[0]!.webhook_username).toBe("AutoMod");
    expect(JSON.stringify(alert.rows[0]!.webhook_embeds)).toContain("golpe aqui");

    const actions = await getPool().query<{ action: string }>(
      `SELECT action FROM audit_log WHERE server_id = $1 AND actor_id IS NULL ORDER BY id`,
      [serverId],
    );
    expect(actions.rows.map((r) => r.action)).toEqual(["automod.block", "member.timeout"]);

    // Clearing the alert channel is a real patch, not "leave it".
    const cleared = await call<{ rule: { alertChannelId: string | null } }>(
      owner,
      "PATCH",
      `${rulesPath(serverId)}/${created.body.rule.id}`,
      { alertChannelId: null },
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body.rule.alertChannelId).toBeNull();
  });

  it("MANAGE_SERVER walks through even without MANAGE_MESSAGES", async () => {
    const { serverId, channelId } = await makeServer();
    await call(owner, "POST", rulesPath(serverId), { kind: "keywords", keywords: ["golpe"] });
    const role = await call<{ role: { id: string } }>(owner, "POST", `/api/servers/${serverId}/roles`, {
      name: "Gestor",
      permissions: String(1n << 5n),
    });
    expect(role.status).toBe(201);
    await getPool().query(
      `INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)`,
      [serverId, member.id, role.body.role.id],
    );
    expect((await send(member, channelId, "golpe")).status).toBe(201);
  });
});

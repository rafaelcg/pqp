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
import type { WebSocket } from "ws";
import type { OutgoingWebhook } from "@pqp/shared";

/**
 * Outgoing channel webhooks, pinned at the places they can silently stop
 * working: chat send must still succeed when the URL is down, bots must not
 * answer themselves, and a member without MANAGE_WEBHOOKS must not CRUD.
 *
 * POST is stubbed. SSRF itself is proved against a real listener in
 * lib/safe-fetch.test.ts; hanging this file on a live receiver would make
 * "the hook is down" a network flake rather than an assertion.
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
  forgetAuthUser: () => {},
  deleteClerkUser: async () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  resolveAuthSession: async () =>
    actor ? { user: actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

vi.mock("../lib/safe-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/safe-fetch.js")>();
  return { ...actual, safePost: vi.fn() };
});

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("../api/index.js");
const { upsertUser } = await import("./users.js");
const { createServer: createChatServer, createChannel } = await import(
  "./servers.js"
);
const { assignRole } = await import("./roles.js");
const { createWebhook, executeWebhook } = await import("./webhooks.js");
const { handleChatMessage, resetChatRateLimits } = await import(
  "../ws/chat.js"
);
const { safePost } = await import("../lib/safe-fetch.js");
const {
  assertOutgoingWebhookUrl,
  enqueueOutgoingMessageCreated,
  resetOutgoingWebhookRateLimit,
  statusWithCharacterHook,
} = await import("./outgoing-webhooks.js");
const { createCharacterAccount } = await import("./characters.js");
const { createInvite, redeemInvite } = await import("./invites.js");
const { verifySignatureHeader } = await import("../lib/webhook-sign.js");

let httpServer: Server;
let baseUrl: string;

interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  as: { id: string; clerk_id: string } | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
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

function recordingSocket(): { socket: WebSocket; received: string[] } {
  const received: string[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => received.push(payload),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, received };
}

async function deliveryCount(): Promise<number> {
  const result = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM outgoing_webhook_deliveries`,
  );
  return Number(result.rows[0]!.count);
}

async function waitForSafePost(times = 1): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (vi.mocked(safePost).mock.calls.length >= times) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("assertOutgoingWebhookUrl", () => {
  it("refuses loopback unless OUTGOING_WEBHOOKS_ALLOW_PRIVATE is on", async () => {
    delete process.env.OUTGOING_WEBHOOKS_ALLOW_PRIVATE;
    await expect(
      assertOutgoingWebhookUrl("http://127.0.0.1:9/hook"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses credentials in the URL", async () => {
    await expect(
      assertOutgoingWebhookUrl("https://user:pass@example.com/hook"),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("statusWithCharacterHook", () => {
  it("leaves humans and live sockets alone", () => {
    expect(statusWithCharacterHook("offline", false, true)).toBe("offline");
    expect(statusWithCharacterHook("idle", true, true)).toBe("idle");
    expect(statusWithCharacterHook("dnd", true, true)).toBe("dnd");
    expect(statusWithCharacterHook("online", true, false)).toBe("online");
  });

  it("paints a socketless character online only while a hook is active", () => {
    expect(statusWithCharacterHook("offline", true, true)).toBe("online");
    expect(statusWithCharacterHook("offline", true, false)).toBe("offline");
  });
});

describeDb("outgoing webhooks", () => {
  let owner: { id: string; clerk_id: string };
  let manager: { id: string; clerk_id: string };
  let member: { id: string; clerk_id: string };
  let serverId: string;
  let channelId: string;
  let otherChannelId: string;

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
    resetChatRateLimits();
    resetOutgoingWebhookRateLimit();
    process.env.OUTGOING_WEBHOOKS_ALLOW_PRIVATE = "true";
    vi.mocked(safePost).mockReset();
    vi.mocked(safePost).mockResolvedValue({
      statusCode: 500,
      headers: {},
      body: Buffer.from(""),
      finalUrl: "http://127.0.0.1/hook",
    });

    const makeUser = (name: string) =>
      upsertUser({
        clerkId: `clerk_${name}`,
        displayName: name,
        avatarUrl: null,
      });
    owner = await makeUser("owner");
    manager = await makeUser("manager");
    member = await makeUser("member");

    const created = await createChatServer("Hooks", owner.id);
    serverId = created.server.id;
    channelId = created.channels.find((c) => c.type === "text")!.id;
    otherChannelId = (await createChannel(serverId, "other", "text")).id;

    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
      [serverId, manager.id, member.id],
    );
    const managerRole = await getPool().query<{ id: string }>(
      `SELECT id FROM roles WHERE server_id = $1 AND system_key = 'manager'`,
      [serverId],
    );
    await assignRole(serverId, manager.id, managerRole.rows[0]!.id);
  });

  async function dbUser(userId: string) {
    const result = await getPool().query(`SELECT * FROM users WHERE id = $1`, [
      userId,
    ]);
    return result.rows[0]!;
  }

  async function say(as: { id: string }, channel: string, body: string) {
    const { socket } = recordingSocket();
    await handleChatMessage(
      { socket, user: await dbUser(as.id) },
      { type: "message-create", channelId: channel, body },
    );
  }

  function createBody(overrides: Record<string, unknown> = {}) {
    return {
      name: "Grok Bot",
      url: "http://127.0.0.1:9/hook",
      channelIds: [channelId],
      ...overrides,
    };
  }

  it("returns 403 to a member without MANAGE_WEBHOOKS and lets owner/manager CRUD", async () => {
    const forbidden = await call(member, "GET", `/api/servers/${serverId}/outgoing-webhooks`);
    expect(forbidden.status).toBe(403);

    const memberCreate = await call(
      member,
      "POST",
      `/api/servers/${serverId}/outgoing-webhooks`,
      createBody(),
    );
    expect(memberCreate.status).toBe(403);

    const asOwner = await call<{ webhook: OutgoingWebhook }>(
      owner,
      "POST",
      `/api/servers/${serverId}/outgoing-webhooks`,
      createBody({
        authHeaderName: "Authorization",
        authHeaderValue: "Bearer sender-key",
      }),
    );
    expect(asOwner.status).toBe(201);
    expect(asOwner.body.webhook.signingSecret).toMatch(/^whsec_/);
    const secret = asOwner.body.webhook.signingSecret!;

    const listed = await call<{ webhooks: OutgoingWebhook[] }>(
      owner,
      "GET",
      `/api/servers/${serverId}/outgoing-webhooks`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.webhooks).toHaveLength(1);
    expect(listed.body.webhooks[0]!.signingSecret).toBeUndefined();
    expect(listed.body.webhooks[0]!.secretHint).toBe(secret.slice(-4));
    expect(listed.body.webhooks[0]!.authHeaderHint).toBe("-key");
    expect(
      JSON.stringify(listed.body.webhooks[0]).includes("Bearer sender-key"),
    ).toBe(false);

    const asManager = await call<{ webhook: OutgoingWebhook }>(
      manager,
      "POST",
      `/api/servers/${serverId}/outgoing-webhooks`,
      createBody({ name: "Manager hook" }),
    );
    expect(asManager.status).toBe(201);
    expect(asManager.body.webhook.signingSecret).toMatch(/^whsec_/);

    const rotated = await call<{ webhook: OutgoingWebhook }>(
      manager,
      "POST",
      `/api/outgoing-webhooks/${asManager.body.webhook.id}/rotate-secret`,
    );
    expect(rotated.status).toBe(200);
    expect(rotated.body.webhook.signingSecret).toMatch(/^whsec_/);
    expect(rotated.body.webhook.signingSecret).not.toBe(
      asManager.body.webhook.signingSecret,
    );
  });

  it("enqueues one row for a human message and none for an unlisted channel", async () => {
    expect(
      (await call(owner, "POST", `/api/servers/${serverId}/outgoing-webhooks`, createBody())).status,
    ).toBe(201);

    await say(owner, channelId, "hello from a human");
    expect(await deliveryCount()).toBe(1);

    await say(owner, otherChannelId, "nothing subscribed here");
    expect(await deliveryCount()).toBe(1);
  });

  it("does not enqueue for character, incoming-webhook, or is_bot authors", async () => {
    expect(
      (await call(owner, "POST", `/api/servers/${serverId}/outgoing-webhooks`, createBody())).status,
    ).toBe(201);

    await getPool().query(`UPDATE users SET is_character = TRUE WHERE id = $1`, [
      member.id,
    ]);
    await say(member, channelId, "a character talking");
    expect(await deliveryCount()).toBe(0);

    await getPool().query(
      `UPDATE users SET is_character = FALSE, is_webhook = TRUE WHERE id = $1`,
      [member.id],
    );
    await say(member, channelId, "a webhook talking");
    expect(await deliveryCount()).toBe(0);

    await getPool().query(
      `UPDATE users SET is_webhook = FALSE, is_bot = TRUE WHERE id = $1`,
      [member.id],
    );
    await say(member, channelId, "a labeled bot talking");
    expect(await deliveryCount()).toBe(0);

    const incoming = await createWebhook(
      channelId,
      serverId,
      "Build Bot",
      null,
      owner.id,
    );
    await executeWebhook(incoming, { content: "build passed" });
    expect(await deliveryCount()).toBe(0);
  });

  it("does not enqueue when the author is on the hook skip list", async () => {
    expect(
      (
        await call(
          owner,
          "POST",
          `/api/servers/${serverId}/outgoing-webhooks`,
          createBody({ skipUserIds: [member.id] }),
        )
      ).status,
    ).toBe(201);

    await say(member, channelId, "caio answering");
    expect(await deliveryCount()).toBe(0);

    await say(owner, channelId, "a human asking");
    expect(await deliveryCount()).toBe(1);
  });

  it("lets a manager edit the URL and channels after create", async () => {
    const created = await call<{ webhook: OutgoingWebhook }>(
      owner,
      "POST",
      `/api/servers/${serverId}/outgoing-webhooks`,
      createBody(),
    );
    expect(created.status).toBe(201);

    const updated = await call<{ webhook: OutgoingWebhook }>(
      manager,
      "PATCH",
      `/api/outgoing-webhooks/${created.body.webhook.id}`,
      {
        url: "http://127.0.0.1:9/hook-b",
        channelIds: [otherChannelId],
        skipUserIds: [member.id],
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.webhook.url).toBe("http://127.0.0.1:9/hook-b");
    expect(updated.body.webhook.channelIds).toEqual([otherChannelId]);
    expect(updated.body.webhook.skipUserIds).toEqual([member.id]);
  });

  it("still broadcasts when the POST fails", async () => {
    vi.mocked(safePost).mockRejectedValue(new Error("endpoint down"));
    expect(
      (await call(owner, "POST", `/api/servers/${serverId}/outgoing-webhooks`, createBody())).status,
    ).toBe(201);

    const viewer = recordingSocket();
    await handleChatMessage(
      { socket: viewer.socket, user: await dbUser(member.id) },
      { type: "join-channel", channelId },
    );
    viewer.received.length = 0;

    await handleChatMessage(
      { socket: recordingSocket().socket, user: await dbUser(owner.id) },
      { type: "message-create", channelId, body: "still going out" },
    );

    expect(
      viewer.received.some((raw) => raw.includes("still going out")),
    ).toBe(true);
    const stored = await getPool().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM messages WHERE channel_id = $1`,
      [channelId],
    );
    expect(Number(stored.rows[0]!.count)).toBe(1);
    expect(await deliveryCount()).toBe(1);
  });

  it("signs the exact body bytes and dual-signs during rotation", async () => {
    const posts: Array<{ body: string; headers: Record<string, string> }> = [];
    vi.mocked(safePost).mockImplementation(async (_url, options) => {
      posts.push({
        body: String(options.body),
        headers: options.headers ?? {},
      });
      return {
        statusCode: 200,
        headers: {},
        body: Buffer.from("ok"),
        finalUrl: String(_url),
      };
    });

    const created = await call<{ webhook: OutgoingWebhook }>(
      owner,
      "POST",
      `/api/servers/${serverId}/outgoing-webhooks`,
      createBody(),
    );
    expect(created.status).toBe(201);
    const firstSecret = created.body.webhook.signingSecret!;

    const rotated = await call<{ webhook: OutgoingWebhook }>(
      owner,
      "POST",
      `/api/outgoing-webhooks/${created.body.webhook.id}/rotate-secret`,
    );
    expect(rotated.status).toBe(200);
    const newSecret = rotated.body.webhook.signingSecret!;

    await say(owner, channelId, "sign me");
    await waitForSafePost(1);
    expect(posts).toHaveLength(1);

    const { body, headers } = posts[0]!;
    const webhookId = headers["webhook-id"];
    const ts = headers["webhook-timestamp"];
    const sig = headers["webhook-signature"];
    expect(webhookId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(sig.split(" ")).toHaveLength(2);
    expect(verifySignatureHeader(newSecret, webhookId, ts, body, sig)).toBe(
      true,
    );
    expect(verifySignatureHeader(firstSecret, webhookId, ts, body, sig)).toBe(
      true,
    );

    const parsed = JSON.parse(body) as {
      type: string;
      body: string;
      author: { isBot: boolean };
    };
    expect(parsed.type).toBe("message.created");
    expect(parsed.body).toBe("sign me");
    expect(parsed.author.isBot).toBe(false);
  });

  it("still enqueues while the hook is failing, not when it is disabled", async () => {
    const created = await call<{ webhook: OutgoingWebhook }>(
      owner,
      "POST",
      `/api/servers/${serverId}/outgoing-webhooks`,
      createBody(),
    );
    expect(created.status).toBe(201);

    await getPool().query(
      `UPDATE outgoing_webhooks SET status = 'failing' WHERE id = $1`,
      [created.body.webhook.id],
    );
    await say(owner, channelId, "during the retry window");
    expect(await deliveryCount()).toBe(1);

    await getPool().query(
      `UPDATE outgoing_webhooks SET status = 'disabled' WHERE id = $1`,
      [created.body.webhook.id],
    );
    await say(owner, channelId, "after disable");
    expect(await deliveryCount()).toBe(1);
  });

  it("signs webhook-timestamp as send time, not the message time", async () => {
    const posts: Array<{ body: string; headers: Record<string, string> }> = [];
    vi.mocked(safePost).mockImplementation(async (_url, options) => {
      posts.push({
        body: String(options.body),
        headers: options.headers ?? {},
      });
      return {
        statusCode: 200,
        headers: {},
        body: Buffer.from("ok"),
        finalUrl: String(_url),
      };
    });

    expect(
      (await call(owner, "POST", `/api/servers/${serverId}/outgoing-webhooks`, createBody())).status,
    ).toBe(201);

    const createdAt = new Date(Date.now() - 60 * 60_000);
    const before = Math.floor(Date.now() / 1000);
    const inserted = await enqueueOutgoingMessageCreated({
      channelId,
      messageId: "00000000-0000-4000-8000-000000000099",
      authorId: owner.id,
      body: "an hour old",
      createdAt,
      replyToId: null,
    });
    expect(inserted).toBe(1);
    await waitForSafePost(1);
    const after = Math.floor(Date.now() / 1000);
    expect(posts).toHaveLength(1);

    const ts = Number(posts[0]!.headers["webhook-timestamp"]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    expect(ts).toBeGreaterThan(Math.floor(createdAt.getTime() / 1000) + 50);

    const parsed = JSON.parse(posts[0]!.body) as { timestamp: string };
    expect(Date.parse(parsed.timestamp)).toBe(createdAt.getTime());
  });

  it("does not enqueue when the body is empty", async () => {
    expect(
      (await call(owner, "POST", `/api/servers/${serverId}/outgoing-webhooks`, createBody())).status,
    ).toBe(201);
    const inserted = await enqueueOutgoingMessageCreated({
      channelId,
      messageId: "00000000-0000-4000-8000-000000000001",
      authorId: owner.id,
      body: "   ",
      createdAt: new Date(),
      replyToId: null,
    });
    expect(inserted).toBe(0);
    expect(await deliveryCount()).toBe(0);
  });

  it("paints a character online on the member list only while a hook is active", async () => {
    const minted = await createCharacterAccount({
      label: "caio-presence",
      displayName: "Caio",
    });
    const invite = await createInvite(serverId, owner.id, { maxUses: 1 });
    await redeemInvite(invite.code, minted.user.id);

    const before = await call<{
      members: Array<{ id: string; status?: string; isCharacter?: boolean }>;
    }>(owner, "GET", `/api/servers/${serverId}/members`);
    const caioBefore = before.body.members.find((m) => m.id === minted.user.id);
    expect(caioBefore?.isCharacter).toBe(true);
    expect(caioBefore?.status).toBe("offline");
    expect(
      before.body.members.find((m) => m.id === owner.id)?.status,
    ).toBe("offline");

    const created = await call<{ webhook: OutgoingWebhook }>(
      owner,
      "POST",
      `/api/servers/${serverId}/outgoing-webhooks`,
      createBody({ name: "Caio wake" }),
    );
    expect(created.status).toBe(201);

    const active = await call<{
      members: Array<{ id: string; status?: string }>;
    }>(owner, "GET", `/api/servers/${serverId}/members`);
    expect(
      active.body.members.find((m) => m.id === minted.user.id)?.status,
    ).toBe("online");
    expect(
      active.body.members.find((m) => m.id === owner.id)?.status,
    ).toBe("offline");

    await getPool().query(
      `UPDATE outgoing_webhooks SET status = 'failing' WHERE id = $1`,
      [created.body.webhook.id],
    );
    const failing = await call<{
      members: Array<{ id: string; status?: string }>;
    }>(owner, "GET", `/api/servers/${serverId}/members`);
    expect(
      failing.body.members.find((m) => m.id === minted.user.id)?.status,
    ).toBe("offline");
  });
});

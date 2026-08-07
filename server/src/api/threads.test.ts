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

/**
 * Threads, end to end over the real router and the real WS handler: start a
 * thread over HTTP, reply over the socket, watch the chip update arrive on a
 * parent-channel viewer's socket, and — the part that matters most — watch a
 * non-member get told the thread does not exist. Same harness as api.test.ts:
 * real Postgres, real services, only the identity layer stubbed.
 */

// TEST_DATABASE_URL wins — see the note in api.test.ts.
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
const { clearChannelAudienceCache } = await import("../services/servers.js");
const { handleChatMessage, resetChatRateLimits } = await import(
  "../ws/chat.js"
);
type DbUser = Awaited<ReturnType<typeof upsertUser>>;

let server: Server;
let baseUrl: string;

async function call<T = Record<string, unknown>>(
  as: { id: string; clerk_id: string } | null,
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

function recordingSocket(): { socket: WebSocket; received: string[] } {
  const received: string[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => received.push(payload),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, received };
}

describeDb("threads over HTTP and WS", () => {
  let owner: DbUser;
  let member: DbUser;
  let outsider: DbUser;
  let serverId: string;
  let textChannelId: string;

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
    resetApiRateLimits();
    resetChatRateLimits();
    clearChannelAudienceCache();
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);

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
    outsider = await upsertUser({
      clerkId: "clerk_outsider",
      displayName: "Outsider",
      avatarUrl: null,
    });

    const created = await call<{
      server: { id: string };
      channels: Array<{ id: string; type: string }>;
    }>(owner, "POST", "/api/servers", { name: "Threads e2e" });
    serverId = created.body.server.id;
    textChannelId = created.body.channels.find((c) => c.type === "text")!.id;

    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, member.id],
    );
  });

  async function postOrigin(body = "origin"): Promise<string> {
    const result = await getPool().query<{ id: string }>(
      `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, $3)
       RETURNING id`,
      [textChannelId, owner.id, body],
    );
    return result.rows[0]!.id;
  }

  it("start → reply over WS → chip count updates on a parent viewer → non-member cannot fetch", async () => {
    const originId = await postOrigin("ship it");

    // A third party watching the PARENT channel — the person whose chip must
    // move without their unread badge moving.
    const viewer = recordingSocket();
    await handleChatMessage(
      { socket: viewer.socket, user: owner },
      { type: "join-channel", channelId: textChannelId },
    );

    // Start the thread over HTTP, as a plain member.
    const started = await call<{ thread: { channelId: string; replyCount: number } }>(
      member,
      "POST",
      `/api/messages/${originId}/threads`,
    );
    expect(started.status).toBe(201);
    const threadId = started.body.thread.channelId;
    expect(started.body.thread.replyCount).toBe(0);

    // Starting it again returns the same thread rather than a second one.
    const again = await call<{ thread: { channelId: string } }>(
      member,
      "POST",
      `/api/messages/${originId}/threads`,
    );
    expect(again.status).toBe(200);
    expect(again.body.thread.channelId).toBe(threadId);

    // Reply inside the thread over the real WS handler.
    const sender = recordingSocket();
    await handleChatMessage(
      { socket: sender.socket, user: member },
      { type: "message-create", channelId: threadId, body: "first reply" },
    );

    // The parent viewer's socket got the chip refresh — created, then reply.
    const updates = viewer.received
      .map((raw) => JSON.parse(raw) as { type: string; thread?: { replyCount: number } })
      .filter((frame) => frame.type === "thread-update");
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates.at(-1)!.thread!.replyCount).toBe(1);
    // And no message content ever rode a parent-channel frame.
    expect(
      viewer.received.some((raw) => raw.includes("first reply")),
    ).toBe(false);

    // History of the thread reads back for a member…
    const history = await call<{ messages: Array<{ body: string }> }>(
      member,
      "GET",
      `/api/channels/${threadId}/messages`,
    );
    expect(history.status).toBe(200);
    expect(history.body.messages.map((m) => m.body)).toEqual(["first reply"]);

    // …and the origin message now carries the chip.
    const parentHistory = await call<{
      messages: Array<{ id: string; thread: { channelId: string; replyCount: number } | null }>;
    }>(member, "GET", `/api/channels/${textChannelId}/messages`);
    const origin = parentHistory.body.messages.find((m) => m.id === originId);
    expect(origin?.thread?.channelId).toBe(threadId);
    expect(origin?.thread?.replyCount).toBe(1);

    // A non-member is told the thread does not exist — 404, not 403, so the
    // id cannot even be confirmed.
    const denied = await call(outsider, "GET", `/api/channels/${threadId}/messages`);
    expect(denied.status).toBe(404);
    const deniedStart = await call(
      outsider,
      "POST",
      `/api/messages/${originId}/threads`,
    );
    expect(deniedStart.status).toBe(404);
  });

  it("fails closed over HTTP for a thread under a private channel", async () => {
    const privateChannel = await call<{ channel: { id: string } }>(
      owner,
      "POST",
      `/api/servers/${serverId}/channels`,
      { name: "secret", type: "text", isPrivate: true },
    );
    const privateChannelId = privateChannel.body.channel.id;
    const originResult = await getPool().query<{ id: string }>(
      `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'hidden')
       RETURNING id`,
      [privateChannelId, owner.id],
    );
    const originId = originResult.rows[0]!.id;

    const started = await call<{ thread: { channelId: string } }>(
      owner,
      "POST",
      `/api/messages/${originId}/threads`,
    );
    expect(started.status).toBe(201);
    const threadId = started.body.thread.channelId;

    // A plain member is not on the private channel's list: its thread answers
    // 404 for reads, sends nothing over WS, and refuses a read cursor.
    for (const path of [
      `/api/channels/${threadId}/messages`,
      `/api/channels/${threadId}/pins`,
    ]) {
      const denied = await call(member, "GET", path);
      expect(denied.status).toBe(404);
    }
    const deniedRead = await call(member, "POST", `/api/channels/${threadId}/read`);
    expect(deniedRead.status).toBe(404);

    // The WS side drops a send into the invisible thread on the same predicate.
    const sender = recordingSocket();
    await handleChatMessage(
      { socket: sender.socket, user: member },
      { type: "message-create", channelId: threadId, body: "should not land" },
    );
    const count = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages WHERE channel_id = $1`,
      [threadId],
    );
    expect(count.rows[0]!.count).toBe("0");
  });

  it("refuses to start a thread anywhere but a server text channel message", async () => {
    const originId = await postOrigin();
    const started = await call<{ thread: { channelId: string } }>(
      owner,
      "POST",
      `/api/messages/${originId}/threads`,
    );
    const threadId = started.body.thread.channelId;

    // A message inside the thread cannot host another one.
    const reply = await getPool().query<{ id: string }>(
      `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'reply')
       RETURNING id`,
      [threadId, owner.id],
    );
    const nested = await call(
      owner,
      "POST",
      `/api/messages/${reply.rows[0]!.id}/threads`,
    );
    expect(nested.status).toBe(400);
  });

  it("keeps threads out of the sidebar channel list", async () => {
    const originId = await postOrigin();
    const started = await call<{ thread: { channelId: string } }>(
      owner,
      "POST",
      `/api/messages/${originId}/threads`,
    );

    const channels = await call<{ channels: Array<{ id: string }> }>(
      member,
      "GET",
      `/api/servers/${serverId}/channels`,
    );
    expect(channels.body.channels.map((c) => c.id)).not.toContain(
      started.body.thread.channelId,
    );
  });
});

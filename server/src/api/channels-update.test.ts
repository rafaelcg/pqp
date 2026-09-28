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
 * A channel created, renamed, moved or deleted reaches the other members'
 * sidebars live, as a `channels-update` frame on their sockets. Before this
 * frame existed none of the four routes sent anything, and a member saw a new
 * channel only after a reload.
 *
 * Driven through the real router against a real Postgres, the same posture as
 * `read-cache.test.ts`. The sockets are recorders registered straight into
 * the authenticated socket table, which is all the member-addressed fan-out
 * reads. The frame names no channel, so the privacy half of the contract is
 * the refetch: a member who cannot see a private channel is nudged like
 * everyone else and still does not get it back from the list.
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
const { setAuthenticatedSocket, deleteAuthenticatedSocket } = await import(
  "../ws/sockets.js"
);
const { resetReadCacheForTests } = await import("../lib/read-cache.js");

type User = Awaited<ReturnType<typeof upsertUser>>;

interface Recorder {
  socket: WebSocket;
  received: string[];
}

let server: Server;
let baseUrl: string;
const open: Recorder[] = [];

async function call<T = Record<string, unknown>>(
  as: User,
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

function connect(user: User): Recorder {
  const received: string[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => received.push(payload),
    on: () => {},
  } as unknown as WebSocket;
  setAuthenticatedSocket(socket, user);
  const recorder = { socket, received };
  open.push(recorder);
  return recorder;
}

function framesOfType(recorder: Recorder, type: string): unknown[] {
  return recorder.received
    .map((raw) => JSON.parse(raw) as { type: string })
    .filter((frame) => frame.type === type);
}

/** The notify is fire-and-forget after the response, so wait for it. */
async function expectNudged(recorder: Recorder, serverId: string) {
  await vi.waitFor(() => {
    expect(framesOfType(recorder, "channels-update")).toEqual([
      { type: "channels-update", serverId },
    ]);
  });
}

async function channelNames(as: User, serverId: string): Promise<string[]> {
  const res = await call<{ channels: Array<{ name: string }> }>(
    as,
    "GET",
    `/api/servers/${serverId}/channels`,
  );
  expect(res.status).toBe(200);
  return res.body.channels.map((channel) => channel.name);
}

describeDb("channels-update: channel list changes reach members live", () => {
  let owner: User;
  let member: User;
  let outsider: User;
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
    resetReadCacheForTests();
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, roles, member_roles,
                server_invites, server_bans, channel_reads
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
    outsider = await upsertUser({
      clerkId: "clerk_outsider",
      displayName: "Outsider",
      avatarUrl: null,
    });
    const created = await call<{
      server: { id: string };
      channels: Array<{ id: string; type: string }>;
    }>(owner, "POST", "/api/servers", { name: "Test server" });
    expect(created.status).toBe(201);
    serverId = created.body.server.id;
    textChannelId = created.body.channels.find((c) => c.type === "text")!.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, member.id],
    );
  });

  afterEach(() => {
    for (const recorder of open) {
      deleteAuthenticatedSocket(recorder.socket);
    }
    open.length = 0;
  });

  it("nudges members, and nobody else, when a channel is created", async () => {
    const memberSocket = connect(member);
    const outsiderSocket = connect(outsider);

    const res = await call(owner, "POST", `/api/servers/${serverId}/channels`, {
      name: "avisos",
      type: "text",
    });
    expect(res.status).toBe(201);

    await expectNudged(memberSocket, serverId);
    expect(outsiderSocket.received).toEqual([]);
    expect(await channelNames(member, serverId)).toContain("avisos");
  });

  it("nudges on a private channel too, and the refetch still hides it", async () => {
    const memberSocket = connect(member);

    const res = await call(owner, "POST", `/api/servers/${serverId}/channels`, {
      name: "staff",
      type: "text",
      isPrivate: true,
    });
    expect(res.status).toBe(201);

    await expectNudged(memberSocket, serverId);
    // Content-free on the wire, filtered on the refetch.
    expect(memberSocket.received.join("")).not.toContain("staff");
    expect(await channelNames(member, serverId)).not.toContain("staff");
    expect(await channelNames(owner, serverId)).toContain("staff");
  });

  it("nudges when a channel is renamed", async () => {
    const memberSocket = connect(member);

    const res = await call(owner, "PATCH", `/api/channels/${textChannelId}`, {
      name: "geral",
    });
    expect(res.status).toBe(200);

    await expectNudged(memberSocket, serverId);
    expect(await channelNames(member, serverId)).toContain("geral");
  });

  it("leaves a privacy flip to permissions-update, which already refetches", async () => {
    const memberSocket = connect(member);

    const res = await call(owner, "PATCH", `/api/channels/${textChannelId}`, {
      isPrivate: true,
    });
    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(framesOfType(memberSocket, "permissions-update")).toHaveLength(1);
    });
    expect(framesOfType(memberSocket, "channels-update")).toEqual([]);
  });

  it("nudges when a channel is deleted", async () => {
    const memberSocket = connect(member);
    const extra = await call<{ channel: { id: string } }>(
      owner,
      "POST",
      `/api/servers/${serverId}/channels`,
      { name: "temporario", type: "text" },
    );
    // The create's own nudge lands after its response; let it, then start
    // counting.
    await expectNudged(memberSocket, serverId);
    memberSocket.received.length = 0;

    const res = await call(owner, "DELETE", `/api/channels/${extra.body.channel.id}`);
    expect(res.status).toBe(200);

    await expectNudged(memberSocket, serverId);
    expect(await channelNames(member, serverId)).not.toContain("temporario");
  });

  it("nudges when a channel is moved", async () => {
    const memberSocket = connect(member);

    const res = await call(owner, "PATCH", `/api/channels/${textChannelId}/move`, {
      parentId: null,
      index: 1,
    });
    expect(res.status).toBe(200);

    await expectNudged(memberSocket, serverId);
  });
});

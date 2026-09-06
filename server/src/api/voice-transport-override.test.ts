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
 * The per-channel voice transport override: the column, who may set it, that
 * explicit null returns a channel to automatic, and that the value is refused
 * when it is not one of the two transports. What the override *does* to a room
 * is proved in ws/voice-transport.test.ts; this is the settings surface only.
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

let server: Server;
let baseUrl: string;

type ChannelBody = { id: string; type: string; voiceTransport: string | null };

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
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
  };
}

describeDb("voice transport override", () => {
  let owner: { id: string; clerk_id: string };
  let member: { id: string; clerk_id: string };

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
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, server_invites, server_bans,
                channel_reads, message_mentions, message_reactions,
                message_attachments, user_blocks, dm_pairs, link_embeds
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
      channels: ChannelBody[];
    }>(owner, "POST", "/api/servers", { name: "Stream" });
    expect(created.status).toBe(201);
    const serverId = created.body.server.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, member.id],
    );
    const voiceChannel = created.body.channels.find((c) => c.type === "voice")!;
    return { serverId, voiceChannelId: voiceChannel.id, created };
  }

  it("defaults a new channel to automatic", async () => {
    const { voiceChannelId, created } = await makeServer();
    expect(
      created.body.channels.find((c) => c.id === voiceChannelId)?.voiceTransport,
    ).toBeNull();
  });

  it("lets MANAGE_CHANNELS force a transport, refuses a plain member, and null goes back to automatic", async () => {
    const { serverId, voiceChannelId } = await makeServer();

    expect(
      (
        await call(member, "PATCH", `/api/channels/${voiceChannelId}`, {
          voiceTransport: "livekit",
        })
      ).status,
    ).toBe(403);

    const forced = await call<{ channel: ChannelBody }>(
      owner,
      "PATCH",
      `/api/channels/${voiceChannelId}`,
      { voiceTransport: "livekit" },
    );
    expect(forced.status).toBe(200);
    expect(forced.body.channel.voiceTransport).toBe("livekit");

    // Everyone in the server reads the same value back.
    const listed = await call<{ channels: ChannelBody[] }>(
      member,
      "GET",
      `/api/servers/${serverId}/channels`,
    );
    expect(
      listed.body.channels.find((c) => c.id === voiceChannelId)?.voiceTransport,
    ).toBe("livekit");

    // Absent means "not changing"...
    const untouched = await call<{ channel: ChannelBody }>(
      owner,
      "PATCH",
      `/api/channels/${voiceChannelId}`,
      { topic: "late night" },
    );
    expect(untouched.body.channel.voiceTransport).toBe("livekit");

    // ...and explicit null is the way back to automatic.
    const automatic = await call<{ channel: ChannelBody }>(
      owner,
      "PATCH",
      `/api/channels/${voiceChannelId}`,
      { voiceTransport: null },
    );
    expect(automatic.status).toBe(200);
    expect(automatic.body.channel.voiceTransport).toBeNull();
  });

  it("refuses a transport that is not one of the two", async () => {
    const { voiceChannelId } = await makeServer();
    const refused = await call(owner, "PATCH", `/api/channels/${voiceChannelId}`, {
      voiceTransport: "cloudflare-sfu",
    });
    expect(refused.status).toBe(400);
  });
});

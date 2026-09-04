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
 * Slow mode: the column, who may set it, and that a moderator cargo
 * (MANAGE_MESSAGES) is not enough to change the interval.
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

describeDb("slow mode", () => {
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
      channels: Array<{ id: string; type: string; slowmodeSeconds: number }>;
    }>(owner, "POST", "/api/servers", { name: "Slow" });
    expect(created.status).toBe(201);
    const serverId = created.body.server.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, member.id],
    );
    const textChannel = created.body.channels.find((c) => c.type === "text")!;
    return { serverId, textChannelId: textChannel.id, created };
  }

  async function roleId(serverId: string, systemKey: string): Promise<string> {
    const listed = await call<{
      roles: Array<{ id: string; systemKey: string | null }>;
    }>(owner, "GET", `/api/servers/${serverId}/roles`);
    const row = listed.body.roles.find((role) => role.systemKey === systemKey);
    expect(row).toBeDefined();
    return row!.id;
  }

  it("defaults a new channel to off and refuses a wait over 6 hours", async () => {
    const { textChannelId, created } = await makeServer();
    const seeded = created.body.channels.find((c) => c.id === textChannelId);
    expect(seeded?.slowmodeSeconds).toBe(0);

    const row = await getPool().query<{ slowmode_seconds: number }>(
      `SELECT slowmode_seconds FROM channels WHERE id = $1`,
      [textChannelId],
    );
    expect(row.rows[0]?.slowmode_seconds).toBe(0);

    await expect(
      getPool().query(
        `UPDATE channels SET slowmode_seconds = 21601 WHERE id = $1`,
        [textChannelId],
      ),
    ).rejects.toThrow();

    await getPool().query(
      `UPDATE channels SET slowmode_seconds = 21600 WHERE id = $1`,
      [textChannelId],
    );
    const max = await getPool().query<{ slowmode_seconds: number }>(
      `SELECT slowmode_seconds FROM channels WHERE id = $1`,
      [textChannelId],
    );
    expect(max.rows[0]?.slowmode_seconds).toBe(21600);
  });

  it("lets MANAGE_CHANNELS set the interval and refuses a plain member", async () => {
    const { serverId, textChannelId } = await makeServer();

    expect(
      (
        await call(member, "PATCH", `/api/channels/${textChannelId}`, {
          slowmodeSeconds: 5,
        })
      ).status,
    ).toBe(403);

    const updated = await call<{ channel: { slowmodeSeconds: number } }>(
      owner,
      "PATCH",
      `/api/channels/${textChannelId}`,
      { slowmodeSeconds: 5 },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.channel.slowmodeSeconds).toBe(5);

    const listed = await call<{
      channels: Array<{ id: string; slowmodeSeconds: number }>;
    }>(member, "GET", `/api/servers/${serverId}/channels`);
    expect(listed.status).toBe(200);
    expect(
      listed.body.channels.find((channel) => channel.id === textChannelId)
        ?.slowmodeSeconds,
    ).toBe(5);
  });

  it("does not let MANAGE_MESSAGES set slow mode", async () => {
    const { serverId, textChannelId } = await makeServer();
    const moderatorId = await roleId(serverId, "moderator");
    expect(
      (
        await call(
          owner,
          "PUT",
          `/api/servers/${serverId}/members/${member.id}/roles/${moderatorId}`,
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await call(member, "PATCH", `/api/channels/${textChannelId}`, {
          slowmodeSeconds: 30,
        })
      ).status,
    ).toBe(403);
  });
});

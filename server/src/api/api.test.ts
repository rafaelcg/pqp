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
import { parseSearchSnippet, Permission, serializePermissions } from "@pqp/shared";
import type { DbUser } from "../db.js";

/**
 * The authorization matrix is the highest-risk untested surface in the app: a
 * missing membership check silently exposes another server's private channel.
 * These tests drive the real router, services and SQL against a real Postgres,
 * with only the identity layer stubbed.
 */

// TEST_DATABASE_URL wins. These tests truncate the tables they touch, and the
// other order made the opt-out unreachable: a developer always has
// DATABASE_URL set, so it always won and `pnpm test` silently ate the dev
// database. CI sets only DATABASE_URL and is unaffected.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

/** The identity the next request will authenticate as. */
let actor: { id: string; clerk_id: string } | null = null;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  // Every actor in this suite is an adult who already answered the age
  // gate — the gate itself is proved end-to-end against a real database in
  // api/age-gate.test.ts, which does not stub this module.
  resolveAuthSession: async () =>
    actor ? { user: actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

// The real function drives an actual outbound HTTP request through the
// SSRF-guarded path proved correct in lib/safe-fetch.test.ts; faking it here
// keeps the embed-related tests below off the real network entirely, the
// same way s3.js is faked in attachments.test.ts.
vi.mock("../lib/safe-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/safe-fetch.js")>();
  return { ...actual, safeFetch: vi.fn() };
});

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { safeFetch } = await import("../lib/safe-fetch.js");
const { upsertUser } = await import("../services/users.js");
const { memberHasPermission } = await import("../services/permissions.js");
const { getChannelAudience } = await import("../services/servers.js");
const { handleChatMessage, resetChatRateLimits } = await import(
  "../ws/chat.js"
);
const {
  handleVoiceMessage,
  isSocketInVoice,
  removeVoicePeerBySocket,
  resetVoiceRateLimits,
} = await import("../ws/voice.js");

let server: Server;
let baseUrl: string;

interface ApiResult<T = unknown> {
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
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
  };
}

describeDb("API authorization", () => {
  let owner: { id: string; clerk_id: string };
  let admin: { id: string; clerk_id: string };
  let member: { id: string; clerk_id: string };
  let outsider: { id: string; clerk_id: string };

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
    resetVoiceRateLimits();
    // servers/messages cascade; users are the only root we must clear.
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, server_invites, server_bans,
                channel_reads, message_mentions, message_reactions,
                message_attachments, user_blocks, dm_pairs, link_embeds
       RESTART IDENTITY CASCADE`,
    );
    vi.mocked(safeFetch).mockReset();

    owner = await upsertUser({
      clerkId: "clerk_owner",
      displayName: "Owner",
      avatarUrl: null,
    });
    admin = await upsertUser({
      clerkId: "clerk_admin",
      displayName: "Admin",
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
  });

  /** The chat handler only ever touches these three members of a socket. */
  function fakeSocket(): WebSocket {
    return {
      readyState: 1,
      send: () => {},
      on: () => {},
    } as unknown as WebSocket;
  }

  /**
   * A socket that keeps what was fanned out to it, so a test can assert on what
   * a *third party* received rather than on what the sender's own call returned.
   * Eviction is only observable this way: the membership row and the socket's
   * live view are two separate pieces of state, and a leak in the second one
   * looks entirely correct from every HTTP response.
   */
  function recordingSocket(): { socket: WebSocket; received: string[] } {
    const received: string[] = [];
    const socket = {
      readyState: 1,
      send: (payload: string) => received.push(payload),
      on: () => {},
    } as unknown as WebSocket;
    return { socket, received };
  }

  function typesOf(received: string[]): string[] {
    return received.map((raw) => (JSON.parse(raw) as { type: string }).type);
  }

  async function asDbUser(id: string): Promise<DbUser> {
    const result = await getPool().query<DbUser>(
      `SELECT * FROM users WHERE id = $1`,
      [id],
    );
    return result.rows[0]!;
  }

  async function makeServer() {
    const created = await call<{
      server: { id: string };
      channels: Array<{ id: string; type: string }>;
    }>(owner, "POST", "/api/servers", { name: "Test server" });
    expect(created.status).toBe(201);

    const serverId = created.body.server.id;
    const textChannel = created.body.channels.find((c) => c.type === "text")!;

    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [serverId, admin.id],
    );
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, member.id],
    );

    return { serverId, textChannelId: textChannel.id };
  }

  it("rejects unauthenticated requests", async () => {
    const res = await call(null, "GET", "/api/servers");
    expect(res.status).toBe(401);
  });

  it("only lists servers the caller belongs to", async () => {
    const { serverId } = await makeServer();

    const mine = await call<{ servers: Array<{ id: string }> }>(
      member,
      "GET",
      "/api/servers",
    );
    expect(mine.body.servers.map((s) => s.id)).toContain(serverId);

    const theirs = await call<{ servers: unknown[] }>(
      outsider,
      "GET",
      "/api/servers",
    );
    expect(theirs.body.servers).toHaveLength(0);
  });

  it("hides a server's channels from non-members", async () => {
    const { serverId } = await makeServer();
    const res = await call(outsider, "GET", `/api/servers/${serverId}/channels`);
    expect(res.status).toBe(404);
  });

  it("hides message history from non-members", async () => {
    const { textChannelId } = await makeServer();
    const res = await call(
      outsider,
      "GET",
      `/api/channels/${textChannelId}/messages`,
    );
    expect(res.status).toBe(404);
  });

  it("stops plain members from creating channels", async () => {
    const { serverId } = await makeServer();

    const asMember = await call(member, "POST", `/api/servers/${serverId}/channels`, {
      name: "nope",
      type: "text",
    });
    expect(asMember.status).toBe(403);

    const asAdmin = await call(admin, "POST", `/api/servers/${serverId}/channels`, {
      name: "yes",
      type: "text",
    });
    expect(asAdmin.status).toBe(201);
  });

  it("keeps private channels out of a plain member's channel list and history", async () => {
    const { serverId } = await makeServer();

    const created = await call<{ channel: { id: string } }>(
      owner,
      "POST",
      `/api/servers/${serverId}/channels`,
      { name: "secret", type: "text", isPrivate: true },
    );
    expect(created.status).toBe(201);
    const privateId = created.body.channel.id;

    const memberChannels = await call<{ channels: Array<{ id: string }> }>(
      member,
      "GET",
      `/api/servers/${serverId}/channels`,
    );
    expect(memberChannels.body.channels.map((c) => c.id)).not.toContain(privateId);

    const history = await call(
      member,
      "GET",
      `/api/channels/${privateId}/messages`,
    );
    expect(history.status).toBe(404);

    // Admins see every channel in their server by design.
    const adminChannels = await call<{ channels: Array<{ id: string }> }>(
      admin,
      "GET",
      `/api/servers/${serverId}/channels`,
    );
    expect(adminChannels.body.channels.map((c) => c.id)).toContain(privateId);

    // Granting access opens it up.
    const granted = await call(owner, "POST", `/api/channels/${privateId}/members`, {
      userId: member.id,
    });
    expect(granted.status).toBe(201);

    const after = await call(member, "GET", `/api/channels/${privateId}/messages`);
    expect(after.status).toBe(200);
  });

  it("keeps owner and admin access when a public channel is made private", async () => {
    const { serverId, textChannelId } = await makeServer();

    expect(
      (
        await call(owner, "PATCH", `/api/channels/${textChannelId}`, {
          isPrivate: true,
        })
      ).status,
    ).toBe(200);

    // Owners and admins see every channel in their server, with or without a
    // channel_members row — the eviction path must use the same rule.
    expect(
      (await call(owner, "GET", `/api/channels/${textChannelId}/messages`))
        .status,
    ).toBe(200);
    expect(
      (await call(admin, "GET", `/api/channels/${textChannelId}/messages`))
        .status,
    ).toBe(200);
    expect(
      (await call(member, "GET", `/api/channels/${textChannelId}/messages`))
        .status,
    ).toBe(404);

    const visible = await call<{ channels: Array<{ id: string }> }>(
      member,
      "GET",
      `/api/servers/${serverId}/channels`,
    );
    expect(visible.body.channels.map((c) => c.id)).not.toContain(textChannelId);
  });

  it("only lets the owner change roles", async () => {
    const { serverId } = await makeServer();

    const byAdmin = await call(
      admin,
      "PATCH",
      `/api/servers/${serverId}/members/${member.id}`,
      { role: "admin" },
    );
    expect(byAdmin.status).toBe(403);

    const byOwner = await call(
      owner,
      "PATCH",
      `/api/servers/${serverId}/members/${member.id}`,
      { role: "admin" },
    );
    expect(byOwner.status).toBe(200);
  });

  it("lets an admin rename the server but only the owner delete it", async () => {
    const { serverId } = await makeServer();

    expect(
      (await call(admin, "PATCH", `/api/servers/${serverId}`, { name: "x" })).status,
    ).toBe(200);
    expect((await call(admin, "DELETE", `/api/servers/${serverId}`)).status).toBe(
      403,
    );
    expect(
      (await call(member, "PATCH", `/api/servers/${serverId}`, { name: "nope" }))
        .status,
    ).toBe(403);
    expect(
      (await call(owner, "PATCH", `/api/servers/${serverId}`, { name: "Renamed" }))
        .status,
    ).toBe(200);
    expect((await call(owner, "DELETE", `/api/servers/${serverId}`)).status).toBe(
      200,
    );
  });

  it("refuses to let the owner leave and abandon the server", async () => {
    const { serverId } = await makeServer();
    const res = await call(owner, "POST", `/api/servers/${serverId}/leave`);
    expect(res.status).toBe(400);
  });

  describe("moderation", () => {
    it("lets an admin kick a member but not another admin or the owner", async () => {
      const { serverId } = await makeServer();

      expect(
        (
          await call(admin, "DELETE", `/api/servers/${serverId}/members/${owner.id}`, {
            ban: false,
          })
        ).status,
      ).toBe(403);

      const secondAdmin = await upsertUser({
        clerkId: "clerk_admin2",
        displayName: "Admin Two",
        avatarUrl: null,
      });
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'admin')`,
        [serverId, secondAdmin.id],
      );
      expect(
        (
          await call(
            admin,
            "DELETE",
            `/api/servers/${serverId}/members/${secondAdmin.id}`,
            { ban: false },
          )
        ).status,
      ).toBe(403);

      expect(
        (
          await call(admin, "DELETE", `/api/servers/${serverId}/members/${member.id}`, {
            ban: false,
          })
        ).status,
      ).toBe(200);
    });

    it("stops a banned user from rejoining with an invite", async () => {
      const { serverId } = await makeServer();

      const invite = await call<{ invite: { code: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/invites`,
        {},
      );
      const code = invite.body.invite.code;

      expect(
        (
          await call(owner, "DELETE", `/api/servers/${serverId}/members/${member.id}`, {
            ban: true,
          })
        ).status,
      ).toBe(200);

      const rejoin = await call(member, "POST", `/api/invites/${code}/join`);
      expect(rejoin.status).toBe(400);

      // A different user can still use the same invite.
      expect((await call(outsider, "POST", `/api/invites/${code}/join`)).status).toBe(
        200,
      );
    });
  });

  describe("invites", () => {
    it("does not burn a use when an existing member re-opens the link", async () => {
      const { serverId } = await makeServer();

      const created = await call<{ invite: { code: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/invites`,
        { maxUses: 1 },
      );
      const code = created.body.invite.code;

      // Already a member: joining is a no-op and must not consume the single use.
      expect((await call(member, "POST", `/api/invites/${code}/join`)).status).toBe(
        200,
      );
      expect((await call(outsider, "POST", `/api/invites/${code}/join`)).status).toBe(
        200,
      );

      const third = await upsertUser({
        clerkId: "clerk_third",
        displayName: "Third",
        avatarUrl: null,
      });
      const exhausted = await call(third, "POST", `/api/invites/${code}/join`);
      expect(exhausted.status).toBe(400);
    });

    it("lets members create invites but not list them", async () => {
      const { serverId } = await makeServer();
      expect(
        (await call(member, "POST", `/api/servers/${serverId}/invites`, {})).status,
      ).toBe(201);
      expect(
        (await call(member, "GET", `/api/servers/${serverId}/invites`)).status,
      ).toBe(403);
    });
  });

  describe("permissions and nicknames", () => {
    it("seeds @everyone, Moderator, Manager, Admin and Owner, and lets a member read the snapshot", async () => {
      const { serverId } = await makeServer();
      const roles = await call<{
        roles: Array<{ name: string; isEveryone: boolean; systemKey: string | null }>;
      }>(member, "GET", `/api/servers/${serverId}/roles`);
      expect(roles.status).toBe(200);
      const keys = new Set(roles.body.roles.map((role) => role.systemKey));
      expect(keys.has("everyone")).toBe(true);
      expect(keys.has("moderator")).toBe(true);
      expect(keys.has("manager")).toBe(true);
      expect(keys.has("admin")).toBe(true);
      expect(keys.has("owner")).toBe(true);

      const snap = await call<{ server: string; version: number }>(
        member,
        "GET",
        `/api/servers/${serverId}/permissions`,
      );
      expect(snap.status).toBe(200);
      expect(snap.body.server).toMatch(/^\d+$/);

      expect(
        (
          await call(member, "POST", `/api/servers/${serverId}/roles`, {
            name: "mods",
          })
        ).status,
      ).toBe(403);
    });

    it("lets a member set their own nickname", async () => {
      const { serverId } = await makeServer();
      const res = await call(
        member,
        "PATCH",
        `/api/servers/${serverId}/members/${member.id}`,
        { nickname: "apelido" },
      );
      expect(res.status).toBe(200);
      const list = await call<{
        members: Array<{ id: string; nickname: string | null }>;
      }>(owner, "GET", `/api/servers/${serverId}/members`);
      const row = list.body.members.find((one) => one.id === member.id);
      expect(row?.nickname).toBe("apelido");
    });

    it("strips kick, ban, timeout and Administrator from @everyone", async () => {
      const { serverId } = await makeServer();
      const listed = await call<{
        roles: Array<{
          id: string;
          isEveryone: boolean;
          permissions: string;
        }>;
      }>(owner, "GET", `/api/servers/${serverId}/roles`);
      const everyone = listed.body.roles.find((role) => role.isEveryone)!
      const dirty = serializePermissions(
        BigInt(everyone.permissions) |
          Permission.KICK_MEMBERS |
          Permission.BAN_MEMBERS |
          Permission.MODERATE_MEMBERS |
          Permission.ADMINISTRATOR,
      );
      const saved = await call<{ role: { permissions: string } }>(
        owner,
        "PATCH",
        `/api/roles/${everyone.id}`,
        { permissions: dirty },
      );
      expect(saved.status).toBe(200);
      const bits = BigInt(saved.body.role.permissions);
      expect(bits & Permission.KICK_MEMBERS).toBe(0n);
      expect(bits & Permission.BAN_MEMBERS).toBe(0n);
      expect(bits & Permission.MODERATE_MEMBERS).toBe(0n);
      expect(bits & Permission.ADMINISTRATOR).toBe(0n);
    });

    it("inserts a new role just above @everyone and lets the owner reorder", async () => {
      const { serverId } = await makeServer();
      const created = await call<{
        role: { id: string; position: number };
      }>(owner, "POST", `/api/servers/${serverId}/roles`, { name: "mods" });
      expect(created.status).toBe(201);
      expect(created.body.role.position).toBe(1);

      const afterCreate = await call<{
        roles: Array<{
          id: string;
          name: string;
          position: number;
          isEveryone: boolean;
          systemKey: string | null;
        }>;
      }>(owner, "GET", `/api/servers/${serverId}/roles`);
      const everyone = afterCreate.body.roles.find((role) => role.isEveryone)!;
      const adminRole = afterCreate.body.roles.find(
        (role) => role.systemKey === "admin",
      )!;
      const mods = afterCreate.body.roles.find((role) => role.name === "mods")!;
      expect(everyone.position).toBe(0);
      expect(mods.position).toBe(1);
      expect(adminRole.position).toBeGreaterThan(mods.position);

      const movable = afterCreate.body.roles
        .filter((role) => !role.isEveryone)
        .sort((left, right) => left.position - right.position);
      const roleIds = movable.map((role) => role.id);
      const swapped = [roleIds[1]!, roleIds[0]!, ...roleIds.slice(2)];
      const reordered = await call(
        owner,
        "PATCH",
        `/api/servers/${serverId}/roles/order`,
        { roleIds: swapped },
      );
      expect(reordered.status).toBe(200);
      const afterOrder = await call<{
        roles: Array<{ id: string; position: number }>;
      }>(owner, "GET", `/api/servers/${serverId}/roles`);
      const byId = Object.fromEntries(
        afterOrder.body.roles.map((role) => [role.id, role.position]),
      );
      expect(byId[everyone.id]).toBe(0);
      expect(byId[swapped[0]!]).toBe(1);
      expect(byId[swapped[1]!]).toBe(2);
    });

    it("refuses to strip a role from a member the actor does not outrank", async () => {
      const { serverId } = await makeServer();
      const created = await call<{ role: { id: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/roles`,
        {
          name: "mods",
          permissions: serializePermissions(
            Permission.MANAGE_ROLES |
              Permission.VIEW_CHANNEL |
              Permission.SEND_MESSAGES,
          ),
        },
      );
      expect(created.status).toBe(201);
      const colour = await call<{ role: { id: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/roles`,
        { name: "colour" },
      );
      expect(colour.status).toBe(201);

      expect(
        (
          await call(
            owner,
            "PUT",
            `/api/servers/${serverId}/members/${member.id}/roles/${created.body.role.id}`,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await call(
            owner,
            "PUT",
            `/api/servers/${serverId}/members/${admin.id}/roles/${colour.body.role.id}`,
          )
        ).status,
      ).toBe(200);

      const stripped = await call(
        member,
        "DELETE",
        `/api/servers/${serverId}/members/${admin.id}/roles/${colour.body.role.id}`,
      );
      expect(stripped.status).toBe(403);

      const byOwner = await call(
        owner,
        "DELETE",
        `/api/servers/${serverId}/members/${admin.id}/roles/${colour.body.role.id}`,
      );
      expect(byOwner.status).toBe(200);
    });

    it("drops role grants on kick so they do not return on rejoin", async () => {
      const { serverId } = await makeServer();
      const colour = await call<{ role: { id: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/roles`,
        { name: "colour" },
      );
      expect(colour.status).toBe(201);
      expect(
        (
          await call(
            owner,
            "PUT",
            `/api/servers/${serverId}/members/${member.id}/roles/${colour.body.role.id}`,
          )
        ).status,
      ).toBe(200);

      expect(
        (
          await call(owner, "DELETE", `/api/servers/${serverId}/members/${member.id}`, {
            ban: false,
          })
        ).status,
      ).toBe(200);

      const leftover = await getPool().query(
        `SELECT 1 FROM member_roles WHERE server_id = $1 AND user_id = $2`,
        [serverId, member.id],
      );
      expect(leftover.rowCount).toBe(0);

      const invite = await call<{ invite: { code: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/invites`,
        {},
      );
      expect(
        (await call(member, "POST", `/api/invites/${invite.body.invite.code}/join`))
          .status,
      ).toBe(200);

      const restored = await getPool().query(
        `SELECT 1 FROM member_roles WHERE server_id = $1 AND user_id = $2`,
        [serverId, member.id],
      );
      expect(restored.rowCount).toBe(0);
    });

    it("refuses to grant a role to someone who is not in the server", async () => {
      const { serverId } = await makeServer();
      const colour = await call<{ role: { id: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/roles`,
        { name: "colour" },
      );
      expect(colour.status).toBe(201);
      const granted = await call(
        owner,
        "PUT",
        `/api/servers/${serverId}/members/${outsider.id}/roles/${colour.body.role.id}`,
      );
      expect(granted.status).toBe(404);
    });

    it("applies a parent-channel send deny to that channel's threads", async () => {
      const { serverId, textChannelId } = await makeServer();
      const listed = await call<{
        roles: Array<{ id: string; isEveryone: boolean }>;
      }>(owner, "GET", `/api/servers/${serverId}/roles`);
      const everyone = listed.body.roles.find((role) => role.isEveryone)!;
      const overwritten = await call(
        owner,
        "PUT",
        `/api/channels/${textChannelId}/overwrites`,
        {
          targetType: "role",
          targetId: everyone.id,
          allow: "0",
          deny: serializePermissions(Permission.SEND_MESSAGES),
        },
      );
      expect(overwritten.status).toBe(200);

      const posted = await getPool().query<{ id: string }>(
        `INSERT INTO messages (channel_id, author_id, body)
         VALUES ($1, $2, $3) RETURNING id`,
        [textChannelId, owner.id, "thread origin"],
      );
      const started = await call<{ thread: { channelId: string } }>(
        owner,
        "POST",
        `/api/messages/${posted.rows[0]!.id}/threads`,
        { name: "announcements thread" },
      );
      expect(started.status).toBe(201);

      expect(
        await memberHasPermission(
          serverId,
          member.id,
          Permission.SEND_MESSAGES,
          textChannelId,
        ),
      ).toBe(false);
      expect(
        await memberHasPermission(
          serverId,
          member.id,
          Permission.SEND_MESSAGES,
          started.body.thread.channelId,
        ),
      ).toBe(false);
    });

    it("keeps @everyone VIEW locked to the private-channel toggle", async () => {
      const { serverId, textChannelId } = await makeServer();
      const listed = await call<{
        roles: Array<{ id: string; isEveryone: boolean }>;
      }>(owner, "GET", `/api/servers/${serverId}/roles`);
      const everyone = listed.body.roles.find((role) => role.isEveryone)!;
      expect(
        (
          await call(owner, "PATCH", `/api/channels/${textChannelId}`, {
            isPrivate: true,
          })
        ).status,
      ).toBe(200);

      const overwritten = await call(
        owner,
        "PUT",
        `/api/channels/${textChannelId}/overwrites`,
        {
          targetType: "role",
          targetId: everyone.id,
          allow: serializePermissions(Permission.VIEW_CHANNEL),
          deny: "0",
        },
      );
      expect(overwritten.status).toBe(200);

      const rows = await call<{
        overwrites: Array<{
          targetId: string;
          allow: string;
          deny: string;
        }>;
      }>(owner, "GET", `/api/channels/${textChannelId}/overwrites`);
      const everyoneRow = rows.body.overwrites.find(
        (row) => row.targetId === everyone.id,
      )!;
      expect(BigInt(everyoneRow.deny) & Permission.VIEW_CHANNEL).toBe(
        Permission.VIEW_CHANNEL,
      );
      expect(BigInt(everyoneRow.allow) & Permission.VIEW_CHANNEL).toBe(0n);
    });

    it("lets a staff role send while @everyone cannot", async () => {
      const { serverId, textChannelId } = await makeServer();
      const listed = await call<{
        roles: Array<{ id: string; isEveryone: boolean }>;
      }>(owner, "GET", `/api/servers/${serverId}/roles`);
      const everyone = listed.body.roles.find((role) => role.isEveryone)!;
      expect(
        (
          await call(owner, "PUT", `/api/channels/${textChannelId}/overwrites`, {
            targetType: "role",
            targetId: everyone.id,
            allow: "0",
            deny: serializePermissions(Permission.SEND_MESSAGES),
          })
        ).status,
      ).toBe(200);

      expect(
        await memberHasPermission(
          serverId,
          member.id,
          Permission.SEND_MESSAGES,
          textChannelId,
        ),
      ).toBe(false);

      const staff = await call<{ role: { id: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/roles`,
        { name: "Staff", permissions: serializePermissions(Permission.SEND_MESSAGES) },
      );
      expect(staff.status).toBe(201);
      expect(
        (
          await call(owner, "PUT", `/api/channels/${textChannelId}/overwrites`, {
            targetType: "role",
            targetId: staff.body.role.id,
            allow: serializePermissions(Permission.SEND_MESSAGES),
            deny: "0",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call(
            owner,
            "PUT",
            `/api/servers/${serverId}/members/${member.id}/roles/${staff.body.role.id}`,
          )
        ).status,
      ).toBe(200);

      expect(
        await memberHasPermission(
          serverId,
          member.id,
          Permission.SEND_MESSAGES,
          textChannelId,
        ),
      ).toBe(true);
    });

    it("hides a channel from a role denied VIEW", async () => {
      const { serverId, textChannelId } = await makeServer();
      const colour = await call<{ role: { id: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/roles`,
        { name: "colour" },
      );
      expect(colour.status).toBe(201);
      expect(
        (
          await call(
            owner,
            "PUT",
            `/api/servers/${serverId}/members/${member.id}/roles/${colour.body.role.id}`,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await call(owner, "PUT", `/api/channels/${textChannelId}/overwrites`, {
            targetType: "role",
            targetId: colour.body.role.id,
            allow: "0",
            deny: serializePermissions(Permission.VIEW_CHANNEL),
          })
        ).status,
      ).toBe(200);

      const audience = await getChannelAudience(textChannelId);
      expect(audience?.has(member.id)).toBe(false);
      expect(audience?.has(owner.id)).toBe(true);
    });

    it("bumps the permissions snapshot version when an overwrite is saved", async () => {
      const { serverId, textChannelId } = await makeServer();
      const listed = await call<{
        roles: Array<{ id: string; isEveryone: boolean }>;
      }>(owner, "GET", `/api/servers/${serverId}/roles`);
      const everyone = listed.body.roles.find((role) => role.isEveryone)!;
      const before = await call<{ version: number }>(
        owner,
        "GET",
        `/api/servers/${serverId}/permissions`,
      );
      expect(before.status).toBe(200);

      expect(
        (
          await call(owner, "PUT", `/api/channels/${textChannelId}/overwrites`, {
            targetType: "role",
            targetId: everyone.id,
            allow: "0",
            deny: serializePermissions(Permission.SEND_MESSAGES),
          })
        ).status,
      ).toBe(200);

      const after = await call<{ version: number }>(
        owner,
        "GET",
        `/api/servers/${serverId}/permissions`,
      );
      expect(after.status).toBe(200);
      expect(after.body.version).toBeGreaterThan(before.body.version);
    });

    it("logs deleting a channel overwrite", async () => {
      const { serverId, textChannelId } = await makeServer();
      const listed = await call<{
        roles: Array<{ id: string; isEveryone: boolean }>;
      }>(owner, "GET", `/api/servers/${serverId}/roles`);
      const everyone = listed.body.roles.find((role) => role.isEveryone)!;
      expect(
        (
          await call(owner, "PUT", `/api/channels/${textChannelId}/overwrites`, {
            targetType: "role",
            targetId: everyone.id,
            allow: "0",
            deny: serializePermissions(Permission.SEND_MESSAGES),
          })
        ).status,
      ).toBe(200);

      const deleted = await call(
        owner,
        "DELETE",
        `/api/channels/${textChannelId}/overwrites/role/${everyone.id}`,
      );
      expect(deleted.status).toBe(200);

      const log = await call<{
        entries: Array<{ action: string; targetId: string | null }>;
      }>(owner, "GET", `/api/servers/${serverId}/audit-log`);
      expect(log.status).toBe(200);
      expect(log.body.entries[0]).toMatchObject({
        action: "channel.overwrite_delete",
        targetId: textChannelId,
      });
    });
  });

  describe("messages", () => {
    async function postMessage(channelId: string, author = owner) {
      const result = await getPool().query<{ id: string }>(
        `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, $3) RETURNING id`,
        [channelId, author.id, "hello"],
      );
      return result.rows[0]!.id;
    }

    it("lets an author edit their own message and nobody else", async () => {
      const { textChannelId } = await makeServer();
      const messageId = await postMessage(textChannelId);

      expect(
        (await call(member, "PATCH", `/api/messages/${messageId}`, { body: "hack" }))
          .status,
      ).toBe(403);

      const edited = await call<{ message: { body: string; editedAt: string } }>(
        owner,
        "PATCH",
        `/api/messages/${messageId}`,
        { body: "edited" },
      );
      expect(edited.status).toBe(200);
      expect(edited.body.message.body).toBe("edited");
      expect(edited.body.message.editedAt).not.toBeNull();
    });

    it("lets moderators delete anyone's message, and members only their own", async () => {
      const { textChannelId } = await makeServer();

      const ownersMessage = await postMessage(textChannelId, owner);
      expect(
        (await call(member, "DELETE", `/api/messages/${ownersMessage}`)).status,
      ).toBe(403);
      expect(
        (await call(admin, "DELETE", `/api/messages/${ownersMessage}`)).status,
      ).toBe(200);

      const membersMessage = await postMessage(textChannelId, member);
      expect(
        (await call(member, "DELETE", `/api/messages/${membersMessage}`)).status,
      ).toBe(200);
    });

    it("hides a message in another server from an outsider", async () => {
      const { textChannelId } = await makeServer();
      const messageId = await postMessage(textChannelId);
      expect(
        (await call(outsider, "PATCH", `/api/messages/${messageId}`, { body: "x" }))
          .status,
      ).toBe(404);
    });

    it("paginates history with a stable cursor", async () => {
      const { textChannelId } = await makeServer();
      for (let i = 0; i < 5; i++) {
        await getPool().query(
          `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, $3)`,
          [textChannelId, owner.id, `m${i}`],
        );
      }

      const first = await call<{
        messages: Array<{ id: string; body: string }>;
        hasMore: boolean;
      }>(owner, "GET", `/api/channels/${textChannelId}/messages?limit=2`);
      expect(first.body.messages.map((m) => m.body)).toEqual(["m3", "m4"]);
      expect(first.body.hasMore).toBe(true);

      const second = await call<{
        messages: Array<{ body: string }>;
        hasMore: boolean;
      }>(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?limit=2&before=${first.body.messages[0]!.id}`,
      );
      expect(second.body.messages.map((m) => m.body)).toEqual(["m1", "m2"]);
    });

    it("centres a page on the message a permalink points at", async () => {
      const { textChannelId } = await makeServer();
      const ids: string[] = [];
      for (let i = 0; i < 9; i++) {
        const inserted = await getPool().query<{ id: string }>(
          `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, $3) RETURNING id`,
          [textChannelId, owner.id, `m${i}`],
        );
        ids.push(inserted.rows[0]!.id);
      }

      const middle = await call<{
        messages: Array<{ id: string; body: string }>;
        hasMore: boolean;
        hasNewer: boolean;
      }>(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?limit=4&around=${ids[4]}`,
      );
      expect(middle.body.messages.map((m) => m.body)).toEqual([
        "m3",
        "m4",
        "m5",
        "m6",
      ]);
      expect(middle.body.hasMore).toBe(true);
      expect(middle.body.hasNewer).toBe(true);

      // The anchor rides in the older half, so the newest message still centres
      // on itself rather than falling off the end of its own page.
      const newest = await call<{
        messages: Array<{ body: string }>;
        hasMore: boolean;
        hasNewer: boolean;
      }>(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?limit=4&around=${ids[8]}`,
      );
      expect(newest.body.messages.map((m) => m.body)).toEqual(["m7", "m8"]);
      expect(newest.body.hasNewer).toBe(false);
      expect(newest.body.hasMore).toBe(true);
    });

    it("walks back and forth around an anchor without repeating or skipping", async () => {
      const { textChannelId } = await makeServer();
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const inserted = await getPool().query<{ id: string }>(
          `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, $3) RETURNING id`,
          [textChannelId, owner.id, `m${i}`],
        );
        ids.push(inserted.rows[0]!.id);
      }

      type Page = {
        messages: Array<{ id: string; body: string }>;
        hasMore: boolean;
        hasNewer: boolean;
      };
      const around = await call<Page>(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?limit=4&around=${ids[5]}`,
      );
      expect(around.body.messages.map((m) => m.body)).toEqual([
        "m4",
        "m5",
        "m6",
        "m7",
      ]);

      const older = await call<Page>(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?limit=2&before=${around.body.messages[0]!.id}`,
      );
      expect(older.body.messages.map((m) => m.body)).toEqual(["m2", "m3"]);
      expect(older.body.hasNewer).toBe(true);

      const newer = await call<Page>(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?limit=2&after=${around.body.messages[3]!.id}`,
      );
      expect(newer.body.messages.map((m) => m.body)).toEqual(["m8", "m9"]);
      expect(newer.body.hasMore).toBe(true);
      expect(newer.body.hasNewer).toBe(false);

      const walked = [
        ...older.body.messages,
        ...around.body.messages,
        ...newer.body.messages,
      ].map((m) => m.id);
      expect(walked).toEqual(ids.slice(2));
      expect(new Set(walked).size).toBe(walked.length);
    });

    it("rejects an anchor whose message was deleted, rather than paging from nowhere", async () => {
      const { textChannelId } = await makeServer();
      for (let i = 0; i < 3; i++) {
        await getPool().query(
          `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, $3)`,
          [textChannelId, owner.id, `m${i}`],
        );
      }
      const anchor = await postMessage(textChannelId);
      await call(owner, "DELETE", `/api/messages/${anchor}`);

      const res = await call(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?around=${anchor}`,
      );
      expect(res.status).toBe(400);
    });

    it("refuses to guess which end a page hangs off when cursors are combined", async () => {
      const { textChannelId } = await makeServer();
      const anchor = await postMessage(textChannelId);
      const res = await call(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?around=${anchor}&before=${anchor}`,
      );
      expect(res.status).toBe(400);
    });

    it("clamps an absurd limit instead of scanning the whole channel", async () => {
      const { textChannelId } = await makeServer();
      const res = await call(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?limit=100000000`,
      );
      expect(res.status).toBe(200);
    });

    it("rejects a malformed cursor with 400, not 500", async () => {
      const { textChannelId } = await makeServer();
      const res = await call(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?before=not-a-uuid`,
      );
      expect(res.status).toBe(400);
    });

    it("rejects a cursor whose message was deleted, rather than claiming history ran out", async () => {
      const { textChannelId } = await makeServer();
      for (let i = 0; i < 3; i++) {
        await getPool().query(
          `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, $3)`,
          [textChannelId, owner.id, `m${i}`],
        );
      }
      const cursor = await postMessage(textChannelId);
      await call(owner, "DELETE", `/api/messages/${cursor}`);

      const res = await call(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?before=${cursor}`,
      );
      expect(res.status).toBe(400);
    });
  });

  describe("pinned messages", () => {
    async function postMessage(channelId: string, author = owner) {
      const result = await getPool().query<{ id: string }>(
        `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, $3) RETURNING id`,
        [channelId, author.id, "hello"],
      );
      return result.rows[0]!.id;
    }

    it("lets an admin pin, and refuses a plain member", async () => {
      const { textChannelId } = await makeServer();
      const messageId = await postMessage(textChannelId, member);

      expect(
        (await call(member, "POST", `/api/messages/${messageId}/pin`)).status,
      ).toBe(403);

      const pinned = await call<{
        message: { pinnedAt: string | null; pinnedBy: { id: string } | null };
      }>(admin, "POST", `/api/messages/${messageId}/pin`);
      expect(pinned.status).toBe(200);
      expect(pinned.body.message.pinnedAt).not.toBeNull();
      expect(pinned.body.message.pinnedBy?.id).toBe(admin.id);
    });

    it("is idempotent: a second pin does not reassign credit or bump the time", async () => {
      const { textChannelId } = await makeServer();
      const messageId = await postMessage(textChannelId);

      const first = await call<{
        message: { pinnedAt: string | null; pinnedBy: { id: string } | null };
      }>(admin, "POST", `/api/messages/${messageId}/pin`);
      const second = await call<{
        message: { pinnedAt: string | null; pinnedBy: { id: string } | null };
      }>(owner, "POST", `/api/messages/${messageId}/pin`);

      expect(second.status).toBe(200);
      expect(second.body.message.pinnedAt).toBe(first.body.message.pinnedAt);
      // Credit stays with whoever pinned it first, not whoever pinned it last.
      expect(second.body.message.pinnedBy?.id).toBe(admin.id);
    });

    it("unpins, and unpinning twice is a no-op success rather than an error", async () => {
      const { textChannelId } = await makeServer();
      const messageId = await postMessage(textChannelId);
      await call(admin, "POST", `/api/messages/${messageId}/pin`);

      expect(
        (await call(member, "DELETE", `/api/messages/${messageId}/pin`))
          .status,
      ).toBe(403);

      const unpinned = await call<{ message: { pinnedAt: string | null } }>(
        admin,
        "DELETE",
        `/api/messages/${messageId}/pin`,
      );
      expect(unpinned.status).toBe(200);
      expect(unpinned.body.message.pinnedAt).toBeNull();

      // Already unpinned — this must still succeed, not 404 or error, so the
      // client never has to check state before offering the button.
      expect(
        (await call(admin, "DELETE", `/api/messages/${messageId}/pin`)).status,
      ).toBe(200);
    });

    it("lists pins newest first, and never a message that was never pinned", async () => {
      const { textChannelId } = await makeServer();
      const first = await postMessage(textChannelId);
      const second = await postMessage(textChannelId);
      const neverPinned = await postMessage(textChannelId);
      void neverPinned;

      await call(admin, "POST", `/api/messages/${first}/pin`);
      await call(admin, "POST", `/api/messages/${second}/pin`);

      const list = await call<{ messages: Array<{ id: string }> }>(
        member,
        "GET",
        `/api/channels/${textChannelId}/pins`,
      );
      expect(list.status).toBe(200);
      expect(list.body.messages.map((m) => m.id)).toEqual([second, first]);
    });

    it("refuses a 51st pin, and a re-pin never counts against the cap", async () => {
      const { textChannelId } = await makeServer();
      const ids: string[] = [];
      for (let i = 0; i < 50; i++) {
        ids.push(await postMessage(textChannelId));
      }
      // Pinned directly rather than through 50 HTTP calls: the cap is what's
      // under test here, not whether 50 rapid writes fit inside one test's
      // rate-limit budget — the write limiter caps at 30 per window and would
      // 429 partway through a real request loop.
      await getPool().query(
        `UPDATE messages SET pinned_at = NOW(), pinned_by = $1 WHERE id = ANY($2::uuid[])`,
        [admin.id, ids],
      );

      // Re-pinning an already-pinned message must not be blocked by a channel
      // sitting exactly at the cap — it changes nothing about the count.
      expect(
        (await call(admin, "POST", `/api/messages/${ids[0]}/pin`)).status,
      ).toBe(200);

      const overflow = await postMessage(textChannelId);
      const blocked = await call(admin, "POST", `/api/messages/${overflow}/pin`);
      expect(blocked.status).toBe(409);
    });

    it("lets either participant of a conversation pin — no server role involved", async () => {
      await makeServer();
      const opened = await call<{ conversation: { channelId: string } }>(
        member,
        "POST",
        "/api/dms",
        { userIds: [admin.id] },
      );
      expect(opened.status).toBe(201);
      const channelId = opened.body.conversation.channelId;
      const messageId = await postMessage(channelId, admin);

      // Pinned by the OTHER participant, not the author and not a server
      // admin acting on the server — proving the conversation branch of
      // requirePinAccess, not the server branch, is what let this through.
      const pinned = await call<{ message: { pinnedAt: string | null } }>(
        member,
        "POST",
        `/api/messages/${messageId}/pin`,
      );
      expect(pinned.status).toBe(200);
      expect(pinned.body.message.pinnedAt).not.toBeNull();
    });

    it("hides pin routes from someone who cannot see the channel at all", async () => {
      const { textChannelId } = await makeServer();
      const messageId = await postMessage(textChannelId);

      expect(
        (await call(outsider, "POST", `/api/messages/${messageId}/pin`))
          .status,
      ).toBe(404);
      expect(
        (await call(outsider, "GET", `/api/channels/${textChannelId}/pins`))
          .status,
      ).toBe(404);
    });
  });

  describe("channel categories", () => {
    async function createChannel(
      serverId: string,
      name: string,
      type: "text" | "voice" | "category",
      as = owner,
    ) {
      const res = await call<{ channel: { id: string; position: number } }>(
        as,
        "POST",
        `/api/servers/${serverId}/channels`,
        { name, type },
      );
      expect(res.status).toBe(201);
      return res.body.channel;
    }

    async function channelRow(channelId: string) {
      const result = await getPool().query<{
        parent_id: string | null;
        position: number;
        type: string;
      }>(
        `SELECT parent_id, position, type FROM channels WHERE id = $1`,
        [channelId],
      );
      return result.rows[0]!;
    }

    it("refuses a private category — inheritance to children does not exist yet", async () => {
      const { serverId } = await makeServer();
      const res = await call(owner, "POST", `/api/servers/${serverId}/channels`, {
        name: "staff",
        type: "category",
        isPrivate: true,
      });
      expect(res.status).toBe(400);
    });

    it("lets a manager move a channel into a category, and refuses a plain member", async () => {
      const { serverId, textChannelId } = await makeServer();
      const category = await createChannel(serverId, "topics", "category");

      expect(
        (
          await call(member, "PATCH", `/api/channels/${textChannelId}/move`, {
            parentId: category.id,
            index: 0,
          })
        ).status,
      ).toBe(403);

      const moved = await call(
        admin,
        "PATCH",
        `/api/channels/${textChannelId}/move`,
        { parentId: category.id, index: 0 },
      );
      expect(moved.status).toBe(200);
      expect((await channelRow(textChannelId)).parent_id).toBe(category.id);
    });

    it("refuses to nest a category under another category", async () => {
      const { serverId } = await makeServer();
      const outer = await createChannel(serverId, "outer", "category");
      const inner = await createChannel(serverId, "inner", "category");

      const res = await call(owner, "PATCH", `/api/channels/${inner.id}/move`, {
        parentId: outer.id,
        index: 0,
      });
      expect(res.status).toBe(400);
    });

    it("refuses a channel naming itself as its own category", async () => {
      const { textChannelId } = await makeServer();
      const res = await call(
        owner,
        "PATCH",
        `/api/channels/${textChannelId}/move`,
        { parentId: textChannelId, index: 0 },
      );
      expect(res.status).toBe(400);
    });

    it("refuses a parent that is not a category at all", async () => {
      const { serverId, textChannelId } = await makeServer();
      const otherText = await createChannel(serverId, "other", "text");

      const res = await call(
        owner,
        "PATCH",
        `/api/channels/${textChannelId}/move`,
        { parentId: otherText.id, index: 0 },
      );
      expect(res.status).toBe(400);
    });

    it("scopes top-level position by type: reordering text never perturbs voice", async () => {
      // This is the one that would have silently broken without the type
      // scope on the top-level sibling group: a naive "position among all
      // top-level channels" would let a text-channel reorder renumber voice
      // channels that share no visible list with it at all.
      const { serverId, textChannelId: text0 } = await makeServer();
      const text1 = await createChannel(serverId, "text-1", "text");
      const voice0 = await createChannel(serverId, "voice-0", "voice");
      const voice1 = await createChannel(serverId, "voice-1", "voice");

      const voice0Before = await channelRow(voice0.id);
      const voice1Before = await channelRow(voice1.id);

      // Move the second text channel to the front of the text list.
      const res = await call(owner, "PATCH", `/api/channels/${text1.id}/move`, {
        parentId: null,
        index: 0,
      });
      expect(res.status).toBe(200);

      expect((await channelRow(text1.id)).position).toBe(0);
      expect((await channelRow(text0)).position).toBe(1);
      // Untouched — a different top-level group (type='voice').
      expect(await channelRow(voice0.id)).toEqual(voice0Before);
      expect(await channelRow(voice1.id)).toEqual(voice1Before);
    });

    it("closes the gap in the category a channel left, and keeps the category it joined contiguous", async () => {
      const { serverId, textChannelId } = await makeServer();
      const category = await createChannel(serverId, "topics", "category");
      const inCategory = [
        await createChannel(serverId, "c0", "text"),
        await createChannel(serverId, "c1", "text"),
        await createChannel(serverId, "c2", "text"),
      ];
      for (const channel of inCategory) {
        await call(owner, "PATCH", `/api/channels/${channel.id}/move`, {
          parentId: category.id,
          index: 99,
        });
      }

      // Pull the middle one back out to top-level.
      await call(owner, "PATCH", `/api/channels/${inCategory[1]!.id}/move`, {
        parentId: null,
        index: 0,
      });

      const remaining = await Promise.all(
        [inCategory[0]!.id, inCategory[2]!.id].map((id) => channelRow(id)),
      );
      expect(remaining.map((r) => r.position).sort()).toEqual([0, 1]);

      // The channel it joined is now the front of the top-level TEXT group —
      // ahead of the server's original default text channel.
      expect((await channelRow(inCategory[1]!.id)).position).toBe(0);
      expect((await channelRow(textChannelId)).position).toBe(1);
    });

    it("uncategorizes a category's children rather than deleting them, without a position collision", async () => {
      // makeServer's default text channel is already at top-level position 0
      // — deleting the category must not hand that same position to the
      // channel it just released, or the two would tie for first forever.
      const { serverId, textChannelId } = await makeServer();
      const category = await createChannel(serverId, "topics", "category");
      const child = await createChannel(serverId, "child", "text");
      await call(owner, "PATCH", `/api/channels/${child.id}/move`, {
        parentId: category.id,
        index: 0,
      });

      expect((await call(owner, "DELETE", `/api/channels/${category.id}`)).status).toBe(
        200,
      );

      const row = await channelRow(child.id);
      expect(row.parent_id).toBeNull();
      const stillExists = await getPool().query(
        `SELECT 1 FROM channels WHERE id = $1`,
        [child.id],
      );
      expect(stillExists.rows).toHaveLength(1);

      const original = await channelRow(textChannelId);
      expect([original.position, row.position].sort()).toEqual([0, 1]);
    });

    it("appends several orphaned children in their prior relative order, after existing top-level channels", async () => {
      const { serverId, textChannelId } = await makeServer();
      const category = await createChannel(serverId, "topics", "category");
      const first = await createChannel(serverId, "first", "text");
      const second = await createChannel(serverId, "second", "text");
      for (const channel of [first, second]) {
        await call(owner, "PATCH", `/api/channels/${channel.id}/move`, {
          parentId: category.id,
          index: 99,
        });
      }

      await call(owner, "DELETE", `/api/channels/${category.id}`);

      const positions = await Promise.all(
        [textChannelId, first.id, second.id].map((id) => channelRow(id)),
      );
      expect(positions.map((p) => p.position)).toEqual([0, 1, 2]);
    });

    it("hides move routes from an outsider", async () => {
      const { textChannelId } = await makeServer();
      const res = await call(
        outsider,
        "PATCH",
        `/api/channels/${textChannelId}/move`,
        { parentId: null, index: 0 },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("replies", () => {
    interface HistoryMessage {
      id: string;
      body: string;
      replyTo: {
        id: string;
        authorId: string | null;
        authorName: string | null;
        excerpt: string;
        deleted: boolean;
      } | null;
    }

    /** Replies are only creatable over the socket, so these drive it directly. */
    async function send(
      as: { id: string },
      channelId: string,
      body: string,
      replyToId?: string,
    ) {
      await handleChatMessage(
        { socket: fakeSocket(), user: await asDbUser(as.id) },
        {
          type: "message-create",
          channelId,
          body,
          ...(replyToId ? { replyToId } : {}),
        },
      );
    }

    async function history(
      as: { id: string; clerk_id: string },
      channelId: string,
    ): Promise<HistoryMessage[]> {
      const res = await call<{ messages: HistoryMessage[] }>(
        as,
        "GET",
        `/api/channels/${channelId}/messages`,
      );
      expect(res.status).toBe(200);
      return res.body.messages;
    }

    async function mentionCount(): Promise<number> {
      const result = await getPool().query(`SELECT 1 FROM message_mentions`);
      return result.rowCount ?? 0;
    }

    it("carries a snapshot of the message it answers", async () => {
      const { textChannelId } = await makeServer();
      await send(owner, textChannelId, "the original question");
      const [parent] = await history(owner, textChannelId);

      await send(member, textChannelId, "the answer", parent!.id);

      const messages = await history(owner, textChannelId);
      expect(messages.map((m) => m.body)).toEqual([
        "the original question",
        "the answer",
      ]);
      expect(messages[0]!.replyTo).toBeNull();
      expect(messages[1]!.replyTo).toEqual({
        id: parent!.id,
        authorId: owner.id,
        authorName: "Owner",
        excerpt: "the original question",
        deleted: false,
      });
    });

    it("counts a reply as a mention of the person being answered", async () => {
      const { serverId, textChannelId } = await makeServer();
      await send(owner, textChannelId, "question");
      const [parent] = await history(owner, textChannelId);
      await send(member, textChannelId, "answer", parent!.id);

      const unread = await call<{
        unread: Array<{ channelId: string; count: number; mentions: number }>;
      }>(owner, "GET", `/api/servers/${serverId}/unread`);
      const row = unread.body.unread.find((u) => u.channelId === textChannelId);
      expect(row?.mentions).toBe(1);
    });

    it("does not notify someone for answering themselves", async () => {
      const { textChannelId } = await makeServer();
      await send(owner, textChannelId, "thinking out loud");
      const [parent] = await history(owner, textChannelId);
      await send(owner, textChannelId, "and the answer", parent!.id);

      expect(await mentionCount()).toBe(0);
    });

    it("keeps the reply notification when the reply is edited", async () => {
      const { textChannelId } = await makeServer();
      await send(owner, textChannelId, "question");
      const [parent] = await history(owner, textChannelId);
      await send(member, textChannelId, "answer", parent!.id);
      const messages = await history(owner, textChannelId);

      const edited = await call(
        member,
        "PATCH",
        `/api/messages/${messages[1]!.id}`,
        { body: "answer, corrected" },
      );
      expect(edited.status).toBe(200);
      // An edit wipes and re-derives the mention rows; the reply must survive it.
      expect(await mentionCount()).toBe(1);
    });

    it("refuses a parent that lives in another channel", async () => {
      const { serverId, textChannelId } = await makeServer();
      const other = await call<{ channel: { id: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/channels`,
        { name: "elsewhere", type: "text" },
      );
      const otherChannelId = other.body.channel.id;
      await send(owner, otherChannelId, "over here");
      const [foreign] = await history(owner, otherChannelId);

      await send(member, textChannelId, "smuggled", foreign!.id);

      expect(await history(owner, textChannelId)).toHaveLength(0);
    });

    it("still posts when the message being answered is already gone", async () => {
      const { textChannelId } = await makeServer();
      // A parent deleted while the reply was being typed is an ordinary race;
      // throwing away what somebody wrote would be the worse failure.
      await send(
        member,
        textChannelId,
        "answer",
        "00000000-0000-4000-8000-0000000000ff",
      );

      const messages = await history(owner, textChannelId);
      expect(messages.map((m) => m.body)).toEqual(["answer"]);
      expect(messages[0]!.replyTo).toBeNull();
    });

    it("keeps replies alive when the message they answer is deleted", async () => {
      const { textChannelId } = await makeServer();
      await send(owner, textChannelId, "question");
      const [parent] = await history(owner, textChannelId);
      await send(member, textChannelId, "answer", parent!.id);

      expect(
        (await call(owner, "DELETE", `/api/messages/${parent!.id}`)).status,
      ).toBe(200);

      // SET NULL, not CASCADE: the answer outlives the question.
      const messages = await history(owner, textChannelId);
      expect(messages.map((m) => m.body)).toEqual(["answer"]);
      expect(messages[0]!.replyTo).toBeNull();
    });
  });

  describe("unread", () => {
    it("counts other people's messages until the channel is marked read", async () => {
      const { serverId, textChannelId } = await makeServer();

      await getPool().query(
        `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'hi @member')`,
        [textChannelId, owner.id],
      );
      await getPool().query(
        `INSERT INTO message_mentions (message_id, user_id)
         SELECT id, $2 FROM messages WHERE channel_id = $1`,
        [textChannelId, member.id],
      );

      const before = await call<{
        unread: Array<{ channelId: string; count: number; mentions: number }>;
      }>(member, "GET", `/api/servers/${serverId}/unread`);
      const row = before.body.unread.find((u) => u.channelId === textChannelId);
      expect(row?.count).toBe(1);
      expect(row?.mentions).toBe(1);

      // The author never has unread of their own.
      const authorView = await call<{
        unread: Array<{ channelId: string; count: number }>;
      }>(owner, "GET", `/api/servers/${serverId}/unread`);
      expect(
        authorView.body.unread.find((u) => u.channelId === textChannelId)?.count,
      ).toBe(0);

      const marked = await call<{
        ok: boolean;
        previousLastReadAt: string | null;
        lastReadAt: string;
      }>(member, "POST", `/api/channels/${textChannelId}/read`);
      expect(marked.status).toBe(200);
      expect(marked.body.previousLastReadAt).toBeNull();
      expect(marked.body.lastReadAt).toBeTruthy();

      const second = await call<{ previousLastReadAt: string | null }>(
        member,
        "POST",
        `/api/channels/${textChannelId}/read`,
      );
      expect(second.body.previousLastReadAt).toBe(marked.body.lastReadAt);

      const after = await call<{
        unread: Array<{ channelId: string; count: number }>;
      }>(member, "GET", `/api/servers/${serverId}/unread`);
      expect(
        after.body.unread.find((u) => u.channelId === textChannelId)?.count,
      ).toBe(0);
    });

    it("rewinds the read cursor so later messages count as unread", async () => {
      const { serverId, textChannelId } = await makeServer();
      await getPool().query(
        `INSERT INTO messages (channel_id, author_id, body, created_at)
         VALUES ($1, $2, 'older', NOW() - INTERVAL '2 minutes'),
                ($1, $2, 'newer', NOW() - INTERVAL '1 minute')`,
        [textChannelId, owner.id],
      );
      const newer = await getPool().query<{ created_at: Date }>(
        `SELECT created_at FROM messages
          WHERE channel_id = $1 AND body = 'newer'`,
        [textChannelId],
      );
      const justBefore = new Date(
        newer.rows[0]!.created_at.getTime() - 1,
      ).toISOString();

      expect(
        (
          await call(member, "POST", `/api/channels/${textChannelId}/read`, {
            lastReadAt: justBefore,
          })
        ).status,
      ).toBe(200);

      const unread = await call<{
        unread: Array<{ channelId: string; count: number }>;
      }>(member, "GET", `/api/servers/${serverId}/unread`);
      expect(
        unread.body.unread.find((u) => u.channelId === textChannelId)?.count,
      ).toBe(1);
    });
  });

  describe("ownership", () => {
    it("refuses to hand the server to someone who is not a member", async () => {
      const { serverId } = await makeServer();
      const res = await call(owner, "PATCH", `/api/servers/${serverId}`, {
        ownerId: outsider.id,
      });
      expect(res.status).toBe(400);
    });

    it("swaps owner and previous owner roles atomically", async () => {
      const { serverId } = await makeServer();
      expect(
        (
          await call(owner, "PATCH", `/api/servers/${serverId}`, {
            ownerId: admin.id,
          })
        ).status,
      ).toBe(200);

      const members = await call<{
        members: Array<{ id: string; role: string }>;
      }>(admin, "GET", `/api/servers/${serverId}/members`);
      const roles = Object.fromEntries(
        members.body.members.map((m) => [m.id, m.role]),
      );
      expect(roles[admin.id]).toBe("owner");
      expect(roles[owner.id]).toBe("admin");

      // The old owner may no longer do owner-only things.
      expect(
        (await call(owner, "DELETE", `/api/servers/${serverId}`)).status,
      ).toBe(403);
    });

    it("carries a status for every member, defaulting to offline", async () => {
      // Status is resolved from the live connection registry, and this suite
      // opens no WebSockets — so everybody is genuinely offline, which is the
      // assertion that matters. `offline` must be what an account with no socket
      // reads as, without a row anywhere saying so.
      const { serverId } = await makeServer();
      const res = await call<{
        members: Array<{ id: string; status?: string }>;
      }>(owner, "GET", `/api/servers/${serverId}/members`);

      expect(res.status).toBe(200);
      expect(res.body.members.length).toBeGreaterThan(0);
      for (const member of res.body.members) {
        expect(member.status).toBe("offline");
      }
    });
  });

  describe("preferences", () => {
    // Deliberately not typed from the shared schema: these assertions are about
    // what actually reaches and leaves the database, so a mistake in the schema
    // should fail them rather than be assumed away.
    interface PrefsBody {
      preferences: Record<string, unknown>;
    }

    it("round-trips a patch and carries it on /api/me", async () => {
      const saved = await call<PrefsBody>(owner, "PATCH", "/api/me/preferences", {
        theme: "light",
        muteOnJoin: true,
        inputVolume: 1.5,
      });
      expect(saved.status).toBe(200);
      expect(saved.body.preferences).toEqual({
        theme: "light",
        muteOnJoin: true,
        inputVolume: 1.5,
      });

      // The bootstrap request already carries them, so the client needs no
      // second round-trip before it can paint.
      const me = await call<PrefsBody>(owner, "GET", "/api/me");
      expect(me.body.preferences).toEqual({
        theme: "light",
        muteOnJoin: true,
        inputVolume: 1.5,
      });
    });

    it("merges shallowly instead of replacing the stored object", async () => {
      const fresh = await call<PrefsBody>(owner, "GET", "/api/me");
      expect(fresh.body.preferences).toEqual({});

      await call(owner, "PATCH", "/api/me/preferences", {
        theme: "dark",
        compactPeers: true,
        outputVolume: 0.4,
      });

      // A client that only knows about `theme` must not drop the rest.
      const merged = await call<PrefsBody>(owner, "PATCH", "/api/me/preferences", {
        theme: "light",
      });
      expect(merged.body.preferences).toEqual({
        theme: "light",
        compactPeers: true,
        outputVolume: 0.4,
      });
    });

    it("keeps one account's preferences out of another's", async () => {
      await call(owner, "PATCH", "/api/me/preferences", { theme: "light" });
      const other = await call<PrefsBody>(member, "GET", "/api/me");
      expect(other.body.preferences).toEqual({});
    });

    it("rejects values outside the allowed set with 400 and stores nothing", async () => {
      const invalid = [
        { theme: "neon" },
        { inputVolume: 4 },
        { outputVolume: -1 },
        { muteOnJoin: "yes" },
      ];
      for (const body of invalid) {
        const res = await call(owner, "PATCH", "/api/me/preferences", body);
        expect(res.status).toBe(400);
      }

      const me = await call<PrefsBody>(owner, "GET", "/api/me");
      expect(me.body.preferences).toEqual({});
    });

    it("drops audio device ids, which name nothing on another machine", async () => {
      const saved = await call<PrefsBody>(owner, "PATCH", "/api/me/preferences", {
        muteOnJoin: true,
        inputDeviceId: "3f9c…-mic",
        outputDeviceId: "a71b…-speakers",
      });
      expect(saved.status).toBe(200);
      expect(saved.body.preferences).toEqual({ muteOnJoin: true });

      const me = await call<PrefsBody>(owner, "GET", "/api/me");
      expect(me.body.preferences).toEqual({ muteOnJoin: true });
    });

    it("stores a manual status, and refuses one nobody may set", async () => {
      // `user_preferences` is the home for the manual half of user status, which
      // is why the whole feature ships without a migration. This proves the
      // column really takes it and hands it back on the bootstrap request.
      const saved = await call<PrefsBody>(owner, "PATCH", "/api/me/preferences", {
        status: "invisible",
      });
      expect(saved.status).toBe(200);
      expect(saved.body.preferences).toEqual({ status: "invisible" });

      const me = await call<PrefsBody>(owner, "GET", "/api/me");
      expect(me.body.preferences).toEqual({ status: "invisible" });

      // The derived states are not settable, and that is enforced by the schema
      // rather than by the UI: `idle` is a measurement and `offline` is the
      // absence of a connection, so neither is anybody's to assert.
      for (const status of ["idle", "offline", "away"]) {
        const res = await call(owner, "PATCH", "/api/me/preferences", { status });
        expect(res.status).toBe(400);
      }
      const unchanged = await call<PrefsBody>(owner, "GET", "/api/me");
      expect(unchanged.body.preferences).toEqual({ status: "invisible" });
    });

    it("rejects unauthenticated writes", async () => {
      const res = await call(null, "PATCH", "/api/me/preferences", {
        theme: "dark",
      });
      expect(res.status).toBe(401);
    });
  });

  describe("gifs", () => {
    interface GifsBody {
      gifs: Array<Record<string, unknown>>;
    }

    /** One upstream entry, shaped like GIPHY's — trimmed to what we read. */
    function giphyEntry(overrides: Record<string, unknown> = {}) {
      return {
        id: "abc123",
        title: "a cat  ",
        images: {
          downsized_medium: {
            url: "https://media3.giphy.com/media/abc123/giphy.gif?cid=track&ct=g",
            width: "480",
            height: "270",
          },
          fixed_width: {
            url: "https://media3.giphy.com/media/abc123/200w.gif?cid=track",
            width: "200",
            height: "112",
          },
          fixed_width_still: {
            url: "https://media3.giphy.com/media/abc123/200w_s.gif",
            width: "200",
            height: "112",
          },
        },
        ...overrides,
      };
    }

    /** URLs GIPHY was asked for, so the forced parameters can be asserted. */
    let upstreamCalls: string[];
    let upstreamReply: () => Response;
    const realFetch = globalThis.fetch;

    beforeEach(() => {
      upstreamCalls = [];
      upstreamReply = () =>
        new Response(JSON.stringify({ data: [giphyEntry()] }), {
          headers: { "Content-Type": "application/json" },
        });

      process.env.GIPHY_API_KEY = "test-key";
      // Only GIPHY is intercepted: `call()` reaches the API under test with the
      // same global, and stubbing that too would break every request here.
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = String(input);
        if (!url.startsWith("https://api.giphy.com/")) {
          return realFetch(input, init);
        }
        upstreamCalls.push(url);
        return Promise.resolve(upstreamReply());
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      delete process.env.GIPHY_API_KEY;
    });

    it("normalises upstream results to the wire shape and drops tracking", async () => {
      const res = await call<GifsBody>(owner, "GET", "/api/gifs/search?q=cat");
      expect(res.status).toBe(200);
      expect(res.body.gifs).toEqual([
        {
          id: "abc123",
          // The chosen URL becomes a message body that outlives the session
          // that fetched it, so the per-request analytics id must not ride along.
          url: "https://media3.giphy.com/media/abc123/giphy.gif",
          previewUrl: "https://media3.giphy.com/media/abc123/200w.gif",
          previewStillUrl: "https://media3.giphy.com/media/abc123/200w_s.gif",
          width: 200,
          height: 112,
          title: "a cat",
        },
      ]);
    });

    it("forces a pg-13 rating on every upstream call", async () => {
      await call(owner, "GET", "/api/gifs/search?q=cat");
      await call(owner, "GET", "/api/gifs/trending");
      expect(upstreamCalls).toHaveLength(2);
      for (const url of upstreamCalls) {
        expect(new URL(url).searchParams.get("rating")).toBe("pg-13");
      }
    });

    it("never leaks the API key to the caller", async () => {
      const res = await call(owner, "GET", "/api/gifs/search?q=cat");
      expect(JSON.stringify(res.body)).not.toContain("test-key");
      expect(new URL(upstreamCalls[0]!).searchParams.get("api_key")).toBe(
        "test-key",
      );
    });

    it("clamps the page size a caller may ask for", async () => {
      await call(owner, "GET", "/api/gifs/trending?limit=5000");
      expect(new URL(upstreamCalls[0]!).searchParams.get("limit")).toBe("50");
    });

    it("drops a result whose media host is outside the allowlist", async () => {
      // A provider that ever served a third-party URL would otherwise get an
      // <img> pointed at it in every reader's browser.
      upstreamReply = () =>
        new Response(
          JSON.stringify({
            data: [
              giphyEntry({
                images: {
                  original: { url: "https://evil.example/x.gif", width: "1", height: "1" },
                },
              }),
              giphyEntry(),
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        );

      const res = await call<GifsBody>(owner, "GET", "/api/gifs/trending");
      expect(res.body.gifs).toHaveLength(1);
      expect(res.body.gifs[0]!.url).toBe(
        "https://media3.giphy.com/media/abc123/giphy.gif",
      );
    });

    it("rejects a search with no query", async () => {
      const res = await call(owner, "GET", "/api/gifs/search");
      expect(res.status).toBe(400);
      expect(upstreamCalls).toHaveLength(0);
    });

    it("answers 502 when the provider fails, not 500", async () => {
      upstreamReply = () => new Response("nope", { status: 500 });
      const res = await call(owner, "GET", "/api/gifs/trending");
      expect(res.status).toBe(502);
    });

    it("reports itself disabled and refuses with 503 when no key is set", async () => {
      delete process.env.GIPHY_API_KEY;

      const config = await call<{ enabled: boolean }>(
        owner,
        "GET",
        "/api/gifs/config",
      );
      expect(config.body.enabled).toBe(false);

      for (const path of ["/api/gifs/search?q=cat", "/api/gifs/trending"]) {
        const res = await call(owner, "GET", path);
        expect(res.status).toBe(503);
      }
      expect(upstreamCalls).toHaveLength(0);
    });

    it("treats a placeholder key as no key at all", async () => {
      // `.env.example` copies are the usual source of this.
      process.env.GIPHY_API_KEY = "your-giphy-api-key";
      const res = await call(owner, "GET", "/api/gifs/trending");
      expect(res.status).toBe(503);
    });

    it("reports itself enabled when a key is set", async () => {
      const res = await call<{ enabled: boolean }>(
        owner,
        "GET",
        "/api/gifs/config",
      );
      expect(res.body.enabled).toBe(true);
    });

    it("spends someone else's quota only for signed-in callers", async () => {
      const res = await call(null, "GET", "/api/gifs/search?q=cat");
      expect(res.status).toBe(401);
      expect(upstreamCalls).toHaveLength(0);
    });

    it("rate limits search harder than ordinary reads", async () => {
      let last = 200;
      for (let attempt = 0; attempt < 40 && last === 200; attempt += 1) {
        last = (await call(owner, "GET", "/api/gifs/trending")).status;
      }
      expect(last).toBe(429);
      // The bucket is spent before the provider is called again.
      expect(upstreamCalls.length).toBeLessThan(40);
    });
  });

  describe("attachments", () => {
    /**
     * Storage that is configured but never contacted. Presigning is pure HMAC
     * over strings, so the routes under test — mint, refresh, read — need
     * credentials to exist and a bucket to name, and nothing else. The signature
     * itself is proved against a real MinIO in `lib/s3.test.ts`.
     */
    function configureStorage() {
      process.env.S3_ENDPOINT = "https://storage.test";
      process.env.S3_BUCKET = "pqp-test";
      process.env.S3_ACCESS_KEY_ID = "test-access-key";
      process.env.S3_SECRET_ACCESS_KEY = "test-secret-key";
      process.env.S3_FORCE_PATH_STYLE = "true";
    }

    afterEach(() => {
      for (const name of [
        "S3_ENDPOINT",
        "S3_BUCKET",
        "S3_ACCESS_KEY_ID",
        "S3_SECRET_ACCESS_KEY",
        "S3_FORCE_PATH_STYLE",
        "MAX_ATTACHMENT_BYTES",
      ]) {
        delete process.env[name];
      }
    });

    function mintBody(overrides: Record<string, unknown> = {}) {
      return {
        filename: "shot.png",
        contentType: "image/png",
        byteSize: 1024,
        ...overrides,
      };
    }

    async function postMessage(channelId: string, author = owner) {
      const result = await getPool().query<{ id: string }>(
        `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'look')
         RETURNING id`,
        [channelId, author.id],
      );
      return result.rows[0]!.id;
    }

    /**
     * A claimed attachment, inserted directly. The claim path needs a real HEAD
     * against a real object to accept anything, and it has its own suite; what
     * these tests are about is who the API will hand the row to afterwards.
     */
    async function seedAttachment(
      channelId: string,
      messageId: string,
      uploader = owner,
    ) {
      const result = await getPool().query<{ id: string }>(
        `INSERT INTO message_attachments
           (message_id, channel_id, uploader_id, storage_key, filename,
            content_type, byte_size)
         VALUES ($1, $2, $3, $4, 'shot.png', 'image/png', 1024)
         RETURNING id`,
        [messageId, channelId, uploader.id, `${channelId}/seeded.png`],
      );
      return result.rows[0]!.id;
    }

    async function attachmentCount(): Promise<number> {
      const result = await getPool().query(`SELECT 1 FROM message_attachments`);
      return result.rowCount ?? 0;
    }

    it("reports whether this deployment can accept uploads at all", async () => {
      const off = await call<{ enabled: boolean }>(
        owner,
        "GET",
        "/api/attachments/config",
      );
      expect(off.status).toBe(200);
      expect(off.body.enabled).toBe(false);

      configureStorage();
      const on = await call<{ enabled: boolean; maxBytes: number }>(
        owner,
        "GET",
        "/api/attachments/config",
      );
      expect(on.body.enabled).toBe(true);
      // The composer sizes its own check off this, so it has to be the number
      // the server would actually enforce.
      expect(on.body.maxBytes).toBe(10 * 1024 * 1024);
    });

    it("refuses to mint an upload URL for a channel the caller cannot see", async () => {
      configureStorage();
      const { serverId, textChannelId } = await makeServer();

      const byOutsider = await call(
        outsider,
        "POST",
        `/api/channels/${textChannelId}/attachments`,
        mintBody(),
      );
      expect(byOutsider.status).toBe(404);

      const created = await call<{ channel: { id: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/channels`,
        { name: "secret", type: "text", isPrivate: true },
      );
      const byNonMember = await call(
        member,
        "POST",
        `/api/channels/${created.body.channel.id}/attachments`,
        mintBody(),
      );
      expect(byNonMember.status).toBe(404);

      // Not even a reserved row: minting *is* the write, and a refused caller
      // must not be able to leave anything behind for the sweeper to pay for.
      expect(await attachmentCount()).toBe(0);

      const allowed = await call<{ attachmentId: string; uploadUrl: string }>(
        member,
        "POST",
        `/api/channels/${textChannelId}/attachments`,
        mintBody(),
      );
      expect(allowed.status).toBe(201);
      expect(allowed.body.uploadUrl).toContain("X-Amz-Signature");
      // The key is the server's, derived from the content type — never the
      // filename the caller sent.
      const stored = await getPool().query<{ storage_key: string }>(
        `SELECT storage_key FROM message_attachments WHERE id = $1`,
        [allowed.body.attachmentId],
      );
      expect(stored.rows[0]!.storage_key).not.toContain("shot");
    });

    it("refuses to mint anything on a deployment with no storage", async () => {
      const { textChannelId } = await makeServer();
      const res = await call(
        owner,
        "POST",
        `/api/channels/${textChannelId}/attachments`,
        mintBody(),
      );
      expect(res.status).toBe(503);
      expect(await attachmentCount()).toBe(0);
    });

    it("stages a GIF on a deployment with no storage at all", async () => {
      // The common shape is GIF search on and S3 off. A GIF's bytes never reach
      // our bucket, so gating this on storage would break the GIF button on
      // exactly the deployment that has GIFs working — which is production.
      const { textChannelId } = await makeServer();
      const res = await call<{ attachment: { id: string; url: string } }>(
        owner,
        "POST",
        `/api/channels/${textChannelId}/attachments/gif`,
        {
          url: "https://media0.giphy.com/media/abc/giphy.gif",
          width: 480,
          height: 270,
          title: "a cat",
        },
      );
      expect(res.status).toBe(201);
      // Handed back verbatim: there is nothing to sign on a host we do not own.
      expect(res.body.attachment.url).toBe(
        "https://media0.giphy.com/media/abc/giphy.gif",
      );
    });

    it("refuses a remote attachment on a host outside the allowlist", async () => {
      // The allowlist is the entire boundary here. Without it this route
      // renders an attacker-chosen URL as an image inside a private channel,
      // which leaks every viewer's IP to that host on render.
      const { textChannelId } = await makeServer();
      const res = await call(
        owner,
        "POST",
        `/api/channels/${textChannelId}/attachments/gif`,
        { url: "https://evil.example.com/tracker.gif" },
      );
      expect(res.status).toBe(400);
      expect(await attachmentCount()).toBe(0);
    });

    it("serves a staged GIF in history while storage stays unconfigured", async () => {
      const { textChannelId } = await makeServer();
      const staged = await call<{ attachment: { id: string } }>(
        owner,
        "POST",
        `/api/channels/${textChannelId}/attachments/gif`,
        { url: "https://media0.giphy.com/media/abc/giphy.gif", title: "cat" },
      );
      await handleChatMessage(
        { socket: fakeSocket(), user: await asDbUser(owner.id) },
        {
          type: "message-create",
          channelId: textChannelId,
          body: "look",
          attachmentIds: [staged.body.attachment.id],
        },
      );

      const history = await call<{
        messages: Array<{ body: string; attachments: Array<{ url: string }> }>;
      }>(owner, "GET", `/api/channels/${textChannelId}/messages`);
      // The caption is the body, so editing it never exposes the URL — the
      // whole reason a GIF became an attachment rather than the message.
      expect(history.body.messages[0]!.body).toBe("look");
      expect(history.body.messages[0]!.attachments).toHaveLength(1);
    });

    it("answers 413 for a file over this deployment's own cap", async () => {
      configureStorage();
      // Under the shared ceiling the schema enforces, over what this server has
      // been told to accept — the only case that reaches the service's check.
      process.env.MAX_ATTACHMENT_BYTES = "1024";
      const { textChannelId } = await makeServer();

      const res = await call(
        owner,
        "POST",
        `/api/channels/${textChannelId}/attachments`,
        mintBody({ byteSize: 4096 }),
      );
      expect(res.status).toBe(413);
    });

    it("rejects a content type outside the allowlist", async () => {
      configureStorage();
      const { textChannelId } = await makeServer();
      const res = await call(
        owner,
        "POST",
        `/api/channels/${textChannelId}/attachments`,
        mintBody({ filename: "payload.html", contentType: "text/html" }),
      );
      expect(res.status).toBe(400);
      expect(await attachmentCount()).toBe(0);
    });

    it("hands a fresh URL only to someone who can see the channel", async () => {
      configureStorage();
      const { serverId } = await makeServer();
      const created = await call<{ channel: { id: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/channels`,
        { name: "secret", type: "text", isPrivate: true },
      );
      const privateId = created.body.channel.id;
      const attachmentId = await seedAttachment(
        privateId,
        await postMessage(privateId),
      );

      // 404 rather than 403, so refreshing a guessed id cannot be used to learn
      // that an attachment exists in a channel you are not in.
      expect(
        (await call(member, "GET", `/api/attachments/${attachmentId}/url`))
          .status,
      ).toBe(404);
      expect(
        (await call(outsider, "GET", `/api/attachments/${attachmentId}/url`))
          .status,
      ).toBe(404);

      const fresh = await call<{ url: string; expiresAt: string }>(
        owner,
        "GET",
        `/api/attachments/${attachmentId}/url`,
      );
      expect(fresh.status).toBe(200);
      expect(fresh.body.url).toContain("X-Amz-Signature");
      expect(Date.parse(fresh.body.expiresAt)).toBeGreaterThan(Date.now());

      // Granting access opens it, on the same predicate as history.
      await call(owner, "POST", `/api/channels/${privateId}/members`, {
        userId: member.id,
      });
      expect(
        (await call(member, "GET", `/api/attachments/${attachmentId}/url`))
          .status,
      ).toBe(200);
    });

    it("hides an attachment no message has claimed", async () => {
      configureStorage();
      const { textChannelId } = await makeServer();
      const minted = await call<{ attachmentId: string }>(
        owner,
        "POST",
        `/api/channels/${textChannelId}/attachments`,
        mintBody(),
      );

      // Until a message carries it, an upload is not content anyone can read —
      // not even the person who uploaded it.
      expect(
        (
          await call(
            owner,
            "GET",
            `/api/attachments/${minted.body.attachmentId}/url`,
          )
        ).status,
      ).toBe(404);
    });

    it("carries attachments on history, one presigned URL per row", async () => {
      configureStorage();
      const { textChannelId } = await makeServer();
      const messageId = await postMessage(textChannelId);
      await seedAttachment(textChannelId, messageId);

      const res = await call<{
        messages: Array<{
          attachments: Array<{ filename: string; byteSize: number; url: string }>;
        }>;
      }>(owner, "GET", `/api/channels/${textChannelId}/messages`);

      const [attachment] = res.body.messages[0]!.attachments;
      expect(attachment!.filename).toBe("shot.png");
      // BIGINT arrives from node-postgres as a string; a read that forgot to
      // convert it fails `attachmentSchema` on the client.
      expect(attachment!.byteSize).toBe(1024);
      expect(attachment!.url).toContain("X-Amz-Signature");
    });

    it("does not post an empty message when every attachment failed", async () => {
      configureStorage();
      const { textChannelId } = await makeServer();
      const minted = await call<{ attachmentId: string }>(
        owner,
        "POST",
        `/api/channels/${textChannelId}/attachments`,
        mintBody(),
      );

      // Nothing was ever uploaded, so the HEAD guarding the claim finds nothing
      // and the attachment is dropped. A message whose only content was that
      // file is then not a message at all, and the frame goes the way every
      // other frame that describes nothing goes.
      await handleChatMessage(
        { socket: fakeSocket(), user: await asDbUser(owner.id) },
        {
          type: "message-create",
          channelId: textChannelId,
          body: "",
          attachmentIds: [minted.body.attachmentId],
        },
      );

      const history = await call<{ messages: unknown[] }>(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages`,
      );
      expect(history.body.messages).toHaveLength(0);
      // The reserved row survives the rollback and is left to the sweeper,
      // which is the only thing that ever deletes an unclaimed upload.
      expect(await attachmentCount()).toBe(1);
    });

    it("lets a message with attachments be edited down to no caption", async () => {
      configureStorage();
      const { textChannelId } = await makeServer();
      const plain = await postMessage(textChannelId);
      const withFile = await postMessage(textChannelId);
      await seedAttachment(textChannelId, withFile);

      // Text and nothing else has nothing left when the text goes: that is a
      // delete, and the edit schema keeps refusing it.
      expect(
        (await call(owner, "PATCH", `/api/messages/${plain}`, { body: "" }))
          .status,
      ).toBe(400);

      const edited = await call<{
        message: { body: string; attachments: unknown[] };
      }>(owner, "PATCH", `/api/messages/${withFile}`, { body: "" });
      expect(edited.status).toBe(200);
      expect(edited.body.message.body).toBe("");
      expect(edited.body.message.attachments).toHaveLength(1);
    });
  });

  describe("message search", () => {
    interface SearchBody {
      results: Array<{
        messageId: string;
        channelId: string;
        channelName: string;
        authorName: string;
        snippet: string;
        createdAt: string;
      }>;
      hasMore: boolean;
      nextCursor: string | null;
    }

    async function seed(channelId: string, body: string, author = owner) {
      const result = await getPool().query<{ id: string }>(
        `INSERT INTO messages (channel_id, author_id, body)
         VALUES ($1, $2, $3) RETURNING id`,
        [channelId, author.id, body],
      );
      return result.rows[0]!.id;
    }

    function search(
      as: { id: string; clerk_id: string },
      serverId: string,
      query: string,
      extra = "",
    ) {
      return call<SearchBody>(
        as,
        "GET",
        `/api/servers/${serverId}/search?q=${encodeURIComponent(query)}${extra}`,
      );
    }

    it("finds a message and says which channel it lives in", async () => {
      const { serverId, textChannelId } = await makeServer();
      const messageId = await seed(textChannelId, "the penguin waddles home");
      await seed(textChannelId, "nothing to see here");

      const res = await search(owner, serverId, "penguin");
      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);

      const [hit] = res.body.results;
      expect(hit!.messageId).toBe(messageId);
      expect(hit!.channelId).toBe(textChannelId);
      expect(hit!.channelName).toBe("general");
      expect(hit!.authorName).toBe("Owner");
      // The snippet marks the matched term rather than returning HTML.
      expect(
        parseSearchSnippet(hit!.snippet)
          .filter((segment) => segment.match)
          .map((segment) => segment.text),
      ).toContain("penguin");
    });

    it("stems, so a search finds the other forms of a word", async () => {
      const { serverId, textChannelId } = await makeServer();
      await seed(textChannelId, "we are deploying on friday");

      const res = await search(owner, serverId, "deploy");
      expect(res.body.results).toHaveLength(1);
    });

    it("never returns a private channel's messages to a non-member", async () => {
      const { serverId } = await makeServer();
      const created = await call<{ channel: { id: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/channels`,
        { name: "secret", type: "text", isPrivate: true },
      );
      const privateId = created.body.channel.id;
      await seed(privateId, "the passphrase is armadillo");

      const hidden = await search(member, serverId, "armadillo");
      expect(hidden.status).toBe(200);
      expect(hidden.body.results).toHaveLength(0);

      // Owners and admins keep access without a channel_members row, exactly as
      // the channel list and history do.
      expect((await search(owner, serverId, "armadillo")).body.results).toHaveLength(1);
      expect((await search(admin, serverId, "armadillo")).body.results).toHaveLength(1);

      await call(owner, "POST", `/api/channels/${privateId}/members`, {
        userId: member.id,
      });
      const granted = await search(member, serverId, "armadillo");
      expect(granted.body.results.map((r) => r.channelId)).toEqual([privateId]);
    });

    it("keeps results inside the server that was asked about", async () => {
      const mine = await makeServer();
      const other = await makeServer();
      await seed(mine.textChannelId, "shared word narwhal here");
      const elsewhere = await seed(other.textChannelId, "narwhal over there");

      const res = await search(owner, mine.serverId, "narwhal");
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results.map((r) => r.messageId)).not.toContain(elsewhere);
    });

    it("hides search from someone who is not in the server", async () => {
      const { serverId, textChannelId } = await makeServer();
      await seed(textChannelId, "narwhal");
      const res = await search(outsider, serverId, "narwhal");
      expect(res.status).toBe(404);
    });

    it("paginates without repeating or skipping a result", async () => {
      const { serverId, textChannelId } = await makeServer();
      const seeded: string[] = [];
      for (let i = 0; i < 5; i++) {
        // Varying length and repetition so the rows do not all rank identically,
        // which is what makes the rank half of the cursor load-bearing.
        seeded.push(
          await seed(
            textChannelId,
            i % 2 === 0
              ? `otter ${"padding ".repeat(i + 1)}`
              : `otter otter sighting ${i}`,
          ),
        );
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const res: ApiResult<SearchBody> = await search(
          owner,
          serverId,
          "otter",
          `&limit=2${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`,
        );
        expect(res.status).toBe(200);
        seen.push(...res.body.results.map((r) => r.messageId));
        cursor = res.body.nextCursor;
        if (!res.body.hasMore) {
          break;
        }
      }

      expect(new Set(seen).size).toBe(seen.length);
      expect([...seen].sort()).toEqual([...seeded].sort());
    });

    it("rejects a query that is too short, and a forged cursor, with 400", async () => {
      const { serverId } = await makeServer();
      expect((await search(owner, serverId, "a")).status).toBe(400);
      expect(
        (await search(owner, serverId, "otter", "&before=not-a-cursor")).status,
      ).toBe(400);
    });

    it("rate limits search harder than ordinary reads", async () => {
      const { serverId } = await makeServer();
      let last = 200;
      for (let attempt = 0; attempt < 40 && last === 200; attempt += 1) {
        last = (await search(owner, serverId, "otter")).status;
      }
      expect(last).toBe(429);
    });
  });

  describe("user discovery", () => {
    /** The whole shape a search result may ever have. */
    const PUBLIC_KEYS = ["avatarUrl", "displayName", "id", "tag", "username"];

    async function tagOf(userId: string): Promise<string> {
      const row = await getPool().query<{ username: string; discrim: string }>(
        `SELECT username, discriminator AS discrim FROM users WHERE id = $1`,
        [userId],
      );
      return `${row.rows[0]!.username}#${row.rows[0]!.discrim}`;
    }

    it("finds a user by exact tag, and never carries a clerk id", async () => {
      const tag = await tagOf(member.id);
      const res = await call<{ user: Record<string, unknown> }>(
        outsider,
        "GET",
        `/api/users/lookup?tag=${encodeURIComponent(tag)}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(member.id);
      expect(Object.keys(res.body.user).sort()).toEqual(PUBLIC_KEYS);
    });

    it("answers 400 for something that is not a tag and 404 for one nobody holds", async () => {
      expect(
        (await call(owner, "GET", "/api/users/lookup?tag=member")).status,
      ).toBe(400);
      expect(
        (await call(owner, "GET", "/api/users/lookup?tag=nobody%230001"))
          .status,
      ).toBe(404);
    });

    it("searches by prefix, excludes the caller, and stays inside the public shape", async () => {
      const res = await call<{ users: Array<Record<string, unknown>> }>(
        outsider,
        "GET",
        "/api/users/search?q=me",
      );
      expect(res.status).toBe(200);
      expect(res.body.users.map((u) => u.id)).toEqual([member.id]);
      expect(Object.keys(res.body.users[0]!).sort()).toEqual(PUBLIC_KEYS);

      const self = await call<{ users: Array<{ id: string }> }>(
        member,
        "GET",
        "/api/users/search?q=me",
      );
      expect(self.body.users.map((u) => u.id)).not.toContain(member.id);
    });

    it("refuses a query below the minimum length", async () => {
      expect((await call(owner, "GET", "/api/users/search?q=m")).status).toBe(
        400,
      );
    });

    it("does not let a LIKE wildcard widen a search", async () => {
      // `_` is legal in a username and is also a LIKE wildcard, so an
      // unescaped query turns a search for one person into a pattern match
      // over the directory.
      await getPool().query(`UPDATE users SET username = 'ab_cd' WHERE id = $1`, [
        member.id,
      ]);
      await getPool().query(`UPDATE users SET username = 'abxcd' WHERE id = $1`, [
        admin.id,
      ]);

      const res = await call<{ users: Array<{ id: string }> }>(
        outsider,
        "GET",
        "/api/users/search?q=ab_c",
      );
      expect(res.body.users.map((u) => u.id)).toEqual([member.id]);
    });

    it("throttles discovery on its own bucket", async () => {
      let last = 200;
      for (let i = 0; i < 25 && last === 200; i++) {
        last = (await call(owner, "GET", "/api/users/search?q=me")).status;
      }
      expect(last).toBe(429);
    });
  });

  describe("blocking", () => {
    it("blocks, lists and unblocks", async () => {
      const first = await call(member, "POST", "/api/blocks", {
        userId: outsider.id,
      });
      expect(first.status).toBe(201);
      // Blocking somebody already blocked is not an error and not a new block.
      expect(
        (await call(member, "POST", "/api/blocks", { userId: outsider.id }))
          .status,
      ).toBe(200);

      const listed = await call<{
        blocked: Array<Record<string, unknown>>;
      }>(member, "GET", "/api/blocks");
      expect(listed.body.blocked.map((b) => b.id)).toEqual([outsider.id]);
      expect(Object.keys(listed.body.blocked[0]!).sort()).toEqual([
        "avatarUrl",
        "blockedAt",
        "displayName",
        "id",
        "tag",
        "username",
      ]);

      expect(
        (await call(member, "DELETE", `/api/blocks/${outsider.id}`)).status,
      ).toBe(200);
      expect(
        (await call<{ blocked: unknown[] }>(member, "GET", "/api/blocks")).body
          .blocked,
      ).toHaveLength(0);
    });

    it("refuses to block yourself or somebody who does not exist", async () => {
      expect(
        (await call(member, "POST", "/api/blocks", { userId: member.id }))
          .status,
      ).toBe(400);
      expect(
        (
          await call(member, "POST", "/api/blocks", {
            userId: "00000000-0000-4000-8000-000000000000",
          })
        ).status,
      ).toBe(404);
    });

    it("shows a block only to the person who made it", async () => {
      await call(member, "POST", "/api/blocks", { userId: outsider.id });
      const theirs = await call<{ blocked: unknown[] }>(
        outsider,
        "GET",
        "/api/blocks",
      );
      expect(theirs.body.blocked).toHaveLength(0);
    });
  });

  describe("conversations", () => {
    /** Both are members of the same server, so the default privacy allows it. */
    async function openWith(
      as: { id: string; clerk_id: string },
      userIds: string[],
    ) {
      return call<{ conversation: { channelId: string } }>(as, "POST", "/api/dms", {
        userIds,
      });
    }

    async function send(
      as: { id: string; clerk_id: string },
      channelId: string,
      body: string,
    ) {
      await handleChatMessage(
        { socket: fakeSocket(), user: await asDbUser(as.id) },
        { type: "message-create", channelId, body },
      );
    }

    it("creates once and reuses after that", async () => {
      await makeServer();
      const first = await openWith(member, [admin.id]);
      expect(first.status).toBe(201);

      const again = await openWith(admin, [member.id]);
      expect(again.status).toBe(200);
      expect(again.body.conversation.channelId).toBe(
        first.body.conversation.channelId,
      );
    });

    it("hides a conversation from a non-participant and from the server's owner", async () => {
      // The owner runs the server both of them are in. That must buy nothing:
      // a server administrator has no business in their members' messages.
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;

      for (const stranger of [owner, outsider]) {
        expect(
          (await call(stranger, "GET", `/api/channels/${channelId}/messages`))
            .status,
        ).toBe(404);
        expect(
          (await call(stranger, "POST", `/api/channels/${channelId}/read`))
            .status,
        ).toBe(404);
        const theirList = await call<{ conversations: unknown[] }>(
          stranger,
          "GET",
          "/api/dms",
        );
        expect(theirList.body.conversations).toHaveLength(0);
      }
    });

    it("cannot be administered as if it were a server channel", async () => {
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;

      // Every one of these goes on to ask a question about the channel's
      // server, and a conversation has none.
      expect(
        (await call(member, "PATCH", `/api/channels/${channelId}`, {
          name: "renamed",
        })).status,
      ).toBe(404);
      expect(
        (await call(member, "DELETE", `/api/channels/${channelId}`)).status,
      ).toBe(404);
      expect(
        (await call(member, "GET", `/api/channels/${channelId}/members`)).status,
      ).toBe(404);
      expect(
        (
          await call(member, "POST", `/api/channels/${channelId}/members`, {
            userId: owner.id,
          })
        ).status,
      ).toBe(404);
    });

    it("carries messages, unread and history on the ordinary channel routes", async () => {
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;

      await send(admin, channelId, "just between us");

      const history = await call<{ messages: Array<{ body: string }> }>(
        member,
        "GET",
        `/api/channels/${channelId}/messages`,
      );
      expect(history.body.messages.map((m) => m.body)).toEqual([
        "just between us",
      ]);

      const list = await call<{
        conversations: Array<{
          channelId: string;
          kind: string;
          participants: Array<{ id: string }>;
          unread: { count: number };
        }>;
      }>(member, "GET", "/api/dms");
      expect(list.body.conversations).toHaveLength(1);
      expect(list.body.conversations[0]!.kind).toBe("dm");
      expect(list.body.conversations[0]!.unread.count).toBe(1);
      expect(list.body.conversations[0]!.participants.map((p) => p.id)).toEqual([
        admin.id,
      ]);

      await call(member, "POST", `/api/channels/${channelId}/read`);
      const afterRead = await call<{
        conversations: Array<{ unread: { count: number } }>;
      }>(member, "GET", "/api/dms");
      expect(afterRead.body.conversations[0]!.unread.count).toBe(0);
    });

    it("has no moderators: a server admin cannot delete a message in one", async () => {
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;
      await send(member, channelId, "mine");

      const history = await call<{ messages: Array<{ id: string }> }>(
        member,
        "GET",
        `/api/channels/${channelId}/messages`,
      );
      const messageId = history.body.messages[0]!.id;

      // admin is a participant *and* an admin of the shared server. Being an
      // admin is what must not help: there is no server to manage here.
      expect(
        (await call(admin, "DELETE", `/api/messages/${messageId}`)).status,
      ).toBe(403);
      expect(
        (await call(member, "DELETE", `/api/messages/${messageId}`)).status,
      ).toBe(200);
    });

    it("refuses when either party has blocked the other", async () => {
      await makeServer();
      await call(admin, "POST", "/api/blocks", { userId: member.id });

      expect((await openWith(member, [admin.id])).status).toBe(403);
      // Symmetric: the blocker cannot reach through their own block either.
      expect((await openWith(admin, [member.id])).status).toBe(403);
    });

    it("drops a message into a 1:1 once a block goes up", async () => {
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;

      await call(admin, "POST", "/api/blocks", { userId: member.id });
      await send(member, channelId, "let me in");

      const history = await call<{ messages: unknown[] }>(
        admin,
        "GET",
        `/api/channels/${channelId}/messages`,
      );
      expect(history.body.messages).toHaveLength(0);
    });

    it("refuses everyone once dm_privacy is 'nobody'", async () => {
      await makeServer();
      expect(
        (await call(admin, "PATCH", "/api/me", { dmPrivacy: "nobody" })).status,
      ).toBe(200);

      // Even a co-member of the same server.
      expect((await openWith(member, [admin.id])).status).toBe(403);
      expect((await openWith(outsider, [admin.id])).status).toBe(403);
    });

    it("under 'server_members' refuses a stranger and allows a co-member", async () => {
      await makeServer();
      // outsider shares no server with anyone; member and admin share one.
      expect((await openWith(outsider, [admin.id])).status).toBe(403);
      expect((await openWith(member, [admin.id])).status).toBe(201);
    });

    it("under 'everyone' allows a complete stranger", async () => {
      await call(admin, "PATCH", "/api/me", { dmPrivacy: "everyone" });
      expect((await openWith(outsider, [admin.id])).status).toBe(201);
    });

    it("reports dm_privacy back on /api/me", async () => {
      const before = await call<{ dmPrivacy: string }>(admin, "GET", "/api/me");
      expect(before.body.dmPrivacy).toBe("server_members");

      await call(admin, "PATCH", "/api/me", { dmPrivacy: "nobody" });
      const after = await call<{ dmPrivacy: string }>(admin, "GET", "/api/me");
      expect(after.body.dmPrivacy).toBe("nobody");
    });

    it("closes a conversation for one side without deleting anything", async () => {
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;
      await send(admin, channelId, "history");

      expect(
        (await call(member, "DELETE", `/api/dms/${channelId}`)).status,
      ).toBe(200);
      expect(
        (await call<{ conversations: unknown[] }>(member, "GET", "/api/dms"))
          .body.conversations,
      ).toHaveLength(0);
      // The other side is untouched, and so is the history.
      expect(
        (await call<{ conversations: unknown[] }>(admin, "GET", "/api/dms")).body
          .conversations,
      ).toHaveLength(1);

      // The next thing said in it brings the conversation back with its
      // history, rather than dropping the message on the floor.
      await send(admin, channelId, "still here?");
      const back = await call<{
        conversations: Array<{ channelId: string }>;
      }>(member, "GET", "/api/dms");
      expect(back.body.conversations.map((c) => c.channelId)).toEqual([
        channelId,
      ]);
      const history = await call<{ messages: unknown[] }>(
        member,
        "GET",
        `/api/channels/${channelId}/messages`,
      );
      expect(history.body.messages).toHaveLength(2);
    });

    it("keeps a block in force after the blocker closes the conversation", async () => {
      // The whole sequence, end to end: block, close, and then the blocked
      // person says something. Closing removes the blocker's own membership
      // row, and a guard that resolved the counterparty through that row let
      // the message through *and* restored the blocker into the conversation,
      // so it reappeared in their list carrying the message they blocked to
      // avoid. Nothing about that is visible to the person who blocked.
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;

      await call(admin, "POST", "/api/blocks", { userId: member.id });
      expect(
        (await call(admin, "DELETE", `/api/dms/${channelId}`)).status,
      ).toBe(200);

      await send(member, channelId, "let me in");

      const stored = await getPool().query(
        `SELECT id FROM messages WHERE channel_id = $1`,
        [channelId],
      );
      expect(stored.rows).toHaveLength(0);
      expect(
        (await call<{ conversations: unknown[] }>(admin, "GET", "/api/dms")).body
          .conversations,
      ).toHaveLength(0);
    });

    it("enforces a block in a group once it has shrunk to two people", async () => {
      // A group never becomes a 'dm', so gating enforcement on kind left this
      // channel exempt for good once the third participant closed it.
      await makeServer();
      const opened = await openWith(member, [admin.id, owner.id]);
      const channelId = opened.body.conversation.channelId;
      expect(
        (await call(owner, "DELETE", `/api/dms/${channelId}`)).status,
      ).toBe(200);

      await call(admin, "POST", "/api/blocks", { userId: member.id });
      await send(member, channelId, "the group is our back door");

      const stored = await getPool().query(
        `SELECT id FROM messages WHERE channel_id = $1`,
        [channelId],
      );
      expect(stored.rows).toHaveLength(0);
    });

    it("records a mention into a 1:1 the recipient had closed", async () => {
      // `recordMentions` resolves a conversation's mentionable set through
      // `channel_members`, so restoring the recipient after the insert left
      // them out of their own mention: the live badge says "mention" and the
      // badge after a refresh says none.
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;
      expect(
        (await call(member, "DELETE", `/api/dms/${channelId}`)).status,
      ).toBe(200);

      const memberRow = await asDbUser(member.id);
      await send(admin, channelId, `come back @${memberRow.username}`);

      const mentions = await getPool().query<{ user_id: string }>(
        `SELECT user_id FROM message_mentions`,
      );
      expect(mentions.rows.map((row) => row.user_id)).toEqual([member.id]);

      const list = await call<{
        conversations: Array<{ unread: { count: number; mentions: number } }>;
      }>(member, "GET", "/api/dms");
      expect(list.body.conversations[0]!.unread).toEqual({
        count: 1,
        mentions: 1,
      });
    });

    it("evicts the closer's live view, and nobody else's", async () => {
      // Closing drops the membership row but the socket's channelId survives,
      // and `broadcastToChannel` fans out on that field alone — the client
      // sends no leave frame here. Without the eviction the person who closed
      // the conversation goes on receiving its message bodies, reactions and
      // typing frames for as long as the socket lives.
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;

      const closer = recordingSocket();
      await handleChatMessage(
        { socket: closer.socket, user: await asDbUser(member.id) },
        { type: "join-channel", channelId },
      );
      const stayer = recordingSocket();
      await handleChatMessage(
        { socket: stayer.socket, user: await asDbUser(admin.id) },
        { type: "join-channel", channelId },
      );

      expect(
        (await call(member, "DELETE", `/api/dms/${channelId}`)).status,
      ).toBe(200);
      closer.received.length = 0;
      stayer.received.length = 0;

      await handleChatMessage(
        { socket: stayer.socket, user: await asDbUser(admin.id) },
        { type: "message-create", channelId, body: "are you still reading?" },
      );
      expect(typesOf(closer.received)).not.toContain("message-broadcast");

      // And only the closer: the other participant never left, so the next
      // thing said still reaches them.
      closer.received.length = 0;
      stayer.received.length = 0;
      await handleChatMessage(
        { socket: closer.socket, user: await asDbUser(member.id) },
        { type: "message-create", channelId, body: "i am" },
      );
      expect(typesOf(stayer.received)).toContain("message-broadcast");
    });

    it("does not let a blocked person type into the blocker's conversation", async () => {
      // A typing indicator is a notification like any other, and the client
      // does not filter it — without the guard a blocked person can park
      // "X is typing…" in the blocker's open conversation indefinitely.
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;

      const blocker = recordingSocket();
      await handleChatMessage(
        { socket: blocker.socket, user: await asDbUser(admin.id) },
        { type: "join-channel", channelId },
      );
      const blocked = recordingSocket();
      await handleChatMessage(
        { socket: blocked.socket, user: await asDbUser(member.id) },
        { type: "join-channel", channelId },
      );

      await handleChatMessage(
        { socket: blocked.socket, user: await asDbUser(member.id) },
        { type: "typing", channelId },
      );
      expect(typesOf(blocker.received)).toContain("typing-broadcast");

      await call(admin, "POST", "/api/blocks", { userId: member.id });
      blocker.received.length = 0;
      await handleChatMessage(
        { socket: blocked.socket, user: await asDbUser(member.id) },
        { type: "typing", channelId },
      );
      expect(typesOf(blocker.received)).not.toContain("typing-broadcast");
    });

    it("answers 404 when closing a conversation the caller is not in", async () => {
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      expect(
        (
          await call(
            outsider,
            "DELETE",
            `/api/dms/${opened.body.conversation.channelId}`,
          )
        ).status,
      ).toBe(404);
    });

    it("refuses to open one with yourself", async () => {
      expect((await openWith(member, [member.id])).status).toBe(403);
    });

    it("stops a blocked person from reacting into a 1:1", async () => {
      // A reaction is a persistent, visible poke at somebody's message. Closing
      // only `message-create` would leave it as the way through.
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;
      await send(admin, channelId, "hello");

      const history = await call<{ messages: Array<{ id: string }> }>(
        member,
        "GET",
        `/api/channels/${channelId}/messages`,
      );
      const messageId = history.body.messages[0]!.id;

      await call(admin, "POST", "/api/blocks", { userId: member.id });
      await handleChatMessage(
        { socket: fakeSocket(), user: await asDbUser(member.id) },
        { type: "reaction-toggle", channelId, messageId, emoji: "👍" },
      );

      const reactions = await getPool().query(
        `SELECT 1 FROM message_reactions WHERE message_id = $1`,
        [messageId],
      );
      expect(reactions.rows).toHaveLength(0);
    });

    it("stops a blocked person from editing an old message into new abuse", async () => {
      // Every guard above sits on a WebSocket frame, but an edit arrives over
      // HTTP and re-broadcasts the new body live. Without a check here the
      // block stops new messages and lets arbitrary new text through anyway,
      // using a message that was legitimately sent before it went up.
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;
      await send(member, channelId, "innocent");

      const history = await call<{ messages: Array<{ id: string }> }>(
        member,
        "GET",
        `/api/channels/${channelId}/messages`,
      );
      const messageId = history.body.messages[0]!.id;

      await call(admin, "POST", "/api/blocks", { userId: member.id });

      expect(
        (
          await call(member, "PATCH", `/api/messages/${messageId}`, {
            body: "abuse",
          })
        ).status,
      ).toBe(403);

      const stored = await getPool().query<{ body: string }>(
        `SELECT body FROM messages WHERE id = $1`,
        [messageId],
      );
      expect(stored.rows[0]!.body).toBe("innocent");
    });

    it("lets a conversation take a call, and closes it to a blocked caller", async () => {
      // A conversation is stored as a text channel, so gating voice on
      // `type = 'voice'` used to reject every DM call.
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;

      const allowed = fakeSocket();
      await handleVoiceMessage(
        { socket: allowed, user: await asDbUser(member.id) },
        { type: "join-voice-room", voiceChannelId: channelId },
      );
      expect(isSocketInVoice(allowed)).toBe(true);
      removeVoicePeerBySocket(allowed);

      await call(admin, "POST", "/api/blocks", { userId: member.id });
      const refused = fakeSocket();
      await handleVoiceMessage(
        { socket: refused, user: await asDbUser(member.id) },
        { type: "join-voice-room", voiceChannelId: channelId },
      );
      expect(isSocketInVoice(refused)).toBe(false);
    });

    it("marks a blocked author's messages in history without dropping them", async () => {
      const { textChannelId } = await makeServer();
      await send(admin, textChannelId, "one");
      await send(member, textChannelId, "two");
      await call(owner, "POST", "/api/blocks", { userId: admin.id });

      const history = await call<{
        messages: Array<{ body: string; blocked: boolean }>;
      }>(owner, "GET", `/api/channels/${textChannelId}/messages`);
      expect(history.body.messages.map((m) => m.body)).toEqual(["one", "two"]);
      expect(history.body.messages.map((m) => m.blocked)).toEqual([true, false]);
    });
  });

  describe("link embeds", () => {
    async function send(
      as: { id: string; clerk_id: string },
      channelId: string,
      body: string,
    ) {
      await handleChatMessage(
        { socket: fakeSocket(), user: await asDbUser(as.id) },
        { type: "message-create", channelId, body },
      );
    }

    function htmlResponse(html: string) {
      return {
        statusCode: 200,
        headers: { "content-type": "text/html" },
        body: Buffer.from(html, "utf8"),
        finalUrl: "https://example.com/article",
      };
    }

    /**
     * Wait for the background fetch-then-broadcast chain in
     * `resolveEmbedInBackground` to actually deliver, rather than for a fixed
     * number of milliseconds.
     *
     * THIS WAS A 50ms SLEEP AND IT FLAKED. The chain does a real DB round trip,
     * and 50ms is plenty on a developer's machine and not always plenty on a
     * loaded CI runner, so `resolves an embed added by an edit` failed with
     * `expected [] to match object [{ title: "Edited in" }]` on unrelated pull
     * requests, including an iOS-only one that cannot touch this code at all.
     * A test that fails on changes it has no relationship with teaches people
     * to re-run CI without reading it, which is worse than the flake.
     *
     * Polling for the frame is both faster in the normal case (it returns as
     * soon as the update lands, usually in single-digit milliseconds) and
     * survives a slow runner. The timeout is deliberately generous: a real
     * regression still fails, it just takes two seconds to say so.
     */
    async function flush(until?: () => boolean) {
      const deadline = Date.now() + 2_000;
      // No predicate means "wait for something that produced no frame to watch
      // for", which is the cache-miss cases below. Those keep the original
      // fixed wait, because there is nothing to poll on. Shortening it would
      // have quietly made THEM flakier while fixing the one that was.
      if (!until) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return;
      }
      while (!until() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    /** The `message-update` frames a recording socket has seen so far. */
    function embedUpdates(listener: { received: string[] }) {
      return listener.received
        .map(
          (raw) =>
            JSON.parse(raw) as { type: string; message?: { embeds: unknown[] } },
        )
        .filter((frame) => frame.type === "message-update");
    }

    it("broadcasts without an embed first, then a follow-up update once the fetch resolves", async () => {
      const { textChannelId } = await makeServer();
      const listener = recordingSocket();
      await handleChatMessage(
        { socket: listener.socket, user: await asDbUser(member.id) },
        { type: "join-channel", channelId: textChannelId },
      );

      vi.mocked(safeFetch).mockResolvedValueOnce(
        htmlResponse(`<meta property="og:title" content="Fresh link" />`),
      );
      await send(owner, textChannelId, "check this out https://example.com/article");

      const created = JSON.parse(listener.received.at(-1)!) as {
        type: string;
        message: { embeds: unknown[] };
      };
      expect(created.type).toBe("message-broadcast");
      expect(created.message.embeds).toEqual([]);

      // Bare wait on purpose. Returning the instant the frame lands leaves this
      // test's background chain still in flight, and the next test's
      // `mockResolvedValueOnce` gets consumed by it: the suite then fails
      // deterministically one test later, which is a worse bug than the flake.
      await flush();
      const updates = embedUpdates(listener);
      expect(updates).toHaveLength(1);
      expect(updates[0]!.message!.embeds).toMatchObject([{ title: "Fresh link" }]);
    });

    it("attaches an already-cached embed to the very first broadcast, with no fetch at all", async () => {
      const { textChannelId } = await makeServer();
      const listener = recordingSocket();
      await handleChatMessage(
        { socket: listener.socket, user: await asDbUser(member.id) },
        { type: "join-channel", channelId: textChannelId },
      );

      const url = "https://example.com/already-known";
      const { createHash } = await import("node:crypto");
      await getPool().query(
        `INSERT INTO link_embeds (url_hash, url, kind, title, failed)
         VALUES ($1, $2, 'link', 'Known already', false)`,
        [createHash("sha256").update(url).digest("hex"), url],
      );

      await send(owner, textChannelId, `see ${url}`);
      expect(safeFetch).not.toHaveBeenCalled();

      const created = JSON.parse(listener.received.at(-1)!) as {
        message: { embeds: Array<{ title: string }> };
      };
      expect(created.message.embeds).toMatchObject([{ title: "Known already" }]);
    });

    it("resolves an embed added by an edit, via the same background path", async () => {
      const { textChannelId } = await makeServer();
      const listener = recordingSocket();
      await handleChatMessage(
        { socket: listener.socket, user: await asDbUser(owner.id) },
        { type: "join-channel", channelId: textChannelId },
      );

      await send(owner, textChannelId, "no link yet");
      const messageId = (
        await getPool().query<{ id: string }>(
          `SELECT id FROM messages WHERE channel_id = $1`,
          [textChannelId],
        )
      ).rows[0]!.id;
      listener.received.length = 0;

      vi.mocked(safeFetch).mockResolvedValueOnce(
        htmlResponse(`<meta property="og:title" content="Edited in" />`),
      );
      const edited = await call<{ message: { embeds: unknown[] } }>(
        owner,
        "PATCH",
        `/api/messages/${messageId}`,
        { body: "now with a link https://example.com/edited" },
      );
      expect(edited.status).toBe(200);
      expect(edited.body.message.embeds).toEqual([]);

      // Wait for an update that CARRIES an embed, not merely for an update.
      // The edit broadcasts its own `message-update` with empty embeds the
      // moment it commits, and the background resolution sends a second one
      // afterwards. Polling on "any update" returns on the first and asserts
      // against `[]` every time.
      await flush(() =>
        embedUpdates(listener).some(
          (frame) => (frame.message?.embeds ?? []).length > 0,
        ),
      );
      const updates = embedUpdates(listener);
      expect(updates.at(-1)!.message!.embeds).toMatchObject([{ title: "Edited in" }]);
    });

    it("marks a fetch failure as cached, so nothing re-fetches on the very next message", async () => {
      const { textChannelId } = await makeServer();
      vi.mocked(safeFetch).mockRejectedValueOnce(new Error("connection refused"));
      await send(owner, textChannelId, "dead link https://example.com/dead");
      await flush();

      await send(owner, textChannelId, "same dead link https://example.com/dead");
      await flush();
      // One outbound attempt total: the second message's history read is
      // cache-only, and its own background trigger only fires on an empty
      // `embeds` result — a failed row is deliberately excluded from that
      // read, not retried, until FAILURE_TTL_MS passes.
      expect(safeFetch).toHaveBeenCalledTimes(1);
    });

    it("serves cached image bytes through the unauthenticated proxy route, and 404s for an unknown hash", async () => {
      const { createHash } = await import("node:crypto");
      const url = "https://cdn.example.com/pic.png";
      const hash = createHash("sha256").update(url).digest("hex");
      await getPool().query(
        `INSERT INTO link_embeds (url_hash, url, kind, image_url, failed)
         VALUES ($1, $2, 'image', $2, false)`,
        [hash, url],
      );

      vi.mocked(safeFetch).mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "image/png" },
        body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        finalUrl: url,
      });

      // No Authorization header at all — proving this route does not require
      // Clerk auth, unlike every other /api/ route.
      const ok = await fetch(`${baseUrl}/api/embeds/${hash}/image`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await ok.arrayBuffer())).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );

      const missing = await fetch(
        `${baseUrl}/api/embeds/${"0".repeat(64)}/image`,
      );
      expect(missing.status).toBe(404);
    });
  });

  describe("audit log", () => {
    interface Entry {
      id: string;
      actorId: string | null;
      actorName: string | null;
      action: string;
      targetType: string | null;
      targetId: string | null;
      reason: string | null;
      changes: Array<{ key: string; old: unknown; new: unknown }> | null;
    }

    async function auditLog(
      serverId: string,
      query = "",
    ): Promise<{ entries: Entry[]; hasMore: boolean }> {
      const res = await call<{ entries: Entry[]; hasMore: boolean }>(
        owner,
        "GET",
        `/api/servers/${serverId}/audit-log${query}`,
      );
      expect(res.status).toBe(200);
      return res.body;
    }

    it("logs channel create, update, move, and delete with before/after context", async () => {
      const { serverId, textChannelId } = await makeServer();

      const createRes = await call<{ channel: { id: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/channels`,
        { name: "roadmap", type: "text" },
      );
      const channelId = createRes.body.channel.id;

      await call(owner, "PATCH", `/api/channels/${channelId}`, {
        name: "renamed",
        topic: "new topic",
      });
      await call(owner, "PATCH", `/api/channels/${channelId}/move`, {
        parentId: null,
        index: 0,
      });
      await call(owner, "DELETE", `/api/channels/${channelId}`);

      const { entries } = await auditLog(serverId);
      // Newest first: delete, move, update, create — plus the default
      // #general text channel this server was seeded with is untouched.
      const actions = entries.map((e) => e.action);
      expect(actions).toEqual([
        "channel.delete",
        "channel.move",
        "channel.update",
        "channel.create",
      ]);

      const created = entries.find((e) => e.action === "channel.create")!;
      expect(created.targetId).toBe(channelId);
      expect(created.changes).toMatchObject([
        { key: "name", old: null, new: "roadmap" },
      ]);

      const updated = entries.find((e) => e.action === "channel.update")!;
      expect(updated.changes).toMatchObject(
        expect.arrayContaining([
          { key: "name", old: "roadmap", new: "renamed" },
          { key: "topic", old: null, new: "new topic" },
        ]),
      );

      const deleted = entries.find((e) => e.action === "channel.delete")!;
      expect(deleted.changes).toMatchObject([
        { key: "name", old: "renamed", new: null },
      ]);

      void textChannelId;
    });

    it("logs kick, ban with a reason, and unban", async () => {
      const { serverId } = await makeServer();

      await call(admin, "DELETE", `/api/servers/${serverId}/members/${member.id}`, {
        ban: false,
      });
      const { entries: afterKick } = await auditLog(serverId);
      expect(afterKick[0]).toMatchObject({
        action: "member.kick",
        targetId: member.id,
        actorId: admin.id,
      });

      // member is gone now (kicked) — ban the outsider instead so the
      // membership precondition on ban does not get in the way.
      await call(owner, "POST", `/api/servers/${serverId}/bans`, {
        userId: outsider.id,
        reason: "spam",
      });
      const { entries: afterBan } = await auditLog(serverId);
      expect(afterBan[0]).toMatchObject({
        action: "member.ban",
        targetId: outsider.id,
        reason: "spam",
      });

      await call(owner, "DELETE", `/api/servers/${serverId}/bans/${outsider.id}`);
      const { entries: afterUnban } = await auditLog(serverId);
      expect(afterUnban[0]).toMatchObject({
        action: "member.unban",
        targetId: outsider.id,
      });
    });

    it("logs a role change with the previous role", async () => {
      const { serverId } = await makeServer();
      await call(owner, "PATCH", `/api/servers/${serverId}/members/${member.id}`, {
        role: "admin",
      });
      const { entries } = await auditLog(serverId);
      expect(entries[0]).toMatchObject({
        action: "member.role_update",
        targetId: member.id,
        changes: [{ key: "role", old: "member", new: "admin" }],
      });
    });

    it("logs a moderator deleting someone else's message, but not a self-delete", async () => {
      const { serverId, textChannelId } = await makeServer();
      const posted = await getPool().query<{ id: string }>(
        `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'hi') RETURNING id`,
        [textChannelId, member.id],
      );
      const messageId = posted.rows[0]!.id;

      // The author deleting their own message is not a moderation action.
      const selfPosted = await getPool().query<{ id: string }>(
        `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'mine') RETURNING id`,
        [textChannelId, owner.id],
      );
      await call(owner, "DELETE", `/api/messages/${selfPosted.rows[0]!.id}`);
      expect((await auditLog(serverId)).entries).toHaveLength(0);

      // A manager deleting someone else's message is.
      await call(admin, "DELETE", `/api/messages/${messageId}`);
      const { entries } = await auditLog(serverId);
      expect(entries[0]).toMatchObject({
        action: "message.delete",
        targetId: messageId,
        actorId: admin.id,
      });
    });

    it("logs invite create and delete", async () => {
      const { serverId } = await makeServer();
      const invite = await call<{ invite: { id: string; code: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/invites`,
        {},
      );
      await call(owner, "DELETE", `/api/servers/${serverId}/invites/${invite.body.invite.id}`);

      const { entries } = await auditLog(serverId);
      expect(entries.map((e) => e.action)).toEqual([
        "invite.delete",
        "invite.create",
      ]);
      expect(entries[1]!.changes).toMatchObject([
        { key: "code", old: null, new: invite.body.invite.code },
      ]);
    });

    it("logs server rename and ownership transfer", async () => {
      const { serverId } = await makeServer();
      await call(owner, "PATCH", `/api/servers/${serverId}`, {
        ownerId: admin.id,
      });
      // The owner (now demoted to admin) can still rename it in the same call
      // only as the new owner — do it as admin-turned-owner instead.
      await call(admin, "PATCH", `/api/servers/${serverId}`, {
        name: "renamed server",
      });

      const { entries } = await auditLog(serverId);
      expect(entries.map((e) => e.action)).toEqual([
        "server.update",
        "server.ownership_transfer",
      ]);
      expect(entries[1]).toMatchObject({
        changes: [{ key: "ownerId", old: owner.id, new: admin.id }],
      });
    });

    it("requires manage permission, refusing a plain member", async () => {
      const { serverId } = await makeServer();
      const res = await call(member, "GET", `/api/servers/${serverId}/audit-log`);
      expect(res.status).toBe(403);
    });

    it("paginates newest-first with a before cursor", async () => {
      const { serverId } = await makeServer();
      for (const name of ["a", "b", "c"]) {
        await call(owner, "POST", `/api/servers/${serverId}/channels`, {
          name,
          type: "text",
        });
      }

      const firstPage = await auditLog(serverId, "?limit=2");
      expect(firstPage.entries).toHaveLength(2);
      expect(firstPage.hasMore).toBe(true);
      // Newest first: the last channel created ("c") leads.
      expect(firstPage.entries[0]!.changes).toMatchObject([
        { key: "name", old: null, new: "c" },
      ]);

      const secondPage = await auditLog(
        serverId,
        `?limit=2&before=${firstPage.entries[1]!.id}`,
      );
      expect(secondPage.entries).toHaveLength(1);
      expect(secondPage.hasMore).toBe(false);
      expect(secondPage.entries[0]!.changes).toMatchObject([
        { key: "name", old: null, new: "a" },
      ]);

      // No entry repeated or skipped across the two pages.
      const allIds = [...firstPage.entries, ...secondPage.entries].map(
        (e) => e.id,
      );
      expect(new Set(allIds).size).toBe(3);
    });

    it("filters by action and by actor", async () => {
      const { serverId } = await makeServer();
      await call(owner, "POST", `/api/servers/${serverId}/channels`, {
        name: "one",
        type: "text",
      });
      await call(owner, "PATCH", `/api/servers/${serverId}/members/${member.id}`, {
        role: "admin",
      });

      const byAction = await auditLog(serverId, "?action=channel.create");
      expect(byAction.entries.map((e) => e.action)).toEqual(["channel.create"]);

      const byActor = await auditLog(serverId, `?actorId=${owner.id}`);
      expect(byActor.entries.length).toBeGreaterThanOrEqual(2);
      expect(byActor.entries.every((e) => e.actorId === owner.id)).toBe(true);
    });
  });

  describe("message retention", () => {
    it("lets the owner set, change, and clear the retention window", async () => {
      const { serverId } = await makeServer();

      const set = await call<{ server: { messageRetentionDays: number | null } }>(
        owner,
        "PATCH",
        `/api/servers/${serverId}`,
        { messageRetentionDays: 90 },
      );
      expect(set.status).toBe(200);
      expect(set.body.server.messageRetentionDays).toBe(90);

      const cleared = await call<{
        server: { messageRetentionDays: number | null };
      }>(owner, "PATCH", `/api/servers/${serverId}`, {
        messageRetentionDays: null,
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body.server.messageRetentionDays).toBeNull();
    });

    it("refuses a non-owner admin", async () => {
      const { serverId } = await makeServer();
      const res = await call(admin, "PATCH", `/api/servers/${serverId}`, {
        messageRetentionDays: 30,
      });
      expect(res.status).toBe(403);
    });

    it("rejects a retention value outside the allowed range", async () => {
      const { serverId } = await makeServer();
      const zero = await call(owner, "PATCH", `/api/servers/${serverId}`, {
        messageRetentionDays: 0,
      });
      expect(zero.status).toBe(400);

      const tooLarge = await call(owner, "PATCH", `/api/servers/${serverId}`, {
        messageRetentionDays: 100_000,
      });
      expect(tooLarge.status).toBe(400);
    });

    it("logs the change to the audit log, distinct from a rename, with the previous value", async () => {
      const { serverId } = await makeServer();
      await call(owner, "PATCH", `/api/servers/${serverId}`, {
        messageRetentionDays: 30,
      });
      await call(owner, "PATCH", `/api/servers/${serverId}`, {
        messageRetentionDays: 90,
      });

      const log = await call<{
        entries: Array<{ action: string; changes: unknown }>;
      }>(owner, "GET", `/api/servers/${serverId}/audit-log`);
      expect(log.body.entries[0]).toMatchObject({
        action: "server.retention_update",
        changes: [{ key: "messageRetentionDays", old: 30, new: 90 }],
      });
      // Never conflated with a plain rename, which uses a different action.
      expect(log.body.entries.every((e) => e.action !== "server.update")).toBe(
        true,
      );
    });
  });

  describe("SSO email domain", () => {
    async function verifyDomains(user: { clerk_id: string }, domains: string[]) {
      await getPool().query(`UPDATE users SET email_domains = $2 WHERE clerk_id = $1`, [
        user.clerk_id,
        domains,
      ]);
    }

    it("lets the owner set a domain and reports it back on the server list", async () => {
      const { serverId } = await makeServer();
      const res = await call<{ server: { ssoEmailDomain: string } }>(
        owner,
        "PATCH",
        `/api/servers/${serverId}`,
        { ssoEmailDomain: "ACME.com" },
      );
      expect(res.status).toBe(200);
      // Normalised on the way in, not stored as typed.
      expect(res.body.server.ssoEmailDomain).toBe("acme.com");

      // The sidebar list is a different query from the PATCH response, and it
      // is the one the settings dialog reads back — so it has to carry the
      // column too, or the field renders empty for a server that has one set.
      const list = await call<{
        servers: Array<{ id: string; ssoEmailDomain: string | null }>;
      }>(owner, "GET", "/api/servers");
      expect(
        list.body.servers.find((s) => s.id === serverId)?.ssoEmailDomain,
      ).toBe("acme.com");
    });

    it("refuses an admin — this is an owner-only setting", async () => {
      const { serverId } = await makeServer();
      const res = await call(admin, "PATCH", `/api/servers/${serverId}`, {
        ssoEmailDomain: "acme.com",
      });
      expect(res.status).toBe(403);
    });

    it("rejects a public email provider, and says why", async () => {
      const { serverId } = await makeServer();
      const res = await call<{ error: string }>(
        owner,
        "PATCH",
        `/api/servers/${serverId}`,
        { ssoEmailDomain: "gmail.com" },
      );
      expect(res.status).toBe(400);
      // The generic ZodError handler flattens everything to "Invalid request",
      // which tells an owner nothing about why their domain was refused — the
      // whole point of this guard is to explain the footgun.
      expect(res.body.error).toMatch(/public email provider/i);
    });

    it("rejects a malformed domain", async () => {
      const { serverId } = await makeServer();
      const res = await call(owner, "PATCH", `/api/servers/${serverId}`, {
        ssoEmailDomain: "not a domain",
      });
      expect(res.status).toBe(400);
    });

    it("joins by verified domain and logs it to the audit log", async () => {
      const { serverId } = await makeServer();
      await call(owner, "PATCH", `/api/servers/${serverId}`, {
        ssoEmailDomain: "acme.com",
      });
      await verifyDomains(outsider, ["acme.com"]);

      const available = await call<{ servers: Array<{ id: string }> }>(
        outsider,
        "GET",
        "/api/servers/sso-available",
      );
      expect(available.body.servers.map((s) => s.id)).toEqual([serverId]);

      const joined = await call(
        outsider,
        "POST",
        `/api/servers/${serverId}/sso-join`,
      );
      expect(joined.status).toBe(200);

      const audit = await call<{ entries: Array<{ action: string }> }>(
        owner,
        "GET",
        `/api/servers/${serverId}/audit-log`,
      );
      expect(audit.body.entries.some((e) => e.action === "member.sso_join")).toBe(
        true,
      );
    });

    it("404s a join when the domain does not match, not 403", async () => {
      const { serverId } = await makeServer();
      await call(owner, "PATCH", `/api/servers/${serverId}`, {
        ssoEmailDomain: "acme.com",
      });
      await verifyDomains(outsider, ["evil.test"]);

      const res = await call(
        outsider,
        "POST",
        `/api/servers/${serverId}/sso-join`,
      );
      // Same answer as an unknown id on purpose — a 403 would confirm the
      // server exists to somebody probing ids.
      expect(res.status).toBe(404);
    });

    it("404s a join against a server with the feature off", async () => {
      const { serverId } = await makeServer();
      await verifyDomains(outsider, ["acme.com"]);
      const res = await call(
        outsider,
        "POST",
        `/api/servers/${serverId}/sso-join`,
      );
      expect(res.status).toBe(404);
    });

    it("clears the domain with an explicit null", async () => {
      const { serverId } = await makeServer();
      await call(owner, "PATCH", `/api/servers/${serverId}`, {
        ssoEmailDomain: "acme.com",
      });
      const res = await call<{ server: { ssoEmailDomain: string | null } }>(
        owner,
        "PATCH",
        `/api/servers/${serverId}`,
        { ssoEmailDomain: null },
      );
      expect(res.body.server.ssoEmailDomain).toBeNull();
    });
  });

  describe("data export", () => {
    it("requires the owner, refusing an admin", async () => {
      const { serverId } = await makeServer();
      const res = await call(admin, "GET", `/api/servers/${serverId}/export`);
      expect(res.status).toBe(403);
    });

    it("exports server info, channels, members, and messages", async () => {
      const { serverId, textChannelId } = await makeServer();
      await getPool().query(
        `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'hello')`,
        [textChannelId, owner.id],
      );

      const res = await call<{
        server: { id: string; name: string };
        channels: Array<{ id: string }>;
        members: Array<{ role: string }>;
        messages: Array<{ body: string }>;
        truncated: boolean;
      }>(owner, "GET", `/api/servers/${serverId}/export`);

      expect(res.status).toBe(200);
      expect(res.body.server.id).toBe(serverId);
      expect(res.body.channels.some((c) => c.id === textChannelId)).toBe(true);
      expect(res.body.members.some((m) => m.role === "owner")).toBe(true);
      expect(res.body.messages).toMatchObject([{ body: "hello" }]);
      expect(res.body.truncated).toBe(false);
    });

    it("sets a Content-Disposition attachment header with a sanitized filename", async () => {
      const created = await call<{ server: { id: string } }>(
        owner,
        "POST",
        "/api/servers",
        { name: 'Weird "Name" / Server' },
      );
      const serverId = created.body.server.id;

      actor = owner;
      const res = await fetch(`${baseUrl}/api/servers/${serverId}/export`, {
        headers: { Authorization: "Bearer test" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");
      const disposition = res.headers.get("content-disposition") ?? "";
      expect(disposition).toContain("attachment; filename=");
      // No quote, slash, or other header-breaking character survived from
      // the server's own (fully user-controlled) name.
      expect(disposition).not.toContain('"Name"');
      expect(disposition).not.toContain("/");
    });

    it("logs the export to the audit log", async () => {
      const { serverId } = await makeServer();
      await call(owner, "GET", `/api/servers/${serverId}/export`);

      const log = await call<{ entries: Array<{ action: string }> }>(
        owner,
        "GET",
        `/api/servers/${serverId}/audit-log`,
      );
      expect(log.body.entries[0]).toMatchObject({
        action: "server.data_export",
        actorId: owner.id,
      });
    });

    it("rate limits repeated exports", async () => {
      const { serverId } = await makeServer();
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push(
          (await call(owner, "GET", `/api/servers/${serverId}/export`)).status,
        );
      }
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses[3]).toBe(429);
    });
  });

  describe("incoming webhooks", () => {
    async function makeWebhook(name = "Build Bot") {
      const { serverId, textChannelId } = await makeServer();
      const res = await call<{ webhook: { id: string; url: string } }>(
        owner,
        "POST",
        `/api/channels/${textChannelId}/webhooks`,
        { name },
      );
      expect(res.status).toBe(201);
      return { serverId, textChannelId, webhook: res.body.webhook };
    }

    it("requires manage permission to create, list, and delete", async () => {
      const { textChannelId, webhook } = await makeWebhook();
      expect(
        (
          await call(member, "POST", `/api/channels/${textChannelId}/webhooks`, {
            name: "Nope",
          })
        ).status,
      ).toBe(403);
      expect(
        (await call(member, "GET", `/api/channels/${textChannelId}/webhooks`))
          .status,
      ).toBe(403);
      expect(
        (await call(member, "DELETE", `/api/webhooks/${webhook.id}`)).status,
      ).toBe(403);
    });

    it("creates a webhook with an executable url, and lists it back", async () => {
      const { textChannelId, webhook } = await makeWebhook("Deploy Bot");
      expect(webhook.url).toMatch(
        new RegExp(`^/api/webhooks/${webhook.id}/[A-Za-z0-9_-]+$`),
      );

      const list = await call<{
        webhooks: Array<{ id: string; name: string; url: string }>;
      }>(owner, "GET", `/api/channels/${textChannelId}/webhooks`);
      expect(list.body.webhooks).toMatchObject([
        { id: webhook.id, name: "Deploy Bot" },
      ]);
    });

    it("executes with no Clerk auth, appears in history as a webhook message", async () => {
      const { textChannelId, webhook } = await makeWebhook();
      const res = await fetch(`${baseUrl}${webhook.url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "build passed",
          embeds: [{ title: "Result", color: 0x00ff00 }],
        }),
      });
      expect(res.status).toBe(200);

      const history = await call<{
        messages: Array<{
          body: string;
          authorName: string;
          isWebhook: boolean;
          webhookEmbeds: Array<{ title: string }>;
        }>;
      }>(owner, "GET", `/api/channels/${textChannelId}/messages`);
      expect(history.body.messages).toMatchObject([
        {
          body: "build passed",
          authorName: "Build Bot",
          isWebhook: true,
          webhookEmbeds: [{ title: "Result" }],
        },
      ]);
    });

    it("broadcasts the executed message live to whoever has the channel open", async () => {
      const { textChannelId, webhook } = await makeWebhook();
      const listener = recordingSocket();
      await handleChatMessage(
        { socket: listener.socket, user: await asDbUser(owner.id) },
        { type: "join-channel", channelId: textChannelId },
      );

      await fetch(`${baseUrl}${webhook.url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "live update" }),
      });

      const frames = listener.received.map(
        (raw) => JSON.parse(raw) as { type: string; message?: { body: string } },
      );
      expect(frames).toContainEqual(
        expect.objectContaining({
          type: "message-broadcast",
          message: expect.objectContaining({ body: "live update" }),
        }),
      );
    });

    it("refuses execution with a wrong token or an unknown id", async () => {
      const { webhook } = await makeWebhook();
      const wrongToken = await fetch(
        `${baseUrl}/api/webhooks/${webhook.id}/not-the-real-token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "nope" }),
        },
      );
      expect(wrongToken.status).toBe(404);

      const unknownId = await fetch(
        `${baseUrl}/api/webhooks/00000000-0000-4000-8000-000000000000/${webhook.url.split("/").pop()}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "nope" }),
        },
      );
      expect(unknownId.status).toBe(404);
    });

    it("rejects a payload with neither content nor embeds", async () => {
      const { webhook } = await makeWebhook();
      const res = await fetch(`${baseUrl}${webhook.url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("stops working once deleted, but its past messages remain", async () => {
      const { textChannelId, webhook } = await makeWebhook();
      await fetch(`${baseUrl}${webhook.url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "before deletion" }),
      });

      expect(
        (await call(owner, "DELETE", `/api/webhooks/${webhook.id}`)).status,
      ).toBe(200);

      const afterDelete = await fetch(`${baseUrl}${webhook.url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "after deletion" }),
      });
      expect(afterDelete.status).toBe(404);

      const history = await call<{ messages: Array<{ body: string }> }>(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages`,
      );
      expect(history.body.messages.map((m) => m.body)).toEqual([
        "before deletion",
      ]);
    });

    it("logs creation and deletion to the audit log", async () => {
      const { serverId, webhook } = await makeWebhook("Audit Bot");
      await call(owner, "DELETE", `/api/webhooks/${webhook.id}`);

      const log = await call<{ entries: Array<{ action: string }> }>(
        owner,
        "GET",
        `/api/servers/${serverId}/audit-log`,
      );
      expect(log.body.entries.map((e) => e.action)).toEqual([
        "webhook.delete",
        "webhook.create",
      ]);
    });
  });

  describe("chance and polls", () => {
    async function history(
      as: { id: string; clerk_id: string },
      channelId: string,
    ) {
      const res = await call<{
        messages: Array<{
          id: string;
          body: string;
          chance: { type: string; total?: number; notation?: string } | null;
          poll: {
            question: string;
            options: Array<{ id: string; label: string; votes: number; voted: boolean }>;
            totalVotes: number;
            closedAt: string | null;
            canClose: boolean;
          } | null;
        }>;
      }>(as, "GET", `/api/channels/${channelId}/messages`);
      expect(res.status).toBe(200);
      return res.body.messages;
    }

    it("stores a server-authored roll, not the sender's number", async () => {
      const { textChannelId } = await makeServer();
      await handleChatMessage(
        { socket: fakeSocket(), user: await asDbUser(owner.id) },
        {
          type: "message-create",
          channelId: textChannelId,
          body: "",
          chance: { type: "roll", notation: "1d20" },
        },
      );
      const [message] = await history(owner, textChannelId);
      expect(message?.chance?.type).toBe("roll");
      expect(message?.chance?.notation).toBe("1d20");
      expect(message?.chance?.total).toBeGreaterThanOrEqual(1);
      expect(message?.chance?.total).toBeLessThanOrEqual(20);
      expect(message?.body).toMatch(/^1d20 → /);
    });

    it("creates a poll, toggles a single-select vote, and closes it", async () => {
      const { textChannelId } = await makeServer();
      await handleChatMessage(
        { socket: fakeSocket(), user: await asDbUser(owner.id) },
        {
          type: "message-create",
          channelId: textChannelId,
          body: "",
          poll: {
            question: "Who is playing Saturday?",
            options: ["Yes", "No"],
            durationSeconds: 86_400,
            allowMultiselect: false,
          },
        },
      );
      const [created] = await history(member, textChannelId);
      expect(created?.poll?.question).toBe("Who is playing Saturday?");
      expect(created?.poll?.options).toHaveLength(2);
      expect(created?.poll?.canClose).toBe(false);

      const yes = created!.poll!.options[0]!;
      await handleChatMessage(
        { socket: fakeSocket(), user: await asDbUser(member.id) },
        {
          type: "poll-vote",
          channelId: textChannelId,
          messageId: created!.id,
          optionId: yes.id,
        },
      );
      const [voted] = await history(member, textChannelId);
      expect(voted?.poll?.options[0]?.voted).toBe(true);
      expect(voted?.poll?.options[0]?.votes).toBe(1);
      expect(voted?.poll?.totalVotes).toBe(1);
      expect(voted?.poll?.options[0]?.voters).toEqual([
        { userId: member.id, displayName: "Member", avatarUrl: null },
      ]);
      expect(voted?.poll?.options[1]?.voters).toEqual([]);

      const no = voted!.poll!.options[1]!;
      await handleChatMessage(
        { socket: fakeSocket(), user: await asDbUser(member.id) },
        {
          type: "poll-vote",
          channelId: textChannelId,
          messageId: created!.id,
          optionId: no.id,
        },
      );
      const [switched] = await history(member, textChannelId);
      expect(switched?.poll?.options[0]?.voted).toBe(false);
      expect(switched?.poll?.options[1]?.voted).toBe(true);
      expect(switched?.poll?.totalVotes).toBe(1);

      await handleChatMessage(
        { socket: fakeSocket(), user: await asDbUser(owner.id) },
        {
          type: "poll-close",
          channelId: textChannelId,
          messageId: created!.id,
        },
      );
      await handleChatMessage(
        { socket: fakeSocket(), user: await asDbUser(member.id) },
        {
          type: "poll-vote",
          channelId: textChannelId,
          messageId: created!.id,
          optionId: yes.id,
        },
      );
      const [closed] = await history(member, textChannelId);
      expect(closed?.poll?.closedAt).toBeTruthy();
      expect(closed?.poll?.options[1]?.voted).toBe(true);
      expect(closed?.poll?.totalVotes).toBe(1);
    });

    it("lets multi-select add a second option without dropping the first", async () => {
      const { textChannelId } = await makeServer();
      await handleChatMessage(
        { socket: fakeSocket(), user: await asDbUser(owner.id) },
        {
          type: "message-create",
          channelId: textChannelId,
          body: "",
          poll: {
            question: "What are you bringing?",
            options: ["Snacks", "Drinks", "Dice"],
            durationSeconds: 86_400,
            allowMultiselect: true,
          },
        },
      );
      const [created] = await history(member, textChannelId);
      const first = created!.poll!.options[0]!;
      const second = created!.poll!.options[1]!;
      await handleChatMessage(
        { socket: fakeSocket(), user: await asDbUser(member.id) },
        {
          type: "poll-vote",
          channelId: textChannelId,
          messageId: created!.id,
          optionId: first.id,
        },
      );
      await handleChatMessage(
        { socket: fakeSocket(), user: await asDbUser(member.id) },
        {
          type: "poll-vote",
          channelId: textChannelId,
          messageId: created!.id,
          optionId: second.id,
        },
      );
      const [voted] = await history(member, textChannelId);
      expect(voted?.poll?.options[0]?.voted).toBe(true);
      expect(voted?.poll?.options[1]?.voted).toBe(true);
      expect(voted?.poll?.totalVotes).toBe(2);
    });
  });

  describe("request hygiene", () => {
    it("answers 404 for a malformed id rather than surfacing a database error", async () => {
      const res = await call(owner, "GET", "/api/servers/not-a-uuid/channels");
      expect(res.status).toBe(404);
    });

    // Was `DELETE /api/me`, which is a real route now that account deletion
    // exists — so it answered 400 on the empty body rather than 405. Any path
    // with no handler for the verb proves the same thing; preferences is
    // PATCH-only.
    it("answers 405 when the path exists under a different method", async () => {
      const res = await call(owner, "DELETE", "/api/me/preferences");
      expect(res.status).toBe(405);
    });

    it("rejects invalid bodies with 400", async () => {
      const { serverId } = await makeServer();
      const res = await call(owner, "POST", `/api/servers/${serverId}/channels`, {
        name: "has spaces and $ymbols",
        type: "text",
      });
      expect(res.status).toBe(400);
    });

    it("rejects an oversized body with 413", async () => {
      const res = await call(owner, "PATCH", "/api/me", {
        displayName: "x".repeat(100_000),
      });
      expect(res.status).toBe(413);
    });
  });
});

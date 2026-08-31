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
import {
  Permission,
  PERMISSION_DEFAULT_MODERATOR,
  serializePermissions,
  STAFF_ROLE_COLORS,
} from "@pqp/shared";

/**
 * Staff ladder: seeded cargos, rank sync, bit-gated routes, kick vs ban,
 * hierarchy, and the populated-server migration.
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

describeDb("staff ladder", () => {
  let owner: { id: string; clerk_id: string };
  let admin: { id: string; clerk_id: string };
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
  });

  async function makeServer() {
    const created = await call<{
      server: { id: string };
      channels: Array<{ id: string; type: string }>;
    }>(owner, "POST", "/api/servers", { name: "Ladder" });
    expect(created.status).toBe(201);
    const serverId = created.body.server.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [serverId, admin.id],
    );
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, member.id],
    );
    return { serverId };
  }

  async function roleId(
    serverId: string,
    systemKey: string,
  ): Promise<string> {
    const listed = await call<{
      roles: Array<{ id: string; systemKey: string | null }>;
    }>(owner, "GET", `/api/servers/${serverId}/roles`);
    const row = listed.body.roles.find((role) => role.systemKey === systemKey);
    expect(row).toBeDefined();
    return row!.id;
  }

  it("paints seeded staff cargos and leaves a homemade colour alone", async () => {
    const { serverId } = await makeServer();
    await getPool().query(
      `INSERT INTO roles (server_id, name, permissions, position, is_everyone, mentionable, hoist, color)
       VALUES ($1, 'Friends', 0, 1, FALSE, FALSE, TRUE, '#ff00aa')`,
      [serverId],
    );
    const listed = await call<{
      roles: Array<{
        name: string;
        systemKey: string | null;
        color: string | null;
      }>;
    }>(owner, "GET", `/api/servers/${serverId}/roles`);
    const byKey = Object.fromEntries(
      listed.body.roles
        .filter((role) => role.systemKey)
        .map((role) => [role.systemKey, role]),
    );
    expect(byKey.owner!.color).toBe(STAFF_ROLE_COLORS.owner);
    expect(byKey.admin!.color).toBe(STAFF_ROLE_COLORS.admin);
    expect(byKey.manager!.color).toBe(STAFF_ROLE_COLORS.manager);
    expect(byKey.moderator!.color).toBe(STAFF_ROLE_COLORS.moderator);
    expect(byKey.vip!.color).toBe(STAFF_ROLE_COLORS.vip);
    expect(byKey.everyone!.color).toBeNull();
    expect(
      listed.body.roles.find((role) => role.name === "Friends")?.color,
    ).toBe("#ff00aa");
  });

  it("puts custom cargos below staff on a populated server, even when Moderator already exists as a name", async () => {
    const { serverId } = await makeServer();
    await getPool().query(
      `DELETE FROM roles WHERE server_id = $1 AND system_key = 'moderator'`,
      [serverId],
    );
    await getPool().query(
      `INSERT INTO roles (server_id, name, permissions, position, is_everyone, mentionable, hoist)
       VALUES ($1, 'Friends', 0, 1, FALSE, FALSE, TRUE),
              ($1, 'Moderator', 0, 2, FALSE, FALSE, TRUE)`,
      [serverId],
    );
    await getPool().query(`SELECT pqp_ensure_staff_ladder($1)`, [serverId]);

    const listed = await call<{
      roles: Array<{
        name: string;
        systemKey: string | null;
        position: number;
        color: string | null;
      }>;
    }>(owner, "GET", `/api/servers/${serverId}/roles`);
    const byKey = Object.fromEntries(
      listed.body.roles
        .filter((role) => role.systemKey)
        .map((role) => [role.systemKey, role]),
    );
    const friends = listed.body.roles.find((role) => role.name === "Friends")!;
    const homemade = listed.body.roles.find(
      (role) => role.name === "Moderator" && role.systemKey === null,
    )!;
    const seededMod = listed.body.roles.find(
      (role) => role.systemKey === "moderator",
    )!;
    expect(seededMod.name).toBe("Moderator_2");
    expect(seededMod.color).toBe(STAFF_ROLE_COLORS.moderator);
    expect(friends.position).toBeLessThan(homemade.position);
    expect(homemade.position).toBeLessThan(byKey.vip!.position);
    expect(byKey.vip!.position).toBeLessThan(byKey.moderator!.position);
    expect(byKey.moderator!.position).toBeLessThan(byKey.manager!.position);
    expect(byKey.manager!.position).toBeLessThan(byKey.admin!.position);
    expect(byKey.admin!.position).toBeLessThan(byKey.owner!.position);
  });

  it("claims an existing VIP cargo instead of inserting VIP_2", async () => {
    const { serverId } = await makeServer();
    await getPool().query(
      `DELETE FROM roles WHERE server_id = $1 AND system_key = 'vip'`,
      [serverId],
    );
    await getPool().query(
      `INSERT INTO roles (server_id, name, permissions, position, is_everyone, mentionable, hoist, color)
       VALUES ($1, 'VIP', 0, 1, FALSE, FALSE, TRUE, '#ff00aa')`,
      [serverId],
    );
    await getPool().query(`SELECT pqp_ensure_staff_ladder($1)`, [serverId]);

    const listed = await call<{
      roles: Array<{
        name: string;
        systemKey: string | null;
        color: string | null;
        hoist: boolean;
      }>;
    }>(owner, "GET", `/api/servers/${serverId}/roles`);
    const vips = listed.body.roles.filter(
      (role) => role.systemKey === "vip" || role.name.toLowerCase() === "vip",
    );
    expect(vips).toHaveLength(1);
    expect(vips[0]!.systemKey).toBe("vip");
    expect(vips[0]!.name).toBe("VIP");
    expect(vips[0]!.color).toBe("#ff00aa");
    expect(vips[0]!.hoist).toBe(true);
  });

  it("keeps Owner at the top even if the payload puts it last", async () => {
    const { serverId } = await makeServer();
    const listed = await call<{
      roles: Array<{ id: string; systemKey: string | null; position: number }>;
    }>(owner, "GET", `/api/servers/${serverId}/roles`);
    const bottomFirst = [...listed.body.roles]
      .sort((left, right) => left.position - right.position)
      .filter((role) => role.systemKey !== "everyone")
      .map((role) => role.id);
    expect(
      (
        await call(owner, "PATCH", `/api/servers/${serverId}/roles/order`, {
          roleIds: bottomFirst,
        })
      ).status,
    ).toBe(200);
    const after = await call<{
      roles: Array<{ systemKey: string | null; position: number }>;
    }>(owner, "GET", `/api/servers/${serverId}/roles`);
    const ranked = [...after.body.roles].sort(
      (left, right) => right.position - left.position,
    );
    expect(ranked[0]?.systemKey).toBe("owner");
    expect(ranked.at(-1)?.systemKey).toBe("everyone");
  });

  it("assigns Moderator extras only and refuses a ban on that cargo", async () => {
    const { serverId } = await makeServer();
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

    const listed = await call<{
      members: Array<{ id: string; role: string }>;
    }>(owner, "GET", `/api/servers/${serverId}/members`);
    expect(listed.body.members.find((row) => row.id === member.id)?.role).toBe(
      "member",
    );

    expect(
      (await call(member, "GET", `/api/servers/${serverId}/timeouts`)).status,
    ).toBe(200);
    expect(
      (await call(member, "GET", `/api/servers/${serverId}/bans`)).status,
    ).toBe(403);
    expect(
      (await call(member, "GET", `/api/servers/${serverId}/audit-log`)).status,
    ).toBe(403);
    expect(
      (
        await call(member, "DELETE", `/api/servers/${serverId}/members/${admin.id}`, {
          ban: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(member, "DELETE", `/api/servers/${serverId}/members/${admin.id}`, {
          ban: false,
        })
      ).status,
    ).toBe(403);

    const extra = await upsertUser({
      clerkId: "clerk_extra",
      displayName: "Extra",
      avatarUrl: null,
    });
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, extra.id],
    );
    expect(
      (
        await call(member, "DELETE", `/api/servers/${serverId}/members/${extra.id}`, {
          ban: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(member, "DELETE", `/api/servers/${serverId}/members/${extra.id}`, {
          ban: false,
        })
      ).status,
    ).toBe(200);
  });

  it("lets Manager ban and rename, and still hides founder-only private channels", async () => {
    const { serverId } = await makeServer();
    const managerId = await roleId(serverId, "manager");
    expect(
      (
        await call(
          owner,
          "PUT",
          `/api/servers/${serverId}/members/${member.id}/roles/${managerId}`,
        )
      ).status,
    ).toBe(200);

    const listed = await call<{
      members: Array<{ id: string; role: string; roleIds: string[] }>;
    }>(owner, "GET", `/api/servers/${serverId}/members`);
    const promoted = listed.body.members.find((row) => row.id === member.id);
    expect(promoted?.role).toBe("admin");
    expect(promoted?.roleIds).toContain(managerId);
    expect(promoted?.roleIds).not.toContain(await roleId(serverId, "admin"));

    expect(
      (await call(member, "PATCH", `/api/servers/${serverId}`, { name: "HQ" }))
        .status,
    ).toBe(200);
    expect(
      (await call(member, "GET", `/api/servers/${serverId}/audit-log`)).status,
    ).toBe(200);
    expect(
      (await call(member, "DELETE", `/api/servers/${serverId}`)).status,
    ).toBe(403);

    const extra = await upsertUser({
      clerkId: "clerk_banned",
      displayName: "Banned",
      avatarUrl: null,
    });
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, extra.id],
    );
    expect(
      (
        await call(member, "DELETE", `/api/servers/${serverId}/members/${extra.id}`, {
          ban: true,
        })
      ).status,
    ).toBe(200);

    const created = await call<{ channel: { id: string } }>(
      owner,
      "POST",
      `/api/servers/${serverId}/channels`,
      { name: "founders", type: "text", isPrivate: true },
    );
    expect(created.status).toBe(201);
    expect(
      (await call(member, "GET", `/api/channels/${created.body.channel.id}/messages`))
        .status,
    ).toBe(404);
  });

  it("refuses assigning Owner and editing a peer Admin cargo", async () => {
    const { serverId } = await makeServer();
    const ownerRole = await roleId(serverId, "owner");
    const adminRole = await roleId(serverId, "admin");
    expect(
      (
        await call(
          owner,
          "PUT",
          `/api/servers/${serverId}/members/${member.id}/roles/${ownerRole}`,
        )
      ).status,
    ).toBe(400);

    expect(
      (
        await call(admin, "PATCH", `/api/roles/${adminRole}`, {
          hoist: false,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(owner, "PATCH", `/api/roles/${adminRole}`, {
          hoist: false,
        })
      ).status,
    ).toBe(200);
  });

  it("syncs rank when Admin is assigned and strips staff on iOS demote", async () => {
    const { serverId } = await makeServer();
    const adminRole = await roleId(serverId, "admin");
    const moderatorId = await roleId(serverId, "moderator");
    expect(
      (
        await call(
          owner,
          "PUT",
          `/api/servers/${serverId}/members/${member.id}/roles/${adminRole}`,
        )
      ).status,
    ).toBe(200);
    let listed = await call<{
      members: Array<{ id: string; role: string; roleIds: string[] }>;
    }>(owner, "GET", `/api/servers/${serverId}/members`);
    const promoted = listed.body.members.find((row) => row.id === member.id)!;
    expect(promoted.role).toBe("admin");
    expect(promoted.roleIds).toContain(adminRole);

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
        await call(owner, "PATCH", `/api/servers/${serverId}/members/${member.id}`, {
          role: "member",
        })
      ).status,
    ).toBe(200);
    listed = await call<{
      members: Array<{ id: string; role: string; roleIds: string[] }>;
    }>(owner, "GET", `/api/servers/${serverId}/members`);
    const demoted = listed.body.members.find((row) => row.id === member.id)!;
    expect(demoted.role).toBe("member");
    expect(demoted.roleIds).not.toContain(adminRole);
    expect(demoted.roleIds).not.toContain(moderatorId);
  });

  it("does not bake @everyone bits into the Moderator mask", async () => {
    expect(
      BigInt(serializePermissions(PERMISSION_DEFAULT_MODERATOR)) &
        Permission.VIEW_CHANNEL,
    ).toBe(0n);
    expect(
      BigInt(serializePermissions(PERMISSION_DEFAULT_MODERATOR)) &
        Permission.SEND_MESSAGES,
    ).toBe(0n);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasPermission, parsePermissions, Permission } from "@pqp/shared";

/**
 * A server created from now on starts with USE_APPS on `@everyone` and on the
 * staff roles (decision 1 of the apps program), whichever path creates it, and
 * a plain member can actually resolve the bit in a channel. The bit stays out
 * of `PERMISSION_DEFAULT_EVERYONE`, so a community never gets it by default.
 * Scratch database only (`TEST_DATABASE_URL`).
 */

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  (process.env.CI === "true" ? process.env.DATABASE_URL : undefined);
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { createServer } = await import("../services/servers.js");
const { computeMemberPermissions } = await import("../services/permissions.js");

describeDb("USE_APPS at server creation", () => {
  beforeAll(async () => {
    await initDb();
  });
  afterAll(async () => {
    await closePool();
  });

  async function roles(serverId: string) {
    const result = await getPool().query<{ system_key: string; permissions: string }>(
      `SELECT system_key, permissions::text AS permissions FROM roles WHERE server_id = $1`,
      [serverId],
    );
    return new Map(result.rows.map((row) => [row.system_key, parsePermissions(row.permissions)]));
  }

  it("gives @everyone and the staff roles the bit", async () => {
    const owner = await upsertUser({
      clerkId: `clerk_grant_${Date.now()}_${Math.random()}`,
      displayName: "Owner",
      avatarUrl: null,
    });
    const { server, channels } = await createServer("Hall", owner.id);
    const byKey = await roles(server.id);

    expect(hasPermission(byKey.get("everyone")!, Permission.USE_APPS)).toBe(true);
    for (const key of ["moderator", "manager", "admin"]) {
      expect(hasPermission(byKey.get(key)!, Permission.USE_APPS), key).toBe(true);
    }
    // VIP and Owner are colours and a hoist with no bits of their own.
    expect(byKey.get("vip")).toBe(0n);

    // A plain member resolves it in a real channel (everyone's grant, no role).
    const member = await upsertUser({
      clerkId: `clerk_grant_m_${Date.now()}_${Math.random()}`,
      displayName: "Member",
      avatarUrl: null,
    });
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [server.id, member.id],
    );
    const general = channels.find((channel) => channel.name === "general")!;
    const perms = await computeMemberPermissions(server.id, member.id, general.id);
    expect(hasPermission(perms, Permission.USE_APPS)).toBe(true);
    expect(hasPermission(perms, Permission.VIEW_CHANNEL)).toBe(true);
  });

  it("leaves the other defaults exactly as they were", async () => {
    const owner = await upsertUser({
      clerkId: `clerk_grant_d_${Date.now()}_${Math.random()}`,
      displayName: "Owner",
      avatarUrl: null,
    });
    const { server } = await createServer("Hall", owner.id);
    const everyone = (await roles(server.id)).get("everyone")!;
    const { PERMISSION_DEFAULT_EVERYONE } = await import("@pqp/shared");
    expect(everyone & ~Permission.USE_APPS).toBe(PERMISSION_DEFAULT_EVERYONE);
    expect(PERMISSION_DEFAULT_EVERYONE & Permission.USE_APPS).toBe(0n);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PERMISSION_DEFAULT_EVERYONE,
  PERMISSION_DEFAULT_MANAGER,
  PERMISSION_DEFAULT_MODERATOR,
  Permission,
} from "@pqp/shared";

/**
 * The one-shot grant of USE_APPS (bit 29, `use_apps_bit_2026_10` in
 * `schema.sql`), on a real Postgres.
 *
 * It must hand the bit to `@everyone` of servers that are not communities and
 * to the manager, admin and moderator system roles everywhere, bump
 * `permissions_version` of exactly the servers it touched, and then never run
 * again: replaying it would keep undoing an owner who took the bit away.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");

const MIGRATION = "use_apps_bit_2026_10";
const USE_APPS = Permission.USE_APPS;

type Seed = {
  serverId: string;
  roles: Record<string, string>;
};

async function seedServer(
  ownerId: string,
  name: string,
  isCommunity: boolean,
): Promise<Seed> {
  const pool = getPool();
  const server = await pool.query<{ id: string }>(
    `INSERT INTO servers (name, owner_id, is_community) VALUES ($1, $2, $3) RETURNING id`,
    [name, ownerId, isCommunity],
  );
  const serverId = server.rows[0]!.id;
  const rows: Array<[string, string | null, boolean, bigint]> = [
    ["everyone", "everyone", true, PERMISSION_DEFAULT_EVERYONE],
    ["manager", "manager", false, PERMISSION_DEFAULT_MANAGER & ~USE_APPS],
    ["admin", "admin", false, 0x1fffffffn],
    ["moderator", "moderator", false, PERMISSION_DEFAULT_MODERATOR & ~USE_APPS],
    ["vip", "vip", false, 0n],
    ["homemade", null, false, 0n],
  ];
  const roles: Record<string, string> = {};
  for (const [label, key, isEveryone, permissions] of rows) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO roles (server_id, name, permissions, is_everyone, system_key)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [serverId, label, permissions.toString(), isEveryone, key],
    );
    roles[label] = inserted.rows[0]!.id;
  }
  return { serverId, roles };
}

async function permissionsOf(roleId: string): Promise<bigint> {
  const result = await getPool().query<{ permissions: string }>(
    `SELECT permissions FROM roles WHERE id = $1`,
    [roleId],
  );
  return BigInt(result.rows[0]!.permissions);
}

async function versionOf(serverId: string): Promise<number> {
  const result = await getPool().query<{ permissions_version: number }>(
    `SELECT permissions_version FROM servers WHERE id = $1`,
    [serverId],
  );
  return result.rows[0]!.permissions_version;
}

const has = (mask: bigint) => (mask & USE_APPS) === USE_APPS;

describeDb("USE_APPS one-shot backfill", () => {
  let priv: Seed;
  let community: Seed;
  let alreadyGranted: Seed;

  beforeAll(async () => {
    await initDb({ mode: "always" });
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    const pool = getPool();
    await pool.query(`TRUNCATE users CASCADE`);
    const owner = await pool.query<{ id: string }>(
      `INSERT INTO users (clerk_id, display_name) VALUES ('clerk_use_apps_owner', 'Owner') RETURNING id`,
    );
    const ownerId = owner.rows[0]!.id;
    priv = await seedServer(ownerId, "Private hall", false);
    community = await seedServer(ownerId, "Community hall", true);
    // A hall where every target row already holds the bit: nothing to touch,
    // so its version must not move.
    alreadyGranted = await seedServer(ownerId, "Already granted", false);
    await pool.query(
      `UPDATE roles SET permissions = permissions | $2::bigint
        WHERE server_id = $1 AND (is_everyone OR system_key IN ('manager', 'admin', 'moderator'))`,
      [alreadyGranted.serverId, USE_APPS.toString()],
    );
    await pool.query(`UPDATE servers SET permissions_version = 7`);
    // Back to the moment before the block shipped.
    await pool.query(`DELETE FROM data_migrations WHERE name = $1`, [MIGRATION]);
  });

  it("is bit 29 on the wire and not in the factory @everyone mask", () => {
    expect(USE_APPS).toBe(536870912n);
    expect(has(PERMISSION_DEFAULT_EVERYONE)).toBe(false);
    expect(has(PERMISSION_DEFAULT_MANAGER)).toBe(true);
    expect(has(PERMISSION_DEFAULT_MODERATOR)).toBe(true);
  });

  it("grants @everyone of a private server and the staff roles, never a community's @everyone", async () => {
    await initDb({ mode: "always" });

    expect(has(await permissionsOf(priv.roles.everyone!))).toBe(true);
    expect(has(await permissionsOf(priv.roles.manager!))).toBe(true);
    expect(has(await permissionsOf(priv.roles.admin!))).toBe(true);
    expect(has(await permissionsOf(priv.roles.moderator!))).toBe(true);

    expect(has(await permissionsOf(community.roles.everyone!))).toBe(false);
    expect(has(await permissionsOf(community.roles.manager!))).toBe(true);
    expect(has(await permissionsOf(community.roles.admin!))).toBe(true);
    expect(has(await permissionsOf(community.roles.moderator!))).toBe(true);

    // Neither VIP nor a homemade cargo is a target, and nothing else changed
    // on @everyone.
    expect(await permissionsOf(priv.roles.vip!)).toBe(0n);
    expect(await permissionsOf(priv.roles.homemade!)).toBe(0n);
    expect(await permissionsOf(priv.roles.everyone!)).toBe(
      PERMISSION_DEFAULT_EVERYONE | USE_APPS,
    );
  });

  it("bumps permissions_version of every server it touched and no other", async () => {
    await initDb({ mode: "always" });

    expect(await versionOf(priv.serverId)).toBe(8);
    // A community still gets the staff grants, so it is touched too.
    expect(await versionOf(community.serverId)).toBe(8);
    expect(await versionOf(alreadyGranted.serverId)).toBe(7);
  });

  it("does not run a second time", async () => {
    await initDb({ mode: "always" });

    // An owner takes the bit away from @everyone after the backfill.
    await getPool().query(
      `UPDATE roles SET permissions = permissions & ~$2::bigint WHERE id = $1`,
      [priv.roles.everyone!, USE_APPS.toString()],
    );
    const before = await versionOf(priv.serverId);

    await initDb({ mode: "always" });

    expect(has(await permissionsOf(priv.roles.everyone!))).toBe(false);
    expect(await versionOf(priv.serverId)).toBe(before);
    const recorded = await getPool().query(
      `SELECT 1 FROM data_migrations WHERE name = $1`,
      [MIGRATION],
    );
    expect(recorded.rowCount).toBe(1);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Permission, serializePermissions } from "@pqp/shared";

/**
 * `computeMemberPermissionsBulk` must be the one-member answer, many times.
 *
 * It exists because the start-of-stream notice has to decide about a few
 * hundred people and the one-member path costs three queries each. A second
 * copy of the overwrite order is exactly the kind of thing that drifts, so this
 * does not assert numbers: it asks both functions the same question about every
 * (member, channel) pair in a matrix of owners, admins, role grants, an
 * `@everyone` deny, member allow and deny, a private channel, a non-member and
 * a role the member no longer holds, and fails on the first disagreement.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer, createChannel } = await import("./servers.js");
const { computeMemberPermissions, computeMemberPermissionsBulk } = await import(
  "./permissions.js"
);

describeDb("computeMemberPermissionsBulk", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  it("agrees with computeMemberPermissions on a matrix of members and channels", async () => {
    const pool = getPool();
    await pool.query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    const make = (name: string) =>
      upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null });
    const owner = await make("owner");
    const admin = await make("admin");
    const plain = await make("plain");
    const vip = await make("vip");
    const denied = await make("denied");
    const invited = await make("invited");
    const stranger = await make("stranger");
    const orphanRole = await make("orphanrole");

    const { server } = await createServer("Matrix", owner.id);
    for (const user of [admin, plain, vip, denied, invited, orphanRole]) {
      await pool.query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, $3)`,
        [server.id, user.id, user === admin ? "admin" : "member"],
      );
    }
    const roles = await pool.query<{ id: string; system_key: string | null; is_everyone: boolean }>(
      `SELECT id, system_key, is_everyone FROM roles WHERE server_id = $1`,
      [server.id],
    );
    const everyone = roles.rows.find((role) => role.is_everyone)!.id;
    const vipRole = roles.rows.find((role) => role.system_key === "vip")!.id;
    const adminRole = roles.rows.find((role) => role.system_key === "admin")!.id;
    await pool.query(
      `INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3), ($1, $4, $5)
       ON CONFLICT DO NOTHING`,
      [server.id, vip.id, vipRole, admin.id, adminRole],
    );

    const open = await createChannel(server.id, "open", "voice");
    const noConnect = await createChannel(server.id, "no-connect", "voice");
    const vipOnly = await createChannel(server.id, "vip-only", "voice");
    const privateRoom = await createChannel(server.id, "private", "voice", true);
    const party = await createChannel(server.id, "party", "watch_party");

    const overwrite = (
      channelId: string,
      type: "role" | "member",
      targetId: string,
      allow: bigint,
      deny: bigint,
    ) =>
      pool.query(
        `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (channel_id, target_type, target_id)
         DO UPDATE SET allow = EXCLUDED.allow, deny = EXCLUDED.deny`,
        [channelId, type, targetId, serializePermissions(allow), serializePermissions(deny)],
      );
    // @everyone may not connect to this one; the VIP role may; one member is
    // then denied again on top.
    await overwrite(noConnect.id, "role", everyone, 0n, Permission.CONNECT);
    await overwrite(noConnect.id, "role", vipRole, Permission.CONNECT, 0n);
    await overwrite(noConnect.id, "member", denied.id, 0n, Permission.CONNECT);
    await overwrite(noConnect.id, "member", plain.id, Permission.CONNECT, 0n);
    // Hidden from everybody but the VIP role.
    await overwrite(vipOnly.id, "role", everyone, 0n, Permission.VIEW_CHANNEL);
    await overwrite(vipOnly.id, "role", vipRole, Permission.VIEW_CHANNEL, 0n);
    // A private channel: the member allow is what lets one person in.
    await overwrite(privateRoom.id, "member", invited.id, Permission.VIEW_CHANNEL, 0n);
    // A member_roles row for a role that is gone must be ignored, not crash.
    const ghost = await pool.query<{ id: string }>(
      `INSERT INTO roles (server_id, name, permissions, position, is_everyone)
       VALUES ($1, 'ghost', $2, 9, FALSE) RETURNING id`,
      [server.id, serializePermissions(Permission.ADMINISTRATOR)],
    );
    await pool.query(
      `INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)`,
      [server.id, orphanRole.id, ghost.rows[0]!.id],
    );
    await pool.query(`DELETE FROM roles WHERE id = $1`, [ghost.rows[0]!.id]);

    const people = [owner, admin, plain, vip, denied, invited, stranger, orphanRole];
    const ids = people.map((user) => user.id);
    const timedOut = new Set([plain.id]);

    for (const channel of [open, noConnect, vipOnly, privateRoom, party, null]) {
      const bulk = await computeMemberPermissionsBulk(
        server.id,
        ids,
        channel ? channel.id : null,
      );
      const bulkTimedOut = await computeMemberPermissionsBulk(
        server.id,
        ids,
        channel ? channel.id : null,
        { timedOut },
      );
      for (const user of people) {
        const single = await computeMemberPermissions(
          server.id,
          user.id,
          channel ? channel.id : null,
        );
        expect(
          bulk.get(user.id),
          `${user.display_name} in ${channel?.name ?? "no channel"}`,
        ).toBe(single);
        const singleTimedOut = await computeMemberPermissions(
          server.id,
          user.id,
          channel ? channel.id : null,
          { timedOut: timedOut.has(user.id) },
        );
        expect(
          bulkTimedOut.get(user.id),
          `${user.display_name} timed out in ${channel?.name ?? "no channel"}`,
        ).toBe(singleTimedOut);
      }
    }

    // And the matrix means what it says, so it is not agreeing on zeros.
    const inNoConnect = await computeMemberPermissionsBulk(server.id, ids, noConnect.id);
    const can = (userId: string, bit: bigint) => ((inNoConnect.get(userId) ?? 0n) & bit) !== 0n;
    expect(can(owner.id, Permission.CONNECT)).toBe(true);
    expect(can(admin.id, Permission.CONNECT)).toBe(true);
    expect(can(vip.id, Permission.CONNECT)).toBe(true);
    expect(can(plain.id, Permission.CONNECT)).toBe(true);
    expect(can(denied.id, Permission.CONNECT)).toBe(false);
    expect(can(denied.id, Permission.VIEW_CHANNEL)).toBe(true);
    expect(inNoConnect.get(stranger.id)).toBe(0n);
    const inPrivate = await computeMemberPermissionsBulk(server.id, ids, privateRoom.id);
    expect(((inPrivate.get(invited.id) ?? 0n) & Permission.CONNECT) !== 0n).toBe(true);
    expect(inPrivate.get(plain.id)).toBe(0n);
  });

  it("answers an empty list without touching the database", async () => {
    expect((await computeMemberPermissionsBulk("x", [], null)).size).toBe(0);
  });
});

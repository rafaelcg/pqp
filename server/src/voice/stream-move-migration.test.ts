import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Permission } from "@pqp/shared";

/**
 * The STREAM / MOVE backfill in schema.sql is a one-shot. It used to
 * fingerprint `roles.permissions`'s column comment, the same slot as
 * MANAGE_WEBHOOKS, so the two blocks took turns re-running on every boot and
 * OR'd STREAM back onto a mic-only role. `data_migrations` is the latch.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");

const SPEAK = Number(Permission.SPEAK);
const STREAM = Number(Permission.STREAM);

describeDb("stream/move bits migration", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(
      `TRUNCATE users, servers RESTART IDENTITY CASCADE`,
    );
  });

  async function seedMicOnly(): Promise<{
    roleId: string;
    channelId: string;
  }> {
    const owner = await upsertUser({
      clerkId: "clerk_stream_move_owner",
      displayName: "Owner",
      avatarUrl: null,
    });
    const server = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('Stage', $1) RETURNING id`,
      [owner.id],
    );
    const serverId = server.rows[0]!.id;
    const role = await getPool().query<{ id: string }>(
      `INSERT INTO roles (server_id, name, permissions, position)
       VALUES ($1, 'Mic only', $2, 5) RETURNING id`,
      [serverId, SPEAK],
    );
    const channel = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position)
       VALUES ($1, 'Lobby', 'voice', 0) RETURNING id`,
      [serverId],
    );
    await getPool().query(
      `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
       VALUES ($1, 'role', $2, $3, $4)`,
      [channel.rows[0]!.id, role.rows[0]!.id, SPEAK, STREAM],
    );
    return {
      roleId: role.rows[0]!.id,
      channelId: channel.rows[0]!.id,
    };
  }

  it("does not re-copy Stream onto a Speak-only role on the next boot", async () => {
    const { roleId, channelId } = await seedMicOnly();
    const before = await getPool().query<{
      permissions: string;
      permissions_version: number;
      allow: string;
      deny: string;
    }>(
      `SELECT r.permissions::text, s.permissions_version, o.allow::text, o.deny::text
         FROM roles r
         JOIN servers s ON s.id = r.server_id
         JOIN channel_overwrites o ON o.target_id = r.id
        WHERE r.id = $1 AND o.channel_id = $2`,
      [roleId, channelId],
    );
    expect(Number(before.rows[0]!.permissions)).toBe(SPEAK);
    expect(Number(before.rows[0]!.allow)).toBe(SPEAK);
    expect(Number(before.rows[0]!.deny)).toBe(STREAM);

    await initDb();
    await initDb();

    const after = await getPool().query<{
      permissions: string;
      permissions_version: number;
      allow: string;
      deny: string;
    }>(
      `SELECT r.permissions::text, s.permissions_version, o.allow::text, o.deny::text
         FROM roles r
         JOIN servers s ON s.id = r.server_id
         JOIN channel_overwrites o ON o.target_id = r.id
        WHERE r.id = $1 AND o.channel_id = $2`,
      [roleId, channelId],
    );
    expect(Number(after.rows[0]!.permissions)).toBe(SPEAK);
    expect(Number(after.rows[0]!.allow)).toBe(SPEAK);
    expect(Number(after.rows[0]!.deny)).toBe(STREAM);
    expect(after.rows[0]!.permissions_version).toBe(
      before.rows[0]!.permissions_version,
    );
  });
});

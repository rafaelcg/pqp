import { formatUserTag } from "@pqp/shared";
import { getPool } from "../db.js";

/** Remove a user's server membership and any private-channel memberships. */
async function removeMembership(serverId: string, userId: string): Promise<void> {
  await getPool().query(
    `DELETE FROM server_members WHERE server_id = $1 AND user_id = $2`,
    [serverId, userId],
  );
  await getPool().query(
    `DELETE FROM channel_members
     WHERE user_id = $1 AND channel_id IN (
       SELECT id FROM channels WHERE server_id = $2
     )`,
    [userId, serverId],
  );
}

export async function kickMember(
  serverId: string,
  userId: string,
): Promise<void> {
  await removeMembership(serverId, userId);
}

export async function banMember(
  serverId: string,
  userId: string,
  bannedBy: string,
  reason?: string | null,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO server_bans (server_id, user_id, banned_by, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (server_id, user_id)
       DO UPDATE SET banned_by = EXCLUDED.banned_by, reason = EXCLUDED.reason`,
      [serverId, userId, bannedBy, reason ?? null],
    );
    await client.query(
      `DELETE FROM server_members WHERE server_id = $1 AND user_id = $2`,
      [serverId, userId],
    );
    await client.query(
      `DELETE FROM channel_members
       WHERE user_id = $1 AND channel_id IN (
         SELECT id FROM channels WHERE server_id = $2
       )`,
      [userId, serverId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function unbanMember(
  serverId: string,
  userId: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM server_bans WHERE server_id = $1 AND user_id = $2`,
    [serverId, userId],
  );
}

export async function isBanned(
  serverId: string,
  userId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM server_bans WHERE server_id = $1 AND user_id = $2`,
    [serverId, userId],
  );
  return result.rows.length > 0;
}

export async function listBans(serverId: string) {
  const result = await getPool().query<{
    user_id: string;
    display_name: string;
    username: string | null;
    discriminator: string | null;
    reason: string | null;
    created_at: Date;
  }>(
    `SELECT b.user_id, u.display_name, u.username, u.discriminator,
            b.reason, b.created_at
     FROM server_bans b
     JOIN users u ON u.id = b.user_id
     WHERE b.server_id = $1
     ORDER BY b.created_at DESC`,
    [serverId],
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    tag: formatUserTag(row.username, row.discriminator),
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
  }));
}

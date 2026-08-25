import { formatUserTag } from "@pqp/shared";
import { getPool } from "../db.js";
import { invalidateServerAudience } from "./servers.js";

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
  // The kick/ban path, and the one where a stale cached audience is worst: the
  // person is gone from the server and would otherwise keep receiving activity
  // badges from every channel in it.
  invalidateServerAudience(serverId);
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
    // Not shared with `removeMembership` above: a ban writes the ban row and
    // the two deletes in one transaction, so it has its own copy of them — and
    // therefore needs its own copy of this. Adding the invalidation only to
    // `removeMembership` left a kicked member evicted from the cache and a
    // *banned* one still in it, which is the wrong way round.
    invalidateServerAudience(serverId);
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

/**
 * The private channels a demoted admin can no longer see.
 *
 * `channelVisibleSql` admits owners and admins to a private channel **on rank
 * alone**, with no `channel_members` row of their own. So `admin` → `member`
 * silently revokes access to every private channel they were never explicitly
 * added to — without touching a single membership row, which is exactly why the
 * kick path's eviction never fired for it and why a cache invalidation alone was
 * not enough. Invalidating the audience cache fixes what the *next* query
 * answers; it does nothing about the socket that is already inside the channel,
 * already receiving every message body, and already in its voice room.
 *
 * The `NOT EXISTS` is the whole correctness condition: an admin who was *also*
 * explicitly added to a private channel keeps it as a plain member, and
 * evicting them would be a bug in the opposite direction.
 *
 * Public channels are absent because a demotion changes nothing about them, and
 * `kind = 'server'` is implied by `server_id` being non-null
 * (`channels_server_kind_check`), so a conversation can never appear here.
 */
export async function listRevokedPrivateChannelIds(
  serverId: string,
  userId: string,
): Promise<string[]> {
  const result = await getPool().query<{ id: string }>(
    `SELECT c.id FROM channels c
     WHERE c.server_id = $1
       AND c.kind = 'server'
       AND c.type <> 'thread'
       AND NOT channel_viewable(c.id, $2)`,
    [serverId, userId],
  );
  return result.rows.map((row) => row.id);
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

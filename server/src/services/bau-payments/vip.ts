import { getPool } from "../../db.js";
import { evictUserFromChannels, notifyPermissionsUpdate } from "../../ws/chat.js";
import { evictVoiceUser } from "../../ws/voice.js";
import { listRevokedPrivateChannelIds } from "../moderation.js";
import { invalidateServerAudience } from "../servers.js";
import { countBauPayments } from "./metrics.js";

/**
 * The VIP cargo a payment gives, and takes back. THE ORDINARY VIP ROLE
 * (`roles.system_key = 'vip'`): no parallel permission, so the Baú, private
 * VIP rooms and every reader of VIP keep working unchanged.
 *
 * SOURCE MARKER. `bau_memberships.vip_owned` is TRUE only when this membership
 * inserted the `member_roles` row. A revoke deletes the row only then, so a VIP
 * staff gave by hand is never taken by an expiry, and a payment that lapses
 * never leaves a VIP behind. Both moves run in one transaction with the
 * membership row locked, and re-check access inside it, so two processes (the
 * API answering a webhook and the worker's sweep) cannot grant and revoke past
 * each other.
 */

/** Does the membership row `m` give access right now. Mirrors `bauMembershipHasAccess`. */
export const HAS_ACCESS_SQL = `(m.status IN ('active', 'grace')
  OR (m.status = 'cancelled' AND m.period_end > NOW()))`;

async function afterRoleChange(serverId: string): Promise<void> {
  invalidateServerAudience(serverId);
  // Bumps `permissions_version` and tells every member's sockets, on every
  // instance; the fan's client refetches what it may see, so a VIP post and a
  // VIP room open without a reload.
  await notifyPermissionsUpdate(serverId).catch((error) => {
    console.error("[bau-payments] permissions-update failed:", error);
  });
}

/**
 * Give the VIP cargo for a membership that has access and whose fan is still a
 * member. True when a row was written. A fan who left is skipped; the sweep
 * gives it on their return (`regrantRejoinedVips`).
 */
export async function grantVipForMembership(membershipId: string): Promise<boolean> {
  const client = await getPool().connect();
  let changed: { serverId: string } | null = null;
  try {
    await client.query("BEGIN");
    const found = await client.query<{
      server_id: string;
      user_id: string;
      has_access: boolean;
      is_member: boolean;
    }>(
      `SELECT m.server_id, m.user_id, ${HAS_ACCESS_SQL} AS has_access,
              EXISTS (SELECT 1 FROM server_members sm
                       WHERE sm.server_id = m.server_id AND sm.user_id = m.user_id) AS is_member
         FROM bau_memberships m
        WHERE m.id = $1
        FOR UPDATE OF m`,
      [membershipId],
    );
    const row = found.rows[0];
    if (!row || !row.has_access || !row.is_member) {
      await client.query("ROLLBACK");
      return false;
    }
    let role = await client.query<{ id: string }>(
      `SELECT id FROM roles WHERE server_id = $1 AND system_key = 'vip'`,
      [row.server_id],
    );
    if (!role.rows[0]) {
      // A hall from before the staff ladder: make the ladder, VIP included.
      await client.query(`SELECT pqp_ensure_staff_ladder($1)`, [row.server_id]);
      role = await client.query<{ id: string }>(
        `SELECT id FROM roles WHERE server_id = $1 AND system_key = 'vip'`,
        [row.server_id],
      );
    }
    const roleId = role.rows[0]?.id;
    if (!roleId) {
      await client.query("ROLLBACK");
      return false;
    }
    const inserted = await client.query(
      `INSERT INTO member_roles (server_id, user_id, role_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING 1`,
      [row.server_id, row.user_id, roleId],
    );
    const wrote = (inserted.rowCount ?? 0) > 0;
    await client.query(
      `UPDATE bau_memberships
          SET vip_owned = vip_owned OR $2,
              vip_granted_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [membershipId, wrote],
    );
    await client.query("COMMIT");
    if (wrote) {
      changed = { serverId: row.server_id };
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  if (changed) {
    countBauPayments("vipGranted");
    await afterRoleChange(changed.serverId);
    return true;
  }
  return false;
}

/**
 * Take the cargo back from a membership that no longer has access, only if
 * this membership is what gave it. True when a row was removed.
 */
export async function revokeVipForMembership(membershipId: string): Promise<boolean> {
  const client = await getPool().connect();
  let removed: { serverId: string; userId: string } | null = null;
  try {
    await client.query("BEGIN");
    const claimed = await client.query<{ server_id: string; user_id: string }>(
      `UPDATE bau_memberships m
          SET vip_owned = FALSE, vip_revoked_at = NOW(), updated_at = NOW()
        WHERE m.id = $1 AND m.vip_owned AND NOT ${HAS_ACCESS_SQL}
        RETURNING m.server_id, m.user_id`,
      [membershipId],
    );
    const row = claimed.rows[0];
    if (row) {
      await client.query(
        `DELETE FROM member_roles mr
          USING roles r
          WHERE mr.server_id = $1 AND mr.user_id = $2
            AND r.id = mr.role_id AND r.server_id = mr.server_id
            AND r.system_key = 'vip'`,
        [row.server_id, row.user_id],
      );
      removed = { serverId: row.server_id, userId: row.user_id };
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  if (!removed) {
    return false;
  }
  countBauPayments("vipRevoked");
  await afterRoleChange(removed.serverId);
  // Out of any VIP-only room they are sitting in, the way taking a cargo away
  // by hand does it (`DELETE .../roles/:roleId`).
  try {
    const revoked = new Set(
      await listRevokedPrivateChannelIds(removed.serverId, removed.userId),
    );
    if (revoked.size > 0) {
      evictUserFromChannels(removed.userId, revoked);
      evictVoiceUser(removed.userId, revoked);
    }
  } catch (error) {
    console.error("[bau-payments] eviction after revoke failed:", error);
  }
  return true;
}

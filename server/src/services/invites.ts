import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool, type DbInvite } from "../db.js";
import { invalidateServerAudience } from "./servers.js";
import { recordActivationStep } from "./activation.js";
import type { PublicInvitePreview } from "@pqp/shared";

export type Queryable = Pick<PoolClient, "query">;

function generateInviteCode(): string {
  return randomBytes(5).toString("base64url").slice(0, 8);
}

export async function deleteInvite(
  serverId: string,
  inviteId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `DELETE FROM server_invites WHERE id = $1 AND server_id = $2`,
    [inviteId, serverId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function createInviteWith(
  db: Queryable,
  serverId: string,
  createdBy: string,
  options: { maxUses?: number | null; expiresInHours?: number | null } = {},
): Promise<DbInvite> {
  const code = generateInviteCode();
  const expiresAt =
    options.expiresInHours != null
      ? new Date(Date.now() + options.expiresInHours * 60 * 60 * 1000)
      : null;

  const result = await db.query<DbInvite>(
    `INSERT INTO server_invites (server_id, code, created_by, max_uses, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, server_id, code, created_by, max_uses, uses, expires_at, created_at`,
    [serverId, code, createdBy, options.maxUses ?? null, expiresAt],
  );
  return result.rows[0]!;
}

export async function createInvite(
  serverId: string,
  createdBy: string,
  options: { maxUses?: number | null; expiresInHours?: number | null } = {},
): Promise<DbInvite> {
  return createInviteWith(getPool(), serverId, createdBy, options);
}

/** `db` defaults to the pool; pass an open transaction's client to read
 * inside it instead of borrowing a second connection off the pool. */
export async function listInvites(
  serverId: string,
  db: Queryable = getPool(),
): Promise<DbInvite[]> {
  const result = await db.query<DbInvite>(
    `SELECT id, server_id, code, created_by, max_uses, uses, expires_at, created_at
     FROM server_invites
     WHERE server_id = $1
     ORDER BY created_at DESC`,
    [serverId],
  );
  return result.rows;
}

export async function getInviteByCode(code: string): Promise<DbInvite | null> {
  const result = await getPool().query<DbInvite>(
    `SELECT i.id, i.server_id, i.code, i.created_by, i.max_uses, i.uses,
            i.expires_at, i.created_at, s.name as server_name
     FROM server_invites i
     JOIN servers s ON s.id = i.server_id
     WHERE i.code = $1`,
    [code],
  );
  return result.rows[0] ?? null;
}

/**
 * Join a server through an invite code.
 *
 * `options.ref` is the `?ref=` tag the invite link carried, already normalised
 * (`normalizeJoinRef`). It is written onto the membership only when this call
 * creates it: re-opening a link you already used neither counts a use nor
 * re-attributes the join.
 */
export async function redeemInvite(
  code: string,
  userId: string,
  options: { ref?: string | null } = {},
): Promise<{ serverId: string; serverName: string }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const inviteResult = await client.query<DbInvite & { server_name: string }>(
      `SELECT i.id, i.server_id, i.code, i.created_by, i.max_uses, i.uses,
              i.expires_at, i.created_at, s.name as server_name
       FROM server_invites i
       JOIN servers s ON s.id = i.server_id
       WHERE i.code = $1
       FOR UPDATE OF i`,
      [code],
    );
    const invite = inviteResult.rows[0];
    if (!invite) {
      throw new Error("Invite not found");
    }
    if (invite.expires_at && invite.expires_at.getTime() < Date.now()) {
      throw new Error("Invite expired");
    }

    const banned = await client.query(
      `SELECT 1 FROM server_bans WHERE server_id = $1 AND user_id = $2`,
      [invite.server_id, userId],
    );
    if (banned.rows.length > 0) {
      throw new Error("You are banned from this server");
    }

    const inserted = await client.query(
      `INSERT INTO server_members (server_id, user_id, role, join_ref)
       VALUES ($1, $2, 'member', $3)
       ON CONFLICT DO NOTHING`,
      [invite.server_id, userId, options.ref ?? null],
    );

    const joinedNow = (inserted.rowCount ?? 0) > 0;

    // Only a real join consumes the invite. Re-opening an invite link you have
    // already used previously burned a use and could exhaust your own invite.
    if (joinedNow) {
      if (invite.max_uses != null && invite.uses >= invite.max_uses) {
        throw new Error("Invite has no uses left");
      }
      await client.query(
        `UPDATE server_invites SET uses = uses + 1 WHERE id = $1`,
        [invite.id],
      );
    }

    await client.query("COMMIT");
    if (joinedNow) {
      invalidateServerAudience(invite.server_id);
      // Funnel step `first_join`, and AFTER the commit on purpose: the stamp is
      // its own statement on the pool, never inside this transaction. Only a
      // real join (a fresh membership row) counts; re-opening an invite you
      // already used is not a join and does not stamp.
      await recordActivationStep(userId, "first_join");
    }
    return {
      serverId: invite.server_id,
      serverName: invite.server_name ?? "Server",
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function mapInvite(invite: DbInvite) {
  return {
    id: invite.id,
    code: invite.code,
    serverId: invite.server_id,
    serverName: invite.server_name,
    maxUses: invite.max_uses,
    uses: invite.uses,
    expiresAt: invite.expires_at?.toISOString() ?? null,
    createdAt: invite.created_at.toISOString(),
  };
}

/**
 * What a signed-out person holding an invite link may see before they sign up:
 * the room's name, its picture and an approximate head count. Nothing else.
 *
 * Every reason the invite would not let a new person in is folded into the
 * WHERE clause, so an unknown code, an expired one, an exhausted one and one
 * pointing at a suspended community all answer null from the same single
 * statement. The caller turns that into one 404; nothing here can sort dead
 * codes into kinds, and the query plan does not change with the reason.
 *
 * "Exhausted" uses the rule a NEW account meets in `redeemInvite`: an existing
 * member may re-open a spent invite, but nobody reading this endpoint is a
 * member yet.
 *
 * No server id, no invite id, no inviter, no member names. The icon URL is the
 * stored one, which for an uploaded picture is `/api/servers/<id>/icon`, the
 * same concession `publicCommunitySchema` documents: every route that would take
 * that id stays behind auth.
 */
export async function getPublicInvitePreview(
  code: string,
): Promise<PublicInvitePreview | null> {
  const result = await getPool().query<{
    name: string;
    icon_url: string | null;
    member_count: number;
  }>(
    `SELECT s.name, s.icon_url, s.member_count
       FROM server_invites i
       JOIN servers s ON s.id = i.server_id
      WHERE i.code = $1
        AND (i.expires_at IS NULL OR i.expires_at > now())
        AND (i.max_uses IS NULL OR i.uses < i.max_uses)
        AND NOT s.is_community_suspended`,
    [code],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    serverName: row.name,
    iconUrl: row.icon_url,
    memberCount: Math.max(0, row.member_count),
  };
}

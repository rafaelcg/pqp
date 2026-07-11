import { randomBytes } from "node:crypto";
import { getPool, type DbInvite } from "../db.js";

function generateInviteCode(): string {
  return randomBytes(5).toString("base64url").slice(0, 8);
}

export async function createInvite(
  serverId: string,
  createdBy: string,
  options: { maxUses?: number | null; expiresInHours?: number | null } = {},
): Promise<DbInvite> {
  const code = generateInviteCode();
  const expiresAt =
    options.expiresInHours != null
      ? new Date(Date.now() + options.expiresInHours * 60 * 60 * 1000)
      : null;

  const result = await getPool().query<DbInvite>(
    `INSERT INTO server_invites (server_id, code, created_by, max_uses, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, server_id, code, created_by, max_uses, uses, expires_at, created_at`,
    [serverId, code, createdBy, options.maxUses ?? null, expiresAt],
  );
  return result.rows[0]!;
}

export async function listInvites(serverId: string): Promise<DbInvite[]> {
  const result = await getPool().query<DbInvite>(
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

export async function redeemInvite(
  code: string,
  userId: string,
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
    if (invite.max_uses != null && invite.uses >= invite.max_uses) {
      throw new Error("Invite has no uses left");
    }

    const banned = await client.query(
      `SELECT 1 FROM server_bans WHERE server_id = $1 AND user_id = $2`,
      [invite.server_id, userId],
    );
    if (banned.rows.length > 0) {
      throw new Error("You are banned from this server");
    }

    await client.query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING`,
      [invite.server_id, userId],
    );

    await client.query(
      `UPDATE server_invites SET uses = uses + 1 WHERE id = $1`,
      [invite.id],
    );

    await client.query("COMMIT");
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

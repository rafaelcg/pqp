import {
  clampEveryonePermissions,
  grantablePermissions,
  hasPermission,
  parsePermissions,
  Permission,
  roleNameSchema,
  serializePermissions,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { HttpError } from "../lib/http.js";
import {
  bumpPermissionsVersion,
  computeMemberPermissions,
  loadMemberPermissionContext,
} from "./permissions.js";
import { invalidateServerAudience } from "./servers.js";

export interface RoleRow {
  id: string;
  server_id: string;
  name: string;
  color: string | null;
  hoist: boolean;
  mentionable: boolean;
  permissions: string;
  position: number;
  is_everyone: boolean;
  system_key: string | null;
}

export function mapRole(row: RoleRow) {
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    color: row.color,
    hoist: row.hoist,
    mentionable: row.mentionable,
    permissions: row.permissions,
    position: row.position,
    isEveryone: row.is_everyone,
    systemKey: (row.system_key as "everyone" | "admin" | null) ?? null,
  };
}

const ROLE_COLUMNS = `id, server_id, name, color, hoist, mentionable, permissions::text AS permissions, position, is_everyone, system_key`;

export async function listRoles(serverId: string): Promise<RoleRow[]> {
  const result = await getPool().query<RoleRow>(
    `SELECT ${ROLE_COLUMNS} FROM roles WHERE server_id = $1 ORDER BY position ASC, name ASC`,
    [serverId],
  );
  return result.rows;
}

export async function getRole(roleId: string): Promise<RoleRow | null> {
  const result = await getPool().query<RoleRow>(
    `SELECT ${ROLE_COLUMNS} FROM roles WHERE id = $1`,
    [roleId],
  );
  return result.rows[0] ?? null;
}

export async function createRole(
  serverId: string,
  input: {
    name: string;
    color?: string | null;
    mentionable?: boolean;
    permissions: bigint;
  },
): Promise<RoleRow> {
  const parsed = roleNameSchema.parse(input.name);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Discord: a new role sits just above @everyone, lowest custom rank.
    await client.query(
      `UPDATE roles SET position = position + 1
        WHERE server_id = $1 AND is_everyone = FALSE`,
      [serverId],
    );
    const result = await client.query<RoleRow>(
      `INSERT INTO roles (server_id, name, color, mentionable, permissions, position)
       VALUES ($1, $2, $3, $4, $5, 1)
       RETURNING ${ROLE_COLUMNS}`,
      [
        serverId,
        parsed,
        input.color ?? null,
        input.mentionable ?? false,
        serializePermissions(input.permissions),
      ],
    );
    await client.query("COMMIT");
    await bumpPermissionsVersion(serverId);
    invalidateServerAudience(serverId);
    return result.rows[0]!;
  } catch (error) {
    await client.query("ROLLBACK");
    if (isUniqueViolation(error)) {
      throw new HttpError(409, "A role with that name already exists");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function updateRole(
  role: RoleRow,
  input: {
    name?: string;
    color?: string | null;
    mentionable?: boolean;
    hoist?: boolean;
    permissions?: bigint;
  },
): Promise<RoleRow> {
  try {
    const result = await getPool().query<RoleRow>(
      `UPDATE roles SET
         name = COALESCE($2, name),
         color = CASE WHEN $3::boolean THEN $4 ELSE color END,
         mentionable = COALESCE($5, mentionable),
         hoist = COALESCE($6, hoist),
         permissions = COALESCE($7, permissions)
       WHERE id = $1
       RETURNING ${ROLE_COLUMNS}`,
      [
        role.id,
        input.name ?? null,
        input.color !== undefined,
        input.color ?? null,
        input.mentionable ?? null,
        input.hoist ?? null,
        input.permissions !== undefined
          ? serializePermissions(
              role.is_everyone
                ? clampEveryonePermissions(input.permissions)
                : input.permissions,
            )
          : role.is_everyone
            ? serializePermissions(
                clampEveryonePermissions(parsePermissions(role.permissions)),
              )
            : null,
      ],
    );
    await bumpPermissionsVersion(role.server_id);
    invalidateServerAudience(role.server_id);
    return result.rows[0]!;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, "A role with that name already exists");
    }
    throw error;
  }
}

export async function deleteRole(role: RoleRow): Promise<void> {
  if (role.is_everyone || role.system_key) {
    throw new HttpError(400, "That role cannot be deleted");
  }
  await getPool().query(`DELETE FROM roles WHERE id = $1`, [role.id]);
  await bumpPermissionsVersion(role.server_id);
  invalidateServerAudience(role.server_id);
}

export async function reorderRoles(
  serverId: string,
  roleIds: string[],
  actor: { isOwner: boolean; hasAdministrator: boolean; position: number },
): Promise<void> {
  const existing = await listRoles(serverId);
  const everyone = existing.find((role) => role.is_everyone);
  const movable = existing.filter((role) => !role.is_everyone);
  const canMoveAny = actor.isOwner || actor.hasAdministrator;
  const editable = canMoveAny
    ? movable
    : movable.filter((role) => role.position < actor.position);
  if (roleIds.length !== editable.length) {
    throw new HttpError(400, "Role order must include every role you can move");
  }
  const known = new Set(editable.map((role) => role.id));
  for (const id of roleIds) {
    if (!known.has(id)) {
      throw new HttpError(400, "Unknown role in order");
    }
  }
  const slots = editable
    .map((role) => role.position)
    .sort((left, right) => left - right);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (everyone) {
      await client.query(`UPDATE roles SET position = 0 WHERE id = $1`, [
        everyone.id,
      ]);
    }
    for (let index = 0; index < roleIds.length; index += 1) {
      const position = canMoveAny ? index + 1 : slots[index]!;
      await client.query(`UPDATE roles SET position = $2 WHERE id = $1`, [
        roleIds[index],
        position,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await bumpPermissionsVersion(serverId);
}

export async function assignRole(
  serverId: string,
  userId: string,
  roleId: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO member_roles (server_id, user_id, role_id)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [serverId, userId, roleId],
  );
  await bumpPermissionsVersion(serverId);
  invalidateServerAudience(serverId);
}

export async function unassignRole(
  serverId: string,
  userId: string,
  roleId: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM member_roles
      WHERE server_id = $1 AND user_id = $2 AND role_id = $3`,
    [serverId, userId, roleId],
  );
  await bumpPermissionsVersion(serverId);
  invalidateServerAudience(serverId);
}

export async function upsertChannelOverwrite(
  channelId: string,
  serverId: string,
  targetType: "role" | "member",
  targetId: string,
  allow: bigint,
  deny: bigint,
): Promise<void> {
  await getPool().query(
    `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (channel_id, target_type, target_id)
     DO UPDATE SET allow = EXCLUDED.allow, deny = EXCLUDED.deny`,
    [
      channelId,
      targetType,
      targetId,
      serializePermissions(allow),
      serializePermissions(deny),
    ],
  );
  await bumpPermissionsVersion(serverId);
  invalidateServerAudience(serverId);
}

export async function deleteChannelOverwrite(
  channelId: string,
  serverId: string,
  targetType: "role" | "member",
  targetId: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM channel_overwrites
      WHERE channel_id = $1 AND target_type = $2 AND target_id = $3`,
    [channelId, targetType, targetId],
  );
  await bumpPermissionsVersion(serverId);
  invalidateServerAudience(serverId);
}

export async function listChannelOverwrites(channelId: string) {
  const result = await getPool().query<{
    target_type: "role" | "member";
    target_id: string;
    allow: string;
    deny: string;
  }>(
    `SELECT target_type, target_id, allow::text AS allow, deny::text AS deny
       FROM channel_overwrites WHERE channel_id = $1`,
    [channelId],
  );
  return result.rows.map((row) => ({
    targetType: row.target_type,
    targetId: row.target_id,
    allow: row.allow,
    deny: row.deny,
  }));
}

export async function assertCanEditRole(
  actorId: string,
  role: RoleRow,
): Promise<{ actorPerms: bigint }> {
  const ctx = await loadMemberPermissionContext(role.server_id, actorId);
  if (!ctx) {
    throw new HttpError(404, "Server not found");
  }
  const actorPerms = await computeMemberPermissions(role.server_id, actorId);
  if (!hasPermission(actorPerms, Permission.MANAGE_ROLES)) {
    throw new HttpError(403, "You cannot manage roles");
  }
  if (!ctx.isOwner && !ctx.hasAdministrator && role.position >= ctx.topPosition) {
    throw new HttpError(403, "You can only edit roles below yours");
  }
  return { actorPerms };
}

export function clampRolePermissions(
  actorPerms: bigint,
  requested: bigint,
  current: bigint,
): bigint {
  const grantable = grantablePermissions(actorPerms);
  const added = requested & ~current;
  const removed = current & ~requested;
  if ((added & ~grantable) !== 0n || (removed & ~grantable) !== 0n) {
    throw new HttpError(403, "You cannot grant or remove permissions you do not have");
  }
  return requested;
}

export { parsePermissions };

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "23505"
  );
}

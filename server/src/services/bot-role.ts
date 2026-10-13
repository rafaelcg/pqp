import { grantablePermissions, hasPermission, Permission, serializePermissions } from "@pqp/shared";
import { getPool } from "../db.js";
import { logEvent } from "../lib/log.js";
import { logAudit } from "./audit.js";
import { botToolPermissions } from "./bot-actions.js";
import { normalizeTools } from "./bots.js";
import { computeMemberPermissions } from "./permissions.js";
import {
  assertCanEditRole,
  assignRole,
  createRole,
  deleteRole,
  getRole,
  parsePermissions,
  updateRole,
  type RoleRow,
} from "./roles.js";

/**
 * A server bot's own role. Without one the bot holds only @everyone's
 * permissions, so every write it stages fails at the route's own check (the
 * bot's key of the two). Staff never have to build it by hand: saving the
 * bot's tool switches makes or adjusts it.
 *
 * The role follows the same rules as a role a person makes:
 *   * Only somebody who may manage roles makes or changes it; for anybody else
 *     the save goes through and `missing` says what the tools still lack. An
 *     existing role is changed only by somebody it ranks below.
 *   * It carries only what the switched-on tools need, and never a bit the
 *     staff member saving it does not hold themselves (`grantablePermissions`).
 *     A bit an earlier, more powerful staff member granted is kept while its
 *     tool stays on; one whose tool goes off is removed.
 *   * It is made at the lowest custom rank, as `createRole` always does, so the
 *     bot outranks nobody and its moderation tools reach only members with no
 *     role, the same reach the hierarchy gives anybody that low.
 *   * Every change is in the audit log under the staff member who saved it.
 */

export interface BotRoleSync {
  roleId: string | null;
  /** Changed anything (a new role, new bits, a re-grant): the caller pings permissions. */
  changed: boolean;
  /** Bits the tools need that the saver could not grant. */
  missing: bigint;
}

interface BotRoleSource {
  user_id: string;
  role_id: string | null;
  tools: string[] | null;
  username: string;
}

export async function syncBotRole(input: {
  serverId: string;
  botId: string;
  actorId: string;
}): Promise<BotRoleSync | null> {
  const found = await getPool().query<BotRoleSource>(
    `SELECT b.user_id, b.role_id, b.tools, u.username
       FROM server_bots b JOIN users u ON u.id = b.user_id
      WHERE b.server_id = $1 AND b.id = $2`,
    [input.serverId, input.botId],
  );
  const bot = found.rows[0];
  if (!bot) {
    return null;
  }
  const needed = botToolPermissions(normalizeTools(bot.tools));
  const actorPerms = await computeMemberPermissions(input.serverId, input.actorId);
  const grantable = grantablePermissions(actorPerms);
  const existing = bot.role_id ? await getRole(bot.role_id) : null;
  const role = existing && existing.server_id === input.serverId ? existing : null;

  if (role) {
    const current = parsePermissions(role.permissions);
    if (!(await mayEdit(input.actorId, role))) {
      return { roleId: role.id, changed: false, missing: needed & ~current };
    }
    const next = needed & (current | grantable);
    let changed = false;
    if (next !== current) {
      await updateRole(role, { permissions: next });
      await logAudit({
        serverId: input.serverId,
        actorId: input.actorId,
        action: "role.update",
        targetType: "role",
        targetId: role.id,
        changes: [
          {
            key: "permissions",
            old: serializePermissions(current),
            new: serializePermissions(next),
          },
        ],
      });
      changed = true;
    }
    // Saving the switches is also how a role staff took off the bot comes back.
    if (await grantIfMissing(input.serverId, bot.user_id, role, input.actorId)) {
      changed = true;
    }
    return { roleId: role.id, changed, missing: needed & ~next };
  }

  if (!hasPermission(actorPerms, Permission.MANAGE_ROLES)) {
    return { roleId: null, changed: false, missing: needed };
  }
  const permissions = needed & grantable;
  const created = await createNamedRole(input.serverId, bot.username, permissions);
  // Compare and set: two saves at once may each have made a role. The one
  // that loses takes its own back out and goes with the winner's.
  const claimed = await getPool().query(
    `UPDATE server_bots SET role_id = $3
      WHERE server_id = $1 AND id = $2 AND role_id IS NOT DISTINCT FROM $4`,
    [input.serverId, input.botId, created.id, bot.role_id],
  );
  if ((claimed.rowCount ?? 0) === 0) {
    await deleteRole(created);
    return syncBotRole(input);
  }
  await logAudit({
    serverId: input.serverId,
    actorId: input.actorId,
    action: "role.create",
    targetType: "role",
    targetId: created.id,
    changes: [{ key: "name", old: null, new: created.name }],
  });
  await grantIfMissing(input.serverId, bot.user_id, created, input.actorId);
  return { roleId: created.id, changed: true, missing: needed & ~permissions };
}

/** The bot is gone: so is the role that existed only for it. */
export async function deleteBotRole(input: {
  serverId: string;
  roleId: string;
  actorId: string;
}): Promise<boolean> {
  const role = await getRole(input.roleId);
  if (!role || role.server_id !== input.serverId || role.is_everyone || role.system_key) {
    return false;
  }
  await deleteRole(role);
  await logAudit({
    serverId: input.serverId,
    actorId: input.actorId,
    action: "role.delete",
    targetType: "role",
    targetId: role.id,
    changes: [{ key: "name", old: role.name, new: null }],
  });
  return true;
}

async function mayEdit(actorId: string, role: RoleRow): Promise<boolean> {
  try {
    await assertCanEditRole(actorId, role);
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 403) {
      return false;
    }
    throw error;
  }
}

async function grantIfMissing(
  serverId: string,
  userId: string,
  role: RoleRow,
  actorId: string,
): Promise<boolean> {
  const held = await getPool().query(
    `SELECT 1 FROM member_roles WHERE server_id = $1 AND user_id = $2 AND role_id = $3`,
    [serverId, userId, role.id],
  );
  if (held.rows.length > 0) {
    return false;
  }
  await assignRole(serverId, userId, role.id);
  await logAudit({
    serverId,
    actorId,
    action: "member.roles_update",
    targetType: "user",
    targetId: userId,
    changes: [{ key: "roleId", old: null, new: role.id }],
  });
  return true;
}

/**
 * The role is named after the bot's handle (`tico_bot`), within the role name
 * rules (2 to 32 of `A-Za-z0-9_`), with a number when a role already has it.
 */
async function createNamedRole(
  serverId: string,
  username: string,
  permissions: bigint,
): Promise<RoleRow> {
  const stem = username.replace(/[^A-Za-z0-9_]+/g, "").slice(0, 28) || "bot";
  const base = stem.length >= 2 ? stem : `${stem}_bot`;
  for (let attempt = 1; attempt <= 9; attempt += 1) {
    const name = attempt === 1 ? base : `${base}_${attempt}`;
    try {
      return await createRole(serverId, { name, permissions });
    } catch (error) {
      if ((error as { status?: number }).status !== 409) {
        throw error;
      }
      logEvent("bots.roleNameTaken", { serverId, name });
    }
  }
  throw new Error("No free role name for the bot");
}

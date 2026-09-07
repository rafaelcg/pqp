import {
  actorOutranksTarget,
  computePermissions,
  grantablePermissions,
  hasPermission,
  parsePermissions,
  PERMISSION_ALL,
  PERMISSION_DEFAULT_EVERYONE,
  PERMISSION_DEFAULT_MANAGER,
  PERMISSION_DEFAULT_MODERATOR,
  Permission,
  serializePermissions,
  STAFF_ROLE_COLORS,
  STAFF_ROLE_NAMES,
  type PermissionOverwrite,
} from "@pqp/shared";
import type { PoolClient } from "pg";
import { getPool } from "../db.js";

type Queryable = Pick<PoolClient, "query">;

const VIEW = Permission.VIEW_CHANNEL;

function asBigInt(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && value.length > 0) {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

export async function seedDefaultRoles(
  db: Queryable,
  serverId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO roles (server_id, name, permissions, position, is_everyone, system_key, mentionable)
     VALUES ($1, 'everyone', $2, 0, TRUE, 'everyone', FALSE)
     ON CONFLICT DO NOTHING`,
    [serverId, serializePermissions(PERMISSION_DEFAULT_EVERYONE)],
  );
  await db.query(
    `INSERT INTO roles (server_id, name, permissions, position, is_everyone, system_key, mentionable, hoist, show_badge, color)
     VALUES ($1, $2, $3, 1, FALSE, 'vip', FALSE, TRUE, TRUE, $4)
     ON CONFLICT DO NOTHING`,
    [
      serverId,
      STAFF_ROLE_NAMES.vip,
      serializePermissions(0n),
      STAFF_ROLE_COLORS.vip,
    ],
  );
  await db.query(
    `INSERT INTO roles (server_id, name, permissions, position, is_everyone, system_key, mentionable, hoist, show_badge, color)
     VALUES ($1, $2, $3, 2, FALSE, 'moderator', FALSE, TRUE, TRUE, $4)
     ON CONFLICT DO NOTHING`,
    [
      serverId,
      STAFF_ROLE_NAMES.moderator,
      serializePermissions(PERMISSION_DEFAULT_MODERATOR),
      STAFF_ROLE_COLORS.moderator,
    ],
  );
  await db.query(
    `INSERT INTO roles (server_id, name, permissions, position, is_everyone, system_key, mentionable, hoist, show_badge, color)
     VALUES ($1, $2, $3, 3, FALSE, 'manager', FALSE, TRUE, TRUE, $4)
     ON CONFLICT DO NOTHING`,
    [
      serverId,
      STAFF_ROLE_NAMES.manager,
      serializePermissions(PERMISSION_DEFAULT_MANAGER),
      STAFF_ROLE_COLORS.manager,
    ],
  );
  await db.query(
    `INSERT INTO roles (server_id, name, permissions, position, is_everyone, system_key, mentionable, hoist, show_badge, color)
     VALUES ($1, $2, $3, 4, FALSE, 'admin', FALSE, TRUE, TRUE, $4)
     ON CONFLICT DO NOTHING`,
    [
      serverId,
      STAFF_ROLE_NAMES.admin,
      serializePermissions(PERMISSION_ALL),
      STAFF_ROLE_COLORS.admin,
    ],
  );
  await db.query(
    `INSERT INTO roles (server_id, name, permissions, position, is_everyone, system_key, mentionable, hoist, show_badge, color)
     VALUES ($1, $2, $3, 5, FALSE, 'owner', FALSE, TRUE, TRUE, $4)
     ON CONFLICT DO NOTHING`,
    [
      serverId,
      STAFF_ROLE_NAMES.owner,
      serializePermissions(0n),
      STAFF_ROLE_COLORS.owner,
    ],
  );
}

async function everyoneRoleId(
  db: Queryable,
  serverId: string,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM roles WHERE server_id = $1 AND is_everyone`,
    [serverId],
  );
  return result.rows[0]?.id ?? null;
}

export async function getEveryoneRoleId(
  serverId: string,
): Promise<string | null> {
  return everyoneRoleId(getPool(), serverId);
}

/**
 * @everyone's VIEW bit is owned by the private-channel toggle. An overwrite
 * write must not desync `is_private` from the resolver.
 */
export function coerceEveryoneViewOverwrite(
  isPrivate: boolean,
  allow: bigint,
  deny: bigint,
): { allow: bigint; deny: bigint } {
  if (isPrivate) {
    return { allow: allow & ~VIEW, deny: deny | VIEW };
  }
  return { allow: allow & ~VIEW, deny: deny & ~VIEW };
}

export async function restorePrivateEveryoneViewOverwrite(
  channelId: string,
  serverId: string,
): Promise<void> {
  await applyPrivateChannelOverwrites(getPool(), channelId, serverId, true);
}

export async function readPermissionsVersion(
  serverId: string,
): Promise<number> {
  const result = await getPool().query<{ permissions_version: number }>(
    `SELECT permissions_version FROM servers WHERE id = $1`,
    [serverId],
  );
  return result.rows[0]?.permissions_version ?? 0;
}

export async function listServerMemberIds(
  serverId: string,
): Promise<string[]> {
  const result = await getPool().query<{ user_id: string }>(
    `SELECT user_id FROM server_members WHERE server_id = $1`,
    [serverId],
  );
  return result.rows.map((row) => row.user_id);
}

/**
 * Private-channel sugar: @everyone deny VIEW, and (separately) member allow
 * VIEW rows written by addChannelMember. Public: drop the VIEW deny / allow
 * sugar without wiping unrelated overwrite bits.
 */
export async function applyPrivateChannelOverwrites(
  db: Queryable,
  channelId: string,
  serverId: string,
  isPrivate: boolean,
): Promise<void> {
  const everyoneId = await everyoneRoleId(db, serverId);
  if (!everyoneId) {
    return;
  }
  if (isPrivate) {
    await db.query(
      `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
       VALUES ($1, 'role', $2, 0, $3)
       ON CONFLICT (channel_id, target_type, target_id)
       DO UPDATE SET
         deny = channel_overwrites.deny | EXCLUDED.deny,
         allow = channel_overwrites.allow & ~EXCLUDED.deny`,
      [channelId, everyoneId, serializePermissions(VIEW)],
    );
    return;
  }
  await db.query(
    `UPDATE channel_overwrites
        SET deny = deny & ~$3::bigint,
            allow = allow & ~$3::bigint
      WHERE channel_id = $1 AND target_type = 'role' AND target_id = $2`,
    [channelId, everyoneId, serializePermissions(VIEW)],
  );
  await db.query(
    `DELETE FROM channel_overwrites
      WHERE channel_id = $1 AND allow = 0 AND deny = 0`,
    [channelId],
  );
}

export async function upsertMemberViewOverwrite(
  db: Queryable,
  channelId: string,
  userId: string,
): Promise<void> {
  const privateRow = await db.query<{ is_private: boolean }>(
    `SELECT is_private FROM channels WHERE id = $1 AND kind = 'server'`,
    [channelId],
  );
  if (!privateRow.rows[0]?.is_private) {
    return;
  }
  await db.query(
    `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
     VALUES ($1, 'member', $2, $3, 0)
     ON CONFLICT (channel_id, target_type, target_id)
     DO UPDATE SET
       allow = channel_overwrites.allow | EXCLUDED.allow,
       deny = channel_overwrites.deny & ~EXCLUDED.allow`,
    [channelId, userId, serializePermissions(VIEW)],
  );
}

export async function deleteMemberViewOverwrite(
  db: Queryable,
  channelId: string,
  userId: string,
): Promise<void> {
  await db.query(
    `UPDATE channel_overwrites
        SET allow = allow & ~$3::bigint
      WHERE channel_id = $1 AND target_type = 'member' AND target_id = $2`,
    [channelId, userId, serializePermissions(VIEW)],
  );
  await db.query(
    `DELETE FROM channel_overwrites
      WHERE channel_id = $1 AND target_type = 'member' AND target_id = $2
        AND allow = 0 AND deny = 0`,
    [channelId, userId],
  );
}

export async function bumpPermissionsVersion(serverId: string): Promise<number> {
  const result = await getPool().query<{ permissions_version: number }>(
    `UPDATE servers
        SET permissions_version = permissions_version + 1
      WHERE id = $1
      RETURNING permissions_version`,
    [serverId],
  );
  return result.rows[0]?.permissions_version ?? 0;
}

interface RoleRow {
  id: string;
  permissions: string;
  position: number;
  is_everyone: boolean;
  system_key: string | null;
  /** Whether the member this context is for holds this role. */
  held: boolean;
}

interface OverwriteRow {
  target_type: "role" | "member";
  target_id: string;
  allow: string;
  deny: string;
}

function overwriteOf(row: OverwriteRow): PermissionOverwrite {
  return { allow: asBigInt(row.allow), deny: asBigInt(row.deny) };
}

export interface MemberPermissionContext {
  /** Who this context is for; the overwrite pass needs it and callers have it. */
  userId: string;
  isOwner: boolean;
  isAdminRank: boolean;
  everyonePermissions: bigint;
  everyoneRoleId: string | null;
  heldRoles: Array<{ id: string; permissions: bigint; position: number }>;
  topPosition: number;
  hasAdministrator: boolean;
  /**
   * What this server calls this member, or null when they use their account
   * name. Read here because the membership row is already being fetched, and
   * every caller that resolves permissions for a person about to be shown to
   * other people (a voice join, an SFU token) needed it and was paying a
   * second round trip for one nullable column. `resolveMemberName` remains the
   * answer for callers that have no reason to resolve permissions.
   */
  nickname: string | null;
}

export async function loadMemberPermissionContext(
  serverId: string,
  userId: string,
): Promise<MemberPermissionContext | null> {
  const pool = getPool();
  const server = await pool.query<{
    owner_id: string;
    role: string | null;
    nickname: string | null;
  }>(
    `SELECT s.owner_id, sm.role, sm.nickname
       FROM servers s
       LEFT JOIN server_members sm
         ON sm.server_id = s.id AND sm.user_id = $2
      WHERE s.id = $1`,
    [serverId, userId],
  );
  const row = server.rows[0];
  if (!row || !row.role) {
    return null;
  }

  // One statement rather than two. The old pair read every role of the server
  // and then read this member's `member_roles` to decide which of them to
  // keep; the join answers both at once, off the same (server_id, user_id)
  // primary key the second query used, and the rows are identical — a
  // `member_roles` entry for a role that no longer exists was dropped by the
  // old filter and is dropped by the join. Every permission check in the app
  // pays for this one, and a voice join pays for it twice (join, then the SFU
  // token mint).
  const roles = await pool.query<RoleRow>(
    `SELECT r.id, r.permissions::text AS permissions, r.position, r.is_everyone,
            r.system_key, (mr.user_id IS NOT NULL) AS held
       FROM roles r
       LEFT JOIN member_roles mr
         ON mr.role_id = r.id AND mr.server_id = r.server_id AND mr.user_id = $2
      WHERE r.server_id = $1`,
    [serverId, userId],
  );

  const everyone = roles.rows.find((role) => role.is_everyone);
  const heldRoles = roles.rows
    .filter((role) => role.held)
    .map((role) => ({
      id: role.id,
      permissions: asBigInt(role.permissions),
      position: role.position,
    }));

  const isOwner = row.owner_id === userId;
  let topPosition = everyone?.position ?? 0;
  for (const role of heldRoles) {
    if (role.position > topPosition) {
      topPosition = role.position;
    }
  }
  if (isOwner) {
    topPosition = Number.MAX_SAFE_INTEGER;
  }

  const assembled = computePermissions({
    isOwner,
    everyonePermissions: asBigInt(everyone?.permissions ?? 0),
    rolePermissions: heldRoles.map((role) => role.permissions),
    roleOverwrites: [],
  });

  return {
    userId,
    isOwner,
    isAdminRank: row.role === "admin",
    everyonePermissions: asBigInt(everyone?.permissions ?? 0),
    everyoneRoleId: everyone?.id ?? null,
    heldRoles,
    topPosition,
    hasAdministrator: hasPermission(assembled, Permission.ADMINISTRATOR),
    nickname: row.nickname,
  };
}

/**
 * A channel a caller already has in hand.
 *
 * Passing this instead of an id skips the lookup that turns a thread into its
 * parent, which every caller holding a `channels` row can answer for free and
 * which is otherwise a round trip on paths that just read the row (the voice
 * join reads it to check `type`, then paid for this).
 */
export interface PermissionChannelRef {
  id: string;
  type: string | null;
  parent_id: string | null;
}

export async function computeMemberPermissions(
  serverId: string,
  userId: string,
  channel?: string | PermissionChannelRef | null,
  options?: { timedOut?: boolean },
): Promise<bigint> {
  return (
    await resolveMemberChannelPermissions(serverId, userId, channel, options)
  ).permissions;
}

export interface MemberChannelPermissions {
  permissions: bigint;
  /**
   * What this server calls this member, or null when they use their account
   * name. Carried here because the membership row is read either way, and a
   * caller that resolves a member's permissions in order to *show* them to
   * other people — the voice join, the SFU token mint — needed both and was
   * paying two round trips for it. `resolveMemberName` stays the answer for
   * callers with no reason to resolve permissions.
   */
  nickname: string | null;
}

/**
 * The bits AND who the member is, in one pass over the same rows.
 *
 * `computeMemberPermissions` is this with the second half thrown away, and is
 * still the right call for the many places that only want the bits.
 */
export async function resolveMemberChannelPermissions(
  serverId: string,
  userId: string,
  channel?: string | PermissionChannelRef | null,
  options?: { timedOut?: boolean },
): Promise<MemberChannelPermissions> {
  const ctx = await loadMemberPermissionContext(serverId, userId);
  if (!ctx) {
    return { permissions: 0n, nickname: null };
  }
  return {
    permissions: await applyChannelOverwrites(ctx, channel ?? null, options),
    nickname: ctx.nickname,
  };
}

async function applyChannelOverwrites(
  ctx: MemberPermissionContext,
  channel: string | PermissionChannelRef | null,
  options?: { timedOut?: boolean },
): Promise<bigint> {
  let everyoneOverwrite: PermissionOverwrite | null = null;
  const roleOverwrites: PermissionOverwrite[] = [];
  let memberOverwrite: PermissionOverwrite | null = null;
  const userId = ctx.userId;

  if (channel) {
    // Threads have no overwrite rows of their own. Privacy and send/react
    // gates follow the parent, the same way `channelVisibleSql` does.
    let overwriteChannelId: string;
    if (typeof channel === "string") {
      const effective = await getPool().query<{ id: string }>(
        `SELECT CASE
           WHEN type = 'thread' AND parent_id IS NOT NULL THEN parent_id
           ELSE id
         END AS id
           FROM channels
          WHERE id = $1`,
        [channel],
      );
      overwriteChannelId = effective.rows[0]?.id ?? channel;
    } else {
      overwriteChannelId =
        channel.type === "thread" && channel.parent_id
          ? channel.parent_id
          : channel.id;
    }
    const overwrites = await getPool().query<OverwriteRow>(
      `SELECT target_type, target_id, allow::text AS allow, deny::text AS deny
         FROM channel_overwrites WHERE channel_id = $1`,
      [overwriteChannelId],
    );
    const heldIds = new Set(ctx.heldRoles.map((role) => role.id));
    for (const row of overwrites.rows) {
      if (row.target_type === "member" && row.target_id === userId) {
        memberOverwrite = overwriteOf(row);
        continue;
      }
      if (row.target_type !== "role") {
        continue;
      }
      if (row.target_id === ctx.everyoneRoleId) {
        everyoneOverwrite = overwriteOf(row);
        continue;
      }
      if (heldIds.has(row.target_id)) {
        roleOverwrites.push(overwriteOf(row));
      }
    }
  }

  return computePermissions({
    isOwner: ctx.isOwner,
    everyonePermissions: ctx.everyonePermissions,
    rolePermissions: ctx.heldRoles.map((role) => role.permissions),
    everyoneOverwrite,
    roleOverwrites,
    memberOverwrite,
    timedOut: options?.timedOut,
  });
}

export async function memberHasPermission(
  serverId: string,
  userId: string,
  bit: bigint,
  channelId?: string | null,
): Promise<boolean> {
  const perms = await computeMemberPermissions(serverId, userId, channelId);
  return hasPermission(perms, bit);
}

export async function getPermissionsSnapshot(
  serverId: string,
  userId: string,
  channelIds: readonly string[],
): Promise<{ version: number; server: string; channels: Record<string, string> }> {
  const version = await readPermissionsVersion(serverId);
  const server = await computeMemberPermissions(serverId, userId);
  const channels: Record<string, string> = {};
  await Promise.all(
    channelIds.map(async (channelId) => {
      channels[channelId] = serializePermissions(
        await computeMemberPermissions(serverId, userId, channelId),
      );
    }),
  );
  return {
    version,
    server: serializePermissions(server),
    channels,
  };
}

export async function getMemberHierarchy(
  serverId: string,
  userId: string,
): Promise<{
  isOwner: boolean;
  position: number;
  hasAdministrator: boolean;
} | null> {
  const ctx = await loadMemberPermissionContext(serverId, userId);
  if (!ctx) {
    return null;
  }
  return {
    isOwner: ctx.isOwner,
    position: ctx.topPosition,
    hasAdministrator: ctx.hasAdministrator,
  };
}

export function canActOnMember(
  actor: { isOwner: boolean; position: number },
  target: { isOwner: boolean; position: number; hasAdministrator: boolean },
): boolean {
  return actorOutranksTarget({
    actorIsOwner: actor.isOwner,
    actorPosition: actor.position,
    targetIsOwner: target.isOwner,
    targetHasAdministrator: target.hasAdministrator,
    targetPosition: target.position,
  });
}

export { grantablePermissions, hasPermission, parsePermissions, Permission };

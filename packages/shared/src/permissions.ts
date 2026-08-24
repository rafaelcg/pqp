import { z } from "zod";

/**
 * Permission bits for a server and its channels.
 *
 * Names follow Discord's published flags so the 8-step overwrite algorithm
 * (https://docs.discord.com/developers/topics/permissions) maps 1:1. The bit
 * *numbers* are ours (0–19). Never do this math in JS `number` — `1 << 31`
 * overflows; always `bigint`.
 *
 * On the wire, bitfields are decimal strings. In Postgres they are `BIGINT`.
 */

export const Permission = {
  CREATE_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_SERVER: 1n << 5n,
  VIEW_CHANNEL: 1n << 6n,
  SEND_MESSAGES: 1n << 7n,
  MANAGE_MESSAGES: 1n << 8n,
  ATTACH_FILES: 1n << 9n,
  READ_MESSAGE_HISTORY: 1n << 10n,
  MENTION_EVERYONE: 1n << 11n,
  CONNECT: 1n << 12n,
  SPEAK: 1n << 13n,
  MUTE_MEMBERS: 1n << 14n,
  CHANGE_NICKNAME: 1n << 15n,
  MANAGE_NICKNAMES: 1n << 16n,
  MANAGE_ROLES: 1n << 17n,
  MODERATE_MEMBERS: 1n << 18n,
  ADD_REACTIONS: 1n << 19n,
} as const;

export type PermissionBit = (typeof Permission)[keyof typeof Permission];

/** Every defined bit. Owner and Administrator resolve to this. */
export const PERMISSION_ALL = (1n << 20n) - 1n;

/**
 * Default `@everyone` mask: chat, react, attach, history, voice, own nick,
 * create invite. No kick/ban/timeout/manage/mention-everyone.
 */
export const PERMISSION_DEFAULT_EVERYONE =
  Permission.CREATE_INVITE |
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.ATTACH_FILES |
  Permission.READ_MESSAGE_HISTORY |
  Permission.CONNECT |
  Permission.SPEAK |
  Permission.CHANGE_NICKNAME |
  Permission.ADD_REACTIONS;

/** What a timeout leaves: you can still see the channel and scroll back. */
export const PERMISSION_TIMEOUT_KEEP =
  Permission.VIEW_CHANNEL | Permission.READ_MESSAGE_HISTORY;

/**
 * Bits `@everyone` must never carry. Kick, ban, timeout and Administrator
 * belong on a higher role. Hierarchy still needs a rank above the target, but
 * OR-ing these onto `@everyone` would hand them to every colour role above it.
 */
export const PERMISSION_EVERYONE_DENIED =
  Permission.ADMINISTRATOR |
  Permission.KICK_MEMBERS |
  Permission.BAN_MEMBERS |
  Permission.MODERATE_MEMBERS;

export function clampEveryonePermissions(value: bigint): bigint {
  return value & ~PERMISSION_EVERYONE_DENIED;
}

export const PERMISSION_FLAGS = [
  { bit: Permission.CREATE_INVITE, key: "CREATE_INVITE" },
  { bit: Permission.KICK_MEMBERS, key: "KICK_MEMBERS" },
  { bit: Permission.BAN_MEMBERS, key: "BAN_MEMBERS" },
  { bit: Permission.ADMINISTRATOR, key: "ADMINISTRATOR" },
  { bit: Permission.MANAGE_CHANNELS, key: "MANAGE_CHANNELS" },
  { bit: Permission.MANAGE_SERVER, key: "MANAGE_SERVER" },
  { bit: Permission.VIEW_CHANNEL, key: "VIEW_CHANNEL" },
  { bit: Permission.SEND_MESSAGES, key: "SEND_MESSAGES" },
  { bit: Permission.MANAGE_MESSAGES, key: "MANAGE_MESSAGES" },
  { bit: Permission.ATTACH_FILES, key: "ATTACH_FILES" },
  { bit: Permission.READ_MESSAGE_HISTORY, key: "READ_MESSAGE_HISTORY" },
  { bit: Permission.MENTION_EVERYONE, key: "MENTION_EVERYONE" },
  { bit: Permission.CONNECT, key: "CONNECT" },
  { bit: Permission.SPEAK, key: "SPEAK" },
  { bit: Permission.MUTE_MEMBERS, key: "MUTE_MEMBERS" },
  { bit: Permission.CHANGE_NICKNAME, key: "CHANGE_NICKNAME" },
  { bit: Permission.MANAGE_NICKNAMES, key: "MANAGE_NICKNAMES" },
  { bit: Permission.MANAGE_ROLES, key: "MANAGE_ROLES" },
  { bit: Permission.MODERATE_MEMBERS, key: "MODERATE_MEMBERS" },
  { bit: Permission.ADD_REACTIONS, key: "ADD_REACTIONS" },
] as const;

export type PermissionFlagKey = (typeof PERMISSION_FLAGS)[number]["key"];

export const permissionBitfieldSchema = z
  .string()
  .regex(/^\d+$/, "Permission bitfield must be a decimal string");

export function serializePermissions(value: bigint): string {
  return value.toString(10);
}

export function parsePermissions(value: string | number | bigint): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      return 0n;
    }
    return BigInt(value);
  }
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

export function hasPermission(perms: bigint, bit: bigint): boolean {
  return (perms & bit) === bit;
}

export interface PermissionOverwrite {
  allow: bigint;
  deny: bigint;
}

export interface ComputePermissionsInput {
  /** Server owner. Short-circuits to ALL before roles or overwrites. */
  isOwner: boolean;
  /** Guild `@everyone` bits. */
  everyonePermissions: bigint;
  /** Other held roles, OR'd. Position does not affect bits. */
  rolePermissions: readonly bigint[];
  everyoneOverwrite?: PermissionOverwrite | null;
  /** Overwrites for other held roles. Union deny, union allow, then apply. */
  roleOverwrites: readonly PermissionOverwrite[];
  memberOverwrite?: PermissionOverwrite | null;
  /**
   * Timeout strip. Owner and Administrator are exempt (they already returned
   * ALL). Everyone else keeps VIEW + READ_MESSAGE_HISTORY only.
   */
  timedOut?: boolean;
}

function applyOverwrite(base: bigint, overwrite: PermissionOverwrite): bigint {
  return (base & ~overwrite.deny) | overwrite.allow;
}

/**
 * Discord's published 8-step resolution, copied as specified:
 *
 * 1. Owner → ALL.
 * 2. Start from `@everyone` guild bits.
 * 3. OR other held roles (position does not affect bits).
 * 4. ADMINISTRATOR → ALL (skips overwrites).
 * 5. Channel `@everyone` overwrite: deny then allow.
 * 6. Union other role overwrites: OR denies, OR allows, then `(perms & ~deny) | allow`.
 * 7. Member overwrite last.
 * 8. Implicit: no VIEW → ignore send/etc; timeout keeps VIEW + READ_HISTORY.
 */
export function computePermissions(input: ComputePermissionsInput): bigint {
  if (input.isOwner) {
    return PERMISSION_ALL;
  }

  let perms = input.everyonePermissions;
  for (const role of input.rolePermissions) {
    perms |= role;
  }

  if (hasPermission(perms, Permission.ADMINISTRATOR)) {
    return PERMISSION_ALL;
  }

  if (input.everyoneOverwrite) {
    perms = applyOverwrite(perms, input.everyoneOverwrite);
  }

  if (input.roleOverwrites.length > 0) {
    let deny = 0n;
    let allow = 0n;
    for (const overwrite of input.roleOverwrites) {
      deny |= overwrite.deny;
      allow |= overwrite.allow;
    }
    perms = applyOverwrite(perms, { allow, deny });
  }

  if (input.memberOverwrite) {
    perms = applyOverwrite(perms, input.memberOverwrite);
  }

  if (!hasPermission(perms, Permission.VIEW_CHANNEL)) {
    return 0n;
  }

  if (input.timedOut) {
    return perms & PERMISSION_TIMEOUT_KEEP;
  }

  return perms;
}

/**
 * Whether the actor may kick / ban / timeout / nick / assign a role on the
 * target. Separate from bits: holding KICK_MEMBERS is not enough if the target
 * sits at an equal or higher role position.
 *
 * Owner position is infinite. Administrator on the target blocks everyone but
 * the owner (Discord: you cannot timeout an Administrator).
 */
export function actorOutranksTarget(input: {
  actorIsOwner: boolean;
  actorPosition: number;
  targetIsOwner: boolean;
  targetHasAdministrator: boolean;
  targetPosition: number;
}): boolean {
  if (input.targetIsOwner) {
    return false;
  }
  if (input.actorIsOwner) {
    return true;
  }
  if (input.targetHasAdministrator) {
    return false;
  }
  return input.actorPosition > input.targetPosition;
}

/**
 * Bits an actor with MANAGE_ROLES may grant or write into an overwrite.
 * Owner and Administrator may grant any defined bit. Everyone else may only
 * grant bits they themselves hold, and never ADMINISTRATOR.
 */
export function grantablePermissions(actorPerms: bigint): bigint {
  if (hasPermission(actorPerms, Permission.ADMINISTRATOR)) {
    return PERMISSION_ALL;
  }
  return actorPerms & ~Permission.ADMINISTRATOR;
}

export const RESERVED_MENTION_NAMES = ["everyone", "here"] as const;

export function isReservedMentionName(name: string): boolean {
  return name.toLowerCase() === "everyone" || name.toLowerCase() === "here";
}

export const roleNameSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(
    /^[A-Za-z0-9_]+$/,
    "Role names are letters, numbers, or underscores",
  )
  .refine((value) => !isReservedMentionName(value), "Role name is reserved");

export const nicknameSchema = z
  .string()
  .min(1)
  .max(32)
  .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), "Invalid characters");

export const roleColorSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Color must be #RRGGBB")
  .nullable();

export const createRoleSchema = z.object({
  name: roleNameSchema,
  color: roleColorSchema.optional(),
  mentionable: z.boolean().optional(),
  permissions: permissionBitfieldSchema.optional(),
});

export const updateRoleSchema = z.object({
  name: roleNameSchema.optional(),
  color: roleColorSchema.optional(),
  mentionable: z.boolean().optional(),
  permissions: permissionBitfieldSchema.optional(),
  hoist: z.boolean().optional(),
});

export const reorderRolesSchema = z.object({
  roleIds: z.array(z.string().uuid()).min(1),
});

export const channelOverwriteSchema = z.object({
  targetType: z.enum(["role", "member"]),
  targetId: z.string().uuid(),
  allow: permissionBitfieldSchema,
  deny: permissionBitfieldSchema,
});

export const updateNicknameSchema = z.object({
  nickname: nicknameSchema.nullable(),
});

export const roleSchema = z.object({
  id: z.string().uuid(),
  serverId: z.string().uuid(),
  name: z.string(),
  color: z.string().nullable(),
  hoist: z.boolean(),
  mentionable: z.boolean(),
  permissions: permissionBitfieldSchema,
  position: z.number().int(),
  isEveryone: z.boolean(),
  systemKey: z.enum(["everyone", "admin"]).nullable().default(null),
});

export type Role = z.infer<typeof roleSchema>;

export const memberPermissionsSchema = z.object({
  version: z.number().int().nonnegative(),
  server: permissionBitfieldSchema,
  channels: z.record(z.string().uuid(), permissionBitfieldSchema),
});

export type MemberPermissions = z.infer<typeof memberPermissionsSchema>;

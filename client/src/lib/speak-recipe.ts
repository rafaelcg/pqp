import {
  hasPermission,
  isWatchPartyChannelType,
  parsePermissions,
  Permission,
} from "@pqp/shared";
import {
  applyOverwriteState,
  overwriteState,
  shouldDeleteOverwrite,
} from "@/lib/overwrite-tristate";

export type RecipeKind = "everyone" | "roles" | "custom";

export interface RecipeOverwrite {
  targetType: "role" | "member";
  targetId: string;
  allow: bigint;
  deny: bigint;
}

export interface RecipeWrite {
  op: "put" | "delete";
  targetType: "role" | "member";
  targetId: string;
  allow: bigint;
  deny: bigint;
}

export function recipeBitsForChannel(type: string): readonly bigint[] {
  if (isWatchPartyChannelType(type)) {
    return [Permission.SPEAK, Permission.START_WATCH_PARTY];
  }
  return type === "voice"
    ? [Permission.SPEAK, Permission.STREAM]
    : [Permission.SEND_MESSAGES];
}

export function recipeBitForChannel(type: string): bigint {
  return recipeBitsForChannel(type)[0]!;
}

/**
 * Owner is the person, not the cargo bits (the Owner row is 0). Administrator
 * skips every channel overwrite. Neither belongs on a speak/post checklist.
 */
export function roleIgnoresChannelOverwrites(role: {
  systemKey?: string | null;
  permissions: string;
}): boolean {
  if (role.systemKey === "owner") {
    return true;
  }
  return hasPermission(
    parsePermissions(role.permissions),
    Permission.ADMINISTRATOR,
  );
}

function asBits(bits: bigint | readonly bigint[]): readonly bigint[] {
  return typeof bits === "bigint" ? [bits] : bits;
}

/**
 * What the channel's overwrites mean for one bit (Speak or Send Messages).
 *
 * everyone — nobody is denied that bit by an overwrite.
 * roles — @everyone is denied, and only role allows (if any) lift it.
 * custom — a member overwrite, a role deny, or any mix the recipe cannot type.
 */
export function readRecipe(
  overwrites: readonly RecipeOverwrite[],
  everyoneId: string,
  bits: bigint | readonly bigint[],
): { kind: RecipeKind; roleIds: string[] } {
  const list = asBits(bits);
  const first = readRecipeForBit(overwrites, everyoneId, list[0]!);
  for (const bit of list.slice(1)) {
    const next = readRecipeForBit(overwrites, everyoneId, bit);
    if (
      next.kind !== first.kind ||
      next.roleIds.length !== first.roleIds.length ||
      next.roleIds.some((id, index) => id !== first.roleIds[index])
    ) {
      return { kind: "custom", roleIds: first.roleIds };
    }
  }
  return first;
}

function readRecipeForBit(
  overwrites: readonly RecipeOverwrite[],
  everyoneId: string,
  bit: bigint,
): { kind: RecipeKind; roleIds: string[] } {
  const roleAllows: string[] = [];
  let everyoneDenied = false;
  let custom = false;

  for (const row of overwrites) {
    const state = overwriteState(bit, row.allow, row.deny);
    if (state === "inherit") {
      continue;
    }
    if (row.targetType === "member") {
      custom = true;
      continue;
    }
    if (row.targetId === everyoneId) {
      if (state === "deny") {
        everyoneDenied = true;
      }
      continue;
    }
    if (state === "deny") {
      custom = true;
      continue;
    }
    if (state === "allow") {
      roleAllows.push(row.targetId);
    }
  }

  if (custom) {
    return { kind: "custom", roleIds: roleAllows };
  }
  if (everyoneDenied) {
    return { kind: "roles", roleIds: roleAllows };
  }
  return { kind: "everyone", roleIds: [] };
}

function rowFor(
  overwrites: readonly RecipeOverwrite[],
  targetType: "role" | "member",
  targetId: string,
): RecipeOverwrite {
  return (
    overwrites.find(
      (row) => row.targetType === targetType && row.targetId === targetId,
    ) ?? { targetType, targetId, allow: 0n, deny: 0n }
  );
}

/** Mute/Move used to live in the channel editor. Strip them from recipe writes. */
const VOICE_RECIPE_LEFTOVERS = [
  Permission.MUTE_MEMBERS,
  Permission.MOVE_MEMBERS,
] as const;

function writeBits(
  row: RecipeOverwrite,
  bits: readonly bigint[],
  state: "allow" | "inherit" | "deny",
): RecipeWrite {
  let allow = row.allow;
  let deny = row.deny;
  for (const bit of bits) {
    const next = applyOverwriteState(bit, state, allow, deny);
    allow = next.allow;
    deny = next.deny;
  }
  if (
    bits.includes(Permission.SPEAK) ||
    bits.includes(Permission.STREAM) ||
    bits.includes(Permission.START_WATCH_PARTY)
  ) {
    for (const extra of VOICE_RECIPE_LEFTOVERS) {
      const next = applyOverwriteState(extra, "inherit", allow, deny);
      allow = next.allow;
      deny = next.deny;
    }
  }
  return {
    op: shouldDeleteOverwrite(allow, deny) ? "delete" : "put",
    targetType: row.targetType,
    targetId: row.targetId,
    allow,
    deny,
  };
}

/**
 * Writes that turn the channel into "everyone" or "only these roles" for one
 * bit. Other bits on the same overwrite rows are left alone. Member-level
 * exceptions on this bit are cleared.
 */
export function planRecipe(
  overwrites: readonly RecipeOverwrite[],
  everyoneId: string,
  bits: bigint | readonly bigint[],
  choice: "everyone" | "roles",
  roleIds: readonly string[],
): RecipeWrite[] {
  const list = asBits(bits);
  const picked = new Set(choice === "roles" ? roleIds : []);
  const writes: RecipeWrite[] = [];
  const seen = new Set<string>();

  function push(write: RecipeWrite) {
    const key = `${write.targetType}:${write.targetId}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const current = rowFor(overwrites, write.targetType, write.targetId);
    if (
      write.op === "delete" &&
      current.allow === 0n &&
      current.deny === 0n &&
      !overwrites.some(
        (row) =>
          row.targetType === write.targetType && row.targetId === write.targetId,
      )
    ) {
      return;
    }
    if (
      write.op === "put" &&
      current.allow === write.allow &&
      current.deny === write.deny &&
      overwrites.some(
        (row) =>
          row.targetType === write.targetType && row.targetId === write.targetId,
      )
    ) {
      return;
    }
    writes.push(write);
  }

  push(
    writeBits(
      rowFor(overwrites, "role", everyoneId),
      list,
      choice === "roles" ? "deny" : "inherit",
    ),
  );

  for (const roleId of picked) {
    push(writeBits(rowFor(overwrites, "role", roleId), list, "allow"));
  }

  for (const row of overwrites) {
    const key = `${row.targetType}:${row.targetId}`;
    if (seen.has(key)) {
      continue;
    }
    if (row.targetType === "role" && picked.has(row.targetId)) {
      continue;
    }
    if (
      list.every((bit) => overwriteState(bit, row.allow, row.deny) === "inherit")
    ) {
      continue;
    }
    push(writeBits(row, list, "inherit"));
  }

  return writes;
}

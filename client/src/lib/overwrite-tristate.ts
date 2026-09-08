import {
  isWatchPartyChannelType,
  Permission,
  type PermissionFlagKey,
} from "@pqp/shared";

/**
 * Bits the channel overwrite editor may flip. Matches the role editor's
 * honesty rule: hide anything the server does not yet enforce.
 */
export const CHANNEL_OVERWRITE_BITS_TEXT = [
  "VIEW_CHANNEL",
  "SEND_MESSAGES",
  "ADD_REACTIONS",
  "MANAGE_MESSAGES",
] as const satisfies readonly PermissionFlagKey[];

/**
 * Channel editor only: who can be here and who can talk or present.
 * Mute and Move stay on Cargos. The server still honours a channel
 * overwrite for those bits if one exists (import or API).
 */
export const CHANNEL_OVERWRITE_BITS_VOICE = [
  "VIEW_CHANNEL",
  "CONNECT",
  "SPEAK",
  "STREAM",
] as const satisfies readonly PermissionFlagKey[];

/**
 * A watch party is a voice room whose stage is the point: STREAM says nothing
 * there (`canStartWatchPartyStream` in @pqp/shared), so the editor offers the
 * bit that does.
 */
export const CHANNEL_OVERWRITE_BITS_WATCH_PARTY = [
  "VIEW_CHANNEL",
  "CONNECT",
  "SPEAK",
  "START_WATCH_PARTY",
] as const satisfies readonly PermissionFlagKey[];

export type OverwriteState = "allow" | "inherit" | "deny";

export type ChannelOverwriteBit = (typeof CHANNEL_OVERWRITE_BITS_TEXT)[number]
  | (typeof CHANNEL_OVERWRITE_BITS_VOICE)[number]
  | (typeof CHANNEL_OVERWRITE_BITS_WATCH_PARTY)[number];

export function overwriteBitsForChannel(
  type: string,
): readonly PermissionFlagKey[] {
  if (isWatchPartyChannelType(type)) {
    return CHANNEL_OVERWRITE_BITS_WATCH_PARTY;
  }
  return type === "voice"
    ? CHANNEL_OVERWRITE_BITS_VOICE
    : CHANNEL_OVERWRITE_BITS_TEXT;
}

export function overwriteState(
  bit: bigint,
  allow: bigint,
  deny: bigint,
): OverwriteState {
  if ((allow & bit) === bit) {
    return "allow";
  }
  if ((deny & bit) === bit) {
    return "deny";
  }
  return "inherit";
}

export function applyOverwriteState(
  bit: bigint,
  state: OverwriteState,
  allow: bigint,
  deny: bigint,
): { allow: bigint; deny: bigint } {
  const nextAllow = allow & ~bit;
  const nextDeny = deny & ~bit;
  if (state === "allow") {
    return { allow: nextAllow | bit, deny: nextDeny };
  }
  if (state === "deny") {
    return { allow: nextAllow, deny: nextDeny | bit };
  }
  return { allow: nextAllow, deny: nextDeny };
}

export function listedBitsMask(
  keys: readonly PermissionFlagKey[],
): bigint {
  return keys.reduce((mask, key) => mask | Permission[key], 0n);
}

/** Delete the row only when every bit, listed or not, is inherit. */
export function shouldDeleteOverwrite(allow: bigint, deny: bigint): boolean {
  return allow === 0n && deny === 0n;
}

export function applyListedOverwriteState(
  keys: readonly PermissionFlagKey[],
  bitKey: PermissionFlagKey,
  state: OverwriteState,
  allow: bigint,
  deny: bigint,
): { allow: bigint; deny: bigint } {
  if (!keys.includes(bitKey)) {
    return { allow, deny };
  }
  return applyOverwriteState(Permission[bitKey], state, allow, deny);
}

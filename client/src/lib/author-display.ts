/**
 * How a message names its author: colour from the highest painted role, and
 * the username half of a `name#1234` tag when the roster did not send one.
 */

/** Quiet glyphs next to a name: rank, then a bot mark for character accounts. */
export type IdentityMark = "owner" | "admin" | "bot";

/**
 * Which marks belong next to a name. A webhook is a posting mechanism, not a
 * member, so it keeps the separate chip and gets none of these. Owner and
 * admin are mutually exclusive ranks; a character can still hold one, and then
 * both marks show.
 */
export function identityMarks(input: {
  rank?: "owner" | "admin" | "member" | null;
  isCharacter?: boolean;
  isWebhook?: boolean;
  /** Crown from the Owner cargo when `show_badge` is on. */
  ownerBadge?: boolean;
  /** Shield from the Admin cargo, not from compatibility rank (Managers share that rank). */
  adminBadge?: boolean;
}): IdentityMark[] {
  if (input.isWebhook) {
    return [];
  }
  const marks: IdentityMark[] = [];
  const owner = input.ownerBadge ?? input.rank === "owner";
  const admin = input.adminBadge ?? (!owner && input.rank === "admin");
  if (owner) {
    marks.push("owner");
  } else if (admin) {
    marks.push("admin");
  }
  if (input.isCharacter) {
    marks.push("bot");
  }
  return marks;
}

export function rankBadges(
  roleIds: readonly string[] | undefined,
  roles: readonly {
    id: string;
    systemKey?: string | null;
    showBadge?: boolean;
  }[],
): { ownerBadge: boolean; adminBadge: boolean } {
  const held = new Set(roleIds ?? []);
  const owner = roles.find((role) => role.systemKey === "owner");
  const admin = roles.find((role) => role.systemKey === "admin");
  return {
    ownerBadge: !!owner && held.has(owner.id) && owner.showBadge !== false,
    adminBadge: !!admin && held.has(admin.id),
  };
}

export function highestRoleColor(
  roleIds: readonly string[] | undefined,
  roles: readonly {
    id: string;
    color: string | null;
    position: number;
  }[],
): string | null {
  if (!roleIds?.length) {
    return null;
  }
  const held = new Set(roleIds);
  let best: { color: string; position: number } | null = null;
  for (const role of roles) {
    if (!held.has(role.id) || !role.color) {
      continue;
    }
    if (!best || role.position > best.position) {
      best = { color: role.color, position: role.position };
    }
  }
  return best?.color ?? null;
}

/** `dev_user#8692` → `dev_user`. A tag without a hash is not a mention handle. */
export function usernameFromTag(
  tag: string | null | undefined,
): string | null {
  if (!tag) {
    return null;
  }
  const hash = tag.lastIndexOf("#");
  if (hash <= 0) {
    return null;
  }
  const username = tag.slice(0, hash).trim();
  return username.length > 0 ? username : null;
}

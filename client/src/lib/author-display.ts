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
}): IdentityMark[] {
  if (input.isWebhook) {
    return [];
  }
  const marks: IdentityMark[] = [];
  if (input.rank === "owner") {
    marks.push("owner");
  } else if (input.rank === "admin") {
    marks.push("admin");
  }
  if (input.isCharacter) {
    marks.push("bot");
  }
  return marks;
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

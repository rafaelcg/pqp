/**
 * How a message names its author: colour from the highest painted role, and
 * the username half of a `name#1234` tag when the roster did not send one.
 */

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

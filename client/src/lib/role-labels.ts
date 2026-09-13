import { STAFF_ROLE_NAMES, type RoleSystemKey } from "@pqp/shared";
import type { MessageKey, Translator } from "@/lib/i18n";
import type { MemberRole } from "@/lib/member-groups";

const SYSTEM_KEY: Record<RoleSystemKey, MessageKey> = {
  everyone: "roles.system.everyone",
  owner: "roles.system.owner",
  admin: "roles.system.admin",
  manager: "roles.system.manager",
  moderator: "roles.system.moderator",
  vip: "roles.system.vip",
};

export type RoleNameSource = {
  id?: string;
  name: string;
  isEveryone?: boolean;
  systemKey?: RoleSystemKey | null;
};

function sameLabel(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

function isSameRole(a: RoleNameSource, b: RoleNameSource): boolean {
  if (a.id && b.id) {
    return a.id === b.id;
  }
  return a === b;
}

/** Localised name while the stored name is still the English seed. */
function resolvedRoleName(role: RoleNameSource, t: Translator["t"]): string {
  if (role.isEveryone || role.systemKey === "everyone") {
    return t("roles.system.everyone");
  }
  if (!role.systemKey) {
    return role.name;
  }
  const seed = STAFF_ROLE_NAMES[role.systemKey];
  if (seed && role.name === seed) {
    return t(SYSTEM_KEY[role.systemKey]);
  }
  return role.name;
}

/**
 * Localised name while the stored name is still the English seed.
 * If translating a seed would match another cargo's stored or displayed
 * name, keep the English seed so two rows are never identical. Homemade
 * cargos keep the name they were given.
 */
export function displayRoleName(
  role: RoleNameSource,
  t: Translator["t"],
  siblings: readonly RoleNameSource[] = [],
): string {
  const label = resolvedRoleName(role, t);
  if (!role.systemKey || role.systemKey === "everyone" || siblings.length === 0) {
    return label;
  }
  if (sameLabel(label, role.name)) {
    return label;
  }
  const collides = siblings.some((other) => {
    if (isSameRole(role, other)) {
      return false;
    }
    return (
      sameLabel(other.name, label) ||
      sameLabel(resolvedRoleName(other, t), label)
    );
  });
  return collides ? role.name : label;
}

/**
 * The channel sidebar header's role badge: `owner` and `admin` say the same
 * thing `displayRoleName` says about the matching cargo, so a server owner
 * reads one word for "who I am here" everywhere it appears rather than one
 * spelling in the roles editor and another over the channel list. `member`
 * has no cargo to borrow from — everyone has it, the way `@everyone` does —
 * so it gets its own key.
 */
export function compatRoleLabel(
  role: MemberRole,
  t: Translator["t"],
): string {
  switch (role) {
    case "owner":
      return t("roles.system.owner");
    case "admin":
      return t("roles.system.admin");
    case "member":
      return t("chrome.role.member");
  }
}

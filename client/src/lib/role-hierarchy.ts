import {
  actorOutranksTarget,
  hasPermission,
  parsePermissions,
  Permission,
} from "@pqp/shared";
import type { MemberRole } from "@/lib/member-groups";

export interface HierarchyRole {
  id: string;
  position: number;
  permissions: string;
  systemKey?: string | null;
}

export function memberPower(
  member: { role: MemberRole; roleIds?: readonly string[] },
  roles: readonly HierarchyRole[],
): {
  isOwner: boolean;
  position: number;
  hasAdministrator: boolean;
} {
  if (member.role === "owner") {
    return {
      isOwner: true,
      position: Number.MAX_SAFE_INTEGER,
      hasAdministrator: true,
    };
  }
  const held = new Set(member.roleIds ?? []);
  let position = 0;
  let hasAdministrator = false;
  for (const role of roles) {
    if (!held.has(role.id)) {
      continue;
    }
    if (role.position > position) {
      position = role.position;
    }
    if (
      role.systemKey === "admin" ||
      hasPermission(parsePermissions(role.permissions), Permission.ADMINISTRATOR)
    ) {
      hasAdministrator = true;
    }
  }
  return { isOwner: false, position, hasAdministrator };
}

export function canActOnMemberClient(
  actor: { role: MemberRole; roleIds?: readonly string[] },
  target: { role: MemberRole; roleIds?: readonly string[] },
  roles: readonly HierarchyRole[],
  actorId: string | null,
  targetId: string,
): boolean {
  if (actorId && actorId === targetId) {
    return false;
  }
  const a = memberPower(actor, roles);
  const b = memberPower(target, roles);
  return actorOutranksTarget({
    actorIsOwner: a.isOwner,
    actorPosition: a.position,
    targetIsOwner: b.isOwner,
    targetHasAdministrator: b.hasAdministrator,
    targetPosition: b.position,
  });
}

export function assignableRoleIds(
  actor: { role: MemberRole; roleIds?: readonly string[] },
  roles: readonly (HierarchyRole & { isEveryone?: boolean })[],
): string[] {
  const power = memberPower(actor, roles);
  return roles
    .filter((role) => {
      if (role.isEveryone || role.systemKey === "everyone" || role.systemKey === "owner") {
        return false;
      }
      return power.isOwner || role.position < power.position;
    })
    .map((role) => role.id);
}

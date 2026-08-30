import type { UserStatus } from "@pqp/shared";

/**
 * How a roster becomes the sections a member list draws.
 *
 * Pure and DOM-free so the rules can be pinned by tests — the sidebar itself is
 * then only markup over this answer. Hoisted cargos follow the order Discord
 * taught people. Unlike Discord, they keep their people when those people go
 * offline: a six-hundred-person Offline list is where owners and admins vanish.
 *
 * THE RULES, AND WHY.
 *
 *  1. A HOISTED ROLE GETS ITS OWN SECTION, most senior first. Owner is always
 *     first and is keyed off rank, not a role row. Custom hoisted roles follow
 *     in the order the caller passed (position descending). @everyone never
 *     hoists. A person lands in the first hoisted role they hold.
 *  2. A HOISTED ROLE KEEPS ITS PEOPLE WHEN THEY GO OFFLINE. Owner, Admin,
 *     Mod, VIP, and every other hoisted cargo stay under that heading, with
 *     an offline pip. A 600-person Offline list is where staff disappear;
 *     the heading is who holds the role, not who is reachable this minute.
 *     Within the section, people who are around sit above people who are
 *     not, then the usual name order.
 *  3. OFFLINE IS EVERYONE WITH NO HOIST, at the bottom. Empty sections still
 *     do not exist: a cargo nobody holds is omitted, not drawn as "Admins — 0".
 *  4. WITHIN A SECTION: around first, then display name, case- and
 *     accent-insensitively, then id. The id tie-break is not cosmetic — two
 *     people called "ana" would otherwise swap places between renders, and
 *     this list re-renders every time anybody's status changes.
 *
 * Rank `admin` does not always write a `member_roles` row (older servers, or
 * iOS Promote before the cargo was assigned). Callers pass `effectiveRoleIds`
 * so a rank-only admin still lands in Admin. Managers share that rank and
 * must not be given the Admin id — they already hold Gerente.
 * The owner lands in the Owner cargo section when that cargo is hoisted.
 */

export type MemberRole = "owner" | "admin" | "member";

export interface HoistedRole {
  id: string;
  name: string;
}

/** Everything this module needs to know about one person. */
export interface GroupableMember {
  id: string;
  displayName: string;
  nickname?: string | null;
  role: MemberRole;
  roleIds?: readonly string[];
  /**
   * Absent means an API that predates status, or a payload that never carried
   * one (a conversation's participants). Read as "not around" — see `isAround`.
   */
  status?: UserStatus | null;
}

/**
 * `all` is the conversation case: one heading, no split. It is a kind rather
 * than "online with a different label" because the difference is real — a
 * participant list carries no status at all, so claiming they are online would
 * be inventing the fact the split is supposed to report.
 */
export type MemberSectionKind = "role" | "online" | "offline" | "all";

export interface MemberSection<T> {
  /** Stable across renders: React keys and the collapse state hang off it. */
  id: string;
  kind: MemberSectionKind;
  /** Set only when `kind` is `"role"` and the section is the owner bucket. */
  role?: MemberRole;
  /** Heading for a hoisted custom role. Owner uses i18n instead. */
  label?: string;
  members: T[];
}

/**
 * Fold the seeded Admin id in only for a rank-admin who has no cargo rows
 * yet. A Manager is also rank `admin`; inventing Admin for them ticks Adm
 * on the profile and hoists them under Adm instead of Gerente.
 */
export function effectiveRoleIds(
  member: { role: MemberRole; roleIds?: readonly string[] },
  adminRoleId: string | null,
  ownerRoleId: string | null = null,
): string[] {
  const ids = [...(member.roleIds ?? [])];
  if (
    member.role === "admin" &&
    adminRoleId &&
    !ids.includes(adminRoleId) &&
    ids.length === 0
  ) {
    ids.push(adminRoleId);
  }
  if (member.role === "owner" && ownerRoleId && !ids.includes(ownerRoleId)) {
    ids.push(ownerRoleId);
  }
  return ids;
}

/**
 * Past this many offline members the Offline section starts closed.
 *
 * Fifty because that is roughly where the section stops being information and
 * starts being the scrollbar: a list you have to scroll past to reach nothing
 * is worse than a list you have to open. Under fifty it stays open, so a small
 * server — which is most of them — never has to click anything.
 */
export const OFFLINE_COLLAPSE_THRESHOLD = 50;

/**
 * How many rows of one section are mounted at a time.
 *
 * Not a virtual scroller: a windowed list has to own the scroll container, and
 * this one is shared by every section. Mounting a page at a time and growing it
 * when the reader reaches the end costs one sentinel and keeps the DOM bounded,
 * which is the part that was actually going to jank.
 */
export const MEMBER_PAGE_SIZE = 100;

/**
 * Around, in the sense the heading means: reachable right now. Idle and
 * do-not-disturb both count — the same call `friends-model.ts` makes, and for
 * the same reason: somebody who stepped away for coffee or asked not to be
 * pinged is still here in the way that matters. An invisible member never
 * arrives as anything but `offline`; the server's status type cannot carry it.
 */
export function isAround(status: UserStatus | null | undefined): boolean {
  return status != null && status !== "offline";
}

/** Alphabetical, then by id so equal names cannot shuffle between renders. */
export function compareMembers(
  a: GroupableMember,
  b: GroupableMember,
): number {
  const nameA = a.nickname?.trim() || a.displayName;
  const nameB = b.nickname?.trim() || b.displayName;
  const byName = nameA.localeCompare(nameB, undefined, {
    sensitivity: "base",
  });
  return byName !== 0 ? byName : a.id.localeCompare(b.id);
}

/** Around first, then the usual name order. Used inside a hoisted cargo. */
function compareHoistedMembers(
  a: GroupableMember,
  b: GroupableMember,
): number {
  const aroundDelta = Number(isAround(b.status)) - Number(isAround(a.status));
  return aroundDelta !== 0 ? aroundDelta : compareMembers(a, b);
}

export function groupMembers<T extends GroupableMember>(
  members: readonly T[],
  hoistedRoles: readonly HoistedRole[] = [],
): MemberSection<T>[] {
  const byHoisted = new Map<string, T[]>(
    hoistedRoles.map((role) => [role.id, []]),
  );
  const online: T[] = [];
  const offline: T[] = [];

  for (const member of members) {
    const held = new Set(member.roleIds ?? []);
    const match = hoistedRoles.find((role) => held.has(role.id));
    if (match) {
      byHoisted.get(match.id)!.push(member);
    } else if (isAround(member.status)) {
      online.push(member);
    } else {
      offline.push(member);
    }
  }

  const sections: MemberSection<T>[] = [];
  for (const role of hoistedRoles) {
    const bucket = byHoisted.get(role.id) ?? [];
    if (bucket.length > 0) {
      sections.push({
        id: `role:${role.id}`,
        kind: "role",
        label: role.name,
        members: bucket.sort(compareHoistedMembers),
      });
    }
  }
  if (online.length > 0) {
    sections.push({
      id: "online",
      kind: "online",
      members: online.sort(compareMembers),
    });
  }
  if (offline.length > 0) {
    sections.push({
      id: "offline",
      kind: "offline",
      members: offline.sort(compareMembers),
    });
  }
  return sections;
}

/**
 * What the reader has explicitly said about each section.
 *
 * TWO SETS, NOT ONE BOOLEAN MAP, because "closed by default" has to be
 * overridable in both directions and a single set cannot express the difference
 * between "not mentioned" and "opened on purpose". A big server's Offline
 * section starts shut without anybody's input; the reader opening it has to
 * survive the next status refresh, and their shutting it again has to survive
 * dropping back under the threshold.
 */
export interface SectionCollapseState {
  /** Sections the reader closed. */
  shut: ReadonlySet<string>;
  /** Sections the reader opened that would otherwise default to closed. */
  opened: ReadonlySet<string>;
}

export const NO_COLLAPSE: SectionCollapseState = {
  shut: new Set(),
  opened: new Set(),
};

/**
 * Is this section drawn as a heading with nothing under it. Only Offline has a
 * default, and only past `OFFLINE_COLLAPSE_THRESHOLD`.
 */
export function sectionCollapsed(
  section: MemberSection<GroupableMember>,
  state: SectionCollapseState,
): boolean {
  if (state.shut.has(section.id)) {
    return true;
  }
  if (state.opened.has(section.id)) {
    return false;
  }
  return (
    section.kind === "offline" &&
    section.members.length > OFFLINE_COLLAPSE_THRESHOLD
  );
}

/** The reader clicked a heading. Returns the next state, never mutating. */
export function toggleSectionCollapse(
  section: MemberSection<GroupableMember>,
  state: SectionCollapseState,
): SectionCollapseState {
  const shut = new Set(state.shut);
  const opened = new Set(state.opened);
  if (sectionCollapsed(section, state)) {
    shut.delete(section.id);
    opened.add(section.id);
  } else {
    opened.delete(section.id);
    shut.add(section.id);
  }
  return { shut, opened };
}

/**
 * One flat section, for a roster with no roles to hoist — a group conversation's
 * participants, whose payload carries no status either, so splitting them into
 * Online and Offline would be inventing the split from missing data.
 */
export function singleSection<T extends GroupableMember>(
  members: readonly T[],
): MemberSection<T>[] {
  return members.length === 0
    ? []
    : [{ id: "all", kind: "all", members: [...members].sort(compareMembers) }];
}

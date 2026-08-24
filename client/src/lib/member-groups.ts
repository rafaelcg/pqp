import type { UserStatus } from "@pqp/shared";

/**
 * How a roster becomes the sections a member list draws.
 *
 * Pure and DOM-free so the rules can be pinned by tests — the sidebar itself is
 * then only markup over this answer. Every decision below is a copy of what
 * Discord and Stoat already taught people to expect, because a member list that
 * groups differently from the two apps everybody arrives from is a member list
 * they have to learn.
 *
 * THE RULES, AND WHY.
 *
 *  1. A HOISTED ROLE GETS ITS OWN SECTION, most senior first. Today that is
 *     `owner` then `admin`; `member` is not hoisted, which is what makes the
 *     plain "Online" section the residue rather than a fourth role heading.
 *  2. A ROLE SECTION HOLDS ONLY PEOPLE WHO ARE AROUND. An offline admin is in
 *     Offline, not in Admins — otherwise "Admins — 4" is a claim about the org
 *     chart while every other heading is a claim about who you can talk to, and
 *     the reader has to hold two meanings of the same shape at once.
 *  3. OFFLINE IS ONE SECTION AT THE BOTTOM, whatever anybody's rank.
 *  4. EMPTY SECTIONS DO NOT EXIST. A server with no admins online must not
 *     render "Admins — 0"; a heading with nothing under it is noise that scales
 *     with the number of roles, which is the direction this is about to grow.
 *  5. WITHIN A SECTION: display name, case- and accent-insensitively, then id.
 *     The id tie-break is not cosmetic — two people called "ana" would
 *     otherwise swap places between renders, and this list re-renders every
 *     time anybody's status changes.
 *
 * `hoistedRoles` is a parameter rather than a constant so that custom roles —
 * which this product does not have yet — arrive as a longer array and a label
 * lookup, not as a rewrite of this file.
 */

export type MemberRole = "owner" | "admin" | "member";

/** Everything this module needs to know about one person. */
export interface GroupableMember {
  id: string;
  displayName: string;
  nickname?: string | null;
  role: MemberRole;
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
  /** Set only when `kind` is `"role"`. */
  role?: MemberRole;
  members: T[];
}

/** Roles with a heading of their own, most senior first. */
export const HOISTED_ROLES: readonly MemberRole[] = ["owner", "admin"];

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

export function groupMembers<T extends GroupableMember>(
  members: readonly T[],
  hoistedRoles: readonly MemberRole[] = HOISTED_ROLES,
): MemberSection<T>[] {
  const hoisted = new Map<MemberRole, T[]>(
    hoistedRoles.map((role) => [role, []]),
  );
  const online: T[] = [];
  const offline: T[] = [];

  for (const member of members) {
    if (!isAround(member.status)) {
      offline.push(member);
      continue;
    }
    const bucket = hoisted.get(member.role);
    if (bucket) {
      bucket.push(member);
    } else {
      online.push(member);
    }
  }

  const sections: MemberSection<T>[] = [];
  for (const role of hoistedRoles) {
    const bucket = hoisted.get(role) ?? [];
    if (bucket.length > 0) {
      sections.push({
        id: `role:${role}`,
        kind: "role",
        role,
        members: bucket.sort(compareMembers),
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

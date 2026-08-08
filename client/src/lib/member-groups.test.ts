import { describe, expect, it } from "vitest";
import type { UserStatus } from "@pqp/shared";
import {
  HOISTED_ROLES,
  MEMBER_PAGE_SIZE,
  NO_COLLAPSE,
  OFFLINE_COLLAPSE_THRESHOLD,
  compareMembers,
  groupMembers,
  isAround,
  sectionCollapsed,
  singleSection,
  toggleSectionCollapse,
  type GroupableMember,
  type MemberRole,
} from "./member-groups";

function person(
  id: string,
  displayName: string,
  role: MemberRole,
  status?: UserStatus | null,
): GroupableMember {
  return { id, displayName, role, status };
}

describe("isAround", () => {
  it("counts idle and do-not-disturb as here", () => {
    expect(isAround("online")).toBe(true);
    expect(isAround("idle")).toBe(true);
    expect(isAround("dnd")).toBe(true);
  });

  it("counts offline, absent and null as gone", () => {
    expect(isAround("offline")).toBe(false);
    expect(isAround(undefined)).toBe(false);
    expect(isAround(null)).toBe(false);
  });
});

describe("groupMembers", () => {
  it("hoists the owner and the admins ahead of plain online members", () => {
    const sections = groupMembers([
      person("1", "Zed", "member", "online"),
      person("2", "Ana", "admin", "online"),
      person("3", "Rafa", "owner", "online"),
    ]);
    expect(sections.map((s) => s.id)).toEqual([
      "role:owner",
      "role:admin",
      "online",
    ]);
    expect(sections[0]!.role).toBe("owner");
    expect(sections[2]!.members.map((m) => m.displayName)).toEqual(["Zed"]);
  });

  it("puts an offline admin in Offline rather than in Admins", () => {
    const sections = groupMembers([
      person("1", "Ana", "admin", "offline"),
      person("2", "Bea", "admin", "online"),
    ]);
    expect(sections.map((s) => s.id)).toEqual(["role:admin", "offline"]);
    expect(sections[0]!.members.map((m) => m.id)).toEqual(["2"]);
    expect(sections[1]!.members.map((m) => m.id)).toEqual(["1"]);
  });

  it("omits a section nobody is in", () => {
    const sections = groupMembers([person("1", "Ana", "member", "online")]);
    expect(sections.map((s) => s.id)).toEqual(["online"]);
  });

  it("returns nothing at all for an empty roster", () => {
    expect(groupMembers([])).toEqual([]);
  });

  it("treats a member with no status as offline, never as online", () => {
    const sections = groupMembers([person("1", "Ana", "member")]);
    expect(sections.map((s) => s.id)).toEqual(["offline"]);
  });

  it("sorts each section by name, ignoring case and accents", () => {
    const sections = groupMembers([
      person("1", "zoe", "member", "online"),
      person("2", "Ávila", "member", "online"),
      person("3", "avila", "member", "online"),
      person("4", "Bruno", "member", "online"),
    ]);
    // "Ávila"/"avila" collate together, so the id tie-break decides between
    // them — and it has to, or they swap on every status refresh.
    expect(sections[0]!.members.map((m) => m.id)).toEqual(["2", "3", "4", "1"]);
  });

  it("breaks a name tie by id so the order cannot shuffle between renders", () => {
    const roster = [
      person("b", "Ana", "member", "online"),
      person("a", "Ana", "member", "online"),
    ];
    const once = groupMembers(roster)[0]!.members.map((m) => m.id);
    const twice = groupMembers([...roster].reverse())[0]!.members.map(
      (m) => m.id,
    );
    expect(once).toEqual(["a", "b"]);
    expect(twice).toEqual(once);
  });

  it("keeps offline members in one section whatever their rank", () => {
    const sections = groupMembers([
      person("1", "Owner", "owner", "offline"),
      person("2", "Admin", "admin", "offline"),
      person("3", "Member", "member", "offline"),
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.kind).toBe("offline");
    expect(sections[0]!.members).toHaveLength(3);
  });

  it("generalises to a longer list of hoisted roles", () => {
    // Stands in for custom roles: the caller passes the hoist order, this file
    // does not need to know the vocabulary.
    const sections = groupMembers(
      [
        person("1", "Plain", "member", "online"),
        person("2", "Boss", "owner", "online"),
      ],
      ["owner", "admin", "member"],
    );
    expect(sections.map((s) => s.id)).toEqual(["role:owner", "role:member"]);
  });

  it("does not mutate the roster it was handed", () => {
    const roster = [
      person("1", "Zed", "member", "online"),
      person("2", "Ana", "member", "online"),
    ];
    groupMembers(roster);
    expect(roster.map((m) => m.id)).toEqual(["1", "2"]);
  });

  it("hoists exactly owner and admin by default", () => {
    expect(HOISTED_ROLES).toEqual(["owner", "admin"]);
  });
});

describe("singleSection", () => {
  it("makes one alphabetical section and claims nothing about presence", () => {
    const sections = singleSection([
      person("1", "Zed", "member"),
      person("2", "Ana", "member"),
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.kind).toBe("all");
    expect(sections[0]!.members.map((m) => m.id)).toEqual(["2", "1"]);
  });

  it("is empty for no participants", () => {
    expect(singleSection([])).toEqual([]);
  });
});

describe("compareMembers", () => {
  it("is a total order suitable for Array.sort", () => {
    const a = person("1", "Ana", "member");
    const b = person("2", "Bea", "member");
    expect(compareMembers(a, b)).toBeLessThan(0);
    expect(compareMembers(b, a)).toBeGreaterThan(0);
    expect(compareMembers(a, a)).toBe(0);
  });
});

describe("OFFLINE_COLLAPSE_THRESHOLD", () => {
  it("leaves a small server's offline section open", () => {
    // The threshold is a product promise, not an implementation detail: under it
    // nobody has to click anything to see everybody.
    expect(OFFLINE_COLLAPSE_THRESHOLD).toBeGreaterThanOrEqual(20);
  });
});

describe("section collapse", () => {
  /** A roster of `count` offline members, as one Offline section. */
  function offlineSection(count: number) {
    const roster = Array.from({ length: count }, (_, i) =>
      person(`u${i}`, `Person ${i}`, "member", "offline"),
    );
    return groupMembers(roster)[0]!;
  }

  const onlineSection = groupMembers([
    person("1", "Ana", "member", "online"),
  ])[0]!;

  it("opens a small offline section without being asked", () => {
    const section = offlineSection(OFFLINE_COLLAPSE_THRESHOLD);
    expect(sectionCollapsed(section, NO_COLLAPSE)).toBe(false);
  });

  it("closes a big one without being asked", () => {
    const section = offlineSection(OFFLINE_COLLAPSE_THRESHOLD + 1);
    expect(sectionCollapsed(section, NO_COLLAPSE)).toBe(true);
  });

  it("never closes a section that is not Offline, however long", () => {
    expect(sectionCollapsed(onlineSection, NO_COLLAPSE)).toBe(false);
  });

  it("lets the reader open a section the threshold closed, and it stays open", () => {
    const section = offlineSection(OFFLINE_COLLAPSE_THRESHOLD + 1);
    const opened = toggleSectionCollapse(section, NO_COLLAPSE);
    expect(sectionCollapsed(section, opened)).toBe(false);
    // The status poll rebuilds the sections every few seconds; a fresh section
    // object with the same id must not reinstate the default.
    const rebuilt = offlineSection(OFFLINE_COLLAPSE_THRESHOLD + 2);
    expect(sectionCollapsed(rebuilt, opened)).toBe(false);
  });

  it("lets the reader close one the threshold left open, and it stays closed", () => {
    const section = offlineSection(3);
    const shut = toggleSectionCollapse(section, NO_COLLAPSE);
    expect(sectionCollapsed(section, shut)).toBe(true);
    expect(sectionCollapsed(offlineSection(4), shut)).toBe(true);
  });

  it("round-trips: two clicks are where you started", () => {
    const section = offlineSection(OFFLINE_COLLAPSE_THRESHOLD + 1);
    const once = toggleSectionCollapse(section, NO_COLLAPSE);
    const twice = toggleSectionCollapse(section, once);
    expect(sectionCollapsed(section, twice)).toBe(
      sectionCollapsed(section, NO_COLLAPSE),
    );
  });

  it("does not mutate the state it was handed", () => {
    const section = offlineSection(3);
    const next = toggleSectionCollapse(section, NO_COLLAPSE);
    expect(NO_COLLAPSE.shut.size).toBe(0);
    expect(NO_COLLAPSE.opened.size).toBe(0);
    expect(next.shut.has("offline")).toBe(true);
  });

  it("pages at a size that keeps the DOM bounded", () => {
    expect(MEMBER_PAGE_SIZE).toBeGreaterThan(0);
    expect(MEMBER_PAGE_SIZE).toBeLessThanOrEqual(200);
  });
});

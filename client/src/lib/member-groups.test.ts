import { describe, expect, it } from "vitest";
import type { UserStatus } from "@pqp/shared";
import {
  MEMBER_PAGE_SIZE,
  NO_COLLAPSE,
  OFFLINE_COLLAPSE_THRESHOLD,
  compareMembers,
  effectiveRoleIds,
  groupMembers,
  isAround,
  sectionCollapsed,
  singleSection,
  toggleSectionCollapse,
  type GroupableMember,
  type HoistedRole,
  type MemberRole,
} from "./member-groups";

const OWNER: HoistedRole = { id: "owner-role", name: "Owner" };
const ADMIN: HoistedRole = { id: "admin-role", name: "Admin" };
const HELPERS: HoistedRole = { id: "helpers", name: "Helpers" };

function person(
  id: string,
  displayName: string,
  role: MemberRole,
  status?: UserStatus | null,
  roleIds?: string[],
): GroupableMember {
  return { id, displayName, role, status, roleIds };
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

describe("effectiveRoleIds", () => {
  it("adds the seeded Admin role for rank admins who have no row", () => {
    expect(
      effectiveRoleIds({ role: "admin", roleIds: [] }, "admin-role"),
    ).toEqual(["admin-role"]);
    expect(
      effectiveRoleIds({ role: "member", roleIds: ["helpers"] }, "admin-role"),
    ).toEqual(["helpers"]);
  });

  it("adds the Owner cargo for the owner", () => {
    expect(
      effectiveRoleIds({ role: "owner", roleIds: [] }, "admin-role", "owner-role"),
    ).toEqual(["owner-role"]);
  });

  it("does not invent Admin for a Manager", () => {
    expect(
      effectiveRoleIds({ role: "admin", roleIds: ["manager-role"] }, "admin-role"),
    ).toEqual(["manager-role"]);
  });
});

describe("groupMembers", () => {
  it("hoists the owner then hoisted roles ahead of plain online members", () => {
    const sections = groupMembers(
      [
        person("1", "Zed", "member", "online"),
        person("2", "Ana", "admin", "online", ["admin-role"]),
        person("3", "Rafa", "owner", "online", ["owner-role"]),
      ],
      [OWNER, ADMIN],
    );
    expect(sections.map((s) => s.id)).toEqual([
      "role:owner-role",
      "role:admin-role",
      "online",
    ]);
    expect(sections[0]!.label).toBe("Owner");
    expect(sections[1]!.label).toBe("Admin");
    expect(sections[2]!.members.map((m) => m.displayName)).toEqual(["Zed"]);
  });

  it("keeps an offline admin in their hoisted role, dimmed by status", () => {
    const sections = groupMembers(
      [
        person("1", "Ana", "admin", "offline", ["admin-role"]),
        person("2", "Bea", "admin", "online", ["admin-role"]),
      ],
      [ADMIN],
    );
    expect(sections.map((s) => s.id)).toEqual(["role:admin-role"]);
    expect(sections[0]!.members.map((m) => m.id)).toEqual(["2", "1"]);
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

  it("keeps unhoisted people in one Offline section whatever their rank", () => {
    const sections = groupMembers([
      person("1", "Owner", "owner", "offline"),
      person("2", "Admin", "admin", "offline", ["admin-role"]),
      person("3", "Member", "member", "offline"),
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.kind).toBe("offline");
    expect(sections[0]!.members).toHaveLength(3);
  });

  it("keeps hoisted staff in their cargo when offline, and leaves the rest in Offline", () => {
    const sections = groupMembers(
      [
        person("1", "Rafa", "owner", "offline", ["owner-role"]),
        person("2", "Ana", "admin", "offline", ["admin-role"]),
        person("3", "Zed", "member", "offline"),
      ],
      [OWNER, ADMIN],
    );
    expect(sections.map((s) => s.id)).toEqual([
      "role:owner-role",
      "role:admin-role",
      "offline",
    ]);
    expect(sections[0]!.members.map((m) => m.id)).toEqual(["1"]);
    expect(sections[1]!.members.map((m) => m.id)).toEqual(["2"]);
    expect(sections[2]!.members.map((m) => m.id)).toEqual(["3"]);
  });

  it("lands a member in their highest hoisted role", () => {
    const sections = groupMembers(
      [
        person("1", "Plain", "member", "online"),
        person("2", "Both", "member", "online", ["admin-role", "helpers"]),
      ],
      [ADMIN, HELPERS],
    );
    expect(sections.map((s) => s.id)).toEqual(["role:admin-role", "online"]);
    expect(sections[0]!.members.map((m) => m.id)).toEqual(["2"]);
  });

  it("keeps owner above any hoisted role they also hold", () => {
    const sections = groupMembers(
      [person("1", "Boss", "owner", "online", ["owner-role", "admin-role"])],
      [OWNER, ADMIN],
    );
    expect(sections.map((s) => s.id)).toEqual(["role:owner-role"]);
  });

  it("does not hoist @everyone when nobody holds that id", () => {
    const none = groupMembers(
      [person("1", "Ana", "member", "online")],
      [{ id: "everyone", name: "@everyone" }],
    );
    expect(none.map((s) => s.id)).toEqual(["online"]);
  });

  it("does not mutate the roster it was handed", () => {
    const roster = [
      person("1", "Zed", "member", "online"),
      person("2", "Ana", "member", "online"),
    ];
    groupMembers(roster);
    expect(roster.map((m) => m.id)).toEqual(["1", "2"]);
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
    expect(OFFLINE_COLLAPSE_THRESHOLD).toBeGreaterThanOrEqual(20);
  });
});

describe("section collapse", () => {
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

import { describe, expect, it } from "vitest";
import { serializePermissions, Permission } from "@pqp/shared";
import {
  assignableRoleIds,
  canActOnMemberClient,
  memberPower,
} from "./role-hierarchy";

const everyone = {
  id: "everyone",
  position: 0,
  permissions: "0",
  systemKey: "everyone" as const,
  isEveryone: true,
};
const moderator = {
  id: "mod",
  position: 1,
  permissions: "0",
  systemKey: "moderator" as const,
};
const manager = {
  id: "mgr",
  position: 2,
  permissions: "0",
  systemKey: "manager" as const,
};
const admin = {
  id: "adm",
  position: 3,
  permissions: serializePermissions(Permission.ADMINISTRATOR),
  systemKey: "admin" as const,
};
const owner = {
  id: "own",
  position: 4,
  permissions: "0",
  systemKey: "owner" as const,
};
const vip = {
  id: "vip",
  position: 1,
  permissions: "0",
  systemKey: null,
};
const roles = [everyone, vip, moderator, manager, admin, owner];

describe("assignableRoleIds", () => {
  it("lets the owner tick every cargo except Owner and @everyone", () => {
    expect(
      assignableRoleIds({ role: "owner", roleIds: [owner.id] }, roles).sort(),
    ).toEqual(["adm", "mgr", "mod", "vip"]);
  });

  it("lets a moderator tick only cargos below them", () => {
    expect(
      assignableRoleIds({ role: "member", roleIds: [moderator.id] }, [
        everyone,
        { ...vip, position: 0 },
        moderator,
        manager,
        admin,
        owner,
      ]),
    ).toEqual(["vip"]);
  });
});

describe("canActOnMemberClient", () => {
  it("never lets you act on yourself", () => {
    expect(
      canActOnMemberClient(
        { role: "owner", roleIds: [owner.id] },
        { role: "owner", roleIds: [owner.id] },
        roles,
        "me",
        "me",
      ),
    ).toBe(false);
  });

  it("blocks a manager from acting on an admin", () => {
    expect(
      canActOnMemberClient(
        { role: "admin", roleIds: [manager.id] },
        { role: "admin", roleIds: [admin.id] },
        roles,
        "mgr-user",
        "adm-user",
      ),
    ).toBe(false);
  });

  it("lets the owner act on an admin", () => {
    expect(
      canActOnMemberClient(
        { role: "owner", roleIds: [owner.id] },
        { role: "admin", roleIds: [admin.id] },
        roles,
        "owner-user",
        "adm-user",
      ),
    ).toBe(true);
  });
});

describe("memberPower", () => {
  it("treats the owner person as above every cargo", () => {
    const power = memberPower({ role: "owner", roleIds: [] }, roles);
    expect(power.isOwner).toBe(true);
    expect(power.position).toBe(Number.MAX_SAFE_INTEGER);
  });
});

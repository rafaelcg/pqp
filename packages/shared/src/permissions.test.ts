import { describe, expect, it } from "vitest";
import {
  CHAT_SERVER_MESSAGE_TYPES,
  isChatServerMessage,
} from "./chat.js";
import {
  actorOutranksTarget,
  computePermissions,
  grantablePermissions,
  hasPermission,
  parsePermissions,
  PERMISSION_ALL,
  PERMISSION_DEFAULT_EVERYONE,
  PERMISSION_DEFAULT_MANAGER,
  PERMISSION_DEFAULT_MODERATOR,
  STAFF_ROLE_COLORS,
  STAFF_ROLE_NAMES,
  defaultRoleColor,
  defaultRoleName,
  defaultRolePermissions,
  isRoleOrderLocked,
  clampEveryonePermissions,
  Permission,
  permissionsUpdateSchema,
  serializePermissions,
} from "./permissions.js";

const VIEW = Permission.VIEW_CHANNEL;
const SEND = Permission.SEND_MESSAGES;
const ADMIN = Permission.ADMINISTRATOR;

describe("permission bitfields", () => {
  it("round-trips as a decimal string, never a JS number", () => {
    expect(serializePermissions(PERMISSION_DEFAULT_EVERYONE)).toBe("571073");
    expect(parsePermissions("571073")).toBe(PERMISSION_DEFAULT_EVERYONE);
    expect(parsePermissions(PERMISSION_ALL)).toBe(PERMISSION_ALL);
  });

  it("treats ADMINISTRATOR as a distinct bit before expansion", () => {
    expect(hasPermission(ADMIN, ADMIN)).toBe(true);
    expect(hasPermission(PERMISSION_DEFAULT_EVERYONE, ADMIN)).toBe(false);
  });

  it("strips kick, ban, timeout and Administrator from @everyone", () => {
    expect(
      hasPermission(PERMISSION_DEFAULT_EVERYONE, Permission.KICK_MEMBERS),
    ).toBe(false);
    expect(
      hasPermission(PERMISSION_DEFAULT_EVERYONE, Permission.BAN_MEMBERS),
    ).toBe(false);
    expect(
      hasPermission(PERMISSION_DEFAULT_EVERYONE, Permission.MODERATE_MEMBERS),
    ).toBe(false);
    const dirty =
      PERMISSION_DEFAULT_EVERYONE |
      Permission.KICK_MEMBERS |
      Permission.BAN_MEMBERS |
      Permission.MODERATE_MEMBERS |
      ADMIN;
    const cleaned = clampEveryonePermissions(dirty);
    expect(hasPermission(cleaned, Permission.KICK_MEMBERS)).toBe(false);
    expect(hasPermission(cleaned, Permission.BAN_MEMBERS)).toBe(false);
    expect(hasPermission(cleaned, Permission.MODERATE_MEMBERS)).toBe(false);
    expect(hasPermission(cleaned, ADMIN)).toBe(false);
    expect(hasPermission(cleaned, Permission.SEND_MESSAGES)).toBe(true);
  });

  it("seeds Manager without Administrator and Moderator as extras only", () => {
    expect(hasPermission(PERMISSION_DEFAULT_MANAGER, ADMIN)).toBe(false);
    expect(
      hasPermission(PERMISSION_DEFAULT_MANAGER, Permission.MANAGE_SERVER),
    ).toBe(true);
    expect(
      hasPermission(PERMISSION_DEFAULT_MANAGER, Permission.BAN_MEMBERS),
    ).toBe(true);
    expect(
      hasPermission(PERMISSION_DEFAULT_MODERATOR, Permission.KICK_MEMBERS),
    ).toBe(true);
    expect(
      hasPermission(PERMISSION_DEFAULT_MODERATOR, Permission.BAN_MEMBERS),
    ).toBe(false);
    expect(
      hasPermission(PERMISSION_DEFAULT_MODERATOR, Permission.VIEW_CHANNEL),
    ).toBe(false);
    expect(
      hasPermission(PERMISSION_DEFAULT_MODERATOR, Permission.SEND_MESSAGES),
    ).toBe(false);
  });

  it("paints seeded staff cargos with the dark-first palette", () => {
    expect(STAFF_ROLE_COLORS.owner).toBe("#E0B84C");
    expect(STAFF_ROLE_COLORS.admin).toBe("#D46A8A");
    expect(STAFF_ROLE_COLORS.manager).toBe("#6BA3E8");
    expect(STAFF_ROLE_COLORS.moderator).toBe("#4EC4B0");
    expect(STAFF_ROLE_COLORS.vip).toBe("#B794D4");
    expect(defaultRoleColor("owner")).toBe(STAFF_ROLE_COLORS.owner);
    expect(defaultRoleColor("everyone")).toBeNull();
    expect(defaultRoleColor(null)).toBeNull();
  });

  it("knows the English seed names and factory permission masks", () => {
    expect(STAFF_ROLE_NAMES.owner).toBe("Owner");
    expect(defaultRoleName("owner")).toBe("Owner");
    expect(defaultRoleName("vip")).toBe("VIP");
    expect(defaultRoleName("everyone")).toBe("everyone");
    expect(defaultRoleName(null)).toBeNull();
    expect(defaultRolePermissions("everyone")).toBe(PERMISSION_DEFAULT_EVERYONE);
    expect(defaultRolePermissions("admin")).toBe(PERMISSION_ALL);
    expect(defaultRolePermissions("manager")).toBe(PERMISSION_DEFAULT_MANAGER);
    expect(defaultRolePermissions("moderator")).toBe(
      PERMISSION_DEFAULT_MODERATOR,
    );
    expect(defaultRolePermissions("vip")).toBe(0n);
    expect(defaultRolePermissions("owner")).toBe(0n);
    expect(defaultRolePermissions(null)).toBe(0n);
  });

  it("pins Owner at the top and @everyone at the bottom", () => {
    expect(isRoleOrderLocked({ systemKey: "owner" })).toBe(true);
    expect(isRoleOrderLocked({ isEveryone: true })).toBe(true);
    expect(isRoleOrderLocked({ systemKey: "admin" })).toBe(false);
    expect(isRoleOrderLocked({ systemKey: null })).toBe(false);
  });
});

describe("computePermissions — Discord 8-step", () => {
  it("1. owner is ALL, even with empty roles and denies", () => {
    expect(
      computePermissions({
        isOwner: true,
        everyonePermissions: 0n,
        rolePermissions: [],
        roleOverwrites: [],
        everyoneOverwrite: { allow: 0n, deny: PERMISSION_ALL },
        timedOut: true,
      }),
    ).toBe(PERMISSION_ALL);
  });

  it("2–3. starts from @everyone and ORs other roles", () => {
    const result = computePermissions({
      isOwner: false,
      everyonePermissions: VIEW,
      rolePermissions: [SEND],
      roleOverwrites: [],
    });
    expect(hasPermission(result, VIEW)).toBe(true);
    expect(hasPermission(result, SEND)).toBe(true);
    expect(hasPermission(result, Permission.KICK_MEMBERS)).toBe(false);
  });

  it("4. ADMINISTRATOR skips overwrites and timeout", () => {
    expect(
      computePermissions({
        isOwner: false,
        everyonePermissions: 0n,
        rolePermissions: [ADMIN],
        roleOverwrites: [],
        everyoneOverwrite: { allow: 0n, deny: VIEW | SEND },
        timedOut: true,
      }),
    ).toBe(PERMISSION_ALL);
  });

  it("5. channel @everyone overwrite: deny then allow", () => {
    const result = computePermissions({
      isOwner: false,
      everyonePermissions: VIEW | SEND,
      rolePermissions: [],
      roleOverwrites: [],
      everyoneOverwrite: { allow: 0n, deny: SEND },
    });
    expect(hasPermission(result, VIEW)).toBe(true);
    expect(hasPermission(result, SEND)).toBe(false);
  });

  it("6. union of other role overwrites: allow wins across the union", () => {
    // Role A denies SEND, role B allows SEND. Discord: OR the denies, OR the
    // allows, then apply deny then allow — so allow wins.
    const result = computePermissions({
      isOwner: false,
      everyonePermissions: VIEW | SEND,
      rolePermissions: [0n],
      roleOverwrites: [
        { allow: 0n, deny: SEND },
        { allow: SEND, deny: 0n },
      ],
    });
    expect(hasPermission(result, SEND)).toBe(true);
  });

  it("7. member overwrite is last", () => {
    const result = computePermissions({
      isOwner: false,
      everyonePermissions: VIEW | SEND,
      rolePermissions: [],
      roleOverwrites: [{ allow: 0n, deny: SEND }],
      memberOverwrite: { allow: SEND, deny: 0n },
    });
    expect(hasPermission(result, SEND)).toBe(true);
  });

  it("8a. no VIEW strips every other bit", () => {
    const result = computePermissions({
      isOwner: false,
      everyonePermissions: VIEW | SEND | Permission.CONNECT,
      rolePermissions: [],
      roleOverwrites: [],
      everyoneOverwrite: { allow: 0n, deny: VIEW },
    });
    expect(result).toBe(0n);
  });

  it("8b. timeout keeps VIEW and history, drops send", () => {
    const result = computePermissions({
      isOwner: false,
      everyonePermissions: PERMISSION_DEFAULT_EVERYONE,
      rolePermissions: [],
      roleOverwrites: [],
      timedOut: true,
    });
    expect(hasPermission(result, VIEW)).toBe(true);
    expect(hasPermission(result, Permission.READ_MESSAGE_HISTORY)).toBe(true);
    expect(hasPermission(result, SEND)).toBe(false);
    expect(hasPermission(result, Permission.CONNECT)).toBe(false);
  });

  it("private channel: @everyone deny VIEW, member allow VIEW", () => {
    const denied = computePermissions({
      isOwner: false,
      everyonePermissions: PERMISSION_DEFAULT_EVERYONE,
      rolePermissions: [],
      roleOverwrites: [],
      everyoneOverwrite: { allow: 0n, deny: VIEW },
    });
    expect(denied).toBe(0n);

    const allowed = computePermissions({
      isOwner: false,
      everyonePermissions: PERMISSION_DEFAULT_EVERYONE,
      rolePermissions: [],
      roleOverwrites: [],
      everyoneOverwrite: { allow: 0n, deny: VIEW },
      memberOverwrite: { allow: VIEW, deny: 0n },
    });
    expect(hasPermission(allowed, VIEW)).toBe(true);
    expect(hasPermission(allowed, SEND)).toBe(true);
  });
});

describe("hierarchy", () => {
  it("nobody outranks the owner", () => {
    expect(
      actorOutranksTarget({
        actorIsOwner: false,
        actorPosition: 99,
        targetIsOwner: true,
        targetHasAdministrator: false,
        targetPosition: 0,
      }),
    ).toBe(false);
  });

  it("owner outranks an Administrator", () => {
    expect(
      actorOutranksTarget({
        actorIsOwner: true,
        actorPosition: 0,
        targetIsOwner: false,
        targetHasAdministrator: true,
        targetPosition: 50,
      }),
    ).toBe(true);
  });

  it("a non-owner cannot act on an Administrator", () => {
    expect(
      actorOutranksTarget({
        actorIsOwner: false,
        actorPosition: 10,
        targetIsOwner: false,
        targetHasAdministrator: true,
        targetPosition: 1,
      }),
    ).toBe(false);
  });

  it("requires a strictly greater position", () => {
    expect(
      actorOutranksTarget({
        actorIsOwner: false,
        actorPosition: 5,
        targetIsOwner: false,
        targetHasAdministrator: false,
        targetPosition: 5,
      }),
    ).toBe(false);
    expect(
      actorOutranksTarget({
        actorIsOwner: false,
        actorPosition: 6,
        targetIsOwner: false,
        targetHasAdministrator: false,
        targetPosition: 5,
      }),
    ).toBe(true);
  });
});

describe("grantablePermissions", () => {
  it("strips ADMINISTRATOR from a non-admin actor", () => {
    const held = Permission.MANAGE_ROLES | Permission.SEND_MESSAGES | ADMIN;
    // The actor here is themselves an Administrator, so they may grant ALL.
    expect(grantablePermissions(PERMISSION_ALL)).toBe(PERMISSION_ALL);
    expect(grantablePermissions(held & ~ADMIN)).toBe(
      Permission.MANAGE_ROLES | Permission.SEND_MESSAGES,
    );
    void held;
  });
});

describe("permissions-update frame", () => {
  it("is not a channel-relayable chat frame", () => {
    expect(CHAT_SERVER_MESSAGE_TYPES).not.toContain("permissions-update");
    expect(isChatServerMessage({ type: "permissions-update" })).toBe(false);
  });

  it("parses a version-only payload", () => {
    expect(
      permissionsUpdateSchema.parse({
        type: "permissions-update",
        serverId: "11111111-1111-1111-1111-111111111111",
        version: 3,
      }),
    ).toEqual({
      type: "permissions-update",
      serverId: "11111111-1111-1111-1111-111111111111",
      version: 3,
    });
  });
});

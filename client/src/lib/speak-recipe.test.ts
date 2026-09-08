import { describe, expect, it } from "vitest";
import { Permission, serializePermissions } from "@pqp/shared";
import {
  planRecipe,
  readRecipe,
  recipeBitsForChannel,
  roleIgnoresChannelOverwrites,
} from "./speak-recipe";

const EVERYONE = "everyone-id";
const MOD = "mod-id";
const VIP = "vip-id";
const BIT = Permission.SPEAK;

function row(
  targetType: "role" | "member",
  targetId: string,
  allow: bigint,
  deny: bigint,
) {
  return { targetType, targetId, allow, deny };
}

describe("readRecipe", () => {
  it("is everyone when nothing touches the bit", () => {
    expect(readRecipe([], EVERYONE, BIT)).toEqual({
      kind: "everyone",
      roleIds: [],
    });
  });

  it("is roles when @everyone is denied and cargos are allowed", () => {
    expect(
      readRecipe(
        [
          row("role", EVERYONE, 0n, BIT),
          row("role", MOD, BIT, 0n),
          row("role", VIP, BIT, 0n),
        ],
        EVERYONE,
        BIT,
      ),
    ).toEqual({ kind: "roles", roleIds: [MOD, VIP] });
  });

  it("is custom when a member overwrite touches the bit", () => {
    expect(
      readRecipe(
        [row("role", EVERYONE, 0n, BIT), row("member", "bob", BIT, 0n)],
        EVERYONE,
        BIT,
      ).kind,
    ).toBe("custom");
  });

  it("is custom when a cargo is denied the bit", () => {
    expect(
      readRecipe([row("role", MOD, 0n, BIT)], EVERYONE, BIT).kind,
    ).toBe("custom");
  });
});

describe("planRecipe", () => {
  it("denies @everyone and allows the picked cargos", () => {
    const writes = planRecipe([], EVERYONE, BIT, "roles", [MOD]);
    expect(writes).toEqual([
      {
        op: "put",
        targetType: "role",
        targetId: EVERYONE,
        allow: 0n,
        deny: BIT,
      },
      {
        op: "put",
        targetType: "role",
        targetId: MOD,
        allow: BIT,
        deny: 0n,
      },
    ]);
  });

  it("clears the bit back to everyone without touching other bits", () => {
    const view = Permission.VIEW_CHANNEL;
    const writes = planRecipe(
      [row("role", EVERYONE, 0n, view | BIT), row("role", MOD, BIT, 0n)],
      EVERYONE,
      BIT,
      "everyone",
      [],
    );
    expect(writes).toContainEqual({
      op: "put",
      targetType: "role",
      targetId: EVERYONE,
      allow: 0n,
      deny: view,
    });
    expect(writes).toContainEqual({
      op: "delete",
      targetType: "role",
      targetId: MOD,
      allow: 0n,
      deny: 0n,
    });
  });

  it("writes Speak and Stream together for a voice recipe", () => {
    const bits = [Permission.SPEAK, Permission.STREAM];
    const writes = planRecipe([], EVERYONE, bits, "roles", [MOD]);
    expect(writes).toEqual([
      {
        op: "put",
        targetType: "role",
        targetId: EVERYONE,
        allow: 0n,
        deny: Permission.SPEAK | Permission.STREAM,
      },
      {
        op: "put",
        targetType: "role",
        targetId: MOD,
        allow: Permission.SPEAK | Permission.STREAM,
        deny: 0n,
      },
    ]);
  });

  it("is custom when Speak and Stream disagree", () => {
    expect(
      readRecipe(
        [row("role", EVERYONE, 0n, Permission.SPEAK)],
        EVERYONE,
        [Permission.SPEAK, Permission.STREAM],
      ).kind,
    ).toBe("custom");
  });

  it("clears a member exception when applying a recipe", () => {
    const writes = planRecipe(
      [row("role", EVERYONE, 0n, BIT), row("member", "bob", BIT, 0n)],
      EVERYONE,
      BIT,
      "roles",
      [MOD],
    );
    expect(writes).toContainEqual({
      op: "delete",
      targetType: "member",
      targetId: "bob",
      allow: 0n,
      deny: 0n,
    });
  });

  it("drops leftover Mute/Move when applying a voice recipe", () => {
    const leftover = Permission.MUTE_MEMBERS | Permission.MOVE_MEMBERS;
    const writes = planRecipe(
      [row("role", MOD, leftover | Permission.SPEAK, 0n)],
      EVERYONE,
      [Permission.SPEAK, Permission.STREAM],
      "everyone",
      [],
    );
    expect(writes).toContainEqual({
      op: "delete",
      targetType: "role",
      targetId: MOD,
      allow: 0n,
      deny: 0n,
    });
  });
});

describe("roleIgnoresChannelOverwrites", () => {
  it("locks the Owner cargo even with no bits", () => {
    expect(
      roleIgnoresChannelOverwrites({ systemKey: "owner", permissions: "0" }),
    ).toBe(true);
  });

  it("locks Administrator, not Manager", () => {
    expect(
      roleIgnoresChannelOverwrites({
        systemKey: "admin",
        permissions: serializePermissions(Permission.ADMINISTRATOR),
      }),
    ).toBe(true);
    expect(
      roleIgnoresChannelOverwrites({
        systemKey: "manager",
        permissions: "0",
      }),
    ).toBe(false);
  });
});

describe("recipeBitsForChannel", () => {
  it("asks about the stage bit that rules each room", () => {
    expect(recipeBitsForChannel("text")).toEqual([Permission.SEND_MESSAGES]);
    expect(recipeBitsForChannel("voice")).toEqual([
      Permission.SPEAK,
      Permission.STREAM,
    ]);
    expect(recipeBitsForChannel("watch_party")).toEqual([
      Permission.SPEAK,
      Permission.START_WATCH_PARTY,
    ]);
  });

  it("strips the mute/move leftovers when writing the watch party recipe too", () => {
    const writes = planRecipe(
      [
        row(
          "role",
          EVERYONE,
          0n,
          Permission.SPEAK | Permission.MUTE_MEMBERS,
        ),
      ],
      EVERYONE,
      recipeBitsForChannel("watch_party"),
      "everyone",
      [],
    );
    expect(writes).toEqual([
      { op: "delete", targetType: "role", targetId: EVERYONE, allow: 0n, deny: 0n },
    ]);
  });
});

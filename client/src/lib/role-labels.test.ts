import { describe, expect, it } from "vitest";
import type { Translator } from "@/lib/i18n";
import { displayRoleName } from "./role-labels";

const t = ((key: string) => key) as Translator["t"];

const tPt = ((key: string) => {
  const map: Record<string, string> = {
    "roles.system.everyone": "@everyone",
    "roles.system.owner": "Dono",
    "roles.system.admin": "Adm",
    "roles.system.manager": "Gerente",
    "roles.system.moderator": "Mod",
  };
  return map[key] ?? key;
}) as Translator["t"];

describe("displayRoleName", () => {
  it("translates English seed names", () => {
    expect(displayRoleName({ name: "Owner", systemKey: "owner" }, t)).toBe(
      "roles.system.owner",
    );
    expect(displayRoleName({ name: "Admin", systemKey: "admin" }, t)).toBe(
      "roles.system.admin",
    );
    expect(displayRoleName({ name: "Manager", systemKey: "manager" }, t)).toBe(
      "roles.system.manager",
    );
    expect(displayRoleName({ name: "Moderator", systemKey: "moderator" }, t)).toBe(
      "roles.system.moderator",
    );
  });

  it("keeps a renamed cargo", () => {
    expect(displayRoleName({ name: "Fundador", systemKey: "owner" }, t)).toBe(
      "Fundador",
    );
  });

  it("always translates @everyone", () => {
    expect(
      displayRoleName({ name: "everyone", isEveryone: true, systemKey: "everyone" }, t),
    ).toBe("roles.system.everyone");
  });

  it("keeps the English seed when a sibling already uses the translated label", () => {
    const seed = { id: "1", name: "Moderator", systemKey: "moderator" as const };
    const homemade = { id: "2", name: "Mod", systemKey: null };
    const siblings = [seed, homemade];
    expect(displayRoleName(seed, tPt, siblings)).toBe("Moderator");
    expect(displayRoleName(homemade, tPt, siblings)).toBe("Mod");
  });

  it("still translates when no sibling collides", () => {
    const seed = { id: "1", name: "Moderator", systemKey: "moderator" as const };
    const vip = { id: "2", name: "VIP", systemKey: null };
    expect(displayRoleName(seed, tPt, [seed, vip])).toBe("Mod");
  });
});

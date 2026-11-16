import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerRole } from "@/lib/api";
import { setActiveCatalogue } from "@/lib/i18n";
import { ChannelPermissionsSection } from "./channel-permissions-section";

afterEach(() => setActiveCatalogue(undefined));

const SERVER = "11111111-1111-4111-8111-111111111111";

function role(
  id: string,
  name: string,
  position: number,
  extra: Partial<ServerRole> = {},
): ServerRole {
  return {
    id,
    serverId: SERVER,
    name,
    color: null,
    hoist: false,
    mentionable: false,
    permissions: "0",
    position,
    isEveryone: false,
    systemKey: null,
    showBadge: false,
    ...extra,
  };
}

const roles: ServerRole[] = [
  role("r-everyone", "@everyone", 0, { isEveryone: true, systemKey: "everyone" }),
  role("r-vip", "VIP", 10, { systemKey: "vip" }),
  role("r-mod", "Moderator", 30, { systemKey: "moderator" }),
  role("r-admin", "Admin", 50, { systemKey: "admin" }),
  role("r-owner", "Owner", 60, { systemKey: "owner" }),
];

function render(): string {
  setActiveCatalogue({
    "roles.system.everyone": "@everyone",
    "roles.system.owner": "Dono",
    "roles.system.admin": "Adm",
    "roles.system.moderator": "Mod",
    "roles.system.vip": "VIP",
  });
  return renderToStaticMarkup(
    <ChannelPermissionsSection
      channelId="22222222-2222-4222-8222-222222222222"
      channelType="text"
      isPrivate={false}
      roles={roles}
      overwrites={[]}
      onOverwritesChange={() => {}}
      reloadOverwrites={async () => []}
      serverMembers={[]}
      channelMembers={[]}
      onChannelMembersChange={() => {}}
      canManageRoles
      canManageAccess
      forceAdvancedOpen
      recipeRef={() => {}}
      privateRef={() => {}}
      onPrivateChange={async () => {}}
      privateBusy={false}
    />,
  );
}

describe("ChannelPermissionsSection role names", () => {
  it("shows the same pt-BR names Cargos shows, never the English seeds", () => {
    const html = render();
    expect(html).toContain("Dono");
    expect(html).toContain("Adm");
    expect(html).toContain("Mod");
    expect(html).not.toMatch(/>Owner</);
    expect(html).not.toMatch(/>Admin</);
    expect(html).not.toMatch(/>Moderator</);
  });

  it("lists them high to low, Dono first", () => {
    const html = render();
    const order = ["Dono", "Adm", "Mod", "VIP"].map((name) =>
      html.indexOf(`>${name}<`),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

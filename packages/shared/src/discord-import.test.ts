import { describe, expect, it } from "vitest";
import { FRIENDS_FAMILY_TEMPLATE } from "./discord-import.fixture.js";
import { Permission, serializePermissions } from "./permissions.js";
import {
  DISCORD_VIEW_CHANNEL,
  DiscordImportCapError,
  DiscordPermission,
  discordGuildIconUrl,
  mapDiscordPermissions,
  mapGuildTemplate,
  mapImportedEveryonePermissions,
  mapImportedOverwriteBits,
  mapImportedRolePermissions,
  parseDiscordTemplateCode,
  sanitiseImportedRoleName,
} from "./discord-import.js";

const EVERYONE = {
  id: 0,
  name: "@everyone",
  color: 0,
  hoist: false,
  mentionable: false,
};

function template(input: {
  name?: string;
  roles?: unknown[];
  channels: unknown[];
  updated_at?: string;
  is_dirty?: boolean | null;
}) {
  return {
    updated_at: input.updated_at ?? "2026-08-01T00:00:00+00:00",
    is_dirty: input.is_dirty ?? false,
    serialized_source_guild: {
      name: input.name ?? "Test guild",
      roles: input.roles ?? [EVERYONE],
      channels: input.channels,
    },
  };
}

function everyoneDenyView() {
  return {
    id: 0,
    type: 0,
    allow: "0",
    deny: DISCORD_VIEW_CHANNEL.toString(),
  };
}

describe("parseDiscordTemplateCode", () => {
  it("accepts a bare code, discord.new, and discord.com/template", () => {
    expect(parseDiscordTemplateCode("hgM48av5Q69A")).toBe("hgM48av5Q69A");
    expect(parseDiscordTemplateCode("https://discord.new/hgM48av5Q69A")).toBe(
      "hgM48av5Q69A",
    );
    expect(
      parseDiscordTemplateCode("https://discord.com/template/hgM48av5Q69A"),
    ).toBe("hgM48av5Q69A");
    expect(
      parseDiscordTemplateCode(
        "https://www.discord.com/template/hgM48av5Q69A?utm=1",
      ),
    ).toBe("hgM48av5Q69A");
  });

  it("refuses anything that is not those three shapes", () => {
    expect(parseDiscordTemplateCode("https://evil.example/hgM48av5Q69A")).toBe(
      null,
    );
    expect(
      parseDiscordTemplateCode(
        "https://discord.com/api/v10/guilds/templates/hgM48av5Q69A",
      ),
    ).toBe(null);
    expect(parseDiscordTemplateCode("https://discord.new/../etc/passwd")).toBe(
      null,
    );
    expect(parseDiscordTemplateCode("not a code!")).toBe(null);
  });
});

describe("sanitiseImportedRoleName", () => {
  it("folds Portuguese accents and suffixes collisions", () => {
    const used = new Set<string>();
    expect(sanitiseImportedRoleName("Vitalícios", used)).toBe("Vitalicios");
    expect(sanitiseImportedRoleName("Vitalicios", used)).toBe("Vitalicios_2");
  });

  it("drops seeded names and emoji-only labels", () => {
    const used = new Set<string>();
    expect(sanitiseImportedRoleName("Admin", used)).toBe(null);
    expect(sanitiseImportedRoleName("Owner", used)).toBe(null);
    expect(sanitiseImportedRoleName("Manager", used)).toBe(null);
    expect(sanitiseImportedRoleName("Moderator", used)).toBe(null);
    expect(sanitiseImportedRoleName("everyone", used)).toBe(null);
    expect(sanitiseImportedRoleName("🎉", used)).toBe(null);
  });
});

describe("mapGuildTemplate", () => {
  it("maps the frozen Friends & Family snapshot", () => {
    const plan = mapGuildTemplate(FRIENDS_FAMILY_TEMPLATE);
    expect(plan.serverName).toBe("Friends & Family");
    expect(plan.templateUpdatedAt).toBe("2020-05-01T17:57:38+00:00");
    expect(plan.isDirty).toBe(false);
    expect(plan.roles).toEqual([]);

    const categories = plan.channels
      .filter((channel) => channel.type === "category")
      .sort((a, b) => a.position - b.position);
    expect(categories.map((channel) => channel.name)).toEqual([
      "Text Channels",
      "Voice Channels",
    ]);
    expect(categories.map((channel) => channel.position)).toEqual([0, 1]);

    const textCat = categories[0]!;
    const voiceCat = categories[1]!;
    const nestedText = plan.channels
      .filter((channel) => channel.parentTemplateId === textCat.templateId)
      .sort((a, b) => a.position - b.position);
    expect(nestedText.map((channel) => channel.name)).toEqual([
      "general",
      "games",
      "music",
    ]);
    expect(nestedText.map((channel) => channel.position)).toEqual([0, 1, 2]);

    const nestedVoice = plan.channels
      .filter((channel) => channel.parentTemplateId === voiceCat.templateId)
      .sort((a, b) => a.position - b.position);
    expect(nestedVoice.map((channel) => channel.name)).toEqual([
      "Lounge",
      "Stream Room",
    ]);
    expect(plan.privateChannelNames).toEqual([]);
    expect(
      plan.mappedAway.some((item) => item.reason === "permissionBits"),
    ).toBe(false);
    expect(
      plan.mappedAway.some((item) => item.reason === "overwrites"),
    ).toBe(false);
    expect(
      plan.mappedAway.some((item) => item.reason === "serverIcon"),
    ).toBe(false);
    expect(plan.mappedAway.some((item) => item.reason === "bitrate")).toBe(true);
    expect(plan.iconUrl).toBeNull();
    expect(plan.everyonePermissions).toBe(
      serializePermissions(
        mapImportedEveryonePermissions(2248329584434769n),
      ),
    );
    expect(plan.overwrites).toEqual([]);
  });

  it("marks a staff channel private when @everyone id 0 is denied VIEW", () => {
    const plan = mapGuildTemplate(
      template({
        channels: [
          {
            id: 1,
            type: 0,
            name: "staff",
            position: 0,
            parent_id: null,
            permission_overwrites: [everyoneDenyView()],
          },
          {
            id: 2,
            type: 0,
            name: "general",
            position: 1,
            parent_id: null,
            permission_overwrites: [],
          },
        ],
      }),
    );
    const staff = plan.channels.find((channel) => channel.name === "staff");
    const general = plan.channels.find((channel) => channel.name === "general");
    expect(staff?.isPrivate).toBe(true);
    expect(general?.isPrivate).toBe(false);
    expect(plan.privateChannelNames).toEqual(["staff"]);
  });

  it("does not treat Discord deny 64 as VIEW (that bit is pqp's, not Discord's)", () => {
    const plan = mapGuildTemplate(
      template({
        channels: [
          {
            id: 1,
            type: 0,
            name: "maybe",
            position: 0,
            parent_id: null,
            permission_overwrites: [
              { id: 0, type: 0, allow: "0", deny: "64" },
            ],
          },
        ],
      }),
    );
    expect(plan.channels[0]?.isPrivate).toBe(false);
  });

  it("inherits category VIEW deny onto children and never marks the category private", () => {
    const plan = mapGuildTemplate(
      template({
        channels: [
          {
            id: 10,
            type: 4,
            name: "Staff",
            position: 0,
            parent_id: null,
            permission_overwrites: [everyoneDenyView()],
          },
          {
            id: 11,
            type: 0,
            name: "mods",
            position: 0,
            parent_id: 10,
            permission_overwrites: [],
          },
          {
            id: 12,
            type: 2,
            name: "mod-voice",
            position: 1,
            parent_id: 10,
            permission_overwrites: [],
          },
        ],
      }),
    );
    const category = plan.channels.find((channel) => channel.name === "Staff");
    const mods = plan.channels.find((channel) => channel.name === "mods");
    const voice = plan.channels.find((channel) => channel.name === "mod-voice");
    expect(category?.isPrivate).toBe(false);
    expect(mods?.isPrivate).toBe(true);
    expect(voice?.isPrivate).toBe(true);
    expect(plan.privateChannelNames).toEqual(["mods", "mod-voice"]);
  });

  it("flattens a forum to a text channel", () => {
    const plan = mapGuildTemplate(
      template({
        channels: [
          {
            id: 1,
            type: 15,
            name: "ideas",
            position: 0,
            parent_id: null,
            available_tags: [{ name: "shipped" }],
          },
        ],
      }),
    );
    expect(plan.channels[0]).toMatchObject({
      type: "text",
      name: "ideas",
      flattenedFrom: "forum",
    });
    expect(
      plan.mappedAway.some(
        (item) => item.reason === "flattenForum" && item.name === "ideas",
      ),
    ).toBe(true);
  });

  it("keeps mixed text and voice positions inside a category", () => {
    const plan = mapGuildTemplate(
      template({
        channels: [
          { id: 1, type: 4, name: "Hangout", position: 0, parent_id: null },
          {
            id: 2,
            type: 0,
            name: "staff-text",
            position: 0,
            parent_id: 1,
          },
          {
            id: 3,
            type: 2,
            name: "staff-voice",
            position: 1,
            parent_id: 1,
          },
          {
            id: 4,
            type: 0,
            name: "staff-logs",
            position: 2,
            parent_id: 1,
          },
        ],
      }),
    );
    const nested = plan.channels
      .filter((channel) => channel.parentTemplateId === 1)
      .sort((a, b) => a.position - b.position);
    expect(nested.map((channel) => channel.name)).toEqual([
      "staff-text",
      "staff-voice",
      "staff-logs",
    ]);
    expect(nested.map((channel) => channel.position)).toEqual([0, 1, 2]);
  });

  it("skips a role whose sanitised name collides with a seeded staff cargo", () => {
    const plan = mapGuildTemplate(
      template({
        roles: [
          EVERYONE,
          { id: 1, name: "Admin", color: 15844367, hoist: true, mentionable: true },
          { id: 3, name: "Moderator", color: 0, hoist: true, mentionable: true },
          { id: 2, name: "Mods", color: 3447003, hoist: false, mentionable: true },
        ],
        channels: [],
      }),
    );
    expect(plan.roles.map((role) => role.name)).toEqual(["Mods"]);
    expect(
      plan.mappedAway.some(
        (item) => item.reason === "unsanitisableRole" && item.name === "Admin",
      ),
    ).toBe(true);
    expect(
      plan.mappedAway.some(
        (item) => item.reason === "unsanitisableRole" && item.name === "Moderator",
      ),
    ).toBe(true);
    expect(plan.roles[0]?.color).toBe("#3498DB");
  });

  it("rejects more than 200 channels", () => {
    expect(() =>
      mapGuildTemplate(
        template({
          channels: Array.from({ length: 201 }, (_, index) => ({
            id: index + 1,
            type: 0,
            name: `c${index}`,
            position: index,
            parent_id: null,
          })),
        }),
      ),
    ).toThrow(DiscordImportCapError);
  });
});

describe("mapDiscordPermissions", () => {
  it("translates Discord VIEW, not pqp's bit 6, and never copies Administrator", () => {
    expect(mapDiscordPermissions(DiscordPermission.VIEW_CHANNEL)).toBe(
      Permission.VIEW_CHANNEL,
    );
    expect(mapDiscordPermissions(64n)).toBe(Permission.ADD_REACTIONS);
    expect(
      mapImportedRolePermissions(DiscordPermission.ADMINISTRATOR),
    ).toBe(0n);
    expect(
      mapImportedEveryonePermissions(
        DiscordPermission.ADMINISTRATOR | DiscordPermission.SEND_MESSAGES,
      ),
    ).toBe(Permission.SEND_MESSAGES);
    expect(
      mapImportedEveryonePermissions(DiscordPermission.MANAGE_GUILD),
    ).toBe(0n);
    expect(
      mapImportedOverwriteBits(
        DiscordPermission.VIEW_CHANNEL |
          DiscordPermission.SEND_MESSAGES |
          DiscordPermission.MANAGE_MESSAGES,
      ),
    ).toBe(Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES);
  });

  it("copies named role bits and flattens category overwrites onto children", () => {
    const vipSend = DiscordPermission.SEND_MESSAGES.toString();
    const everyoneDenyView = DISCORD_VIEW_CHANNEL.toString();
    const plan = mapGuildTemplate(
      template({
        roles: [
          EVERYONE,
          {
            id: 9,
            name: "VIP",
            color: 0,
            hoist: false,
            mentionable: false,
            permissions: vipSend,
          },
        ],
        channels: [
          {
            id: 10,
            type: 4,
            name: "Staff",
            position: 0,
            parent_id: null,
            permission_overwrites: [
              { id: 0, type: 0, allow: "0", deny: everyoneDenyView },
              {
                id: 9,
                type: 0,
                allow: DiscordPermission.VIEW_CHANNEL.toString(),
                deny: "0",
              },
            ],
          },
          {
            id: 11,
            type: 0,
            name: "mods",
            position: 0,
            parent_id: 10,
            permission_overwrites: [],
          },
        ],
      }),
    );
    expect(plan.roles[0]?.permissions).toBe(
      serializePermissions(Permission.SEND_MESSAGES),
    );
    const child = plan.overwrites.filter(
      (row) => row.channelTemplateId === 11,
    );
    expect(child).toEqual(
      expect.arrayContaining([
        {
          channelTemplateId: 11,
          roleTemplateId: 0,
          allow: "0",
          deny: serializePermissions(Permission.VIEW_CHANNEL),
        },
        {
          channelTemplateId: 11,
          roleTemplateId: 9,
          allow: serializePermissions(Permission.VIEW_CHANNEL),
          deny: "0",
        },
      ]),
    );
    expect(
      plan.overwrites.some((row) => row.channelTemplateId === 10),
    ).toBe(false);
  });

  it("builds a Discord CDN icon URL only from a snowflake and a hash", () => {
    expect(
      discordGuildIconUrl("123456789012345678", "a".repeat(32)),
    ).toBe(
      `https://cdn.discordapp.com/icons/123456789012345678/${"a".repeat(32)}.png?size=256`,
    );
    expect(discordGuildIconUrl("not-an-id", "a".repeat(32))).toBeNull();
    expect(discordGuildIconUrl("123456789012345678", "../x")).toBeNull();
    const plan = mapGuildTemplate({
      source_guild_id: "123456789012345678",
      serialized_source_guild: {
        name: "With icon",
        icon_hash: "b".repeat(32),
        roles: [EVERYONE],
        channels: [],
      },
    });
    expect(plan.iconUrl).toContain("cdn.discordapp.com/icons/");
    expect(plan.mappedAway.some((item) => item.reason === "serverIcon")).toBe(
      false,
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  DISCORD_VIEW_CHANNEL,
  MAX_IMPORT_CATEGORIES,
  MAX_IMPORT_CHANNELS,
  mapGuildTemplate,
} from "./discord-import.js";
import {
  discordImportMergeApplySchema,
  discordMergeIsEmpty,
  planDiscordMerge,
  type MergeExisting,
  type MergeExistingChannel,
} from "./discord-import-merge.js";

const EVERYONE = { id: 0, name: "@everyone", color: 0, hoist: false, mentionable: false };

function plan(channels: unknown[], roles: unknown[] = []) {
  return mapGuildTemplate({
    updated_at: "2026-08-01T00:00:00+00:00",
    is_dirty: false,
    serialized_source_guild: { name: "Old Discord", roles: [EVERYONE, ...roles], channels },
  });
}

let nextId = 0;
function row(
  name: string,
  type: string,
  parentId: string | null = null,
  position = 0,
): MergeExistingChannel {
  nextId += 1;
  return { id: `ch-${nextId}`, name, type, parentId, position };
}

function existing(
  channels: MergeExistingChannel[] = [],
  roles: MergeExisting["roles"] = [{ id: "r-everyone", name: "everyone", isEveryone: true }],
): MergeExisting {
  return { channels, roles };
}

const TEMPLATE = [
  { id: 1, type: 4, name: "Text", position: 0 },
  { id: 2, type: 0, name: "general", position: 0, parent_id: 1 },
  { id: 3, type: 0, name: "memes", position: 1, parent_id: 1 },
  { id: 4, type: 4, name: "Voice", position: 1 },
  { id: 5, type: 2, name: "Lobby", position: 0, parent_id: 4 },
  { id: 6, type: 0, name: "rules", position: 0 },
];

function summary(result: ReturnType<typeof planDiscordMerge>) {
  return result.skipped.map((s) => `${s.kind}:${s.name}:${s.reason}`);
}

describe("planDiscordMerge", () => {
  it("adds everything to an empty server, categories and loose channels", () => {
    const result = planDiscordMerge(plan(TEMPLATE), existing());
    expect(result.addedCategories.map((c) => c.name)).toEqual(["Text", "Voice"]);
    expect(result.addedChannels.map((c) => c.name)).toEqual([
      "general",
      "memes",
      "Lobby",
      "rules",
    ]);
    expect(result.reusedCategories).toEqual([]);
    expect(result.skipped).toEqual([]);
    const general = result.addedChannels[0]!;
    expect(general.parentTemplateId).toBe(1);
    expect(general.parentExistingId).toBeNull();
    expect(result.addedChannels[3]!.categoryName).toBeNull();
  });

  it("reuses a category by trimmed, case-insensitive name and adds only what is missing", () => {
    const category = row("  text ", "category");
    const result = planDiscordMerge(
      plan(TEMPLATE),
      existing([category, row("GENERAL", "text", category.id)]),
    );
    expect(result.reusedCategories).toEqual([
      { templateId: 1, name: "Text", existingName: "  text ", existingId: category.id },
    ]);
    expect(result.addedCategories.map((c) => c.name)).toEqual(["Voice"]);
    const memes = result.addedChannels.find((c) => c.name === "memes")!;
    expect(memes.parentExistingId).toBe(category.id);
    expect(memes.parentTemplateId).toBeNull();
    expect(result.skipped).toEqual([
      { kind: "channel", name: "general", type: "text", categoryName: "  text ", reason: "exists" },
    ]);
  });

  it("treats the same name with another type as a different channel", () => {
    const category = row("Text", "category");
    const result = planDiscordMerge(
      plan(TEMPLATE),
      existing([category, row("general", "voice", category.id)]),
    );
    expect(result.addedChannels.map((c) => c.name)).toContain("general");
    expect(result.skipped.find((s) => s.name === "general")).toBeUndefined();
  });

  it("does not count a same-named channel in ANOTHER category as existing", () => {
    const other = row("Elsewhere", "category");
    const result = planDiscordMerge(
      plan(TEMPLATE),
      existing([other, row("general", "text", other.id)]),
    );
    expect(result.addedChannels.map((c) => c.name)).toContain("general");
  });

  it("skips a loose channel that already exists loose", () => {
    const result = planDiscordMerge(plan(TEMPLATE), existing([row("rules", "text")]));
    expect(result.skipped).toEqual([
      { kind: "channel", name: "rules", type: "text", categoryName: null, reason: "exists" },
    ]);
  });

  it("folds two template categories that read the same into one, and dedupes inside it", () => {
    const result = planDiscordMerge(
      plan([
        { id: 1, type: 4, name: "Chat", position: 0 },
        { id: 2, type: 0, name: "a", position: 0, parent_id: 1 },
        { id: 3, type: 4, name: " chat", position: 1 },
        { id: 4, type: 0, name: "A", position: 0, parent_id: 3 },
        { id: 5, type: 0, name: "b", position: 1, parent_id: 3 },
        { id: 6, type: 0, name: "dup", position: 0 },
        { id: 7, type: 0, name: "Dup", position: 1 },
      ]),
      existing(),
    );
    expect(result.addedCategories).toHaveLength(1);
    expect(result.addedChannels.map((c) => c.name)).toEqual(["a", "b", "dup"]);
    expect(summary(result)).toEqual([
      "category:chat:duplicate",
      "channel:A:duplicate",
      "channel:Dup:duplicate",
    ]);
  });

  it("is idempotent: planning against the result adds nothing", () => {
    const first = planDiscordMerge(plan(TEMPLATE), existing());
    const channels: MergeExistingChannel[] = first.addedCategories.map((c, i) => ({
      id: `cat-${c.templateId}`,
      name: c.name,
      type: "category",
      parentId: null,
      position: i,
    }));
    first.addedChannels.forEach((added, i) => {
      channels.push({
        id: `c${i}`,
        name: added.name,
        type: added.type,
        parentId: added.parentTemplateId != null ? `cat-${added.parentTemplateId}` : null,
        position: i,
      });
    });
    const second = planDiscordMerge(plan(TEMPLATE), existing(channels));
    expect(discordMergeIsEmpty(second)).toBe(true);
    expect(second.reusedCategories).toHaveLength(2);
    expect(second.skipped.every((s) => s.reason === "exists")).toBe(true);
  });

  it("counts what exists against the channel cap and reports what did not fit", () => {
    const filler = Array.from({ length: MAX_IMPORT_CHANNELS - 2 }, (_, i) =>
      row(`filler-${i}`, "text"),
    );
    const result = planDiscordMerge(
      plan([
        { id: 1, type: 0, name: "one", position: 0 },
        { id: 2, type: 0, name: "two", position: 1 },
        { id: 3, type: 0, name: "three", position: 2 },
      ]),
      existing(filler),
    );
    expect(result.addedChannels.map((c) => c.name)).toEqual(["one", "two"]);
    expect(result.skipped).toEqual([
      { kind: "channel", name: "three", type: "text", categoryName: null, reason: "channelLimit" },
    ]);
    expect(result.usage.channels).toEqual({
      existing: MAX_IMPORT_CHANNELS - 2,
      max: MAX_IMPORT_CHANNELS,
    });
  });

  it("does not make a category when only the header would fit", () => {
    const filler = Array.from({ length: MAX_IMPORT_CHANNELS - 1 }, (_, i) =>
      row(`filler-${i}`, "text"),
    );
    const result = planDiscordMerge(plan(TEMPLATE.slice(0, 3)), existing(filler));
    expect(result.addedCategories).toEqual([]);
    expect(result.addedChannels).toEqual([]);
    expect(summary(result)).toEqual([
      "category:Text:channelLimit",
      "channel:general:channelLimit",
      "channel:memes:channelLimit",
    ]);
  });

  it("stops at the category cap and skips the channels of the category it refused", () => {
    const cats = Array.from({ length: MAX_IMPORT_CATEGORIES }, (_, i) =>
      row(`cat-${i}`, "category", null, i),
    );
    const result = planDiscordMerge(plan(TEMPLATE.slice(0, 3)), existing(cats));
    expect(result.addedCategories).toEqual([]);
    expect(summary(result)).toEqual([
      "category:Text:categoryLimit",
      "channel:general:categoryLimit",
      "channel:memes:categoryLimit",
    ]);
  });

  it("keeps a refused category refused for a later duplicate, instead of making it empty", () => {
    const filler = Array.from({ length: MAX_IMPORT_CHANNELS - 1 }, (_, i) =>
      row(`filler-${i}`, "text"),
    );
    const result = planDiscordMerge(
      plan([
        { id: 1, type: 4, name: "Chat", position: 0 },
        { id: 2, type: 0, name: "a", position: 0, parent_id: 1 },
        { id: 3, type: 0, name: "b", position: 1, parent_id: 1 },
        { id: 4, type: 4, name: "chat", position: 1 },
      ]),
      existing(filler),
    );
    expect(result.addedCategories).toEqual([]);
    expect(summary(result)).toEqual([
      "category:Chat:channelLimit",
      "channel:a:channelLimit",
      "channel:b:channelLimit",
      "category:chat:channelLimit",
    ]);
  });

  it("still reuses a category at the cap", () => {
    const cats = Array.from({ length: MAX_IMPORT_CATEGORIES }, (_, i) =>
      row(i === 0 ? "Text" : `cat-${i}`, "category", null, i),
    );
    const result = planDiscordMerge(plan(TEMPLATE.slice(0, 3)), existing(cats));
    expect(result.reusedCategories).toHaveLength(1);
    expect(result.addedChannels.map((c) => c.name)).toEqual(["general", "memes"]);
  });

  it("carries privacy and lists private names", () => {
    const result = planDiscordMerge(
      plan([
        {
          id: 1,
          type: 0,
          name: "staff",
          position: 0,
          permission_overwrites: [
            { id: 0, type: 0, allow: "0", deny: DISCORD_VIEW_CHANNEL.toString() },
          ],
        },
      ]),
      existing(),
    );
    expect(result.addedChannels[0]!.isPrivate).toBe(true);
    expect(result.privateChannelNames).toEqual(["staff"]);
  });

  it("offers a cargo only for a name the server lacks, and counts its rules", () => {
    const view = DISCORD_VIEW_CHANNEL.toString();
    const result = planDiscordMerge(
      plan(
        [
          {
            id: 1,
            type: 0,
            name: "staff",
            position: 0,
            permission_overwrites: [
              { id: 0, type: 0, allow: "0", deny: view },
              { id: 10, type: 0, allow: view, deny: "0" },
              { id: 11, type: 0, allow: view, deny: "0" },
            ],
          },
        ],
        [
          { id: 10, name: "Mods", color: 0, hoist: false, mentionable: false, permissions: "0" },
          { id: 11, name: "Helpers", color: 0, hoist: false, mentionable: false, permissions: "0" },
        ],
      ),
      existing(
        [],
        [
          { id: "r-everyone", name: "everyone", isEveryone: true },
          { id: "r-mods", name: "mods", isEveryone: false },
        ],
      ),
    );
    expect(result.reusedRoles).toEqual([
      { templateId: 10, name: "Mods", existingName: "mods", existingId: "r-mods" },
    ]);
    expect(result.addableRoles.map((r) => [r.name, r.overwriteCount])).toEqual([
      ["Helpers", 1],
    ]);
  });

  it("never counts rules of a channel that was skipped", () => {
    const result = planDiscordMerge(
      plan(
        [
          {
            id: 1,
            type: 0,
            name: "staff",
            position: 0,
            permission_overwrites: [
              { id: 10, type: 0, allow: DISCORD_VIEW_CHANNEL.toString(), deny: "0" },
            ],
          },
        ],
        [{ id: 10, name: "Helpers", color: 0, hoist: false, mentionable: false, permissions: "0" }],
      ),
      existing([row("staff", "text")]),
    );
    expect(result.addableRoles[0]!.overwriteCount).toBe(0);
  });

  it("drops the server icon line, which a merge never touches", () => {
    const result = planDiscordMerge(
      mapGuildTemplate({
        source_guild_id: "123",
        serialized_source_guild: {
          name: "x",
          icon_hash: "abc",
          roles: [EVERYONE],
          channels: [],
        },
      }),
      existing(),
    );
    expect(result.mappedAway.find((m) => m.reason === "serverIcon")).toBeUndefined();
  });
});

describe("discordImportMergeApplySchema", () => {
  it("defaults to no cargos and refuses non-integers", () => {
    expect(discordImportMergeApplySchema.parse({ source: "abcd1234" }).createRoles).toBeUndefined();
    expect(
      discordImportMergeApplySchema.safeParse({ source: "abcd1234", createRoles: ["x"] }).success,
    ).toBe(false);
  });
});

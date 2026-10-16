import { z } from "zod";
import {
  MAX_IMPORT_CATEGORIES,
  MAX_IMPORT_CHANNELS,
  MAX_IMPORT_ROLES,
  type DiscordImportPlan,
  type MappedAwayItem,
  type MappedImportChannel,
  type MappedImportForumTag,
  type NotInTemplateReason,
} from "./discord-import.js";

/**
 * Importing a Discord layout INTO a community that already exists.
 *
 * The rules live here, pure, so the server's preview, the server's apply and
 * the client's tests all read the same answer. The module only ever ADDS: it
 * has no way to say "delete", "rename", "move" or "retype", because its output
 * is a list of things to insert and a list of things left alone.
 *
 * - A template category whose name matches an existing one (trimmed,
 *   case-insensitive) is reused and only its missing channels are added.
 * - A channel whose name AND type already sit in the target group (that
 *   category, or the loose channels) is skipped as `exists`.
 * - The same name twice inside the template is added once (`duplicate`).
 * - The same name with another type is a different channel and is added: pqp
 *   has no unique name, and `general` as text and as voice is ordinary.
 * - The caps of an import (`MAX_IMPORT_CHANNELS`, `MAX_IMPORT_CATEGORIES`)
 *   count what the server already has, so a template cannot push a community
 *   past what a fresh import could have made. Whatever does not fit is
 *   reported (`channelLimit`, `categoryLimit`), never silently dropped.
 */

export const discordImportMergeApplySchema = z.object({
  source: z.string().min(1).max(200),
  /**
   * Template ids of the cargos to create. Default: none. A cargo is only ever
   * created for a name the server does not have; an existing cargo is never
   * touched, and nobody is given one.
   */
  createRoles: z.array(z.number().int()).max(MAX_IMPORT_ROLES).optional(),
});

export type DiscordImportMergeApply = z.infer<typeof discordImportMergeApplySchema>;

/** What the server already has, as much of it as the merge reads. */
export interface MergeExistingChannel {
  id: string;
  name: string;
  /** `category`, `text`, `voice`, `forum`, `watch_party`. Threads are left out. */
  type: string;
  parentId: string | null;
  position: number;
}

export interface MergeExistingRole {
  id: string;
  name: string;
  isEveryone: boolean;
}

export interface MergeExisting {
  channels: MergeExistingChannel[];
  roles: MergeExistingRole[];
}

export const MERGE_SKIP_REASONS = [
  "exists",
  "duplicate",
  "channelLimit",
  "categoryLimit",
] as const;

export type MergeSkipReason = (typeof MERGE_SKIP_REASONS)[number];

export interface MergeSkippedItem {
  kind: "category" | "channel";
  name: string;
  /** Channels only. */
  type?: MappedImportChannel["type"];
  /** The category the item sat in, in the template. Null for loose channels. */
  categoryName: string | null;
  reason: MergeSkipReason;
}

export interface MergeAddedCategory {
  templateId: number;
  name: string;
}

export interface MergeReusedCategory {
  templateId: number;
  name: string;
  /** The existing category's own spelling. */
  existingName: string;
  existingId: string;
}

export interface MergeAddedChannel {
  templateId: number;
  name: string;
  type: Exclude<MappedImportChannel["type"], "category">;
  topic: string | null;
  isPrivate: boolean;
  /** A category this merge creates; null when loose or inside a reused one. */
  parentTemplateId: number | null;
  /** An existing category this channel joins; null when loose or in a new one. */
  parentExistingId: string | null;
  categoryName: string | null;
  tags?: MappedImportForumTag[];
}

export interface MergeAddableRole {
  templateId: number;
  name: string;
  originalName: string;
  color: string | null;
  hoist: boolean;
  mentionable: boolean;
  permissions: string;
  /**
   * How many channel permission rules this merge would write for the cargo.
   * Without the cargo they are not written, which the preview says.
   */
  overwriteCount: number;
}

export interface MergeReusedRole {
  templateId: number;
  name: string;
  existingName: string;
  existingId: string;
}

export interface DiscordMergePlan {
  templateUpdatedAt: string | null;
  isDirty: boolean;
  addedCategories: MergeAddedCategory[];
  reusedCategories: MergeReusedCategory[];
  addedChannels: MergeAddedChannel[];
  skipped: MergeSkippedItem[];
  addableRoles: MergeAddableRole[];
  reusedRoles: MergeReusedRole[];
  /** Overwrites of added channels, resolved to a cargo that exists today. */
  usage: {
    channels: { existing: number; max: number };
    categories: { existing: number; max: number };
  };
  privateChannelNames: string[];
  notInTemplate: NotInTemplateReason[];
  mappedAway: MappedAwayItem[];
}

/** The preview the API answers: the plan plus what this caller may do. */
export interface DiscordMergePreview extends DiscordMergePlan {
  /** Creating cargos needs Manage Roles on top of Manage Server. */
  canCreateRoles: boolean;
}

export function mergeName(name: string): string {
  return name.trim().toLowerCase();
}

function channelKey(name: string, type: string): string {
  return `${type}\u0000${mergeName(name)}`;
}

/** Position order, ties by template id so the answer never depends on input order. */
function byPosition(a: MappedImportChannel, b: MappedImportChannel): number {
  return a.position - b.position || a.templateId - b.templateId;
}

export function planDiscordMerge(
  plan: DiscordImportPlan,
  existing: MergeExisting,
): DiscordMergePlan {
  const existingCategories = existing.channels
    .filter((channel) => channel.type === "category")
    .sort((a, b) => a.position - b.position);
  const existingCategoryByName = new Map<string, MergeExistingChannel>();
  for (const category of existingCategories) {
    const key = mergeName(category.name);
    if (!existingCategoryByName.has(key)) {
      existingCategoryByName.set(key, category);
    }
  }

  let budget = Math.max(0, MAX_IMPORT_CHANNELS - existing.channels.length);
  let categorySlots = Math.max(
    0,
    MAX_IMPORT_CATEGORIES - existingCategories.length,
  );

  const addedCategories: MergeAddedCategory[] = [];
  const reusedCategories: MergeReusedCategory[] = [];
  const addedChannels: MergeAddedChannel[] = [];
  const skipped: MergeSkippedItem[] = [];

  const templateCategories = plan.channels
    .filter((channel) => channel.type === "category")
    .sort(byPosition);
  const childrenOf = (parentTemplateId: number | null) =>
    plan.channels
      .filter(
        (channel) =>
          channel.type !== "category" &&
          (channel.parentTemplateId ?? null) === parentTemplateId,
      )
      .sort(byPosition);

  // Two template categories that read the same ("Voice" and " voice ") are
  // one target: the second adds nothing of its own and its channels join the
  // first's.
  const targets = new Map<
    string,
    {
      existingId: string | null;
      newTemplateId: number | null;
      categoryName: string;
      present: Set<string>;
      added: Set<string>;
    }
  >();

  function addChannelsTo(
    children: MappedImportChannel[],
    target: {
      existingId: string | null;
      newTemplateId: number | null;
      categoryName: string | null;
      present: Set<string>;
      added: Set<string>;
    },
  ) {
    for (const child of children) {
      const key = channelKey(child.name, child.type);
      const skip = (reason: MergeSkipReason) =>
        skipped.push({
          kind: "channel",
          name: child.name,
          type: child.type,
          categoryName: target.categoryName,
          reason,
        });
      if (target.present.has(key)) {
        skip("exists");
        continue;
      }
      if (target.added.has(key)) {
        skip("duplicate");
        continue;
      }
      if (budget <= 0) {
        skip("channelLimit");
        continue;
      }
      budget -= 1;
      target.added.add(key);
      addedChannels.push({
        templateId: child.templateId,
        name: child.name,
        type: child.type as MergeAddedChannel["type"],
        topic: child.topic,
        isPrivate: child.isPrivate,
        parentTemplateId: target.newTemplateId,
        parentExistingId: target.existingId,
        categoryName: target.categoryName,
        ...(child.tags ? { tags: child.tags } : {}),
      });
    }
  }

  const presentIn = (parentId: string | null) =>
    new Set(
      existing.channels
        .filter(
          (channel) =>
            channel.type !== "category" && (channel.parentId ?? null) === parentId,
        )
        .map((channel) => channelKey(channel.name, channel.type)),
    );

  for (const category of templateCategories) {
    const norm = mergeName(category.name);
    const children = childrenOf(category.templateId);
    const earlier = targets.get(norm);
    if (earlier) {
      skipped.push({
        kind: "category",
        name: category.name,
        categoryName: null,
        reason: "duplicate",
      });
      addChannelsTo(children, earlier);
      continue;
    }

    const match = existingCategoryByName.get(norm);
    if (match) {
      reusedCategories.push({
        templateId: category.templateId,
        name: category.name,
        existingName: match.name,
        existingId: match.id,
      });
      const target = {
        existingId: match.id,
        newTemplateId: null,
        categoryName: match.name,
        present: presentIn(match.id),
        added: new Set<string>(),
      };
      targets.set(norm, target);
      addChannelsTo(children, target);
      continue;
    }

    // A new category. It costs one slot of each cap, and it is only made when
    // there is room for something to put in it: an empty header added because
    // its channels did not fit would be clutter the person did not ask for.
    const distinct = new Set(
      children.map((child) => channelKey(child.name, child.type)),
    ).size;
    if (categorySlots <= 0) {
      skipped.push({
        kind: "category",
        name: category.name,
        categoryName: null,
        reason: "categoryLimit",
      });
      for (const child of children) {
        skipped.push({
          kind: "channel",
          name: child.name,
          type: child.type,
          categoryName: category.name,
          reason: "categoryLimit",
        });
      }
      continue;
    }
    if (budget < (distinct > 0 ? 2 : 1)) {
      skipped.push({
        kind: "category",
        name: category.name,
        categoryName: null,
        reason: "channelLimit",
      });
      for (const child of children) {
        skipped.push({
          kind: "channel",
          name: child.name,
          type: child.type,
          categoryName: category.name,
          reason: "channelLimit",
        });
      }
      continue;
    }
    categorySlots -= 1;
    budget -= 1;
    addedCategories.push({ templateId: category.templateId, name: category.name });
    const target = {
      existingId: null,
      newTemplateId: category.templateId,
      categoryName: category.name,
      present: new Set<string>(),
      added: new Set<string>(),
    };
    targets.set(norm, target);
    addChannelsTo(children, target);
  }

  addChannelsTo(childrenOf(null), {
    existingId: null,
    newTemplateId: null,
    categoryName: null,
    present: presentIn(null),
    added: new Set<string>(),
  });

  // Cargos. An existing name is only ever REFERENCED (a rule on a channel this
  // merge adds); a new name is offered, and made only if the person ticked it.
  const roleByName = new Map<string, MergeExistingRole>();
  for (const role of existing.roles) {
    if (!role.isEveryone && !roleByName.has(mergeName(role.name))) {
      roleByName.set(mergeName(role.name), role);
    }
  }
  const addedIds = new Set(addedChannels.map((channel) => channel.templateId));
  const overwritesByRole = new Map<number, number>();
  for (const overwrite of plan.overwrites) {
    if (!addedIds.has(overwrite.channelTemplateId)) {
      continue;
    }
    overwritesByRole.set(
      overwrite.roleTemplateId,
      (overwritesByRole.get(overwrite.roleTemplateId) ?? 0) + 1,
    );
  }
  const addableRoles: MergeAddableRole[] = [];
  const reusedRoles: MergeReusedRole[] = [];
  for (const role of plan.roles) {
    const match = roleByName.get(mergeName(role.name));
    if (match) {
      reusedRoles.push({
        templateId: role.templateId,
        name: role.name,
        existingName: match.name,
        existingId: match.id,
      });
      continue;
    }
    addableRoles.push({
      templateId: role.templateId,
      name: role.name,
      originalName: role.originalName,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      permissions: role.permissions,
      overwriteCount: overwritesByRole.get(role.templateId) ?? 0,
    });
  }

  return {
    templateUpdatedAt: plan.templateUpdatedAt,
    isDirty: plan.isDirty,
    addedCategories,
    reusedCategories,
    addedChannels,
    skipped,
    addableRoles,
    reusedRoles,
    usage: {
      channels: { existing: existing.channels.length, max: MAX_IMPORT_CHANNELS },
      categories: {
        existing: existingCategories.length,
        max: MAX_IMPORT_CATEGORIES,
      },
    },
    privateChannelNames: addedChannels
      .filter((channel) => channel.isPrivate)
      .map((channel) => channel.name),
    notInTemplate: plan.notInTemplate,
    mappedAway: plan.mappedAway.filter(
      // The icon and @everyone are never touched by a merge, so the "could
      // not copy the icon" line would be about something that was not asked.
      (item) => item.reason !== "serverIcon",
    ),
  };
}

/** True when running the same template again would add nothing. */
export function discordMergeIsEmpty(plan: DiscordMergePlan): boolean {
  return plan.addedCategories.length === 0 && plan.addedChannels.length === 0;
}

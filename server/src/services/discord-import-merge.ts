import {
  grantablePermissions,
  planDiscordMerge,
  serializePermissions,
  type DiscordImportPlan,
  type DiscordMergePlan,
  type MergeExisting,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { isEnabled } from "../lib/flags.js";
import { logAudit } from "./audit.js";
import { bumpChannelLayoutVersion } from "./channel-layout.js";
import { insertForumTags } from "./discord-import.js";
import type { Queryable } from "./invites.js";
import {
  applyPrivateChannelOverwrites,
  bumpPermissionsVersion,
  upsertMemberViewOverwrite,
} from "./permissions.js";
import {
  CHANNEL_COLUMNS,
  invalidateServerAudience,
  invalidateServerChannelList,
  positionGroupTypes,
  type ChannelRow,
} from "./servers.js";

/** Runtime flag `discord_import_existing`, read for the server being merged into. */
export function discordImportExistingEnabled(serverId: string): boolean {
  return isEnabled("discord_import_existing", { serverId });
}

export interface DiscordMergeResult {
  plan: DiscordMergePlan;
  /** The rows this merge inserted, in sidebar order. Empty on a second run. */
  channels: ChannelRow[];
  rolesCreated: string[];
}

/**
 * What the merge reads about the server today. Threads are not part of the
 * sidebar and are never a target. `db` is the open transaction when there is
 * one, so the apply plans against the same rows it then writes next to.
 */
export async function loadMergeExisting(
  serverId: string,
  db: Queryable = getPool(),
): Promise<MergeExisting> {
  const channels = await db.query<{
    id: string;
    name: string;
    type: string;
    parent_id: string | null;
    position: number;
  }>(
    `SELECT id, name, type, parent_id, position FROM channels
      WHERE server_id = $1 AND kind = 'server' AND type <> 'thread'`,
    [serverId],
  );
  const roles = await db.query<{ id: string; name: string; is_everyone: boolean }>(
    `SELECT id, name, is_everyone FROM roles WHERE server_id = $1`,
    [serverId],
  );
  return {
    channels: channels.rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      parentId: row.parent_id,
      position: row.position,
    })),
    roles: roles.rows.map((row) => ({
      id: row.id,
      name: row.name,
      isEveryone: row.is_everyone,
    })),
  };
}

export async function previewDiscordMerge(
  serverId: string,
  plan: DiscordImportPlan,
): Promise<DiscordMergePlan> {
  return planDiscordMerge(plan, await loadMergeExisting(serverId));
}

/**
 * Adds a Discord layout to a server that already exists, in ONE transaction.
 *
 * Strictly additive. Nothing here updates or deletes a channel, a category, a
 * cargo, an overwrite or a member. The only write to a row that was already
 * there is the server's `channel_layout_version` (which every channel create
 * bumps too, so open clients know the list moved) and the rank number of the
 * cargos, which slides up by the number of cargos added so the new ones sit
 * under everything (the same thing making a cargo by hand does; their order
 * among themselves is unchanged).
 *
 * The server row is locked first (`bumpChannelLayoutVersion` is an UPDATE of
 * it), which is the same first lock every writer of the channel list takes. A
 * second apply of the same template, started while the first is open, waits
 * there and then plans against what the first left, so it adds nothing.
 */
export async function applyDiscordMerge(input: {
  serverId: string;
  actorId: string;
  code: string;
  plan: DiscordImportPlan;
  createRoleTemplateIds: number[];
  /** The caller's permission bits: a cargo never carries one they cannot grant. */
  actorPermissions: bigint;
}): Promise<DiscordMergeResult> {
  const { serverId } = input;
  const client = await getPool().connect();
  let merged: DiscordMergeResult;
  let touchedPermissions = false;
  try {
    await client.query("BEGIN");
    await bumpChannelLayoutVersion(client, serverId);

    const existing = await loadMergeExisting(serverId, client);
    const merge = planDiscordMerge(input.plan, existing);

    // Cargos first, so a rule on a new channel can name one made in this very
    // transaction. Only the names the person ticked AND the server lacks.
    const roleIdByTemplate = new Map<number, string>();
    for (const reused of merge.reusedRoles) {
      roleIdByTemplate.set(reused.templateId, reused.existingId);
    }
    const everyone = existing.roles.find((role) => role.isEveryone);
    if (everyone) {
      roleIdByTemplate.set(0, everyone.id);
    }
    const wanted = new Set(input.createRoleTemplateIds);
    const toCreate = merge.addableRoles.filter((role) => wanted.has(role.templateId));
    const rolesCreated: string[] = [];
    if (
      merge.addedCategories.length === 0 &&
      merge.addedChannels.length === 0 &&
      toCreate.length === 0
    ) {
      // Everything is already here (a second run of the same template). Write
      // nothing at all, not even the layout version bump or an audit row: no
      // open client has a reason to refetch for a no-op.
      await client.query("ROLLBACK");
      return { plan: merge, channels: [], rolesCreated: [] };
    }
    if (toCreate.length > 0) {
      await client.query(
        `UPDATE roles SET position = position + $2
          WHERE server_id = $1 AND is_everyone = FALSE`,
        [serverId, toCreate.length],
      );
      const grantable = grantablePermissions(input.actorPermissions);
      let rank = 1;
      for (const role of toCreate) {
        const permissions = BigInt(role.permissions) & grantable;
        // `ON CONFLICT` on the case-insensitive name: a cargo made by hand a
        // moment ago (the plan above read the table before it) is reused, not
        // a unique violation that would take the whole import down with it.
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO roles (server_id, name, color, hoist, mentionable, permissions, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (server_id, LOWER(name)) DO NOTHING
           RETURNING id`,
          [
            serverId,
            role.name,
            role.color,
            role.hoist,
            role.mentionable,
            serializePermissions(permissions),
            rank,
          ],
        );
        rank += 1;
        if (inserted.rows[0]) {
          roleIdByTemplate.set(role.templateId, inserted.rows[0].id);
          rolesCreated.push(role.name);
          continue;
        }
        const raced = await client.query<{ id: string }>(
          `SELECT id FROM roles WHERE server_id = $1 AND LOWER(name) = LOWER($2)`,
          [serverId, role.name],
        );
        if (raced.rows[0]) {
          roleIdByTemplate.set(role.templateId, raced.rows[0].id);
        }
      }
      touchedPermissions = true;
    }

    // Categories go after the last one, in the template's order.
    const categoryIdByTemplate = new Map<number, string>();
    for (const reused of merge.reusedCategories) {
      categoryIdByTemplate.set(reused.templateId, reused.existingId);
    }
    let categoryPosition =
      (
        await client.query<{ max: number | null }>(
          `SELECT MAX(position) AS max FROM channels
            WHERE server_id = $1 AND parent_id IS NULL AND type = 'category'`,
          [serverId],
        )
      ).rows[0]?.max ?? -1;
    for (const category of merge.addedCategories) {
      categoryPosition += 1;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO channels (server_id, name, type, position, is_private, topic, parent_id)
         VALUES ($1, $2, 'category', $3, FALSE, NULL, NULL)
         RETURNING id`,
        [serverId, category.name, categoryPosition],
      );
      categoryIdByTemplate.set(category.templateId, inserted.rows[0]!.id);
    }

    // Channels go after the last sibling of their group: the end of the
    // category they join, or of the loose channels. One mixed sequence per
    // group, the same one `createChannel` appends to.
    const nextPosition = new Map<string, number>();
    const positionFor = async (parentId: string | null): Promise<number> => {
      const key = parentId ?? "";
      let next = nextPosition.get(key);
      if (next === undefined) {
        const max = await client.query<{ max: number | null }>(
          `SELECT MAX(position) AS max FROM channels
            WHERE server_id = $1 AND parent_id IS NOT DISTINCT FROM $2
              AND type = ANY($3::text[])`,
          [serverId, parentId, positionGroupTypes("text")],
        );
        next = (max.rows[0]?.max ?? -1) + 1;
      }
      nextPosition.set(key, next + 1);
      return next;
    };

    const channelIdByTemplate = new Map<number, string>();
    const channels: ChannelRow[] = [];
    for (const channel of merge.addedChannels) {
      const parentId =
        channel.parentExistingId ??
        (channel.parentTemplateId != null
          ? (categoryIdByTemplate.get(channel.parentTemplateId) ?? null)
          : null);
      const position = await positionFor(parentId);
      const inserted = await client.query<ChannelRow>(
        `INSERT INTO channels (server_id, name, type, position, is_private, topic, parent_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${CHANNEL_COLUMNS}`,
        [
          serverId,
          channel.name,
          channel.type,
          position,
          channel.isPrivate,
          channel.topic,
          parentId,
        ],
      );
      const row = inserted.rows[0]!;
      channels.push(row);
      channelIdByTemplate.set(channel.templateId, row.id);
    }

    await insertForumTags(
      client,
      {
        channels: merge.addedChannels.map((channel) => ({
          templateId: channel.templateId,
          type: channel.type,
          tags: channel.tags,
        })),
      },
      channelIdByTemplate,
    );

    // Rules on the channels this merge made, and only those. A rule whose
    // cargo is neither on the server nor ticked is not written.
    for (const overwrite of input.plan.overwrites) {
      const channelId = channelIdByTemplate.get(overwrite.channelTemplateId);
      const roleId = roleIdByTemplate.get(overwrite.roleTemplateId);
      if (!channelId || !roleId) {
        continue;
      }
      await client.query(
        `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
         VALUES ($1, 'role', $2, $3, $4)
         ON CONFLICT (channel_id, target_type, target_id)
         DO UPDATE SET allow = EXCLUDED.allow, deny = EXCLUDED.deny`,
        [channelId, roleId, overwrite.allow, overwrite.deny],
      );
      touchedPermissions = true;
    }
    for (const row of channels) {
      if (row.is_private) {
        await applyPrivateChannelOverwrites(client, row.id, serverId, true);
        // The same access row `POST /channels` gives whoever makes a private
        // channel: an owner reads everything, but a manager who is not an
        // admin would otherwise add a channel they cannot open.
        await client.query(
          `INSERT INTO channel_members (channel_id, user_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [row.id, input.actorId],
        );
        await upsertMemberViewOverwrite(client, row.id, input.actorId);
        touchedPermissions = true;
      }
    }

    await logAudit(
      {
        serverId,
        actorId: input.actorId,
        action: "server.discord_import_merge",
        targetType: "server",
        targetId: serverId,
        changes: [
          { key: "templateCode", old: null, new: input.code },
          { key: "categoriesAdded", old: null, new: merge.addedCategories.length },
          { key: "categoriesReused", old: null, new: merge.reusedCategories.length },
          { key: "channelsAdded", old: null, new: merge.addedChannels.length },
          { key: "skipped", old: null, new: merge.skipped.length },
          { key: "rolesAdded", old: null, new: rolesCreated.length },
        ],
      },
      client,
    );

    await client.query("COMMIT");
    merged = { plan: merge, channels, rolesCreated };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  // Committed. Caches after, never before: a read in between would warm them
  // with the old list. A failure here must not look like a failed import.
  try {
    if (touchedPermissions) {
      await bumpPermissionsVersion(serverId);
    }
  } catch (error) {
    console.error("[discord-import-merge] permissions version bump failed:", error);
  } finally {
    invalidateServerChannelList(serverId);
    if (merged.rolesCreated.length > 0) {
      invalidateServerAudience(serverId);
    }
  }
  return merged;
}

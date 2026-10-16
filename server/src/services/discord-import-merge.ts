import { randomUUID } from "node:crypto";
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
import { applyPrivateChannelOverwrites, upsertMemberViewOverwrite } from "./permissions.js";
import {
  CHANNEL_COLUMNS,
  invalidateServerAudience,
  invalidateServerChannelList,
  positionGroupTypes,
  type ChannelRow,
} from "./servers.js";

/** Rules per INSERT: 1,000 x 4 parameters, far under PostgreSQL's 65,535. */
const OVERWRITE_CHUNK = 1000;

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
 * cargo, an overwrite or a member. The only writes to a row that was already
 * there are the server's `channel_layout_version` (which every channel create
 * bumps too, so open clients know the list moved), its `permissions_version`
 * when a rule or cargo is written (so cached permission answers drop), and the
 * rank number of the cargos, which slides up by the number of cargos added so the new ones sit
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
      // One statement for every cargo. `ON CONFLICT` on the case-insensitive
      // name: a cargo made by hand a moment ago (the plan above read the table
      // before it) is reused, not a unique violation that would take the whole
      // import down with it.
      const params: unknown[] = [serverId];
      const tuples = toCreate.map((role, index) => {
        const base = params.length;
        params.push(
          role.name,
          role.color,
          role.hoist,
          role.mentionable,
          serializePermissions(BigInt(role.permissions) & grantable),
          index + 1,
        );
        return `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
      });
      const inserted = await client.query<{ id: string; name: string }>(
        `INSERT INTO roles (server_id, name, color, hoist, mentionable, permissions, position)
         VALUES ${tuples.join(", ")}
         ON CONFLICT (server_id, LOWER(name)) DO NOTHING
         RETURNING id, name`,
        params,
      );
      const idByName = new Map(inserted.rows.map((row) => [row.name.toLowerCase(), row.id]));
      const raced = toCreate.filter((role) => !idByName.has(role.name.toLowerCase()));
      if (raced.length > 0) {
        const found = await client.query<{ id: string; name: string }>(
          `SELECT id, name FROM roles WHERE server_id = $1 AND LOWER(name) = ANY($2::text[])`,
          [serverId, raced.map((role) => role.name.toLowerCase())],
        );
        for (const row of found.rows) {
          idByName.set(row.name.toLowerCase(), row.id);
        }
      }
      for (const role of toCreate) {
        const id = idByName.get(role.name.toLowerCase());
        if (!id) {
          continue;
        }
        roleIdByTemplate.set(role.templateId, id);
        if (inserted.rows.some((row) => row.id === id)) {
          rolesCreated.push(role.name);
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

    type NewRow = {
      id: string;
      name: string;
      type: string;
      position: number;
      isPrivate: boolean;
      topic: string | null;
      parentId: string | null;
    };
    const insertRows = async (rows: NewRow[]): Promise<ChannelRow[]> => {
      if (rows.length === 0) {
        return [];
      }
      const params: unknown[] = [serverId];
      const tuples = rows.map((row) => {
        const base = params.length;
        params.push(row.id, row.name, row.type, row.position, row.isPrivate, row.topic, row.parentId);
        return `($${base + 1}, $1, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
      });
      const result = await client.query<ChannelRow>(
        `INSERT INTO channels (id, server_id, name, type, position, is_private, topic, parent_id)
         VALUES ${tuples.join(", ")}
         RETURNING ${CHANNEL_COLUMNS}`,
        params,
      );
      // Back in the order they were planned, whatever order Postgres returned.
      const byId = new Map(result.rows.map((row) => [row.id, row]));
      return rows.map((row) => byId.get(row.id)!);
    };

    await insertRows(
      merge.addedCategories.map((category) => {
        categoryPosition += 1;
        const id = randomUUID();
        categoryIdByTemplate.set(category.templateId, id);
        return {
          id,
          name: category.name,
          type: "category",
          position: categoryPosition,
          isPrivate: false,
          topic: null,
          parentId: null,
        };
      }),
    );

    // Channels go after the last sibling of their group: the end of the
    // category they join, or of the loose channels. One mixed sequence per
    // group, the same one `createChannel` appends to. A category this merge
    // just made has no children yet, so only the groups that existed are read.
    const parentOf = (channel: (typeof merge.addedChannels)[number]): string | null =>
      channel.parentExistingId ??
      (channel.parentTemplateId != null
        ? (categoryIdByTemplate.get(channel.parentTemplateId) ?? null)
        : null);
    const existingParents = [
      ...new Set(
        merge.addedChannels
          .map((channel) => channel.parentExistingId)
          .filter((id): id is string => id != null),
      ),
    ];
    const maxima = await client.query<{ parent_id: string | null; max: number }>(
      `SELECT parent_id, MAX(position) AS max FROM channels
        WHERE server_id = $1 AND type = ANY($2::text[])
          AND (parent_id IS NULL OR parent_id = ANY($3::uuid[]))
        GROUP BY parent_id`,
      [serverId, positionGroupTypes("text"), existingParents],
    );
    const nextPosition = new Map<string, number>(
      maxima.rows.map((row) => [row.parent_id ?? "", row.max + 1]),
    );

    const channelIdByTemplate = new Map<number, string>();
    const channels = await insertRows(
      merge.addedChannels.map((channel) => {
        const parentId = parentOf(channel);
        const key = parentId ?? "";
        const position = nextPosition.get(key) ?? 0;
        nextPosition.set(key, position + 1);
        const id = randomUUID();
        channelIdByTemplate.set(channel.templateId, id);
        return {
          id,
          name: channel.name,
          type: channel.type,
          position,
          isPrivate: channel.isPrivate,
          topic: channel.topic,
          parentId,
        };
      }),
    );

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
    const rules = new Map<string, { channelId: string; roleId: string; allow: string; deny: string }>();
    for (const overwrite of input.plan.overwrites) {
      const channelId = channelIdByTemplate.get(overwrite.channelTemplateId);
      const roleId = roleIdByTemplate.get(overwrite.roleTemplateId);
      if (!channelId || !roleId) {
        continue;
      }
      rules.set(`${channelId}:${roleId}`, {
        channelId,
        roleId,
        allow: overwrite.allow,
        deny: overwrite.deny,
      });
    }
    if (rules.size > 0) {
      // Bounded chunks: a template of 200 channels with 100 cargos can name
      // more rules than one statement has bind parameters (65,535 / 4).
      const all = [...rules.values()];
      for (let from = 0; from < all.length; from += OVERWRITE_CHUNK) {
        const params: unknown[] = [];
        const tuples = all.slice(from, from + OVERWRITE_CHUNK).map((rule) => {
          const base = params.length;
          params.push(rule.channelId, rule.roleId, rule.allow, rule.deny);
          return `($${base + 1}, 'role', $${base + 2}, $${base + 3}, $${base + 4})`;
        });
        await client.query(
          `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
           VALUES ${tuples.join(", ")}
           ON CONFLICT (channel_id, target_type, target_id)
           DO UPDATE SET allow = EXCLUDED.allow, deny = EXCLUDED.deny`,
          params,
        );
      }
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

    if (touchedPermissions) {
      // Inside the transaction, so the version moves with the rows it
      // describes: a bump after COMMIT that failed would leave every cached
      // permission answer stale for rules that are already committed.
      await client.query(
        `UPDATE servers SET permissions_version = permissions_version + 1 WHERE id = $1`,
        [serverId],
      );
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
  // with the old list.
  invalidateServerChannelList(serverId);
  if (merged.rolesCreated.length > 0) {
    invalidateServerAudience(serverId);
  }
  return merged;
}

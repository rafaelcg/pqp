import {
  formatUserTag,
  type ChannelKind,
  type VoiceRoomTransport,
} from "@pqp/shared";
import { getPool, type DbChannel, type DbServer, type MemberRole } from "../db.js";
import {
  isBusEnabled,
  publishToCluster,
  subscribeToCluster,
} from "../lib/bus.js";
import { deleteObject, isStorageConfigured } from "../lib/s3.js";
import {
  applyPrivateChannelOverwrites,
  bumpPermissionsVersion,
  deleteMemberViewOverwrite,
  seedDefaultRoles,
  upsertMemberViewOverwrite,
} from "./permissions.js";
import { channelVisibleSql } from "./users.js";

/**
 * A `channels` row as it actually comes back now that a channel need not belong
 * to a server.
 *
 * Declared here rather than widening `DbChannel` in db.ts because every caller
 * that reads `server_id` to route or to authorise has to be made to say what it
 * does when there is no server — and the type is the only thing that will make
 * it. `db.ts` still describes the pre-conversation shape; nothing outside this
 * file reads a channel row directly.
 */
export type ChannelRow = Omit<DbChannel, "server_id"> & {
  server_id: string | null;
  kind: ChannelKind;
};

/** Every channel read selects the same columns, `kind` included. */
export const CHANNEL_COLUMNS = `id, server_id, name, type, position, is_private, kind, topic, image_url, parent_id, slowmode_seconds, voice_transport`;

/**
 * Every server read selects the same columns.
 *
* Exported because `server-images.ts` writes this table too, and a picture
 * upload has to hand the whole updated row back to the client for the same
 * reason a rename does. Threading the list through rather than restating it
 * there is what keeps a column added here from being invisible in that payload.
 *
 * `icon_key` / `banner_key` are deliberately NOT in it: the key is what the
 * bucket is asked about, never what a client is told. `mapServer` has no field
 * for either. `is_community` rides along even though the directory is flagged
 * off by default: it is what tells the member's own client whether the rail's
 * context menu should offer "show this on my profile". `show_on_profile` is
 * NOT here — it lives on `server_members`, so only reads that join a
 * membership can select it.
 */
export const SERVER_COLUMNS = `id, name, owner_id, created_at, message_retention_days, sso_email_domain, icon_url, banner_url, is_community, community_home_enabled`;

/**
 * How many attachment objects one channel or server delete will clean up.
 *
 * The read happens on the request path, so it cannot pull an unbounded key set
 * into memory. Past the cap the objects leak, which is the same cost problem
 * the sweeper already accepts on a failed delete and which a bucket lifecycle
 * rule backstops — unlike a delete that OOMs the process.
 */
const MAX_DELETED_OBJECTS = 5000;

/** Concurrent bucket deletes: quick, but far short of self-inflicted throttling. */
const DELETE_CONCURRENCY = 8;

/**
 * Storage keys for every attachment under a channel, read *before* the delete.
 *
 * `message_attachments.channel_id` is ON DELETE CASCADE, so the cascade
 * destroys the only rows that name these objects, and the sweeper cannot help:
 * its predicate is `message_id IS NULL`, which can never match a row that no
 * longer exists. Read them afterwards and nothing in Postgres names the bytes
 * ever again.
 */
async function channelAttachmentKeys(channelId: string): Promise<string[]> {
  if (!isStorageConfigured()) {
    return [];
  }
  const result = await getPool().query<{ storage_key: string }>(
    `SELECT storage_key FROM message_attachments
     WHERE channel_id = $1
     LIMIT ${MAX_DELETED_OBJECTS}`,
    [channelId],
  );
  return result.rows.map((row) => row.storage_key);
}

/** Same read as `channelAttachmentKeys`, reached through the server's channels. */
async function serverAttachmentKeys(serverId: string): Promise<string[]> {
  if (!isStorageConfigured()) {
    return [];
  }
  const result = await getPool().query<{ storage_key: string }>(
    `SELECT a.storage_key
     FROM message_attachments a
     JOIN channels c ON c.id = a.channel_id
     WHERE c.server_id = $1
     LIMIT ${MAX_DELETED_OBJECTS}`,
    [serverId],
  );
  return result.rows.map((row) => row.storage_key);
}

/**
 * The server's own icon and banner objects, if it uploaded either.
 *
 * Separate from `serverAttachmentKeys` because they hang off the `servers` row
 * itself rather than off a message, and because a server with no pictures — the
 * common case — should cost nothing beyond the one row read the query already
 * needs.
 */
async function serverImageKeys(serverId: string): Promise<string[]> {
  if (!isStorageConfigured()) {
    return [];
  }
  const result = await getPool().query<{
    icon_key: string | null;
    banner_key: string | null;
  }>(`SELECT icon_key, banner_key FROM servers WHERE id = $1`, [serverId]);
  const row = result.rows[0];
  return [row?.icon_key, row?.banner_key].filter(
    (key): key is string => typeof key === "string" && key.length > 0,
  );
}

/**
 * Drop the objects a completed delete just orphaned, best effort.
 *
 * Neither awaited nor allowed to fail, matching `deleteMessage`: the row that
 * referenced each object is already gone, so nothing here can be retried and
 * nothing depends on the outcome. Blocking on it would put one bucket round
 * trip per attachment in front of the response and let an unreachable bucket
 * fail a delete that has already committed. Batched rather than fired at once
 * because a busy channel holds thousands of these and a store answers a
 * thousand simultaneous DELETEs with rate limiting.
 */
export function deleteObjectsInBackground(keys: string[]): void {
  if (keys.length === 0) {
    return;
  }
  void (async () => {
    for (let start = 0; start < keys.length; start += DELETE_CONCURRENCY) {
      await Promise.all(
        keys.slice(start, start + DELETE_CONCURRENCY).map((key) =>
          deleteObject(key).catch((error: unknown) => {
            // Logged because this is the last mention of the key anywhere: the
            // row naming it is gone, so a lost object is only ever recoverable
            // by diffing the bucket against the table by hand.
            console.error(
              `[attachments] leaked object ${key}:`,
              error instanceof Error ? error.message : error,
            );
          }),
        ),
      );
    }
  })();
}

export async function listServersForUser(userId: string): Promise<DbServer[]> {
  const result = await getPool().query<DbServer>(
    `SELECT ${SERVER_COLUMNS.split(", ")
      .map((c) => `s.${c}`)
      .join(", ")}, sm.show_on_profile, sm.role
     FROM servers s
     JOIN server_members sm ON sm.server_id = s.id
     WHERE sm.user_id = $1
     ORDER BY s.created_at ASC`,
    [userId],
  );
  return result.rows;
}

export async function createServer(
  name: string,
  ownerId: string,
): Promise<{ server: DbServer; channels: ChannelRow[] }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const serverResult = await client.query<DbServer>(
      `INSERT INTO servers (name, owner_id) VALUES ($1, $2)
       RETURNING ${SERVER_COLUMNS}`,
      [name, ownerId],
    );
    const server = serverResult.rows[0]!;

    await client.query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [server.id, ownerId],
    );

    await seedDefaultRoles(client, server.id);

    const channelsResult = await client.query<ChannelRow>(
      `INSERT INTO channels (server_id, name, type, position, is_private) VALUES
         ($1, 'general', 'text', 0, FALSE),
         ($1, 'Lobby', 'voice', 1, FALSE)
       RETURNING ${CHANNEL_COLUMNS}`,
      [server.id],
    );

    await client.query("COMMIT");
    return { server, channels: channelsResult.rows };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listChannels(
  serverId: string,
  userId: string,
): Promise<ChannelRow[]> {
  const result = await getPool().query<ChannelRow>(
    `SELECT c.id, c.server_id, c.name, c.type, c.position, c.is_private, c.kind,
            c.topic, c.image_url, c.parent_id, c.slowmode_seconds, c.voice_transport
     FROM channels c
     JOIN server_members sm ON sm.server_id = c.server_id
     WHERE c.server_id = $1 AND sm.user_id = $2
       AND c.type <> 'thread'
       AND ${channelVisibleSql("$2")}
     ORDER BY c.position ASC`,
    [serverId, userId],
  );
  return result.rows;
}

export async function createChannel(
  serverId: string,
  name: string,
  type: "text" | "voice" | "category",
  isPrivate = false,
): Promise<ChannelRow> {
  // Top-level text, top-level voice, and categories are three separate
  // sibling groups sharing the `parent_id IS NULL` scope — the client renders
  // them as three separate lists rather than one interleaved one, so `type`
  // has to be part of the group key here or a new voice channel could land
  // between two text channels' positions for no visible reason. A channel
  // moved into a real category leaves this scope entirely; that group mixes
  // types together, matching how the sidebar nests them under one heading.
  const positionResult = await getPool().query<{ max: number | null }>(
    `SELECT MAX(position) as max FROM channels
     WHERE server_id = $1 AND parent_id IS NULL AND type = $2`,
    [serverId, type],
  );
  const position = (positionResult.rows[0]?.max ?? -1) + 1;

  const result = await getPool().query<ChannelRow>(
    `INSERT INTO channels (server_id, name, type, position, is_private)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${CHANNEL_COLUMNS}`,
    [serverId, name, type, position, isPrivate],
  );
  const channel = result.rows[0]!;
  if (isPrivate) {
    await applyPrivateChannelOverwrites(
      getPool(),
      channel.id,
      serverId,
      true,
    );
    await bumpPermissionsVersion(serverId);
  }
  return channel;
}

export class InvalidChannelMoveError extends Error {}

/**
 * Move a channel to a 0-based position among the siblings sharing
 * `parentId`, renumbering both the destination group and — if the channel is
 * changing groups — the group it left, so both stay a contiguous 0..n-1
 * sequence. Small, low-frequency, admin-only: a handful of individual
 * UPDATEs inside one transaction is simpler than hand-rolled batch SQL and
 * costs nothing measurable for a sidebar-sized channel list.
 *
 * Returns null when `channelId` does not belong to `serverId` at all, so the
 * route can answer 404 without confirming a channel id exists elsewhere.
 * Throws `InvalidChannelMoveError` for a move that names a real channel but
 * breaks an invariant — the two are different failures with different
 * status codes, and only the caller knows which one 404 would leak.
 */
export async function moveChannel(
  serverId: string,
  channelId: string,
  parentId: string | null,
  index: number,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const target = await client.query<{ type: string; parent_id: string | null }>(
      `SELECT type, parent_id FROM channels WHERE id = $1 AND server_id = $2 FOR UPDATE`,
      [channelId, serverId],
    );
    const row = target.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return;
    }

    // --- threads --- a thread lives on its origin message, not in the
    // sidebar; "moving" one has no meaning and would corrupt the parent
    // pointer the visibility predicate reads.
    if (row.type === "thread") {
      await client.query("ROLLBACK");
      throw new InvalidChannelMoveError("A thread cannot be moved");
    }

    if (parentId !== null) {
      if (parentId === channelId) {
        await client.query("ROLLBACK");
        throw new InvalidChannelMoveError("A channel cannot contain itself");
      }
      if (row.type === "category") {
        await client.query("ROLLBACK");
        throw new InvalidChannelMoveError(
          "A category cannot be nested under another category",
        );
      }
      const parent = await client.query<{ type: string }>(
        `SELECT type FROM channels WHERE id = $1 AND server_id = $2`,
        [parentId, serverId],
      );
      if (!parent.rows[0] || parent.rows[0].type !== "category") {
        await client.query("ROLLBACK");
        throw new InvalidChannelMoveError(
          "Not a category in this server",
        );
      }
    }

    const oldParentId = row.parent_id;

    // The destination group, in order, with the moved channel spliced in —
    // every existing member of this group already has parent_id = parentId,
    // so writing it for the whole list is correct for them too, not just for
    // the one that is actually moving.
    //
    // Top-level (parentId null) additionally scopes by the moved channel's own
    // type: text, voice and categories are three separate lists in the
    // sidebar, not one interleaved one, so "top-level" alone is not a single
    // sibling group there the way it is inside a real category, which mixes
    // types together under one heading.
    const destination = await client.query<{ id: string }>(
      `SELECT id FROM channels
       WHERE server_id = $1 AND id <> $2 AND parent_id IS NOT DISTINCT FROM $3
         AND ($3 IS NOT NULL OR type = $4)
       ORDER BY position ASC`,
      [serverId, channelId, parentId, row.type],
    );
    const destIds = destination.rows.map((r) => r.id);
    const clampedIndex = Math.max(0, Math.min(index, destIds.length));
    destIds.splice(clampedIndex, 0, channelId);

    for (let i = 0; i < destIds.length; i++) {
      await client.query(
        `UPDATE channels SET position = $1, parent_id = $2 WHERE id = $3`,
        [i, parentId, destIds[i]],
      );
    }

    // Only the group being LEFT needs closing up — a same-group reorder
    // already renumbered it above as the destination group.
    const changedGroup =
      oldParentId !== parentId && !(oldParentId === null && parentId === null);
    if (changedGroup) {
      const vacated = await client.query<{ id: string }>(
        `SELECT id FROM channels
         WHERE server_id = $1 AND id <> $2 AND parent_id IS NOT DISTINCT FROM $3
           AND ($3 IS NOT NULL OR type = $4)
         ORDER BY position ASC`,
        [serverId, channelId, oldParentId, row.type],
      );
      for (let i = 0; i < vacated.rows.length; i++) {
        await client.query(`UPDATE channels SET position = $1 WHERE id = $2`, [
          i,
          vacated.rows[i]!.id,
        ]);
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function updateChannel(
  channelId: string,
  updates: {
    name?: string;
    isPrivate?: boolean;
    topic?: string | null;
    imageUrl?: string | null;
    slowmodeSeconds?: number;
    voiceTransport?: VoiceRoomTransport | null;
  },
): Promise<ChannelRow | null> {
  const result = await getPool().query<ChannelRow>(
    `UPDATE channels SET
       name = COALESCE($2, name),
       is_private = COALESCE($3, is_private),
       topic = CASE WHEN $4::boolean THEN $5 ELSE topic END,
       image_url = CASE WHEN $6::boolean THEN $7 ELSE image_url END,
       slowmode_seconds = CASE WHEN $8::boolean THEN $9 ELSE slowmode_seconds END,
       voice_transport = CASE WHEN $10::boolean THEN $11 ELSE voice_transport END
     WHERE id = $1
     RETURNING ${CHANNEL_COLUMNS}`,
    [
      channelId,
      updates.name ?? null,
      updates.isPrivate ?? null,
      updates.topic !== undefined,
      updates.topic === "" ? null : (updates.topic ?? null),
      updates.imageUrl !== undefined,
      updates.imageUrl === "" ? null : (updates.imageUrl ?? null),
      updates.slowmodeSeconds !== undefined,
      updates.slowmodeSeconds ?? 0,
      updates.voiceTransport !== undefined,
      updates.voiceTransport ?? null,
    ],
  );
  const updated = result.rows[0] ?? null;
  if (updated && updates.isPrivate !== undefined && updated.server_id) {
    await applyPrivateChannelOverwrites(
      getPool(),
      updated.id,
      updated.server_id,
      updated.is_private,
    );
    if (updated.is_private) {
      const members = await getPool().query<{ user_id: string }>(
        `SELECT user_id FROM channel_members WHERE channel_id = $1`,
        [updated.id],
      );
      for (const member of members.rows) {
        await upsertMemberViewOverwrite(getPool(), updated.id, member.user_id);
      }
    }
    await bumpPermissionsVersion(updated.server_id);
  }
  // `is_private` is half of `channelVisibleSql`, so a rename and a
  // public→private flip arrive through the same call and only one of them is
  // safe to keep a cached audience through. Invalidating unconditionally is
  // one wasted query on a rename and the difference between correct and not on
  // the flip.
  invalidateChannelAudience(channelId);
  return updated;
}

export async function deleteChannel(channelId: string): Promise<boolean> {
  const keys = await channelAttachmentKeys(channelId);

  // --- threads ---
  // A text channel's threads die with it, explicitly. `parent_id` is ON DELETE
  // SET NULL (categories need that), so without this the threads would survive
  // as orphans: invisible to everyone (the visibility predicate fails closed on
  // a null parent) but still holding messages and attachment rows forever.
  // Their attachment keys are read here, before anything is deleted, for the
  // same reason `channelAttachmentKeys` runs first for the channel itself: the
  // cascade destroys the only rows that name the objects.
  const threadIds = (
    await getPool().query<{ id: string }>(
      `SELECT id FROM channels WHERE parent_id = $1 AND type = 'thread'`,
      [channelId],
    )
  ).rows.map((row) => row.id);
  const threadKeys = (
    await Promise.all(threadIds.map((id) => channelAttachmentKeys(id)))
  ).flat();

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // Before the orphan read below: with the threads already gone, the
    // category-uncategorising logic can never mistake a thread for a channel
    // that should be renumbered into a top-level sibling group.
    if (threadIds.length > 0) {
      await client.query(
        `DELETE FROM channels WHERE parent_id = $1 AND type = 'thread'`,
        [channelId],
      );
    }

    // Deleting a category SETs NULL the parent_id of whatever was inside it,
    // uncategorizing rather than deleting its children — but that only clears
    // parent_id. Their `position` values still belong to the category's own
    // sibling-group numbering, which routinely collides with positions
    // already in use by the top-level group of the same type they land back
    // in: a category's first child and the existing top-level channel at
    // position 0 would both read position 0 once uncategorized, and every
    // move computed against that group afterwards inherits the ambiguity.
    // Read the children (and the server they belong to) before the delete —
    // parent_id is still set, and a plain channel has none, so this is a
    // no-op read for the common case.
    const before = await client.query<{ server_id: string | null }>(
      `SELECT server_id FROM channels WHERE id = $1`,
      [channelId],
    );
    const serverId = before.rows[0]?.server_id ?? null;
    const orphaned = serverId
      ? await client.query<{ id: string; type: string }>(
          `SELECT id, type FROM channels WHERE parent_id = $1 ORDER BY position ASC`,
          [channelId],
        )
      : { rows: [] as Array<{ id: string; type: string }> };

    const result = await client.query(`DELETE FROM channels WHERE id = $1`, [
      channelId,
    ]);
    const deleted = (result.rowCount ?? 0) > 0;

    if (deleted && serverId && orphaned.rows.length > 0) {
      const newcomersByType = new Map<string, string[]>();
      for (const row of orphaned.rows) {
        const list = newcomersByType.get(row.type) ?? [];
        list.push(row.id);
        newcomersByType.set(row.type, list);
      }
      // One pass per type: the newcomers append, in the order they held
      // inside the category, after whatever top-level channels of that same
      // type already existed — the ordinary "join the back of the line"
      // outcome, and the only one that leaves every position in the group
      // unique afterwards.
      for (const [type, newcomers] of newcomersByType) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM channels
           WHERE server_id = $1 AND parent_id IS NULL AND type = $2
             AND id <> ALL($3::uuid[])
           ORDER BY position ASC`,
          [serverId, type, newcomers],
        );
        const ordered = [...existing.rows.map((r) => r.id), ...newcomers];
        for (let i = 0; i < ordered.length; i++) {
          await client.query(`UPDATE channels SET position = $1 WHERE id = $2`, [
            i,
            ordered[i],
          ]);
        }
      }
    }

    await client.query("COMMIT");

    // Only once the delete landed: a channel that was already gone, or that
    // some other request is still using, must not have its objects removed.
    if (deleted) {
      invalidateChannelAudience(channelId);
      // --- threads --- the child threads went in the same transaction.
      for (const threadId of threadIds) {
        invalidateChannelAudience(threadId);
      }
      deleteObjectsInBackground([...keys, ...threadKeys]);
    }
    return deleted;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteServer(serverId: string): Promise<boolean> {
  const keys = await serverAttachmentKeys(serverId);
  // The icon and banner ride along on the same list, and for the same reason
  // the attachments do: their only mention anywhere is a column on the row this
  // is about to delete, so read afterwards nothing in Postgres names the bytes
  // ever again.
  keys.push(...(await serverImageKeys(serverId)));

  // channels / members / invites / bans all cascade from servers — and so do
  // the attachment rows, which is why their keys are already in hand.
  const result = await getPool().query(`DELETE FROM servers WHERE id = $1`, [
    serverId,
  ]);
  const deleted = (result.rowCount ?? 0) > 0;

  if (deleted) {
    // The channels cascaded away, so every one of their cached audiences is
    // now an answer about a channel that does not exist.
    invalidateServerAudience(serverId);
    deleteObjectsInBackground(keys);
  }
  return deleted;
}

export async function renameServer(
  serverId: string,
  name: string,
): Promise<DbServer | null> {
  const result = await getPool().query<DbServer>(
    `UPDATE servers SET name = $2 WHERE id = $1
     RETURNING ${SERVER_COLUMNS}`,
    [serverId, name],
  );
  return result.rows[0] ?? null;
}

export async function getServer(serverId: string): Promise<DbServer | null> {
  const result = await getPool().query<DbServer>(
    `SELECT ${SERVER_COLUMNS} FROM servers WHERE id = $1`,
    [serverId],
  );
  return result.rows[0] ?? null;
}

export async function setCommunityHomeEnabled(
  serverId: string,
  enabled: boolean,
): Promise<DbServer> {
  const result = await getPool().query<DbServer>(
    `UPDATE servers SET community_home_enabled = $2 WHERE id = $1
     RETURNING ${SERVER_COLUMNS}`,
    [serverId, enabled],
  );
  const server = result.rows[0];
  if (!server) {
    throw new Error("Server not found");
  }
  return server;
}

/**
 * Null clears retention back to "keep forever." Server-wide, not per-channel
 * — see the schema comment on `message_retention_days` for why. The sweep
 * that actually deletes anything lives in `retention.ts`; this only ever
 * writes the setting.
 *
 * Returns the previous value alongside the row: the caller's audit entry is
 * only worth writing if both sides of the change are in it, and a plain
 * `UPDATE ... RETURNING` only ever hands back the new row.
 */
export async function updateMessageRetention(
  serverId: string,
  days: number | null,
): Promise<{ server: DbServer; previousDays: number | null } | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const before = await client.query<{ message_retention_days: number | null }>(
      `SELECT message_retention_days FROM servers WHERE id = $1 FOR UPDATE`,
      [serverId],
    );
    if (before.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const result = await client.query<DbServer>(
      `UPDATE servers SET message_retention_days = $2 WHERE id = $1
       RETURNING ${SERVER_COLUMNS}`,
      [serverId, days],
    );
    await client.query("COMMIT");
    return {
      server: result.rows[0]!,
      previousDays: before.rows[0]!.message_retention_days,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateSsoEmailDomain(
  serverId: string,
  domain: string | null,
): Promise<{ server: DbServer; previousDomain: string | null } | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const before = await client.query<{ sso_email_domain: string | null }>(
      `SELECT sso_email_domain FROM servers WHERE id = $1 FOR UPDATE`,
      [serverId],
    );
    if (before.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const result = await client.query<DbServer>(
      `UPDATE servers SET sso_email_domain = $2 WHERE id = $1
       RETURNING ${SERVER_COLUMNS}`,
      [serverId, domain],
    );
    await client.query("COMMIT");
    return {
      server: result.rows[0]!,
      previousDomain: before.rows[0]!.sso_email_domain,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Servers this user could join right now on the strength of a verified email
 * domain — excluding ones they are already in or banned from.
 *
 * The domain match happens in SQL against `users.email_domains`, read from the
 * row rather than taken from the caller, so a request cannot assert a domain it
 * has not proved.
 */
export async function listSsoJoinableServers(
  userId: string,
): Promise<DbServer[]> {
  const result = await getPool().query<DbServer>(
    `SELECT ${SERVER_COLUMNS.split(", ")
      .map((c) => `s.${c}`)
      .join(", ")}
     FROM servers s
     JOIN users u ON u.id = $1
     WHERE s.sso_email_domain IS NOT NULL
       AND s.sso_email_domain = ANY(u.email_domains)
       AND NOT EXISTS (
         SELECT 1 FROM server_members m
         WHERE m.server_id = s.id AND m.user_id = $1
       )
       AND NOT EXISTS (
         SELECT 1 FROM server_bans b
         WHERE b.server_id = s.id AND b.user_id = $1
       )
     ORDER BY s.name ASC`,
    [userId],
  );
  return result.rows;
}

export type SsoJoinResult =
  | { ok: true; server: DbServer; joinedNow: boolean }
  | { ok: false; reason: "not_found" | "domain_mismatch" | "banned" };

/**
 * Join a server by verified email domain, no invite required.
 *
 * Re-checks the domain inside the transaction against the stored `email_domains`
 * rather than trusting anything the caller sent, and holds the server row so a
 * concurrent "turn SSO off" cannot be raced by a join that already read it as on.
 */
export async function joinServerBySso(
  serverId: string,
  userId: string,
): Promise<SsoJoinResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const serverResult = await client.query<DbServer>(
      `SELECT ${SERVER_COLUMNS} FROM servers WHERE id = $1 FOR UPDATE`,
      [serverId],
    );
    const server = serverResult.rows[0];
    if (!server) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }

    const matched = await client.query(
      `SELECT 1 FROM users
       WHERE id = $1 AND $2::text = ANY(email_domains)`,
      [userId, server.sso_email_domain],
    );
    // Covers both "this server has SSO off" (NULL never equals ANY) and "your
    // verified domains do not include it". Reported as one reason on purpose:
    // distinguishing them would confirm a server exists to a stranger probing ids.
    if (!server.sso_email_domain || matched.rows.length === 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "domain_mismatch" };
    }

    const banned = await client.query(
      `SELECT 1 FROM server_bans WHERE server_id = $1 AND user_id = $2`,
      [serverId, userId],
    );
    if (banned.rows.length > 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "banned" };
    }

    const inserted = await client.query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING`,
      [serverId, userId],
    );

    await client.query("COMMIT");
    const joinedNow = (inserted.rowCount ?? 0) > 0;
    if (joinedNow) {
      // Widening, so the cost of missing it is a badge the new member does not
      // get for a few seconds rather than one they should not have. Done
      // anyway: "you joined and the server went quiet" is a bad first minute.
      invalidateServerAudience(serverId);
    }
    return { ok: true, server, joinedNow };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Hand the server to another member. Both role rows and `servers.owner_id` move
 * together or not at all — a half-applied transfer would leave a server with two
 * owners or none.
 */
export async function transferOwnership(
  serverId: string,
  currentOwnerId: string,
  nextOwnerId: string,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const target = await client.query(
      `SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2`,
      [serverId, nextOwnerId],
    );
    if (target.rows.length === 0) {
      throw new Error("New owner must already be a member of this server");
    }

    await client.query(
      `UPDATE servers SET owner_id = $2 WHERE id = $1 AND owner_id = $3`,
      [serverId, nextOwnerId, currentOwnerId],
    );
    await client.query(
      `UPDATE server_members SET role = 'admin'
       WHERE server_id = $1 AND user_id = $2`,
      [serverId, currentOwnerId],
    );
    await client.query(
      `UPDATE server_members SET role = 'owner'
       WHERE server_id = $1 AND user_id = $2`,
      [serverId, nextOwnerId],
    );

    await client.query("COMMIT");
    // Both roles here are inside `channelVisibleSql`'s privileged set, so this
    // transfer only ever widens. Invalidated regardless: a future change to
    // who counts as privileged must not have to remember this call site.
    invalidateServerAudience(serverId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface ChannelAudience {
  /** Null for a conversation, which belongs to no server. */
  serverId: string | null;
  kind: ChannelKind;
  /**
   * May this user see the channel? O(1), and the form every fan-out must use:
   * the alternative, `new Set(audience.userIds)`, rebuilds a set the size of
   * the whole server for each message and is what made a 20k-member server
   * cost 5x the CPU of a 200-member one at the same message rate.
   */
  has(userId: string): boolean;
  /**
   * The same answer as a list, for the handful of callers that genuinely need
   * every id (turning a channel private, tests). Materialised on each access
   * rather than stored, because this object is shared between calls — read it
   * once into a local if you need it twice.
   */
  readonly userIds: readonly string[];
}

/**
 * Every user who is allowed to see a channel. Used to decide who gets an unread
 * notification, and who sees a voice roster.
 *
 * Two branches because the two kinds draw their candidates from different
 * tables, not merely filter them differently: a server channel's candidates are
 * the server's members, and a conversation's are its participants. The first
 * branch is the set-returning form of `channelVisibleSql` and interpolates that
 * same fragment, so it cannot drift from `canAccessChannel`. The second is the
 * set-returning form of the conversation branch — `channel_members` and nothing
 * else, with no role that overrides it.
 *
 * `c.kind <> 'server'` on the second branch is what keeps a private server
 * channel from being answered twice, and more importantly keeps the second
 * branch from ever being the reason somebody can see a server channel: there,
 * `channel_members` is only meaningful in combination with server membership.
 */
async function readChannelAudience(
  channelId: string,
): Promise<{ audience: ChannelAudience; size: number } | null> {
  // Aggregated into one row rather than returned as one row per member.
  //
  // The predicate and the rows it admits are identical either way — the only
  // thing that changes is how they cross the wire, and on a 20,201-member
  // server that is not a detail: measured on this machine, 20k row objects
  // cost 144ms to fetch and turn into a Set, and the same ids as a single
  // `uuid[]` cost 65ms. Almost all of the difference is `pg` allocating twenty
  // thousand row objects. (`string_agg` plus a split measured 39ms and was
  // deliberately not taken: this is an access-control query, and a text
  // encoding that a future non-uuid id type could break silently is not worth
  // 26ms on a path that now runs once every few seconds.)
  //
  // GROUP BY yields no row at all for a channel that does not exist, which is
  // the same "no rows" the caller already treats as "no such channel".
  const result = await getPool().query<{
    server_id: string | null;
    kind: ChannelKind;
    user_ids: string[];
  }>(
    `SELECT server_id, kind, array_agg(user_id) AS user_ids
     FROM (
       SELECT c.server_id, c.kind, sm.user_id
       FROM channels c
       JOIN server_members sm ON sm.server_id = c.server_id
       WHERE c.id = $1
         AND ${channelVisibleSql("sm.user_id")}
       UNION
       SELECT c.server_id, c.kind, cm.user_id
       FROM channels c
       JOIN channel_members cm ON cm.channel_id = c.id
       WHERE c.id = $1 AND c.kind <> 'server'
     ) visible
     GROUP BY server_id, kind`,
    [channelId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }
  const userIds = new Set(row.user_ids);
  return {
    audience: {
      serverId: row.server_id,
      kind: row.kind,
      has: (userId) => userIds.has(userId),
      get userIds() {
        return [...userIds];
      },
    },
    size: userIds.size,
  };
}

// -------------------------------------------------- channel audience cache
//
// THIS IS AN ACCESS-CONTROL CACHE. A STALE ENTRY IS A PRIVACY BUG.
//
// What it gates, precisely, is the `channel-activity` fan-out in ws/chat.ts —
// the unread badge. Message *bodies* travel over `channelPresence`, which is
// live socket state that `evictChannelViewers` empties synchronously, so
// nothing here can leak the contents of a message. What a stale entry leaks is
// that a channel you were just removed from is active, and — via the `mention`
// flag — that somebody said your name in it. That is small but it is not
// nothing, and it is the whole reason the invalidation below is explicit
// rather than TTL-only.
//
// The strategy is belt AND braces, and both halves are load-bearing:
//
//   * EXPLICIT invalidation at the service function that performs each write,
//     never at the route. A route is a place a second route can be added
//     beside without anyone noticing the omission; `removeChannelMember` is
//     not. The complete set of writes that can change an audience, and where
//     each one invalidates:
//
//       server_members   invites.ts redeemInvite · joinServerBySso ·
//                        transferOwnership · users.ts updateMemberRole ·
//                        users.ts deleteMembership (leave + remove) ·
//                        moderation.ts removeMembership (kick) ·
//                        moderation.ts banMember (its own copy of the deletes)
//                          → invalidateServerAudience
//       channel_members  addChannelMember · removeChannelMember
//                          → invalidateChannelAudience
//       channels         updateChannel (is_private) · deleteChannel
//                          → invalidateChannelAudience
//       servers          deleteServer (cascades channels + members)
//                          → invalidateServerAudience
//
//     `createServer` and `createChannel` need nothing: an id nobody has asked
//     about yet cannot have a cached answer. The conversation writes in dms.ts
//     need nothing either, because conversations are not cached.
//
//   * A SHORT TTL underneath it. Explicit-only assumes the list above is
//     complete, and it provably is not: `deleteAccount` (services/account.ts)
//     removes memberships by cascading `DELETE FROM users`, and the periodic
//     `sweepPendingAccountDeletions` does the same on a timer. Neither goes
//     through any function here. The TTL is what bounds that class of miss —
//     including the ones nobody has thought of yet — to a few seconds.
//
// Conversations (`kind <> 'server'`) are deliberately NOT cached; see
// `getChannelAudience`.
//
// Multi-instance: invalidation is published on its own bus topic, so an
// instance that caches an audience drops it when a *different* instance
// processes the ban. See `subscribeToCluster(AUDIENCE_TOPIC, …)` below. With
// `CLUSTER_BUS` unset the publish is a single boolean read and the TTL is the
// only backstop there is — which is correct, because with no bus there is only
// one instance and its own writes all go through the functions above.

/**
 * How long a cached audience may keep answering.
 *
 * Short on purpose. The cache exists because one 20k-member server at 56
 * messages a second was on course to saturate a whole shared-cpu-1x with this
 * single query; at 3 seconds that is already 168 queries collapsed into 1, so
 * buying a longer window would widen the staleness hole for no measurable CPU.
 * Every extra second here is an extra second a banned user keeps receiving
 * badges on any path the explicit invalidation misses.
 */
const AUDIENCE_TTL_MS = 3_000;

/**
 * How much of the TTL is given up to jitter, and why there is jitter at all.
 *
 * Without it, every channel that went hot at the same moment — which on a busy
 * server is all of them, because that is what "busy" means — expires at the
 * same moment and re-reads in one burst. Measured with five hot channels on a
 * 20k-member server, the synchronised refresh moved message p99 from 98ms to
 * 291ms while *mean* CPU fell: the work had not grown, it had bunched into one
 * stall of the event loop every three seconds.
 *
 * Jitter is subtracted, never added, so "at most AUDIENCE_TTL_MS stale"
 * remains literally true and the privacy argument above does not acquire a
 * footnote.
 */
const AUDIENCE_JITTER_MS = 1_000;

/**
 * Bounds. The auth caches next door leaked precisely by being maps that only
 * ever grew, so this one is capped on both axes: entries, and total user ids
 * held across all of them (roughly 80 bytes each, so 250k ids is ~20MB).
 *
 * A single server larger than the id cap is still cached rather than refused —
 * it is one entry, it expires in seconds, and refusing it would make the only
 * channel that actually needs the cache the one channel that cannot have it.
 */
const MAX_CACHED_AUDIENCES = 1_000;
const MAX_CACHED_AUDIENCE_IDS = 250_000;

interface CachedAudience {
  audience: ChannelAudience;
  /** Ids held by this entry, kept so `cachedAudienceIds` can be decremented
   *  without materialising the list again on the way out. */
  size: number;
  expiresAt: number;
}

const audienceCache = new Map<string, CachedAudience>();
let cachedAudienceIds = 0;

/**
 * Bumped by every invalidation, checked by every read before it stores.
 *
 * The race it closes: a read starts, Postgres gives it a snapshot, a ban
 * commits and invalidates, and only then does the read return — with rows from
 * before the ban. Dropping the entry is not enough, because there was no entry
 * yet; the write has to be refused. A single global counter is deliberately
 * over-broad (an unrelated invalidation also discards an in-flight read) and
 * that is fine: the cost is one cache miss and invalidations are rare.
 */
let audienceEpoch = 0;

const AUDIENCE_TOPIC = "audience.invalidate";

function dropCachedAudience(channelId: string): void {
  const entry = audienceCache.get(channelId);
  if (!entry) {
    return;
  }
  cachedAudienceIds -= entry.size;
  audienceCache.delete(channelId);
}

/**
 * Forget one channel's audience. Call this from the service function that just
 * changed who can see the channel — `channel_members`, `is_private`, or the
 * channel's existence — *after* the write has committed.
 */
export function invalidateChannelAudience(channelId: string): void {
  invalidateChannelAudienceLocally(channelId);
  if (isBusEnabled()) {
    publishToCluster(AUDIENCE_TOPIC, { kind: "channel", channelId });
  }
}

/**
 * Forget every channel of one server. Call this whenever `server_members`
 * changes — a join, a leave, a kick, a ban, a role change, or the server going
 * away. A role change matters as much as a removal: `channelVisibleSql` lets
 * owners and admins into private channels without a `channel_members` row, so
 * a demotion to `member` silently narrows every private channel at once.
 */
export function invalidateServerAudience(serverId: string): void {
  invalidateServerAudienceLocally(serverId);
  if (isBusEnabled()) {
    publishToCluster(AUDIENCE_TOPIC, { kind: "server", serverId });
  }
}

function invalidateChannelAudienceLocally(channelId: string): void {
  audienceEpoch++;
  dropCachedAudience(channelId);
}

function invalidateServerAudienceLocally(serverId: string): void {
  audienceEpoch++;
  for (const [channelId, entry] of audienceCache) {
    if (entry.audience.serverId === serverId) {
      dropCachedAudience(channelId);
    }
  }
}

/** Drop expired entries. Called from the same 60s sweep as the auth caches. */
export function sweepChannelAudiences(now = Date.now()): void {
  for (const [channelId, entry] of audienceCache) {
    if (entry.expiresAt <= now) {
      dropCachedAudience(channelId);
    }
  }
}

/** Test seam, and the only correct answer to a raw `TRUNCATE`. */
export function clearChannelAudienceCache(): void {
  audienceEpoch++;
  audienceCache.clear();
  cachedAudienceIds = 0;
}

/** Test helper: what the cache is holding. */
export function channelAudienceCacheStats(): {
  entries: number;
  userIds: number;
} {
  return { entries: audienceCache.size, userIds: cachedAudienceIds };
}

function storeAudience(
  channelId: string,
  audience: ChannelAudience,
  size: number,
): void {
  dropCachedAudience(channelId);
  audienceCache.set(channelId, {
    audience,
    size,
    expiresAt:
      Date.now() + AUDIENCE_TTL_MS - Math.random() * AUDIENCE_JITTER_MS,
  });
  cachedAudienceIds += size;

  if (
    audienceCache.size <= MAX_CACHED_AUDIENCES &&
    cachedAudienceIds <= MAX_CACHED_AUDIENCE_IDS
  ) {
    return;
  }
  sweepChannelAudiences();
  // Still over: evict in insertion order, which with a uniform TTL is also
  // expiry order, and skip the entry that was just stored — the caller is
  // about to use it, and dropping it would leave the cache doing work for
  // nobody. Ending the loop still over budget is possible only when that one
  // entry is itself larger than the id cap, which is the documented case above.
  for (const oldest of audienceCache.keys()) {
    if (
      audienceCache.size <= MAX_CACHED_AUDIENCES &&
      cachedAudienceIds <= MAX_CACHED_AUDIENCE_IDS
    ) {
      break;
    }
    if (oldest !== channelId) {
      dropCachedAudience(oldest);
    }
  }
}

/**
 * Every user who is allowed to see a channel, cached for at most
 * `AUDIENCE_TTL_MS`.
 *
 * CONVERSATIONS ARE NOT CACHED, and that is a correctness decision rather than
 * an oversight. A conversation's audience is at most `DM_MAX_RECIPIENTS` rows
 * off an index, so there is nothing to win — and `restoreDmParticipants` runs
 * on the message path itself, re-adding a participant who had closed the
 * conversation immediately before `createMessage`. A cache there would be
 * invalidated as often as it was read, and getting that wrong means the first
 * message into a reopened DM reaches nobody, which is the exact failure the
 * comment on `restoreDmParticipants` exists to prevent.
 *
 * There is no in-flight coalescing. The point of a TTL cache on a hot channel
 * is that misses happen once per TTL, so the most a herd can cost is the
 * handful of messages that arrive inside one query's latency, once every three
 * seconds.
 */
export async function getChannelAudience(
  channelId: string,
): Promise<ChannelAudience | null> {
  const cached = audienceCache.get(channelId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.audience;
  }

  const epoch = audienceEpoch;
  const result = await readChannelAudience(channelId);
  if (!result) {
    return null;
  }
  if (result.audience.kind === "server" && audienceEpoch === epoch) {
    storeAudience(channelId, result.audience, result.size);
  }
  return result.audience;
}

/**
 * Invalidations from other instances. Local half only — publishing from here
 * would have two instances answering each other forever, and the origin check
 * in `bus.ts` is the other half of that guard.
 *
 * Frames are validated because a rolling deploy puts two builds on one bus. An
 * unrecognised frame is ignored rather than guessed at: guessing wrong in the
 * widening direction is a cache that keeps a removed member, which is the one
 * outcome this whole file exists to avoid.
 */
subscribeToCluster(AUDIENCE_TOPIC, (data) => {
  const frame =
    typeof data === "object" && data !== null
      ? (data as Record<string, unknown>)
      : null;
  if (frame?.kind === "channel" && typeof frame.channelId === "string") {
    invalidateChannelAudienceLocally(frame.channelId);
    return;
  }
  if (frame?.kind === "server" && typeof frame.serverId === "string") {
    invalidateServerAudienceLocally(frame.serverId);
  }
});

/** Channel ids belonging to a server — used to evict live WS state on removal. */
export async function listServerChannelIds(
  serverId: string,
): Promise<Set<string>> {
  const result = await getPool().query<{ id: string }>(
    `SELECT id FROM channels WHERE server_id = $1`,
    [serverId],
  );
  return new Set(result.rows.map((row) => row.id));
}

export async function getChannel(channelId: string): Promise<ChannelRow | null> {
  const result = await getPool().query<ChannelRow>(
    `SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = $1`,
    [channelId],
  );
  return result.rows[0] ?? null;
}

export async function addChannelMember(
  channelId: string,
  userId: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO channel_members (channel_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [channelId, userId],
  );
  await upsertMemberViewOverwrite(getPool(), channelId, userId);
  invalidateChannelAudience(channelId);
}

export async function removeChannelMember(
  channelId: string,
  userId: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
    [channelId, userId],
  );
  await deleteMemberViewOverwrite(getPool(), channelId, userId);
  // The narrowing case this cache is most likely to get wrong: on a private
  // channel this row *is* the access, and the route that calls it only evicts
  // live viewers, which a person who was never looking is not.
  invalidateChannelAudience(channelId);
}

export async function listChannelMembers(channelId: string) {
  const result = await getPool().query<{
    id: string;
    display_name: string;
    username: string | null;
    discriminator: string | null;
  }>(
    `SELECT u.id, u.display_name, u.username, u.discriminator
     FROM channel_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.channel_id = $1
     ORDER BY u.display_name`,
    [channelId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    username: row.username,
    discriminator: row.discriminator,
    tag: formatUserTag(row.username, row.discriminator),
  }));
}

export function mapChannel(c: ChannelRow) {
  return {
    id: c.id,
    serverId: c.server_id,
    kind: c.kind,
    name: c.name,
    type: c.type,
    position: c.position,
    isPrivate: c.is_private,
    topic: c.topic ?? null,
    imageUrl: c.image_url ?? null,
    parentId: c.parent_id ?? null,
    slowmodeSeconds: c.slowmode_seconds ?? 0,
    voiceTransport: c.voice_transport ?? null,
  };
}

/**
 * What the voice transport policy needs to know about a server: whether it is
 * a listed community and how many members it has. One query, one correlated
 * count over `server_members`' primary key (server_id, user_id), so it is an
 * index-only range scan even on the largest server. Read once per room pin,
 * never per join (ws/voice.ts caches the decision for the life of the pin).
 */
export async function getServerVoiceProfile(
  serverId: string,
): Promise<{ isCommunity: boolean; memberCount: number } | null> {
  const result = await getPool().query<{
    is_community: boolean;
    member_count: string;
  }>(
    `SELECT s.is_community,
            (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count
     FROM servers s
     WHERE s.id = $1`,
    [serverId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    isCommunity: row.is_community,
    memberCount: Number(row.member_count),
  };
}

export function mapServer(s: DbServer) {
  return {
    id: s.id,
    name: s.name,
    ownerId: s.owner_id,
    role: s.role as MemberRole | undefined,
    createdAt: s.created_at.toISOString(),
    messageRetentionDays: s.message_retention_days,
    ssoEmailDomain: s.sso_email_domain,
    // Root-relative when uploaded here (`/api/servers/:id/icon?v=…`); null for
    // the overwhelmingly common server that has set neither. Never the storage
    // key — see the note on `SERVER_COLUMNS`.
    iconUrl: s.icon_url ?? null,
    bannerUrl: s.banner_url ?? null,
    isCommunity: s.is_community ?? false,
    communityHomeEnabled: s.community_home_enabled ?? false,
    // Only `listServersForUser` joins a membership, so every other caller —
    // a create, a rename — has no row to read this from. TRUE is the column's
    // own default and the honest answer for a membership just created.
    showOnProfile: s.show_on_profile ?? true,
  };
}

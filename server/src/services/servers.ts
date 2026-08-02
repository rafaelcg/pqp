import { formatUserTag, type ChannelKind } from "@pqp/shared";
import { getPool, type DbChannel, type DbServer, type MemberRole } from "../db.js";
import { deleteObject, isStorageConfigured } from "../lib/s3.js";
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
const CHANNEL_COLUMNS = `id, server_id, name, type, position, is_private, kind, topic, image_url`;

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
function deleteObjectsInBackground(keys: string[]): void {
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
    `SELECT s.id, s.name, s.owner_id, s.created_at, sm.role
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
       RETURNING id, name, owner_id, created_at`,
      [name, ownerId],
    );
    const server = serverResult.rows[0]!;

    await client.query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [server.id, ownerId],
    );

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
            c.topic, c.image_url
     FROM channels c
     JOIN server_members sm ON sm.server_id = c.server_id
     WHERE c.server_id = $1 AND sm.user_id = $2
       AND ${channelVisibleSql("$2")}
     ORDER BY c.position ASC`,
    [serverId, userId],
  );
  return result.rows;
}

export async function createChannel(
  serverId: string,
  name: string,
  type: "text" | "voice",
  isPrivate = false,
): Promise<ChannelRow> {
  const positionResult = await getPool().query<{ max: number | null }>(
    `SELECT MAX(position) as max FROM channels WHERE server_id = $1`,
    [serverId],
  );
  const position = (positionResult.rows[0]?.max ?? -1) + 1;

  const result = await getPool().query<ChannelRow>(
    `INSERT INTO channels (server_id, name, type, position, is_private)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${CHANNEL_COLUMNS}`,
    [serverId, name, type, position, isPrivate],
  );
  return result.rows[0]!;
}

export async function updateChannel(
  channelId: string,
  updates: {
    name?: string;
    isPrivate?: boolean;
    topic?: string | null;
    imageUrl?: string | null;
  },
): Promise<ChannelRow | null> {
  const result = await getPool().query<ChannelRow>(
    `UPDATE channels SET
       name = COALESCE($2, name),
       is_private = COALESCE($3, is_private),
       topic = CASE WHEN $4::boolean THEN $5 ELSE topic END,
       image_url = CASE WHEN $6::boolean THEN $7 ELSE image_url END
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
    ],
  );
  return result.rows[0] ?? null;
}

export async function deleteChannel(channelId: string): Promise<boolean> {
  const keys = await channelAttachmentKeys(channelId);

  const result = await getPool().query(
    `DELETE FROM channels WHERE id = $1`,
    [channelId],
  );
  const deleted = (result.rowCount ?? 0) > 0;

  // Only once the delete landed: a channel that was already gone, or that some
  // other request is still using, must not have its objects removed.
  if (deleted) {
    deleteObjectsInBackground(keys);
  }
  return deleted;
}

export async function deleteServer(serverId: string): Promise<boolean> {
  const keys = await serverAttachmentKeys(serverId);

  // channels / members / invites / bans all cascade from servers — and so do
  // the attachment rows, which is why their keys are already in hand.
  const result = await getPool().query(`DELETE FROM servers WHERE id = $1`, [
    serverId,
  ]);
  const deleted = (result.rowCount ?? 0) > 0;

  if (deleted) {
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
     RETURNING id, name, owner_id, created_at`,
    [serverId, name],
  );
  return result.rows[0] ?? null;
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
  userIds: string[];
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
export async function getChannelAudience(
  channelId: string,
): Promise<ChannelAudience | null> {
  const result = await getPool().query<{
    server_id: string | null;
    kind: ChannelKind;
    user_id: string;
  }>(
    `SELECT c.server_id, c.kind, sm.user_id
     FROM channels c
     JOIN server_members sm ON sm.server_id = c.server_id
     WHERE c.id = $1
       AND ${channelVisibleSql("sm.user_id")}
     UNION
     SELECT c.server_id, c.kind, cm.user_id
     FROM channels c
     JOIN channel_members cm ON cm.channel_id = c.id
     WHERE c.id = $1 AND c.kind <> 'server'`,
    [channelId],
  );

  const first = result.rows[0];
  if (!first) {
    return null;
  }
  return {
    serverId: first.server_id,
    kind: first.kind,
    userIds: result.rows.map((row) => row.user_id),
  };
}

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
}

export async function removeChannelMember(
  channelId: string,
  userId: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
    [channelId, userId],
  );
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
  };
}

export function mapServer(s: DbServer) {
  return {
    id: s.id,
    name: s.name,
    ownerId: s.owner_id,
    role: s.role as MemberRole | undefined,
    createdAt: s.created_at.toISOString(),
  };
}

import { formatUserTag } from "@pqp/shared";
import { getPool, type DbChannel, type DbServer, type MemberRole } from "../db.js";

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
): Promise<{ server: DbServer; channels: DbChannel[] }> {
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

    const channelsResult = await client.query<DbChannel>(
      `INSERT INTO channels (server_id, name, type, position, is_private) VALUES
         ($1, 'general', 'text', 0, FALSE),
         ($1, 'Lobby', 'voice', 1, FALSE)
       RETURNING id, server_id, name, type, position, is_private`,
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
): Promise<DbChannel[]> {
  const result = await getPool().query<DbChannel>(
    `SELECT c.id, c.server_id, c.name, c.type, c.position, c.is_private
     FROM channels c
     JOIN server_members sm ON sm.server_id = c.server_id
     WHERE c.server_id = $1 AND sm.user_id = $2
       AND (
         c.is_private = FALSE
         OR sm.role IN ('owner', 'admin')
         OR EXISTS (
           SELECT 1 FROM channel_members cm
           WHERE cm.channel_id = c.id AND cm.user_id = $2
         )
       )
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
): Promise<DbChannel> {
  const positionResult = await getPool().query<{ max: number | null }>(
    `SELECT MAX(position) as max FROM channels WHERE server_id = $1`,
    [serverId],
  );
  const position = (positionResult.rows[0]?.max ?? -1) + 1;

  const result = await getPool().query<DbChannel>(
    `INSERT INTO channels (server_id, name, type, position, is_private)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, server_id, name, type, position, is_private`,
    [serverId, name, type, position, isPrivate],
  );
  return result.rows[0]!;
}

export async function updateChannel(
  channelId: string,
  updates: { name?: string; isPrivate?: boolean },
): Promise<DbChannel | null> {
  const result = await getPool().query<DbChannel>(
    `UPDATE channels SET
       name = COALESCE($2, name),
       is_private = COALESCE($3, is_private)
     WHERE id = $1
     RETURNING id, server_id, name, type, position, is_private`,
    [channelId, updates.name ?? null, updates.isPrivate ?? null],
  );
  return result.rows[0] ?? null;
}

export async function deleteChannel(channelId: string): Promise<boolean> {
  const result = await getPool().query(
    `DELETE FROM channels WHERE id = $1`,
    [channelId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getChannel(channelId: string): Promise<DbChannel | null> {
  const result = await getPool().query<DbChannel>(
    `SELECT id, server_id, name, type, position, is_private FROM channels WHERE id = $1`,
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

export function mapChannel(c: DbChannel) {
  return {
    id: c.id,
    serverId: c.server_id,
    name: c.name,
    type: c.type,
    position: c.position,
    isPrivate: c.is_private,
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

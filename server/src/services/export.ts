import { formatUserTag } from "@pqp/shared";
import { getPool } from "../db.js";
import { listServerMembers } from "./users.js";

/** A generous but bounded ceiling: a server this large exporting in one HTTP
 * response would risk timing out the request and holding tens of megabytes
 * in memory at once. `truncated` tells the caller when they hit it rather
 * than silently handing back a partial file that looks complete. */
const MAX_EXPORT_MESSAGES = 50_000;
const EXPORT_BATCH_SIZE = 1000;

export interface ExportChannel {
  id: string;
  name: string;
  type: "text" | "voice" | "category";
  isPrivate: boolean;
  topic: string | null;
  parentId: string | null;
}

export interface ExportAttachment {
  filename: string;
  contentType: string;
  byteSize: number;
  /**
   * Never a presigned URL — those expire in hours, and an export exists to
   * outlive the deployment that made it. `null` for a remote (GIF) attachment
   * this server never stored bytes for.
   */
  storageKey: string | null;
  remoteUrl: string | null;
}

export interface ExportMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  authorTag: string | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  replyToId: string | null;
  pinnedAt: string | null;
  attachments: ExportAttachment[];
}

export interface ExportMember {
  id: string;
  displayName: string;
  tag: string | null;
  role: "owner" | "admin" | "member";
}

export interface ServerExport {
  exportedAt: string;
  server: {
    id: string;
    name: string;
    ownerId: string;
    createdAt: string;
    messageRetentionDays: number | null;
  };
  channels: ExportChannel[];
  members: ExportMember[];
  messages: ExportMessage[];
  /** True when `MAX_EXPORT_MESSAGES` was reached — the file is a prefix of
   * the server's history, oldest first, not the whole thing. */
  truncated: boolean;
}

interface ExportServerRow {
  id: string;
  name: string;
  owner_id: string;
  created_at: Date;
  message_retention_days: number | null;
}

async function exportServerInfo(serverId: string): Promise<ExportServerRow | null> {
  const result = await getPool().query<ExportServerRow>(
    `SELECT id, name, owner_id, created_at, message_retention_days
     FROM servers WHERE id = $1`,
    [serverId],
  );
  return result.rows[0] ?? null;
}

async function exportChannels(serverId: string): Promise<ExportChannel[]> {
  const result = await getPool().query<{
    id: string;
    name: string;
    type: "text" | "voice" | "category";
    is_private: boolean;
    topic: string | null;
    parent_id: string | null;
  }>(
    `SELECT id, name, type, is_private, topic, parent_id
     FROM channels WHERE server_id = $1 ORDER BY type, position`,
    [serverId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    isPrivate: row.is_private,
    topic: row.topic,
    parentId: row.parent_id,
  }));
}

interface ExportMessageRow {
  id: string;
  channel_id: string;
  author_id: string;
  author_name: string;
  author_username: string | null;
  author_discriminator: string | null;
  body: string;
  created_at: Date;
  edited_at: Date | null;
  reply_to_id: string | null;
  pinned_at: Date | null;
}

/**
 * Every message across every channel in the server, oldest first, keyset
 * paginated on `(created_at, id)` — the same tie-break `listMessages` uses,
 * since `id` alone is a random UUID and carries no chronological order.
 */
async function exportMessages(
  serverId: string,
): Promise<{ messages: ExportMessage[]; truncated: boolean }> {
  const rows: ExportMessageRow[] = [];
  let cursor: { createdAt: Date; id: string } | null = null;

  while (rows.length < MAX_EXPORT_MESSAGES) {
    const remaining = MAX_EXPORT_MESSAGES - rows.length;
    const limit = Math.min(EXPORT_BATCH_SIZE, remaining);
    const params: unknown[] = [serverId];
    let cursorClause = "";
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      cursorClause = `AND (m.created_at, m.id) > ($2, $3)`;
    }
    params.push(limit);

    const result = await getPool().query<ExportMessageRow>(
      `SELECT m.id, m.channel_id, m.author_id, m.body, m.created_at, m.edited_at,
              m.reply_to_id, m.pinned_at,
              u.display_name AS author_name, u.username AS author_username,
              u.discriminator AS author_discriminator
       FROM messages m
       JOIN channels c ON c.id = m.channel_id
       JOIN users u ON u.id = m.author_id
       WHERE c.server_id = $1 ${cursorClause}
       ORDER BY m.created_at ASC, m.id ASC
       LIMIT $${params.length}`,
      params,
    );
    rows.push(...result.rows);
    if (result.rows.length < limit) {
      break;
    }
    const last = result.rows[result.rows.length - 1]!;
    cursor = { createdAt: last.created_at, id: last.id };
  }

  const truncated = rows.length >= MAX_EXPORT_MESSAGES;

  const attachmentsByMessage = await exportAttachments(rows.map((row) => row.id));

  return {
    truncated,
    messages: rows.map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      authorId: row.author_id,
      authorName: row.author_name,
      authorTag: formatUserTag(row.author_username, row.author_discriminator),
      body: row.body,
      createdAt: row.created_at.toISOString(),
      editedAt: row.edited_at?.toISOString() ?? null,
      replyToId: row.reply_to_id,
      pinnedAt: row.pinned_at?.toISOString() ?? null,
      attachments: attachmentsByMessage.get(row.id) ?? [],
    })),
  };
}

async function exportAttachments(
  messageIds: string[],
): Promise<Map<string, ExportAttachment[]>> {
  const byMessage = new Map<string, ExportAttachment[]>();
  if (messageIds.length === 0) {
    return byMessage;
  }
  const result = await getPool().query<{
    message_id: string;
    filename: string;
    content_type: string;
    // BIGINT — node-postgres returns it as a string to avoid the precision
    // loss a JS number would risk above 2^53; see `toPublicAttachment` for
    // the same conversion on the read path this mirrors.
    byte_size: string;
    storage_key: string | null;
    remote_url: string | null;
  }>(
    `SELECT message_id, filename, content_type, byte_size, storage_key, remote_url
     FROM message_attachments
     WHERE message_id = ANY($1::uuid[])
     ORDER BY position ASC, created_at ASC`,
    [messageIds],
  );
  for (const row of result.rows) {
    const list = byMessage.get(row.message_id) ?? [];
    list.push({
      filename: row.filename,
      contentType: row.content_type,
      byteSize: Number(row.byte_size),
      storageKey: row.storage_key,
      remoteUrl: row.remote_url,
    });
    byMessage.set(row.message_id, list);
  }
  return byMessage;
}

export async function buildServerExport(
  serverId: string,
): Promise<ServerExport | null> {
  const server = await exportServerInfo(serverId);
  if (!server) {
    return null;
  }

  const [channels, members, exported] = await Promise.all([
    exportChannels(serverId),
    listServerMembers(serverId),
    exportMessages(serverId),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    server: {
      id: server.id,
      name: server.name,
      ownerId: server.owner_id,
      createdAt: server.created_at.toISOString(),
      messageRetentionDays: server.message_retention_days,
    },
    channels,
    members: members.map((member) => ({
      id: member.id,
      displayName: member.displayName,
      tag: member.tag,
      role: member.role,
    })),
    messages: exported.messages,
    truncated: exported.truncated,
  };
}

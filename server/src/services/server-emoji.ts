import { createHash, randomUUID } from "node:crypto";
import {
  MAX_SERVER_EMOJI_BYTES,
  SERVER_EMOJI_DEFAULT_LIMIT,
  serverEmojiPath,
  type ServerEmoji,
  type ServerEmojiContentType,
} from "@pqp/shared";
import { getPool } from "../db.js";
import type { ScanResult } from "./content-scan.js";
import {
  copyObject,
  deleteObject,
  headObject,
  isStorageConfigured,
  presignGet,
  presignPut,
} from "../lib/s3.js";

/**
 * Custom server emoji.
 *
 * Storage is the server-icon contract (`server-images.ts`) with a row per
 * object: same bucket, same presign-then-HEAD claim, and the same caveat that
 * the key prefix only proves "this object belongs to the server in the URL".
 * The route proves the caller holds Manage Server there; this file cannot.
 */

const UPLOAD_URL_TTL_SECONDS = 15 * 60;
const READ_URL_TTL_SECONDS = 60 * 60;

const EXTENSION_BY_CONTENT_TYPE: Record<ServerEmojiContentType, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export class ServerEmojiError extends Error {
  constructor(
    readonly code: "name_taken" | "limit_reached" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

interface ServerEmojiRow {
  id: string;
  server_id: string;
  name: string;
  storage_key: string;
  created_by: string | null;
  created_at: Date;
}

/**
 * How many emoji this server may hold.
 *
 * Every limit check and the list response go through here, so a per-server
 * limit is a change to this function alone.
 */
export async function serverEmojiLimit(_serverId: string): Promise<number> {
  return SERVER_EMOJI_DEFAULT_LIMIT;
}

export function isServerEmojiUploadConfigured(): boolean {
  return isStorageConfigured();
}

function emojiPrefix(serverId: string): string {
  return `servers/${serverId}/emoji/`;
}

export function serverEmojiObjectKey(
  serverId: string,
  contentType: ServerEmojiContentType,
): string {
  return `${emojiPrefix(serverId)}${randomUUID()}${EXTENSION_BY_CONTENT_TYPE[contentType]}`;
}

/** Same rule as `isServerImageKey`: right prefix, no `..`, something after it. */
export function isServerEmojiKey(serverId: string, key: string): boolean {
  const prefix = emojiPrefix(serverId);
  return key.startsWith(prefix) && !key.includes("..") && key.length > prefix.length;
}

function pinnedEmojiPrefix(serverId: string): string {
  return `${emojiPrefix(serverId)}pinned/`;
}

/**
 * A key a claim may name: one a mint could have signed. A `pinned/` key is
 * only ever written by this process, so a client naming one is pointing at
 * bytes somebody else's claim judged.
 */
export function isServerEmojiUploadKey(serverId: string, key: string): boolean {
  return isServerEmojiKey(serverId, key) && !key.startsWith(pinnedEmojiPrefix(serverId));
}

/**
 * Copy an upload to a key nobody holds a PUT URL for, so the bytes the scanner
 * judges are the bytes every message serves. The mint's PUT URL stays valid
 * for 15 minutes and a PUT overwrites, which is why Baú does the same
 * (`pinCommunityHomeUpload`). Null when the copy failed; the original is the
 * caller's to discard.
 */
export async function pinServerEmojiUpload(
  serverId: string,
  sourceKey: string,
): Promise<string | null> {
  const extension = /\.[a-z0-9]+$/i.exec(sourceKey)?.[0] ?? "";
  const pinnedKey = `${pinnedEmojiPrefix(serverId)}${randomUUID()}${extension}`;
  try {
    await copyObject(sourceKey, pinnedKey);
    return pinnedKey;
  } catch (error) {
    console.error(
      `[server-emoji] could not pin ${sourceKey}:`,
      error instanceof Error ? error.message : error,
    );
    // A copy can land and still answer with an error; nothing names the key.
    scheduleDiscardServerEmojiObject(pinnedKey);
    return null;
  }
}

export function serverEmojiUrlForKey(emojiId: string, key: string): string {
  return serverEmojiPath(
    emojiId,
    createHash("sha256").update(key).digest("hex").slice(0, 8),
  );
}

function mapRow(row: ServerEmojiRow): ServerEmoji {
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    url: serverEmojiUrlForKey(row.id, row.storage_key),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

const COLUMNS = "id, server_id, name, storage_key, created_by, created_at";

export async function listServerEmoji(serverId: string): Promise<ServerEmoji[]> {
  const result = await getPool().query<ServerEmojiRow>(
    `SELECT ${COLUMNS} FROM server_emoji WHERE server_id = $1 ORDER BY name`,
    [serverId],
  );
  return result.rows.map(mapRow);
}

/**
 * The checks a mint runs before signing anything, so somebody picking a file
 * hears "that name is taken" or "the server is full" before the upload, not
 * after it. The claim runs them again, under a lock, because they can change in
 * between.
 */
export async function assertServerEmojiCanBeAdded(
  serverId: string,
  name: string,
): Promise<void> {
  const result = await getPool().query<{ total: number; taken: boolean }>(
    `SELECT COUNT(*)::int AS total, COALESCE(BOOL_OR(name = $2), FALSE) AS taken
       FROM server_emoji WHERE server_id = $1`,
    [serverId, name],
  );
  const row = result.rows[0]!;
  if (row.taken) {
    throw new ServerEmojiError("name_taken", "That name is already in use on this server.");
  }
  if (row.total >= (await serverEmojiLimit(serverId))) {
    throw new ServerEmojiError("limit_reached", "This server has no room for more emoji.");
  }
}

export function createServerEmojiUpload(input: {
  serverId: string;
  contentType: ServerEmojiContentType;
  byteSize: number;
}): { key: string; uploadUrl: string; expiresAt: string } {
  const key = serverEmojiObjectKey(input.serverId, input.contentType);
  return {
    key,
    uploadUrl: presignPut(key, input.contentType, input.byteSize, UPLOAD_URL_TTL_SECONDS),
    expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
  };
}

/**
 * HEAD the uploaded object. Null for anything that cannot be trusted: wrong
 * prefix, never uploaded, empty, over the cap, or stored as another type than
 * the one the key's extension was chosen for.
 */
export async function verifyServerEmojiObject(
  serverId: string,
  key: string,
): Promise<{ byteSize: number; contentType: ServerEmojiContentType } | null> {
  if (!isStorageConfigured() || !isServerEmojiKey(serverId, key)) {
    return null;
  }
  let head;
  try {
    head = await headObject(key);
  } catch (error) {
    console.error(
      `[server-emoji] HEAD failed for ${key}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
  if (!head || head.contentLength <= 0 || head.contentLength > MAX_SERVER_EMOJI_BYTES) {
    return null;
  }
  const expected = Object.entries(EXTENSION_BY_CONTENT_TYPE).find(([, suffix]) =>
    key.endsWith(suffix),
  )?.[0] as ServerEmojiContentType | undefined;
  if (!expected || head.contentType !== expected) {
    return null;
  }
  return { byteSize: head.contentLength, contentType: expected };
}

/**
 * Insert the row. The server row is locked first so two claims racing for the
 * last slot cannot both see room; the unique index settles a name race.
 */
export async function insertServerEmoji(input: {
  serverId: string;
  name: string;
  key: string;
  createdBy: string;
  scan: ScanResult;
}): Promise<ServerEmoji> {
  const limit = await serverEmojiLimit(input.serverId);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      "SELECT id FROM servers WHERE id = $1 FOR UPDATE",
      [input.serverId],
    );
    if (locked.rows.length === 0) {
      await client.query("ROLLBACK");
      throw new ServerEmojiError("not_found", "Server not found");
    }
    const count = await client.query<{ total: number }>(
      "SELECT COUNT(*)::int AS total FROM server_emoji WHERE server_id = $1",
      [input.serverId],
    );
    if (count.rows[0]!.total >= limit) {
      await client.query("ROLLBACK");
      throw new ServerEmojiError("limit_reached", "This server has no room for more emoji.");
    }
    const inserted = await client.query<ServerEmojiRow>(
      `INSERT INTO server_emoji
         (server_id, name, storage_key, created_by,
          scan_status, scan_provider, scan_score, scan_labels, scanned_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb,
               CASE WHEN $5 = 'unscanned' THEN NULL ELSE NOW() END)
       ON CONFLICT (server_id, name) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        input.serverId,
        input.name,
        input.key,
        input.createdBy,
        input.scan.status,
        input.scan.provider,
        input.scan.score,
        input.scan.status === "unscanned" ? null : JSON.stringify(input.scan.labels),
      ],
    );
    if (inserted.rows.length === 0) {
      await client.query("ROLLBACK");
      throw new ServerEmojiError("name_taken", "That name is already in use on this server.");
    }
    await client.query("COMMIT");
    return mapRow(inserted.rows[0]!);
  } catch (error) {
    if (!(error instanceof ServerEmojiError)) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function renameServerEmoji(
  serverId: string,
  emojiId: string,
  name: string,
): Promise<{ emoji: ServerEmoji; previousName: string }> {
  let result;
  try {
    result = await getPool().query<ServerEmojiRow & { previous_name: string }>(
      `UPDATE server_emoji e SET name = $3
         FROM (SELECT id, name AS previous_name FROM server_emoji
                WHERE id = $2 AND server_id = $1) before
        WHERE e.id = before.id
        RETURNING e.id, e.server_id, e.name, e.storage_key, e.created_by,
                  e.created_at, before.previous_name`,
      [serverId, emojiId, name],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ServerEmojiError("name_taken", "That name is already in use on this server.");
    }
    throw error;
  }
  const row = result.rows[0];
  if (!row) {
    throw new ServerEmojiError("not_found", "Emoji not found");
  }
  return { emoji: mapRow(row), previousName: row.previous_name };
}

export async function deleteServerEmoji(
  serverId: string,
  emojiId: string,
): Promise<{ name: string; key: string }> {
  const result = await getPool().query<{ name: string; storage_key: string }>(
    `DELETE FROM server_emoji WHERE id = $2 AND server_id = $1
     RETURNING name, storage_key`,
    [serverId, emojiId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ServerEmojiError("not_found", "Emoji not found");
  }
  return { name: row.name, key: row.storage_key };
}

/** Best effort with one retry: an unreferenced object costs storage, nothing more. */
export function scheduleDiscardServerEmojiObject(key: string): void {
  void (async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!isStorageConfigured()) {
        return;
      }
      try {
        await deleteObject(key);
        return;
      } catch (error) {
        console.error(
          `[server-emoji] could not delete ${key}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  })();
}

/** Presigned read for the unauthenticated image route. Null is a 404. */
export async function presignServerEmojiRead(emojiId: string): Promise<string | null> {
  if (!isStorageConfigured()) {
    return null;
  }
  const result = await getPool().query<{ storage_key: string }>(
    "SELECT storage_key FROM server_emoji WHERE id = $1",
    [emojiId],
  );
  const key = result.rows[0]?.storage_key;
  return key ? presignGet(key, { ttlSeconds: READ_URL_TTL_SECONDS }) : null;
}

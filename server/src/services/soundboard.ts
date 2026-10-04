import { randomUUID } from "node:crypto";
import {
  audioDurationMs,
  soundboardBuiltin,
  soundboardClipRejection,
  SOUNDBOARD_MAX_BYTES,
  SOUNDBOARD_MAX_DURATION_MS,
  SOUNDBOARD_MAX_SOUNDS,
  type SoundboardContentType,
  type SoundboardSound,
} from "@pqp/shared";
import { getPool } from "../db.js";
import {
  deleteObject,
  getObjectPrefix,
  headObject,
  isStorageConfigured,
  presignGet,
  presignPut,
} from "../lib/s3.js";

const UPLOAD_URL_TTL_SECONDS = 15 * 60;
const READ_URL_TTL_SECONDS = 60 * 60;

const EXTENSION: Record<SoundboardContentType, string> = {
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
};

export type SoundboardUploadError =
  | "storage"
  | "slots"
  | "too_big"
  | "too_long"
  | "unreadable"
  | "type"
  | "missing";

export class SoundboardError extends Error {
  constructor(readonly code: SoundboardUploadError) {
    super(code);
    this.name = "SoundboardError";
  }
}

interface SoundRow {
  id: string;
  server_id: string;
  name: string;
  emoji: string;
  storage_key: string;
  content_type: string;
  bytes: number;
  duration_ms: number;
  volume: number;
}

export interface PlayableSound {
  id: string;
  emoji: string;
  durationMs: number;
  volume: number;
}

function prefix(serverId: string): string {
  return `soundboard/${serverId}/`;
}

export function soundboardObjectKey(
  serverId: string,
  contentType: SoundboardContentType,
): string {
  return `${prefix(serverId)}${randomUUID()}${EXTENSION[contentType]}`;
}

export function isSoundboardKey(serverId: string, key: string): boolean {
  const root = prefix(serverId);
  return key.startsWith(root) && !key.includes("..") && key.length > root.length;
}

function toSound(row: SoundRow): SoundboardSound {
  let url: string | null = null;
  if (isStorageConfigured()) {
    try {
      url = presignGet(row.storage_key, { ttlSeconds: READ_URL_TTL_SECONDS });
    } catch {
      url = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    contentType: row.content_type as SoundboardContentType,
    byteSize: row.bytes,
    durationMs: row.duration_ms,
    volume: Number(row.volume),
    url,
  };
}

export async function listSoundboardSounds(
  serverId: string,
): Promise<SoundboardSound[]> {
  const result = await getPool().query<SoundRow>(
    `SELECT id, server_id, name, emoji, storage_key, content_type, bytes,
            duration_ms, volume
       FROM soundboard_sounds
      WHERE server_id = $1
      ORDER BY created_at ASC, id ASC`,
    [serverId],
  );
  return result.rows.map(toSound);
}

const playableCache = new Map<
  string,
  { serverId: string; sound: PlayableSound; at: number }
>();
const PLAYABLE_TTL_MS = 30_000;

function rememberPlayable(serverId: string, sound: PlayableSound): void {
  playableCache.set(sound.id, { serverId, sound, at: Date.now() });
}

function forgetPlayable(soundId: string): void {
  playableCache.delete(soundId);
}

/**
 * What a play is allowed to sound like. Built-ins never touch the database.
 * A custom id must belong to this server. Hits stay in memory for a short
 * while so a burst of plays does not query once per click.
 */
export async function resolvePlayableSound(
  serverId: string,
  soundId: string,
): Promise<PlayableSound | null> {
  const builtin = soundboardBuiltin(soundId);
  if (builtin) {
    return {
      id: builtin.id,
      emoji: builtin.emoji,
      durationMs: builtin.durationMs,
      volume: 1,
    };
  }
  const cached = playableCache.get(soundId);
  if (
    cached &&
    cached.serverId === serverId &&
    Date.now() - cached.at < PLAYABLE_TTL_MS
  ) {
    return cached.sound;
  }
  const result = await getPool().query<SoundRow>(
    `SELECT id, server_id, name, emoji, storage_key, content_type, bytes,
            duration_ms, volume
       FROM soundboard_sounds
      WHERE id = $1 AND server_id = $2`,
    [soundId, serverId],
  );
  const row = result.rows[0];
  if (!row) {
    playableCache.delete(soundId);
    return null;
  }
  const sound: PlayableSound = {
    id: row.id,
    emoji: row.emoji,
    durationMs: row.duration_ms,
    volume: Number(row.volume),
  };
  rememberPlayable(serverId, sound);
  return sound;
}

const pendingUploads = new Map<string, { serverId: string; expiresAt: number }>();

/**
 * Drop a signed upload that nobody claimed.
 *
 * The pending map lives on one API process. The claim often lands on the
 * other. Never delete an object a row already points at.
 */
async function dropUnclaimedObject(key: string): Promise<void> {
  const kept = await getPool().query(
    `SELECT 1 FROM soundboard_sounds WHERE storage_key = $1`,
    [key],
  );
  if ((kept.rowCount ?? 0) > 0) {
    pendingUploads.delete(key);
    return;
  }
  await deleteObject(key);
  pendingUploads.delete(key);
}

async function sweepPendingUploads(now: number): Promise<void> {
  const due = [...pendingUploads.entries()].filter(
    ([, row]) => row.expiresAt <= now,
  );
  for (const [key, row] of due) {
    try {
      await dropUnclaimedObject(key);
    } catch {
      pendingUploads.set(key, {
        serverId: row.serverId,
        expiresAt: now + 60_000,
      });
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

if (typeof setInterval === "function") {
  setInterval(() => {
    void sweepPendingUploads(Date.now());
  }, 60_000).unref?.();
}

function pendingUploadCount(serverId: string): number {
  let count = 0;
  for (const row of pendingUploads.values()) {
    if (row.serverId === serverId) {
      count += 1;
    }
  }
  return count;
}

export async function createSoundboardUpload(input: {
  serverId: string;
  contentType: SoundboardContentType;
  byteSize: number;
}): Promise<{ key: string; uploadUrl: string; expiresAt: string }> {
  if (!isStorageConfigured()) {
    throw new SoundboardError("storage");
  }
  if (input.byteSize <= 0 || input.byteSize > SOUNDBOARD_MAX_BYTES) {
    throw new SoundboardError("too_big");
  }
  const now = Date.now();
  await sweepPendingUploads(now);
  const count = await getPool().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM soundboard_sounds WHERE server_id = $1`,
    [input.serverId],
  );
  if (
    Number(count.rows[0]?.n ?? 0) + pendingUploadCount(input.serverId) >=
    SOUNDBOARD_MAX_SOUNDS
  ) {
    throw new SoundboardError("slots");
  }
  const key = soundboardObjectKey(input.serverId, input.contentType);
  const expiresAtMs = now + UPLOAD_URL_TTL_SECONDS * 1000;
  pendingUploads.set(key, { serverId: input.serverId, expiresAt: expiresAtMs });
  return {
    key,
    uploadUrl: presignPut(
      key,
      input.contentType,
      input.byteSize,
      UPLOAD_URL_TTL_SECONDS,
    ),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/**
 * Read the object, time it, and insert the row.
 *
 * The GET happens before the transaction. Nothing between BEGIN and COMMIT
 * touches the network. The server row is locked so two claims cannot both
 * pass a count of 23.
 */
export async function claimSoundboardSound(input: {
  serverId: string;
  userId: string;
  key: string;
  name: string;
  emoji: string;
  volume?: number;
}): Promise<SoundboardSound> {
  if (!isStorageConfigured()) {
    throw new SoundboardError("storage");
  }
  if (!isSoundboardKey(input.serverId, input.key)) {
    throw new SoundboardError("missing");
  }

  const head = await headObject(input.key);
  if (!head) {
    throw new SoundboardError("missing");
  }
  const contentType = head.contentType as SoundboardContentType;
  if (contentType !== "audio/mpeg" && contentType !== "audio/ogg") {
    throw new SoundboardError("type");
  }
  const bytes = await getObjectPrefix(input.key, SOUNDBOARD_MAX_BYTES);
  if (!bytes) {
    throw new SoundboardError("missing");
  }
  const durationMs = audioDurationMs(bytes, contentType);
  const rejection = soundboardClipRejection(
    head.contentLength,
    durationMs,
    SOUNDBOARD_MAX_BYTES,
    SOUNDBOARD_MAX_DURATION_MS,
  );
  if (rejection) {
    await dropUnclaimedObject(input.key).catch(() => undefined);
    throw new SoundboardError(rejection);
  }

  const volume = input.volume ?? 1;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT id FROM servers WHERE id = $1 FOR UPDATE`, [
      input.serverId,
    ]);
    const count = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM soundboard_sounds WHERE server_id = $1`,
      [input.serverId],
    );
    if (Number(count.rows[0]?.n ?? 0) >= SOUNDBOARD_MAX_SOUNDS) {
      await client.query("ROLLBACK");
      await dropUnclaimedObject(input.key).catch(() => undefined);
      throw new SoundboardError("slots");
    }
    const inserted = await client.query<SoundRow>(
      `INSERT INTO soundboard_sounds (
         server_id, name, emoji, storage_key, content_type, bytes,
         duration_ms, volume, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, server_id, name, emoji, storage_key, content_type, bytes,
                 duration_ms, volume`,
      [
        input.serverId,
        input.name,
        input.emoji,
        input.key,
        contentType,
        head.contentLength,
        durationMs,
        volume,
        input.userId,
      ],
    );
    await client.query("COMMIT");
    pendingUploads.delete(input.key);
    return toSound(inserted.rows[0]!);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof SoundboardError) {
      throw error;
    }
    if (isUniqueViolation(error)) {
      const existing = await getPool().query<SoundRow>(
        `SELECT id, server_id, name, emoji, storage_key, content_type, bytes,
                duration_ms, volume
           FROM soundboard_sounds
          WHERE storage_key = $1 AND server_id = $2`,
        [input.key, input.serverId],
      );
      const row = existing.rows[0];
      if (row) {
        pendingUploads.delete(input.key);
        return toSound(row);
      }
      throw new SoundboardError("missing");
    }
    const kept = await getPool()
      .query(`SELECT 1 FROM soundboard_sounds WHERE storage_key = $1`, [
        input.key,
      ])
      .catch(() => null);
    if (kept && (kept.rowCount ?? 0) === 0) {
      await dropUnclaimedObject(input.key).catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function updateSoundboardSound(input: {
  serverId: string;
  soundId: string;
  name?: string;
  emoji?: string;
  volume?: number;
}): Promise<SoundboardSound | null> {
  const result = await getPool().query<SoundRow>(
    `UPDATE soundboard_sounds
        SET name = COALESCE($3, name),
            emoji = COALESCE($4, emoji),
            volume = COALESCE($5, volume)
      WHERE id = $1 AND server_id = $2
      RETURNING id, server_id, name, emoji, storage_key, content_type, bytes,
                duration_ms, volume`,
    [
      input.soundId,
      input.serverId,
      input.name ?? null,
      input.emoji ?? null,
      input.volume ?? null,
    ],
  );
  const row = result.rows[0];
  forgetPlayable(input.soundId);
  return row ? toSound(row) : null;
}

export async function deleteSoundboardSound(
  serverId: string,
  soundId: string,
): Promise<boolean> {
  const result = await getPool().query<{ storage_key: string }>(
    `SELECT storage_key
       FROM soundboard_sounds
      WHERE id = $1 AND server_id = $2`,
    [soundId, serverId],
  );
  const key = result.rows[0]?.storage_key;
  if (!key) {
    return false;
  }
  if (isStorageConfigured()) {
    await deleteObject(key);
  }
  await getPool().query(
    `DELETE FROM soundboard_sounds WHERE id = $1 AND server_id = $2`,
    [soundId, serverId],
  );
  forgetPlayable(soundId);
  return true;
}

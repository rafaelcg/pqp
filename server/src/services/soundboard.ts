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

const PLAYABLE_CACHE_MAX = 500;

function rememberPlayable(serverId: string, sound: PlayableSound): void {
  if (playableCache.size >= PLAYABLE_CACHE_MAX) {
    // Insertion order: drop the oldest entry so a long-lived process that has
    // seen many sounds does not grow without bound.
    const oldest = playableCache.keys().next().value;
    if (oldest !== undefined) {
      playableCache.delete(oldest);
    }
  }
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

/** How long a cleanup holds a ticket while it deletes the object. */
const CLEANUP_LEASE_SECONDS = 120;
/** Past its signature plus this, an upload is abandoned: nothing will claim it. */
const PENDING_GRACE_SECONDS = 60;
const SWEEP_BATCH = 50;

/**
 * Delete the object behind tickets this process holds a lease on, then the
 * tickets. The lease (`cleanup_until`) is what keeps a claim from taking a
 * ticket whose file is going away; the ticket row is removed only after the
 * object is gone, so a failed or interrupted delete leaves the row and the
 * next sweep retries once the lease lapses. The S3 calls hold no connection
 * and sit outside any transaction.
 */
async function finishCleanup(keys: string[]): Promise<void> {
  for (const key of keys) {
    // A batch can take longer than one lease (each S3 call may run its full
    // timeout), so each key renews its own lease just before its delete.
    await getPool()
      .query(
        `UPDATE soundboard_pending_uploads
            SET cleanup_until = NOW() + INTERVAL '120 seconds'
          WHERE storage_key = $1 AND cleanup_until IS NOT NULL`,
        [key],
      )
      .catch(() => undefined);
    try {
      await deleteObject(key);
    } catch {
      continue;
    }
    await getPool()
      .query(`DELETE FROM soundboard_pending_uploads WHERE storage_key = $1`, [
        key,
      ])
      .catch(() => undefined);
  }
}

/**
 * Give up on a signed upload the claim rejected: lease its ticket, delete the
 * object, then drop the ticket. Never touches a file a claim already took
 * (its ticket is gone, so there is nothing to lease).
 */
async function dropUnclaimedObject(key: string): Promise<void> {
  const leased = await getPool().query<{ storage_key: string }>(
    `UPDATE soundboard_pending_uploads
        SET cleanup_until = NOW() + make_interval(secs => $2)
      WHERE storage_key = $1
        AND (cleanup_until IS NULL OR cleanup_until <= NOW())
      RETURNING storage_key`,
    [key, CLEANUP_LEASE_SECONDS],
  );
  await finishCleanup(leased.rows.map((row) => row.storage_key));
}

/**
 * Sweep abandoned uploads, on whichever machine runs first. `SKIP LOCKED`
 * means two machines never lease the same row.
 */
export async function sweepPendingUploads(): Promise<number> {
  const due = await getPool().query<{ storage_key: string }>(
    `UPDATE soundboard_pending_uploads
        SET cleanup_until = NOW() + make_interval(secs => $3)
      WHERE storage_key IN (
        SELECT storage_key FROM soundboard_pending_uploads
         WHERE expires_at <= NOW() - make_interval(secs => $1)
           AND (cleanup_until IS NULL OR cleanup_until <= NOW())
         ORDER BY expires_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING storage_key`,
    [PENDING_GRACE_SECONDS, SWEEP_BATCH, CLEANUP_LEASE_SECONDS],
  );
  await finishCleanup(due.rows.map((row) => row.storage_key));
  return due.rows.length;
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
    if (!isStorageConfigured()) {
      return;
    }
    void sweepPendingUploads().catch(() => undefined);
  }, 60_000).unref?.();
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
  const key = soundboardObjectKey(input.serverId, input.contentType);
  const expiresAtMs = Date.now() + UPLOAD_URL_TTL_SECONDS * 1000;
  // Sign before reserving: a signer failure then leaves no ticket counting
  // toward the cap.
  const uploadUrl = presignPut(
    key,
    input.contentType,
    input.byteSize,
    UPLOAD_URL_TTL_SECONDS,
  );
  // One statement under the server row lock, so two requests cannot both pass
  // a count of 23, and the count is the whole cluster's: stored sounds plus
  // every ticket still in the table (one stays claimable until swept).
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT id FROM servers WHERE id = $1 FOR UPDATE`, [
      input.serverId,
    ]);
    const count = await client.query<{ n: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM soundboard_sounds WHERE server_id = $1) +
         (SELECT COUNT(*) FROM soundboard_pending_uploads
           WHERE server_id = $1)
       )::text AS n`,
      [input.serverId],
    );
    if (Number(count.rows[0]?.n ?? 0) >= SOUNDBOARD_MAX_SOUNDS) {
      await client.query("ROLLBACK");
      throw new SoundboardError("slots");
    }
    await client.query(
      `INSERT INTO soundboard_pending_uploads (storage_key, server_id, expires_at)
       VALUES ($1, $2, $3)`,
      [key, input.serverId, new Date(expiresAtMs)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return {
    key,
    uploadUrl,
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
  // Set when the claim loses its slot: the file is dropped once the pooled
  // client is back, never while it is held.
  let dropAfter = false;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT id FROM servers WHERE id = $1 FOR UPDATE`, [
      input.serverId,
    ]);
    // The pending row is the ticket. Taking it here is what keeps the sweep
    // from deleting the object under this insert; no row means the sweep
    // took it, or an earlier claim of the same key already finished.
    const ticket = await client.query(
      `DELETE FROM soundboard_pending_uploads
        WHERE storage_key = $1 AND server_id = $2
          AND (cleanup_until IS NULL OR cleanup_until <= NOW())`,
      [input.key, input.serverId],
    );
    if ((ticket.rowCount ?? 0) === 0) {
      const done = await client.query<SoundRow>(
        `SELECT id, server_id, name, emoji, storage_key, content_type, bytes,
                duration_ms, volume
           FROM soundboard_sounds
          WHERE storage_key = $1 AND server_id = $2`,
        [input.key, input.serverId],
      );
      await client.query("ROLLBACK");
      const row = done.rows[0];
      if (!row) {
        throw new SoundboardError("missing");
      }
      return toSound(row);
    }
    const count = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM soundboard_sounds WHERE server_id = $1`,
      [input.serverId],
    );
    if (Number(count.rows[0]?.n ?? 0) >= SOUNDBOARD_MAX_SOUNDS) {
      await client.query("ROLLBACK");
      dropAfter = true;
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
    return toSound(inserted.rows[0]!);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof SoundboardError) {
      throw error;
    }
    if (isUniqueViolation(error)) {
      // Another claim of the same key committed first. Answer with its row.
      const existing = await getPool().query<SoundRow>(
        `SELECT id, server_id, name, emoji, storage_key, content_type, bytes,
                duration_ms, volume
           FROM soundboard_sounds
          WHERE storage_key = $1 AND server_id = $2`,
        [input.key, input.serverId],
      );
      const row = existing.rows[0];
      if (row) {
        return toSound(row);
      }
      throw new SoundboardError("missing");
    }
    // Rolled back, so the pending row is still there: the sweep owns the file.
    throw error;
  } finally {
    client.release();
    if (dropAfter) {
      await dropUnclaimedObject(input.key).catch(() => undefined);
    }
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
  const found = await getPool().query<{ storage_key: string }>(
    `SELECT storage_key
       FROM soundboard_sounds
      WHERE id = $1 AND server_id = $2`,
    [soundId, serverId],
  );
  const key = found.rows[0]?.storage_key;
  if (!key) {
    return false;
  }
  // Object first: a storage error leaves the row in place, so the delete can
  // be retried and no file is orphaned with its key forgotten. A missing
  // object still counts as gone (`deleteObject` treats 404 as success).
  // With no storage configured the file cannot be removed, so keep the row
  // rather than forget a key whose object may still exist.
  if (!isStorageConfigured()) {
    throw new Error("storage_unavailable");
  }
  await deleteObject(key);
  await getPool().query(
    `DELETE FROM soundboard_sounds WHERE id = $1 AND server_id = $2`,
    [soundId, serverId],
  );
  forgetPlayable(soundId);
  return true;
}

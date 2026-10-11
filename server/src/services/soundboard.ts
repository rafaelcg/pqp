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
import { publishToCluster, subscribeToCluster } from "../lib/bus.js";
import {
  deleteObject,
  getObjectPrefix,
  headObject,
  isStorageConfigured,
  presignGet,
  presignPut,
} from "../lib/s3.js";

// A clip is at most 512 KB, so a few minutes is plenty to send it. The
// ticket counts toward the 24 slots until it is claimed or swept, so a long
// signature is a long-held slot after an abandoned upload.
const UPLOAD_URL_TTL_SECONDS = 3 * 60;
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

/**
 * Slots taken: stored sounds plus uploads still in flight. The same count
 * the mint refuses on, so the settings counter and the Add button never
 * disagree with the server.
 */
export async function countSoundboardSlotsUsed(serverId: string): Promise<number> {
  const result = await getPool().query<{ n: string }>(
    `SELECT (
       (SELECT COUNT(*) FROM soundboard_sounds WHERE server_id = $1) +
       (SELECT COUNT(*) FROM soundboard_pending_uploads WHERE server_id = $1)
     )::text AS n`,
    [serverId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

export async function listSoundboardSounds(
  serverId: string,
  options: { withUploader?: boolean } = {},
): Promise<SoundboardSound[]> {
  const result = await getPool().query<
    SoundRow & { created_by: string | null; added_by_name: string | null }
  >(
    `SELECT s.id, s.server_id, s.name, s.emoji, s.storage_key, s.content_type,
            s.bytes, s.duration_ms, s.volume, s.created_by,
            u.display_name AS added_by_name
       FROM soundboard_sounds s
       LEFT JOIN users u ON u.id = s.created_by
      WHERE s.server_id = $1
      ORDER BY s.created_at ASC, s.id ASC`,
    [serverId],
  );
  return result.rows.map((row) => {
    const sound = toSound(row);
    if (!options.withUploader) {
      return sound;
    }
    return {
      ...sound,
      addedBy:
        row.created_by && row.added_by_name
          ? { id: row.created_by, name: row.added_by_name }
          : null,
    };
  });
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

const FORGET_TOPIC = "soundboard.forget";

/**
 * Drop a sound from the playable cache here and on every other instance, so
 * a deleted or edited clip is not admitted for up to a TTL by the sibling
 * that cached it.
 */
function forgetPlayable(soundId: string): void {
  playableCache.delete(soundId);
  publishToCluster(FORGET_TOPIC, { soundId });
}

subscribeToCluster(FORGET_TOPIC, (data) => {
  const soundId = (data as { soundId?: unknown } | null)?.soundId;
  if (typeof soundId === "string") {
    playableCache.delete(soundId);
  }
});

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
 * Read the object, time it, and insert the row. `created` is true only for
 * the call that inserted the row, so only that call is audited; a repeat or
 * a parallel claim of the same key answers with the row and `created: false`.
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
}): Promise<{ sound: SoundboardSound; created: boolean }> {
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
      return { sound: toSound(row), created: false };
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
        // Within the measuring tolerance of the cap counts as at the cap.
        Math.min(durationMs!, SOUNDBOARD_MAX_DURATION_MS),
        volume,
        input.userId,
      ],
    );
    await client.query("COMMIT");
    return { sound: toSound(inserted.rows[0]!), created: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof SoundboardError) {
      throw error;
    }
    if (isUniqueViolation(error)) {
      // Another claim of the same key committed first. Answer with its row;
      // that claim is the one that created it.
      const existing = await getPool().query<SoundRow>(
        `SELECT id, server_id, name, emoji, storage_key, content_type, bytes,
                duration_ms, volume
           FROM soundboard_sounds
          WHERE storage_key = $1 AND server_id = $2`,
        [input.key, input.serverId],
      );
      const row = existing.rows[0];
      if (row) {
        return { sound: toSound(row), created: false };
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

/** What a clip looked like before an edit, for the audit row. */
export interface SoundboardBefore {
  name: string;
  emoji: string;
  volume: number;
}

/**
 * Edit a clip. The row is locked and read first, so the audit row can say
 * what it was before, and an edit that changes nothing writes nothing:
 * `changed` is false and the caller skips the audit row.
 */
export async function updateSoundboardSound(input: {
  serverId: string;
  soundId: string;
  name?: string;
  emoji?: string;
  volume?: number;
}): Promise<{
  sound: SoundboardSound;
  before: SoundboardBefore;
  changed: boolean;
} | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<SoundRow>(
      `SELECT id, server_id, name, emoji, storage_key, content_type, bytes,
              duration_ms, volume
         FROM soundboard_sounds
        WHERE id = $1 AND server_id = $2
          FOR UPDATE`,
      [input.soundId, input.serverId],
    );
    const old = current.rows[0];
    if (!old) {
      await client.query("ROLLBACK");
      forgetPlayable(input.soundId);
      return null;
    }
    const before: SoundboardBefore = {
      name: old.name,
      emoji: old.emoji,
      volume: Number(old.volume),
    };
    // The column is REAL: compare at that precision or 0.05 never equals itself.
    const changed =
      (input.name !== undefined && input.name !== old.name) ||
      (input.emoji !== undefined && input.emoji !== old.emoji) ||
      (input.volume !== undefined &&
        Math.fround(input.volume) !== Math.fround(Number(old.volume)));
    if (!changed) {
      await client.query("ROLLBACK");
      return { sound: toSound(old), before, changed: false };
    }
    const result = await client.query<SoundRow>(
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
    await client.query("COMMIT");
    forgetPlayable(input.soundId);
    return { sound: toSound(result.rows[0]!), before, changed: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Deletes the clip. Its name for the audit row, or null when there was none
 * (already deleted, or deleted by a parallel request).
 *
 * One transaction, no network inside it: `DELETE ... RETURNING` picks the
 * winner (exactly one of any number of parallel callers gets the row, so
 * exactly one writes the audit row), and the same transaction hands the file
 * to the upload ledger as an expired ticket this call holds the lease on.
 * The object is deleted after the commit. If storage fails, or the process
 * dies first, the lease lapses and `sweepPendingUploads` deletes the file
 * later. So no file is ever left with its key forgotten, the clip is gone for
 * everybody at once, and the board never counts it twice.
 *
 * With no storage configured the file cannot be removed, so the row is kept.
 */
export async function deleteSoundboardSound(
  serverId: string,
  soundId: string,
): Promise<string | null> {
  if (!isStorageConfigured()) {
    const exists = await getPool().query(
      `SELECT 1 FROM soundboard_sounds WHERE id = $1 AND server_id = $2`,
      [soundId, serverId],
    );
    if ((exists.rowCount ?? 0) === 0) {
      return null;
    }
    throw new SoundboardError("storage");
  }
  const client = await getPool().connect();
  let row: { name: string; storage_key: string } | undefined;
  try {
    await client.query("BEGIN");
    const removed = await client.query<{ name: string; storage_key: string }>(
      `DELETE FROM soundboard_sounds
        WHERE id = $1 AND server_id = $2
        RETURNING name, storage_key`,
      [soundId, serverId],
    );
    row = removed.rows[0];
    if (row) {
      await client.query(
        `INSERT INTO soundboard_pending_uploads
           (storage_key, server_id, expires_at, cleanup_until)
         VALUES ($1, $2, NOW() - INTERVAL '1 day', NOW() + make_interval(secs => $3))
         ON CONFLICT (storage_key) DO UPDATE
           SET expires_at = EXCLUDED.expires_at,
               cleanup_until = EXCLUDED.cleanup_until`,
        [row.storage_key, serverId, CLEANUP_LEASE_SECONDS],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (!row) {
    return null;
  }
  forgetPlayable(soundId);
  // Best effort now; the sweep owns the file if this fails.
  await finishCleanup([row.storage_key]);
  return row.name;
}

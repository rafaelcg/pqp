import { randomBytes, randomUUID } from "node:crypto";
import {
  LOCADORA_APP_ID,
  LOCADORA_SAVE_LIMITS,
  type LocadoraSaveRow,
  type LocadoraSaveStatus,
  type LocadoraSaveUpload,
  type LocadoraSaveUploadBody,
  type LocadoraSaveUsage,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { isEnabled } from "../lib/flags.js";
import { HttpError } from "../lib/http.js";
import { rateLimit } from "../lib/rate-limit.js";
import { HttpErrorWithDetail } from "../lib/route-results.js";
import { deleteObject, headObject, presignGet, presignPut } from "../lib/s3.js";
import { isAttachmentsConfigured } from "../services/attachments.js";

/**
 * SAVES NA CONTA: the server half (docs/EMULATOR_ROOM.md rule 7, SPEC 10 of
 * the Locadora UX pass). Behind the runtime flag `locadora_save_sync`, per
 * server, default off.
 *
 * What this keeps: a person's battery saves and save states for Locadora, and
 * a small picture of each state. Never the game file, its title or its box
 * art; there is no field for any of them. A save is found by `game_key`, an
 * HMAC of the game file's hash under a salt that is this account's alone,
 * computed in the browser, so the raw hash never arrives and a save shows up
 * only on a device that holds the same file. Honest limit, said in the docs
 * too: the salt is stored here, so the operator COULD test a known hash
 * against a key. The policy is to never build or keep such a list.
 *
 * Every request names an app session (`sessionId`): the caller must hold a
 * player seat in a live Locadora session, and that session's row says which
 * server it is, so the flags are read for the right server and the request
 * itself names none. The bytes never pass through here: the browser PUTs and
 * GETs them with presigned URLs (docs/ATTACHMENTS.md), and the commit checks
 * with a HEAD that what arrived is the size that was signed. Nothing between
 * BEGIN and COMMIT touches the network.
 *
 * Optimistic concurrency on `rev`: every write names the rev it replaces (0 for
 * "there is none") and a mismatch is 409 `stale_rev` with what is there now,
 * so the app can draw both sides of the conflict.
 */

const PREFIX = "locadora-saves";
const PUT_TTL_SECONDS = 10 * 60;
const GET_TTL_SECONDS = 5 * 60;
const OCTET = "application/octet-stream";
const PNG = "image/png";

export type SaveSyncMode = "on" | "read-only";

export interface SaveContext {
  userId: string;
  serverId: string;
  mode: SaveSyncMode;
}

interface DbSave {
  id: string;
  user_id: string;
  game_key: string;
  kind: "sram" | "state";
  slot: number;
  rev: number;
  size: number;
  sha256: string;
  object_key: string;
  thumb_key: string | null;
  thumb_size: number;
  platform: string;
  core: string;
  core_version: string;
  device_kind: "computer" | "phone" | "tablet";
  device_id: string;
  updated_at: Date;
  history?: string | number;
}

const notFound = () => new HttpError(404, "Not found");

function q<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return getPool().query<T>(text, values);
}

export function rowToSave(row: DbSave): LocadoraSaveRow {
  return {
    id: row.id,
    kind: row.kind,
    slot: row.slot,
    rev: row.rev,
    size: row.size,
    sha256: row.sha256,
    hasThumb: row.thumb_key !== null,
    platform: row.platform,
    core: row.core,
    coreVersion: row.core_version,
    deviceKind: row.device_kind,
    deviceId: row.device_id,
    updatedAt: row.updated_at.getTime(),
    history: Number(row.history ?? 0),
  };
}

/** Deletes objects after a commit; a failure is logged, never thrown (the row is already gone). */
function dropObjects(keys: Array<string | null | undefined>): void {
  for (const key of keys) {
    if (!key) continue;
    void deleteObject(key).catch((error: unknown) => {
      console.error(`[locadora-saves] leaked object ${key}:`, error instanceof Error ? error.message : error);
    });
  }
}

function objectKey(userId: string, thumb = false): string {
  return `${PREFIX}/${userId}/${randomUUID()}${thumb ? ".png" : ".bin"}`;
}

/* ---- who may ask ---- */

/**
 * The gate every route runs first. 404, exactly like a path that does not
 * exist, unless: storage is configured, the session is a live Locadora session
 * the caller holds a player seat in, `apps` and `emulator_room` are on for its
 * server, and `locadora_save_sync` is on there (`on`) or this account used it
 * in the last 30 days (`read-only`, which `write` refuses).
 */
export async function saveContext(userId: string, sessionId: string, options: { write: boolean }): Promise<SaveContext> {
  if (!isAttachmentsConfigured()) throw notFound();
  const seat = await q<{ server_id: string }>(
    `SELECT s.server_id
       FROM app_sessions s
       JOIN app_session_participants p ON p.session_id = s.id
      WHERE s.id = $1 AND s.status = 'live' AND s.app_id = $2
        AND p.user_id = $3 AND p.left_at IS NULL AND p.role = 'player'`,
    [sessionId, LOCADORA_APP_ID, userId],
  );
  const serverId = seat.rows[0]?.server_id;
  if (!serverId) throw notFound();
  if (!isEnabled("apps", { serverId }) || !isEnabled("emulator_room", { serverId })) throw notFound();
  if (isEnabled("locadora_save_sync", { serverId })) return { userId, serverId, mode: "on" };
  if (options.write) throw notFound();
  const recent = await q(
    `SELECT 1 FROM locadora_save_salts
      WHERE user_id = $1 AND last_on_at > NOW() - make_interval(days => $2)
        AND EXISTS (SELECT 1 FROM locadora_saves WHERE user_id = $1)`,
    [userId, LOCADORA_SAVE_LIMITS.readOnlyDays],
  );
  if (recent.rows.length === 0) throw notFound();
  return { userId, serverId, mode: "read-only" };
}

function spendWrite(userId: string): void {
  const result = rateLimit(`locadora-save-write:${userId}`, LOCADORA_SAVE_LIMITS.writesPerMinute, 60_000);
  if (!result.allowed) throw new HttpError(429, "rate_limited");
}

/* ---- reads ---- */

export async function usageOf(userId: string): Promise<LocadoraSaveUsage> {
  const result = await q<{ used: string }>(
    `SELECT (
        COALESCE((SELECT SUM(size + thumb_size) FROM locadora_saves WHERE user_id = $1), 0)
      + COALESCE((SELECT SUM(size) FROM locadora_save_history WHERE user_id = $1), 0)
      + COALESCE((SELECT SUM(size + thumb_size) FROM locadora_save_uploads
                   WHERE user_id = $1 AND created_at > NOW() - make_interval(mins => $2)), 0)
     )::bigint AS used`,
    [userId, LOCADORA_SAVE_LIMITS.uploadTtlMinutes],
  );
  return { used: Number(result.rows[0]?.used ?? 0), cap: LOCADORA_SAVE_LIMITS.accountBytes };
}

/** The salt is created on first use, and only with the flag on. */
export async function saveStatus(context: SaveContext): Promise<LocadoraSaveStatus> {
  let salt: Buffer | undefined;
  if (context.mode === "on") {
    const created = await q<{ salt: Buffer }>(
      `INSERT INTO locadora_save_salts (user_id, salt) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET last_on_at = NOW()
       RETURNING salt`,
      [context.userId, randomBytes(32)],
    );
    salt = created.rows[0]?.salt;
  } else {
    const found = await q<{ salt: Buffer }>(`SELECT salt FROM locadora_save_salts WHERE user_id = $1`, [context.userId]);
    salt = found.rows[0]?.salt;
  }
  if (!salt) throw notFound();
  return { mode: context.mode, salt: salt.toString("base64url"), usage: await usageOf(context.userId) };
}

const SAVE_COLUMNS = `s.*, (SELECT count(*) FROM locadora_save_history h WHERE h.save_id = s.id) AS history`;

export async function listSaves(context: SaveContext, gameKey: string): Promise<LocadoraSaveRow[]> {
  const rows = await q<DbSave & Record<string, unknown>>(
    `SELECT ${SAVE_COLUMNS} FROM locadora_saves s
      WHERE s.user_id = $1 AND s.game_key = $2
      ORDER BY s.kind, s.slot`,
    [context.userId, gameKey],
  );
  return rows.rows.map(rowToSave);
}

async function readSave(userId: string, saveId: string): Promise<DbSave | null> {
  const rows = await q<DbSave & Record<string, unknown>>(
    `SELECT ${SAVE_COLUMNS} FROM locadora_saves s WHERE s.id = $1 AND s.user_id = $2`,
    [saveId, userId],
  );
  return rows.rows[0] ?? null;
}

async function readSlot(userId: string, gameKey: string, kind: string, slot: number): Promise<DbSave | null> {
  const rows = await q<DbSave & Record<string, unknown>>(
    `SELECT ${SAVE_COLUMNS} FROM locadora_saves s
      WHERE s.user_id = $1 AND s.game_key = $2 AND s.kind = $3 AND s.slot = $4`,
    [userId, gameKey, kind, slot],
  );
  return rows.rows[0] ?? null;
}

export async function downloadSave(context: SaveContext, saveId: string) {
  const row = await readSave(context.userId, saveId);
  if (!row) throw notFound();
  return {
    rev: row.rev,
    url: presignGet(row.object_key, { ttlSeconds: GET_TTL_SECONDS }),
    thumbUrl: row.thumb_key ? presignGet(row.thumb_key, { ttlSeconds: GET_TTL_SECONDS }) : null,
  };
}

function staleRev(current: DbSave | null): HttpErrorWithDetail {
  return new HttpErrorWithDetail(409, "stale_rev", { save: current ? rowToSave(current) : null });
}

/* ---- writes ---- */

/**
 * Step one of a write: refuses early what would be refused at the commit (a
 * stale rev, the quota), records the upload and hands back presigned PUTs for
 * the save and its picture, each signed with its exact length.
 */
export async function beginUpload(context: SaveContext, body: LocadoraSaveUploadBody): Promise<LocadoraSaveUpload> {
  spendWrite(context.userId);
  const current = await readSlot(context.userId, body.gameKey, body.kind, body.slot);
  if ((current?.rev ?? 0) !== body.baseRev) throw staleRev(current);
  const usage = await usageOf(context.userId);
  // a replaced state frees its bytes at the commit; a battery save's old one moves to the history
  const freed = current && body.kind === "state" ? current.size + current.thumb_size : 0;
  if (usage.used - freed + body.size + body.thumbSize > usage.cap) throw new HttpError(413, "quota");

  const key = objectKey(context.userId);
  const thumbKey = body.thumbSize > 0 ? objectKey(context.userId, true) : null;
  const inserted = await q<{ id: string }>(
    `INSERT INTO locadora_save_uploads
       (user_id, game_key, kind, slot, base_rev, size, sha256, object_key, thumb_key, thumb_size,
        platform, core, core_version, device_kind, device_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [
      context.userId, body.gameKey, body.kind, body.slot, body.baseRev, body.size, body.sha256, key, thumbKey,
      body.thumbSize, body.platform, body.core, body.coreVersion, body.deviceKind, body.deviceId,
    ],
  );
  return {
    uploadId: inserted.rows[0]!.id,
    put: { url: presignPut(key, OCTET, body.size, PUT_TTL_SECONDS), contentType: OCTET },
    thumbPut: thumbKey ? { url: presignPut(thumbKey, PNG, body.thumbSize, PUT_TTL_SECONDS), contentType: PNG } : null,
  };
}

interface DbUpload {
  id: string;
  user_id: string;
  game_key: string;
  kind: "sram" | "state";
  slot: number;
  base_rev: number;
  size: number;
  sha256: string;
  object_key: string;
  thumb_key: string | null;
  thumb_size: number;
  platform: string;
  core: string;
  core_version: string;
  device_kind: string;
  device_id: string;
  created_at: Date;
}

/** Throws when what was stored is not what was signed (or never arrived). */
async function checkStored(key: string, size: number): Promise<void> {
  const head = await headObject(key);
  if (!head || head.contentLength !== size) throw new HttpError(400, "upload_incomplete");
}

/**
 * Step two: the bytes are in the bucket. HEAD first (outside the transaction),
 * then in one transaction: the slot's row is locked, its rev must still be the
 * one the upload named, and the write lands with rev + 1. A battery save's
 * previous object moves to the history (three are kept); a state's is deleted
 * after the commit. The quota is checked again inside, against the rows as
 * they are, so two uploads racing cannot both fit.
 */
export async function commitUpload(context: SaveContext, uploadId: string): Promise<{ save: LocadoraSaveRow; usage: LocadoraSaveUsage }> {
  const found = await q<DbUpload & Record<string, unknown>>(
    `SELECT * FROM locadora_save_uploads
      WHERE id = $1 AND user_id = $2 AND created_at > NOW() - make_interval(mins => $3)`,
    [uploadId, context.userId, LOCADORA_SAVE_LIMITS.uploadTtlMinutes],
  );
  const upload = found.rows[0];
  if (!upload) throw notFound();
  await checkStored(upload.object_key, upload.size);
  if (upload.thumb_key) await checkStored(upload.thumb_key, upload.thumb_size);

  const client = await getPool().connect();
  const afterCommit: Array<string | null> = [];
  let failure: HttpError | null = null;
  let saved: DbSave | null = null;
  try {
    await client.query("BEGIN");
    const locked = await client.query<DbSave & Record<string, unknown>>(
      `SELECT * FROM locadora_saves
        WHERE user_id = $1 AND game_key = $2 AND kind = $3 AND slot = $4
        FOR UPDATE`,
      [context.userId, upload.game_key, upload.kind, upload.slot],
    );
    const current = locked.rows[0] ?? null;
    if ((current?.rev ?? 0) !== upload.base_rev) {
      failure = staleRev(current ? ((await readSave(context.userId, current.id)) ?? current) : null);
    } else if (!current) {
      const inserted = await client.query<DbSave & Record<string, unknown>>(
        `INSERT INTO locadora_saves
           (user_id, game_key, kind, slot, rev, size, sha256, object_key, thumb_key, thumb_size,
            platform, core, core_version, device_kind, device_id)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (user_id, game_key, kind, slot) DO NOTHING
         RETURNING *`,
        [
          context.userId, upload.game_key, upload.kind, upload.slot, upload.size, upload.sha256, upload.object_key,
          upload.thumb_key, upload.thumb_size, upload.platform, upload.core, upload.core_version, upload.device_kind,
          upload.device_id,
        ],
      );
      saved = inserted.rows[0] ?? null;
      // somebody else's first write landed between the read and the insert
      if (!saved) failure = staleRev(await readSlot(context.userId, upload.game_key, upload.kind, upload.slot));
    } else {
      if (current.kind === "sram") {
        await client.query(
          `INSERT INTO locadora_save_history (save_id, user_id, rev, size, sha256, object_key, device_kind, device_id, saved_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [current.id, context.userId, current.rev, current.size, current.sha256, current.object_key, current.device_kind, current.device_id, current.updated_at],
        );
        afterCommit.push(current.thumb_key);
        const pruned = await client.query<{ object_key: string }>(
          `DELETE FROM locadora_save_history
            WHERE save_id = $1 AND id NOT IN (
              SELECT id FROM locadora_save_history WHERE save_id = $1 ORDER BY rev DESC LIMIT $2)
            RETURNING object_key`,
          [current.id, LOCADORA_SAVE_LIMITS.sramHistory],
        );
        afterCommit.push(...pruned.rows.map((row) => row.object_key));
      } else {
        afterCommit.push(current.object_key, current.thumb_key);
      }
      const updated = await client.query<DbSave & Record<string, unknown>>(
        `UPDATE locadora_saves
            SET rev = rev + 1, size = $2, sha256 = $3, object_key = $4, thumb_key = $5, thumb_size = $6,
                platform = $7, core = $8, core_version = $9, device_kind = $10, device_id = $11, updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [
          current.id, upload.size, upload.sha256, upload.object_key, upload.thumb_key, upload.thumb_size,
          upload.platform, upload.core, upload.core_version, upload.device_kind, upload.device_id,
        ],
      );
      saved = updated.rows[0] ?? null;
    }
    await client.query(`DELETE FROM locadora_save_uploads WHERE id = $1`, [upload.id]);
    if (!failure) {
      const total = await client.query<{ used: string }>(
        `SELECT (
            COALESCE((SELECT SUM(size + thumb_size) FROM locadora_saves WHERE user_id = $1), 0)
          + COALESCE((SELECT SUM(size) FROM locadora_save_history WHERE user_id = $1), 0)
          + COALESCE((SELECT SUM(size + thumb_size) FROM locadora_save_uploads
                       WHERE user_id = $1 AND created_at > NOW() - make_interval(mins => $2)), 0)
         )::bigint AS used`,
        [context.userId, LOCADORA_SAVE_LIMITS.uploadTtlMinutes],
      );
      if (Number(total.rows[0]?.used ?? 0) > LOCADORA_SAVE_LIMITS.accountBytes) {
        failure = new HttpError(413, "quota");
      }
    }
    if (failure) {
      // the upload row goes; what it put in the bucket goes with it
      await client.query("ROLLBACK");
      await client.query(`DELETE FROM locadora_save_uploads WHERE id = $1`, [upload.id]);
      dropObjects([upload.object_key, upload.thumb_key]);
      throw failure;
    }
    await client.query("COMMIT");
  } catch (error) {
    if (!failure) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  dropObjects(afterCommit);
  // a write with the flag on starts the read-only month over (and the salt exists from here on)
  await q(
    `INSERT INTO locadora_save_salts (user_id, salt) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET last_on_at = NOW()`,
    [context.userId, randomBytes(32)],
  );
  const fresh =(await readSave(context.userId, saved!.id)) ?? saved!;
  return { save: rowToSave(fresh), usage: await usageOf(context.userId) };
}

/**
 * The newest older battery save comes back as the current one (rev + 1), and
 * the one it replaces goes into the history in its place: a restore can be
 * restored again.
 */
export async function restoreSave(context: SaveContext, saveId: string, baseRev: number): Promise<LocadoraSaveRow> {
  spendWrite(context.userId);
  const client = await getPool().connect();
  let restoredId: string;
  try {
    await client.query("BEGIN");
    const locked = await client.query<DbSave & Record<string, unknown>>(
      `SELECT * FROM locadora_saves WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [saveId, context.userId],
    );
    const current = locked.rows[0];
    if (!current) throw notFound();
    if (current.rev !== baseRev) throw staleRev(current);
    const older = await client.query<{
      id: string;
      size: number;
      sha256: string;
      object_key: string;
      device_kind: string;
      device_id: string;
    }>(`SELECT * FROM locadora_save_history WHERE save_id = $1 ORDER BY rev DESC LIMIT 1`, [saveId]);
    const back = older.rows[0];
    if (!back) throw new HttpError(409, "no_history");
    await client.query(`DELETE FROM locadora_save_history WHERE id = $1`, [back.id]);
    await client.query(
      `INSERT INTO locadora_save_history (save_id, user_id, rev, size, sha256, object_key, device_kind, device_id, saved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [current.id, context.userId, current.rev, current.size, current.sha256, current.object_key, current.device_kind, current.device_id, current.updated_at],
    );
    await client.query(
      `UPDATE locadora_saves
          SET rev = rev + 1, size = $2, sha256 = $3, object_key = $4, thumb_key = NULL, thumb_size = 0,
              device_kind = $5, device_id = $6, updated_at = NOW()
        WHERE id = $1`,
      [current.id, back.size, back.sha256, back.object_key, back.device_kind, back.device_id],
    );
    await client.query("COMMIT");
    restoredId = current.id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return rowToSave((await readSave(context.userId, restoredId))!);
}

/** Every object a set of saves names, read before the rows (and their history) are deleted. */
async function deleteWhere(userId: string, where: string, values: unknown[]): Promise<number> {
  const client = await getPool().connect();
  const keys: Array<string | null> = [];
  let deleted = 0;
  try {
    await client.query("BEGIN");
    const history = await client.query<{ object_key: string }>(
      `SELECT h.object_key FROM locadora_save_history h
         JOIN locadora_saves s ON s.id = h.save_id
        WHERE s.user_id = $1 AND ${where}`,
      [userId, ...values],
    );
    keys.push(...history.rows.map((row) => row.object_key));
    const removed = await client.query<{ object_key: string; thumb_key: string | null }>(
      `DELETE FROM locadora_saves s WHERE s.user_id = $1 AND ${where} RETURNING s.object_key, s.thumb_key`,
      [userId, ...values],
    );
    for (const row of removed.rows) keys.push(row.object_key, row.thumb_key);
    deleted = removed.rows.length;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  dropObjects(keys);
  return deleted;
}

export async function deleteSave(context: SaveContext, saveId: string) {
  spendWrite(context.userId);
  const deleted = await deleteWhere(context.userId, "s.id = $2", [saveId]);
  if (deleted === 0) throw notFound();
  return { deleted, usage: await usageOf(context.userId) };
}

/** One game's saves, or (no key) every Locadora save on the account. */
export async function clearSaves(context: SaveContext, gameKey: string | null) {
  spendWrite(context.userId);
  const deleted = gameKey
    ? await deleteWhere(context.userId, "s.game_key = $2", [gameKey])
    : await deleteWhere(context.userId, "TRUE", []);
  return { deleted, usage: await usageOf(context.userId) };
}

/* ---- the account and the sweep ---- */

/**
 * Every object this account has under Locadora saves, read before the account
 * is deleted (the rows cascade with it, and nothing would name the objects
 * after). Uploads in flight included.
 */
export async function accountLocadoraSaveKeys(userId: string): Promise<string[]> {
  const result = await q<{ key: string }>(
    `SELECT object_key AS key FROM locadora_saves WHERE user_id = $1
     UNION ALL SELECT thumb_key FROM locadora_saves WHERE user_id = $1 AND thumb_key IS NOT NULL
     UNION ALL SELECT object_key FROM locadora_save_history WHERE user_id = $1
     UNION ALL SELECT object_key FROM locadora_save_uploads WHERE user_id = $1
     UNION ALL SELECT thumb_key FROM locadora_save_uploads WHERE user_id = $1 AND thumb_key IS NOT NULL`,
    [userId],
  );
  return result.rows.map((row) => row.key);
}

const SWEEP_BATCH = 200;

/**
 * Daily: a save not written for 365 days goes (with its history), and an
 * upload never committed goes after an hour, with whatever it put in the
 * bucket. Runs whatever the flag says: a flag turned off must not make a save
 * outlive its retention.
 */
export async function sweepLocadoraSaves(): Promise<{ saves: number; uploads: number }> {
  const stale = await q<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM locadora_saves
      WHERE updated_at < NOW() - make_interval(days => $1)
      ORDER BY updated_at LIMIT $2`,
    [LOCADORA_SAVE_LIMITS.retentionDays, SWEEP_BATCH],
  );
  let saves = 0;
  for (const row of stale.rows) {
    saves += await deleteWhere(row.user_id, "s.id = $2", [row.id]);
  }
  const uploads = await q<{ object_key: string; thumb_key: string | null }>(
    `DELETE FROM locadora_save_uploads
      WHERE id IN (SELECT id FROM locadora_save_uploads
                    WHERE created_at < NOW() - make_interval(mins => $1)
                    ORDER BY created_at LIMIT $2)
      RETURNING object_key, thumb_key`,
    [LOCADORA_SAVE_LIMITS.uploadTtlMinutes, SWEEP_BATCH],
  );
  if (isAttachmentsConfigured()) {
    dropObjects(uploads.rows.flatMap((row) => [row.object_key, row.thumb_key]));
  }
  return { saves, uploads: uploads.rows.length };
}

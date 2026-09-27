/**
 * Idempotency for room creation. An optional client-supplied key, scoped per
 * user, on `POST /api/servers` and `POST /api/import/discord/apply`. A
 * client that lost the response to a create (network drop, timeout) resends
 * the same request with the same key instead of guessing whether it landed;
 * the server returns the room it already made instead of making a second
 * one.
 *
 * The concurrency guarantee rides on ordinary Postgres MVCC, not an
 * advisory lock: `claimServerIdempotencyKey`'s INSERT is the only write to
 * the (user_id, idempotency_key) row, so a second transaction attempting
 * the same INSERT blocks on that unique index until the first commits or
 * rolls back, then either sees the row (and reads the server id the first
 * request recorded) or, if the first rolled back, gets the claim itself.
 * Callers must run the claim and the eventual `recordServerIdempotencyKey`
 * inside the same transaction that creates the room, so a concurrent
 * duplicate really does wait for the whole create rather than a narrower
 * window.
 */
import type { PoolClient } from "pg";
import { getPool } from "../db.js";

const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

/** Normalizes a raw header value: absent, blank or absurdly long collapses
 * to `null`, which every caller treats as "behave exactly as an old client
 * that never sent the header." */
export function normalizeIdempotencyKey(
  raw: string | string[] | undefined,
): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return null;
  }
  return trimmed;
}

export type IdempotencyClaim =
  | { claimed: true }
  | { claimed: false; serverId: string | null };

/**
 * Claims `(userId, key)` inside the caller's open transaction. `claimed:
 * true` means this call owns the key and must create the room and call
 * `recordServerIdempotencyKey` before COMMIT. `claimed: false` means the key
 * was already used; `serverId` is the room it resolved to, or `null` if a
 * prior attempt claimed the key and never recorded one (its transaction is
 * necessarily gone, since a live one would still hold this INSERT blocked).
 * A caller in that state should proceed to create a room as if it had
 * claimed the key itself.
 */
export async function claimServerIdempotencyKey(
  client: PoolClient,
  userId: string,
  key: string,
): Promise<IdempotencyClaim> {
  const insertResult = await client.query<{ server_id: string | null }>(
    `INSERT INTO server_create_idempotency_keys (user_id, idempotency_key, server_id)
     VALUES ($1, $2, NULL)
     ON CONFLICT (user_id, idempotency_key) DO NOTHING
     RETURNING server_id`,
    [userId, key],
  );
  if (insertResult.rows.length > 0) {
    return { claimed: true };
  }
  const existing = await client.query<{ server_id: string | null }>(
    `SELECT server_id FROM server_create_idempotency_keys
      WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, key],
  );
  return { claimed: false, serverId: existing.rows[0]?.server_id ?? null };
}

/** Records the room a claimed key resolved to. Call once, inside the same
 * transaction as the claim, right before COMMIT. */
export async function recordServerIdempotencyKey(
  client: PoolClient,
  userId: string,
  key: string,
  serverId: string,
): Promise<void> {
  await client.query(
    `UPDATE server_create_idempotency_keys SET server_id = $3
      WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, key, serverId],
  );
}

/**
 * A read outside any transaction, for a caller that wants to skip expensive
 * work (an outbound fetch, a rate-limit draw) ahead of a request it can
 * already tell is a duplicate. Not itself race-safe, since a concurrent
 * in-flight claim can still read `null` here, so it is only ever an
 * optimization; `claimServerIdempotencyKey` inside the creating transaction
 * is what actually prevents a second room.
 */
export async function peekServerIdempotencyKey(
  userId: string,
  key: string,
): Promise<string | null> {
  const result = await getPool().query<{ server_id: string | null }>(
    `SELECT server_id FROM server_create_idempotency_keys
      WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, key],
  );
  return result.rows[0]?.server_id ?? null;
}

/** Daily sweep: drop keys past their 24h retention. A pruned key is simply
 * available again; nothing depends on this running, the same way nothing
 * depends on `pruneExpiredTimeouts` running (see server/src/jobs.ts). */
export async function pruneExpiredServerIdempotencyKeys(): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM server_create_idempotency_keys
      WHERE created_at < NOW() - INTERVAL '24 hours'`,
  );
  return result.rowCount ?? 0;
}

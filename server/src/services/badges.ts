import { TURMA_1000_BADGE, TURMA_1000_SIZE } from "@pqp/shared";
import { getPool } from "../db.js";
import { logEvent } from "../lib/log.js";

/**
 * Turma dos 1000 — the founding mark.
 *
 * One shot: the first {@link TURMA_1000_SIZE} human accounts, numbered by
 * `created_at` then `id`, then the door closes. Characters and webhooks are
 * not humans (same predicate as `GET /api/admin/metrics`).
 *
 * Called from `insertNewUser` after a new person exists. Cheap until the
 * threshold (EXISTS + COUNT) and a no-op after. Signup must not 500 if this
 * fails; the next new human retries.
 *
 * The Fly image does not ship `server/scripts/`. This function is what
 * production actually runs. The script of the same name is a local fallback
 * against `DATABASE_URL`.
 *
 * `minHumans` / `take` exist so tests can stamp three rows without inserting
 * a thousand. Production always uses {@link TURMA_1000_SIZE}.
 */

/** Arbitrary int4; documented so a second lock in this area does not collide. */
const TURMA_1000_LOCK_KEY = 872_401_000;

const HUMAN_SQL = `NOT is_webhook AND NOT is_character`;

export interface StampTurma1000Result {
  status: "granted" | "already" | "too_soon";
  granted: number;
}

export async function stampTurma1000(options?: {
  minHumans?: number;
  take?: number;
}): Promise<StampTurma1000Result> {
  const minHumans = options?.minHumans ?? TURMA_1000_SIZE;
  const take = options?.take ?? TURMA_1000_SIZE;
  const pool = getPool();

  // Cheap after the door has closed: no lock, no transaction. The locked
  // path below re-checks, so two signups crossing 1,000 still serialize.
  const already = await pool.query(
    `SELECT 1 FROM user_badges WHERE badge = $1 LIMIT 1`,
    [TURMA_1000_BADGE],
  );
  if ((already.rowCount ?? 0) > 0) {
    return { status: "already", granted: 0 };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [TURMA_1000_LOCK_KEY]);

    const existing = await client.query(
      `SELECT 1 FROM user_badges WHERE badge = $1 LIMIT 1`,
      [TURMA_1000_BADGE],
    );
    if ((existing.rowCount ?? 0) > 0) {
      await client.query("COMMIT");
      return { status: "already", granted: 0 };
    }

    const humans = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM users WHERE ${HUMAN_SQL}`,
    );
    if (Number(humans.rows[0]?.n ?? 0) < minHumans) {
      await client.query("COMMIT");
      return { status: "too_soon", granted: 0 };
    }

    const inserted = await client.query(
      `INSERT INTO user_badges (user_id, badge, ordinal)
       SELECT id, $1, rn
         FROM (
           SELECT id,
                  ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS rn
             FROM users
            WHERE ${HUMAN_SQL}
         ) ranked
        WHERE rn <= $2
       ON CONFLICT (user_id, badge) DO NOTHING`,
      [TURMA_1000_BADGE, take],
    );
    await client.query("COMMIT");
    const granted = inserted.rowCount ?? 0;
    logEvent("turma1000.stamped", { granted, take, minHumans });
    return { status: "granted", granted };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

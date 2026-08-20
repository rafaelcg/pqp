import {
  CACA_BUGS_BADGE,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackStatus,
  type ProfileAchievement,
} from "@pqp/shared";
import { getPool } from "../db.js";

/**
 * Product feedback — the settings box, not the moderation queue.
 *
 * Deliberately thin next to reports: there is no subject to resolve, no
 * visibility oracle to defend, no routing decision. Somebody typed a thing
 * about the product; the operator reads it. The one piece of ceremony is the
 * caça-bugs badge: confirming a bug report grants its author a permanent
 * mark, in the same transaction that flips the status, so a confirmed catch
 * can never exist without its badge or the badge without a catch.
 */

interface FeedbackRow {
  id: string;
  user_id: string | null;
  username: string | null;
  kind: FeedbackKind;
  body: string;
  status: FeedbackStatus;
  created_at: Date;
}

function toItem(row: FeedbackRow): FeedbackItem {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    kind: row.kind,
    body: row.body,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

export async function createFeedback(
  userId: string,
  input: { kind: FeedbackKind; body: string },
): Promise<FeedbackItem> {
  const result = await getPool().query<FeedbackRow>(
    `WITH inserted AS (
       INSERT INTO feedback (user_id, kind, body)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, kind, body, status, created_at
     )
     SELECT i.id, i.user_id, u.username, i.kind, i.body, i.status, i.created_at
       FROM inserted i
       LEFT JOIN users u ON u.id = i.user_id`,
    [userId, input.kind, input.body],
  );
  return toItem(result.rows[0]!);
}

export async function listFeedback(options: {
  before?: string;
  limit: number;
  status?: FeedbackStatus;
}): Promise<{ items: FeedbackItem[] }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.status) {
    params.push(options.status);
    clauses.push(`f.status = $${params.length}`);
  }
  if (options.before && /^[0-9]{1,19}$/.test(options.before)) {
    params.push(options.before);
    clauses.push(`f.id < $${params.length}::bigint`);
  }
  params.push(options.limit);
  const result = await getPool().query<FeedbackRow>(
    `SELECT f.id, f.user_id, u.username, f.kind, f.body, f.status, f.created_at
       FROM feedback f
       LEFT JOIN users u ON u.id = f.user_id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY f.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return { items: result.rows.map(toItem) };
}

/**
 * Flip a feedback item to `confirmed` or `closed`.
 *
 * Confirming a BUG grants its author the caça-bugs badge in the same
 * transaction. Only the bug kind: confirming an idea means "we'll do it",
 * which is not a catch. Idempotent on the badge (a second confirmed bug from
 * the same person changes nothing) and null-safe on the author (an account
 * deleted since filing simply earns nothing).
 */
export async function resolveFeedback(
  id: string,
  status: "confirmed" | "closed",
): Promise<FeedbackItem | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query<FeedbackRow>(
      `WITH changed AS (
         UPDATE feedback
            SET status = $2
          WHERE id = $1::bigint
          RETURNING id, user_id, kind, body, status, created_at
       )
       SELECT c.id, c.user_id, u.username, c.kind, c.body, c.status, c.created_at
         FROM changed c
         LEFT JOIN users u ON u.id = c.user_id`,
      [id, status],
    );
    const row = updated.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    if (status === "confirmed" && row.kind === "bug" && row.user_id) {
      await client.query(
        `INSERT INTO user_badges (user_id, badge)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [row.user_id, CACA_BUGS_BADGE],
      );
    }
    await client.query("COMMIT");
    return toItem(row);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Display names for earned badges. The slug is storage; this is the label. */
const ACHIEVEMENT_NAMES: Record<string, string> = {
  [CACA_BUGS_BADGE]: "Caça-bugs",
};

export async function listUserAchievements(
  userId: string,
): Promise<ProfileAchievement[]> {
  const result = await getPool().query<{ badge: string }>(
    `SELECT badge FROM user_badges WHERE user_id = $1 ORDER BY granted_at`,
    [userId],
  );
  return result.rows.map(({ badge }) => ({
    badge,
    name: ACHIEVEMENT_NAMES[badge] ?? badge,
  }));
}

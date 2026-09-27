import {
  CACA_BUGS_BADGE,
  TURMA_1000_BADGE,
  type FeedbackContext,
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

/** Long enough for any real browser's string, short enough to bound a row. */
const USER_AGENT_MAX_LENGTH = 400;

export async function createFeedback(
  userId: string,
  input: { kind: FeedbackKind; body: string; context?: FeedbackContext },
  userAgent?: string,
): Promise<FeedbackItem> {
  // The user agent comes from this request's own header, never from the body:
  // the client already has every other field, and this one it cannot forge
  // into something the operator would read as a different device.
  const agent = userAgent?.slice(0, USER_AGENT_MAX_LENGTH) || undefined;
  const context =
    input.context || agent ? { ...(input.context ?? {}), userAgent: agent } : null;
  const result = await getPool().query<FeedbackRow>(
    `WITH inserted AS (
       INSERT INTO feedback (user_id, kind, body, context)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, kind, body, status, created_at
     )
     SELECT i.id, i.user_id, u.username, i.kind, i.body, i.status, i.created_at
       FROM inserted i
       LEFT JOIN users u ON u.id = i.user_id`,
    [userId, input.kind, input.body, context ? JSON.stringify(context) : null],
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

// ---------------------------------------------------------------------------
// The operator's queue, on the dashboard.

export const ADMIN_FEEDBACK_PATH = "/api/admin/feedback";
export const ADMIN_FEEDBACK_RESOLVE_PATH = "/api/admin/feedback/resolve";

/**
 * One item as the operator dashboard shows it: the whole text, who wrote it,
 * and where they were. Richer than `FeedbackItem` on purpose, and only ever
 * served to an instance moderator or the dashboard's machine token. It names
 * a person (tag, handle, account age) because a bug report nobody can follow
 * up on is half a report; it still carries no account id and no email.
 */
export interface OperatorFeedbackItem {
  id: string;
  kind: FeedbackKind;
  status: FeedbackStatus;
  body: string;
  createdAt: string;
  context: (FeedbackContext & { userAgent?: string }) | null;
  /** Null when the account was deleted since. */
  author: {
    tag: string;
    displayName: string | null;
    handle: string | null;
    accountCreatedAt: string;
    /** Everything this person has sent, and how many of those were confirmed. */
    sent: number;
    confirmed: number;
  } | null;
}

export interface OperatorFeedbackPage {
  items: OperatorFeedbackItem[];
  /** Pass as `before` for the next page; null on the last one. */
  next: string | null;
  counts: {
    open: number;
    confirmed: number;
    closed: number;
    last24h: number;
    openByKind: Record<FeedbackKind, number>;
  };
}

export type OperatorFeedbackStatusFilter = FeedbackStatus | "all";

export async function listOperatorFeedback(options: {
  status: OperatorFeedbackStatusFilter;
  kind: FeedbackKind | null;
  before?: string;
  limit: number;
}): Promise<OperatorFeedbackPage> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.status !== "all") {
    params.push(options.status);
    clauses.push(`f.status = $${params.length}`);
  }
  if (options.kind) {
    params.push(options.kind);
    clauses.push(`f.kind = $${params.length}`);
  }
  // 18 digits so a hostile cursor cannot overflow `::bigint` into a 500.
  if (options.before && /^[0-9]{1,18}$/.test(options.before)) {
    params.push(options.before);
    clauses.push(`f.id < $${params.length}::bigint`);
  }
  // One more than asked, to know whether there is a next page.
  params.push(options.limit + 1);
  const pool = getPool();
  const rows = await pool.query<{
    id: string;
    kind: FeedbackKind;
    status: FeedbackStatus;
    body: string;
    created_at: Date;
    context: OperatorFeedbackItem["context"];
    user_id: string | null;
    username: string | null;
    discriminator: string | null;
    display_name: string | null;
    handle: string | null;
    account_created_at: Date | null;
  }>(
    `SELECT f.id, f.kind, f.status, f.body, f.created_at, f.context, f.user_id,
            u.username, u.discriminator, u.display_name, u.handle,
            u.created_at AS account_created_at
       FROM feedback f
       LEFT JOIN users u ON u.id = f.user_id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY f.id DESC
      LIMIT $${params.length}`,
    params,
  );
  // Each author's history, once per author on the page rather than once per
  // row: one grouped read over `idx_feedback_user`. The ids stay in here.
  const authorIds = [
    ...new Set(rows.rows.map((row) => row.user_id).filter((id): id is string => !!id)),
  ];
  const history = new Map<string, { sent: number; confirmed: number }>();
  if (authorIds.length > 0) {
    const counted = await pool.query<{ user_id: string; sent: number; confirmed: number }>(
      `SELECT user_id,
              COUNT(*)::int AS sent,
              COUNT(*) FILTER (WHERE status = 'confirmed')::int AS confirmed
         FROM feedback
        WHERE user_id = ANY($1::uuid[])
        GROUP BY user_id`,
      [authorIds],
    );
    for (const row of counted.rows) {
      history.set(row.user_id, { sent: row.sent, confirmed: row.confirmed });
    }
  }
  const counts = await pool.query<{
    open: number;
    confirmed: number;
    closed: number;
    last24h: number;
    open_bug: number;
    open_idea: number;
    open_other: number;
  }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS open,
            COUNT(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
            COUNT(*) FILTER (WHERE status = 'closed')::int AS closed,
            COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS last24h,
            COUNT(*) FILTER (WHERE status = 'open' AND kind = 'bug')::int AS open_bug,
            COUNT(*) FILTER (WHERE status = 'open' AND kind = 'idea')::int AS open_idea,
            COUNT(*) FILTER (WHERE status = 'open' AND kind = 'other')::int AS open_other
       FROM feedback`,
  );
  const page = rows.rows.slice(0, options.limit);
  const c = counts.rows[0]!;
  return {
    items: page.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      body: row.body,
      createdAt: row.created_at.toISOString(),
      context: row.context,
      author:
        row.username && row.account_created_at
          ? {
              tag: `${row.username}#${row.discriminator ?? "0000"}`,
              displayName: row.display_name,
              handle: row.handle,
              accountCreatedAt: row.account_created_at.toISOString(),
              sent: history.get(row.user_id ?? "")?.sent ?? 0,
              confirmed: history.get(row.user_id ?? "")?.confirmed ?? 0,
            }
          : null,
    })),
    next: rows.rows.length > options.limit ? page[page.length - 1]!.id : null,
    counts: {
      open: c.open,
      confirmed: c.confirmed,
      closed: c.closed,
      last24h: c.last24h,
      openByKind: { bug: c.open_bug, idea: c.open_idea, other: c.open_other },
    },
  };
}

/** Display names for earned badges. The slug is storage; this is the label. */
const ACHIEVEMENT_NAMES: Record<string, string> = {
  [CACA_BUGS_BADGE]: "Caça-bugs",
  [TURMA_1000_BADGE]: "Turma dos 1000",
};

export async function listUserAchievements(
  userId: string,
): Promise<ProfileAchievement[]> {
  const result = await getPool().query<{ badge: string; ordinal: number | null }>(
    `SELECT badge, ordinal FROM user_badges WHERE user_id = $1 ORDER BY granted_at`,
    [userId],
  );
  return result.rows.map(({ badge, ordinal }) => ({
    badge,
    name: ACHIEVEMENT_NAMES[badge] ?? badge,
    ordinal: ordinal == null ? null : Number(ordinal),
  }));
}

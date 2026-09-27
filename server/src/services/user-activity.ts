import type { Pool } from "pg";
import { getPool } from "../db.js";
import { logEvent } from "../lib/log.js";

/**
 * Who opened the app on which day, and the two numbers that come out of it:
 * daily / weekly / monthly actives, and whether people who signed up come back.
 *
 * WHY THIS EXISTS
 * Until this table a message was the only per-person activity the database
 * kept, so every "active" and "came back" figure on the dashboard counted
 * posters. A watch party audience is mostly people who watch and never type,
 * and a voice regular may never write a line, so the product's biggest events
 * were close to invisible in its retention numbers.
 *
 * WHAT COUNTS AS ACTIVE
 * The app connecting (WebSocket `auth`), or the person doing something in it
 * (`ACTIVITY_FRAME_TYPES` in `ws/index.ts`: sending, reacting, typing,
 * joining a call or a watch party, the voice frames the idle hangup counts).
 * Never WebRTC signalling or other frames a client sends on its own. Web,
 * Electron, iOS and Android all hold that socket, so it is one signal
 * everywhere. Honest limit: an app left open counts again on any day it
 * reconnects, and an API deploy reconnects everything, so this reads closer
 * to "had pqp open" than "used it". `posted` is the strict measure.
 *
 * NO WRITE PER CONNECTION
 * A deploy reconnects every socket at once, and a per-connection UPDATE is
 * exactly the reconnect-storm pool pressure of the 2026-09-12 postmortem (A2).
 * A note is a `Map.set`. Each process flushes what it noted once a minute as
 * one multi-row `INSERT ... ON CONFLICT DO NOTHING`, and a pair it has already
 * stored today is never queued again. Two API processes writing the same pair
 * converge on one row through the primary key; there is no lock.
 *
 * A failed flush (the breaker open, a timeout) keeps everything it held and
 * the next tick tries again. Past `maxPending` new notes are dropped and
 * counted rather than growing without bound during a long outage.
 *
 * TWO MEASURES, NEVER BLENDED
 * Messages go back to the first day; this table starts the day it shipped.
 * Mixing the two would make the curve jump on deploy day and read as a
 * retention improvement that never happened. So the report carries both:
 * `posted` (sent a message, the whole history) and `active` (opened the app or
 * posted), with `active` left null wherever its window reaches back before
 * `trackingSince`.
 */

export const ADMIN_USER_ACTIVITY_PATH = "/api/admin/user-activity";

/**
 * The timezone a "day" means. Same reasoning as `OCCUPANCY_TIMEZONE`: the
 * instance is Brazilian and its evening straddles UTC midnight.
 */
export const ACTIVITY_TIMEZONE = "America/Sao_Paulo";

export const USER_ACTIVITY_FLUSH_INTERVAL_MS = 60_000;
const MAX_PENDING = 50_000;
const MAX_ROWS_PER_STATEMENT = 5_000;

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: ACTIVITY_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** `YYYY-MM-DD` in São Paulo for an epoch millisecond. */
export function activityDay(ms: number): string {
  return dayFormatter.format(new Date(ms));
}

export interface UserActivityRecorderStats {
  noted: number;
  pending: number;
  flushes: number;
  flushFailures: number;
  dropped: number;
}

export interface UserActivityRecorder {
  note(userId: string): void;
  flush(): Promise<number>;
  stats(): UserActivityRecorderStats;
  start(): () => Promise<void>;
  resetForTests(): void;
}

export function createUserActivityRecorder(
  options: {
    now?: () => number;
    pool?: () => Pick<Pool, "query">;
    flushIntervalMs?: number;
    maxPending?: number;
  } = {},
): UserActivityRecorder {
  const now = options.now ?? Date.now;
  const pool = options.pool ?? getPool;
  const flushIntervalMs =
    options.flushIntervalMs ?? USER_ACTIVITY_FLUSH_INTERVAL_MS;
  const maxPending = options.maxPending ?? MAX_PENDING;

  /** Noted and not yet stored, keyed `day|userId`. */
  let pending = new Map<string, { userId: string; day: string }>();
  /** Stored by this process today. Cleared when the day turns. */
  let stored = new Set<string>();
  let storedDay = "";
  let flushing = false;
  let noted = 0;
  let flushes = 0;
  let flushFailures = 0;
  let dropped = 0;

  function note(userId: string): void {
    const day = activityDay(now());
    if (day !== storedDay) {
      stored = new Set();
      storedDay = day;
    }
    const key = `${day}|${userId}`;
    if (stored.has(key) || pending.has(key)) {
      return;
    }
    if (pending.size >= maxPending) {
      dropped += 1;
      return;
    }
    noted += 1;
    pending.set(key, { userId, day });
  }

  async function flush(): Promise<number> {
    if (flushing || pending.size === 0) {
      return 0;
    }
    flushing = true;
    const batch = pending;
    pending = new Map();
    let written = 0;
    try {
      const entries = [...batch.entries()];
      for (let i = 0; i < entries.length; i += MAX_ROWS_PER_STATEMENT) {
        const slice = entries.slice(i, i + MAX_ROWS_PER_STATEMENT);
        // Joined to `users` so an account deleted between the note and the
        // flush drops out instead of failing the whole statement on the
        // foreign key, and so bots and the house cast never count.
        const result = await pool().query(
          `INSERT INTO user_activity_days (user_id, day)
           SELECT v.user_id, v.day
             FROM unnest($1::uuid[], $2::date[]) AS v(user_id, day)
             JOIN users u ON u.id = v.user_id
            WHERE NOT u.is_webhook AND NOT u.is_character
           ON CONFLICT DO NOTHING`,
          [slice.map(([, e]) => e.userId), slice.map(([, e]) => e.day)],
        );
        written += result.rowCount ?? 0;
        for (const [key, entry] of slice) {
          batch.delete(key);
          if (entry.day === storedDay) {
            stored.add(key);
          }
        }
      }
      flushes += 1;
      return written;
    } catch (error) {
      flushFailures += 1;
      // Put back what did not land, ahead of anything noted meanwhile, and
      // within the bound.
      for (const [key, entry] of batch) {
        if (pending.size >= maxPending) {
          dropped += 1;
          continue;
        }
        pending.set(key, entry);
      }
      logEvent("userActivity.flushFailed", {
        pending: pending.size,
        error: error instanceof Error ? error.message : String(error),
      });
      return written;
    } finally {
      flushing = false;
    }
  }

  function start(): () => Promise<void> {
    const timer = setInterval(() => {
      void flush().catch(() => undefined);
    }, flushIntervalMs);
    timer.unref?.();
    return async () => {
      clearInterval(timer);
      await flush().catch(() => undefined);
    };
  }

  return {
    note,
    flush,
    stats: () => ({
      noted,
      pending: pending.size,
      flushes,
      flushFailures,
      dropped,
    }),
    start,
    resetForTests() {
      pending = new Map();
      stored = new Set();
      storedDay = "";
      flushing = false;
      noted = 0;
      flushes = 0;
      flushFailures = 0;
      dropped = 0;
    },
  };
}

export const userActivity = createUserActivityRecorder();

// ---------------------------------------------------------------------------
// The report.

export interface ActivityDayRow {
  day: string;
  /** Opened the app or posted. Null where the window predates tracking. */
  dau: number | null;
  wau: number | null;
  mau: number | null;
  /** Sent at least one message. The whole history. */
  postedDau: number;
  postedWau: number;
  postedMau: number;
}

/** One bracket of one cohort: how many had the chance, how many came back. */
export interface CohortBracket {
  /** Members whose bracket has fully elapsed. */
  eligible: number;
  /** Of those, how many sent a message in it. */
  posted: number;
  /** Members whose bracket elapsed after tracking started. */
  activeEligible: number;
  /** Of those, how many opened the app or posted in it. */
  active: number;
}

export interface SignupCohort {
  /** Monday of the signup week, São Paulo. */
  week: string;
  size: number;
  d1: CohortBracket;
  d7: CohortBracket;
  d30: CohortBracket;
}

export interface UserActivityReport {
  generatedAt: string;
  timezone: string;
  /** Today, São Paulo. Its row is a partial day. */
  today: string;
  /** First day `user_activity_days` holds anything, or null. */
  trackingSince: string | null;
  days: ActivityDayRow[];
  /** Bracket definitions, in days after the signup day (day 0). */
  brackets: { d1: [number, number]; d7: [number, number]; d30: [number, number] };
  cohorts: SignupCohort[];
  recorder: UserActivityRecorderStats;
}

export const ACTIVITY_BRACKETS = {
  d1: [1, 1],
  d7: [7, 13],
  d30: [30, 36],
} as const satisfies Record<string, readonly [number, number]>;

export function clampActivityDays(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return 90;
  }
  return Math.min(180, Math.max(14, Math.floor(n)));
}

export function clampCohortWeeks(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return 12;
  }
  return Math.min(26, Math.max(4, Math.floor(n)));
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Every (account, day) that was active, with whether a message was part of
 * it, from `$1` (a date) onward. Humans only. Shared by both queries so the
 * definition of "active" lives in one place.
 */
const ACTIVE_ROWS_SQL = `
  active AS (
    SELECT user_id, day, bool_or(posted) AS posted
      FROM (
        SELECT a.user_id, a.day, FALSE AS posted
          FROM user_activity_days a
         WHERE a.day >= $1::date
        UNION ALL
        SELECT m.author_id, (m.created_at AT TIME ZONE '${ACTIVITY_TIMEZONE}')::date, TRUE
          FROM messages m
         WHERE m.created_at >= ($1::date)::timestamp AT TIME ZONE '${ACTIVITY_TIMEZONE}'
      ) raw
      JOIN users u ON u.id = raw.user_id
     WHERE NOT u.is_webhook AND NOT u.is_character
     GROUP BY user_id, day
  )`;

async function readSeries(
  pool: Pick<Pool, "query">,
  firstDay: string,
  lastDay: string,
): Promise<
  {
    day: string;
    dau: number;
    wau: number;
    mau: number;
    posted_dau: number;
    posted_wau: number;
    posted_mau: number;
  }[]
> {
  const result = await pool.query(
    `WITH ${ACTIVE_ROWS_SQL},
     series AS (
       SELECT d::date AS day
         FROM generate_series($2::date, $3::date, interval '1 day') d
     )
     SELECT to_char(s.day, 'YYYY-MM-DD') AS day,
            COUNT(DISTINCT a.user_id) FILTER (WHERE a.day = s.day)::int AS dau,
            COUNT(DISTINCT a.user_id) FILTER (WHERE a.day > s.day - 7)::int AS wau,
            COUNT(DISTINCT a.user_id)::int AS mau,
            COUNT(DISTINCT a.user_id)
              FILTER (WHERE a.day = s.day AND a.posted)::int AS posted_dau,
            COUNT(DISTINCT a.user_id)
              FILTER (WHERE a.day > s.day - 7 AND a.posted)::int AS posted_wau,
            COUNT(DISTINCT a.user_id) FILTER (WHERE a.posted)::int AS posted_mau
       FROM series s
       LEFT JOIN active a ON a.day BETWEEN s.day - 29 AND s.day
      GROUP BY s.day
      ORDER BY s.day`,
    [addDays(firstDay, -29), firstDay, lastDay],
  );
  return result.rows;
}

async function readCohorts(
  pool: Pick<Pool, "query">,
  firstWeek: string,
  today: string,
  trackingSince: string | null,
): Promise<Record<string, string | number>[]> {
  const { d1, d7, d30 } = ACTIVITY_BRACKETS;
  // A bracket counts only once its last day is over (strictly before today),
  // the same rule as the existing "exclude the last 24h": somebody who signed
  // up yesterday has not failed to come back on day seven. The "active"
  // measure additionally needs the whole bracket inside the tracked period.
  const bracket = (name: string, [from, to]: readonly [number, number]) => `
    COUNT(*) FILTER (WHERE signup_day + ${to} < $2::date)::int AS ${name}_eligible,
    COUNT(*) FILTER (WHERE signup_day + ${to} < $2::date AND ${name}_posted)::int AS ${name}_posted,
    COUNT(*) FILTER (WHERE signup_day + ${to} < $2::date
                       AND signup_day + ${from} >= $3::date)::int AS ${name}_active_eligible,
    COUNT(*) FILTER (WHERE signup_day + ${to} < $2::date
                       AND signup_day + ${from} >= $3::date
                       AND ${name}_active)::int AS ${name}_active`;
  const flags = (name: string, [from, to]: readonly [number, number]) => `
    COALESCE(bool_or(a.day BETWEEN c.signup_day + ${from} AND c.signup_day + ${to}), FALSE) AS ${name}_active,
    COALESCE(bool_or(a.posted AND a.day BETWEEN c.signup_day + ${from} AND c.signup_day + ${to}), FALSE) AS ${name}_posted`;
  const result = await pool.query(
    `WITH ${ACTIVE_ROWS_SQL},
     cohort AS (
       SELECT u.id, (u.created_at AT TIME ZONE '${ACTIVITY_TIMEZONE}')::date AS signup_day
         FROM users u
        WHERE NOT u.is_webhook AND NOT u.is_character
          AND u.created_at >= ($1::date)::timestamp AT TIME ZONE '${ACTIVITY_TIMEZONE}'
     ),
     per_user AS (
       SELECT c.id, c.signup_day,
              ${flags("d1", d1)},
              ${flags("d7", d7)},
              ${flags("d30", d30)}
         FROM cohort c
         LEFT JOIN active a
           ON a.user_id = c.id
          AND a.day BETWEEN c.signup_day + 1 AND c.signup_day + ${d30[1]}
        GROUP BY c.id, c.signup_day
     )
     SELECT to_char(date_trunc('week', signup_day)::date, 'YYYY-MM-DD') AS week,
            COUNT(*)::int AS size,
            ${bracket("d1", d1)},
            ${bracket("d7", d7)},
            ${bracket("d30", d30)}
       FROM per_user
      GROUP BY 1
      ORDER BY 1`,
    // No tracking yet: a date nothing can reach, so every "active" bracket
    // is ineligible rather than read as zero.
    [firstWeek, today, trackingSince ?? "9999-12-31"],
  );
  return result.rows;
}

function toBracket(row: Record<string, string | number>, name: string): CohortBracket {
  return {
    eligible: Number(row[`${name}_eligible`] ?? 0),
    posted: Number(row[`${name}_posted`] ?? 0),
    activeEligible: Number(row[`${name}_active_eligible`] ?? 0),
    active: Number(row[`${name}_active`] ?? 0),
  };
}

export async function computeUserActivityReport(
  query: { days: number; weeks: number },
  options: { now?: number; pool?: Pick<Pool, "query"> } = {},
): Promise<UserActivityReport> {
  const pool = options.pool ?? getPool();
  const nowMs = options.now ?? Date.now();
  const today = activityDay(nowMs);
  const firstDay = addDays(today, -(query.days - 1));

  // The day AFTER the first row. The deploy that started tracking landed
  // partway through its day, so that day missed everybody who came before it
  // and would read as a jump in actives the next morning.
  const since = await pool.query<{ first: string | null }>(
    `SELECT to_char(MIN(day) + 1, 'YYYY-MM-DD') AS first FROM user_activity_days`,
  );
  const trackingSince = since.rows[0]?.first ?? null;

  // Monday of the week `weeks - 1` weeks before this one.
  const todayDate = new Date(`${today}T12:00:00Z`);
  const mondayOffset = (todayDate.getUTCDay() + 6) % 7;
  const firstWeek = addDays(today, -mondayOffset - 7 * (query.weeks - 1));

  // One after the other: this should never hold two pooled connections.
  const series = await readSeries(pool, firstDay, today);
  const cohorts = await readCohorts(pool, firstWeek, today, trackingSince);

  // A window counts for "active" only when it starts on or after the first
  // tracked day; before that it would silently be message-only.
  const tracked = (windowStart: string) =>
    trackingSince !== null && windowStart >= trackingSince;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    timezone: ACTIVITY_TIMEZONE,
    today,
    trackingSince,
    days: series.map((row) => ({
      day: row.day,
      dau: tracked(row.day) ? row.dau : null,
      wau: tracked(addDays(row.day, -6)) ? row.wau : null,
      mau: tracked(addDays(row.day, -29)) ? row.mau : null,
      postedDau: row.posted_dau,
      postedWau: row.posted_wau,
      postedMau: row.posted_mau,
    })),
    brackets: {
      d1: [...ACTIVITY_BRACKETS.d1],
      d7: [...ACTIVITY_BRACKETS.d7],
      d30: [...ACTIVITY_BRACKETS.d30],
    },
    cohorts: cohorts.map((row) => ({
      week: String(row.week),
      size: Number(row.size),
      d1: toBracket(row, "d1"),
      d7: toBracket(row, "d7"),
      d30: toBracket(row, "d30"),
    })),
    recorder: userActivity.stats(),
  };
}

/**
 * The report behind the dashboard, cached for five minutes with the read in
 * flight shared. The two queries scan up to half a year of messages, which is
 * fine once in a while and wasteful on every open of the tab.
 */
const REPORT_TTL_MS = 5 * 60_000;
const reportCache = new Map<
  string,
  { at: number; report: Promise<UserActivityReport> }
>();

export function userActivityReport(query: {
  days: number;
  weeks: number;
}): Promise<UserActivityReport> {
  const key = `${query.days}|${query.weeks}`;
  const cached = reportCache.get(key);
  const at = Date.now();
  if (cached && at - cached.at < REPORT_TTL_MS) {
    return cached.report;
  }
  const report = computeUserActivityReport(query);
  reportCache.set(key, { at, report });
  // A failed read is not cached: the next open of the tab retries.
  report.catch(() => {
    if (reportCache.get(key)?.report === report) {
      reportCache.delete(key);
    }
  });
  return report;
}

export function resetUserActivityReportCache(): void {
  reportCache.clear();
}

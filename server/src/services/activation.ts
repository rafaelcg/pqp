import { getPool } from "../db.js";

/**
 * The activation funnel: the ordered steps a new account moves through, the
 * one function that stamps them, and the cohort report the operator dashboard
 * and Grafana read.
 *
 * WHY IN-HOUSE. This is authoritative and free: the timestamps live in our own
 * Postgres, next to the accounts they describe, and the counts ride on the
 * admin-metrics snapshot the operator dashboard already polls. It is NOT a
 * replacement for a product-analytics tool -- it cannot answer an ad-hoc "of the
 * people who joined a community but never sent a message, how many linked
 * Steam" -- but it does not try to. It answers the one question that has to be
 * always-on and never sampled: how many of the people who signed up reached
 * each step, and where the drop-off is.
 *
 * THE SEAM (`recordActivationStep`). Every step is stamped through this one
 * function. Today it writes a row. The day a per-user event sink is wanted
 * (PostHog, or anything else that answers cohort/retention questions this
 * aggregate cannot), it plugs in HERE -- one `capture(userId, step)` beside the
 * write, with no fire site touched. See docs/MONITORING.md "Adding PostHog
 * later". The fire sites are deliberately dumb: they call this and move on.
 */

/**
 * The steps, in funnel order. The ORDER is the funnel -- each step's count is
 * read against the one before it to get the drop-off -- so do not reorder these
 * without meaning to reorder the funnel. The string is the public event name (a
 * future `capture()` would send exactly these); the column it maps to is in
 * `STEP_COLUMN` below.
 */
export const ACTIVATION_STEPS = [
  "signup",
  "age_gate",
  "handle",
  "first_join",
  "first_message",
  "first_voice",
  "first_watch_party",
] as const;

export type ActivationStep = (typeof ACTIVATION_STEPS)[number];

/**
 * step -> the `user_activation` column it stamps. A fixed, code-owned map: it
 * is never derived from user input, which is what makes interpolating the
 * column name into the SQL in `recordActivationStep` safe. Adding a step means
 * adding it here, to `ACTIVATION_STEPS`, to the table in schema.sql, and to the
 * report below -- the type system flags the first three if you miss one.
 */
const STEP_COLUMN: Record<ActivationStep, string> = {
  signup: "signup_at",
  age_gate: "age_gate_at",
  handle: "handle_at",
  first_join: "first_join_at",
  first_message: "first_message_at",
  first_voice: "first_voice_at",
  first_watch_party: "first_watch_party_at",
};

/**
 * In-process memo of `${userId}:${step}` pairs this process has already stamped
 * successfully, so a repeat call short-circuits before touching Postgres.
 *
 * WHY IT EXISTS. `first_message` and `first_voice` are wired into hot paths -- a
 * WS send, a voice join, a watch party that runs several hundred joins in an
 * evening. The DB write is a single indexed upsert that no-ops after the first
 * time (the ON CONFLICT below keeps the earliest timestamp), which is cheap,
 * but "cheap" is still a round trip per message. This makes the steady state
 * free: after a user's first message on this process, every later message
 * skips the query entirely. The DB upsert remains the real idempotency
 * guarantee -- this is only a cost optimisation, and it is correct to lose it on
 * a restart or across instances, because the upsert catches those.
 *
 * A key is added ONLY after a successful write, so a failed write is retried
 * rather than silently memoised as done. Bounded: cleared wholesale when it
 * grows past the cap (the worst that costs is a few redundant no-op upserts as
 * it refills), which needs no per-entry bookkeeping.
 */
const STAMPED_MEMO_MAX = 200_000;
const stampedMemo = new Set<string>();

/** Test hook: forget what this process has stamped, so a re-stamp hits the DB. */
export function resetActivationMemo(): void {
  stampedMemo.clear();
}

/**
 * Stamp `step` for `userId` the first time it happens, idempotently.
 *
 * Never throws and never blocks the caller's own work: a funnel stamp is
 * telemetry, and a telemetry write must not be able to fail a message send or a
 * voice join. Errors are swallowed with a log line. Callers `await` it (the
 * memo makes that a no-op after the first stamp), so tests are deterministic,
 * but a caller on the very hottest path may `void` it just as safely.
 *
 * The write is one statement: insert the row stamping this step, or, if the row
 * exists, set this step's column only when it is still NULL. `COALESCE(existing,
 * now())` keeps the earlier timestamp, so the FIRST occurrence wins and every
 * later call leaves the value untouched -- that is the whole idempotency
 * contract, and it holds across instances and restarts because it lives in the
 * row, not in this process.
 */
export async function recordActivationStep(
  userId: string,
  step: ActivationStep,
): Promise<void> {
  const key = `${userId}:${step}`;
  if (stampedMemo.has(key)) {
    return;
  }
  const column = STEP_COLUMN[step];
  try {
    await getPool().query(
      `INSERT INTO user_activation (user_id, ${column})
            VALUES ($1, now())
       ON CONFLICT (user_id) DO UPDATE
            SET ${column} = COALESCE(user_activation.${column}, EXCLUDED.${column})`,
      [userId],
    );
    if (stampedMemo.size >= STAMPED_MEMO_MAX) {
      stampedMemo.clear();
    }
    stampedMemo.add(key);
  } catch (error) {
    // Telemetry never breaks the surrounding action. `[activation]` + `failed`
    // so the error heartbeat (scripts/monitor/errors.mjs) still sees it.
    console.error(`[activation] failed to stamp ${step} for a user:`, error);
  }
}

/** How many of a signup cohort reached each step. Aggregate only, never a person. */
export interface ActivationStepCounts {
  /** The cohort size: accounts whose `signup_at` falls in the window. */
  signup: number;
  ageGate: number;
  handle: number;
  firstJoin: number;
  firstMessage: number;
  firstVoice: number;
  firstWatchParty: number;
}

/**
 * The funnel, bounded and aggregate-only.
 *
 * A window's cohort is "accounts whose `signup_at` is within the last N days".
 * Each step counts the members of that cohort who have reached the step at any
 * time since -- steps only ever happen after signup, so a step is always <= the
 * step before it, and `step / signup` is a real conversion. A recent cohort's
 * later steps are still filling in, which is the normal shape of a funnel and
 * not a bug: read the 30-day cohort for a settled picture and the 7-day one for
 * a recent-trend read.
 */
export interface ActivationFunnel {
  window7d: ActivationStepCounts;
  window30d: ActivationStepCounts;
  /**
   * Step-to-step conversion for the 30-day cohort, each a share (0..1) of the
   * PREVIOUS step, plus the headline `signupToFirstMessage` (signup -> first
   * message, the closest thing to "this account became a real user"). Rounded
   * to three places; the counts above are the source of truth. Precomputed so
   * the dashboard and the one alert do not each re-derive it. A denominator of
   * zero yields 0, not a divide-by-zero.
   */
  conversion30d: {
    signupToAgeGate: number;
    ageGateToHandle: number;
    handleToFirstJoin: number;
    firstJoinToFirstMessage: number;
    firstMessageToFirstVoice: number;
    firstVoiceToFirstWatchParty: number;
    signupToFirstMessage: number;
  };
}

interface FunnelRow {
  s7: string;
  ag7: string;
  h7: string;
  j7: string;
  m7: string;
  v7: string;
  w7: string;
  s30: string;
  ag30: string;
  h30: string;
  j30: string;
  m30: string;
  v30: string;
  w30: string;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Math.round((numerator / denominator) * 1000) / 1000;
}

/**
 * Read the funnel for the 7- and 30-day signup cohorts in one round trip.
 *
 * One `user_activation` scan, bounded by the partial `idx_user_activation_signup`
 * index because every count is gated on `signup_at` being in a window. Cheap
 * enough to sit inside the 30-second admin-metrics snapshot beside `acquisition`
 * and `retention`, which answer the neighbouring questions.
 */
export async function activationFunnel(): Promise<ActivationFunnel> {
  const result = await getPool().query<FunnelRow>(
    `SELECT
       COUNT(*) FILTER (WHERE signup_at >= now() - interval '7 days')                                      AS s7,
       COUNT(*) FILTER (WHERE signup_at >= now() - interval '7 days' AND age_gate_at IS NOT NULL)           AS ag7,
       COUNT(*) FILTER (WHERE signup_at >= now() - interval '7 days' AND handle_at IS NOT NULL)             AS h7,
       COUNT(*) FILTER (WHERE signup_at >= now() - interval '7 days' AND first_join_at IS NOT NULL)         AS j7,
       COUNT(*) FILTER (WHERE signup_at >= now() - interval '7 days' AND first_message_at IS NOT NULL)      AS m7,
       COUNT(*) FILTER (WHERE signup_at >= now() - interval '7 days' AND first_voice_at IS NOT NULL)        AS v7,
       COUNT(*) FILTER (WHERE signup_at >= now() - interval '7 days' AND first_watch_party_at IS NOT NULL)  AS w7,
       COUNT(*) FILTER (WHERE signup_at >= now() - interval '30 days')                                      AS s30,
       COUNT(*) FILTER (WHERE signup_at >= now() - interval '30 days' AND age_gate_at IS NOT NULL)          AS ag30,
       COUNT(*) FILTER (WHERE signup_at >= now() - interval '30 days' AND handle_at IS NOT NULL)            AS h30,
       COUNT(*) FILTER (WHERE signup_at >= now() - interval '30 days' AND first_join_at IS NOT NULL)        AS j30,
       COUNT(*) FILTER (WHERE signup_at >= now() - interval '30 days' AND first_message_at IS NOT NULL)     AS m30,
       COUNT(*) FILTER (WHERE signup_at >= now() - interval '30 days' AND first_voice_at IS NOT NULL)       AS v30,
       COUNT(*) FILTER (WHERE signup_at >= now() - interval '30 days' AND first_watch_party_at IS NOT NULL) AS w30
     FROM user_activation`,
  );
  const row = result.rows[0];
  const window7d: ActivationStepCounts = {
    signup: Number(row?.s7 ?? 0),
    ageGate: Number(row?.ag7 ?? 0),
    handle: Number(row?.h7 ?? 0),
    firstJoin: Number(row?.j7 ?? 0),
    firstMessage: Number(row?.m7 ?? 0),
    firstVoice: Number(row?.v7 ?? 0),
    firstWatchParty: Number(row?.w7 ?? 0),
  };
  const window30d: ActivationStepCounts = {
    signup: Number(row?.s30 ?? 0),
    ageGate: Number(row?.ag30 ?? 0),
    handle: Number(row?.h30 ?? 0),
    firstJoin: Number(row?.j30 ?? 0),
    firstMessage: Number(row?.m30 ?? 0),
    firstVoice: Number(row?.v30 ?? 0),
    firstWatchParty: Number(row?.w30 ?? 0),
  };
  return {
    window7d,
    window30d,
    conversion30d: {
      signupToAgeGate: ratio(window30d.ageGate, window30d.signup),
      ageGateToHandle: ratio(window30d.handle, window30d.ageGate),
      handleToFirstJoin: ratio(window30d.firstJoin, window30d.handle),
      firstJoinToFirstMessage: ratio(window30d.firstMessage, window30d.firstJoin),
      firstMessageToFirstVoice: ratio(window30d.firstVoice, window30d.firstMessage),
      firstVoiceToFirstWatchParty: ratio(
        window30d.firstWatchParty,
        window30d.firstVoice,
      ),
      signupToFirstMessage: ratio(window30d.firstMessage, window30d.signup),
    },
  };
}

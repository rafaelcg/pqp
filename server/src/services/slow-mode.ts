import { getPool } from "../db.js";
import { SLOWMODE_SECONDS_MAX } from "@pqp/shared";

/**
 * Slow mode's clock, in Postgres rather than in this process.
 *
 * The first version of this kept one token bucket per interval in a module
 * `Map`, keyed by channel + user. That is correct on one machine and wrong on
 * two: `pqp-api` is heading for a second replica, module state is per process,
 * and a sender whose two requests land on different machines would get two
 * sends out of a one-send budget. Worse, it fails *quietly* -- the wait looks
 * enforced right up until the moment there is a second machine, which is
 * exactly the "working and silently-not-working look identical" shape this
 * codebase keeps getting bitten by.
 *
 * So the state is a row. `channel_slowmode_sends` holds one `last_sent_at` per
 * (channel, sender), and the interval is compared against it at check time
 * rather than baked into a stored deadline -- so lowering a channel from ten
 * minutes to five seconds frees everyone immediately instead of leaving the
 * room held under the old number.
 *
 * The cluster bus was the other candidate and is the wrong tool: it is
 * documented as ephemeral fan-out where "a frame lost to a bus outage costs a
 * live update, never data". A dropped frame here would cost enforcement.
 *
 * Under a race the single statement below decides it. `ON CONFLICT DO UPDATE`
 * takes a row lock, so two concurrent sends from the same person serialise:
 * the second re-evaluates its `WHERE` against the row the first just wrote,
 * finds the interval unspent, updates nothing and is refused. A first-ever
 * send races on the unique index instead, with the same outcome. Exactly one
 * of any two concurrent sends is charged, on one machine or on ten.
 */

export type SlowModeCharge =
  | { ok: true }
  | { ok: false; retryAfterMs: number };

/**
 * Claim this sender's turn in the channel. Returns `ok` when the wait had
 * already elapsed (and marks the clock as spent from now), otherwise the
 * milliseconds still left.
 *
 * Call this as late as possible, immediately before the row is written: every
 * other refusal -- no access, no SEND_MESSAGES, a blocked DM, a reply pointing
 * at another channel -- must be decided first, so a message that fails for one
 * of those reasons does not also cost the sender their turn.
 */
export async function chargeSlowMode(
  channelId: string,
  userId: string,
  seconds: number,
): Promise<SlowModeCharge> {
  if (seconds <= 0) {
    return { ok: true };
  }
  const interval = Math.min(Math.floor(seconds), SLOWMODE_SECONDS_MAX);
  // The outer SELECT reads the table under the statement's own snapshot, so
  // it sees the row as it was *before* the CTE's write. On a refusal that is
  // the value the remaining wait has to be computed from; on a charge it is
  // ignored.
  const result = await getPool().query<{
    charged: boolean;
    retry_after_ms: string | number | null;
  }>(
    `WITH charged AS (
       INSERT INTO channel_slowmode_sends AS s (channel_id, user_id, last_sent_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (channel_id, user_id) DO UPDATE
         SET last_sent_at = NOW()
         WHERE s.last_sent_at <= NOW() - make_interval(secs => $3::int)
       RETURNING 1
     )
     SELECT
       EXISTS (SELECT 1 FROM charged) AS charged,
       (
         SELECT CEIL(
           EXTRACT(EPOCH FROM (
             s.last_sent_at + make_interval(secs => $3::int) - NOW()
           )) * 1000
         )
         FROM channel_slowmode_sends s
         WHERE s.channel_id = $1 AND s.user_id = $2
       ) AS retry_after_ms`,
    [channelId, userId, interval],
  );
  const row = result.rows[0];
  if (!row || row.charged) {
    return { ok: true };
  }
  const remaining = Number(row.retry_after_ms ?? 0);
  return {
    ok: false,
    // A clock that has already run out but lost the update race reports the
    // floor rather than zero, so a client never renders "wait 0s".
    retryAfterMs: Math.min(
      Math.max(Number.isFinite(remaining) ? remaining : 0, 1),
      SLOWMODE_SECONDS_MAX * 1000,
    ),
  };
}

/**
 * Give the turn back. Only for the narrow case where the charge succeeded and
 * the write then failed anyway, which leaves the sender with nothing posted
 * and no reason to wait. Deleting the row is exactly the state they were in a
 * moment earlier, because they had just passed the gate.
 */
export async function refundSlowMode(
  channelId: string,
  userId: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM channel_slowmode_sends WHERE channel_id = $1 AND user_id = $2`,
    [channelId, userId],
  );
}

/**
 * Drop clocks nobody is waiting on. A row is dead weight the moment its
 * interval has passed, and the ceiling is six hours, so anything older than a
 * day is certainly spent whatever the channel's setting has been changed to
 * since. Disk hygiene only: enforcement reads `last_sent_at` against the
 * channel's current interval, so a row this sweep never gets to is inert
 * rather than wrong.
 */
export async function sweepSlowModeClocks(): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM channel_slowmode_sends WHERE last_sent_at < NOW() - INTERVAL '1 day'`,
  );
  return result.rowCount ?? 0;
}

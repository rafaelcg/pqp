import { getPool } from "../db.js";
import { logEvent } from "../lib/log.js";
import { createAutomatedInstanceReport } from "./reports.js";

/**
 * TELLING THE OPERATORS A BLOCK HAPPENED.
 *
 * A block is the one moderation act a user performs for themselves, and it used
 * to leave no trace anybody but the blocker could see. App Store guideline 1.2
 * asks that blocking "also notify the developer", so every NEW block does three
 * things, none of which can fail the block:
 *
 * 1. A structured log line, `social.block`, carrying two account ids and the
 *    surface the block came from. Never a message, never a name.
 * 2. A process counter (`blocks` on `GET /api/admin/metrics`).
 * 3. An entry in the INSTANCE report queue, reusing the automated-report
 *    machinery the image scanner files through: no reporter, reason `other`,
 *    place label "Bloqueio", one open ticket per blocked person. The queue's
 *    context card already says how many people blocked the account and shows
 *    its recent messages, so a second blocker adds to a number rather than to
 *    the pile. Resolving the ticket re-arms it.
 *
 * A block is not a report, and treating every one as an accusation would let one
 * account bury the queue by blocking everybody, so the queue entry is capped:
 * past `BLOCK_REPORTS_PER_DAY` new blocks from one account in a day, the block
 * is still logged and counted but files nothing.
 *
 * Its own file, not `blocks.ts`: reports.ts reaches stories and the Baú, which
 * import `blocks.ts` for their SQL fragments, and that would be a cycle.
 */
export const BLOCK_REPORTS_PER_DAY = 20;

/** The place label that marks a queue entry as filed by a block. */
export const BLOCK_REPORT_PLACE = "Bloqueio";

const blockStats = { blocks: 0, reportsFiled: 0, reportsCapped: 0, failures: 0 };

export interface BlockMetrics {
  /** New blocks (not repeats) since this process started. */
  blocks: number;
  /** Instance-queue tickets this process opened because of a block. */
  reportsFiled: number;
  /** Blocks that were counted but not queued: the blocker's daily cap. */
  reportsCapped: number;
  /** Operator notifications that threw. Belongs at zero. */
  failures: number;
}

export function blockMetrics(): BlockMetrics {
  return { ...blockStats };
}

export function resetBlockMetricsForTests(): void {
  blockStats.blocks = 0;
  blockStats.reportsFiled = 0;
  blockStats.reportsCapped = 0;
  blockStats.failures = 0;
}

export async function noteBlockForOperators(input: {
  blockerId: string;
  blockedUserId: string;
  /** Where in the app the block was made; free of user content. */
  surface?: string | null;
}): Promise<void> {
  blockStats.blocks += 1;
  let queued = false;
  let capped = false;
  try {
    // A durable per-account, per-UTC-day counter, bumped atomically for every
    // new block. Counting `user_blocks` rows would let block/unblock cycles
    // reset the cap, because an unblock deletes the row.
    const today = await getPool().query<{ n: number }>(
      `INSERT INTO user_block_days (user_id, day, n)
       VALUES ($1, (NOW() AT TIME ZONE 'UTC')::date, 1)
       ON CONFLICT (user_id, day) DO UPDATE SET n = user_block_days.n + 1
       RETURNING n`,
      [input.blockerId],
    );
    // A few days of history is plenty; the table stays a handful of rows.
    await getPool().query(
      `DELETE FROM user_block_days
       WHERE user_id = $1 AND day < (NOW() AT TIME ZONE 'UTC')::date - 7`,
      [input.blockerId],
    );
    if ((today.rows[0]?.n ?? 0) > BLOCK_REPORTS_PER_DAY) {
      capped = true;
      blockStats.reportsCapped += 1;
    } else {
      queued = await createAutomatedInstanceReport({
        reportedUserId: input.blockedUserId,
        placeLabel: BLOCK_REPORT_PLACE,
        reason: "other",
        details:
          "Bloqueado por outro usuário (aviso automático, ninguém abriu denúncia). " +
          "O contexto mostra quantas pessoas bloquearam esta conta e as mensagens recentes dela.",
      });
      if (queued) {
        blockStats.reportsFiled += 1;
      }
    }
  } catch (error) {
    blockStats.failures += 1;
    console.error(
      "[blocks] operator notification failed:",
      error instanceof Error ? error.message : error,
    );
  }
  logEvent("social.block", {
    blocker: input.blockerId,
    blocked: input.blockedUserId,
    surface: input.surface ?? null,
    queued,
    capped,
  });
}

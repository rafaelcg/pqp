import { getPool } from "../db.js";
import { INSTANCE_ID } from "./bus.js";

/**
 * "RUN THIS ON EXACTLY ONE PROCESS, THIS TICK."
 *
 * Every `setInterval` at the top of `index.ts` runs on every process that
 * loads the entry point. On one machine that is the same thing as running
 * once. On two API machines plus a worker it is three times, and for a timer
 * that WRITES a sample the difference is not cosmetic: `status_samples` got a
 * row per process per minute, so uptime was averaged over three probes of
 * which only one machine's outage was visible, and a blip on one machine read
 * as a service that was two thirds up.
 *
 * The honest fix for a periodic job is a lease, not a role check. A role check
 * (`runsColdJobs`) is a good first gate — it stops the query happening at all
 * on a process that has no business doing the work — but it is configuration,
 * and configuration is exactly what is wrong when a deployment sets
 * `WORKER_MODE` on neither machine. So the callers do both: the role decides
 * whether to ASK, and this decides who WINS.
 *
 * Atomic in one statement. `ON CONFLICT DO UPDATE ... WHERE` takes the row
 * lock, re-reads the committed row, and only then evaluates the predicate, so
 * two processes arriving in the same millisecond cannot both be handed the
 * tick: the loser's UPDATE finds a lease that is no longer expired and
 * returns nothing.
 */
export async function claimSingletonTick(
  key: string,
  ttlMs: number,
  claimedBy: string = INSTANCE_ID,
): Promise<boolean> {
  const result = await getPool().query(
    `INSERT INTO singleton_leases AS l (key, claimed_until, claimed_by)
     VALUES ($1, NOW() + ($2::bigint * INTERVAL '1 millisecond'), $3)
     ON CONFLICT (key) DO UPDATE
       SET claimed_until = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
           claimed_by = $3,
           claimed_at = NOW()
       WHERE l.claimed_until < NOW()
     RETURNING 1`,
    [key, Math.max(1, Math.round(ttlMs)), claimedBy],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * A claim that must never stop the job on a database it cannot reach.
 *
 * A status probe whose lease query failed should still run somewhere, and
 * "somewhere" with a broken database is "everywhere" — duplicate samples are
 * noise, a missing sample is a hole in the uptime history that can never be
 * filled in afterwards. Fails open, and says so.
 */
export async function claimSingletonTickOrRun(
  key: string,
  ttlMs: number,
): Promise<boolean> {
  try {
    return await claimSingletonTick(key, ttlMs);
  } catch {
    return true;
  }
}

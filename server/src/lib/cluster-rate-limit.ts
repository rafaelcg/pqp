import { getPool } from "../db.js";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";

/**
 * THE TWO HONEST ANSWERS TO "THIS LIMIT IS PER PROCESS".
 *
 * `lib/rate-limit.ts` is in-memory on purpose and its banner explains at
 * length why: a token bucket needs an atomic decrement, and paying a round
 * trip for one on every chat message and every keystroke costs more than the
 * limit is worth. That reasoning is about the HOT limiters. It says nothing
 * about the handful of budgets that are small, rare, and loud, and those are
 * the ones where "per process" is a real defect rather than a footnote: with
 * two machines a user with a tab on each gets two full buckets.
 *
 * So there are two shapes here, and which one a limiter gets is a judgement
 * about its traffic, not a default:
 *
 *  1. `sharedRateLimit` — ONE bucket in Postgres, spent atomically. For the
 *     destructive, low-frequency, user-keyed actions where the cluster total
 *     has to be the number in the config. One round trip per call, which is
 *     affordable precisely because the call is rare. Ringing a DM is the
 *     case it was written for: five rings per five minutes is a budget that
 *     means something to the person being buzzed, and ten is not.
 *
 *  2. `clusterCapacity` — the in-memory bucket, with its capacity DIVIDED by
 *     the number of live instances. Cheap, synchronous, approximate. For a
 *     limiter that is consulted on a per-frame path (a seek scrub emits
 *     continuously while a thumb is down) and, crucially, one that REFUSES
 *     nothing: the watch-party and music write budgets are spent by every
 *     write and only decide whether a position-only update is worth a
 *     fan-out. Dividing there costs a slightly choppier scrub in the worst
 *     case and nothing at all in the common one. Dividing a budget that
 *     refuses would be a regression, because a user holds their socket on
 *     ONE machine and would simply get half the budget they had.
 *
 * Neither is on the cluster bus. Pub/sub is eventually consistent; a burst
 * gets through while it converges, which is the one thing a limit must not do.
 */

/** Live instances, refreshed by the heartbeat. 1 until told otherwise. */
let liveInstances = 1;

/**
 * Called by the voice-registry heartbeat (`voice/registry.ts`), which already
 * knows this number because it already reads the table. Never queried from a
 * limiter: a limiter must not be able to make a database call on a hot path.
 */
export function noteLiveInstanceCount(count: number): void {
  liveInstances = Math.max(1, Math.floor(count) || 1);
}

/** How many instances the last heartbeat saw. Exported for the metrics block. */
export function liveInstanceCount(): number {
  return liveInstances;
}

/** Test hook. */
export function resetLiveInstanceCount(): void {
  liveInstances = 1;
}

/**
 * An in-memory limiter whose budget is this process's SHARE of a cluster-wide
 * one. Re-read per call, so an instance appearing or going away is picked up
 * on the next heartbeat without restarting anything.
 *
 * `Math.ceil` and a floor of one token: the cluster total may exceed the
 * configured capacity by up to N-1 rather than round down to a budget nobody
 * can spend. For a limiter that coalesces rather than refuses, erring towards
 * "one more fan-out" is the right direction.
 */
export function createDividedRateLimiter(options: {
  capacity: number;
  refillPerSecond: number;
  idleTtlMs?: number;
  now?: () => number;
}): RateLimiter {
  let divisor = 0;
  let limiter: RateLimiter | null = null;
  const build = (n: number): RateLimiter => {
    divisor = n;
    return createRateLimiter({
      capacity: Math.max(1, Math.ceil(options.capacity / n)),
      refillPerSecond: Math.max(
        options.refillPerSecond / n,
        Number.EPSILON,
      ),
      idleTtlMs: options.idleTtlMs,
      now: options.now,
    });
  };
  const current = (): RateLimiter => {
    const n = liveInstances;
    if (!limiter || n !== divisor) {
      // Rebuilding drops the held buckets, which is the conservative
      // direction only when instances are LEAVING. It happens at most once
      // per topology change (a deploy), not per call.
      limiter = build(n);
    }
    return limiter;
  };
  return {
    take: (key, cost) => current().take(key, cost),
    retryAfter: (key) => current().retryAfter(key),
    reset: (key) => current().reset(key),
    size: () => current().size(),
  };
}

export interface SharedBucketOptions {
  /** Names the budget. The row key is `(bucket, subject)`. */
  bucket: string;
  capacity: number;
  refillPerSecond: number;
}

/**
 * Spend one token from the cluster's bucket for `subject`. True to proceed.
 *
 * ONE STATEMENT, and it has to be one statement. `ON CONFLICT DO UPDATE`
 * takes the row lock and re-reads the committed row before evaluating both
 * the `SET` and the trailing `WHERE`, so the refill and the decrement happen
 * inside the lock. Two machines spending the last token at the same instant
 * therefore serialise: the second one's predicate sees the first one's write
 * and declines. A read-then-write pair, or a CTE that reads its own snapshot,
 * would let both through — which is the whole reason this is not just the
 * in-memory bucket with a table behind it.
 *
 * FAILS OPEN. A database hiccup must not make it impossible to ring somebody;
 * the caller keeps its in-process limiter as the backstop, so failing open
 * here degrades to the per-machine behaviour this replaced rather than to no
 * limit at all.
 */
export async function sharedRateLimit(
  options: SharedBucketOptions,
  subject: string,
): Promise<boolean> {
  const { bucket, capacity, refillPerSecond } = options;
  const result = await getPool().query(
    `INSERT INTO rate_limit_buckets AS b (bucket, subject, tokens, updated_at)
     VALUES ($1, $2, $3::float8 - 1, NOW())
     ON CONFLICT (bucket, subject) DO UPDATE
       SET tokens = LEAST(
             $3::float8,
             b.tokens
               + EXTRACT(EPOCH FROM (NOW() - b.updated_at)) * $4::float8
           ) - 1,
           updated_at = NOW()
       WHERE LEAST(
             $3::float8,
             b.tokens
               + EXTRACT(EPOCH FROM (NOW() - b.updated_at)) * $4::float8
           ) >= 1
     RETURNING 1`,
    [bucket, subject, capacity, refillPerSecond],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Rows whose bucket has refilled carry no information; drop them so the table
 * is bounded by "subjects active in the last few minutes" rather than by
 * "subjects ever". Runs with the other cold jobs.
 */
export async function sweepRateLimitBuckets(): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM rate_limit_buckets
      WHERE updated_at < NOW() - INTERVAL '1 hour'`,
  );
  return result.rowCount ?? 0;
}

/** Test hook: wipe one bucket's rows. */
export async function resetSharedRateLimit(bucket: string): Promise<void> {
  await getPool().query(`DELETE FROM rate_limit_buckets WHERE bucket = $1`, [
    bucket,
  ]);
}

import { dbBreakerState } from "../db.js";
import { logEvent } from "../lib/log.js";

/**
 * How a post-commit notification keeps trying, in delays between attempts:
 * about two minutes of attempts, which outlasts the database breaker opening
 * and closing again and the 61 s outage of 2026-09-23 (CLAUDE.md pitfalls 17
 * and 18). Each delay is jittered by up to a quarter either way, so the retries
 * of many notifications do not all land on the database in the same instant.
 */
export const POST_COMMIT_RETRY_DELAYS_MS: readonly number[] = [
  150, 300, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000,
];

/**
 * While the database breaker is not closed an attempt would only fail fast, so
 * no attempt is spent: the retry waits, checking every `POLL_MS`, and goes on
 * once the database is back. That is the "retry after the dependency recovers"
 * part. The whole task is still bounded by `POST_COMMIT_RETRY_HORIZON_MS`.
 */
const POLL_MS = 2_000;

/**
 * How long one notification is kept trying in all. Past it (a database down
 * for this long is an incident, not a blip) the client's own refetch is the
 * recovery, as for any other lost hint: the message page on reload, and
 * `GET /api/servers/:id/app-sessions` on reconnect.
 */
export const POST_COMMIT_RETRY_HORIZON_MS = 10 * 60_000;

/**
 * How many notifications may be waiting to be retried at once on this process.
 * One more than that is not kept (logged as `apps.postCommitRetryDropped`), so
 * an outage during a busy minute holds a bounded number of timers and the
 * recovery replays a bounded number of reads.
 */
export const POST_COMMIT_RETRY_MAX_PENDING = 200;

export interface PostCommitRetryOptions {
  /** The log event for a failed attempt, for example `apps.timelineAnnounceFailed`. */
  event: string;
  /**
   * What is being retried, for example `card:<sessionId>`. A second retry for a
   * key already waiting is not started: the one waiting does the same work.
   */
  key: string;
  fields: Record<string, unknown>;
  delaysMs?: readonly number[];
  horizonMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  /** True while an attempt would only fail fast (the breaker is open or half-open). */
  databaseDown?: () => boolean;
}

const pending = new Set<string>();

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/** How many notifications are waiting to be retried on this process. */
export function pendingPostCommitRetries(): number {
  return pending.size;
}

/** Tests: forget every waiting retry (their loops still run to the end). */
export function resetPostCommitRetriesForTests(): void {
  pending.clear();
}

/**
 * Tries `attempt` again after each delay until it resolves, and never throws:
 * what it retries is a notification about a write that already committed, so a
 * failure is logged and must not undo or re-answer that write. Resolves true
 * once an attempt succeeded, false when it gave up or was not kept (the key is
 * already waiting, or `POST_COMMIT_RETRY_MAX_PENDING` are). The first attempt
 * runs after the first delay, so a caller that already tried once inline calls
 * this only after that try failed.
 */
export async function retryAfterCommit(
  attempt: () => Promise<void>,
  options: PostCommitRetryOptions,
): Promise<boolean> {
  if (pending.has(options.key)) return false;
  if (pending.size >= POST_COMMIT_RETRY_MAX_PENDING) {
    logEvent("apps.postCommitRetryDropped", { ...options.fields, key: options.key, pending: pending.size });
    return false;
  }
  const delays = options.delaysMs ?? POST_COMMIT_RETRY_DELAYS_MS;
  const horizon = options.horizonMs ?? POST_COMMIT_RETRY_HORIZON_MS;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const databaseDown = options.databaseDown ?? (() => dbBreakerState() !== "closed");
  const started = now();
  pending.add(options.key);
  try {
    for (let index = 0; index < delays.length; index += 1) {
      await sleep(Math.round(delays[index]! * (0.75 + random() * 0.5)));
      while (databaseDown()) {
        if (now() - started >= horizon) {
          logEvent(options.event, { ...options.fields, attempt: index + 1, final: true, error: "database still down" });
          return false;
        }
        await sleep(POLL_MS);
      }
      try {
        await attempt();
        return true;
      } catch (error) {
        logEvent(options.event, {
          ...options.fields,
          attempt: index + 1,
          final: index === delays.length - 1,
          error: String(error),
        });
      }
    }
    return false;
  } finally {
    pending.delete(options.key);
  }
}

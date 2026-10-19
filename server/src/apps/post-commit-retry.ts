import { logEvent } from "../lib/log.js";

/**
 * How long a post-commit notification keeps trying, in delays between attempts:
 * about two minutes in all. That outlasts the database breaker opening and
 * closing again and the 61 s outage of 2026-09-23 (CLAUDE.md pitfalls 17 and 18),
 * which is what a few retries 150 ms apart did not. Past it the client's own
 * refetch on reconnect (`GET /api/servers/:id/app-sessions`, the message page)
 * is the recovery, as for any other lost hint.
 */
export const POST_COMMIT_RETRY_DELAYS_MS: readonly number[] = [
  150, 300, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000,
];

export interface PostCommitRetryOptions {
  /** The log event for a failed attempt, for example `apps.timelineAnnounceFailed`. */
  event: string;
  fields: Record<string, unknown>;
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/**
 * Tries `attempt` again after each delay until it resolves, and never throws:
 * what it retries is a notification about a write that already committed, so a
 * failure is logged and must not undo or re-answer that write. Resolves true
 * once an attempt succeeded, false when every delay is spent. The first attempt
 * runs after the first delay, so a caller that already tried once inline calls
 * this only after that try failed.
 */
export async function retryAfterCommit(
  attempt: () => Promise<void>,
  options: PostCommitRetryOptions,
): Promise<boolean> {
  const delays = options.delaysMs ?? POST_COMMIT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? realSleep;
  for (let index = 0; index < delays.length; index += 1) {
    await sleep(delays[index]!);
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
}

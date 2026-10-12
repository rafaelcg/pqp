import { STORY_VIEWS_BATCH_MAX } from "@pqp/shared";
import { recordStoryViews } from "./api";

/**
 * Views waiting to reach the server, batched (design §3.2: "after 1 s on
 * screen, batched"). Module-level rather than inside the viewer, so a batch
 * still goes out after the viewer closes, and a failed write is put back and
 * retried with backoff instead of being dropped: the author's viewer list is
 * the one place a lost view would be noticed. The route is idempotent, so a
 * retry that races a write which did land costs nothing.
 */

const FLUSH_MS = 1_500;
const MAX_BACKOFF_MS = 60_000;

const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let failures = 0;

type Sender = (ids: readonly string[]) => Promise<unknown>;
let send: Sender = recordStoryViews;

function schedule(delay: number): void {
  if (timer !== null) {
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    void flushStoryViews();
  }, delay);
}

/**
 * Whose views are waiting. A view is sent with whatever account is signed in
 * when the batch goes out, so another account's pending views are dropped the
 * moment a different viewer queues one, never sent under the wrong name.
 */
let owner: string | null = null;

export function queueStoryViews(ids: Iterable<string>, viewerId: string): void {
  if (owner !== viewerId) {
    pending.clear();
    failures = 0;
    owner = viewerId;
  }
  for (const id of ids) {
    pending.add(id);
  }
  if (pending.size > 0) {
    schedule(FLUSH_MS);
  }
}

export async function flushStoryViews(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (inFlight || pending.size === 0) {
    return;
  }
  const batch = [...pending].slice(0, STORY_VIEWS_BATCH_MAX);
  for (const id of batch) {
    pending.delete(id);
  }
  inFlight = true;
  try {
    await send(batch);
    failures = 0;
  } catch {
    for (const id of batch) {
      pending.add(id);
    }
    failures += 1;
  } finally {
    inFlight = false;
  }
  if (pending.size > 0) {
    schedule(failures === 0 ? 0 : Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** (failures - 1)));
  }
}

/** Tests only. */
export function resetStoryViewsQueue(sender: Sender = recordStoryViews): void {
  pending.clear();
  if (timer !== null) {
    clearTimeout(timer);
  }
  timer = null;
  inFlight = false;
  failures = 0;
  owner = null;
  send = sender;
}

/** Tests only. */
export function pendingStoryViews(): string[] {
  return [...pending];
}

/**
 * Where a forum post opens (UX §2.4 #26): on the question for a first visit,
 * on the first reply the reader has not seen for a later one, and never on
 * the newest reply just because that is where a history page ends.
 *
 * History is read newest first, one page at a time, so a post longer than a
 * page opens with its question (or the reader's first unread reply) still
 * above the window. `backfillForLanding` pages backwards until the landing
 * point is in the window, then the transcript lands on it: the top of the
 * window for a first visit, the "Novas" divider for a revisit.
 *
 * Bounded: a post of thousands of replies stops after `maxPages` and lands at
 * the top of what it loaded, which is still the oldest unread it could reach
 * and never the newest reply.
 */

/** Older pages read at most before landing. A page is 50 messages. */
export const FORUM_LANDING_MAX_PAGES = 20;

export interface LandingHistory {
  /** Older messages exist above the loaded window. */
  hasMoreHistory(): boolean;
  /** Oldest loaded message first. */
  getMessages(): readonly { createdAt: string }[];
  /** Reads one older page; answers how many messages it added. */
  loadOlder(): Promise<number>;
}

/**
 * True while the landing point is above the window: a first visit (no
 * cursor) needs the very first message, a revisit needs a message at or
 * before the cursor so the first unread one is on screen with its divider.
 */
export function landingNeedsOlder(
  history: Pick<LandingHistory, "hasMoreHistory" | "getMessages">,
  previousReadAt: string | null,
): boolean {
  if (!history.hasMoreHistory()) {
    return false;
  }
  if (previousReadAt === null) {
    return true;
  }
  const oldest = history.getMessages()[0];
  return oldest === undefined || oldest.createdAt > previousReadAt;
}

/** Page backwards until the landing point is loaded. Answers the pages read. */
export async function backfillForLanding(
  history: LandingHistory,
  previousReadAt: string | null,
  options: { maxPages?: number; cancelled?: () => boolean } = {},
): Promise<number> {
  const maxPages = options.maxPages ?? FORUM_LANDING_MAX_PAGES;
  let pages = 0;
  while (pages < maxPages && landingNeedsOlder(history, previousReadAt)) {
    if (options.cancelled?.()) {
      return pages;
    }
    const added = await history.loadOlder();
    pages += 1;
    if (added === 0) {
      break;
    }
  }
  return pages;
}

import { describe, expect, it } from "vitest";
import {
  backfillForLanding,
  landingNeedsOlder,
  type LandingHistory,
} from "./forum-landing";

/** A post of `total` messages, one a minute, read newest first in pages. */
function fakeHistory(total: number, pageSize = 50) {
  const all = Array.from({ length: total }, (_, index) => ({
    createdAt: new Date(Date.UTC(2026, 9, 11, 0, index)).toISOString(),
  }));
  let start = Math.max(0, total - pageSize);
  let reads = 0;
  const history: LandingHistory & { reads: () => number } = {
    hasMoreHistory: () => start > 0,
    getMessages: () => all.slice(start),
    loadOlder: async () => {
      reads += 1;
      const next = Math.max(0, start - pageSize);
      const added = start - next;
      start = next;
      return added;
    },
    reads: () => reads,
  };
  return { history, all };
}

describe("where a post opens", () => {
  it("a first visit pages back to the question, however long the post", async () => {
    const { history, all } = fakeHistory(180);
    expect(landingNeedsOlder(history, null)).toBe(true);
    const pages = await backfillForLanding(history, null);
    expect(pages).toBe(3);
    expect(history.hasMoreHistory()).toBe(false);
    expect(history.getMessages()[0]).toBe(all[0]);
  });

  it("a short post reads nothing more", async () => {
    const { history } = fakeHistory(12);
    expect(await backfillForLanding(history, null)).toBe(0);
  });

  it("a revisit pages back only until the first unread reply is loaded", async () => {
    const { history, all } = fakeHistory(300);
    // Read up to message 100: the window must reach back past it.
    const cursor = all[100].createdAt;
    await backfillForLanding(history, cursor);
    const loaded = history.getMessages();
    expect(loaded[0].createdAt <= cursor).toBe(true);
    // ...and no further than it had to.
    expect(history.hasMoreHistory()).toBe(true);
    expect(history.reads()).toBe(3);
  });

  it("a revisit whose unread replies are already on the newest page reads nothing", async () => {
    const { history, all } = fakeHistory(300);
    expect(await backfillForLanding(history, all[290].createdAt)).toBe(0);
  });

  it("stops at the cap on a huge post, landing at the oldest it loaded, not the newest", async () => {
    const { history, all } = fakeHistory(5000);
    const pages = await backfillForLanding(history, null, { maxPages: 3 });
    expect(pages).toBe(3);
    expect(history.getMessages()[0]).toBe(all[5000 - 200]);
  });

  it("stops when the reader leaves", async () => {
    const { history } = fakeHistory(500);
    let left = false;
    const reading = backfillForLanding(history, null, { cancelled: () => left });
    left = true;
    expect(await reading).toBeLessThanOrEqual(1);
  });
});

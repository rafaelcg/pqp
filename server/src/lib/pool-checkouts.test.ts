import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHECKED_OUT_OVER_MS,
  STUCK_LOG_MIN_INTERVAL_MS,
  checkedOutCountForTests,
  noteCheckout,
  noteCheckoutQuery,
  noteRelease,
  poolCheckoutStats,
  resetPoolCheckoutsForTests,
  sweepStuckCheckouts,
} from "./pool-checkouts.js";

/**
 * The bookkeeping half of the 2026-09-17 fix, with no Postgres involved: the
 * pool events are simulated so the ages are exact. `db-pool-timeouts.test.ts`
 * proves the same module is actually wired to a real pool.
 */
describe("pool checkout ages", () => {
  beforeEach(() => {
    resetPoolCheckoutsForTests();
  });

  afterEach(() => {
    resetPoolCheckoutsForTests();
  });

  it("reports zeros when nothing is checked out", () => {
    expect(poolCheckoutStats()).toEqual({
      longestCheckoutMs: 0,
      checkedOutOver10s: 0,
    });
  });

  it("reports the oldest checkout and how many are past the threshold", () => {
    const now = 1_000_000;
    const young = {};
    const old = {};
    const older = {};
    noteCheckout(young, now - 500);
    noteCheckout(old, now - CHECKED_OUT_OVER_MS - 1);
    noteCheckout(older, now - 250_000);

    expect(poolCheckoutStats(now)).toEqual({
      longestCheckoutMs: 250_000,
      checkedOutOver10s: 2,
    });
  });

  it("forgets a checkout on release, which is how the numbers come back down", () => {
    const now = 1_000_000;
    const client = {};
    noteCheckout(client, now - 60_000);
    expect(poolCheckoutStats(now).longestCheckoutMs).toBe(60_000);

    noteRelease(client);
    expect(checkedOutCountForTests()).toBe(0);
    expect(poolCheckoutStats(now)).toEqual({
      longestCheckoutMs: 0,
      checkedOutOver10s: 0,
    });
  });

  it("logs the stuck checkout with the query text once it passes the threshold", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const now = 1_000_000;
      const client = {};
      noteCheckout(client, now - 40_000);
      noteCheckoutQuery(
        client,
        "SELECT   m.id,\n  m.body\n FROM messages m WHERE m.channel_id = $1",
      );

      // Not yet: 40s has not passed a 60s threshold.
      expect(sweepStuckCheckouts(60_000, now)).toBeNull();

      const fields = sweepStuckCheckouts(15_000, now);
      expect(fields).toMatchObject({
        ageMs: 40_000,
        thresholdMs: 15_000,
        checkedOut: 1,
        // Whitespace collapsed, so one stuck query is one greppable line.
        query: "SELECT m.id, m.body FROM messages m WHERE m.channel_id = $1",
      });
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("db.pool.stuckClient"),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("logs each stuck checkout at most once, and rate-limits the rest with a suppressed count", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const now = 1_000_000;
      const clients = [{}, {}, {}, {}];
      for (const client of clients) {
        noteCheckout(client, now - 100_000);
      }

      // First one through.
      expect(sweepStuckCheckouts(15_000, now)).not.toBeNull();
      // The same checkouts, swept again inside the window: no second line for
      // the one already reported, and none for the others either.
      expect(sweepStuckCheckouts(15_000, now + 1_000)).toBeNull();
      expect(sweepStuckCheckouts(15_000, now + 2_000)).toBeNull();
      expect(sweepStuckCheckouts(15_000, now + 3_000)).toBeNull();
      expect(log).toHaveBeenCalledTimes(1);

      // Past the window, one more client crosses. The three that were held
      // back are on the record as a count rather than lost.
      const later = now + STUCK_LOG_MIN_INTERVAL_MS + 1_000;
      const fresh = {};
      noteCheckout(fresh, later - 100_000);
      expect(sweepStuckCheckouts(15_000, later)).toMatchObject({
        suppressed: 3,
      });
      expect(log).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
    }
  });

  it("never throws out of a pool event, whatever it is handed", () => {
    expect(() => noteCheckout({})).not.toThrow();
    expect(() => noteCheckoutQuery({}, null)).not.toThrow();
    expect(() => noteRelease({})).not.toThrow();
    expect(() => sweepStuckCheckouts(15_000)).not.toThrow();
  });
});

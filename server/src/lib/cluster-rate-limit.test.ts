import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * A PER-USER BUDGET THAT SURVIVES TWO MACHINES, on a real Postgres.
 *
 * `lib/rate-limit.ts` is in-memory and says so at length: with N replicas a
 * per-user budget is N budgets. For a chat message that is a footnote. For a
 * ring it is the product: five rings per five minutes is a number aimed at the
 * person being buzzed, and a user with a tab on each machine got ten.
 *
 * The one thing worth testing here is the thing a single-process test cannot
 * see, so every case below spends the bucket from TWO callers — which is what
 * two instances are, since the table is the only state either of them has.
 * Pitfall 12's lesson in miniature: exercise the code path production runs.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const {
  createDividedRateLimiter,
  noteLiveInstanceCount,
  liveInstanceCount,
  resetLiveInstanceCount,
  sharedRateLimit,
  sweepRateLimitBuckets,
} = await import("./cluster-rate-limit.js");

describeDb("shared cluster rate limit", () => {
  const budget = { bucket: "test.ring", capacity: 5, refillPerSecond: 0.2 };
  let subject = "";

  beforeEach(async () => {
    await initDb();
    subject = randomUUID();
    await getPool().query(`DELETE FROM rate_limit_buckets WHERE bucket = $1`, [
      budget.bucket,
    ]);
  });

  afterAll(async () => {
    await closePool();
  });

  it("spends ONE budget across two instances, not one each", async () => {
    // Instance A takes three, instance B takes two: five between them, which
    // is the whole budget. The sixth is refused whichever machine asks.
    const a = [];
    for (let i = 0; i < 3; i += 1) {
      a.push(await sharedRateLimit(budget, subject));
    }
    const b = [];
    for (let i = 0; i < 3; i += 1) {
      b.push(await sharedRateLimit(budget, subject));
    }
    expect(a).toEqual([true, true, true]);
    // B's first two land inside the budget; its third is the sixth call.
    expect(b).toEqual([true, true, false]);
  });

  it("keeps subjects apart", async () => {
    const other = randomUUID();
    for (let i = 0; i < 5; i += 1) {
      expect(await sharedRateLimit(budget, subject)).toBe(true);
    }
    expect(await sharedRateLimit(budget, subject)).toBe(false);
    // A spent budget is one person's, never the bucket's.
    expect(await sharedRateLimit(budget, other)).toBe(true);
  });

  it("keeps buckets apart", async () => {
    for (let i = 0; i < 5; i += 1) {
      await sharedRateLimit(budget, subject);
    }
    expect(await sharedRateLimit(budget, subject)).toBe(false);
    expect(
      await sharedRateLimit({ ...budget, bucket: "test.other" }, subject),
    ).toBe(true);
    await getPool().query(`DELETE FROM rate_limit_buckets WHERE bucket = $1`, [
      "test.other",
    ]);
  });

  it("refills from the clock, not from a timer", async () => {
    // Nothing refills these buckets on a schedule: the spend statement
    // computes the refill from `updated_at` inside the row lock. Backdating
    // the row is therefore exactly equivalent to waiting.
    const fast = { bucket: "test.ring", capacity: 2, refillPerSecond: 1 };
    expect(await sharedRateLimit(fast, subject)).toBe(true);
    expect(await sharedRateLimit(fast, subject)).toBe(true);
    expect(await sharedRateLimit(fast, subject)).toBe(false);
    await getPool().query(
      `UPDATE rate_limit_buckets SET updated_at = NOW() - INTERVAL '2 seconds'
        WHERE bucket = $1 AND subject = $2`,
      [fast.bucket, subject],
    );
    expect(await sharedRateLimit(fast, subject)).toBe(true);
  });

  it("does not let concurrent takes exceed the budget", async () => {
    // Ten simultaneous calls on separate pool connections, which is as close
    // as one process gets to two machines arriving in the same millisecond.
    // A read-then-write limiter passes every other test above and fails this
    // one; the row lock in `ON CONFLICT DO UPDATE` is what makes it pass.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => sharedRateLimit(budget, subject)),
    );
    expect(results.filter(Boolean)).toHaveLength(budget.capacity);
  });

  it("sweeps only the rows that have gone quiet", async () => {
    await sharedRateLimit(budget, subject);
    const stale = randomUUID();
    await sharedRateLimit(budget, stale);
    await getPool().query(
      `UPDATE rate_limit_buckets SET updated_at = NOW() - INTERVAL '2 hours'
        WHERE bucket = $1 AND subject = $2`,
      [budget.bucket, stale],
    );
    await sweepRateLimitBuckets();
    const rows = await getPool().query<{ subject: string }>(
      `SELECT subject FROM rate_limit_buckets WHERE bucket = $1`,
      [budget.bucket],
    );
    expect(rows.rows.map((r) => r.subject)).toEqual([subject]);
  });
});

describe("divided capacity", () => {
  beforeEach(() => {
    resetLiveInstanceCount();
  });

  it("is the whole budget on one machine", () => {
    const limiter = createDividedRateLimiter({
      capacity: 15,
      refillPerSecond: 5,
    });
    let taken = 0;
    while (limiter.take("u1")) {
      taken += 1;
      if (taken > 40) break;
    }
    expect(taken).toBe(15);
  });

  it("is this machine's share on two", () => {
    noteLiveInstanceCount(2);
    const limiter = createDividedRateLimiter({
      capacity: 15,
      refillPerSecond: 5,
    });
    let taken = 0;
    while (limiter.take("u1")) {
      taken += 1;
      if (taken > 40) break;
    }
    // ceil(15 / 2): the cluster total may exceed 15 by one rather than round
    // down to a budget nobody can spend. This limiter refuses nothing, so
    // erring towards one more fan-out is the right direction.
    expect(taken).toBe(8);
  });

  it("follows the instance count without being rebuilt", () => {
    const limiter = createDividedRateLimiter({
      capacity: 10,
      refillPerSecond: 1,
    });
    expect(limiter.take("u1")).toBe(true);
    noteLiveInstanceCount(5);
    expect(liveInstanceCount()).toBe(5);
    let taken = 0;
    while (limiter.take("u1")) {
      taken += 1;
      if (taken > 20) break;
    }
    expect(taken).toBe(2);
  });

  it("never divides below one token", () => {
    noteLiveInstanceCount(9);
    const limiter = createDividedRateLimiter({
      capacity: 5,
      refillPerSecond: 0.2,
    });
    expect(limiter.take("u1")).toBe(true);
    expect(limiter.take("u1")).toBe(false);
  });
});

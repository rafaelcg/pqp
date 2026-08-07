import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The auth caches, pinned against unbounded growth.
 *
 * Both maps are keyed on the Clerk id and neither ever shrank on its own: an
 * expired entry was read through and overwritten on the owner's next request,
 * and deleted only on a profile edit. So the resident set was every account
 * that had *ever* signed in, not the ones online — roughly 73MB per 100k users,
 * on a process the deploy config deliberately never restarts. It never showed
 * up in testing because it needs thousands of distinct accounts to be visible.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
// The bypass is what lets this populate the cache with many distinct identities
// without a Clerk round trip per account.
process.env.DEV_AUTH_BYPASS = "true";

const { getPool, initDb, closePool } = await import("../db.js");
const { resolveAuthUser, sweepAuthCaches, authCacheSizes, clearAuthCaches } =
  await import("./clerk.js");

describeDb("auth cache sweeping", () => {
  beforeAll(async () => {
    await initDb();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    clearAuthCaches();
  });

  afterAll(async () => {
    await closePool();
  });

  /** Sign in as `count` distinct local identities. */
  async function signInMany(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await resolveAuthUser(`Bearer dev-local-token:cache${i}`);
    }
  }

  it("holds an entry per distinct identity", async () => {
    await signInMany(20);
    expect(authCacheSizes().users).toBe(20);
  });

  it("drops entries once their TTL has passed", async () => {
    await signInMany(20);
    expect(authCacheSizes().users).toBe(20);

    // The user TTL is 30s; sweep as if an hour has gone by.
    sweepAuthCaches(Date.now() + 60 * 60_000);
    expect(authCacheSizes().users).toBe(0);
  });

  it("keeps entries that are still live", async () => {
    await signInMany(5);
    sweepAuthCaches(Date.now());
    expect(authCacheSizes().users).toBe(5);
  });

  /**
   * The shape that actually leaked: people who sign in once and never come
   * back. Without a sweep the map only ever grows, because nothing they do
   * later would overwrite or delete their entry.
   */
  it("does not grow across rounds of one-time visitors", async () => {
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 10; i++) {
        await resolveAuthUser(`Bearer dev-local-token:r${round}u${i}`);
      }
      sweepAuthCaches(Date.now() + 60 * 60_000);
    }
    expect(authCacheSizes().users).toBe(0);
  });
});

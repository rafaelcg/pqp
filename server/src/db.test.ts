import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * A3.1's breaker guard, at the level the Farol review on PR #566 questioned:
 * does `pool.connect()` (and the `PoolClient` it hands back — every
 * transaction in `server/src/services/*.ts`) actually fast-reject the same
 * way `pool.query()` does, is `half-open` really a single recovery trial
 * and not a wide-open door, and does re-checking out a reused `PoolClient`
 * wrap it exactly once. `db-breaker-http.test.ts` already proves the HTTP
 * boundary for a `pool.query()`-backed route; this proves the lower-level
 * guard itself, including the `connect()`-based path that route doesn't
 * exercise. Real Postgres — a mocked `pg.Pool` would not exercise pg-pool's
 * own idle-client reuse, which is exactly what the idempotency test below
 * depends on.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const {
  getPool,
  initDb,
  closePool,
  forceDbBreakerStateForTests,
  resetDbBreakerForTests,
  DatabaseUnavailableError,
} = await import("./db.js");

describeDb("A3.1: guardPoolQueries covers connect() and half-open", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    resetDbBreakerForTests();
    await closePool();
  });

  beforeEach(() => {
    resetDbBreakerForTests();
  });

  afterEach(() => {
    resetDbBreakerForTests();
  });

  it("pool.connect() fast-rejects while the breaker is open, same as pool.query()", async () => {
    forceDbBreakerStateForTests("open");
    await expect(getPool().connect()).rejects.toBeInstanceOf(
      DatabaseUnavailableError,
    );
  });

  it("a client already checked out also rejects once the breaker opens mid-session", async () => {
    const client = await getPool().connect();
    try {
      await expect(client.query("SELECT 1")).resolves.toBeDefined();
      forceDbBreakerStateForTests("open");
      // The transaction this client is mid-way through — the exact case a
      // first review flagged: BEGIN already ran before the outage started,
      // and the next statement in it must still fail fast rather than hang
      // on a connection the breaker knows is bad.
      await expect(client.query("SELECT 1")).rejects.toBeInstanceOf(
        DatabaseUnavailableError,
      );
    } finally {
      forceDbBreakerStateForTests("closed");
      client.release();
    }
  });

  it("half-open rejects ordinary pool.query() and pool.connect(), not just fully-open", async () => {
    forceDbBreakerStateForTests("half-open");
    await expect(getPool().query("SELECT 1")).rejects.toBeInstanceOf(
      DatabaseUnavailableError,
    );
    await expect(getPool().connect()).rejects.toBeInstanceOf(
      DatabaseUnavailableError,
    );
  });

  it("recovers: connect() and query() both work again once the breaker closes", async () => {
    forceDbBreakerStateForTests("open");
    await expect(getPool().connect()).rejects.toBeInstanceOf(
      DatabaseUnavailableError,
    );
    forceDbBreakerStateForTests("closed");
    const client = await getPool().connect();
    await expect(client.query("SELECT 1")).resolves.toBeDefined();
    client.release();
    await expect(getPool().query("SELECT 1")).resolves.toBeDefined();
  });

  it("guards a reused PoolClient exactly once, however many times it is checked out", async () => {
    // pg-pool hands the same idle client straight back out when one is
    // available and nobody else is queued (pg-pool/index.js's
    // `_pulseQueue`) — reliable here because this test runs with no
    // concurrent connect() calls. If `guardQueryMethod` were not idempotent,
    // each checkout below would wrap `.query` in a fresh closure around the
    // last one, so `.query` would be a DIFFERENT function object after every
    // release/reconnect even though the underlying client object is the
    // same one. Reference equality across checkouts is exactly what would
    // break if the wrapper depth were growing.
    const first = await getPool().connect();
    const firstQuery = first.query;
    first.release();

    const second = await getPool().connect();
    try {
      expect(second).toBe(first);
      expect(second.query).toBe(firstQuery);
      await expect(second.query("SELECT 1")).resolves.toBeDefined();
    } finally {
      second.release();
    }

    // A third round for good measure — idempotency must hold on every
    // checkout, not just the first repeat.
    const third = await getPool().connect();
    try {
      expect(third.query).toBe(firstQuery);
    } finally {
      third.release();
    }
  });
});

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

  // A Farol pass on PR #566 caught the sharpest bug in this file: the guard
  // above rejected `ROLLBACK` exactly like any other query, so a client
  // mid-transaction that hit the breaker on its next statement had its own
  // cleanup rolled back by nothing, and pg-pool handed the still-open
  // transaction to a later, unrelated request.
  it("transaction-control statements are never rejected by the guard, even while open", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      forceDbBreakerStateForTests("open");
      // COMMIT is a control statement, not application data access — it
      // must go through regardless of breaker state.
      await expect(client.query("COMMIT")).resolves.toBeDefined();
    } finally {
      forceDbBreakerStateForTests("closed");
      client.release();
    }

    // Nothing was ever rejected on this client, so it must still be safe to
    // reuse: pg-pool hands the same idle object back with nothing else
    // contending for the pool (see the idempotency test above).
    const again = await getPool().connect();
    try {
      expect(again).toBe(client);
    } finally {
      again.release();
    }
  });

  // A second Farol pass caught that classifying a query as a transaction
  // control statement by its first keyword alone would wave through a
  // MULTI-statement string (Postgres's simple query protocol treats `;` as
  // a statement separator) that merely starts with BEGIN — nothing in this
  // codebase issues a query this way, but the guard itself must not assume
  // that stays true.
  it("a multi-statement string starting with BEGIN is not treated as a control statement", async () => {
    forceDbBreakerStateForTests("open");
    await expect(
      getPool().query("BEGIN; SELECT 1"),
    ).rejects.toBeInstanceOf(DatabaseUnavailableError);
  });

  // A THIRD Farol pass caught that the fix for the case above was too
  // blunt: scanning the raw text for any `;` also disqualified a perfectly
  // ordinary control statement carrying a trailing comment, which would
  // send exactly the ROLLBACK the dirty-transaction fix depends on back
  // through rejection while the breaker is open.
  it("a semicolon inside a trailing comment does not stop ROLLBACK/COMMIT from being treated as control statements", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      forceDbBreakerStateForTests("open");
      // The comment's own `;` must not make this look like two statements.
      await expect(
        client.query("ROLLBACK; -- because the breaker is open"),
      ).resolves.toBeDefined();
    } finally {
      forceDbBreakerStateForTests("closed");
      client.release();
    }
  });

  // A FOURTH Farol pass caught two more gaps in the comment-aware scanner
  // above: a `\r`-only ("old Mac") line ending never terminates a `--`
  // comment if only `\n` is checked for, so a real bundled statement after
  // one would be silently dropped rather than scanned — a multi-statement
  // bypass, same shape as the original one this whole scanner exists to
  // close. And Postgres nests `/* */` block comments (unlike C), so
  // stopping at the first `*/` can leave an outer comment's tail
  // un-stripped, wrongly rejecting an ordinary ROLLBACK/COMMIT that
  // happens to carry one.
  it("a bundled statement after a CR-only comment terminator is still rejected while open", async () => {
    forceDbBreakerStateForTests("open");
    await expect(
      getPool().query("ROLLBACK -- comment\r; SELECT 1"),
    ).rejects.toBeInstanceOf(DatabaseUnavailableError);
  });

  it("a semicolon inside a nested block comment does not stop ROLLBACK from being treated as a control statement", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      forceDbBreakerStateForTests("open");
      // The whole /* ... */ is ONE comment, nesting included — Postgres
      // parses this as just `ROLLBACK`.
      await expect(
        client.query("ROLLBACK /* outer /* inner; */ still outer */"),
      ).resolves.toBeDefined();
    } finally {
      forceDbBreakerStateForTests("closed");
      client.release();
    }
  });

  it("a client a rejected query poisons mid-transaction is destroyed on release, and its writes never land", async () => {
    const clerkId = "clerk_dirty_txn_test";
    await getPool().query(`DELETE FROM users WHERE clerk_id = $1`, [clerkId]);

    const client = await getPool().connect();
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO users (clerk_id, display_name) VALUES ($1, $2)`,
      [clerkId, "Dirty Txn Test"],
    );

    forceDbBreakerStateForTests("open");

    // The application's next statement is fast-rejected by the breaker...
    await expect(client.query("SELECT 1")).rejects.toBeInstanceOf(
      DatabaseUnavailableError,
    );
    // ...but its own ROLLBACK — the `catch { await client.query("ROLLBACK") }`
    // shape every service in this codebase uses — must NOT be rejected by
    // the same guard. Before the fix, this line was the bug: a rejected
    // ROLLBACK never reaches Postgres, and the transaction stays open on a
    // connection about to be released as if it were clean.
    await expect(client.query("ROLLBACK")).resolves.toBeDefined();

    // The application releases with no error — it has no way to know the
    // guard rejected one of its statements. This must be overridden.
    client.release();
    forceDbBreakerStateForTests("closed");

    // The client must have been destroyed, not returned to the idle pool:
    // with nothing else contending for the pool, pg-pool would otherwise
    // hand back this exact object (proven above) — getting a DIFFERENT one
    // is the evidence `release(err)` actually ran instead of a plain release.
    const fresh = await getPool().connect();
    try {
      expect(fresh).not.toBe(client);
    } finally {
      fresh.release();
    }

    // And the row never survives for a later, unrelated request to inherit.
    const check = await getPool().query(
      `SELECT 1 FROM users WHERE clerk_id = $1`,
      [clerkId],
    );
    expect(check.rowCount).toBe(0);
  });
});

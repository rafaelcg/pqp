import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The 2026-09-17 staging fix, against a real Postgres.
 *
 * WHAT HAPPENED. A reconnect storm (800 voice seats dropping and rejoining at
 * once) left both API processes at `{max:22, total:22, idle:0, busy:22,
 * waiting:15, pressure:"saturated"}` with the DB circuit breaker open, for
 * many minutes, with two sockets left, while every one of the 45 API backends
 * was `idle` in `ClientRead` on the database side, some for over 250 seconds,
 * the oldest backend 756 seconds old. Postgres had finished the work; the Node
 * clients were still checked out waiting for replies the transport had
 * swallowed. The pool had `connectionTimeoutMillis` and `idleTimeoutMillis`
 * and nothing that bounded waiting for a reply, so a lost answer pinned a pool
 * slot forever and nothing recovered without a restart.
 *
 * A mocked pool would prove none of this: the interesting behaviour is
 * Postgres's own `statement_timeout` arriving in the startup packet, pg's
 * per-query read timer sitting above it, and pg-pool's `acquire` / `release` /
 * `remove` events being the thing checkout ages are counted from. Real
 * database, therefore, like every other suite here.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

/**
 * Set BEFORE `db.ts` is imported and before any `getPool()`: the pool reads
 * this once, at creation. One second is short enough to make `pg_sleep(5)`
 * fail quickly and long enough that `initDb`'s own DDL would notice if it were
 * NOT running on the exempt boot connection.
 */
const POOL_TIMEOUT_MS = 1_000;
process.env.PG_QUERY_TIMEOUT_MS = String(POOL_TIMEOUT_MS);
delete process.env.WORKER_MODE;

const {
  getPool,
  initDb,
  closePool,
  forceDbBreakerStateForTests,
  resetDbBreakerForTests,
  DatabaseUnavailableError,
  resolvePgQueryTimeoutMs,
  pgTimeoutConfig,
  isPoisoningQueryError,
  DEFAULT_PG_QUERY_TIMEOUT_MS,
  DEFAULT_PG_WORKER_QUERY_TIMEOUT_MS,
} = await import("./db.js");
const { runtimeSnapshot } = await import("./lib/runtime.js");

/**
 * Which errors mean "never hand this connection to anybody else".
 *
 * The exclusion is the interesting half and the reason this is its own test:
 * `57014` arrives as an ErrorResponse followed by a ReadyForQuery, so the
 * connection resynchronised and is genuinely fine. `query_timeout` is a
 * client-side timer that cancels nothing, so the response may still be in
 * flight toward a socket somebody else will be using. Treating the two the
 * same in either direction is a bug: one way churns the pool on every slow
 * query, the other is the 2026-09-17 failure.
 */
describe("isPoisoningQueryError", () => {
  it("poisons on pg's client-side read timeout", () => {
    expect(isPoisoningQueryError(new Error("Query read timeout"))).toBe(
      "query-read-timeout",
    );
  });

  it("poisons on a lost or terminated connection", () => {
    expect(isPoisoningQueryError(new Error("Connection terminated"))).toBe(
      "connection-lost",
    );
    expect(
      isPoisoningQueryError(
        Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      ),
    ).toBe("connection-lost");
    expect(
      isPoisoningQueryError(
        Object.assign(new Error("terminating connection"), { code: "57P01" }),
      ),
    ).toBe("connection-lost");
  });

  it("does NOT poison on a statement Postgres cancelled cleanly, or on ordinary SQL errors", () => {
    expect(
      isPoisoningQueryError(
        Object.assign(
          new Error("canceling statement due to statement timeout"),
          { code: "57014" },
        ),
      ),
    ).toBeNull();
    expect(
      isPoisoningQueryError(
        Object.assign(new Error('relation "nope" does not exist'), {
          code: "42P01",
        }),
      ),
    ).toBeNull();
    expect(isPoisoningQueryError(undefined)).toBeNull();
    expect(isPoisoningQueryError("not an error")).toBeNull();
  });
});

describe("resolvePgQueryTimeoutMs", () => {
  it("defaults to 15s for a process that serves traffic", () => {
    expect(resolvePgQueryTimeoutMs({})).toBe(DEFAULT_PG_QUERY_TIMEOUT_MS);
    expect(resolvePgQueryTimeoutMs({ WORKER_MODE: "api" })).toBe(
      DEFAULT_PG_QUERY_TIMEOUT_MS,
    );
  });

  // The worker runs `jobs.ts`: a first retention sweep against a long backlog
  // is allowed to take much longer than any request ever may.
  it("gives the batch worker its own, longer default", () => {
    expect(resolvePgQueryTimeoutMs({ WORKER_MODE: "worker" })).toBe(
      DEFAULT_PG_WORKER_QUERY_TIMEOUT_MS,
    );
    expect(resolvePgQueryTimeoutMs({ WORKER_MODE: "1" })).toBe(
      DEFAULT_PG_WORKER_QUERY_TIMEOUT_MS,
    );
    expect(resolvePgQueryTimeoutMs({ WORKER_MODE: "worker" })).not.toBe(
      resolvePgQueryTimeoutMs({}),
    );
  });

  it("reads the explicit variables, worker's own first", () => {
    expect(resolvePgQueryTimeoutMs({ PG_QUERY_TIMEOUT_MS: "4000" })).toBe(4000);
    expect(
      resolvePgQueryTimeoutMs({
        WORKER_MODE: "worker",
        PG_WORKER_QUERY_TIMEOUT_MS: "300000",
        PG_QUERY_TIMEOUT_MS: "4000",
      }),
    ).toBe(300_000);
    // A deployment that sets one value for every process still gets it on the
    // worker, rather than silently keeping the two-minute default.
    expect(
      resolvePgQueryTimeoutMs({
        WORKER_MODE: "worker",
        PG_QUERY_TIMEOUT_MS: "4000",
      }),
    ).toBe(4000);
  });

  it("treats 0 as the rollback switch and a typo as the default", () => {
    expect(resolvePgQueryTimeoutMs({ PG_QUERY_TIMEOUT_MS: "0" })).toBe(0);
    expect(pgTimeoutConfig({ PG_QUERY_TIMEOUT_MS: "0" })).toEqual({});
    expect(resolvePgQueryTimeoutMs({ PG_QUERY_TIMEOUT_MS: "soon" })).toBe(
      DEFAULT_PG_QUERY_TIMEOUT_MS,
    );
    expect(resolvePgQueryTimeoutMs({ PG_QUERY_TIMEOUT_MS: "-1" })).toBe(
      DEFAULT_PG_QUERY_TIMEOUT_MS,
    );
  });

  // Postgres cancels first and cleanly (57014, connection still usable); pg's
  // own read timer is the later, dirtier backstop for a reply that is never
  // coming at all. Getting this order backwards would mean every slow query
  // came back through the door that leaves the connection in an unknown state.
  it("puts Postgres's own cancel a second ahead of the client-side read timeout", () => {
    const config = pgTimeoutConfig({ PG_QUERY_TIMEOUT_MS: "15000" });
    expect(config.statement_timeout).toBe(15_000);
    expect(config.query_timeout).toBe(16_000);
    expect(config.query_timeout!).toBeGreaterThan(config.statement_timeout!);
  });
});

describeDb("the main pool's timeouts and keepalive", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    resetDbBreakerForTests();
    await closePool();
  });

  it("creates the pool with both timeouts and TCP keepalive", () => {
    const options = getPool().options as unknown as Record<string, unknown>;
    expect(options.statement_timeout).toBe(POOL_TIMEOUT_MS);
    expect(options.query_timeout).toBe(POOL_TIMEOUT_MS + 1_000);
    expect(options.keepAlive).toBe(true);
    expect(options.keepAliveInitialDelayMillis).toBe(10_000);
    // Unchanged, so this PR is additive rather than a re-tuning.
    expect(options.connectionTimeoutMillis).toBe(10_000);
    expect(options.idleTimeoutMillis).toBe(30_000);
  });

  // The one that matters: `statement_timeout` has to actually reach the
  // server. It travels in the startup packet, so a config key pg silently
  // ignored would look identical from this side of the connection.
  it("lands statement_timeout on every pooled connection, and initDb's exemption does not leak", async () => {
    const client = await getPool().connect();
    try {
      const shown = await client.query<{ statement_timeout: string }>(
        "SHOW statement_timeout",
      );
      // `initDb` above ran `SET statement_timeout = 0` on its own connection
      // and destroyed it afterwards. If it had released that connection back
      // to the pool instead, this read could come back "0".
      expect(shown.rows[0]?.statement_timeout).toBe("1s");
    } finally {
      client.release();
    }
  });

  it("aborts a query that outruns the timeout and leaves the client reusable", async () => {
    const pool = getPool();
    const client = await pool.connect();
    const totalBefore = pool.totalCount;
    try {
      // Five seconds against a one-second bound.
      await expect(client.query("SELECT pg_sleep(5)")).rejects.toMatchObject({
        // Postgres's own cancel, not pg's read timer: the clean door.
        code: "57014",
      });
      // The connection survived it, which is the whole point of putting
      // `statement_timeout` a second below `query_timeout`.
      await expect(client.query("SELECT 1")).resolves.toBeDefined();
    } finally {
      client.release();
    }
    // Back in the idle list, ready for the next caller: the pool recovers on
    // its own, which is exactly what it did not do on staging.
    expect(pool.idleCount).toBeGreaterThan(0);
    expect(pool.totalCount).toBe(totalBefore);
    await expect(pool.query("SELECT 1")).resolves.toBeDefined();
  });

  /**
   * THE LOST REPLY, on the path that actually stranded the pool.
   *
   * `pool.query()` survives this by accident: pg-pool calls
   * `client.release(err)` itself and a truthy `err` destroys the client. Every
   * transaction in this codebase instead does `getPool().connect()` and
   * `finally { client.release() }` with NO argument, because the caller cannot
   * know the connection is compromised. Before the fix, pg-pool put that
   * client back in the idle list still waiting on a response that was never
   * coming, and handed it to the next request, which queued behind that
   * missing response and timed out too. The pool reported the slot as free
   * while it was as dead as it was on staging.
   *
   * `statement_timeout` is turned off on this one connection so Postgres
   * cannot cancel the statement and resynchronise the protocol: only the
   * client-side timer fires, which is exactly the shape of a reply lost in
   * transit, and the shape no test had.
   */
  it("destroys a client whose reply never arrived, even when its borrower releases it cleanly", async () => {
    const pool = getPool();
    // Warm the pool so `totalCount` is a real count, not a first open.
    const warm = await pool.connect();
    warm.release();

    const client = await pool.connect();
    const totalBefore = pool.totalCount;
    expect(totalBefore).toBeGreaterThan(0);

    // Postgres must NOT cancel this one; only pg's own read timer may fire.
    await client.query("SET statement_timeout = 0");
    await expect(
      client.query({
        text: "SELECT pg_sleep(30)",
        query_timeout: 300,
      } as never),
    ).rejects.toThrow(/query read timeout/i);

    // The caller's ordinary cleanup, with no error, because it has none to
    // pass. This line is the whole bug.
    client.release();

    // Destroyed, not idled: the slot is genuinely free again.
    expect(pool.totalCount).toBe(totalBefore - 1);
    // And nothing is left counted as checked out.
    expect(runtimeSnapshot().pool.longestCheckoutMs).toBe(0);

    // The next caller gets a healthy connection promptly, rather than queueing
    // behind a response that is never coming.
    const started = Date.now();
    const fresh = await pool.connect();
    try {
      expect(fresh).not.toBe(client);
      await expect(fresh.query("SELECT 1")).resolves.toBeDefined();
      // Also proves `SET statement_timeout = 0` did not ride back into the
      // pool on a reused connection.
      const shown = await fresh.query<{ statement_timeout: string }>(
        "SHOW statement_timeout",
      );
      expect(shown.rows[0]?.statement_timeout).toBe("1s");
    } finally {
      fresh.release();
    }
    expect(Date.now() - started).toBeLessThan(POOL_TIMEOUT_MS);
  });

  it("exposes checkout ages on the runtime block, and they come back down", async () => {
    const pool = getPool();
    // Drain the idle list's bookkeeping first: nothing else is contending.
    expect(runtimeSnapshot().pool).toMatchObject({
      longestCheckoutMs: 0,
      checkedOutOver10s: 0,
    });

    const client = await pool.connect();
    try {
      await client.query("SELECT 1");
      const held = runtimeSnapshot().pool;
      // A live checkout is visible the moment it happens, unlike `busy`,
      // which cannot tell a 3ms query from a four-minute one.
      expect(held.longestCheckoutMs).toBeGreaterThanOrEqual(0);
      expect(held.checkedOutOver10s).toBe(0);
      expect(held.busy).toBeGreaterThan(0);
    } finally {
      client.release();
    }

    expect(runtimeSnapshot().pool.longestCheckoutMs).toBe(0);
  });

  /**
   * The breaker's own rejection path, end to end. A client that is mid
   * transaction when the breaker opens is poisoned by `guardQueryMethod` and
   * must be DESTROYED on release rather than handed to a later request with
   * somebody else's transaction still open on it (`guardClientRelease`). This
   * asserts the half `db.test.ts` does not: that the destroyed connection
   * actually leaves the pool, so the slot it held is available again. A
   * rejection path that stranded clients would be its own version of the
   * 2026-09-17 failure, with the breaker as the cause.
   */
  it("destroys a client the breaker poisoned mid-transaction, freeing its pool slot", async () => {
    const pool = getPool();
    // Warm the pool so `totalCount` is a real count rather than a first open.
    const warm = await pool.connect();
    warm.release();

    const client = await pool.connect();
    const totalBefore = pool.totalCount;
    expect(totalBefore).toBeGreaterThan(0);

    await client.query("BEGIN");
    await client.query("SELECT 1");

    forceDbBreakerStateForTests("open");
    try {
      await expect(client.query("SELECT 1")).rejects.toBeInstanceOf(
        DatabaseUnavailableError,
      );
      // The caller's own cleanup still reaches Postgres (control statements
      // are never rejected by the guard) and still leaves the connection
      // unsafe to reuse, because one of its statements never ran.
      await expect(client.query("ROLLBACK")).resolves.toBeDefined();
      // The application releases with no error; it has no way to know.
      client.release();
    } finally {
      forceDbBreakerStateForTests("closed");
    }

    expect(pool.totalCount).toBe(totalBefore - 1);
    // And the slot is usable: a brand new connection, not the poisoned one.
    const fresh = await pool.connect();
    try {
      expect(fresh).not.toBe(client);
      await expect(fresh.query("SELECT 1")).resolves.toBeDefined();
    } finally {
      fresh.release();
    }
    // Nothing was left counted as checked out by the destroyed client either:
    // `remove` deletes the entry that `release` would have.
    expect(runtimeSnapshot().pool.longestCheckoutMs).toBe(0);
  });
});

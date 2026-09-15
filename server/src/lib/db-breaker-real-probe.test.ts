import pg from "pg";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDbBreaker,
  DB_BREAKER_GRACE_MS,
  DB_BREAKER_OPEN_COOLDOWN_MS,
  type DbBreakerState,
} from "./db-breaker.js";

/**
 * `db-breaker.test.ts` proves the state machine against a fake `probe`
 * function — deliberately, so the suite stays fast. That leaves a real gap
 * this repo has hit before (CLAUDE.md pitfalls #9 and #12): a mock can agree
 * with the code path it stands in for right up until production disagrees.
 * Here the `probe` is a genuine `pg.Client` pointed at a real, closed TCP
 * port — the same shape of failure a collapsed or firewalled Postgres
 * produces — so "opens on a real connection failure" and "recovers once
 * Postgres is reachable again" are proven against actual `pg` behavior
 * (ECONNREFUSED, connection timeouts), not an approximation of it. Only the
 * grace/cooldown clock is faked, the same as the other suite, because
 * waiting out `DB_BREAKER_GRACE_MS` and `DB_BREAKER_OPEN_COOLDOWN_MS` in
 * real time would buy nothing.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

/** Nothing listens here — a real, immediate connection refusal. */
const CLOSED_PORT_URL = "postgresql://pqp:pqp@127.0.0.1:1/nope";

function realProbe(getConnectionString: () => string) {
  return async (): Promise<void> => {
    const client = new pg.Client({
      connectionString: getConnectionString(),
      connectionTimeoutMillis: 500,
      statement_timeout: 500,
      query_timeout: 500,
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
    } finally {
      await client.end().catch(() => {});
    }
  };
}

describeDb("createDbBreaker against a real, unreachable Postgres port", () => {
  afterEach(() => {
    // Nothing to reset — each test builds its own breaker — but keep the
    // slot for symmetry with the rest of this file's siblings.
  });

  it("opens on sustained real connection failures, then recovers once Postgres is reachable", async () => {
    let clock = 1_000_000;
    let connectionString = CLOSED_PORT_URL;
    const transitions: DbBreakerState[] = [];

    const breaker = createDbBreaker({
      now: () => clock,
      probe: realProbe(() => connectionString),
      poolStats: () => ({ waiting: 0 }),
      onStateChange: (next) => transitions.push(next),
    });

    // First tick against the closed port: one bad probe is not enough.
    await breaker.tick();
    expect(breaker.state()).toBe("closed");

    // A full grace window of sustained real failures trips it.
    clock += DB_BREAKER_GRACE_MS + 1;
    await breaker.tick();
    expect(breaker.state()).toBe("open");
    expect(transitions).toEqual(["open"]);

    // Point the SAME probe at real Postgres and let the cooldown elapse —
    // the breaker moves to half-open and runs its trial in the same tick.
    connectionString = DATABASE_URL!;
    clock += DB_BREAKER_OPEN_COOLDOWN_MS + 1;
    await breaker.tick();
    expect(breaker.state()).toBe("half-open");

    // A second good real probe closes it.
    clock += 1;
    await breaker.tick();
    expect(breaker.state()).toBe("closed");
  });

  it("a queue-pressure trip also recovers via a real probe once Postgres answers", async () => {
    let clock = 2_000_000;
    let waiting = 100;
    const breaker = createDbBreaker({
      now: () => clock,
      probe: realProbe(() => DATABASE_URL!),
      poolStats: () => ({ waiting }),
    });

    await breaker.tick();
    clock += DB_BREAKER_GRACE_MS + 1;
    await breaker.tick();
    expect(breaker.state()).toBe("open");

    waiting = 0;
    clock += DB_BREAKER_OPEN_COOLDOWN_MS + 1;
    await breaker.tick(); // half-open, real probe against live Postgres
    expect(breaker.state()).toBe("half-open");
    clock += 1;
    await breaker.tick();
    expect(breaker.state()).toBe("closed");
  });
});

/**
 * The singleton wiring in `db.ts` specifically — not `createDbBreaker` in
 * isolation. A Farol pass caught that timing out the race in
 * `probeWithinBudget` did not stop `db.ts`'s `probeConnection` from running:
 * `pg` has no query cancellation this version can use, so the abandoned
 * connection attempt or query kept going toward its own (larger) internal
 * timeout. This proves the fix — `abortProbeConnection` — against a REAL
 * stalled connection, not a closed one: a bare TCP listener that accepts
 * the socket and never speaks Postgres's startup protocol back, which is
 * the "stalled, not refused" shape a saturated real Postgres produces and a
 * closed port (ECONNREFUSED, instant) does not exercise at all.
 */
const describeDbSingleton = DATABASE_URL ? describe : describe.skip;

describeDbSingleton("db.ts's breaker probe against a real stalled connection", () => {
  afterEach(async () => {
    const { resetDbBreakerForTests } = await import("../db.js");
    resetDbBreakerForTests();
  });

  it("a probe that misses its latency budget is torn down, not left running", async () => {
    const { tickDbBreakerForTests, probeConnectionActiveForTests, resetDbBreakerForTests } =
      await import("../db.js");

    // Track every accepted socket -- `server.close()`'s callback only fires
    // once every connection it accepted has ended, and a socket this test
    // never speaks on (deliberately, to simulate a stall) does not close
    // itself just because the client side called `end()`.
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      // Accept the connection and do nothing — never send Postgres's own
      // startup response, so `pg.Client.connect()` hangs waiting for one.
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `postgresql://pqp:pqp@127.0.0.1:${port}/nope`;
    resetDbBreakerForTests();

    try {
      expect(probeConnectionActiveForTests()).toBe(false);
      await tickDbBreakerForTests();
      // Torn down the instant the latency budget elapsed, not left hanging
      // toward `probeConnection`'s own 2s `connectionTimeoutMillis`.
      expect(probeConnectionActiveForTests()).toBe(false);
    } finally {
      process.env.DATABASE_URL = previousUrl;
      resetDbBreakerForTests();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);

  // A second Farol pass caught that publishing `probeClient` BEFORE
  // `connect()` settles (the fix above) opened a different gap: a
  // `connect()` that rejects on its own -- refused, not aborted by this
  // process -- left that same client sitting in `probeClient` with nothing
  // to un-publish it, so the next tick would find a "connection" here, skip
  // making a fresh one, and waste a probe running a query against a client
  // that was never actually connected.
  it("a real connection refusal during connect() does not leave a dead client published", async () => {
    const { tickDbBreakerForTests, probeConnectionActiveForTests, resetDbBreakerForTests } =
      await import("../db.js");

    const previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = CLOSED_PORT_URL;
    resetDbBreakerForTests();

    try {
      expect(probeConnectionActiveForTests()).toBe(false);
      await tickDbBreakerForTests();
      expect(probeConnectionActiveForTests()).toBe(false);
      // And the NEXT tick must attempt a fresh connection rather than
      // reusing the dead one -- also proven false, not stuck true.
      await tickDbBreakerForTests();
      expect(probeConnectionActiveForTests()).toBe(false);
    } finally {
      process.env.DATABASE_URL = previousUrl;
      resetDbBreakerForTests();
    }
  });
});

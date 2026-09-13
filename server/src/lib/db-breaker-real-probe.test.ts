import pg from "pg";
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

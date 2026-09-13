import { describe, expect, it } from "vitest";
import {
  createDbBreaker,
  DB_BREAKER_GRACE_MS,
  DB_BREAKER_HALF_OPEN_SUCCESSES,
  DB_BREAKER_OPEN_COOLDOWN_MS,
  DB_BREAKER_QUEUE_THRESHOLD,
  type DbBreakerState,
} from "./db-breaker.js";

/**
 * A3.1's circuit breaker over the Postgres pool. Two independent triggers
 * (a sustained queue, a sustained failing/slow probe) and hysteresis on both
 * ends: it needs `graceMs` of unbroken badness to open (not one bad tick),
 * and `halfOpenSuccesses` unbroken good probes to close again (not the
 * first one). Real timeouts would make this suite slow for no benefit — the
 * clock is injected and `probeWithinBudget`'s race uses a tiny real timer
 * instead, same pattern as `services/ready.test.ts`.
 */

interface Harness {
  advance(ms: number): void;
  setPostgres(mode: "ok" | "fail" | "hang"): void;
  setQueue(waiting: number | null): void;
  tick(): Promise<void>;
  state(): DbBreakerState;
  transitions: DbBreakerState[];
  probeCount(): number;
}

function harness(overrides: Partial<Parameters<typeof createDbBreaker>[0]> = {}): Harness {
  let clock = 1_000_000;
  let postgres: "ok" | "fail" | "hang" = "ok";
  let waiting: number | null = 0;
  let probeCount = 0;
  const transitions: DbBreakerState[] = [];
  const hang = () => new Promise<never>(() => {});

  const breaker = createDbBreaker({
    now: () => clock,
    probe: async () => {
      probeCount += 1;
      if (postgres === "fail") throw new Error("connection terminated");
      if (postgres === "hang") return hang();
      return "ok";
    },
    poolStats: () => (waiting === null ? null : { waiting }),
    // Real but tiny, so a "hang" resolves fast without slowing the suite.
    latencyBudgetMs: 5,
    onStateChange: (next) => transitions.push(next),
    ...overrides,
  });

  return {
    advance: (ms) => {
      clock += ms;
    },
    setPostgres: (mode) => {
      postgres = mode;
    },
    setQueue: (value) => {
      waiting = value;
    },
    tick: () => breaker.tick(),
    state: () => breaker.state(),
    transitions,
    probeCount: () => probeCount,
  };
}

describe("createDbBreaker", () => {
  it("starts closed", () => {
    const h = harness();
    expect(h.state()).toBe("closed");
  });

  it("a single failing probe does not trip it — only a sustained run does", async () => {
    const h = harness();
    h.setPostgres("fail");
    await h.tick();
    expect(h.state()).toBe("closed");
    h.advance(DB_BREAKER_GRACE_MS - 1);
    await h.tick();
    expect(h.state()).toBe("closed");
  });

  it("opens once the probe has failed for the whole grace window", async () => {
    const h = harness();
    h.setPostgres("fail");
    await h.tick();
    h.advance(DB_BREAKER_GRACE_MS + 1);
    await h.tick();
    expect(h.state()).toBe("open");
    expect(h.transitions).toEqual(["open"]);
  });

  it("a probe slower than the latency budget counts as a failure", async () => {
    const h = harness();
    h.setPostgres("hang");
    await h.tick();
    h.advance(DB_BREAKER_GRACE_MS + 1);
    await h.tick();
    expect(h.state()).toBe("open");
  });

  it("a queue over threshold for the grace window opens it even with a healthy probe", async () => {
    const h = harness();
    h.setQueue(DB_BREAKER_QUEUE_THRESHOLD + 1);
    await h.tick();
    expect(h.state()).toBe("closed");
    h.advance(DB_BREAKER_GRACE_MS + 1);
    await h.tick();
    expect(h.state()).toBe("open");
  });

  it("a queue that drains before the grace window resets the clock", async () => {
    const h = harness();
    h.setQueue(DB_BREAKER_QUEUE_THRESHOLD + 1);
    await h.tick();
    h.advance(DB_BREAKER_GRACE_MS - 1);
    h.setQueue(0);
    await h.tick();
    h.advance(DB_BREAKER_GRACE_MS + 1);
    await h.tick();
    // The good tick cleared queuedSince, so this run never reached graceMs.
    expect(h.state()).toBe("closed");
  });

  it("holds fully open and stops probing until the cooldown elapses", async () => {
    const h = harness();
    h.setPostgres("fail");
    await h.tick();
    h.advance(DB_BREAKER_GRACE_MS + 1);
    await h.tick();
    expect(h.state()).toBe("open");
    const probesAtOpen = h.probeCount();

    h.advance(DB_BREAKER_OPEN_COOLDOWN_MS - 1);
    await h.tick();
    expect(h.state()).toBe("open");
    // No probe issued while fully open: nothing here hammers a dead database.
    expect(h.probeCount()).toBe(probesAtOpen);
  });

  it("moves to half-open once the cooldown elapses, and closes after enough good probes", async () => {
    const h = harness();
    h.setPostgres("fail");
    await h.tick();
    h.advance(DB_BREAKER_GRACE_MS + 1);
    await h.tick();
    expect(h.state()).toBe("open");

    h.advance(DB_BREAKER_OPEN_COOLDOWN_MS + 1);
    h.setPostgres("ok");
    await h.tick(); // -> half-open, first good probe
    expect(h.state()).toBe("half-open");

    for (let i = 1; i < DB_BREAKER_HALF_OPEN_SUCCESSES; i++) {
      await h.tick();
    }
    expect(h.state()).toBe("closed");
    expect(h.transitions).toEqual(["open", "half-open", "closed"]);
  });

  it("a single bad probe in half-open sends it back to a full cooldown, not a partial one", async () => {
    const h = harness();
    h.setPostgres("fail");
    await h.tick();
    h.advance(DB_BREAKER_GRACE_MS + 1);
    await h.tick();
    h.advance(DB_BREAKER_OPEN_COOLDOWN_MS + 1);
    h.setPostgres("ok");
    await h.tick(); // half-open
    expect(h.state()).toBe("half-open");

    h.setPostgres("fail");
    await h.tick(); // one bad trial
    expect(h.state()).toBe("open");

    // Still within a fresh cooldown measured from THIS re-open, not the first.
    h.advance(DB_BREAKER_OPEN_COOLDOWN_MS - 1);
    await h.tick();
    expect(h.state()).toBe("open");
  });

  it("a queue still over threshold in half-open reopens it even if the probe is healthy", async () => {
    const h = harness();
    h.setPostgres("fail");
    await h.tick();
    h.advance(DB_BREAKER_GRACE_MS + 1);
    await h.tick();
    h.advance(DB_BREAKER_OPEN_COOLDOWN_MS + 1);
    h.setPostgres("ok");
    h.setQueue(DB_BREAKER_QUEUE_THRESHOLD + 1);
    await h.tick();
    expect(h.state()).toBe("open");
  });

  it("noteRejected and stats() count independently of state transitions", () => {
    const breaker = createDbBreaker({
      probe: async () => "ok",
      poolStats: () => ({ waiting: 0 }),
    });
    expect(breaker.stats()).toEqual({ state: "closed", opened: 0, rejected: 0 });
    breaker.noteRejected();
    breaker.noteRejected();
    expect(breaker.stats().rejected).toBe(2);
  });

  it("reset() forgets state, streaks and counts", async () => {
    let clock = 0;
    let postgres: "ok" | "fail" = "ok";
    const breaker = createDbBreaker({
      now: () => clock,
      probe: async () => {
        if (postgres === "fail") throw new Error("down");
        return "ok";
      },
      poolStats: () => ({ waiting: 0 }),
      latencyBudgetMs: 5,
    });
    postgres = "fail";
    await breaker.tick();
    clock += DB_BREAKER_GRACE_MS + 1;
    await breaker.tick();
    expect(breaker.state()).toBe("open");
    breaker.noteRejected();

    breaker.reset();
    expect(breaker.state()).toBe("closed");
    expect(breaker.stats()).toEqual({ state: "closed", opened: 0, rejected: 0 });
  });
});

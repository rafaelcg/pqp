import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PoolStats } from "../lib/runtime.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import {
  createReadyChecker,
  POOL_FULL_GRACE_MS,
  POOL_QUEUE_GRACE_MS,
  READY_PATH,
  readyHandler,
  REMOTE_CACHE_TTL_MS,
  type ReadyReport,
} from "./ready.js";

/**
 * `GET /ready` is a verdict over four dependencies plus two clocks. The
 * clocks are what a `SELECT 1` cannot see (the 2026-09-05 outage passed
 * `/health` for half an hour), so they get the most attention: a queue that
 * appears for a moment must not page anybody, a queue that never drains must.
 */

interface Harness {
  checker: ReturnType<typeof createReadyChecker>;
  advance(ms: number): void;
  setPostgres(mode: "ok" | "fail" | "hang"): void;
  setPool(stats: Partial<PoolStats> | null): void;
  setLivekit(mode: "unconfigured" | "ok" | "fail" | "hang"): void;
  livekitProbes(): number;
  report(): Promise<ReadyReport>;
}

function harness(): Harness {
  let clock = 1_000_000;
  let postgres: "ok" | "fail" | "hang" = "ok";
  let livekit: "unconfigured" | "ok" | "fail" | "hang" = "unconfigured";
  let livekitProbes = 0;
  let pool: PoolStats | null = { max: 10, total: 2, idle: 2, waiting: 0 };
  const hang = () => new Promise<never>(() => {});
  const checker = createReadyChecker({
    now: () => clock,
    version: () => "test",
    probePostgres: async () => {
      if (postgres === "fail") throw new Error("connection terminated");
      if (postgres === "hang") return hang();
      return "ok";
    },
    poolStats: () => pool,
    probeLivekit: () =>
      livekit === "unconfigured"
        ? null
        : async () => {
            livekitProbes += 1;
            if (livekit === "fail") throw new Error("sfu unreachable");
            if (livekit === "hang") return hang();
            return [];
          },
    livekitHost: () => (livekit === "unconfigured" ? null : "sfu.pqp.gg"),
    probeStorage: () => null,
    // Real timeouts would make the suite slow; the behaviour is the same.
    postgresTimeoutMs: 5,
    remoteTimeoutMs: 5,
  });
  return {
    checker,
    advance: (ms) => {
      clock += ms;
    },
    setPostgres: (mode) => {
      postgres = mode;
    },
    setPool: (stats) => {
      pool = stats === null ? null : { max: 10, total: 2, idle: 2, waiting: 0, ...stats };
    },
    setLivekit: (mode) => {
      livekit = mode;
    },
    livekitProbes: () => livekitProbes,
    report: () => checker.check(),
  };
}

describe("the /ready path", () => {
  it("is its own path, not Fly's check and not the status page", () => {
    expect(READY_PATH).toBe("/ready");
    expect(READY_PATH).not.toBe("/health");
    expect(READY_PATH).not.toBe("/up");
    expect(READY_PATH).not.toBe("/status.json");
  });
});

describe("ready checker", () => {
  it("is ok when everything answers, and says what it checked", async () => {
    const h = harness();
    const r = await h.report();
    expect(r.ok).toBe(true);
    expect(r.version).toBe("test");
    expect(r.checks.postgres.ok).toBe(true);
    expect(typeof r.checks.postgres.ms).toBe("number");
    expect(r.checks.pool).toEqual({ ok: true, inUse: 0, max: 10, queued: 0 });
    expect(r.checks.livekit).toEqual({ ok: true, skipped: true });
    expect(r.checks.storage).toEqual({ ok: true, skipped: true });
  });

  it("is not ok the moment postgres fails, and names postgres", async () => {
    const h = harness();
    h.setPostgres("fail");
    const r = await h.report();
    expect(r.ok).toBe(false);
    expect(r.checks.postgres.ok).toBe(false);
    expect(r.checks.pool.ok).toBe(true);
  });

  it("treats a postgres that never answers as failed, within the timeout", async () => {
    const h = harness();
    h.setPostgres("hang");
    const r = await h.report();
    expect(r.checks.postgres.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("ignores a queue that clears within the grace window", async () => {
    // A cold start or a deploy stampede: pg-pool queues checkouts for a tick,
    // then hands them out. That must never read as an outage.
    const h = harness();
    h.setPool({ waiting: 4 });
    h.checker.samplePool();
    h.advance(POOL_QUEUE_GRACE_MS - 1_000);
    expect((await h.report()).checks.pool.ok).toBe(true);
    h.setPool({ waiting: 0 });
    h.advance(5_000);
    expect((await h.report()).ok).toBe(true);
  });

  it("is 503 once the queue has been non-empty for longer than the grace window", async () => {
    const h = harness();
    h.setPool({ waiting: 1, total: 10, idle: 0 });
    h.checker.samplePool();
    h.advance(POOL_QUEUE_GRACE_MS + 1);
    const r = await h.report();
    expect(r.checks.pool).toEqual({ ok: false, inUse: 10, max: 10, queued: 1 });
    expect(r.ok).toBe(false);
    // Postgres itself was fine; the pool is what is reported.
    expect(r.checks.postgres.ok).toBe(true);
  });

  it("measures the queue continuously: a drain in the middle restarts the clock", async () => {
    const h = harness();
    h.setPool({ waiting: 2 });
    h.checker.samplePool();
    h.advance(POOL_QUEUE_GRACE_MS - 1);
    h.setPool({ waiting: 0 });
    h.checker.samplePool();
    h.setPool({ waiting: 2 });
    h.checker.samplePool();
    h.advance(POOL_QUEUE_GRACE_MS - 1);
    expect((await h.report()).checks.pool.ok).toBe(true);
    h.advance(2);
    expect((await h.report()).checks.pool.ok).toBe(false);
  });

  it("tolerates a full pool for a burst and flags it after 30 s", async () => {
    const h = harness();
    h.setPool({ total: 10, idle: 0, waiting: 0 });
    h.checker.samplePool();
    h.advance(POOL_FULL_GRACE_MS - 1);
    expect((await h.report()).checks.pool.ok).toBe(true);
    h.advance(2);
    const r = await h.report();
    expect(r.checks.pool.ok).toBe(false);
    expect(r.checks.pool.inUse).toBe(10);
  });

  it("reports no pool as ok on the pool axis; postgres carries that failure", async () => {
    const h = harness();
    h.setPool(null);
    h.setPostgres("fail");
    const r = await h.report();
    expect(r.checks.pool.ok).toBe(true);
    expect(r.checks.postgres.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("skips livekit when it is not configured, and that is ok", async () => {
    const h = harness();
    expect((await h.report()).checks.livekit).toEqual({ ok: true, skipped: true });
    expect(h.livekitProbes()).toBe(0);
  });

  it("probes livekit when configured, caches the answer for 30 s, and fails on timeout", async () => {
    const h = harness();
    h.setLivekit("ok");
    let r = await h.report();
    expect(r.checks.livekit.ok).toBe(true);
    expect("ms" in r.checks.livekit).toBe(true);
    // The SFU host rides on the check, hostname only, so a rollback to
    // LiveKit Cloud is visible to a monitor that only reads this endpoint.
    expect(r.checks.livekit.host).toBe("sfu.pqp.gg");
    await Promise.all([h.report(), h.report(), h.report()]);
    expect(h.livekitProbes()).toBe(1);

    h.setLivekit("hang");
    h.advance(REMOTE_CACHE_TTL_MS);
    r = await h.report();
    expect(h.livekitProbes()).toBe(2);
    expect(r.checks.livekit.ok).toBe(false);
    expect(r.checks.livekit.host).toBe("sfu.pqp.gg");
    expect(r.ok).toBe(false);
  });

  it("forgets its clocks and caches on reset", async () => {
    const h = harness();
    h.setPool({ waiting: 1 });
    h.checker.samplePool();
    h.advance(POOL_QUEUE_GRACE_MS + 1);
    expect((await h.report()).ok).toBe(false);
    h.checker.reset();
    expect((await h.report()).ok).toBe(true);
  });
});

describe("GET /ready over HTTP", () => {
  let server: Server;
  let baseUrl: string;
  let report: ReadyReport;
  const limiter = createRateLimiter({ capacity: 3, refillPerSecond: 0.001 });

  beforeAll(async () => {
    server = createServer((req, res) => {
      void readyHandler(async () => report, limiter)(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  afterEach(() => limiter.reset());

  const ok = (): ReadyReport => ({
    ok: true,
    checks: {
      postgres: { ok: true, ms: 1 },
      pool: { ok: true, inUse: 1, max: 10, queued: 0 },
      livekit: { ok: true, skipped: true },
      storage: { ok: true, skipped: true },
    },
    version: "abc",
  });

  it("answers 200 with the report when everything is ok", async () => {
    report = ok();
    const res = await fetch(`${baseUrl}${READY_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(report);
  });

  it("answers 503 with the failing check named", async () => {
    report = ok();
    report.ok = false;
    report.checks.postgres = { ok: false, ms: 2000 };
    const res = await fetch(`${baseUrl}${READY_PATH}`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as ReadyReport;
    expect(body.checks.postgres.ok).toBe(false);
    // Nothing in the body is a hostname, a secret or an error string.
    expect(JSON.stringify(body)).not.toMatch(/postgres:\/\/|@|https?:\/\/|error/i);
  });

  it("rate-limits a flood from one address", async () => {
    report = ok();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await fetch(`${baseUrl}${READY_PATH}`)).status);
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });
});

/**
 * The real thing against the test database: the process-wide checker with a
 * live pool. Skipped without TEST_DATABASE_URL, like every DB-backed suite.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb("checkReady against a real pool", () => {
  it("is ok with a reachable database and no SFU or storage configured", async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    delete process.env.LIVEKIT_URL;
    delete process.env.S3_ENDPOINT;
    const { checkReady } = await import("./ready.js");
    const { closePool } = await import("../db.js");
    try {
      const r = await checkReady();
      expect(r.ok).toBe(true);
      expect(r.checks.postgres.ok).toBe(true);
      expect(r.checks.pool.max).toBeGreaterThan(0);
      expect(r.checks.livekit).toEqual({ ok: true, skipped: true });
      expect(r.checks.storage).toEqual({ ok: true, skipped: true });
    } finally {
      await closePool();
    }
  });
});

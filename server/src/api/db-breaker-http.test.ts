import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * A3.1 (docs/plans/ALWAYS_ON.md), at the HTTP boundary: a DB-dependent route
 * must answer fast and with a specific shape when the breaker is open,
 * rather than queueing on the pool for `connectionTimeoutMillis`. Real
 * Postgres, same harness shape as `api.test.ts` — the point being tested is
 * the wiring between `db.ts`'s breaker and `api/index.ts`'s central catch,
 * which a mocked pool would not exercise honestly.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

let actor: { id: string; clerk_id: string } | null = null;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  resolveAuthSession: async () =>
    actor ? { user: actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool, forceDbBreakerStateForTests, resetDbBreakerForTests } =
  await import("../db.js");
const { upsertUser } = await import("../services/users.js");

let server: Server;
let baseUrl: string;

async function timedCall(path: string, init?: RequestInit) {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: "Bearer test", ...init?.headers },
  });
  const elapsedMs = Date.now() - startedAt;
  const text = await response.text();
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
    elapsedMs,
  };
}

describeDb("A3.1: DB breaker at the HTTP boundary", () => {
  let user: { id: string; clerk_id: string };

  beforeAll(async () => {
    await initDb();
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => server.listen(0, done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    resetDbBreakerForTests();
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    resetDbBreakerForTests();
    await getPool().query(
      `TRUNCATE users, user_preferences RESTART IDENTITY CASCADE`,
    );
    user = await upsertUser({
      clerkId: "clerk_breaker_http",
      displayName: "Breaker Test",
      avatarUrl: null,
    });
    actor = user;
  });

  afterEach(() => {
    resetDbBreakerForTests();
    actor = null;
  });

  it("a DB-dependent route works normally while the breaker is closed", async () => {
    const res = await timedCall("/api/me");
    expect(res.status).toBe(200);
  });

  it("answers 503 with Retry-After and the exact body, fast, once the breaker is open", async () => {
    forceDbBreakerStateForTests("open");
    const res = await timedCall("/api/me");
    expect(res.status).toBe(503);
    expect(res.retryAfter).toBe("5");
    expect(res.body).toEqual({ error: "database_unavailable" });
    // The old failure mode was a 30s hang on the pool's connectionTimeoutMillis
    // per request; this must reject long before that, with no query issued.
    expect(res.elapsedMs).toBeLessThan(2_000);
  });

  it("recovers once the breaker closes again", async () => {
    forceDbBreakerStateForTests("open");
    expect((await timedCall("/api/me")).status).toBe(503);
    forceDbBreakerStateForTests("closed");
    expect((await timedCall("/api/me")).status).toBe(200);
  });

  // A Farol review of this PR flagged that the breaker guards `pool.query`
  // but not `pool.connect()` — the path every transaction in
  // `server/src/services/*.ts` uses. `POST /api/servers` (`createServer`)
  // is exactly that: `BEGIN` / several `client.query` calls / `COMMIT` on a
  // client checked out via `getPool().connect()`. It is guarded the same
  // way `pool.query` is (`server/src/db.ts`'s `guardPoolQueries` wraps
  // `connect()` too, and the `PoolClient` it returns), so this must answer
  // exactly as fast and with the exact same shape as a `query()`-backed
  // route.
  it("a connect()/transaction-backed route (POST /api/servers) also fast-rejects while open", async () => {
    forceDbBreakerStateForTests("open");
    const res = await timedCall("/api/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Should Not Be Created" }),
    });
    expect(res.status).toBe(503);
    expect(res.retryAfter).toBe("5");
    expect(res.body).toEqual({ error: "database_unavailable" });
    expect(res.elapsedMs).toBeLessThan(2_000);

    // And nothing was actually created — connect() itself was refused
    // before BEGIN, not rolled back after a partial write.
    forceDbBreakerStateForTests("closed");
    const list = await timedCall("/api/servers");
    expect(list.status).toBe(200);
    expect(list.body.servers).toEqual([]);
  });

  // Also flagged: that `half-open` was a wide-open door rather than the
  // single recovery trial it is documented as. `half-open` is reached only
  // through the breaker's own clock (a real bad probe followed by the
  // cooldown), so this drives it there directly with the same test hook
  // the rest of this suite uses to reach `open`.
  it("half-open still fast-rejects ordinary requests, both query()- and connect()-backed", async () => {
    forceDbBreakerStateForTests("half-open");
    const getRes = await timedCall("/api/me");
    expect(getRes.status).toBe(503);
    expect(getRes.body).toEqual({ error: "database_unavailable" });

    const postRes = await timedCall("/api/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Should Not Be Created Either" }),
    });
    expect(postRes.status).toBe(503);
    expect(postRes.body).toEqual({ error: "database_unavailable" });
  });
});

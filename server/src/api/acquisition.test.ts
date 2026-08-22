import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * The two ends of acquisition attribution, over HTTP.
 *
 *  - `PATCH /api/me` with an `acquisition` body writes it once, and a profile
 *    payload never carries it back (the columns are not in DB_USER_COLUMNS,
 *    and this is the test that keeps that true);
 *  - `GET /api/admin/acquisition` is a 404 for anybody who is not an instance
 *    moderator, and a grouped count for one who is.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const stubs = vi.hoisted(() => ({
  actor: null as { id: string; clerk_id: string } | null,
}));

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  forgetAuthUser: () => {},
  deleteClerkUser: async () => {},
  resolveAuthUser: async () => (stubs.actor ? { user: stubs.actor } : null),
  resolveAuthSession: async () =>
    stubs.actor ? { user: stubs.actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");

let server: Server;
let baseUrl: string;

type Actor = { id: string; clerk_id: string };

async function call<T = Record<string, unknown>>(
  as: Actor | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  stubs.actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

describeDb("acquisition over the API", () => {
  let ana: Actor;
  let operator: Actor;

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
    delete process.env.INSTANCE_MODERATOR_CLERK_IDS;
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    ana = await upsertUser({
      clerkId: "clerk-ana",
      displayName: "Ana",
      avatarUrl: null,
    });
    operator = await upsertUser({
      clerkId: "clerk-operator",
      displayName: "Operator",
      avatarUrl: null,
    });
    process.env.INSTANCE_MODERATOR_CLERK_IDS = operator.clerk_id;
  });

  it("writes the acquisition on PATCH /api/me and never echoes it back", async () => {
    const first = await call(ana, "PATCH", "/api/me", {
      acquisition: { source: "google", medium: "cpc", campaign: "tela-br" },
    });
    expect(first.status).toBe(200);
    expect(JSON.stringify(first.body)).not.toContain("acquisition");
    expect(JSON.stringify(first.body)).not.toContain("tela-br");

    const me = await call(ana, "GET", "/api/me");
    expect(JSON.stringify(me.body)).not.toContain("tela-br");

    const row = await getPool().query<{ acquisition_source: string | null }>(
      `SELECT acquisition_source FROM users WHERE id = $1`,
      [ana.id],
    );
    expect(row.rows[0]!.acquisition_source).toBe("google");

    // First touch: the second send is accepted as a request and ignored as a
    // write, so a retry never turns into a re-attribution.
    const second = await call(ana, "PATCH", "/api/me", {
      acquisition: { source: "meta" },
    });
    expect(second.status).toBe(200);
    const again = await getPool().query<{ acquisition_source: string | null }>(
      `SELECT acquisition_source FROM users WHERE id = $1`,
      [ana.id],
    );
    expect(again.rows[0]!.acquisition_source).toBe("google");
  });

  it("refuses an over-long field with a 400", async () => {
    const result = await call(ana, "PATCH", "/api/me", {
      acquisition: { source: "x".repeat(101) },
    });
    expect(result.status).toBe(400);
  });

  it("hides the report from everybody but an instance moderator", async () => {
    expect((await call(ana, "GET", "/api/admin/acquisition")).status).toBe(404);
    expect((await call(null, "GET", "/api/admin/acquisition")).status).toBe(401);
  });

  it("answers the operator with signups grouped by campaign", async () => {
    await call(ana, "PATCH", "/api/me", {
      acquisition: { source: "google", medium: "cpc", campaign: "tela-br" },
    });
    const report = await call<{
      days: number;
      total: number;
      rows: { source: string | null; signups: number }[];
    }>(operator, "GET", "/api/admin/acquisition?days=7");
    expect(report.status).toBe(200);
    expect(report.body.days).toBe(7);
    expect(report.body.total).toBe(2);
    expect(report.body.rows).toEqual([
      {
        source: "google",
        medium: "cpc",
        campaign: "tela-br",
        ref: null,
        signups: 1,
      },
      { source: null, medium: null, campaign: null, ref: null, signups: 1 },
    ]);
    // No names, no ids: the report is counts and nothing else.
    expect(JSON.stringify(report.body)).not.toContain(ana.id);
    expect(JSON.stringify(report.body)).not.toContain("Ana");
  });

  it("clamps the window to at most 90 days", async () => {
    const report = await call<{ days: number }>(
      operator,
      "GET",
      "/api/admin/acquisition?days=9999",
    );
    expect(report.body.days).toBe(90);
  });
});

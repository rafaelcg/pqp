import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET /api/dms/config`, the Conversas switches every client reads.
 *
 * Flags are set the way production sets them: a row in `feature_flags` read
 * after `startFeatureFlags()`, never an environment variable (CLAUDE.md
 * pitfall 12).
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
delete process.env.CONVERSATIONS_HOME;
delete process.env.CONVERSATIONS_HOME_PHONE_TABS;

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
const { resetFeatureFlagsForTests, setGlobalFlag, startFeatureFlags } = await import(
  "../lib/flags.js"
);

let http: Server;
let baseUrl: string;

async function config(): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/dms/config`, {
    headers: { Authorization: "Bearer test" },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describeDb("GET /api/dms/config", () => {
  beforeAll(async () => {
    await initDb();
    http = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => http.listen(0, done));
    baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => http.close(() => done()));
    resetFeatureFlagsForTests();
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    resetFeatureFlagsForTests();
    await getPool().query(
      `TRUNCATE users, feature_flags, feature_flag_overrides, feature_flag_audit
       RESTART IDENTITY CASCADE`,
    );
    stubs.actor = await upsertUser({
      clerkId: "clerk_dms_config",
      displayName: "Alice",
      avatarUrl: null,
    });
    await startFeatureFlags();
  });

  it("answers both off until the operator flips them", async () => {
    const answer = await config();
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ home: false, phoneTabs: false });
  });

  it("follows conversations_home from its flag row", async () => {
    await setGlobalFlag("conversations_home", true, { kind: "dashboard" });
    expect((await config()).body).toEqual({ home: true, phoneTabs: false });
    await setGlobalFlag("conversations_home", null, { kind: "dashboard" });
    expect((await config()).body).toEqual({ home: false, phoneTabs: false });
  });

  it("phoneTabs needs home: the sub-switch alone answers off", async () => {
    await setGlobalFlag("conversations_home_phone_tabs", true, { kind: "dashboard" });
    expect((await config()).body).toEqual({ home: false, phoneTabs: false });
    await setGlobalFlag("conversations_home", true, { kind: "dashboard" });
    expect((await config()).body).toEqual({ home: true, phoneTabs: true });
    // Turning the phone half off alone leaves desktop on: the rollback order.
    await setGlobalFlag("conversations_home_phone_tabs", false, { kind: "dashboard" });
    expect((await config()).body).toEqual({ home: true, phoneTabs: false });
  });

  it("is behind auth like every other /api route", async () => {
    stubs.actor = null;
    expect((await config()).status).toBe(401);
  });
});

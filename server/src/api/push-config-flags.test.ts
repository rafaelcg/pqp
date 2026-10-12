import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET /api/push/config` and the notification flags it carries.
 *
 * Flags are set the way production sets them: a row in `feature_flags` read
 * after `startFeatureFlags()`, never an environment variable (CLAUDE.md
 * pitfall 12: the test must exercise the path production uses).
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
delete process.env.NOTIFY_OPEN_CHANNEL;

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

async function pushConfig(): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/api/push/config`, {
    headers: { Authorization: "Bearer test" },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describeDb("GET /api/push/config notification flags", () => {
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
      clerkId: "clerk_push_flags",
      displayName: "Alice",
      avatarUrl: null,
    });
    // Flags read the database from here on, with nothing stored: off.
    await startFeatureFlags();
  });

  it("says notifyOpenChannel is off until the operator turns the flag on", async () => {
    expect((await pushConfig()).notifyOpenChannel).toBe(false);
  });

  it("follows the flag row, both ways, with no restart", async () => {
    await setGlobalFlag("notify_open_channel", true, { kind: "dashboard" });
    expect((await pushConfig()).notifyOpenChannel).toBe(true);
    await setGlobalFlag("notify_open_channel", false, { kind: "dashboard" });
    expect((await pushConfig()).notifyOpenChannel).toBe(false);
    await setGlobalFlag("notify_open_channel", null, { kind: "dashboard" });
    expect((await pushConfig()).notifyOpenChannel).toBe(false);
  });

  it("keeps the fields the settings screen and the phones already read", async () => {
    const body = await pushConfig();
    expect(body).toMatchObject({
      enabled: expect.any(Boolean),
      apns: expect.any(Boolean),
      fcm: expect.any(Boolean),
      dmDetails: false,
    });
  });
});

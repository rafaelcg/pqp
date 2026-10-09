import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The split notification defaults and the flag that turns the new behaviour on.
 *
 * Flags are set the way production sets them: a row in `feature_flags` read
 * after `startFeatureFlags()`, never an environment variable (CLAUDE.md
 * pitfall 12). The preferences route is the one that strips keys its schema
 * does not know, so the round trip is what proves `dmDefault`, `serverDefault`
 * and `desktopChosen` are kept and that nothing else in the object is lost.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
delete process.env.DESKTOP_NOTIFY_DEFAULT_ON;

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
const { resolvePushLevel } = await import("../services/push.js");

let http: Server;
let baseUrl: string;

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

interface PreferencesAnswer {
  preferences: { notifications?: Record<string, unknown> };
}

describeDb("notification defaults", () => {
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
      clerkId: "clerk_defaults",
      displayName: "Alice",
      avatarUrl: null,
    });
    await startFeatureFlags();
  });

  it("serves desktopNotifyDefaultOn from the flag row, off until the operator flips it", async () => {
    expect((await call("GET", "/api/push/config")).body.desktopNotifyDefaultOn).toBe(false);
    await setGlobalFlag("desktop_notify_default_on", true, { kind: "dashboard" });
    expect((await call("GET", "/api/push/config")).body.desktopNotifyDefaultOn).toBe(true);
    await setGlobalFlag("desktop_notify_default_on", null, { kind: "dashboard" });
    expect((await call("GET", "/api/push/config")).body.desktopNotifyDefaultOn).toBe(false);
  });

  it("keeps dmDefault, serverDefault and desktopChosen through the preferences route", async () => {
    const patch = await call<PreferencesAnswer>("PATCH", "/api/me/preferences", {
      notifications: {
        desktop: true,
        desktopChosen: true,
        default: "all",
        dmDefault: "all",
        serverDefault: "mentions",
      },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.preferences.notifications).toMatchObject({
      desktop: true,
      desktopChosen: true,
      default: "all",
      dmDefault: "all",
      serverDefault: "mentions",
    });
    const read = await call<{ preferences?: PreferencesAnswer["preferences"] }>("GET", "/api/me");
    expect(read.body.preferences?.notifications).toMatchObject({
      dmDefault: "all",
      serverDefault: "mentions",
    });
  });

  it("an account that never set the split reads exactly as before", async () => {
    await call("PATCH", "/api/me/preferences", {
      notifications: { desktop: false, default: "mentions" },
    });
    const read = await call<{ preferences?: PreferencesAnswer["preferences"] }>("GET", "/api/me");
    const notifications = read.body.preferences?.notifications ?? {};
    expect(notifications.dmDefault).toBeUndefined();
    expect(notifications.serverDefault).toBeUndefined();
    // And the push resolver, which reads the same stored object, still says
    // "mentions" for both a conversation and a server channel.
    const settings = { notifications } as Parameters<typeof resolvePushLevel>[0];
    expect(resolvePushLevel(settings, null, "22222222-2222-4222-8222-222222222222")).toBe("mentions");
    expect(
      resolvePushLevel(
        settings,
        "11111111-1111-4111-8111-111111111111",
        "33333333-3333-4333-8333-333333333333",
      ),
    ).toBe("mentions");
  });

  it("rejects a level the schema does not know", async () => {
    const bad = await call("PATCH", "/api/me/preferences", {
      notifications: { serverDefault: "everything" },
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });
});

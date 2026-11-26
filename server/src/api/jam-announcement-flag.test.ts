import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { jamPublicMeConfigSchema } from "@pqp/shared";

/**
 * `jam_announcement`: the "A Jam abriu" corner card, served as `announce` on
 * the signed-in `GET /api/jam-public/config`. Global, default off, and only
 * ever true while `jam_public` is on too.
 *
 * Flags are set the way production sets them: rows read after
 * `startFeatureFlags()`, never an environment variable (CLAUDE.md pitfall 12).
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
delete process.env.JAM_PUBLIC;
delete process.env.JAM_ANNOUNCEMENT;

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

async function config() {
  const response = await fetch(`${baseUrl}/api/jam-public/config`, {
    headers: { Authorization: "Bearer test" },
  });
  expect(response.status).toBe(200);
  return jamPublicMeConfigSchema.parse(await response.json());
}

const flag = (key: "jam_public" | "jam_announcement", on: boolean | null) =>
  setGlobalFlag(key, on, { kind: "dashboard" });

describeDb("jam_announcement: the announce field of the jam-public config", () => {
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
      clerkId: "clerk_jam_announcement",
      displayName: "Alice",
      avatarUrl: null,
    });
    await startFeatureFlags();
  });

  it("is off by default, and off with jam_public off", async () => {
    expect(await config()).toMatchObject({ enabled: false, announce: false });
  });

  it("jam_public on alone does not announce", async () => {
    await flag("jam_public", true);
    expect(await config()).toMatchObject({ enabled: true, announce: false });
  });

  it("both on announces, and off again is live", async () => {
    await flag("jam_public", true);
    await flag("jam_announcement", true);
    expect(await config()).toMatchObject({ enabled: true, announce: true });

    await flag("jam_announcement", null);
    expect(await config()).toMatchObject({ enabled: true, announce: false });
  });

  it("never announces a jam nobody may open: announcement on, jam_public off", async () => {
    await flag("jam_announcement", true);
    expect(await config()).toMatchObject({ enabled: false, announce: false });
  });

  it("turning jam_public off takes the announcement with it", async () => {
    await flag("jam_public", true);
    await flag("jam_announcement", true);
    await flag("jam_public", false);
    expect(await config()).toMatchObject({ enabled: false, announce: false });
  });
});

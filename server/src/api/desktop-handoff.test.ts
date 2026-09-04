import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgeGateStatus } from "@pqp/shared";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../.env") });

/**
 * Desktop handoff mints a 90s Clerk ticket. The suite owns the clerk stub
 * because it has to drive `createDesktopSignInToken` and the age-gate
 * exemption without a live Clerk call.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const stubs = vi.hoisted(() => ({
  actor: null as { id: string; clerk_id: string } | null,
  ageGate: "passed" as AgeGateStatus,
  createDesktopSignInToken: vi.fn(async (_clerkId: string) => "st_test_ticket"),
}));

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  forgetAuthUser: () => {},
  deleteClerkUser: async () => {},
  isClerkUserId: (clerkId: string) => clerkId.startsWith("user_"),
  createDesktopSignInToken: stubs.createDesktopSignInToken,
  resolveAuthUser: async () => (stubs.actor ? { user: stubs.actor } : null),
  resolveAuthSession: async () =>
    stubs.actor ? { user: stubs.actor, ageGate: stubs.ageGate } : null,
  verifyAuthHeader: async () => null,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");

let server: Server;
let baseUrl: string;

interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
}

type Actor = { id: string; clerk_id: string };

async function call<T = Record<string, unknown>>(
  as: Actor | null,
  method: string,
  path: string,
): Promise<ApiResult<T>> {
  stubs.actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test",
    },
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

describeDb("POST /api/desktop/handoff", () => {
  let alice: Actor;

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
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    stubs.ageGate = "passed";
    stubs.createDesktopSignInToken.mockReset();
    stubs.createDesktopSignInToken.mockResolvedValue("st_test_ticket");
    await getPool().query(
      `TRUNCATE users, user_preferences RESTART IDENTITY CASCADE`,
    );
    alice = await upsertUser({
      clerkId: "user_alice",
      displayName: "Alice",
      avatarUrl: null,
    });
  });

  it("refuses a missing session", async () => {
    const result = await call(null, "POST", "/api/desktop/handoff");
    expect(result.status).toBe(401);
    expect(stubs.createDesktopSignInToken).not.toHaveBeenCalled();
  });

  it("returns a ticket for a Clerk user", async () => {
    const result = await call<{ ticket: string }>(
      alice,
      "POST",
      "/api/desktop/handoff",
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ticket: "st_test_ticket" });
    expect(stubs.createDesktopSignInToken).toHaveBeenCalledWith("user_alice");
  });

  it("still mints when the age gate is pending", async () => {
    stubs.ageGate = "pending";
    const result = await call<{ ticket: string }>(
      alice,
      "POST",
      "/api/desktop/handoff",
    );
    expect(result.status).toBe(200);
    expect(result.body.ticket).toBe("st_test_ticket");
  });

  it("still mints when the age gate is blocked", async () => {
    stubs.ageGate = "blocked";
    const result = await call<{ ticket: string }>(
      alice,
      "POST",
      "/api/desktop/handoff",
    );
    expect(result.status).toBe(200);
    expect(result.body.ticket).toBe("st_test_ticket");
  });

  it("refuses a non-Clerk identity", async () => {
    const character = await upsertUser({
      clerkId: "character:not-a-clerk-user",
      displayName: "Bot",
      avatarUrl: null,
    });
    const result = await call(character, "POST", "/api/desktop/handoff");
    expect(result.status).toBe(403);
    expect(stubs.createDesktopSignInToken).not.toHaveBeenCalled();
  });

  it("rate-limits a burst of mints", async () => {
    for (let i = 0; i < 8; i++) {
      const result = await call(alice, "POST", "/api/desktop/handoff");
      expect(result.status).toBe(200);
    }
    const blocked = await call(alice, "POST", "/api/desktop/handoff");
    expect(blocked.status).toBe(429);
  });

  it("surfaces a Clerk failure as 503 without a ticket", async () => {
    stubs.createDesktopSignInToken.mockRejectedValueOnce(new Error("clerk down"));
    const result = await call(alice, "POST", "/api/desktop/handoff");
    expect(result.status).toBe(503);
    expect(result.body).not.toHaveProperty("ticket");
  });
});

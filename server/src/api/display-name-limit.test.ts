import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A new display name is capped at 32 characters, but a stored one can be
 * longer (a Clerk full name is kept untruncated). Installed iOS builds send the
 * stored name back with every Settings save, so an unchanged name must pass
 * whatever its length, and only a changed one is bound by the cap.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const stubs = vi.hoisted(() => ({
  actor: null as { id: string; clerk_id: string } | null,
  load: null as
    | ((clerkId: string) => Promise<Record<string, unknown> | null>)
    | null,
}));

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => {
    const user = stubs.actor && (await stubs.load?.(stubs.actor.clerk_id));
    return user ? { user } : null;
  },
  resolveAuthSession: async () => {
    const user = stubs.actor && (await stubs.load?.(stubs.actor.clerk_id));
    return user ? { user, ageGate: "passed" as const } : null;
  },
  verifyAuthHeader: async () => null,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");

let server: Server;
let baseUrl: string;

async function patchMe(
  as: { id: string; clerk_id: string },
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  stubs.actor = as;
  const response = await fetch(`${baseUrl}/api/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describeDb("PATCH /api/me display name limit", () => {
  const longName = "Maria Fernanda de Albuquerque Santos"; // 36 characters
  let alice: { id: string; clerk_id: string };

  beforeAll(async () => {
    await initDb();
    stubs.load = async (clerkId) => {
      const result = await getPool().query(
        `SELECT id, clerk_id, display_name, username, discriminator, avatar_url,
                avatar_key, is_character, handle, handle_changed_at
           FROM users WHERE clerk_id = $1`,
        [clerkId],
      );
      return result.rows[0] ?? null;
    };
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
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    alice = await upsertUser({
      clerkId: "clerk_alice",
      displayName: longName,
      avatarUrl: null,
    });
    expect(longName.length).toBeGreaterThan(32);
  });

  it("saves other fields when the unchanged long name is sent back", async () => {
    const res = await patchMe(alice, {
      displayName: longName,
      dmPrivacy: "nobody",
    });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe(longName);
    expect(res.body.dmPrivacy).toBe("nobody");
  });

  it("refuses a changed name over 32 characters", async () => {
    const res = await patchMe(alice, { displayName: `${longName} Junior` });
    expect(res.status).toBe(400);
  });

  it("accepts a changed name of 32 characters or fewer", async () => {
    const res = await patchMe(alice, { displayName: "Maria Santos" });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe("Maria Santos");
  });
});

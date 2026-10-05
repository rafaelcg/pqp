import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET /api/servers/:id/stream-alerts`, over HTTP, and the preference it reads.
 *
 * The route exists so the menu shows the REAL state of the switch without the
 * client guessing a member count, so what matters is that the three inputs it
 * folds (the flag, the person's own choice, the server's size and kind) come
 * out right, that a non-member learns nothing (404, not 403), and that the
 * choice survives the preferences route, which strips keys its schema does not
 * know: a PATCH that dropped `notifications.streamAlerts` would make the switch
 * a switch that never stays.
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
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

interface Setting {
  flag: boolean;
  enabled: boolean;
  default: boolean;
  memberCount: number;
}

describeDb("GET /api/servers/:id/stream-alerts", () => {
  let member: Actor;
  let outsider: Actor;
  let serverId: string;

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
    const pool = getPool();
    await pool.query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    member = await upsertUser({ clerkId: "clerk-member", displayName: "Membro", avatarUrl: null });
    outsider = await upsertUser({ clerkId: "clerk-out", displayName: "Fora", avatarUrl: null });
    const created = await pool.query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('Filminho', $1) RETURNING id`,
      [member.id],
    );
    serverId = created.rows[0]!.id;
    await pool.query(`INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      serverId,
      member.id,
    ]);
  });

  afterEach(() => {
    delete process.env.STREAM_START_NOTIFICATIONS;
  });

  it("answers a member with the flag, their effective choice, the default and the size", async () => {
    const off = await call<Setting>(member, "GET", `/api/servers/${serverId}/stream-alerts`);
    expect(off.status).toBe(200);
    // A one-member server is small: the default is on, the flag is off.
    expect(off.body).toEqual({ flag: false, enabled: true, default: true, memberCount: 1 });

    process.env.STREAM_START_NOTIFICATIONS = "true";
    const on = await call<Setting>(member, "GET", `/api/servers/${serverId}/stream-alerts`);
    expect(on.body.flag).toBe(true);
  });

  it("is off by default for a community, and for a server above the ceiling", async () => {
    const pool = getPool();
    await pool.query(`UPDATE servers SET is_community = TRUE WHERE id = $1`, [serverId]);
    const community = await call<Setting>(member, "GET", `/api/servers/${serverId}/stream-alerts`);
    expect(community.body).toMatchObject({ enabled: false, default: false });

    await pool.query(`UPDATE servers SET is_community = FALSE WHERE id = $1`, [serverId]);
    await pool.query(
      `INSERT INTO users (clerk_id, display_name)
       SELECT 'bulk_' || g, 'M' || g FROM generate_series(1, 200) g`,
    );
    await pool.query(
      `INSERT INTO server_members (server_id, user_id, role)
       SELECT $1, id, 'member' FROM users WHERE clerk_id LIKE 'bulk_%'`,
      [serverId],
    );
    const big = await call<Setting>(member, "GET", `/api/servers/${serverId}/stream-alerts`);
    expect(big.body).toMatchObject({ enabled: false, default: false, memberCount: 201 });
  });

  it("follows the person's own choice, written through the preferences route", async () => {
    const patch = await call<{ preferences: { notifications?: { streamAlerts?: Record<string, boolean> } } }>(
      member,
      "PATCH",
      "/api/me/preferences",
      { notifications: { streamAlerts: { [serverId]: false } } },
    );
    expect(patch.status).toBe(200);
    // The schema keeps the key: the answer is the merged object.
    expect(patch.body.preferences.notifications?.streamAlerts).toEqual({ [serverId]: false });
    const stored = await call<Setting>(member, "GET", `/api/servers/${serverId}/stream-alerts`);
    expect(stored.body).toMatchObject({ enabled: false, default: true });

    await call(member, "PATCH", "/api/me/preferences", {
      notifications: { streamAlerts: { [serverId]: true } },
    });
    expect((await call<Setting>(member, "GET", `/api/servers/${serverId}/stream-alerts`)).body.enabled).toBe(
      true,
    );
  });

  it("rejects a choice that is not a boolean for a uuid", async () => {
    const bad = await call(member, "PATCH", "/api/me/preferences", {
      notifications: { streamAlerts: { [serverId]: "yes" } },
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const badKey = await call(member, "PATCH", "/api/me/preferences", {
      notifications: { streamAlerts: { "not-a-uuid": true } },
    });
    expect(badKey.status).toBeGreaterThanOrEqual(400);
  });

  it("tells a non-member nothing, and an unknown server the same", async () => {
    expect((await call(outsider, "GET", `/api/servers/${serverId}/stream-alerts`)).status).toBe(404);
    expect(
      (await call(member, "GET", `/api/servers/00000000-0000-4000-8000-000000000000/stream-alerts`)).status,
    ).toBe(404);
  });
});

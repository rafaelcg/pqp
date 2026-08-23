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

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("./index.js");
const { upsertUser } = await import("../services/users.js");

interface Actor {
  id: string;
  clerk_id: string;
}

interface ApiResult<T> {
  status: number;
  body: T;
}

describeDb("game connections API", () => {
  let server: Server;
  let baseUrl: string;
  let user: Actor;

  beforeAll(async () => {
    await initDb();
    stubs.actor = null;
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
    delete process.env.STEAM_WEB_API_KEY;
    delete process.env.BATTLENET_CLIENT_ID;
    delete process.env.BATTLENET_CLIENT_SECRET;
    delete process.env.TWITCH_CLIENT_ID;
    delete process.env.TWITCH_CLIENT_SECRET;
    process.env.PUBLIC_APP_URL = "http://localhost:5173";
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    const row = await upsertUser({
      clerkId: "clerk_conn_api",
      displayName: "Conn",
      avatarUrl: null,
    });
    user = { id: row.id, clerk_id: row.clerk_id };
  });

  async function call<T = Record<string, unknown>>(
    as: Actor | null,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResult<T>> {
    stubs.actor = as;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(as ? { Authorization: "Bearer test" } : {}),
        Origin: "http://localhost:5173",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : {}) as T,
    };
  }

  it("reports every provider off until credentials exist", async () => {
    const res = await call<{
      steam: boolean;
      battlenet: boolean;
      twitch: boolean;
    }>(user, "GET", "/api/connections/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      steam: false,
      battlenet: false,
      twitch: false,
    });
  });

  it("starts Steam only when a Web API key is set", async () => {
    const off = await call(user, "POST", "/api/me/connections/steam/start");
    expect(off.status).toBe(503);

    process.env.STEAM_WEB_API_KEY = "test-steam-key";
    const on = await call<{ url: string }>(
      user,
      "POST",
      "/api/me/connections/steam/start",
    );
    expect(on.status).toBe(200);
    expect(on.body.url).toContain("steamcommunity.com/openid/login");
    expect(on.body.url).toContain("openid.mode=checkid_setup");
  });

  it("refuses an unknown provider as 404, not as a Steam start", async () => {
    const res = await call(user, "POST", "/api/me/connections/xbox/start");
    expect(res.status).toBe(404);
  });

  it("needs a session even for the config read", async () => {
    const res = await call(null, "GET", "/api/connections/config");
    expect(res.status).toBe(401);
  });

  it("shows shared and public links on the in-app card, never hidden ones", async () => {
    await getPool().query(
      `INSERT INTO user_connections
         (user_id, provider, provider_user_id, display_name, visibility)
       VALUES
         ($1, 'steam', '76561198000000001', 'HiddenSteam', 'hidden'),
         ($1, 'twitch', '42', 'SharedTwitch', 'shared')`,
      [user.id],
    );
    const res = await call<{
      connections: Array<{ provider: string; displayName: string }>;
    }>(user, "GET", `/api/users/${user.id}/connections`);
    expect(res.status).toBe(200);
    expect(res.body.connections).toEqual([
      expect.objectContaining({
        provider: "twitch",
        displayName: "SharedTwitch",
      }),
    ]);
    expect(JSON.stringify(res.body)).not.toContain("HiddenSteam");
    expect(JSON.stringify(res.body)).not.toContain("76561198000000001");
  });

  it("returns an empty list to a stranger, not the shared nick", async () => {
    await getPool().query(
      `INSERT INTO user_connections
         (user_id, provider, provider_user_id, display_name, visibility)
       VALUES ($1, 'steam', '76561198000000001', 'AliceSteam', 'shared')`,
      [user.id],
    );
    const strangerRow = await upsertUser({
      clerkId: "clerk_conn_stranger",
      displayName: "Stranger",
      avatarUrl: null,
    });
    const stranger: Actor = {
      id: strangerRow.id,
      clerk_id: strangerRow.clerk_id,
    };
    const res = await call<{
      connections: Array<{ provider: string; displayName: string }>;
    }>(stranger, "GET", `/api/users/${user.id}/connections`);
    expect(res.status).toBe(200);
    expect(res.body.connections).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain("AliceSteam");
    expect(JSON.stringify(res.body)).not.toContain("76561198000000001");
  });
});

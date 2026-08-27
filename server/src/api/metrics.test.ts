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
 * `GET /api/admin/metrics`, over HTTP, both ways in:
 *
 *  - the machine token (`ADMIN_METRICS_TOKEN`), resolved before Clerk runs,
 *    and absent entirely when the variable is unset or too short;
 *  - an instance moderator's session, same predicate as `/api/admin/acquisition`.
 *
 * Everybody else gets a 404, never a 401: the route does not confirm it exists.
 * And the payload is counts: no ids, no clerk ids, no display names.
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
const { resetAdminMetricsCache, isAdminMetricsTokenValid } = await import(
  "../services/metrics.js"
);

let server: Server;
let baseUrl: string;

type Actor = { id: string; clerk_id: string };

const TOKEN = "0123456789abcdef0123456789abcdef";

async function call<T = Record<string, unknown>>(
  as: Actor | null,
  path: string,
  authorization = "Bearer test",
): Promise<{ status: number; body: T }> {
  stubs.actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: { Authorization: authorization },
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

interface MetricsBody {
  generatedAt: string;
  cacheTtlSeconds: number;
  version: string | null;
  excludedAccounts: string[];
  users: { total: number; last24h: number; byHour: number[] };
  servers: { total: number; last24h: number };
  messages: {
    last24h: number;
    previous24h: number;
    lastHour: number;
    automated24h: number;
    byHour: number[];
  };
  runtime: {
    sampledAt: string;
    sockets: number;
    peakSockets: number;
    pool: {
      max: number;
      total: number;
      idle: number;
      waiting: number;
      busy: number;
      pressure: string;
    };
    peakPoolWaiting: number;
    peakPoolBusy: number;
    peakTrackedSince: string;
  };
  distinctSenders24h: number;
  activeTextChannels24h: number;
  channels: { text: number; voice: number; category: number; thread: number };
  voice: {
    activeRooms: number;
    participants: number;
    largestRoomNow: number;
    peakRoomSizeToday: number;
    peakTrackedSince: string;
    backend: string;
  };
  topServers24h: {
    name: string;
    tagline: string | null;
    channels: number;
    members: number;
    messages24h: number;
  }[];
  acquisition: { days: number; total: number; rows: unknown[] };
  connections: {
    ofUsers: number;
    anyProvider: number;
    anyProviderPublic: number;
    providers: {
      provider: string;
      enabled: boolean;
      linked: number;
      public: number;
      shared: number;
      hidden: number;
    }[];
  };
}

describe("isAdminMetricsTokenValid", () => {
  beforeEach(() => {
    delete process.env.ADMIN_METRICS_TOKEN;
  });

  it("is disabled when the variable is unset or too short", () => {
    expect(isAdminMetricsTokenValid(`Bearer ${TOKEN}`)).toBe(false);
    process.env.ADMIN_METRICS_TOKEN = "short";
    expect(isAdminMetricsTokenValid("Bearer short")).toBe(false);
  });

  it("accepts only the exact token under the Bearer scheme", () => {
    process.env.ADMIN_METRICS_TOKEN = TOKEN;
    expect(isAdminMetricsTokenValid(`Bearer ${TOKEN}`)).toBe(true);
    expect(isAdminMetricsTokenValid(`bearer ${TOKEN}`)).toBe(true);
    expect(isAdminMetricsTokenValid(`Basic ${TOKEN}`)).toBe(false);
    expect(isAdminMetricsTokenValid(`Bearer ${TOKEN}x`)).toBe(false);
    expect(isAdminMetricsTokenValid(`Bearer ${TOKEN.slice(0, -1)}`)).toBe(false);
    expect(isAdminMetricsTokenValid(TOKEN)).toBe(false);
    expect(isAdminMetricsTokenValid(undefined)).toBe(false);
  });
});

describeDb("GET /api/admin/metrics", () => {
  let ana: Actor;
  let operator: Actor;
  let webhook: Actor;
  let textChannelId: string;

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
    delete process.env.ADMIN_METRICS_TOKEN;
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    resetAdminMetricsCache();
    delete process.env.ADMIN_METRICS_TOKEN;
    const pool = getPool();
    await pool.query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    ana = await upsertUser({ clerkId: "clerk-ana", displayName: "Ana", avatarUrl: null });
    operator = await upsertUser({
      clerkId: "clerk-operator",
      displayName: "Operator",
      avatarUrl: null,
    });
    webhook = await upsertUser({
      clerkId: "clerk-webhook",
      displayName: "Deploy bot",
      avatarUrl: null,
    });
    await pool.query(`UPDATE users SET is_webhook = TRUE WHERE id = $1`, [webhook.id]);
    process.env.INSTANCE_MODERATOR_CLERK_IDS = operator.clerk_id;

    // One server, one text channel, one voice channel, one category. Ana
    // writes two messages today and one 30 hours ago; the webhook writes one.
    const created = await pool.query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('Clube', $1) RETURNING id`,
      [ana.id],
    );
    const serverId = created.rows[0]!.id;
    await pool.query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
      [serverId, ana.id, operator.id],
    );
    const channels = await pool.query<{ id: string; type: string }>(
      `INSERT INTO channels (server_id, name, type)
       VALUES ($1, 'geral', 'text'), ($1, 'voz', 'voice'), ($1, 'pasta', 'category')
       RETURNING id, type`,
      [serverId],
    );
    textChannelId = channels.rows.find((c) => c.type === "text")!.id;
    await pool.query(
      `INSERT INTO messages (channel_id, author_id, body, created_at) VALUES
         ($1, $2, 'oi', now()),
         ($1, $2, 'tudo bem?', now() - interval '5 minutes'),
         ($1, $2, 'ontem', now() - interval '30 hours'),
         ($1, $3, 'deploy ok', now())`,
      [textChannelId, ana.id, webhook.id],
    );

    // Game connections: Ana shows Steam publicly, the operator has Steam at
    // the default visibility plus a hidden Twitch, and the webhook has a Steam
    // row that must not be counted. No provider credentials are configured, so
    // every provider reports as disabled.
    for (const name of [
      "STEAM_WEB_API_KEY",
      "TWITCH_CLIENT_ID",
      "TWITCH_CLIENT_SECRET",
      "BATTLENET_CLIENT_ID",
      "BATTLENET_CLIENT_SECRET",
    ]) {
      delete process.env[name];
    }
    await pool.query(
      `INSERT INTO user_connections (user_id, provider, provider_user_id, display_name, visibility)
       VALUES ($1, 'steam', '7656119800000001', 'a', 'public'),
              ($2, 'steam', '7656119800000002', 'b', 'shared'),
              ($2, 'twitch', 'tw-operator', 'c', 'hidden'),
              ($3, 'steam', '7656119800000003', 'd', 'public')`,
      [ana.id, operator.id, webhook.id],
    );
  });

  it("answers 404 without any credential and to a signed-in non-moderator", async () => {
    // No token configured, no session: 404, not 401.
    expect((await call(null, "/api/admin/metrics")).status).toBe(404);
    // A signed-in member who is not an instance moderator.
    expect((await call(ana, "/api/admin/metrics")).status).toBe(404);
    // The rest of the API still says 401 to the unauthenticated.
    expect((await call(null, "/api/admin/acquisition")).status).toBe(401);
  });

  it("ignores the token path entirely while ADMIN_METRICS_TOKEN is unset", async () => {
    expect((await call(null, "/api/admin/metrics", `Bearer ${TOKEN}`)).status).toBe(404);
    process.env.ADMIN_METRICS_TOKEN = "tooshort";
    expect((await call(null, "/api/admin/metrics", "Bearer tooshort")).status).toBe(404);
  });

  it("answers the machine token with the payload, and a wrong token with 404", async () => {
    process.env.ADMIN_METRICS_TOKEN = TOKEN;
    expect((await call(null, "/api/admin/metrics", `Bearer ${TOKEN}x`)).status).toBe(404);
    expect((await call(null, "/api/admin/metrics", "Bearer test")).status).toBe(404);

    const result = await call<MetricsBody>(null, "/api/admin/metrics", `Bearer ${TOKEN}`);
    expect(result.status).toBe(200);
    expect(result.body.users.total).toBe(2);
    // The token only opens this one route.
    expect((await call(null, "/api/admin/acquisition", `Bearer ${TOKEN}`)).status).toBe(401);
    expect((await call(null, "/api/me", `Bearer ${TOKEN}`)).status).toBe(401);
  });

  it("answers an instance moderator with counts and no identities", async () => {
    const result = await call<MetricsBody>(operator, "/api/admin/metrics");
    expect(result.status).toBe(200);
    const body = result.body;

    expect(Date.parse(body.generatedAt)).not.toBeNaN();
    expect(body.cacheTtlSeconds).toBe(30);
    expect(body.excludedAccounts).toEqual(["webhook", "character"]);

    // People only: the webhook pseudo-account is not a user.
    expect(body.users).toMatchObject({ total: 2, last24h: 2 });
    expect(body.users.byHour).toHaveLength(24);
    expect(body.users.byHour.reduce((a, b) => a + b, 0)).toBe(2);
    expect(body.users.byHour[23]).toBe(2);

    expect(body.servers).toEqual({ total: 1, last24h: 1 });
    expect(body.channels).toEqual({ text: 1, voice: 1, category: 1, thread: 0 });

    // Two human messages in the window, one 30 hours ago, one automated.
    expect(body.messages.last24h).toBe(2);
    expect(body.messages.previous24h).toBe(1);
    expect(body.messages.lastHour).toBe(2);
    expect(body.messages.automated24h).toBe(1);
    expect(body.messages.byHour).toHaveLength(24);
    expect(body.messages.byHour.reduce((a, b) => a + b, 0)).toBe(2);
    expect(body.distinctSenders24h).toBe(1);
    expect(body.activeTextChannels24h).toBe(1);

    expect(body.topServers24h).toEqual([
      { name: "Clube", tagline: null, channels: 2, members: 2, messages24h: 2 },
    ]);

    expect(body.voice).toMatchObject({
      activeRooms: 0,
      participants: 0,
      largestRoomNow: 0,
      peakRoomSizeToday: 0,
      backend: "mesh",
    });
    expect(Date.parse(body.voice.peakTrackedSince)).not.toBeNaN();

    expect(body.acquisition.days).toBe(7);
    expect(body.acquisition.total).toBe(2);

    // Two people have linked something, three links between them; the webhook
    // row is not a person. The share is of `users.total`, so it is 2 of 2.
    expect(body.connections.ofUsers).toBe(body.users.total);
    expect(body.connections).toEqual({
      ofUsers: 2,
      anyProvider: 2,
      anyProviderPublic: 1,
      providers: [
        { provider: "steam", enabled: false, linked: 2, public: 1, shared: 1, hidden: 0 },
        { provider: "battlenet", enabled: false, linked: 0, public: 0, shared: 0, hidden: 0 },
        { provider: "twitch", enabled: false, linked: 1, public: 0, shared: 0, hidden: 1 },
      ],
    });

    // Counts, never people.
    const text = JSON.stringify(body);
    for (const secret of [ana.id, operator.id, webhook.id, "clerk-", "Ana", "Operator", "Deploy bot"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("serves the cached counts for 30 seconds", async () => {
    const first = await call<MetricsBody>(operator, "/api/admin/metrics");
    expect(first.body.messages.last24h).toBe(2);

    await getPool().query(
      `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'mais uma')`,
      [textChannelId, ana.id],
    );
    const second = await call<MetricsBody>(operator, "/api/admin/metrics");
    expect(second.body.messages.last24h).toBe(2);
    expect(second.body.generatedAt).toBe(first.body.generatedAt);

    resetAdminMetricsCache();
    const third = await call<MetricsBody>(operator, "/api/admin/metrics");
    expect(third.body.messages.last24h).toBe(3);
  });

  it("carries a runtime block, and never a cached one", async () => {
    const first = await call<MetricsBody>(operator, "/api/admin/metrics");
    const runtime = first.body.runtime;

    // The pool this very request ran on. No socket server in this suite, so the
    // socket count is legitimately zero.
    expect(runtime.pool.max).toBeGreaterThan(0);
    expect(runtime.pool.busy).toBe(runtime.pool.total - runtime.pool.idle);
    expect(["ok", "tight", "saturated"]).toContain(runtime.pool.pressure);
    expect(runtime.sockets).toBe(0);
    expect(Date.parse(runtime.sampledAt)).not.toBeNaN();
    expect(Date.parse(runtime.peakTrackedSince)).not.toBeNaN();

    // The counts come from the cache; the runtime block does not. A stale
    // `waiting` would be worse than none, because it reads as calm during the
    // one event it exists to report.
    await new Promise((done) => setTimeout(done, 5));
    const second = await call<MetricsBody>(operator, "/api/admin/metrics");
    expect(second.body.generatedAt).toBe(first.body.generatedAt);
    expect(second.body.runtime.sampledAt).not.toBe(runtime.sampledAt);
  });
});

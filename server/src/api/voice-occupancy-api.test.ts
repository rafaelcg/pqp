import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * `GET /api/admin/voice-occupancy` and `GET /api/channels/:id/voice-transport`.
 *
 * The first is the history the operator dashboard charts, and it rides the
 * same `ADMIN_METRICS_TOKEN` as `/api/admin/metrics` and the same rule that a
 * refusal is a 404: the route does not confirm it exists.
 *
 * The second is the channel settings sheet's read, and its whole job is to
 * keep two facts apart that look like one. What the channel is CONFIGURED as
 * ("Automático") is not what a call in it would RUN as, and neither is what
 * the call happening right now is actually using, because a room's path is
 * pinned when the first person joins and does not move while anybody is in it.
 * A UI that showed one number would be wrong two ways.
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

const { handleApi, resetApiRateLimits, occupancyQuery } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { OCCUPANCY_TIMEZONE, DEFAULT_OCCUPANCY_DAYS } = await import(
  "../services/voice-occupancy.js"
);

const TOKEN = "0123456789abcdef0123456789abcdef";

let server: Server;
let baseUrl: string;

type Actor = { id: string; clerk_id: string };

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

describe("occupancyQuery", () => {
  it("takes the narrower request when both are present", () => {
    const params = new URLSearchParams("days=90&day=2026-09-06");
    expect(occupancyQuery(params)).toEqual({ days: 90, day: "2026-09-06" });
  });

  it("drops a malformed day instead of failing the request", () => {
    expect(occupancyQuery(new URLSearchParams("day=06%2F09%2F2026"))).toEqual({
      days: DEFAULT_OCCUPANCY_DAYS,
      day: null,
    });
  });

  it("falls back to the default range on junk", () => {
    expect(occupancyQuery(new URLSearchParams("days=-1")).days).toBe(
      DEFAULT_OCCUPANCY_DAYS,
    );
    expect(occupancyQuery(new URLSearchParams()).days).toBe(
      DEFAULT_OCCUPANCY_DAYS,
    );
  });
});

interface OccupancyBody {
  granularity: string;
  timezone: string;
  lastSampleAt: string | null;
  points: { at: string; participants: number; mesh: number; livekit: number }[];
}

describeDb("GET /api/admin/voice-occupancy", () => {
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
    delete process.env.ADMIN_METRICS_TOKEN;
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    delete process.env.ADMIN_METRICS_TOKEN;
    const pool = getPool();
    await pool.query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    await pool.query(
      `TRUNCATE voice_occupancy_samples, voice_occupancy_daily`,
    );
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
    await pool.query(
      `INSERT INTO voice_occupancy_daily
         (day, peak_participants, peak_mesh, peak_livekit, peak_rooms, peak_largest_room)
       SELECT ((NOW() AT TIME ZONE $1)::date - g), 100 - g, g, 100 - 2 * g, 1, 10
         FROM generate_series(0, 40) AS g`,
      [OCCUPANCY_TIMEZONE],
    );
  });

  it("answers the machine token, and only the exact one", async () => {
    process.env.ADMIN_METRICS_TOKEN = TOKEN;
    const ok = await call<OccupancyBody>(null, "/api/admin/voice-occupancy", `Bearer ${TOKEN}`);
    expect(ok.status).toBe(200);
    expect(ok.body.granularity).toBe("day");
    expect(ok.body.timezone).toBe(OCCUPANCY_TIMEZONE);

    const wrong = await call(null, "/api/admin/voice-occupancy", `Bearer ${TOKEN}x`);
    expect(wrong.status).toBe(404);
  });

  it("does not exist when the token is unset", async () => {
    delete process.env.ADMIN_METRICS_TOKEN;
    const attempt = await call(null, "/api/admin/voice-occupancy", `Bearer ${TOKEN}`);
    expect(attempt.status).toBe(404);
  });

  it("refuses with 404 rather than 401, so it never confirms it is there", async () => {
    const anonymous = await call(null, "/api/admin/voice-occupancy");
    expect(anonymous.status).toBe(404);
    const member = await call(ana, "/api/admin/voice-occupancy");
    expect(member.status).toBe(404);
  });

  it("answers an instance moderator's session", async () => {
    const response = await call<OccupancyBody>(operator, "/api/admin/voice-occupancy");
    expect(response.status).toBe(200);
    expect(response.body.points.length).toBe(DEFAULT_OCCUPANCY_DAYS);
  });

  it("honours ?days= and clamps it", async () => {
    const week = await call<OccupancyBody>(operator, "/api/admin/voice-occupancy?days=7");
    expect(week.body.points).toHaveLength(7);

    const junk = await call<OccupancyBody>(operator, "/api/admin/voice-occupancy?days=abc");
    expect(junk.body.points).toHaveLength(DEFAULT_OCCUPANCY_DAYS);

    const huge = await call<OccupancyBody>(operator, "/api/admin/voice-occupancy?days=99999");
    // Only 41 days were seeded, so the cap shows up as "everything there is"
    // rather than an error or a refusal.
    expect(huge.status).toBe(200);
    expect(huge.body.points).toHaveLength(41);
  });

  it("drops to minute resolution for ?day=", async () => {
    await getPool().query(
      `INSERT INTO voice_occupancy_samples
         (bucket_at, participants, mesh_participants, livekit_participants,
          rooms, mesh_rooms, livekit_rooms, largest_room)
       VALUES ('2026-09-06T23:00:00Z', 30, 2, 28, 4, 1, 3, 20)`,
    );
    const day = await call<OccupancyBody>(
      operator,
      "/api/admin/voice-occupancy?day=2026-09-06",
    );
    expect(day.status).toBe(200);
    expect(day.body.granularity).toBe("minute");
    expect(day.body.points).toHaveLength(1);
    expect(day.body.points[0]!.livekit).toBe(28);
  });
});

interface RouteBody {
  configured: string | null;
  resolved: { transport: string; reason: string };
  live: { transport: string; participants: number } | null;
}

describeDb("GET /api/channels/:channelId/voice-transport", () => {
  let owner: Actor;
  let stranger: Actor;
  let voiceChannelId: string;
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
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  afterEach(() => {
    delete process.env.VOICE_REGISTRY;
    delete process.env.LIVEKIT_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    delete process.env.VOICE_BACKEND;
  });

  beforeEach(async () => {
    resetApiRateLimits();
    const pool = getPool();
    await pool.query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    await pool.query(`TRUNCATE voice_peers, voice_rooms CASCADE`);
    owner = await upsertUser({
      clerkId: "clerk-owner",
      displayName: "Dona",
      avatarUrl: null,
    });
    stranger = await upsertUser({
      clerkId: "clerk-stranger",
      displayName: "Zé",
      avatarUrl: null,
    });
    const created = await pool.query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('Clube', $1) RETURNING id`,
      [owner.id],
    );
    const serverId = created.rows[0]!.id;
    await pool.query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [serverId, owner.id],
    );
    const channels = await pool.query<{ id: string; type: string }>(
      `INSERT INTO channels (server_id, name, type)
       VALUES ($1, 'voz', 'voice'), ($1, 'geral', 'text')
       RETURNING id, type`,
      [serverId],
    );
    voiceChannelId = channels.rows.find((c) => c.type === "voice")!.id;
    textChannelId = channels.rows.find((c) => c.type === "text")!.id;
  });

  it("says a small server opens peer to peer, and why", async () => {
    const response = await call<RouteBody>(
      owner,
      `/api/channels/${voiceChannelId}/voice-transport`,
    );
    expect(response.status).toBe(200);
    expect(response.body.configured).toBeNull();
    expect(response.body.resolved.transport).toBe("mesh");
    // No SFU configured in the test process, so the honest reason is that the
    // deployment has none, not that the server is small.
    expect(response.body.resolved.reason).toBe("unconfigured");
    expect(response.body.live).toBeNull();
  });

  it("reports the override as the reason once one is set", async () => {
    process.env.VOICE_BACKEND = "livekit";
    process.env.LIVEKIT_URL = "wss://sfu.example";
    process.env.LIVEKIT_API_KEY = "key";
    process.env.LIVEKIT_API_SECRET = "secret";
    await getPool().query(
      `UPDATE channels SET voice_transport = 'livekit' WHERE id = $1`,
      [voiceChannelId],
    );
    const response = await call<RouteBody>(
      owner,
      `/api/channels/${voiceChannelId}/voice-transport`,
    );
    expect(response.body.configured).toBe("livekit");
    expect(response.body.resolved).toEqual({
      transport: "livekit",
      reason: "override",
    });
  });

  it("reports the live call separately from the setting, pin and all", async () => {
    // The trap this endpoint exists for: the channel now says "large", but the
    // call in it started on the small-server path and keeps it until it
    // empties. Configured, resolved and live are three different answers.
    process.env.VOICE_REGISTRY = "postgres";
    process.env.VOICE_BACKEND = "livekit";
    process.env.LIVEKIT_URL = "wss://sfu.example";
    process.env.LIVEKIT_API_KEY = "key";
    process.env.LIVEKIT_API_SECRET = "secret";
    await getPool().query(
      `UPDATE channels SET voice_transport = 'livekit' WHERE id = $1`,
      [voiceChannelId],
    );
    await getPool().query(
      `INSERT INTO voice_rooms (channel_id, transport) VALUES ($1, 'mesh')`,
      [voiceChannelId],
    );
    for (let i = 0; i < 3; i += 1) {
      await getPool().query(
        `INSERT INTO voice_peers (peer_id, channel_id, user_id, instance_id, display_name)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), voiceChannelId, randomUUID(), randomUUID(), `p${i}`],
      );
    }

    const response = await call<RouteBody>(
      owner,
      `/api/channels/${voiceChannelId}/voice-transport`,
    );
    expect(response.body.resolved.transport).toBe("livekit");
    expect(response.body.live).toEqual({ transport: "mesh", participants: 3 });
  });

  it("is not a text channel route and not a stranger's route", async () => {
    const text = await call(owner, `/api/channels/${textChannelId}/voice-transport`);
    expect(text.status).toBe(404);

    const outsider = await call(
      stranger,
      `/api/channels/${voiceChannelId}/voice-transport`,
    );
    expect(outsider.status).toBeGreaterThanOrEqual(400);
  });
});

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { WebSocket } from "ws";
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
 * The watch party waitlist, over HTTP, against a real Postgres, with the flags
 * production sets (`VOICE_REGISTRY=postgres`, `CLUSTER_BUS=postgres` and a real
 * Postgres bus installed) and with `LIVE_HLS_SERVER_ALLOWLIST` SET, because a
 * fallback proved with the variable unset proves nothing about production
 * (CLAUDE.md pitfall 12).
 *
 * What is pinned:
 *  - who may ASK (the owner or an admin: `request`) and who may only say they
 *    would watch (a member: `interest`), decided by the server;
 *  - nobody reads anybody else's row;
 *  - a server that already runs watch parties refuses a join;
 *  - the operator's "Ativar" is the availability flip with low latency beside
 *    it, and turning a server on approves its waiting rows, tells the people
 *    on this machine's sockets, publishes on the bus for the other machine,
 *    and leaves a durable row for anybody offline;
 *  - the new machine routes, and the counters on `GET /api/admin/metrics`.
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
const { resetAdminMetricsCache } = await import("../services/metrics.js");
const { setAuthenticatedSocket, deleteAuthenticatedSocket } = await import(
  "../ws/sockets.js"
);
const bus = await import("../lib/bus.js");
const { createPostgresBusTransport } = await import("../lib/bus-postgres.js");
const { liveHlsConfigForServer } = await import("../voice/hls-egress.js");

const TOKEN = "0123456789abcdef0123456789abcdef";

type Actor = { id: string; clerk_id: string };

let server: Server;
let baseUrl: string;

async function call<T = Record<string, unknown>>(
  as: Actor | "machine",
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  stubs.actor = as === "machine" ? null : as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: as === "machine" ? `Bearer ${TOKEN}` : "Bearer session",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

/** A socket the approval can reach, recording what it was sent. */
function fakeSocket(): WebSocket & { frames: unknown[] } {
  const frames: unknown[] = [];
  return {
    readyState: 1,
    frames,
    send: (data: string) => {
      frames.push(JSON.parse(data));
    },
  } as unknown as WebSocket & { frames: unknown[] };
}

const LIVE_HLS_ENV: Record<string, string> = {
  LIVE_HLS_ENABLED: "true",
  LIVEKIT_URL: "wss://sfu.example.test",
  LIVEKIT_API_KEY: "key",
  LIVEKIT_API_SECRET: "secret",
  LIVE_HLS_PUBLIC_BASE_URL: "https://live.example.test",
  LIVE_HLS_S3_BUCKET: "pqp-live-test",
  LIVE_HLS_S3_ACCESS_KEY_ID: "ak",
  LIVE_HLS_S3_SECRET_ACCESS_KEY: "sk",
  LIVE_HLS_S3_ENDPOINT: "https://s3.example.test",
  // Low latency configured, so the dashboard's LL switch has something to
  // switch: the flag and the edge playlist front are its master switches.
  LIVE_HLS_LL: "true",
  LIVE_HLS_PLAYLIST_BASE_URL: "https://hls.example.test",
  VOICE_REGISTRY: "postgres",
  CLUSTER_BUS: "postgres",
};

describeDb("the watch party waitlist", () => {
  let owner: Actor;
  let admin: Actor;
  let member: Actor;
  let stranger: Actor;
  let serverId: string;
  let enabledServerId: string;
  let busTransport: ReturnType<typeof createPostgresBusTransport> | null = null;
  const busFrames: { topic: string; data: unknown }[] = [];
  let stopObserving: (() => void) | null = null;

  beforeAll(async () => {
    await initDb();
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => server.listen(0, done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The bus production runs, for real: an approval has to reach the
    // other API machine's sockets too.
    busTransport = createPostgresBusTransport(DATABASE_URL);
    bus.setBusTransport(busTransport);
    stopObserving = bus.observeBusFrames((frame) => {
      busFrames.push({ topic: frame.topic, data: frame.data });
    });
  });

  afterAll(async () => {
    stopObserving?.();
    bus.setBusTransport(null);
    await busTransport?.close?.();
    for (const name of Object.keys(LIVE_HLS_ENV)) {
      delete process.env[name];
    }
    delete process.env.LIVE_HLS_SERVER_ALLOWLIST;
    delete process.env.LIVE_HLS_LL_ALLOWLIST;
    delete process.env.ADMIN_METRICS_TOKEN;
    delete process.env.WATCH_PARTY_WAITLIST;
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    resetAdminMetricsCache();
    busFrames.length = 0;
    process.env.ADMIN_METRICS_TOKEN = TOKEN;
    for (const [name, value] of Object.entries(LIVE_HLS_ENV)) {
      process.env[name] = value;
    }
    delete process.env.WATCH_PARTY_WAITLIST;

    const pool = getPool();
    await pool.query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    owner = await upsertUser({ clerkId: "clerk-owner", displayName: "Dona", avatarUrl: null });
    admin = await upsertUser({ clerkId: "clerk-admin", displayName: "Adm", avatarUrl: null });
    member = await upsertUser({ clerkId: "clerk-member", displayName: "Bia", avatarUrl: null });
    stranger = await upsertUser({ clerkId: "clerk-stranger", displayName: "Zé", avatarUrl: null });

    const created = await pool.query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('Sessão do sodtz', $1), ('Cinemoon', $1)
       RETURNING id`,
      [owner.id],
    );
    serverId = created.rows[0]!.id;
    enabledServerId = created.rows[1]!.id;
    for (const id of [serverId, enabledServerId]) {
      await pool.query(
        `INSERT INTO server_members (server_id, user_id, role)
         VALUES ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'member')`,
        [id, owner.id, admin.id, member.id],
      );
    }
    // Production's shape: the environment names the server that already runs
    // parties, and the one asking for them is off.
    process.env.LIVE_HLS_SERVER_ALLOWLIST = enabledServerId;
    process.env.LIVE_HLS_LL_ALLOWLIST = enabledServerId;
  });

  afterEach(() => {
    stubs.actor = null;
  });

  const join = (as: Actor, body: Record<string, unknown>) =>
    call<{ entry: Record<string, unknown>; error?: string }>(
      as,
      "POST",
      "/api/watch-party/waitlist",
      body,
    );

  describe("joining", () => {
    it("tells the owner they may ask, and that nothing is on yet", async () => {
      const state = await call(owner, "GET", `/api/watch-party/waitlist?serverId=${serverId}`);
      expect(state.status).toBe(200);
      expect(state.body).toEqual({
        campaign: true,
        canRequest: true,
        available: false,
        entry: null,
      });
    });

    it("records the owner's request, normalised, and a second submit edits it", async () => {
      const first = await join(owner, {
        serverId,
        audienceBucket: "50-150",
        note: "Final do campeonato",
        streamChannel: "https://www.Twitch.tv/SodTZ/",
      });
      expect(first.status).toBe(200);
      expect(first.body.entry).toMatchObject({
        serverId,
        kind: "request",
        status: "waiting",
        audienceBucket: "50-150",
        note: "Final do campeonato",
        streamChannel: "twitch.tv/sodtz",
        decidedAt: null,
      });

      const second = await join(owner, {
        serverId,
        audienceBucket: "150-500",
        streamChannel: "kick.com/sodtz",
      });
      expect(second.status).toBe(200);
      expect(second.body.entry).toMatchObject({
        audienceBucket: "150-500",
        note: null,
        streamChannel: "kick.com/sodtz",
      });
      const rows = await getPool().query(
        `SELECT 1 FROM watch_party_waitlist WHERE server_id = $1`,
        [serverId],
      );
      expect(rows.rowCount).toBe(1);
    });

    it("asks a requester how many would watch", async () => {
      const response = await join(owner, { serverId });
      expect(response.status).toBe(400);
    });

    it("makes an admin's row a request and a member's row interest", async () => {
      const asAdmin = await join(admin, { serverId, audienceBucket: "20-50" });
      expect(asAdmin.body.entry).toMatchObject({ kind: "request" });

      const state = await call(member, "GET", `/api/watch-party/waitlist?serverId=${serverId}`);
      expect(state.body).toMatchObject({ canRequest: false, entry: null });
      const asMember = await join(member, { serverId });
      expect(asMember.status).toBe(200);
      expect(asMember.body.entry).toMatchObject({ kind: "interest", status: "waiting" });
    });

    it("never shows anybody else's row", async () => {
      await join(owner, { serverId, audienceBucket: "50-150", note: "segredo" });
      const state = await call<{ entry: unknown }>(
        member,
        "GET",
        `/api/watch-party/waitlist?serverId=${serverId}`,
      );
      expect(state.body.entry).toBeNull();
      expect(JSON.stringify(state.body)).not.toContain("segredo");
    });

    it("answers a stranger with the same 404 as any server route", async () => {
      expect((await call(stranger, "GET", `/api/watch-party/waitlist?serverId=${serverId}`)).status).toBe(404);
      expect((await join(stranger, { serverId, audienceBucket: "under-20" })).status).toBe(404);
    });

    it("refuses a server that already runs watch parties", async () => {
      const state = await call(owner, "GET", `/api/watch-party/waitlist?serverId=${enabledServerId}`);
      expect(state.body).toMatchObject({ available: true });
      const response = await join(owner, { serverId: enabledServerId, audienceBucket: "under-20" });
      expect(response.status).toBe(409);
    });

    it("takes interest from somebody with no server yet", async () => {
      const first = await join(stranger, { serverId: null, note: "filmes de terror" });
      expect(first.status).toBe(200);
      expect(first.body.entry).toMatchObject({ serverId: null, kind: "interest" });
      const again = await join(stranger, { serverId: null, audienceBucket: "under-20" });
      expect(again.status).toBe(200);
      const rows = await getPool().query(
        `SELECT 1 FROM watch_party_waitlist WHERE user_id = $1`,
        [stranger.id],
      );
      expect(rows.rowCount).toBe(1);
      const state = await call(stranger, "GET", "/api/watch-party/waitlist");
      expect(state.body).toMatchObject({
        canRequest: false,
        entry: { serverId: null, audienceBucket: "under-20" },
      });
    });

    it("refuses a channel that is not Twitch or Kick, and a note that runs long", async () => {
      expect(
        (await join(owner, { serverId, audienceBucket: "under-20", streamChannel: "youtube.com/foo" })).status,
      ).toBe(400);
      expect(
        (await join(owner, { serverId, audienceBucket: "under-20", note: "x".repeat(141) })).status,
      ).toBe(400);
      expect(
        (await join(owner, { serverId, audienceBucket: "lots" })).status,
      ).toBe(400);
    });

    it("is off, and says so, when the deployment is not running the campaign", async () => {
      process.env.WATCH_PARTY_WAITLIST = "off";
      const state = await call(owner, "GET", `/api/watch-party/waitlist?serverId=${serverId}`);
      expect(state.body).toMatchObject({ campaign: false });
      expect((await join(owner, { serverId, audienceBucket: "under-20" })).status).toBe(404);
    });

    it("follows LIVE_HLS_ENABLED when the variable is unset, so a self-host never teases", async () => {
      delete process.env.LIVE_HLS_ENABLED;
      const state = await call(owner, "GET", `/api/watch-party/waitlist?serverId=${serverId}`);
      expect(state.body).toMatchObject({ campaign: false });
    });

    it("rate limits a script", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        statuses.push((await join(owner, { serverId, audienceBucket: "under-20" })).status);
      }
      expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      expect(statuses).toContain(429);
    });
  });

  describe("the operator", () => {
    it("lists servers with their requests, interest as a count, and serverless interest", async () => {
      await join(owner, {
        serverId,
        audienceBucket: "50-150",
        note: "Final do campeonato",
        streamChannel: "twitch.tv/sodtz",
      });
      await join(member, { serverId, audienceBucket: "20-50" });
      await join(stranger, { serverId: null });

      const list = await call<{
        servers: Record<string, unknown>[];
        serverless: number;
        totals: Record<string, number>;
      }>("machine", "GET", "/api/admin/watch-party-waitlist");
      expect(list.status).toBe(200);
      expect(list.body.serverless).toBe(1);
      expect(list.body.totals).toEqual({ waiting: 3, approved: 0, declined: 0 });
      expect(list.body.servers).toHaveLength(1);
      expect(list.body.servers[0]).toMatchObject({
        serverId,
        name: "Sessão do sodtz",
        memberCount: 3,
        status: "waiting",
        interest: 1,
        buckets: { "50-150": 1, "20-50": 1 },
        liveHlsOverride: null,
        liveHlsLlOverride: null,
        requests: [
          {
            note: "Final do campeonato",
            streamChannel: "twitch.tv/sodtz",
            audienceBucket: "50-150",
          },
        ],
      });
      // Interest is a count: the member's name is not on the page.
      expect(JSON.stringify(list.body)).not.toContain("Bia");
    });

    it("is not reachable with no token, nor by a member's session", async () => {
      stubs.actor = null;
      const bare = await fetch(`${baseUrl}/api/admin/watch-party-waitlist`);
      expect([401, 404]).toContain(bare.status);
      expect((await call(owner, "GET", "/api/admin/watch-party-waitlist")).status).toBe(404);
    });

    it("Ativar turns the server and low latency on, approves every waiting row, and tells them", async () => {
      await join(owner, { serverId, audienceBucket: "50-150" });
      await join(member, { serverId });
      const ownerSocket = fakeSocket();
      const strangerSocket = fakeSocket();
      setAuthenticatedSocket(ownerSocket, owner as never);
      setAuthenticatedSocket(strangerSocket, stranger as never);
      try {
        const flip = await call<Record<string, unknown>>(
          "machine",
          "PUT",
          "/api/admin/server-live-hls",
          { serverId, enabled: true, lowLatency: true },
        );
        expect(flip.status).toBe(200);
        expect(flip.body).toMatchObject({
          liveHlsOverride: true,
          liveHlsEffective: true,
          liveHlsLlOverride: true,
          liveHlsLlEffective: true,
          liveHlsLlSource: "server",
        });

        const columns = await getPool().query<{
          live_hls_enabled: boolean | null;
          live_hls_ll_enabled: boolean | null;
        }>(`SELECT live_hls_enabled, live_hls_ll_enabled FROM servers WHERE id = $1`, [serverId]);
        expect(columns.rows[0]).toEqual({ live_hls_enabled: true, live_hls_ll_enabled: true });

        const statuses = await getPool().query<{ status: string }>(
          `SELECT status FROM watch_party_waitlist WHERE server_id = $1`,
          [serverId],
        );
        expect(statuses.rows.map((row) => row.status)).toEqual(["approved", "approved"]);

        expect(ownerSocket.frames).toEqual([
          { type: "watch-party-waitlist-approved", serverId, serverName: "Sessão do sodtz" },
        ]);
        expect(strangerSocket.frames).toEqual([]);
        // And the other machine hears it over the bus, addressed to both.
        await vi.waitFor(() => {
          const frame = busFrames.find((f) => f.topic === "watch-party.waitlist-approved");
          expect(frame?.data).toMatchObject({
            serverId,
            userIds: expect.arrayContaining([owner.id, member.id]),
          });
        });
      } finally {
        deleteAuthenticatedSocket(ownerSocket);
        deleteAuthenticatedSocket(strangerSocket);
      }

      // The config a client reads now says yes to both.
      const config = await liveHlsConfigForServer(serverId);
      expect(config.enabled).toBe(true);
      expect(config.lowLatency.available).toBe(true);

      // The durable half: somebody offline sees it on their next load, once.
      const approvals = await call<{ approvals: Record<string, unknown>[] }>(
        member,
        "GET",
        "/api/watch-party/waitlist/approvals",
      );
      expect(approvals.body.approvals).toEqual([
        expect.objectContaining({ serverId, serverName: "Sessão do sodtz", kind: "interest" }),
      ]);
      expect(
        (await call(member, "POST", "/api/watch-party/waitlist/approvals/ack", { serverId })).status,
      ).toBe(200);
      const after = await call<{ approvals: unknown[] }>(
        member,
        "GET",
        "/api/watch-party/waitlist/approvals",
      );
      expect(after.body.approvals).toEqual([]);

      // A second flip tells nobody twice.
      busFrames.length = 0;
      await call("machine", "PUT", "/api/admin/server-live-hls", { serverId, enabled: true });
      expect(busFrames.filter((f) => f.topic === "watch-party.waitlist-approved")).toEqual([]);
    });

    it("moves low latency on its own without touching availability, and refuses an empty change", async () => {
      const flip = await call<Record<string, unknown>>(
        "machine",
        "PUT",
        "/api/admin/server-live-hls",
        { serverId: enabledServerId, lowLatency: false },
      );
      expect(flip.status).toBe(200);
      expect(flip.body).toMatchObject({
        liveHlsOverride: null,
        liveHlsEffective: true,
        liveHlsLlOverride: false,
        // FALSE beats the variable that names this server.
        liveHlsLlEffective: false,
      });
      expect((await liveHlsConfigForServer(enabledServerId)).lowLatency.available).toBe(false);

      // Back to NULL: the environment decides again, exactly as before.
      await call("machine", "PUT", "/api/admin/server-live-hls", {
        serverId: enabledServerId,
        lowLatency: null,
      });
      expect((await liveHlsConfigForServer(enabledServerId)).lowLatency.available).toBe(true);
      expect((await liveHlsConfigForServer(serverId)).lowLatency.available).toBe(false);

      expect(
        (await call("machine", "PUT", "/api/admin/server-live-hls", { serverId })).status,
      ).toBe(400);
    });

    it("Recusar declines the waiting rows and tells nobody", async () => {
      await join(owner, { serverId, audienceBucket: "under-20" });
      const response = await call<{ declined: number }>(
        "machine",
        "PUT",
        "/api/admin/watch-party-waitlist/decline",
        { serverId },
      );
      expect(response.body).toEqual({ declined: 1 });
      const state = await call<{ entry: Record<string, unknown> }>(
        owner,
        "GET",
        `/api/watch-party/waitlist?serverId=${serverId}`,
      );
      expect(state.body.entry).toMatchObject({ status: "declined" });
      // Asking again edits the row and does not reopen it.
      await join(owner, { serverId, audienceBucket: "20-50" });
      const again = await call<{ entry: Record<string, unknown> }>(
        owner,
        "GET",
        `/api/watch-party/waitlist?serverId=${serverId}`,
      );
      expect(again.body.entry).toMatchObject({ status: "declined", audienceBucket: "20-50" });
      expect(
        (await call<{ approvals: unknown[] }>(owner, "GET", "/api/watch-party/waitlist/approvals"))
          .body.approvals,
      ).toEqual([]);
    });

    it("counts joins on the metrics payload", async () => {
      await join(owner, { serverId, audienceBucket: "under-20" });
      await join(member, { serverId });
      await join(stranger, { serverId: null });
      resetAdminMetricsCache();
      const metrics = await call<{ watchPartyWaitlist: Record<string, number> }>(
        "machine",
        "GET",
        "/api/admin/metrics",
      );
      expect(metrics.status).toBe(200);
      expect(metrics.body.watchPartyWaitlist).toEqual({
        joinsTotal: 3,
        joins7d: 3,
        requestsTotal: 1,
        interestTotal: 2,
        serversWaiting: 1,
        approvedTotal: 0,
      });
    });
  });
});

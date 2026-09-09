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
 * The operator dashboard's WRITE surface, over HTTP, against a real Postgres.
 *
 * Three things are being proved here and none of them can be proved by types:
 *
 *  1. **The allowlist is data now.** `servers.live_hls_enabled` decides, and a
 *     flip is answered by the very next `GET /api/live-hls/config?serverId=`
 *     in the same process, with no restart. That is the whole point of the
 *     change and it is asserted end to end rather than inferred.
 *  2. **The environment still works underneath it.** Every case in here runs
 *     with `LIVE_HLS_SERVER_ALLOWLIST` SET, which is how production is
 *     configured; a NULL row falls back to it, exactly as before the column
 *     existed. Testing the fallback with the variable unset would have proved
 *     nothing about the machine this runs on (CLAUDE.md pitfall 12).
 *  3. **The machine token's blast radius is the list and only the list.** It
 *     reaches the four operator routes and cannot terminate an account.
 *
 * And every write leaves an `audit_log` row, with a NULL actor for the machine
 * token (which has no account) and the moderator's own id for a session.
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

const { handleApi, resetApiRateLimits, matchAdminMachineRoute } = await import(
  "./index.js"
);
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");

const TOKEN = "0123456789abcdef0123456789abcdef";
const WRONG_TOKEN = "ffffffffffffffffffffffffffffffff";

type Actor = { id: string; clerk_id: string };

let server: Server;
let baseUrl: string;

/**
 * A request as the machine caller: the Bearer token and no session at all.
 * `stubs.actor = null` is load-bearing: it is what makes a route that falls
 * through to Clerk resolution answer 401 instead of running as somebody.
 */
async function asMachine<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  token = TOKEN,
): Promise<{ status: number; body: T }> {
  stubs.actor = null;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function asUser<T = Record<string, unknown>>(
  as: Actor | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  stubs.actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: "Bearer session",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

describe("matchAdminMachineRoute", () => {
  it("is exactly the six routes, and account deletion is not one of them", () => {
    const reachable = [
      ["GET", "/api/admin/metrics"],
      ["GET", "/api/admin/voice-occupancy"],
      ["GET", "/api/admin/servers"],
      ["GET", "/api/admin/server-channels"],
      ["PUT", "/api/admin/server-live-hls"],
      ["PUT", "/api/admin/channel-voice-transport"],
    ] as const;
    for (const [method, path] of reachable) {
      expect(matchAdminMachineRoute(method, path)).not.toBeNull();
    }

    // The whole reason the allowlist is a table of exact pairs. If any of
    // these ever matches, the token in a Cloudflare Worker can do it.
    const refused = [
      ["DELETE", "/api/admin/users/00000000-0000-4000-8000-000000000001"],
      ["GET", "/api/admin/acquisition"],
      ["POST", "/api/admin/server-live-hls"],
      ["DELETE", "/api/admin/server-live-hls"],
      ["GET", "/api/admin/server-live-hls"],
      ["PUT", "/api/admin/metrics"],
      ["GET", "/api/admin/servers/"],
      ["GET", "/api/servers"],
    ] as const;
    for (const [method, path] of refused) {
      expect(matchAdminMachineRoute(method, path)).toBeNull();
    }
  });
});

describeDb("the operator's two levers", () => {
  let ana: Actor;
  let operator: Actor;
  let serverId: string;
  let otherServerId: string;
  let voiceChannelId: string;
  let partyChannelId: string;
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
    delete process.env.LIVE_HLS_SERVER_ALLOWLIST;
    for (const name of [
      "LIVE_HLS_ENABLED",
      "LIVEKIT_URL",
      "LIVEKIT_API_KEY",
      "LIVEKIT_API_SECRET",
      "LIVE_HLS_PUBLIC_BASE_URL",
      "LIVE_HLS_S3_BUCKET",
      "LIVE_HLS_S3_ACCESS_KEY_ID",
      "LIVE_HLS_S3_SECRET_ACCESS_KEY",
      "LIVE_HLS_S3_ENDPOINT",
    ]) {
      delete process.env[name];
    }
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    process.env.ADMIN_METRICS_TOKEN = TOKEN;

    // The deployment as production has it: live HLS configured, and the
    // environment allowlist SET. Every fallback assertion below is against
    // this shape, never against an unset variable.
    process.env.LIVE_HLS_ENABLED = "true";
    process.env.LIVEKIT_URL = "wss://sfu.example.test";
    process.env.LIVEKIT_API_KEY = "key";
    process.env.LIVEKIT_API_SECRET = "secret";
    process.env.LIVE_HLS_PUBLIC_BASE_URL = "https://live.example.test";
    process.env.LIVE_HLS_S3_BUCKET = "pqp-live-test";
    process.env.LIVE_HLS_S3_ACCESS_KEY_ID = "ak";
    process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY = "sk";
    process.env.LIVE_HLS_S3_ENDPOINT = "https://s3.example.test";

    const pool = getPool();
    await pool.query(`TRUNCATE users RESTART IDENTITY CASCADE`);
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

    const created = await pool.query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('Cinemoon', $1), ('Outro hall', $1)
       RETURNING id`,
      [ana.id],
    );
    serverId = created.rows[0]!.id;
    otherServerId = created.rows[1]!.id;
    await pool.query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [serverId, ana.id],
    );
    const channels = await pool.query<{ id: string; type: string }>(
      `INSERT INTO channels (server_id, name, type)
       VALUES ($1, 'voz', 'voice'), ($1, 'cinema', 'watch_party'), ($1, 'geral', 'text')
       RETURNING id, type`,
      [serverId],
    );
    voiceChannelId = channels.rows.find((c) => c.type === "voice")!.id;
    partyChannelId = channels.rows.find((c) => c.type === "watch_party")!.id;
    textChannelId = channels.rows.find((c) => c.type === "text")!.id;

    // The environment names the OTHER server. So `serverId` is off until a
    // row says otherwise, and `otherServerId` is on until a row says otherwise.
    process.env.LIVE_HLS_SERVER_ALLOWLIST = otherServerId;
  });

  async function overrideOf(id: string): Promise<boolean | null> {
    const row = await getPool().query<{ live_hls_enabled: boolean | null }>(
      `SELECT live_hls_enabled FROM servers WHERE id = $1`,
      [id],
    );
    return row.rows[0]?.live_hls_enabled ?? null;
  }

  async function auditRows(id: string) {
    const rows = await getPool().query<{
      action: string;
      actor_id: string | null;
      target_id: string | null;
      changes: unknown;
    }>(
      `SELECT action, actor_id, target_id, changes FROM audit_log
        WHERE server_id = $1 ORDER BY id ASC`,
      [id],
    );
    return rows.rows;
  }

  describe("finding a server", () => {
    it("lists servers with the effective answer and where it came from", async () => {
      const { status, body } = await asMachine<{
        servers: {
          id: string;
          name: string;
          liveHlsOverride: boolean | null;
          liveHlsEffective: boolean;
          liveHlsSource: string;
          watchPartyChannels: number;
        }[];
        matched: number;
        liveHls: { configured: boolean; envAllowlist: boolean };
        overrides: { on: number; off: number };
      }>("GET", "/api/admin/servers");

      expect(status).toBe(200);
      expect(body.matched).toBe(2);
      expect(body.liveHls).toMatchObject({ configured: true, envAllowlist: true });
      expect(body.overrides).toEqual({ on: 0, off: 0 });

      const cinemoon = body.servers.find((s) => s.id === serverId)!;
      const outro = body.servers.find((s) => s.id === otherServerId)!;
      expect(cinemoon.watchPartyChannels).toBe(1);
      // Nobody has decided about either, so the environment does, and it
      // names only the other one.
      expect(cinemoon).toMatchObject({
        liveHlsOverride: null,
        liveHlsEffective: false,
        liveHlsSource: "allowlist",
      });
      expect(outro).toMatchObject({
        liveHlsOverride: null,
        liveHlsEffective: true,
        liveHlsSource: "allowlist",
      });
    });

    it("searches by name, because there are 908 of them", async () => {
      const { body } = await asMachine<{
        servers: { name: string }[];
        matched: number;
      }>("GET", "/api/admin/servers?q=cine");
      expect(body.matched).toBe(1);
      expect(body.servers.map((s) => s.name)).toEqual(["Cinemoon"]);
    });
  });

  describe("watch party availability, per server", () => {
    it("a flip is answered by the very next config read, with no restart", async () => {
      // Before: the environment says no for this server.
      const before = await asUser<{ enabled: boolean; allowlisted: boolean }>(
        ana,
        "GET",
        `/api/live-hls/config?serverId=${serverId}`,
      );
      expect(before.body.enabled).toBe(false);

      const put = await asMachine<{
        liveHlsOverride: boolean | null;
        liveHlsEffective: boolean;
        liveHlsSource: string;
      }>("PUT", "/api/admin/server-live-hls", { serverId, enabled: true });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({
        liveHlsOverride: true,
        liveHlsEffective: true,
        liveHlsSource: "server",
      });

      // Same process, no restart, no deploy, and the environment variable is
      // untouched and still names the other server.
      expect(process.env.LIVE_HLS_SERVER_ALLOWLIST).toBe(otherServerId);
      const after = await asUser<{ enabled: boolean; allowlisted: boolean }>(
        ana,
        "GET",
        `/api/live-hls/config?serverId=${serverId}`,
      );
      expect(after.body.enabled).toBe(true);
    });

    it("FALSE is the kill switch: it beats an environment that says yes", async () => {
      const before = await asUser<{ enabled: boolean }>(
        ana,
        "GET",
        `/api/live-hls/config?serverId=${otherServerId}`,
      );
      expect(before.body.enabled).toBe(true);

      await asMachine("PUT", "/api/admin/server-live-hls", {
        serverId: otherServerId,
        enabled: false,
      });

      const after = await asUser<{ enabled: boolean; allowlisted: boolean }>(
        ana,
        "GET",
        `/api/live-hls/config?serverId=${otherServerId}`,
      );
      expect(after.body.enabled).toBe(false);
      expect(after.body.allowlisted).toBe(true);
    });

    it("null hands the decision back to the environment", async () => {
      await asMachine("PUT", "/api/admin/server-live-hls", {
        serverId,
        enabled: true,
      });
      expect(await overrideOf(serverId)).toBe(true);

      const cleared = await asMachine<{
        liveHlsOverride: boolean | null;
        liveHlsEffective: boolean;
        liveHlsSource: string;
      }>("PUT", "/api/admin/server-live-hls", { serverId, enabled: null });
      expect(cleared.body).toMatchObject({
        liveHlsOverride: null,
        liveHlsEffective: false,
        liveHlsSource: "allowlist",
      });
      expect(await overrideOf(serverId)).toBeNull();
    });

    it("counts the rows that were decided, either way", async () => {
      await asMachine("PUT", "/api/admin/server-live-hls", {
        serverId,
        enabled: true,
      });
      await asMachine("PUT", "/api/admin/server-live-hls", {
        serverId: otherServerId,
        enabled: false,
      });
      const { body } = await asMachine<{ overrides: { on: number; off: number } }>(
        "GET",
        "/api/admin/servers",
      );
      expect(body.overrides).toEqual({ on: 1, off: 1 });
    });

    it("404s a server that does not exist, and writes nothing", async () => {
      const missing = "00000000-0000-4000-8000-0000000000ff";
      const { status } = await asMachine("PUT", "/api/admin/server-live-hls", {
        serverId: missing,
        enabled: true,
      });
      expect(status).toBe(404);
    });

    it("400s a body that is not the schema", async () => {
      const { status } = await asMachine("PUT", "/api/admin/server-live-hls", {
        serverId,
        enabled: "sim",
      });
      expect(status).toBe(400);
    });
  });

  describe("a channel's media path", () => {
    it("lists the voice channels with the pin a room would open on", async () => {
      const { status, body } = await asMachine<{
        serverName: string;
        liveKitConfigured: boolean;
        channels: {
          id: string;
          name: string;
          type: string;
          voiceTransport: string | null;
          pinnedTransport: string | null;
          wouldOpenOn: { transport: string; reason: string };
        }[];
      }>("GET", `/api/admin/server-channels?serverId=${serverId}`);

      expect(status).toBe(200);
      expect(body.serverName).toBe("Cinemoon");
      // The text channel has no media path and is not listed.
      expect(body.channels.map((c) => c.type).sort()).toEqual([
        "voice",
        "watch_party",
      ]);
      const voice = body.channels.find((c) => c.type === "voice")!;
      expect(voice).toMatchObject({
        voiceTransport: null,
        pinnedTransport: null,
      });
      expect(voice.wouldOpenOn.transport).toBe("mesh");
    });

    it("sets and clears the override, and shows it in the next read", async () => {
      const put = await asMachine<{
        voiceTransport: string | null;
        wouldOpenOn: { transport: string; reason: string };
      }>("PUT", "/api/admin/channel-voice-transport", {
        channelId: voiceChannelId,
        transport: "livekit",
      });
      expect(put.status).toBe(200);
      expect(put.body.voiceTransport).toBe("livekit");
      expect(put.body.wouldOpenOn).toEqual({
        transport: "livekit",
        reason: "override",
      });

      const list = await asMachine<{
        channels: { id: string; voiceTransport: string | null }[];
      }>("GET", `/api/admin/server-channels?serverId=${serverId}`);
      expect(
        list.body.channels.find((c) => c.id === voiceChannelId)!.voiceTransport,
      ).toBe("livekit");

      const cleared = await asMachine<{ voiceTransport: string | null }>(
        "PUT",
        "/api/admin/channel-voice-transport",
        { channelId: voiceChannelId, transport: null },
      );
      expect(cleared.body.voiceTransport).toBeNull();
    });

    it("the watch party channel's answer follows the server's own switch", async () => {
      const off = await asMachine<{
        channels: { id: string; wouldOpenOn: { reason: string; transport: string } }[];
        liveHlsEffective: boolean;
      }>("GET", `/api/admin/server-channels?serverId=${serverId}`);
      expect(off.body.liveHlsEffective).toBe(false);
      expect(
        off.body.channels.find((c) => c.id === partyChannelId)!.wouldOpenOn,
      ).toEqual({ transport: "mesh", reason: "small" });

      await asMachine("PUT", "/api/admin/server-live-hls", {
        serverId,
        enabled: true,
      });

      const on = await asMachine<{
        channels: { id: string; wouldOpenOn: { reason: string; transport: string } }[];
        liveHlsEffective: boolean;
      }>("GET", `/api/admin/server-channels?serverId=${serverId}`);
      expect(on.body.liveHlsEffective).toBe(true);
      // A watch party in a two-member hall still needs the SFU, because the
      // transcode only exists there. Same rule the join path applies.
      expect(
        on.body.channels.find((c) => c.id === partyChannelId)!.wouldOpenOn,
      ).toEqual({ transport: "livekit", reason: "hls" });
    });

    it("refuses a text channel: it has no media path to pin", async () => {
      const { status } = await asMachine("PUT", "/api/admin/channel-voice-transport", {
        channelId: textChannelId,
        transport: "livekit",
      });
      expect(status).toBe(404);
      const row = await getPool().query<{ voice_transport: string | null }>(
        `SELECT voice_transport FROM channels WHERE id = $1`,
        [textChannelId],
      );
      expect(row.rows[0]!.voice_transport).toBeNull();
    });
  });

  describe("the audit trail", () => {
    it("records a machine write with a NULL actor, old value and new", async () => {
      await asMachine("PUT", "/api/admin/server-live-hls", {
        serverId,
        enabled: true,
      });
      await asMachine("PUT", "/api/admin/channel-voice-transport", {
        channelId: voiceChannelId,
        transport: "mesh",
      });

      const rows = await auditRows(serverId);
      expect(rows.map((r) => r.action)).toEqual([
        "server.live_hls_update",
        "channel.voice_transport_update",
      ]);
      expect(rows[0]!.actor_id).toBeNull();
      expect(rows[0]!.target_id).toBe(serverId);
      expect(rows[0]!.changes).toEqual([
        { key: "liveHlsEnabled", old: null, new: true },
      ]);
      expect(rows[1]!.target_id).toBe(voiceChannelId);
      expect(rows[1]!.changes).toEqual([
        { key: "voiceTransport", old: null, new: "mesh" },
      ]);
    });

    it("records the moderator's own id when they used a session", async () => {
      const { status } = await asUser(operator, "PUT", "/api/admin/server-live-hls", {
        serverId,
        enabled: true,
      });
      expect(status).toBe(200);
      const rows = await auditRows(serverId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_id).toBe(operator.id);
    });

    it("writes nothing when the value did not change", async () => {
      await asMachine("PUT", "/api/admin/server-live-hls", {
        serverId,
        enabled: true,
      });
      await asMachine("PUT", "/api/admin/server-live-hls", {
        serverId,
        enabled: true,
      });
      expect(await auditRows(serverId)).toHaveLength(1);
    });
  });

  describe("who may do this", () => {
    it("a wrong token is a 404, the same answer as a route that is not there", async () => {
      const { status } = await asMachine(
        "PUT",
        "/api/admin/server-live-hls",
        { serverId, enabled: true },
        WRONG_TOKEN,
      );
      expect(status).toBe(404);
      expect(await overrideOf(serverId)).toBeNull();
    });

    it("a signed-in non-moderator is a 404 too", async () => {
      const { status } = await asUser(ana, "PUT", "/api/admin/server-live-hls", {
        serverId,
        enabled: true,
      });
      expect(status).toBe(404);
      expect(await overrideOf(serverId)).toBeNull();
    });

    it("the machine token cannot terminate an account", async () => {
      // Not on `ADMIN_MACHINE_ROUTES`, so it falls through to the ordinary
      // Clerk resolution, which has no session to resolve.
      const { status } = await asMachine("DELETE", `/api/admin/users/${ana.id}`);
      expect(status).toBe(401);
      const still = await getPool().query(`SELECT 1 FROM users WHERE id = $1`, [
        ana.id,
      ]);
      expect(still.rowCount).toBe(1);
    });

    it("with the token unset the operator routes do not exist at all", async () => {
      delete process.env.ADMIN_METRICS_TOKEN;
      // 404 and not 401, the same rule `/api/admin/metrics` already follows:
      // an unauthenticated probe of one of these paths must not learn that
      // the path is there and only the credential was wrong. The 401 in the
      // test above is what a path OUTSIDE the machine allowlist answers,
      // which is how the two are told apart from the outside.
      const { status } = await asMachine("GET", "/api/admin/servers");
      expect(status).toBe(404);
    });
  });
});

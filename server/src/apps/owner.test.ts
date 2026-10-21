import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { appEndedSchema } from "@pqp/shared";

/**
 * The owner's switches (`apps/owner.ts`, `api/app-owner-routes.ts`), against a
 * real Postgres with the real flag snapshot and the Postgres bus installed, the
 * routes reached through the real router. What is pinned here:
 *
 *  1. WHO. MANAGE_SERVER (the owner, a manager), a 403 for a member without it,
 *     the 404 of any server route for a stranger and while the `apps` flag is
 *     off for the server.
 *  2. WHAT. The list is the apps the operator released here and that are live;
 *     a public community's release counts only for an unlocked app. The write
 *     takes `false` or `null` and nothing else: the owner never switches ON.
 *  3. THE EFFECT. Off refuses a new start (`owner-off`), ends the sessions
 *     running there with `app-disabled` (the people inside are told), and is
 *     audited with the count.
 */

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  (process.env.CI === "true" ? process.env.DATABASE_URL : undefined);
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
process.env.CLUSTER_BUS = "postgres";
process.env.VOICE_REGISTRY = "postgres";
process.env.APPS_ORIGIN = "https://apps.example.test";
delete process.env.APPS;

const db = await import("../db.js");
const bus = await import("../lib/bus.js");
const { createPostgresBusTransport } = await import("../lib/bus-postgres.js");
const flags = await import("../lib/flags.js");
const users = await import("../services/users.js");
const servers = await import("../services/servers.js");
const roles = await import("../services/roles.js");
const catalog = await import("./catalog.js");
const sockets = await import("../ws/sockets.js");
const wsApps = await import("../ws/apps.js");
const sessions = await import("./sessions.js");
const { createRouter } = await import("../lib/router.js");
const { registerAppOwnerRoutes } = await import("../api/app-owner-routes.js");
const { buildWorld, publishTestApp, recordingSocket } = await import("./testing-world.js");
import type { World } from "./testing-world.js";

const modules = { db, users, servers, roles, flags, catalog, sockets };
const q = <T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
) => db.getPool().query<T>(text, values);

describeDb("the owner's apps switches", () => {
  const router = createRouter();
  registerAppOwnerRoutes(router);
  let transport: ReturnType<typeof createPostgresBusTransport>;
  let world: World;
  let appId: string;

  async function call(
    user: World["owner"],
    method: "GET" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const url = new URL(`http://localhost${path}`);
    const route = router.match(method, url.pathname);
    if (!route) {
      return { status: 404, body: { error: "Not found" } };
    }
    const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
      headers: {},
    }) as unknown as IncomingMessage;
    try {
      const result = await route.handler({ req, url, user } as never, route.params);
      return { status: 200, body: JSON.parse(JSON.stringify(result)) };
    } catch (error) {
      if (error && typeof error === "object" && (error as Error).name === "ZodError") {
        return { status: 400, body: { error: "Invalid request" } };
      }
      if (error && typeof error === "object" && "status" in error) {
        return {
          status: (error as { status: number }).status,
          body: { error: (error as unknown as Error).message },
        };
      }
      throw error;
    }
  }

  const list = (user: World["owner"], serverId = world.serverId) =>
    call(user, "GET", `/api/servers/${serverId}/apps`);
  const put = (user: World["owner"], ownerEnabled: unknown, id = appId, serverId = world.serverId) =>
    call(user, "PUT", `/api/servers/${serverId}/apps`, { appId: id, ownerEnabled });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  beforeAll(async () => {
    await db.initDb();
    transport = createPostgresBusTransport(DATABASE_URL!);
    bus.setBusTransport(transport);
    await transport.whenConnected();
  }, 30_000);

  beforeEach(async () => {
    await q(`TRUNCATE app_admin_audit, app_sessions, app_session_participants, server_apps,
                      app_versions, apps, feature_flags, feature_flag_overrides, messages
                      RESTART IDENTITY CASCADE`);
    await q(
      `INSERT INTO app_publishers (id, display_name, kind)
       VALUES ('pqp', 'pqp', 'first_party') ON CONFLICT (id) DO NOTHING`,
    );
    flags.resetFeatureFlagsForTests();
    await flags.startFeatureFlags();
    sessions.resetAppSessionLimitsForTests();
    wsApps.resetAppsWsForTests();
    process.env.INSTANCE_MODERATOR_CLERK_IDS = "";
    world = await buildWorld(modules);
    appId = await publishTestApp(modules, world.serverId);
    await flags.setServerFlagOverride("apps", world.serverId, true, { kind: "dashboard" });
  });

  afterAll(async () => {
    flags.resetFeatureFlagsForTests();
    await transport.close().catch(() => {});
    await db.closePool();
  });

  describe("who may", () => {
    it("the owner and a manager (MANAGE_SERVER) read and write; a member is refused, a stranger is a 404", async () => {
      expect((await list(world.owner)).status).toBe(200);
      expect((await list(world.manager)).status).toBe(200);
      expect((await put(world.manager, false)).status).toBe(200);
      expect((await list(world.member)).status).toBe(403);
      expect((await put(world.member, null)).status).toBe(403);
      expect((await list(world.stranger)).status).toBe(404);
      expect((await put(world.stranger, false)).status).toBe(404);
      expect((await list(world.owner, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    });

    it("with the apps flag off for the server both routes are the 404 of a route that is not there", async () => {
      await flags.setServerFlagOverride("apps", world.serverId, false, { kind: "dashboard" });
      expect((await list(world.owner)).status).toBe(404);
      expect((await put(world.owner, false)).status).toBe(404);
      const row = await q(`SELECT owner_enabled FROM server_apps WHERE server_id = $1`, [world.serverId]);
      expect(row.rows[0]!.owner_enabled).toBeNull();
    });
  });

  describe("the list", () => {
    it("is the live apps the operator released here, with the owner's switch, in the manifest's languages", async () => {
      const { status, body } = await list(world.owner);
      expect(status).toBe(200);
      expect(body.apps).toEqual([
        {
          id: appId,
          icon: "sparkles",
          category: "tool",
          names: { "pt-BR": "Eco", en: "Eco", es: "Eco" },
          descriptions: {
            "pt-BR": "Um app de teste que repete o que tu manda.",
            en: "A test app that echoes what you send.",
            es: "Una app de prueba que repite lo que mandas.",
          },
          enabled: true,
          paused: false,
          liveSessions: 0,
        },
      ]);
    });

    it("leaves out what the operator did not release, apps that are not live, and a locked community's", async () => {
      await q(`UPDATE server_apps SET operator_enabled = NULL WHERE app_id = $1`, [appId]);
      expect((await list(world.owner)).body.apps).toEqual([]);
      await q(`UPDATE server_apps SET operator_enabled = TRUE WHERE app_id = $1`, [appId]);
      await q(`UPDATE apps SET status = 'review' WHERE id = $1`, [appId]);
      expect((await list(world.owner)).body.apps).toEqual([]);
      await q(`UPDATE apps SET status = 'live' WHERE id = $1`, [appId]);
      expect((await list(world.owner)).body.apps).toHaveLength(1);

      await q(`UPDATE servers SET is_community = TRUE WHERE id = $1`, [world.serverId]);
      expect((await list(world.owner)).body.apps).toEqual([]);
      await q(`UPDATE apps SET community_unlocked = TRUE WHERE id = $1`, [appId]);
      expect((await list(world.owner)).body.apps).toHaveLength(1);
    });

    it("says when the operator's master switch is off, and what is running", async () => {
      await q(`UPDATE apps SET global_enabled = FALSE WHERE id = $1`, [appId]);
      expect((await list(world.owner)).body.apps[0]).toMatchObject({ paused: true });
      await q(`UPDATE apps SET global_enabled = TRUE WHERE id = $1`, [appId]);
      await sessions.startAppSession(world.member, world.channels.general, appId);
      expect((await list(world.owner)).body.apps[0]).toMatchObject({ liveSessions: 1 });
    });
  });

  describe("the write", () => {
    it("takes false and null, never true, and a bad body is a 400", async () => {
      for (const bad of [true, "false", 0, undefined]) {
        expect((await put(world.owner, bad)).status).toBe(400);
      }
      expect((await call(world.owner, "PUT", `/api/servers/${world.serverId}/apps`, { ownerEnabled: false })).status).toBe(400);
      const row = await q(`SELECT owner_enabled FROM server_apps WHERE server_id = $1`, [world.serverId]);
      expect(row.rows[0]!.owner_enabled).toBeNull();
    });

    it("off, then back, is audited as the owner with before and after; a repeat writes nothing", async () => {
      const off = await put(world.owner, false);
      expect(off.body).toEqual({ appId, enabled: false, changed: true, sessionsEnded: 0 });
      expect((await list(world.owner)).body.apps[0].enabled).toBe(false);
      expect((await put(world.owner, false)).body.changed).toBe(false);
      const back = await put(world.owner, null);
      expect(back.body).toMatchObject({ enabled: true, changed: true });
      expect((await put(world.owner, null)).body.changed).toBe(false);

      const audit = await q<{ actor_kind: string; actor_user_id: string; server_id: string; before: unknown; after: unknown }>(
        `SELECT actor_kind, actor_user_id, server_id, before, after FROM app_admin_audit
          WHERE action = 'owner-server' ORDER BY id`,
      );
      expect(audit.rows).toEqual([
        { actor_kind: "owner", actor_user_id: world.owner.id, server_id: world.serverId, before: { ownerEnabled: null }, after: { ownerEnabled: false } },
        { actor_kind: "owner", actor_user_id: world.owner.id, server_id: world.serverId, before: { ownerEnabled: false }, after: { ownerEnabled: null } },
      ]);
    });

    it("an app the operator never released here is not there to switch, and nothing is created", async () => {
      await q(`UPDATE server_apps SET operator_enabled = NULL WHERE app_id = $1`, [appId]);
      expect((await put(world.owner, false)).status).toBe(404);
      expect((await put(world.owner, false, "no-such-app")).status).toBe(404);
      const row = await q(`SELECT owner_enabled FROM server_apps WHERE server_id = $1`, [world.serverId]);
      expect(row.rows[0]!.owner_enabled).toBeNull();
      expect((await q(`SELECT 1 FROM app_admin_audit WHERE action = 'owner-server'`)).rowCount).toBe(0);
    });

    it("the switch is per server: another server's release is untouched", async () => {
      const other = await servers.createServer("Other hall", world.owner.id);
      await q(`INSERT INTO server_apps (server_id, app_id, operator_enabled) VALUES ($1, $2, TRUE)`, [other.server.id, appId]);
      await put(world.owner, false);
      const rows = await q<{ server_id: string; owner_enabled: boolean | null }>(
        `SELECT server_id, owner_enabled FROM server_apps WHERE app_id = $1`,
        [appId],
      );
      const byServer = new Map(rows.rows.map((r) => [r.server_id, r.owner_enabled]));
      expect(byServer.get(world.serverId)).toBe(false);
      expect(byServer.get(other.server.id)).toBeNull();
    });
  });

  describe("what it does", () => {
    it("a new start is refused with owner-off, and allowed again when the switch goes back", async () => {
      await put(world.owner, false);
      await expect(sessions.startAppSession(world.member, world.channels.general, appId)).rejects.toMatchObject({
        status: 403,
        message: "app_unavailable",
        detail: { reason: "owner-off" },
      });
      await put(world.owner, null);
      const summary = await sessions.startAppSession(world.member, world.channels.general, appId);
      expect(summary.appId).toBe(appId);
    });

    it("off ends that server's live sessions with app-disabled, tells the people inside, and records the count", async () => {
      const first = await sessions.startAppSession(world.member, world.channels.general, appId);
      const second = await sessions.startAppSession(world.moderator, world.channels.lobby, appId);
      const seated = recordingSocket({ sockets }, world.member);
      wsApps.addSessionSocket(first.id, seated.socket);

      const off = await put(world.owner, false);
      expect(off.body).toMatchObject({ changed: true, sessionsEnded: 2 });
      await settle();

      const rows = await q<{ id: string; status: string; end_reason: string; ended_by: string; state: unknown }>(
        `SELECT id, status, end_reason, ended_by, state FROM app_sessions`,
      );
      expect(rows.rows.map((r) => [r.status, r.end_reason, r.ended_by]).sort()).toEqual([
        ["ended", "app-disabled", world.owner.id],
        ["ended", "app-disabled", world.owner.id],
      ]);
      expect(rows.rows.every((r) => JSON.stringify(r.state) === "{}")).toBe(true);
      expect(new Set(rows.rows.map((r) => r.id))).toEqual(new Set([first.id, second.id]));
      const ended = appEndedSchema.parse(seated.ofType("app-ended")[0]);
      expect(ended).toMatchObject({ sessionId: first.id, reason: "app-disabled" });

      const audit = await q<{ sessions_ended: number }>(
        `SELECT sessions_ended FROM app_admin_audit WHERE action = 'owner-server' AND after = '{"ownerEnabled": false}'::jsonb`,
      );
      expect(audit.rows.map((r) => r.sessions_ended)).toEqual([2]);
    });

    it("another server's session of the same app keeps running", async () => {
      const other = await servers.createServer("Other hall", world.owner.id);
      await q(`INSERT INTO server_apps (server_id, app_id, operator_enabled) VALUES ($1, $2, TRUE)`, [other.server.id, appId]);
      await flags.setServerFlagOverride("apps", other.server.id, true, { kind: "dashboard" });
      const channel = other.channels.find((c) => c.type === "text")!;
      const there = await sessions.startAppSession(world.owner, channel.id, appId);
      await sessions.startAppSession(world.member, world.channels.general, appId);

      await put(world.owner, false);
      const live = await q<{ id: string }>(`SELECT id FROM app_sessions WHERE status = 'live'`);
      expect(live.rows.map((r) => r.id)).toEqual([there.id]);
    });

    it("a repeat of off, and null, end nothing", async () => {
      await put(world.owner, false);
      const summary = await (async () => {
        await q(`UPDATE server_apps SET owner_enabled = NULL WHERE server_id = $1`, [world.serverId]);
        return sessions.startAppSession(world.member, world.channels.general, appId);
      })();
      await q(`UPDATE server_apps SET owner_enabled = FALSE WHERE server_id = $1`, [world.serverId]);
      // Already off in the row: nothing changed, so nothing ends.
      expect((await put(world.owner, false)).body).toMatchObject({ changed: false, sessionsEnded: 0 });
      expect((await q(`SELECT status FROM app_sessions WHERE id = $1`, [summary.id])).rows[0]!.status).toBe("live");
    });
  });
});

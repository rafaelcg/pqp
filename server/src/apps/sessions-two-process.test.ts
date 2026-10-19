import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appEndedSchema, channelAppSchema } from "@pqp/shared";
import type { World } from "./testing-world.js";

/**
 * APP SESSIONS ON TWO MACHINES.
 *
 * Production runs two API machines with `CLUSTER_BUS=postgres` and
 * `VOICE_REGISTRY=postgres`, so the rules here are exercised the way it meets
 * them: two module graphs (two instances), one real Postgres, the real
 * LISTEN/NOTIFY bus between them, the runtime flag turned on by an override row
 * written on one instance and read on the other (never the environment:
 * pitfalls 9 and 12). Viewers sit on both machines; the session is started on
 * one and ended on the other.
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

interface Instance {
  bus: typeof import("../lib/bus.js");
  db: typeof import("../db.js");
  flags: typeof import("../lib/flags.js");
  users: typeof import("../services/users.js");
  servers: typeof import("../services/servers.js");
  roles: typeof import("../services/roles.js");
  catalog: typeof import("./catalog.js");
  sockets: typeof import("../ws/sockets.js");
  wsApps: typeof import("../ws/apps.js");
  sessions: typeof import("./sessions.js");
  transport: ReturnType<typeof import("../lib/bus-postgres.js").createPostgresBusTransport>;
}

const booted: Instance[] = [];

async function bootInstance(): Promise<Instance> {
  vi.resetModules();
  const bus = await import("../lib/bus.js");
  const db = await import("../db.js");
  const { createPostgresBusTransport } = await import("../lib/bus-postgres.js");
  const instance: Instance = {
    bus,
    db,
    flags: await import("../lib/flags.js"),
    users: await import("../services/users.js"),
    servers: await import("../services/servers.js"),
    roles: await import("../services/roles.js"),
    catalog: await import("./catalog.js"),
    sockets: await import("../ws/sockets.js"),
    wsApps: await import("../ws/apps.js"),
    sessions: await import("./sessions.js"),
    transport: createPostgresBusTransport(DATABASE_URL!),
  };
  await db.initDb();
  bus.setBusTransport(instance.transport);
  await instance.transport.whenConnected();
  await instance.flags.startFeatureFlags();
  booted.push(instance);
  return instance;
}

describeDb("app sessions across two instances on the Postgres bus", () => {
  let a: Instance;
  let b: Instance;
  let world: World;
  let appId: string;
  let testing: typeof import("./testing-world.js");

  const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

  beforeAll(async () => {
    a = await bootInstance();
    b = await bootInstance();
    testing = await import("./testing-world.js");
    expect(a.bus.isBusEnabled() && b.bus.isBusEnabled()).toBe(true);
    expect(a.bus.INSTANCE_ID).not.toBe(b.bus.INSTANCE_ID);
    await a.db.getPool().query(
      `TRUNCATE app_admin_audit, app_sessions, app_session_participants, server_apps,
                app_versions, apps, feature_flags, feature_flag_overrides, messages, users, servers
       RESTART IDENTITY CASCADE`,
    );
    await a.db.getPool().query(
      `INSERT INTO app_publishers (id, display_name, kind)
       VALUES ('pqp', 'pqp', 'first_party') ON CONFLICT (id) DO NOTHING`,
    );
    world = await testing.buildWorld(a);
    appId = await testing.publishTestApp(a, world.serverId);
    // Turned on by a row written on A; B has to learn it over the bus.
    await a.flags.setServerFlagOverride("apps", world.serverId, true, { kind: "dashboard" });
    await vi.waitFor(() => expect(b.flags.isEnabled("apps", { serverId: world.serverId })).toBe(true), {
      timeout: 5_000,
    });
  }, 40_000);

  afterAll(async () => {
    for (const instance of booted) {
      await instance.transport.close().catch(() => {});
      instance.flags.resetFeatureFlagsForTests();
      await instance.db.closePool().catch(() => {});
    }
  });

  it("a start on one machine reaches the viewers on both, and nobody who cannot view the channel", async () => {
    const onA = testing.recordingSocket(a, world.moderator);
    const onB = testing.recordingSocket(b, world.member);
    const strangerOnB = testing.recordingSocket(b, world.stranger);

    const summary = await a.sessions.startAppSession(world.owner, world.channels.general, appId);
    await settle();

    for (const rec of [onA, onB]) {
      const frames = rec.ofType("channel-app");
      expect(frames).toHaveLength(1);
      const parsed = channelAppSchema.parse(frames[0]);
      expect(parsed.channelId).toBe(world.channels.general);
      expect(parsed.session?.id).toBe(summary.id);
      expect(parsed.session?.hostUserId).toBe(world.owner.id);
    }
    expect(strangerOnB.ofType("channel-app")).toHaveLength(0);
  });

  it("an end on the other machine tells both audiences and reaches a participant socket on the first", async () => {
    const [{ id: sessionId }] = (
      await a.db
        .getPool()
        .query<{ id: string }>(`SELECT id FROM app_sessions WHERE status = 'live'`)
    ).rows as [{ id: string }];
    const viewerOnA = testing.recordingSocket(a, world.manager);
    const viewerOnB = testing.recordingSocket(b, world.member);
    const seatedOnA = testing.recordingSocket(a, world.owner);
    const seatedOnB = testing.recordingSocket(b, world.moderator);
    a.wsApps.addSessionSocket(sessionId, seatedOnA.socket);
    b.wsApps.addSessionSocket(sessionId, seatedOnB.socket);

    // The host's own end, taken on B though the session was started on A.
    const result = await b.sessions.endAppSessionAs(world.owner, sessionId);
    expect(result).toEqual({ ended: true, channelId: world.channels.general });
    await settle();

    for (const rec of [viewerOnA, viewerOnB]) {
      const last = channelAppSchema.parse(rec.ofType("channel-app").at(-1));
      expect(last.session).toBeNull();
    }
    for (const rec of [seatedOnA, seatedOnB]) {
      const ended = appEndedSchema.parse(rec.ofType("app-ended")[0]);
      expect(ended).toMatchObject({ sessionId, reason: "host" });
      expect(rec.ofType("app-ended")).toHaveLength(1);
    }
    // A second end on the first machine is the no-op, and silent.
    const before = viewerOnA.frames.length;
    expect(await a.sessions.endAppSessionAs(world.owner, sessionId)).toEqual({
      ended: false,
      channelId: null,
    });
    await settle();
    expect(viewerOnA.frames).toHaveLength(before);
  });

  it("two machines starting in the same channel at once make one session and one 409 with its summary", async () => {
    for (const instance of [a, b]) {
      instance.sessions.resetAppSessionLimitsForTests();
    }
    const outcomes = await Promise.all([
      a.sessions.startAppSession(world.member, world.channels.lobby, appId).then(
        (summary) => ({ ok: true as const, summary }),
        (error: { status?: number; message: string; detail?: { session?: { id: string } } }) => ({
          ok: false as const,
          error,
        }),
      ),
      b.sessions.startAppSession(world.moderator, world.channels.lobby, appId).then(
        (summary) => ({ ok: true as const, summary }),
        (error: { status?: number; message: string; detail?: { session?: { id: string } } }) => ({
          ok: false as const,
          error,
        }),
      ),
    ]);
    const winners = outcomes.filter((o) => o.ok);
    const losers = outcomes.filter((o) => !o.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = losers[0]!;
    if (!loser.ok) {
      expect(loser.error.status).toBe(409);
      expect(loser.error.message).toBe("session_live");
      expect(loser.error.detail?.session?.id).toBe(winners[0]!.ok ? winners[0]!.summary.id : "");
    }
    const live = await a.db
      .getPool()
      .query(`SELECT 1 FROM app_sessions WHERE channel_id = $1 AND status = 'live'`, [
        world.channels.lobby,
      ]);
    expect(live.rowCount).toBe(1);
    expect(
      (
        await a.db
          .getPool()
          .query(`SELECT 1 FROM messages WHERE channel_id = $1 AND system_kind = 'app_session'`, [
            world.channels.lobby,
          ])
      ).rowCount,
    ).toBe(1);
  });

  it("the flag turned off on one machine is a 404 start on the other within a moment", async () => {
    await a.flags.setServerFlagOverride("apps", world.serverId, false, { kind: "dashboard" });
    await vi.waitFor(() => expect(b.flags.isEnabled("apps", { serverId: world.serverId })).toBe(false), {
      timeout: 5_000,
    });
    b.sessions.resetAppSessionLimitsForTests();
    await expect(
      b.sessions.startAppSession(world.owner, world.channels.restricted, appId),
    ).rejects.toMatchObject({ status: 404 });
    const sessionsOnRestricted = await b.db
      .getPool()
      .query(`SELECT 1 FROM app_sessions WHERE channel_id = $1`, [world.channels.restricted]);
    expect(sessionsOnRestricted.rowCount).toBe(0);
  });
});

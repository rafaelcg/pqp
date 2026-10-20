import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appEndedSchema, channelAppSchema } from "@pqp/shared";
import type { World } from "./testing-world.js";

/**
 * THE OWNER'S SWITCH ON TWO MACHINES. Production runs two API machines with
 * `CLUSTER_BUS=postgres` and `VOICE_REGISTRY=postgres`: two module graphs, one
 * real Postgres, the real LISTEN/NOTIFY bus between them. The owner's switch is
 * taken on B; the session it ends was started on A and has a person seated on
 * each machine, so what is proved is that the end reaches both, that the card
 * leaves both channels' viewers, and that A refuses the next start with the
 * reason, from the rows, with nothing cached in between.
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
  owner: typeof import("./owner.js");
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
    owner: await import("./owner.js"),
    transport: createPostgresBusTransport(DATABASE_URL!),
  };
  await db.initDb();
  bus.setBusTransport(instance.transport);
  await instance.transport.whenConnected();
  await instance.flags.startFeatureFlags();
  booted.push(instance);
  return instance;
}

describeDb("the owner's apps switch across two instances on the Postgres bus", () => {
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

  it("off on B ends the session started on A for both machines' people, and A refuses the next start with owner-off", async () => {
    const summary = await a.sessions.startAppSession(world.member, world.channels.general, appId);
    const viewerOnA = testing.recordingSocket(a, world.manager);
    const viewerOnB = testing.recordingSocket(b, world.moderator);
    const seatedOnA = testing.recordingSocket(a, world.member);
    const seatedOnB = testing.recordingSocket(b, world.moderator);
    a.wsApps.addSessionSocket(summary.id, seatedOnA.socket);
    b.wsApps.addSessionSocket(summary.id, seatedOnB.socket);

    const result = await b.owner.setOwnerApp(world.serverId, world.owner.id, {
      appId,
      ownerEnabled: false,
    });
    expect(result).toMatchObject({ changed: true, enabled: false, sessionsEnded: 1 });
    await settle();

    for (const rec of [seatedOnA, seatedOnB]) {
      const ended = appEndedSchema.parse(rec.ofType("app-ended")[0]);
      expect(ended).toMatchObject({ sessionId: summary.id, reason: "app-disabled" });
    }
    for (const rec of [viewerOnA, viewerOnB]) {
      const last = channelAppSchema.parse(rec.ofType("channel-app").at(-1));
      expect(last.session).toBeNull();
    }

    a.sessions.resetAppSessionLimitsForTests();
    await expect(
      a.sessions.startAppSession(world.member, world.channels.lobby, appId),
    ).rejects.toMatchObject({ status: 403, detail: { reason: "owner-off" } });

    // And back: the switch removed on A is seen by B at once.
    await a.owner.setOwnerApp(world.serverId, world.owner.id, { appId, ownerEnabled: null });
    b.sessions.resetAppSessionLimitsForTests();
    const again = await b.sessions.startAppSession(world.member, world.channels.lobby, appId);
    expect(again.appId).toBe(appId);
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbUser } from "../db.js";
import type { World } from "./testing-world.js";

/**
 * THE SWEEPS ON TWO MACHINES, including the one that matters most: the host's
 * machine dies and the other one hands the host role over.
 *
 * Two module graphs (two instances), one real Postgres, the real LISTEN/NOTIFY
 * bus, the runtime flag turned on by a row written on one instance and read on
 * the other (never the environment: pitfalls 9 and 12). Time is a fake clock
 * handed to every sweep. Heartbeats are written by hand into
 * `voice_instances`, the table a sibling's liveness is read from.
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
  sweeps: typeof import("./sweeps.js");
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
    sweeps: await import("./sweeps.js"),
    transport: createPostgresBusTransport(DATABASE_URL!),
  };
  await db.initDb();
  bus.setBusTransport(instance.transport);
  await instance.transport.whenConnected();
  await instance.flags.startFeatureFlags();
  booted.push(instance);
  return instance;
}

const settle = (ms = 500) => new Promise((resolve) => setTimeout(resolve, ms));
const SECOND = 1000;
const MINUTE = 60 * SECOND;

describeDb("the sweeps across two instances on the Postgres bus", () => {
  let a: Instance;
  let b: Instance;
  let world: World;
  let appId: string;
  let testing: typeof import("./testing-world.js");
  let t0: number;

  const at = (ms: number) => new Date(t0 + ms);

  async function join(on: Instance, sessionId: string, user: DbUser) {
    const rec = testing.recordingSocket(on, user);
    await on.wsApps.handleAppFrame(rec.socket, user, { type: "app-join", sessionId });
    return rec;
  }

  async function heartbeat(instanceId: string, offsetMs: number) {
    await a.db.getPool().query(
      `INSERT INTO voice_instances (instance_id, config_hash, heartbeat_at, snapshot)
       VALUES ($1, 'h', $2, '{}'::jsonb)
       ON CONFLICT (instance_id) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`,
      [instanceId, new Date(t0 + offsetMs)],
    );
  }

  const row = async (id: string) =>
    (await a.db.getPool().query(`SELECT * FROM app_sessions WHERE id = $1`, [id])).rows[0]!;

  beforeAll(async () => {
    a = await bootInstance();
    b = await bootInstance();
    testing = await import("./testing-world.js");
    expect(a.bus.INSTANCE_ID).not.toBe(b.bus.INSTANCE_ID);
    await a.db.getPool().query(
      `TRUNCATE app_admin_audit, app_sessions, app_session_participants, server_apps,
                app_versions, apps, feature_flags, feature_flag_overrides, messages,
                member_timeouts, voice_instances, users, servers RESTART IDENTITY CASCADE`,
    );
    await a.db.getPool().query(
      `INSERT INTO app_publishers (id, display_name, kind)
       VALUES ('pqp', 'pqp', 'first_party') ON CONFLICT (id) DO NOTHING`,
    );
    world = await testing.buildWorld(a);
    appId = await testing.publishTestApp(a, world.serverId, { players: { max: 4, spectators: true } });
    await a.flags.setServerFlagOverride("apps", world.serverId, true, { kind: "dashboard" });
    await vi.waitFor(
      () => expect(b.flags.isEnabled("apps", { serverId: world.serverId })).toBe(true),
      { timeout: 5_000 },
    );
  }, 40_000);

  afterEach(async () => {
    await a.db.getPool().query(
      `UPDATE app_sessions SET status = 'ended', ended_at = NOW(), end_reason = 'host'
        WHERE status = 'live'`,
    );
    await a.db.getPool().query(`DELETE FROM voice_instances`);
    await a.db.getPool().query(`DELETE FROM singleton_leases WHERE key = 'apps.sweep'`);
    a.wsApps.resetAppsWsForTests();
    b.wsApps.resetAppsWsForTests();
    a.sweeps.resetAppSweepStateForTests();
    b.sweeps.resetAppSweepStateForTests();
  });

  afterAll(async () => {
    for (const instance of booted) {
      await instance.transport.close().catch(() => {});
      instance.flags.resetFeatureFlagsForTests();
      await instance.db.closePool().catch(() => {});
    }
  });

  async function startOnA(channelId = world.channels.general): Promise<string> {
    a.sessions.resetAppSessionLimitsForTests();
    t0 = Date.now();
    return (await a.sessions.startAppSession(world.owner, channelId, appId)).id;
  }

  it("the host's machine dies: the other one holds the seat, releases it and hands the role to the longest seated person there", async () => {
    const id = await startOnA();
    await join(a, id, world.owner); // the host, on the machine that is about to die
    const first = await join(b, id, world.member); // longest seated on the survivor
    await settle(30);
    const second = await join(b, id, world.moderator);
    await settle(300);

    // A stops beating and stops existing; B keeps beating.
    await heartbeat(a.bus.INSTANCE_ID, -10 * MINUTE);
    await heartbeat(b.bus.INSTANCE_ID, 30 * MINUTE);
    await a.transport.close().catch(() => {});
    a.wsApps.resetAppsWsForTests();
    first.frames.length = 0;
    second.frames.length = 0;

    // First tick: the dead machine's seat is held (90 s), the host is not present, the countdown starts.
    const one = await b.sweeps.runAppSweep({ now: at(0) });
    expect(one).toMatchObject({ deadSeatsHeld: 1, hostGoneStamped: 1, handoffs: 0 });
    expect((await row(id)).host_gone_at).toEqual(at(0));
    const held = await a.db
      .getPool()
      .query(`SELECT orphaned_at FROM app_session_participants WHERE session_id = $1 AND user_id = $2`, [
        id,
        world.owner.id,
      ]);
    expect(held.rows[0]!.orphaned_at).toEqual(at(0));
    // The survivors' own seats are untouched.
    const theirs = await a.db
      .getPool()
      .query(`SELECT orphaned_at, instance_id FROM app_session_participants WHERE user_id = ANY($1::uuid[])`, [
        [world.member.id, world.moderator.id],
      ]);
    expect(theirs.rows.every((r) => r.orphaned_at === null && r.instance_id === b.bus.INSTANCE_ID)).toBe(true);

    // Inside the hold and inside the grace: nothing moves.
    expect((await b.sweeps.runAppSweep({ now: at(89 * SECOND) })).handoffs).toBe(0);
    // The hold ends: the seat is released.
    expect((await b.sweeps.runAppSweep({ now: at(91 * SECOND) })).deadSeatsReleased).toBe(1);
    expect((await row(id)).host_user_id).toBe(world.owner.id);
    expect((await b.sweeps.runAppSweep({ now: at(2 * MINUTE - SECOND) })).handoffs).toBe(0);

    // Two minutes after the host went: the survivor hands the role over.
    const handoff = await b.sweeps.runAppSweep({ now: at(2 * MINUTE) });
    expect(handoff.handoffs).toBe(1);
    expect(await row(id)).toMatchObject({ host_user_id: world.member.id, host_gone_at: null });
    await settle(600);
    expect((first.ofType("app-session").at(-1) as unknown as { isHost: boolean }).isHost).toBe(true);
    expect((second.ofType("app-session").at(-1) as unknown as { isHost: boolean }).isHost).toBe(false);
  });

  it("two machines sweeping at once make one handoff", async () => {
    const id = await startOnA(world.channels.lobby);
    const hostRec = await join(a, id, world.owner);
    await join(a, id, world.member);
    await join(b, id, world.moderator);
    await settle(300);
    await heartbeat(a.bus.INSTANCE_ID, 30 * MINUTE);
    await heartbeat(b.bus.INSTANCE_ID, 30 * MINUTE);
    await a.wsApps.handleAppSocketClose(hostRec.socket);
    await a.sweeps.runAppSweep({ now: at(0) });
    expect((await row(id)).host_gone_at).toEqual(at(0));

    const [left, right] = await Promise.all([
      a.sweeps.runAppSweep({ now: at(2 * MINUTE) }),
      b.sweeps.runAppSweep({ now: at(2 * MINUTE) }),
    ]);
    expect(left.handoffs + right.handoffs).toBe(1);
    const after = await row(id);
    expect(after.host_gone_at).toBeNull();
    expect([world.member.id, world.moderator.id]).toContain(after.host_user_id);
  });

  it("the take-host tap on one machine and the sweep on the other: one winner", async () => {
    const id = await startOnA(world.channels.general);
    const hostRec = await join(a, id, world.owner);
    await join(b, id, world.member);
    await settle(300);
    await heartbeat(a.bus.INSTANCE_ID, 30 * MINUTE);
    await heartbeat(b.bus.INSTANCE_ID, 30 * MINUTE);
    await a.wsApps.handleAppSocketClose(hostRec.socket);
    await a.sweeps.runAppSweep({ now: at(0) });

    const host = await import("./host.js");
    const outcomes = await Promise.allSettled([
      host.takeHostAs(world.member, id),
      b.sweeps.runAppSweep({ now: at(3 * MINUTE) }),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await row(id)).host_user_id).toBe(world.member.id);
  });

  it("the job is one process per tick: a lease, whoever asks first", async () => {
    await startOnA();
    const results = await Promise.all([
      a.sweeps.runAppSweepJob({ now: at(0) }),
      b.sweeps.runAppSweepJob({ now: at(0) }),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    // The lease is spent for this tick on both.
    expect(await a.sweeps.runAppSweepJob({ now: at(0) })).toBeNull();
    expect(await b.sweeps.runAppSweepJob({ now: at(0) })).toBeNull();
  });
});

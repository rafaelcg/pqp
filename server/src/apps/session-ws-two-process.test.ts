import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbUser } from "../db.js";
import type { World } from "./testing-world.js";

/**
 * TAKING PART IN AN APP SESSION ON TWO MACHINES.
 *
 * Production runs two API machines with `CLUSTER_BUS=postgres` and
 * `VOICE_REGISTRY=postgres`: two module graphs here (two instances), one real
 * Postgres, the real LISTEN/NOTIFY bus between them, the runtime flag turned on
 * by an override row written on one instance and read on the other (never the
 * environment: pitfalls 9 and 12). Participants sit on both machines and see
 * each other's state, events and roster.
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

const settle = (ms = 500) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb("app sessions across two instances on the Postgres bus", () => {
  let a: Instance;
  let b: Instance;
  let world: World;
  let appId: string;
  let testing: typeof import("./testing-world.js");

  const roster = (rec: { ofType: (t: string) => unknown[] }) =>
    (rec.ofType("app-session").at(-1) as { participants: Array<{ userId: string; connection: string }> })
      .participants;
  const snapshot = (rec: { ofType: (t: string) => unknown[] }) =>
    rec.ofType("app-session").at(-1) as { seatId: string; role: string; participants: unknown[] };

  async function join(on: Instance, sessionId: string, user: DbUser, asSpectator = false) {
    const rec = testing.recordingSocket(on, user);
    await on.wsApps.handleAppFrame(rec.socket, user, {
      type: "app-join",
      sessionId,
      ...(asSpectator ? { asSpectator } : {}),
    });
    return rec;
  }

  async function startOn(on: Instance, host: DbUser, channelId: string, app = appId) {
    on.sessions.resetAppSessionLimitsForTests();
    return (await on.sessions.startAppSession(host, channelId, app)).id;
  }

  beforeAll(async () => {
    a = await bootInstance();
    b = await bootInstance();
    testing = await import("./testing-world.js");
    expect(a.bus.INSTANCE_ID).not.toBe(b.bus.INSTANCE_ID);
    await a.db.getPool().query(
      `TRUNCATE app_admin_audit, app_sessions, app_session_participants, server_apps,
                app_versions, apps, feature_flags, feature_flag_overrides, messages,
                member_timeouts, users, servers RESTART IDENTITY CASCADE`,
    );
    await a.db.getPool().query(
      `INSERT INTO app_publishers (id, display_name, kind)
       VALUES ('pqp', 'pqp', 'first_party') ON CONFLICT (id) DO NOTHING`,
    );
    world = await testing.buildWorld(a);
    appId = await testing.publishTestApp(a, world.serverId, {
      players: { max: 4, spectators: true },
      state: { maxBytes: 200, maxWritesPerSecond: 10, writers: "participants" },
      events: { maxPerSecond: 20, maxBytes: 100 },
    });
    await a.flags.setServerFlagOverride("apps", world.serverId, true, { kind: "dashboard" });
    await vi.waitFor(
      () => expect(b.flags.isEnabled("apps", { serverId: world.serverId })).toBe(true),
      { timeout: 5_000 },
    );
  }, 40_000);

  afterEach(async () => {
    // Whatever a failed test left live must not block the next one's channel.
    await a.db.getPool().query(
      `UPDATE app_sessions SET status = 'ended', ended_at = NOW(), end_reason = 'host'
        WHERE status = 'live'`,
    );
    a.wsApps.resetAppsWsForTests();
    b.wsApps.resetAppsWsForTests();
  });

  afterAll(async () => {
    for (const instance of booted) {
      instance.wsApps.resetAppsWsForTests();
      await instance.transport.close().catch(() => {});
      instance.flags.resetFeatureFlagsForTests();
      await instance.db.closePool().catch(() => {});
    }
  });

  it("participants on both machines see each other's roster, state and events", async () => {
    const id = await startOn(a, world.owner, world.channels.general);
    const owner = await join(a, id, world.owner);
    const member = await join(b, id, world.member);
    const moderator = await join(b, id, world.moderator);
    await settle();

    // The roster reached the first machine's participant about people on the second.
    expect(roster(owner)).toHaveLength(3);
    expect(roster(member)).toHaveLength(3);
    expect(roster(moderator).map((p) => p.userId).sort()).toEqual(
      [world.owner.id, world.member.id, world.moderator.id].sort(),
    );
    const moderatorSeat = snapshot(moderator).seatId;
    for (const rec of [owner, member, moderator]) {
      rec.frames.length = 0;
    }

    // State written on B reaches A, and the other way round, in one revision order.
    await b.wsApps.handleAppFrame(member.socket, world.member, {
      type: "app-state-patch",
      sessionId: id,
      patch: { fromB: 1 },
    });
    await settle(300);
    await a.wsApps.handleAppFrame(owner.socket, world.owner, {
      type: "app-state-patch",
      sessionId: id,
      patch: { fromA: 1 },
    });
    await settle(400);
    for (const rec of [owner, member, moderator]) {
      const frames = rec.ofType("app-state") as unknown as Array<{
        rev: number;
        value: Record<string, number>;
      }>;
      expect(frames.map((f) => f.rev)).toEqual([1, 2]);
      expect(frames.at(-1)!.value).toEqual({ fromB: 1, fromA: 1 });
    }

    // An event from B reaches A and B's other seat, and not its own.
    for (const rec of [owner, member, moderator]) {
      rec.frames.length = 0;
    }
    await b.wsApps.handleAppFrame(moderator.socket, world.moderator, {
      type: "app-event-send",
      sessionId: id,
      name: "wave",
      data: { hi: true },
    });
    await settle(300);
    expect(owner.ofType("app-event")).toEqual([
      { type: "app-event", sessionId: id, fromSeatId: moderatorSeat, name: "wave", data: { hi: true } },
    ]);
    expect(member.ofType("app-event")).toHaveLength(1);
    expect(moderator.ofType("app-event")).toHaveLength(0);

    await a.sessions.endSessionRow(id, "host", world.owner.id);
  });

  it("writes from both machines at the same moment serialize into one revision order", async () => {
    const id = await startOn(a, world.owner, world.channels.general);
    const owner = await join(a, id, world.owner);
    const member = await join(b, id, world.member);
    await settle(300);
    for (const rec of [owner, member]) {
      rec.frames.length = 0;
    }
    await Promise.all([
      a.wsApps.handleAppFrame(owner.socket, world.owner, {
        type: "app-state-patch",
        sessionId: id,
        patch: { a: 1, shared: "from-a" },
      }),
      b.wsApps.handleAppFrame(member.socket, world.member, {
        type: "app-state-patch",
        sessionId: id,
        patch: { b: 1, shared: "from-b" },
      }),
    ]);
    await settle(500);
    const row = (
      await a.db.getPool().query<{ state: Record<string, unknown>; state_rev: string }>(
        `SELECT state, state_rev FROM app_sessions WHERE id = $1`,
        [id],
      )
    ).rows[0]!;
    expect(row.state.a).toBe(1);
    expect(row.state.b).toBe(1);
    expect(Number(row.state_rev)).toBeGreaterThanOrEqual(1);
    expect(Number(row.state_rev)).toBeLessThanOrEqual(2);
    // Both participants end on the same revision and the same value as the row.
    for (const rec of [owner, member]) {
      const last = rec.ofType("app-state").at(-1) as unknown as { rev: number; value: unknown };
      expect(last.rev).toBe(Number(row.state_rev));
      expect(last.value).toEqual(row.state);
    }
    await a.sessions.endSessionRow(id, "host", world.owner.id);
  });

  it("a close on one machine shows as reconnecting on the other, and the same seat comes back on either", async () => {
    const id = await startOn(a, world.owner, world.channels.general);
    const owner = await join(a, id, world.owner);
    const member = await join(b, id, world.member);
    await settle(300);
    const seat = snapshot(member).seatId;
    owner.frames.length = 0;

    await b.wsApps.handleAppSocketClose(member.socket);
    await settle();
    expect(roster(owner).find((p) => p.userId === world.member.id)?.connection).toBe("reconnecting");

    // The person comes back through the OTHER machine: the same seat, owned by it now.
    const back = await join(a, id, world.member);
    expect(snapshot(back).seatId).toBe(seat);
    const row = (
      await a.db
        .getPool()
        .query<{ orphaned_at: Date | null; instance_id: string }>(
          `SELECT orphaned_at, instance_id FROM app_session_participants
            WHERE session_id = $1 AND user_id = $2`,
          [id, world.member.id],
        )
    ).rows[0]!;
    expect(row.orphaned_at).toBeNull();
    expect(row.instance_id).toBe(a.bus.INSTANCE_ID);
    await settle();
    expect(roster(owner).find((p) => p.userId === world.member.id)?.connection).toBe("present");
    await a.sessions.endSessionRow(id, "host", world.owner.id);
  });

  it("a person with a tab on each machine keeps the seat when one closes (the other machine takes it back)", async () => {
    const id = await startOn(a, world.owner, world.channels.general);
    const onB = await join(b, id, world.member);
    const onA = await join(a, id, world.member);
    expect(snapshot(onA).seatId).toBe(snapshot(onB).seatId);
    await settle(300);
    const heldRow = () =>
      a.db
        .getPool()
        .query<{ orphaned_at: Date | null; instance_id: string }>(
          `SELECT orphaned_at, instance_id FROM app_session_participants
            WHERE session_id = $1 AND user_id = $2`,
          [id, world.member.id],
        )
        .then((result) => result.rows[0]!);

    // The tab on A (the row's owner) closes while B's is still seated: A held the
    // seat on its own evidence; B's roster delivery has a live socket for the
    // person and takes the seat back.
    await a.wsApps.handleAppSocketClose(onA.socket);
    await vi.waitFor(async () => {
      const row = await heldRow();
      expect(row.orphaned_at).toBeNull();
      expect(row.instance_id).toBe(b.bus.INSTANCE_ID);
    }, { timeout: 5_000 });

    // And a close on the machine that does NOT own the row changes nothing.
    const again = await join(a, id, world.member);
    expect((await heldRow()).instance_id).toBe(a.bus.INSTANCE_ID);
    await b.wsApps.handleAppSocketClose(onB.socket);
    expect((await heldRow()).orphaned_at).toBeNull();
    void again;
    await a.sessions.endSessionRow(id, "host", world.owner.id);
  });

  it("two machines taking the last place at once: one player, one spectator", async () => {
    const duo = await testing.publishTestApp(a, world.serverId, {
      id: "last-seat-app",
      players: { max: 1, spectators: true },
    });
    const id = await startOn(a, world.owner, world.channels.lobby, duo);
    const [left, right] = await Promise.all([
      join(a, id, world.member),
      join(b, id, world.moderator),
    ]);
    expect([snapshot(left).role, snapshot(right).role].sort()).toEqual(["player", "spectator"]);
    await a.sessions.endSessionRow(id, "host", world.owner.id);
  });

  it("an end taken on one machine reaches the participants on both", async () => {
    const id = await startOn(a, world.owner, world.channels.general);
    const onA = await join(a, id, world.owner);
    const onB = await join(b, id, world.member);
    await settle(300);
    await b.sessions.endAppSessionAs(world.owner, id);
    await settle(400);
    for (const rec of [onA, onB]) {
      expect(rec.ofType("app-ended")).toEqual([
        expect.objectContaining({ sessionId: id, reason: "host" }),
      ]);
    }
    // And the frames after it find no seat on either.
    await b.wsApps.handleAppFrame(onB.socket, world.member, {
      type: "app-state-patch",
      sessionId: id,
      patch: { late: true },
    });
    await settle(150);
    expect(
      (
        await a.db.getPool().query<{ state_rev: string }>(
          `SELECT state_rev FROM app_sessions WHERE id = $1`,
          [id],
        )
      ).rows[0]!.state_rev,
    ).toBe("0");
  });

  it("each machine's sweep reads only its own rows", async () => {
    const id = await startOn(a, world.owner, world.channels.general);
    await a.db.getPool().query(
      `INSERT INTO app_session_participants (session_id, user_id, seat_id, role, instance_id, orphaned_at)
       VALUES ($1, $2, 'sweepAAAAAAAAAAAAAAAAAA', 'player', $3, NOW() - interval '1 hour')`,
      [id, world.member.id, a.bus.INSTANCE_ID],
    );
    const left = () =>
      a.db
        .getPool()
        .query<{ left_at: Date | null }>(
          `SELECT left_at FROM app_session_participants WHERE session_id = $1 AND user_id = $2`,
          [id, world.member.id],
        )
        .then((result) => result.rows[0]!.left_at);
    // B judges nothing about A's row, however old it is.
    expect(await b.wsApps.sweepOwnAppParticipants({ now: new Date(Date.now() + 3_600_000) })).toEqual({
      orphaned: 0,
      released: 0,
    });
    expect(await left()).toBeNull();
    expect((await a.wsApps.sweepOwnAppParticipants()).released).toBe(1);
    expect(await left()).not.toBeNull();
    await a.sessions.endSessionRow(id, "host", world.owner.id);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Permission, type AppManifest } from "@pqp/shared";
import type { World } from "./testing-world.js";

/**
 * JOINING AN APP SESSION AND TAKING PART IN IT, over the real socket handlers,
 * against a real Postgres, with the real runtime flag snapshot and the real
 * LISTEN/NOTIFY bus installed (production runs `CLUSTER_BUS=postgres` and
 * `VOICE_REGISTRY=postgres`: pitfall 12). Frames are read off recording
 * sockets. Scratch database only (`TEST_DATABASE_URL`).
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
delete process.env.LOCADORA_SHARE;

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
const chat = await import("../ws/chat.js");
const sessions = await import("./sessions.js");
const metrics = await import("./metrics.js");
const { buildWorld, publishTestApp, recordingSocket } = await import("./testing-world.js");

const modules = { db, users, servers, roles, flags, catalog, sockets };
const q = <T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
) => db.getPool().query<T>(text, values);

const settle = (ms = 350) => new Promise((resolve) => setTimeout(resolve, ms));

type Rec = ReturnType<typeof recordingSocket>;

describeDb("app sessions over the socket", () => {
  let transport: ReturnType<typeof createPostgresBusTransport>;
  let world: World;
  let appId: string;

  async function resetApps(): Promise<void> {
    await q(`TRUNCATE app_admin_audit, app_sessions, app_session_participants, server_apps,
                      app_versions, apps, feature_flags, feature_flag_overrides, messages,
                      member_timeouts RESTART IDENTITY CASCADE`);
    await q(
      `INSERT INTO app_publishers (id, display_name, kind)
       VALUES ('pqp', 'pqp', 'first_party') ON CONFLICT (id) DO NOTHING`,
    );
  }

  /** Start a session as `host` in `channelId`, and give back its id. */
  async function startSession(
    host = world.owner,
    channelId = world.channels.general,
    id = appId,
  ): Promise<string> {
    sessions.resetAppSessionLimitsForTests();
    return (await sessions.startAppSession(host, channelId, id)).id;
  }

  /** A fresh recording socket for `user`, joined to `sessionId`. */
  async function join(
    sessionId: string,
    user: DbUser,
    options: { asSpectator?: boolean } = {},
  ): Promise<Rec> {
    const rec = recordingSocket(modules, user);
    await wsApps.handleAppFrame(rec.socket, user, {
      type: "app-join",
      sessionId,
      ...(options.asSpectator ? { asSpectator: true } : {}),
    });
    return rec;
  }

  const errors = (rec: Rec) =>
    rec.ofType("app-error") as unknown as Array<{ op: string; code: string }>;
  const snapshot = (rec: Rec) => rec.ofType("app-session").at(-1) as any;
  const rowOf = async (sessionId: string, user: DbUser) =>
    (
      await q(
        `SELECT * FROM app_session_participants WHERE session_id = $1 AND user_id = $2`,
        [sessionId, user.id],
      )
    ).rows[0];

  /** Publish another app on the server with the manifest knobs a test turns. */
  const publish = (options: Parameters<typeof publishTestApp>[2]) =>
    publishTestApp(modules, world.serverId, options);

  beforeAll(async () => {
    await db.initDb();
    transport = createPostgresBusTransport(DATABASE_URL!);
    bus.setBusTransport(transport);
    await transport.whenConnected();
  }, 30_000);

  beforeEach(async () => {
    await resetApps();
    flags.resetFeatureFlagsForTests();
    await flags.startFeatureFlags();
    metrics.resetAppCountersForTests();
    sessions.resetAppSessionLimitsForTests();
    wsApps.resetAppsWsForTests();
    world = await buildWorld(modules);
    appId = await publishTestApp(modules, world.serverId, {
      players: { max: 3, spectators: true, maxSpectators: 2 },
      state: { maxBytes: 64, maxWritesPerSecond: 10, writers: "participants" },
      events: { maxPerSecond: 3, maxBytes: 40 },
    });
    await flags.setServerFlagOverride("apps", world.serverId, true, { kind: "dashboard" });
  });

  afterAll(async () => {
    flags.resetFeatureFlagsForTests();
    await transport.close().catch(() => {});
    await db.closePool();
  });

  describe("joining: the floor", () => {
    it("VIEW_CHANNEL is the floor in a text channel: a person who cannot see it is refused", async () => {
      const id = await startSession(world.insider, world.channels.secret);
      const refused = await join(id, world.member);
      expect(errors(refused)).toEqual([expect.objectContaining({ op: "join", code: "not-allowed" })]);
      expect(await rowOf(id, world.member)).toBeUndefined();
      const stranger = await join(id, world.stranger);
      expect(errors(stranger)[0]).toMatchObject({ code: "not-allowed" });
      // The one who can see it is in.
      expect(snapshot(await join(id, world.insider))).toBeTruthy();
    });

    it("in a text channel CONNECT is not needed; in a voice channel it is", async () => {
      await q(`SELECT 1`);
      await roles.upsertChannelOverwrite(
        world.channels.general,
        world.serverId,
        "member",
        world.noApps.id,
        0n,
        Permission.CONNECT,
      );
      await roles.upsertChannelOverwrite(
        world.channels.lobby,
        world.serverId,
        "member",
        world.noApps.id,
        0n,
        Permission.CONNECT,
      );
      const inText = await startSession(world.owner, world.channels.general);
      expect(snapshot(await join(inText, world.noApps))).toBeTruthy();
      const inVoice = await startSession(world.owner, world.channels.lobby);
      const refused = await join(inVoice, world.noApps);
      expect(errors(refused)[0]).toMatchObject({ op: "join", code: "not-allowed" });
      expect(snapshot(await join(inVoice, world.member))).toBeTruthy();
    });

    it("a manifest can raise the floor to CONNECT in a text channel, never lower it", async () => {
      const strict = await publish({ id: "connect-app", requires: { join: "CONNECT" } });
      await roles.upsertChannelOverwrite(
        world.channels.general,
        world.serverId,
        "member",
        world.noApps.id,
        0n,
        Permission.CONNECT,
      );
      const id = await startSession(world.owner, world.channels.general, strict);
      expect(errors(await join(id, world.noApps))[0]).toMatchObject({ code: "not-allowed" });
      expect(snapshot(await join(id, world.member))).toBeTruthy();
      // And a VIEW_CHANNEL manifest in a voice channel still needs CONNECT.
      const lax = await publish({ id: "view-app", requires: { join: "VIEW_CHANNEL" } });
      await roles.upsertChannelOverwrite(
        world.channels.lobby,
        world.serverId,
        "member",
        world.noApps.id,
        0n,
        Permission.CONNECT,
      );
      const voice = await startSession(world.owner, world.channels.lobby, lax);
      expect(errors(await join(voice, world.noApps))[0]).toMatchObject({ code: "not-allowed" });
    });

    it("answers a session that does not exist, or whose server has the flag off, with nothing at all", async () => {
      const ghost = recordingSocket(modules, world.member);
      await wsApps.handleAppFrame(ghost.socket, world.member, {
        type: "app-join",
        sessionId: "00000000-0000-4000-8000-000000000000",
      });
      expect(ghost.frames).toEqual([]);

      const id = await startSession();
      await flags.setServerFlagOverride("apps", world.serverId, false, { kind: "dashboard" });
      const off = await join(id, world.member);
      await settle(100);
      expect(off.frames).toEqual([]);
      expect(await rowOf(id, world.member)).toBeUndefined();
    });

    it("an ended session answers `ended` to somebody who can see its channel", async () => {
      const id = await startSession();
      await sessions.endSessionRow(id, "host", world.owner.id);
      const late = await join(id, world.member);
      expect(errors(late)).toEqual([expect.objectContaining({ op: "join", code: "ended" })]);
    });

    it("is rate limited per person, and counted", async () => {
      const id = await startSession();
      const rec = recordingSocket(modules, world.member);
      for (let i = 0; i < 12; i += 1) {
        await wsApps.handleAppFrame(rec.socket, world.member, { type: "app-join", sessionId: id });
      }
      // Over the limit a join is dropped before any read, and without an answer.
      expect(errors(rec)).toEqual([]);
      expect(metrics.appCountersSnapshot().framesDropped["join-rate"]).toBeGreaterThan(0);
    });
  });

  describe("joining: what it writes and what comes back", () => {
    it("seats the person, sends the snapshot, tells the others and the channel's viewers", async () => {
      const id = await startSession(world.owner);
      const host = await join(id, world.owner);
      const viewer = recordingSocket(modules, world.moderator);

      const hostSnapshot = snapshot(host);
      expect(hostSnapshot).toMatchObject({
        type: "app-session",
        sessionId: id,
        role: "player",
        isHost: true,
        state: { rev: 0, value: {} },
      });
      expect(hostSnapshot.seatId).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(hostSnapshot.participants).toEqual([
        expect.objectContaining({ userId: world.owner.id, isHost: true, connection: "present" }),
      ]);

      const guest = await join(id, world.member);
      const guestSnapshot = snapshot(guest);
      expect(guestSnapshot).toMatchObject({ role: "player", isHost: false });
      expect(guestSnapshot.seatId).not.toBe(hostSnapshot.seatId);
      expect(guestSnapshot.participants).toHaveLength(2);

      const row = await rowOf(id, world.member);
      expect(row).toMatchObject({
        seat_id: guestSnapshot.seatId,
        role: "player",
        left_at: null,
        orphaned_at: null,
        instance_id: bus.INSTANCE_ID,
      });

      await settle();
      // The host hears the roster again, with both seats.
      expect(snapshot(host).participants).toHaveLength(2);
      // The viewer's summary carries the count.
      const summary = viewer.ofType("channel-app").at(-1) as any;
      expect(summary.session.participants).toHaveLength(2);
      expect(summary.session.players).toBe(2);
      expect(metrics.appCountersSnapshot().joins).toBe(2);
    });

    it("a join clears the empty clock, and the host's return ends the handoff countdown", async () => {
      const id = await startSession(world.owner);
      await q(`UPDATE app_sessions SET empty_since = NOW(), host_gone_at = NOW() WHERE id = $1`, [id]);
      await join(id, world.member);
      let row = (await q(`SELECT empty_since, host_gone_at FROM app_sessions WHERE id = $1`, [id])).rows[0]!;
      expect(row.empty_since).toBeNull();
      expect(row.host_gone_at).not.toBeNull();
      await join(id, world.owner);
      row = (await q(`SELECT empty_since, host_gone_at FROM app_sessions WHERE id = $1`, [id])).rows[0]!;
      expect(row.host_gone_at).toBeNull();
    });

    it("never puts a user id on the frames an app is shown (state and events), only on the roster", async () => {
      const id = await startSession(world.owner);
      const a = await join(id, world.owner);
      const b = await join(id, world.member);
      await wsApps.handleAppFrame(a.socket, world.owner, {
        type: "app-state-patch",
        sessionId: id,
        patch: { hello: "world" },
      });
      await wsApps.handleAppFrame(a.socket, world.owner, {
        type: "app-event-send",
        sessionId: id,
        name: "ping",
        data: { n: 1 },
      });
      await settle();
      for (const type of ["app-state", "app-event"]) {
        const text = JSON.stringify(b.ofType(type));
        expect(b.ofType(type).length, type).toBeGreaterThan(0);
        expect(text).not.toContain(world.owner.id);
        expect(text).not.toContain(world.member.id);
      }
    });
  });

  describe("players, spectators and `full`", () => {
    it("fills the players, then seats spectators if the app allows, then says full", async () => {
      const id = await startSession(world.owner);
      const roleOf = async (user: DbUser, options = {}) => snapshot(await join(id, user, options))?.role;
      expect(await roleOf(world.owner)).toBe("player");
      expect(await roleOf(world.member)).toBe("player");
      expect(await roleOf(world.moderator)).toBe("player");
      // Over `players.max` (3): a spectator, up to `maxSpectators` (2).
      expect(await roleOf(world.manager)).toBe("spectator");
      expect(await roleOf(world.insider)).toBe("spectator");
      const full = await join(id, world.noApps);
      expect(errors(full)).toEqual([expect.objectContaining({ op: "join", code: "full" })]);
      expect(await rowOf(id, world.noApps)).toBeUndefined();
      expect(metrics.appCountersSnapshot().joinsRefused).toEqual({ full: 1 });
    });

    it("`asSpectator` asks for a spectator seat even with room", async () => {
      const id = await startSession(world.owner);
      expect(snapshot(await join(id, world.member, { asSpectator: true })).role).toBe("spectator");
    });

    it("an app without spectators says `full` over max and refuses `asSpectator`", async () => {
      const solo = await publish({ id: "solo-app", players: { max: 1, spectators: false } });
      const id = await startSession(world.owner, world.channels.general, solo);
      expect(snapshot(await join(id, world.owner)).role).toBe("player");
      expect(errors(await join(id, world.member))[0]).toMatchObject({ code: "full" });
      expect(errors(await join(id, world.moderator, { asSpectator: true }))[0]).toMatchObject({
        code: "not-allowed",
      });
    });

    it("two people joining the last place at once: one player, the other a spectator", async () => {
      const duo = await publish({ id: "duo-app", players: { max: 1, spectators: true } });
      const id = await startSession(world.owner, world.channels.general, duo);
      const [a, b] = await Promise.all([join(id, world.member), join(id, world.moderator)]);
      const roles = [snapshot(a).role, snapshot(b).role].sort();
      expect(roles).toEqual(["player", "spectator"]);
    });

    it("D14: an emulator app admits spectators only where locadora_share is on", async () => {
      const emu = await publish({
        id: "pqp-retro",
        category: "emulator",
        players: { max: 1, spectators: true },
      });
      // `emulator_room` is not registered until PR 1390, so the start route
      // would refuse an emulator app: put the session in directly.
      const inserted = await q<{ id: string }>(
        `INSERT INTO app_sessions (server_id, channel_id, app_id, app_version, started_by, host_user_id)
         SELECT $1, $2, a.id, a.current_version, $3, $3 FROM apps a WHERE a.id = $4
         RETURNING id`,
        [world.serverId, world.channels.general, world.owner.id, emu],
      );
      const id = inserted.rows[0]!.id;
      expect(snapshot(await join(id, world.owner)).role).toBe("player");

      // Off: asking to watch is refused, and over `max` the answer is full.
      expect(errors(await join(id, world.member, { asSpectator: true }))[0]).toMatchObject({
        code: "not-allowed",
      });
      expect(errors(await join(id, world.moderator))[0]).toMatchObject({ code: "full" });

      // On for this server: both are seated as spectators.
      await flags.setServerFlagOverride("locadora_share", world.serverId, true, { kind: "dashboard" });
      expect(snapshot(await join(id, world.member, { asSpectator: true })).role).toBe("spectator");
      expect(snapshot(await join(id, world.moderator)).role).toBe("spectator");
    });

    it("a person under a timeout may watch and not act: seated as a spectator", async () => {
      await q(
        `INSERT INTO member_timeouts (server_id, user_id, expires_at)
         VALUES ($1, $2, NOW() + interval '1 hour')`,
        [world.serverId, world.member.id],
      );
      const id = await startSession(world.owner);
      const rec = await join(id, world.member);
      expect(snapshot(rec).role).toBe("spectator");
      await wsApps.handleAppFrame(rec.socket, world.member, {
        type: "app-event-send",
        sessionId: id,
        name: "ping",
        data: {},
      });
      expect(errors(rec)).toEqual([expect.objectContaining({ op: "event", code: "not-allowed" })]);
    });
  });

  describe("a timeout issued after the join", () => {
    it("stops state writes and events within the recheck window, and a rejoin cannot resume a player seat", async () => {
      const id = await startSession(world.owner);
      const rec = await join(id, world.member);
      const other = await join(id, world.moderator);
      await settle(100);
      other.frames.length = 0;
      expect(wsApps.seatOf(id, rec.socket)!.role).toBe("player");

      await q(
        `INSERT INTO member_timeouts (server_id, user_id, expires_at)
         VALUES ($1, $2, NOW() + interval '1 hour')`,
        [world.serverId, world.member.id],
      );
      // The seat's last look was a moment ago: age it past the window.
      wsApps.seatOf(id, rec.socket)!.timeoutCheckedAt = Date.now() - wsApps.APP_TIMEOUT_RECHECK_MS - 1;
      await wsApps.handleAppFrame(rec.socket, world.member, {
        type: "app-state-patch",
        sessionId: id,
        patch: { a: 1 },
      });
      await wsApps.handleAppFrame(rec.socket, world.member, {
        type: "app-event-send",
        sessionId: id,
        name: "ping",
        data: {},
      });
      await settle(200);
      expect(errors(rec).map((e) => [e.op, e.code])).toEqual([
        ["state", "not-allowed"],
        ["event", "not-allowed"],
      ]);
      expect(other.ofType("app-state")).toEqual([]);
      expect(other.ofType("app-event")).toEqual([]);
      expect((await q(`SELECT state_rev FROM app_sessions WHERE id = $1`, [id])).rows[0]!.state_rev).toBe("0");

      // Back in on a fresh socket: still the same seat, no longer a player.
      const again = await join(id, world.member);
      expect(snapshot(again).role).toBe("spectator");
      expect((await rowOf(id, world.member)).role).toBe("spectator");
    });
  });

  describe("the empty clock", () => {
    it("is started for a session with nobody and not for one with a seat, and a leave starts it in the same write", async () => {
      const { stampEmptySessions } = await import("./participants.js");
      const quiet = await startSession(world.owner, world.channels.general);
      const busy = await startSession(world.owner, world.channels.lobby);
      await join(busy, world.member);
      expect(await stampEmptySessions()).toBe(1);
      const clocks = async () =>
        (await q(`SELECT id, empty_since FROM app_sessions`)).rows.reduce<Record<string, unknown>>(
          (acc, r) => ({ ...acc, [r.id as string]: r.empty_since }),
          {},
        );
      expect((await clocks())[quiet]).toBeInstanceOf(Date);
      expect((await clocks())[busy]).toBeNull();
      // Again: nothing to do, the clock is not moved.
      const first = (await clocks())[quiet];
      expect(await stampEmptySessions()).toBe(0);
      expect((await clocks())[quiet]).toEqual(first);

      const rec = recordingSocket(modules, world.member);
      await wsApps.handleAppFrame(rec.socket, world.member, { type: "app-leave", sessionId: busy });
      expect((await clocks())[busy]).toBeInstanceOf(Date);
    });
  });

  describe("sockets, seats and the 90 second hold", () => {
    it("a socket closing holds the seat; coming back reuses the row and the seat id", async () => {
      const id = await startSession(world.owner);
      const first = await join(id, world.member);
      const seat = snapshot(first).seatId;
      const watcher = await join(id, world.owner);
      await settle(100);
      watcher.frames.length = 0;

      await wsApps.handleAppSocketClose(first.socket);
      const held = await rowOf(id, world.member);
      expect(held.orphaned_at).not.toBeNull();
      expect(held.left_at).toBeNull();
      await settle();
      // The others see the person as reconnecting, not gone.
      const others = snapshot(watcher).participants.find((p: any) => p.seatId === seat);
      expect(others.connection).toBe("reconnecting");
      const viewer = recordingSocket(modules, world.moderator);
      void viewer;

      const again = await join(id, world.member);
      expect(snapshot(again).seatId).toBe(seat);
      const back = await rowOf(id, world.member);
      expect(back.orphaned_at).toBeNull();
      expect(back.joined_at).toEqual(held.joined_at);
      await settle();
      expect(snapshot(watcher).participants.find((p: any) => p.seatId === seat).connection).toBe(
        "present",
      );
    });

    it("the summary says reconnecting while a seat is held", async () => {
      const id = await startSession(world.owner);
      const rec = await join(id, world.member);
      await wsApps.handleAppSocketClose(rec.socket);
      const summary = await (await import("./summary.js")).readLiveSummary(world.channels.general);
      expect(summary!.participants).toEqual([
        expect.objectContaining({ userId: world.member.id, connection: "reconnecting" }),
      ]);
    });

    it("a person with two tabs stays seated until the last one closes", async () => {
      const id = await startSession(world.owner);
      const tabOne = await join(id, world.member);
      const tabTwo = await join(id, world.member);
      expect(snapshot(tabTwo).seatId).toBe(snapshot(tabOne).seatId);
      await wsApps.handleAppSocketClose(tabOne.socket);
      expect((await rowOf(id, world.member)).orphaned_at).toBeNull();
      await wsApps.handleAppSocketClose(tabTwo.socket);
      expect((await rowOf(id, world.member)).orphaned_at).not.toBeNull();
    });

    it("app-leave releases the seat at once, not held; coming back keeps the seat id but not the place in line", async () => {
      const id = await startSession(world.owner);
      const rec = await join(id, world.member);
      const seat = snapshot(rec).seatId;
      const before = await rowOf(id, world.member);
      await wsApps.handleAppFrame(rec.socket, world.member, { type: "app-leave", sessionId: id });
      const left = await rowOf(id, world.member);
      expect(left.left_at).not.toBeNull();
      expect(left.orphaned_at).toBeNull();
      // Its socket is no longer seated: a close now does nothing to the row.
      await wsApps.handleAppSocketClose(rec.socket);
      expect((await rowOf(id, world.member)).orphaned_at).toBeNull();
      // And the roster no longer lists the person.
      const summary = await (await import("./summary.js")).readLiveSummary(world.channels.general);
      expect(summary!.participants).toEqual([]);

      await settle(20);
      const back = await join(id, world.member);
      expect(snapshot(back).seatId).toBe(seat);
      const rejoined = await rowOf(id, world.member);
      expect(rejoined.left_at).toBeNull();
      expect((rejoined.joined_at as Date).getTime()).toBeGreaterThan((before.joined_at as Date).getTime());
    });

    it("the sweep holds a seat for 90 s and then releases it, and a leave is not held at all", async () => {
      const id = await startSession(world.owner);
      const rec = await join(id, world.member);
      await wsApps.handleAppSocketClose(rec.socket);
      const stamped = (await rowOf(id, world.member)).orphaned_at as Date;

      let swept = await wsApps.sweepOwnAppParticipants({ now: new Date(stamped.getTime() + 89_000) });
      expect(swept).toEqual({ orphaned: 0, released: 0 });
      expect((await rowOf(id, world.member)).left_at).toBeNull();

      swept = await wsApps.sweepOwnAppParticipants({ now: new Date(stamped.getTime() + 91_000) });
      expect(swept.released).toBe(1);
      expect((await rowOf(id, world.member)).left_at).not.toBeNull();
      // The session now has nobody: the empty clock started.
      const session = (await q(`SELECT empty_since FROM app_sessions WHERE id = $1`, [id])).rows[0]!;
      expect(session.empty_since).not.toBeNull();
    });

    it("a ghost row this process owns (a close that never reached it) is held, then released", async () => {
      const id = await startSession(world.owner);
      const rec = await join(id, world.member);
      // Lose the socket without the close path: the row stays, the map forgets it.
      wsApps.removeSessionSocket(id, rec.socket);
      expect((await rowOf(id, world.member)).orphaned_at).toBeNull();

      const first = await wsApps.sweepOwnAppParticipants();
      expect(first.orphaned).toBe(1);
      const held = (await rowOf(id, world.member)).orphaned_at as Date;
      expect(held).not.toBeNull();
      const second = await wsApps.sweepOwnAppParticipants({ now: new Date(held.getTime() + 91_000) });
      expect(second.released).toBe(1);
    });

    /**
     * Hold a row lock in another connection until `release()`, so a handler that
     * needs the row is frozen mid-flight and a test can close its socket THERE,
     * deterministically, instead of racing a timer.
     */
    async function holdLock(query: string, values: unknown[]) {
      const client = await db.getPool().connect();
      await client.query("BEGIN");
      await client.query(query, values);
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          await client.query("COMMIT");
          client.release();
        },
      };
    }

    const lockSession = (id: string) =>
      holdLock(`SELECT 1 FROM app_sessions WHERE id = $1 FOR UPDATE`, [id]);

    describe("a socket that closes while its app-join is in flight", () => {
      it("closing during the seat write leaves a held seat, not a live ghost", async () => {
        const id = await startSession(world.owner);
        const rec = recordingSocket(modules, world.member);
        const lock = await lockSession(id);
        // The join passes every read and freezes inside `joinSession`.
        const joining = wsApps.handleAppFrame(rec.socket, world.member, {
          type: "app-join",
          sessionId: id,
        });
        await settle(300);
        await wsApps.handleAppSocketClose(rec.socket);
        await lock.release();
        await joining;
        await settle();

        const row = await rowOf(id, world.member);
        expect(row.left_at).toBeNull();
        // Held for the resume window, exactly as the close would have.
        expect(row.orphaned_at).not.toBeNull();
        // The dead socket is not registered as the seat's live evidence.
        expect(wsApps.seatOf(id, rec.socket)).toBeUndefined();
        expect(wsApps.hasLocalSocketFor(id, world.member.id)).toBe(false);
        expect(rec.ofType("app-session")).toEqual([]);

        // The sweep treats it as any held seat: kept inside the window, released after.
        const held = row.orphaned_at as Date;
        expect(await wsApps.sweepOwnAppParticipants({ now: new Date(held.getTime() + 60_000) })).toEqual({
          orphaned: 0,
          released: 0,
        });
        const swept = await wsApps.sweepOwnAppParticipants({ now: new Date(held.getTime() + 91_000) });
        expect(swept.released).toBe(1);
        expect((await rowOf(id, world.member)).left_at).not.toBeNull();
        const session = (await q(`SELECT empty_since FROM app_sessions WHERE id = $1`, [id])).rows[0]!;
        expect(session.empty_since).not.toBeNull();
      });

      it("a socket that is closing (readyState 3) with no close handler run yet is treated the same", async () => {
        const id = await startSession(world.owner);
        const rec = recordingSocket(modules, world.member);
        const lock = await lockSession(id);
        const joining = wsApps.handleAppFrame(rec.socket, world.member, {
          type: "app-join",
          sessionId: id,
        });
        await settle(300);
        (rec.socket as unknown as { readyState: number }).readyState = 3;
        await lock.release();
        await joining;
        await settle();

        const row = await rowOf(id, world.member);
        expect(row.orphaned_at).not.toBeNull();
        expect(wsApps.hasLocalSocketFor(id, world.member.id)).toBe(false);
        expect(wsApps.seatOf(id, rec.socket)).toBeUndefined();
      });

      it("closing before the seat is written writes no seat at all", async () => {
        const id = await startSession(world.owner);
        const rec = recordingSocket(modules, world.member);
        const joining = wsApps.handleAppFrame(rec.socket, world.member, {
          type: "app-join",
          sessionId: id,
        });
        await wsApps.handleAppSocketClose(rec.socket);
        await joining;
        await settle(100);
        expect(await rowOf(id, world.member)).toBeUndefined();
        expect(wsApps.hasLocalSocketFor(id, world.member.id)).toBe(false);
      });

      it("a person with another tab seated keeps the seat: the dead socket is simply not registered", async () => {
        const id = await startSession(world.owner);
        const tabOne = await join(id, world.member);
        const tabTwo = recordingSocket(modules, world.member);
        const lock = await lockSession(id);
        const joining = wsApps.handleAppFrame(tabTwo.socket, world.member, {
          type: "app-join",
          sessionId: id,
        });
        await settle(300);
        await wsApps.handleAppSocketClose(tabTwo.socket);
        await lock.release();
        await joining;
        await settle();

        expect((await rowOf(id, world.member)).orphaned_at).toBeNull();
        expect(wsApps.seatOf(id, tabTwo.socket)).toBeUndefined();
        expect(wsApps.seatOf(id, tabOne.socket)).toBeDefined();
        // And the surviving tab's close still holds the seat as usual.
        await wsApps.handleAppSocketClose(tabOne.socket);
        expect((await rowOf(id, world.member)).orphaned_at).not.toBeNull();
      });

      it("a dead socket cannot take a held seat back at the roster", async () => {
        const id = await startSession(world.owner);
        const mine = await join(id, world.member);
        // The socket died without its close handler having run, and the other
        // machine stamped the row as held.
        (mine.socket as unknown as { readyState: number }).readyState = 3;
        await q(
          `UPDATE app_session_participants SET orphaned_at = NOW(), instance_id = 'the-other-instance'
            WHERE session_id = $1 AND user_id = $2`,
          [id, world.member.id],
        );
        await join(id, world.owner);
        await settle();
        const row = await rowOf(id, world.member);
        expect(row.orphaned_at).not.toBeNull();
        expect(row.instance_id).toBe("the-other-instance");
        expect(wsApps.seatOf(id, mine.socket)).toBeUndefined();
        expect(wsApps.hasLocalSocketFor(id, world.member.id)).toBe(false);
      });

      it("a socket that dies while the reclaim write is in flight leaves the seat held again", async () => {
        const id = await startSession(world.owner);
        const mine = await join(id, world.member);
        await q(
          `UPDATE app_session_participants SET orphaned_at = NOW(), instance_id = 'the-other-instance'
            WHERE session_id = $1 AND user_id = $2`,
          [id, world.member.id],
        );
        // Freeze the reclaim on the person's row, then let the socket die there.
        const lock = await holdLock(
          `SELECT 1 FROM app_session_participants WHERE session_id = $1 AND user_id = $2 FOR UPDATE`,
          [id, world.member.id],
        );
        await join(id, world.owner);
        await settle(700);
        (mine.socket as unknown as { readyState: number }).readyState = 3;
        await lock.release();
        await settle();
        const row = await rowOf(id, world.member);
        expect(row.orphaned_at).not.toBeNull();
        expect(wsApps.hasLocalSocketFor(id, world.member.id)).toBe(false);
      });
    });

    /**
     * Park every `reclaimLiveSeat` statement until `open()`, leaving the rest of
     * the pool alone. The close handler's own statement is NOT parked, so a test
     * can run the whole close while the reclaim is still on its way, which is the
     * order a lock cannot give (the lock queues the close behind the reclaim).
     */
    function parkReclaims() {
      const pool = db.getPool() as unknown as {
        query: (text: unknown, ...rest: unknown[]) => Promise<unknown>;
      };
      const original = pool.query;
      const waiting: Array<() => void> = [];
      let all = false;
      pool.query = function (this: unknown, text: unknown, ...rest: unknown[]) {
        if (typeof text === "string" && text.includes("orphaned_at = NULL, instance_id") && !all) {
          return new Promise<void>((resolve) => waiting.push(resolve)).then(() =>
            original.call(this, text, ...rest),
          );
        }
        return original.call(this, text, ...rest);
      };
      return {
        /** Let the oldest parked reclaim through. */
        next: () => waiting.shift()?.(),
        /** Let everything through, now and later. */
        open: () => {
          all = true;
          while (waiting.length) waiting.shift()?.();
        },
        restore: () => {
          pool.query = original;
        },
      };
    }

    it("a socket whose close was fully handled before the reclaim lands leaves the seat held again", async () => {
      const id = await startSession(world.owner);
      const mine = await join(id, world.member);
      await q(
        `UPDATE app_session_participants SET orphaned_at = NOW(), instance_id = 'the-other-instance'
          WHERE session_id = $1 AND user_id = $2`,
        [id, world.member.id],
      );
      const parked = parkReclaims();
      try {
        await join(id, world.owner);
        await settle(700);
        // The whole close, while the reclaim is parked: the row is still the other
        // machine's, so its orphan statement matches nothing and no mapping is left.
        (mine.socket as unknown as { readyState: number }).readyState = 3;
        await wsApps.handleAppSocketClose(mine.socket);
        expect(wsApps.hasLocalSocketFor(id, world.member.id)).toBe(false);
        parked.open();
        await settle(500);
      } finally {
        parked.open();
        parked.restore();
      }
      const row = await rowOf(id, world.member);
      expect(row.orphaned_at).not.toBeNull();
      expect(wsApps.hasLocalSocketFor(id, world.member.id)).toBe(false);
      // And the sweep owns it like any held seat.
      const held = row.orphaned_at as Date;
      const swept = await wsApps.sweepOwnAppParticipants({ now: new Date(held.getTime() + 91_000) });
      expect(swept.released).toBe(1);
    });

    it("one tab dying during a reclaim does not make the person look disconnected while another tab is open", async () => {
      const id = await startSession(world.owner);
      const steady = await join(id, world.member);
      const dying = await join(id, world.member);
      await q(
        `UPDATE app_session_participants SET orphaned_at = NOW(), instance_id = 'the-other-instance'
          WHERE session_id = $1 AND user_id = $2`,
        [id, world.member.id],
      );
      const parked = parkReclaims();
      const watcher = recordingSocket(modules, world.owner);
      try {
        await wsApps.handleAppFrame(watcher.socket, world.owner, { type: "app-join", sessionId: id });
        await settle(700);
        // The steady tab's reclaim goes through; the dying tab's is next in line.
        parked.next();
        await settle(300);
        (dying.socket as unknown as { readyState: number }).readyState = 3;
        parked.open();
        await settle(700);
      } finally {
        parked.open();
        parked.restore();
      }
      const row = await rowOf(id, world.member);
      // The steady tab is the evidence: the seat is the person's again.
      expect(row.orphaned_at).toBeNull();
      expect(wsApps.hasLocalSocketFor(id, world.member.id)).toBe(true);
      const mineInRoster = snapshot(watcher).participants.find(
        (p: any) => p.userId === world.member.id,
      );
      expect(mineInRoster.connection).toBe("present");
      void steady;
    });

    it("the sweep never touches a row another instance owns", async () => {
      const id = await startSession(world.owner);
      await q(
        `INSERT INTO app_session_participants (session_id, user_id, seat_id, role, instance_id, orphaned_at)
         VALUES ($1, $2, 'seatOtherOtherOtherOther', 'player', 'some-other-instance', NOW() - interval '1 hour'),
                ($1, $3, 'seatTwoTwoTwoTwoTwoTwoTwo', 'player', 'some-other-instance', NULL)`,
        [id, world.member.id, world.moderator.id],
      );
      const swept = await wsApps.sweepOwnAppParticipants({ now: new Date(Date.now() + 10 * 60_000) });
      expect(swept).toEqual({ orphaned: 0, released: 0 });
      const rows = (await q(`SELECT left_at, orphaned_at FROM app_session_participants`)).rows;
      expect(rows.every((row) => row.left_at === null)).toBe(true);
    });

    it("a person who left on another machine is dropped from this one's sockets at the next roster", async () => {
      const id = await startSession(world.owner);
      const rec = await join(id, world.member);
      await q(`UPDATE app_session_participants SET left_at = NOW() WHERE session_id = $1 AND user_id = $2`, [
        id,
        world.member.id,
      ]);
      await join(id, world.owner);
      await settle();
      expect(wsApps.seatOf(id, rec.socket)).toBeUndefined();
    });

    it("a person whose seat another machine's close stamped takes it back while they still have a socket here", async () => {
      const id = await startSession(world.owner);
      const mine = await join(id, world.member);
      // The other machine's tab closed and stamped the row as held.
      await q(
        `UPDATE app_session_participants SET orphaned_at = NOW(), instance_id = 'the-other-instance'
          WHERE session_id = $1 AND user_id = $2`,
        [id, world.member.id],
      );
      await join(id, world.owner);
      await settle();
      const row = await rowOf(id, world.member);
      expect(row.orphaned_at).toBeNull();
      expect(row.instance_id).toBe(bus.INSTANCE_ID);
      void mine;
    });

    it("an end drops the sockets and tells the participants", async () => {
      const id = await startSession(world.owner);
      const rec = await join(id, world.member);
      await sessions.endSessionRow(id, "host", world.owner.id);
      expect(rec.ofType("app-ended")).toHaveLength(1);
      expect(wsApps.seatOf(id, rec.socket)).toBeUndefined();
      // Frames to a session that is over do nothing and cost no write.
      await wsApps.handleAppFrame(rec.socket, world.member, {
        type: "app-state-patch",
        sessionId: id,
        patch: { a: 1 },
      });
      await settle(150);
      expect(
        (await q(`SELECT state_rev FROM app_sessions WHERE id = $1`, [id])).rows[0]!.state_rev,
      ).toBe("0");
    });
  });

  describe("shared state", () => {
    async function pair(manifest?: Parameters<typeof publish>[0]) {
      const app = manifest ? await publish(manifest) : appId;
      const id = await startSession(world.owner, world.channels.general, app);
      const host = await join(id, world.owner);
      const guest = await join(id, world.member);
      await settle(100);
      return { id, host, guest };
    }

    const patch = (rec: Rec, user: DbUser, sessionId: string, body: unknown, baseRev?: number) =>
      wsApps.handleAppFrame(rec.socket, user, {
        type: "app-state-patch",
        sessionId,
        ...(baseRev !== undefined ? { baseRev } : {}),
        patch: body as never,
      });
    const stateRow = async (id: string) =>
      (await q(`SELECT state, state_rev FROM app_sessions WHERE id = $1`, [id])).rows[0]!;

    it("applies a merge patch, bumps the revision and broadcasts the whole value to every participant", async () => {
      const { id, host, guest } = await pair();
      await patch(guest, world.member, id, { a: 1, nested: { x: 1, y: 2 } });
      await settle();
      await patch(host, world.owner, id, { nested: { y: null, z: 3 } });
      await settle();

      const row = await stateRow(id);
      expect(row.state).toEqual({ a: 1, nested: { x: 1, z: 3 } });
      expect(row.state_rev).toBe("2");
      for (const rec of [host, guest]) {
        const frames = rec.ofType("app-state") as any[];
        expect(frames.map((f) => f.rev)).toEqual([1, 2]);
        expect(frames.at(-1).value).toEqual({ a: 1, nested: { x: 1, z: 3 } });
      }
    });

    it("`writers: host` lets only the host write", async () => {
      const { id, host, guest } = await pair({
        id: "host-writes-app",
        players: { max: 3 },
        state: { maxBytes: 64, writers: "host" },
      });
      await patch(guest, world.member, id, { a: 1 });
      await settle();
      expect(errors(guest)).toEqual([expect.objectContaining({ op: "state", code: "not-allowed" })]);
      expect((await stateRow(id)).state_rev).toBe("0");
      await patch(host, world.owner, id, { a: 1 });
      await settle();
      expect((await stateRow(id)).state).toEqual({ a: 1 });
    });

    it("`writers: participants` means the players and the host, not spectators", async () => {
      const id = await startSession(world.owner);
      const watcher = await join(id, world.member, { asSpectator: true });
      await patch(watcher, world.member, id, { a: 1 });
      await settle();
      expect(errors(watcher)[0]).toMatchObject({ op: "state", code: "not-allowed" });
      expect((await stateRow(id)).state_rev).toBe("0");
    });

    it("an unseated socket is answered with nothing, flag on or off, and writes nothing", async () => {
      const id = await startSession(world.owner);
      const stranger = recordingSocket(modules, world.member);
      const answered = () => stranger.frames.filter((f) => f.type !== 'channel-app');
      await patch(stranger, world.member, id, { a: 1 });
      expect(answered()).toEqual([]);
      // The flag off for the server changes nothing about that: still silent.
      await flags.setServerFlagOverride("apps", world.serverId, false, { kind: "dashboard" });
      await patch(stranger, world.member, id, { a: 1 });
      expect(answered()).toEqual([]);
      await settle(150);
      expect((await stateRow(id)).state_rev).toBe("0");
    });

    it("`baseRev` is a compare-and-set: the right revision applies, a stale one is `stale-rev`", async () => {
      const { id, host } = await pair();
      await patch(host, world.owner, id, { a: 1 }, 0);
      await settle(150);
      expect((await stateRow(id)).state_rev).toBe("1");
      await patch(host, world.owner, id, { a: 2 }, 0);
      await settle(150);
      expect(errors(host)).toEqual([expect.objectContaining({ op: "state", code: "stale-rev" })]);
      expect((await stateRow(id)).state).toEqual({ a: 1 });
      await patch(host, world.owner, id, { a: 3 }, 1);
      await settle(150);
      expect((await stateRow(id)).state).toEqual({ a: 3 });
    });

    it("the cap counts the compact bytes of the merged value, not what the client sent", async () => {
      const { id, host } = await pair({ id: "tiny-state-app", state: { maxBytes: 20 } });
      // `{"k":"1234567890"}` is exactly 18 bytes compact; the patch text below is
      // padded with spaces and newlines that never count.
      await wsApps.handleAppFrame(host.socket, world.owner, {
        type: "app-state-patch",
        sessionId: id,
        patch: JSON.parse('{ "k" :\n\n "1234567890"   }'),
      });
      await settle();
      expect((await stateRow(id)).state).toEqual({ k: "1234567890" });
      await patch(host, world.owner, id, { k2: "xyz" });
      await settle();
      expect(errors(host)).toEqual([expect.objectContaining({ op: "state", code: "too-large" })]);
      expect((await stateRow(id)).state).toEqual({ k: "1234567890" });
      expect(metrics.appCountersSnapshot().framesDropped["state-too-large"]).toBe(1);
    });

    it("an app with no state refuses every write", async () => {
      const { id, host } = await pair({ id: "no-state-app", state: { maxBytes: 0 } });
      await patch(host, world.owner, id, { a: 1 });
      await settle();
      expect(errors(host)[0]).toMatchObject({ op: "state", code: "not-allowed" });
    });

    it("refuses a string Postgres cannot store (U+0000) and keeps a `__proto__` key as plain data", async () => {
      const { id, host } = await pair();
      await patch(host, world.owner, id, { bad: "a\u0000b" });
      await settle();
      expect(errors(host)[0]).toMatchObject({ code: "not-allowed" });
      expect((await stateRow(id)).state_rev).toBe("0");
      await patch(host, world.owner, id, JSON.parse('{"__proto__": {"polluted": 1}}'));
      await settle();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(JSON.stringify((await stateRow(id)).state)).toBe('{"__proto__":{"polluted":1}}');
    });

    it("a patch that changes nothing writes nothing", async () => {
      const { id, host } = await pair();
      await patch(host, world.owner, id, { a: 1 });
      await settle(250);
      await patch(host, world.owner, id, { a: 1 });
      await settle(250);
      expect((await stateRow(id)).state_rev).toBe("1");
    });
  });

  describe("events", () => {
    async function trio() {
      const id = await startSession(world.owner);
      const a = await join(id, world.owner);
      const b = await join(id, world.member);
      const c = await join(id, world.moderator);
      await settle(100);
      const seat = snapshot(a).seatId as string;
      for (const rec of [a, b, c]) {
        rec.frames.length = 0;
      }
      return { id, a, b, c, seat };
    }
    const send = (rec: Rec, user: DbUser, sessionId: string, name: string, data: unknown) =>
      wsApps.handleAppFrame(rec.socket, user, {
        type: "app-event-send",
        sessionId,
        name,
        data: data as never,
      });

    it("relays to the other seats, with the sender's seat id and no echo, and stores nothing", async () => {
      const { id, a, b, c, seat } = await trio();
      await send(a, world.owner, id, "move.left", { x: 1 });
      await settle(100);
      for (const rec of [b, c]) {
        expect(rec.ofType("app-event")).toEqual([
          { type: "app-event", sessionId: id, fromSeatId: seat, name: "move.left", data: { x: 1 } },
        ]);
      }
      expect(a.ofType("app-event")).toEqual([]);
      expect(metrics.appCountersSnapshot().events).toBe(1);
      // Nothing about the event is in any table.
      const rows = await q(`SELECT state, summary FROM app_sessions WHERE id = $1`, [id]);
      expect(JSON.stringify(rows.rows)).not.toContain("move.left");
    });

    it("is capped per participant per second (3): the rest are dropped and counted, and the sender told once", async () => {
      const { id, a, b } = await trio();
      for (let i = 0; i < 10; i += 1) {
        await send(a, world.owner, id, "tick", { i });
      }
      await settle(100);
      expect(b.ofType("app-event")).toHaveLength(3);
      expect(metrics.appCountersSnapshot().framesDropped["event-rate"]).toBe(7);
      expect(errors(a).filter((e) => e.code === "rate-limited")).toHaveLength(1);
      // Another seat has a bucket of its own.
      await send(b, world.member, id, "tick", {});
      await settle(100);
      expect(a.ofType("app-event")).toHaveLength(1);
    });

    it("refuses a payload over the manifest's size, and a spectator, and an unseated socket", async () => {
      const { id, a, b } = await trio();
      await send(a, world.owner, id, "big", { blob: "x".repeat(60) });
      expect(errors(a)).toEqual([expect.objectContaining({ op: "event", code: "too-large" })]);
      expect(b.ofType("app-event")).toEqual([]);

      const watcher = await join(id, world.manager, { asSpectator: true });
      await send(watcher, world.manager, id, "hi", {});
      expect(errors(watcher)[0]).toMatchObject({ op: "event", code: "not-allowed" });

      const outsider = recordingSocket(modules, world.insider);
      await send(outsider, world.insider, id, "hi", {});
      expect(outsider.frames).toEqual([]);
      expect(metrics.appCountersSnapshot().framesDropped["event-unseated"]).toBe(1);
    });

    it("an app that declares no events takes none", async () => {
      const quiet = await publish({ id: "quiet-app", events: { maxPerSecond: 0, maxBytes: 0 } });
      const id = await startSession(world.owner, world.channels.general, quiet);
      const rec = await join(id, world.owner);
      await send(rec, world.owner, id, "x", {});
      expect(errors(rec)[0]).toMatchObject({ op: "event", code: "not-allowed" });
    });
  });

  describe("through the chat socket's own dispatch", () => {
    it("`handleChatMessage` routes the frames, and drops one with an unknown key", async () => {
      const id = await startSession(world.owner);
      const rec = recordingSocket(modules, world.member);
      await chat.handleChatMessage({ socket: rec.socket, user: world.member }, {
        type: "app-join",
        sessionId: id,
        smuggled: "key",
      });
      expect(rec.frames).toEqual([]);
      await chat.handleChatMessage({ socket: rec.socket, user: world.member }, {
        type: "app-join",
        sessionId: id,
      });
      expect(rec.ofType("app-session")).toHaveLength(1);
      await chat.handleChatMessage({ socket: rec.socket, user: world.member }, {
        type: "app-leave",
        sessionId: id,
      });
      expect((await rowOf(id, world.member)).left_at).not.toBeNull();
    });
  });
});

type DbUser = World["owner"];
void (undefined as unknown as AppManifest);

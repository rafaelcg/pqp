import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Permission } from "@pqp/shared";
import type { DbUser } from "../db.js";
import type { World } from "./testing-world.js";

/**
 * THE SWEEPS OF A LIVE SESSION, against a real Postgres, with the real runtime
 * flag snapshot and the real LISTEN/NOTIFY bus (production runs
 * `CLUSTER_BUS=postgres` and `VOICE_REGISTRY=postgres`: pitfall 12). Time is a
 * fake clock: every sweep is handed the `now` it should judge by, so the two
 * minutes, the five minutes and the twelve hours are exact and nothing sleeps.
 * Scratch database only (`TEST_DATABASE_URL`).
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
const sessions = await import("./sessions.js");
const sweeps = await import("./sweeps.js");
const host = await import("./host.js");
const metrics = await import("./metrics.js");
const summary = await import("./summary.js");
const registry = await import("../voice/registry.js");
const retention = await import("../services/retention.js");
const participants = await import("./participants.js");
const { buildWorld, publishTestApp, recordingSocket } = await import("./testing-world.js");

const modules = { db, users, servers, roles, flags, catalog, sockets };
const q = <T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
) => db.getPool().query<T>(text, values);

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
const SECOND = 1000;
const MINUTE = 60 * SECOND;

type Rec = ReturnType<typeof recordingSocket>;

const DEAD = randomUUID();
const LIVE = randomUUID();
const OTHER = randomUUID();
const EARLIER = randomUUID();

describeDb("the sweeps of a live app session", () => {
  let transport: ReturnType<typeof createPostgresBusTransport>;
  let world: World;
  let appId: string;
  let t0: number;

  const at = (ms: number) => new Date(t0 + ms);
  const sweep = (ms: number) => sweeps.runAppSweep({ now: at(ms) });

  async function start(
    hostUser = world.owner,
    channelId = world.channels.general,
    id = appId,
  ): Promise<string> {
    sessions.resetAppSessionLimitsForTests();
    return (await sessions.startAppSession(hostUser, channelId, id)).id;
  }

  async function join(sessionId: string, user: DbUser, asSpectator = false): Promise<Rec> {
    const rec = recordingSocket(modules, user);
    await wsApps.handleAppFrame(rec.socket, user, {
      type: "app-join",
      sessionId,
      ...(asSpectator ? { asSpectator } : {}),
    });
    return rec;
  }

  const row = async (id: string) =>
    (await q(`SELECT * FROM app_sessions WHERE id = $1`, [id])).rows[0]!;
  const seat = async (id: string, user: DbUser) =>
    (
      await q(`SELECT * FROM app_session_participants WHERE session_id = $1 AND user_id = $2`, [
        id,
        user.id,
      ])
    ).rows[0];

  beforeAll(async () => {
    await db.initDb();
    transport = createPostgresBusTransport(DATABASE_URL!);
    bus.setBusTransport(transport);
    await transport.whenConnected();
  }, 30_000);

  beforeEach(async () => {
    await q(`TRUNCATE app_admin_audit, app_sessions, app_session_participants, server_apps,
                      app_versions, apps, feature_flags, feature_flag_overrides, messages,
                      member_timeouts, voice_instances RESTART IDENTITY CASCADE`);
    await q(
      `INSERT INTO app_publishers (id, display_name, kind)
       VALUES ('pqp', 'pqp', 'first_party') ON CONFLICT (id) DO NOTHING`,
    );
    flags.resetFeatureFlagsForTests();
    await flags.startFeatureFlags();
    metrics.resetAppCountersForTests();
    sessions.resetAppSessionLimitsForTests();
    wsApps.resetAppsWsForTests();
    sweeps.resetAppSweepStateForTests();
    registry.resetOwnHeartbeatStateForTests();
    process.env.APPS_ORIGIN = "https://apps.example.test";
    process.env.VOICE_REGISTRY = "postgres";
    world = await buildWorld(modules);
    appId = await publishTestApp(modules, world.serverId, {
      players: { max: 4, spectators: true },
    });
    await flags.setServerFlagOverride("apps", world.serverId, true, { kind: "dashboard" });
    t0 = Date.now();
  });

  afterAll(async () => {
    flags.resetFeatureFlagsForTests();
    await transport.close().catch(() => {});
    await db.closePool();
  });

  describe("the platform and the app", () => {
    it("ends with flag-off when the apps flag is off for the server, and only that server's", async () => {
      const id = await start(world.owner);
      await flags.setServerFlagOverride("apps", world.serverId, false, { kind: "dashboard" });
      const result = await sweep(0);
      expect(result.ended).toEqual({ "flag-off": 1 });
      expect(await row(id)).toMatchObject({ status: "ended", end_reason: "flag-off", ended_by: null });
    });

    it.each([
      ["retired", `UPDATE apps SET status = 'retired' WHERE id = $1`],
      ["switched off for everyone", `UPDATE apps SET global_enabled = FALSE WHERE id = $1`],
      ["no longer released to the server", `UPDATE server_apps SET operator_enabled = FALSE WHERE app_id = $1`],
      ["switched off by the owner", `UPDATE server_apps SET owner_enabled = FALSE WHERE app_id = $1`],
    ])("ends with app-disabled when the app is %s", async (_label, statement) => {
      const id = await start(world.owner);
      await join(id, world.member);
      await q(statement, [appId]);
      const result = await sweep(0);
      expect(result.ended).toEqual({ "app-disabled": 1 });
      expect(await row(id)).toMatchObject({ status: "ended", end_reason: "app-disabled" });
    });

    it("ends with app-disabled when the server became a public community the app is not unlocked for", async () => {
      const id = await start(world.owner);
      await q(`UPDATE servers SET is_community = TRUE WHERE id = $1`, [world.serverId]);
      expect((await sweep(0)).ended).toEqual({ "app-disabled": 1 });
      expect((await row(id)).end_reason).toBe("app-disabled");
    });

    it("does NOT end a session because this process has no apps origin (a worker without APPS_ORIGIN)", async () => {
      const id = await start(world.owner);
      delete process.env.APPS_ORIGIN;
      expect((await sweep(0)).ended).toEqual({});
      expect((await row(id)).status).toBe("live");
    });

    it("leaves another app's session alone", async () => {
      const other = await publishTestApp(modules, world.serverId, { id: "other-app" });
      const a = await start(world.owner, world.channels.general);
      const b = await start(world.owner, world.channels.lobby, other);
      await q(`UPDATE apps SET global_enabled = FALSE WHERE id = $1`, [other]);
      expect((await sweep(0)).ended).toEqual({ "app-disabled": 1 });
      expect((await row(a)).status).toBe("live");
      expect((await row(b)).status).toBe("ended");
    });

    it("ends at twelve hours, not before", async () => {
      const id = await start(world.owner);
      await join(id, world.owner);
      await q(`UPDATE app_sessions SET started_at = $2 WHERE id = $1`, [id, at(0)]);
      expect((await sweep(12 * 60 * MINUTE - SECOND)).ended).toEqual({});
      expect((await sweep(12 * 60 * MINUTE)).ended).toEqual({ "max-duration": 1 });
      expect((await row(id)).end_reason).toBe("max-duration");
    });

    it("tells the viewers and the participants when it ends a session, like any other end", async () => {
      const id = await start(world.owner);
      const seated = await join(id, world.owner);
      const viewer = recordingSocket(modules, world.moderator);
      await q(`UPDATE app_sessions SET started_at = $2 WHERE id = $1`, [id, at(-13 * 60 * MINUTE)]);
      await sweep(0);
      await settle();
      expect(seated.ofType("app-ended")).toEqual([
        expect.objectContaining({ sessionId: id, reason: "max-duration" }),
      ]);
      expect((viewer.ofType("channel-app").at(-1) as unknown as { session: unknown }).session).toBeNull();
    });
  });

  describe("the host", () => {
    /** The host plus three people in order: a first who may not host here, a second who may, a spectator. */
    async function room(channelId = world.channels.restricted) {
      const id = await start(world.owner, channelId);
      const hostRec = await join(id, world.owner);
      const blocked = await join(id, world.noApps);
      await settle(15);
      const next = await join(id, world.member);
      await settle(15);
      return { id, hostRec, blocked, next };
    }

    it("a present host starts no countdown", async () => {
      const { id } = await room();
      const result = await sweep(0);
      expect(result.hostGoneStamped).toBe(0);
      expect((await row(id)).host_gone_at).toBeNull();
    });

    it("a host with no present seat starts the countdown, and the summary says who is next and when", async () => {
      const { id, hostRec } = await room();
      const viewer = recordingSocket(modules, world.moderator);
      await wsApps.handleAppSocketClose(hostRec.socket);
      const result = await sweep(0);
      expect(result.hostGoneStamped).toBe(1);
      expect((await row(id)).host_gone_at).toEqual(at(0));
      await settle();
      const frame = viewer.ofType("channel-app").at(-1) as unknown as {
        session: { hostUserId: string; handoff: { toUserId: string; at: string } };
      };
      // The longest seated person who could have started it: the second, not the first.
      expect(frame.session.handoff).toEqual({
        toUserId: world.member.id,
        at: at(2 * MINUTE).toISOString(),
      });
      expect(frame.session.hostUserId).toBe(world.owner.id);
      // A second sweep inside the window changes nothing.
      expect((await sweep(30 * SECOND)).hostGoneStamped).toBe(0);
      expect((await row(id)).host_gone_at).toEqual(at(0));
    });

    it("hands the role to the longest seated person WITH the permission, after two minutes and not before", async () => {
      const { id, hostRec, next } = await room();
      await wsApps.handleAppSocketClose(hostRec.socket);
      await sweep(0);
      next.frames.length = 0;

      expect((await sweep(2 * MINUTE - SECOND)).handoffs).toBe(0);
      expect((await row(id)).host_user_id).toBe(world.owner.id);

      const result = await sweep(2 * MINUTE);
      expect(result.handoffs).toBe(1);
      expect(await row(id)).toMatchObject({ host_user_id: world.member.id, host_gone_at: null });
      await settle();
      // The new host's snapshot says so, and the strip's countdown is gone.
      const snapshot = next.ofType("app-session").at(-1) as unknown as { isHost: boolean };
      expect(snapshot.isHost).toBe(true);
      const live = await summary.readLiveSummary(world.channels.restricted);
      expect(live!.hostUserId).toBe(world.member.id);
      expect(live!.handoff).toBeNull();
      expect(metrics.appCountersSnapshot().handoffs).toEqual({ sweep: 1 });
    });

    it("the old host coming back before the two minutes ends the countdown", async () => {
      const { id, hostRec } = await room();
      await wsApps.handleAppSocketClose(hostRec.socket);
      await sweep(0);
      expect((await row(id)).host_gone_at).not.toBeNull();
      await join(id, world.owner);
      expect((await row(id)).host_gone_at).toBeNull();
      expect((await sweep(3 * MINUTE)).handoffs).toBe(0);
      expect((await row(id)).host_user_id).toBe(world.owner.id);
    });

    it("a handoff judged on an old countdown cannot move the role during a newer one, nor to a seat that is gone", async () => {
      const { id, hostRec } = await room();
      await wsApps.handleAppSocketClose(hostRec.socket);
      await sweep(0);
      const old = (await row(id)).host_gone_at as Date;
      // The host came back and left again: a new countdown with its own two minutes.
      await q(`UPDATE app_sessions SET host_gone_at = $2 WHERE id = $1`, [id, at(90 * SECOND)]);
      expect(await host.completeHandoff(id, world.owner.id, world.member.id, "sweep", old)).toBe(false);
      expect((await row(id)).host_user_id).toBe(world.owner.id);

      // The chosen person left between choosing and moving.
      await q(`UPDATE app_session_participants SET left_at = NOW() WHERE session_id = $1 AND user_id = $2`, [
        id,
        world.member.id,
      ]);
      expect(
        await host.completeHandoff(id, world.owner.id, world.member.id, "sweep", at(90 * SECOND)),
      ).toBe(false);
      expect((await row(id)).host_user_id).toBe(world.owner.id);

      // Control: the same call with the current countdown and a present seat moves it.
      await q(`UPDATE app_session_participants SET left_at = NULL WHERE session_id = $1 AND user_id = $2`, [
        id,
        world.member.id,
      ]);
      expect(
        await host.completeHandoff(id, world.owner.id, world.member.id, "sweep", at(90 * SECOND)),
      ).toBe(true);
      expect((await row(id)).host_user_id).toBe(world.member.id);
    });

    it("clears a countdown whose host is present again even if no join cleared it", async () => {
      const { id } = await room();
      await q(`UPDATE app_sessions SET host_gone_at = $2 WHERE id = $1`, [id, at(0)]);
      await sweep(1 * MINUTE);
      expect((await row(id)).host_gone_at).toBeNull();
    });

    it("the countdown follows who is next: a held seat does not count, and the name changes", async () => {
      const { id, hostRec, next } = await room();
      await wsApps.handleAppSocketClose(hostRec.socket);
      await sweep(0);
      expect(await (await import("./next-host.js")).pickNextHost(id)).toBe(world.member.id);
      await wsApps.handleAppSocketClose(next.socket);
      expect(await (await import("./next-host.js")).pickNextHost(id)).toBeNull();
    });

    it("in a voice channel the next host must be able to CONNECT, even holding VIEW and USE_APPS", async () => {
      const id = await start(world.owner, world.channels.lobby);
      const hostRec = await join(id, world.owner);
      const first = await join(id, world.member);
      await settle(15);
      await join(id, world.moderator);
      await roles.upsertChannelOverwrite(
        world.channels.lobby,
        world.serverId,
        "member",
        world.member.id,
        0n,
        Permission.CONNECT,
      );
      await wsApps.handleAppSocketClose(hostRec.socket);
      await sweep(0);
      const { pickNextHost } = await import("./next-host.js");
      // The longest seated cannot connect any more: the next one is chosen.
      expect(await pickNextHost(id)).toBe(world.moderator.id);
      void first;
    });

    it("the delete of a channel is stopped when its session cannot be ended", async () => {
      const channel = await servers.createChannel(world.serverId, "to-keep", "text");
      const id = await start(world.owner, channel.id);
      // The end cannot be written: a constraint that refuses this reason.
      await q(`ALTER TABLE app_sessions ADD CONSTRAINT apps_test_no_channel_gone
                 CHECK (end_reason IS DISTINCT FROM 'channel-gone') NOT VALID`);
      try {
        await expect(sweeps.endSessionsOfChannel(channel.id)).rejects.toThrow();
      } finally {
        await q(`ALTER TABLE app_sessions DROP CONSTRAINT apps_test_no_channel_gone`);
      }
      expect((await row(id)).status).toBe("live");
    });

    it("an app that is hostBound ends with host-gone after the same two minutes, and shows no handoff", async () => {
      const bound = await publishTestApp(modules, world.serverId, {
        id: "bound-app",
        hostBound: true,
      });
      const id = await start(world.owner, world.channels.general, bound);
      const hostRec = await join(id, world.owner);
      await join(id, world.member);
      await wsApps.handleAppSocketClose(hostRec.socket);
      await sweep(0);
      const live = await summary.readLiveSummary(world.channels.general);
      expect(live!.handoff).toBeNull();
      expect((await sweep(2 * MINUTE - SECOND)).ended).toEqual({});
      expect((await sweep(2 * MINUTE)).ended).toEqual({ "host-gone": 1 });
      expect((await row(id)).end_reason).toBe("host-gone");
    });

    it("ends with host-gone when people are still seated and none of them could host", async () => {
      const id = await start(world.owner, world.channels.restricted);
      const hostRec = await join(id, world.owner);
      await join(id, world.noApps);
      await wsApps.handleAppSocketClose(hostRec.socket);
      await sweep(0);
      expect((await sweep(2 * MINUTE)).ended).toEqual({ "host-gone": 1 });
    });

    it("a session nobody is in is left to the empty sweep: not ended at two minutes, ended at five", async () => {
      const id = await start(world.owner);
      await q(`UPDATE app_sessions SET started_at = $2 WHERE id = $1`, [id, at(0)]);
      await sweep(0);
      expect((await sweep(2 * MINUTE)).ended).toEqual({});
      expect((await sweep(5 * MINUTE - SECOND)).ended).toEqual({});
      expect((await sweep(5 * MINUTE)).ended).toEqual({ empty: 1 });
      expect((await row(id)).end_reason).toBe("empty");
    });

    it("the empty clock restarts when the last seat is released, and a join stops it", async () => {
      const id = await start(world.owner);
      const rec = await join(id, world.member);
      await wsApps.handleAppFrame(rec.socket, world.member, { type: "app-leave", sessionId: id });
      const stamped = (await row(id)).empty_since as Date;
      expect(stamped).toBeInstanceOf(Date);
      // Five minutes after the real release, not after the start.
      expect((await sweeps.runAppSweep({ now: new Date(stamped.getTime() + 5 * MINUTE - SECOND) })).ended).toEqual({});
      await join(id, world.member);
      expect((await row(id)).empty_since).toBeNull();
      expect(
        (await sweeps.runAppSweep({ now: new Date(stamped.getTime() + 30 * MINUTE) })).ended,
      ).toEqual({});
    });
  });

  describe("take-host: Assumir agora", () => {
    async function counting() {
      const id = await start(world.owner, world.channels.restricted);
      const hostRec = await join(id, world.owner);
      await join(id, world.noApps);
      await settle(15);
      await join(id, world.member);
      await wsApps.handleAppSocketClose(hostRec.socket);
      await sweep(0);
      return id;
    }

    it("only the chosen next host may take it, at once", async () => {
      const id = await counting();
      await expect(host.takeHostAs(world.noApps, id)).rejects.toMatchObject({
        status: 403,
        message: "not_next_host",
      });
      await expect(host.takeHostAs(world.stranger, id)).rejects.toMatchObject({ status: 404 });
      expect(await host.takeHostAs(world.member, id)).toEqual({ host: true });
      expect(await row(id)).toMatchObject({ host_user_id: world.member.id, host_gone_at: null });
      expect(metrics.appCountersSnapshot().handoffs).toEqual({ take: 1 });
      // The sweep that follows has nothing left to hand over.
      expect((await sweep(3 * MINUTE)).handoffs).toBe(0);
    });

    it("is refused while the host is present, for a hostBound app, and with the flag off", async () => {
      const present = await start(world.owner, world.channels.general);
      await join(present, world.owner);
      await join(present, world.member);
      await expect(host.takeHostAs(world.member, present)).rejects.toMatchObject({
        status: 409,
        message: "host_present",
      });

      const bound = await publishTestApp(modules, world.serverId, { id: "bound-app", hostBound: true });
      const hb = await start(world.owner, world.channels.lobby, bound);
      const hostRec = await join(hb, world.owner);
      await join(hb, world.member);
      await wsApps.handleAppSocketClose(hostRec.socket);
      await sweep(0);
      await expect(host.takeHostAs(world.member, hb)).rejects.toMatchObject({
        status: 409,
        message: "host_bound",
      });

      const id = await counting();
      await flags.setServerFlagOverride("apps", world.serverId, false, { kind: "dashboard" });
      await expect(host.takeHostAs(world.member, id)).rejects.toMatchObject({ status: 404 });
    });

    it("two takers and the sweep at once: one winner", async () => {
      const id = await counting();
      const results = await Promise.allSettled([
        host.takeHostAs(world.member, id),
        host.takeHostAs(world.member, id),
        sweep(3 * MINUTE),
      ]);
      expect(results.filter((r) => r.status === "fulfilled" && "host" in (r.value as object))).toHaveLength(1);
      expect((await row(id)).host_user_id).toBe(world.member.id);
      expect(
        Object.values(metrics.appCountersSnapshot().handoffs).reduce((a, b) => a + b, 0),
      ).toBe(1);
    });
  });

  describe("seats lost", () => {
    it("releases a participant who left the server, and drops their socket from the roster", async () => {
      const id = await start(world.owner);
      const keep = await join(id, world.owner);
      const kicked = await join(id, world.member);
      await q(`DELETE FROM server_members WHERE server_id = $1 AND user_id = $2`, [
        world.serverId,
        world.member.id,
      ]);
      users.invalidateChannelAccessForServer();
      const result = await sweep(0);
      expect(result.participantsRemoved).toBe(1);
      expect((await seat(id, world.member)).left_at).not.toBeNull();
      expect((await seat(id, world.owner)).left_at).toBeNull();
      await settle(500);
      expect(wsApps.seatOf(id, kicked.socket)).toBeUndefined();
      expect(wsApps.seatOf(id, keep.socket)).toBeDefined();
      expect(metrics.appCountersSnapshot().participantsRemoved).toBe(1);
    });

    it("releases somebody who can no longer view a private channel", async () => {
      const id = await start(world.insider, world.channels.secret);
      await join(id, world.insider);
      await q(
        `DELETE FROM channel_overwrites WHERE channel_id = $1 AND target_type = 'member' AND target_id = $2`,
        [world.channels.secret, world.insider.id],
      );
      users.invalidateChannelAccessForServer();
      await sweep(0);
      expect((await seat(id, world.insider)).left_at).not.toBeNull();
    });

    it("in a voice channel, releases somebody who lost CONNECT, and leaves the others", async () => {
      const id = await start(world.owner, world.channels.lobby);
      await join(id, world.owner);
      await join(id, world.noApps);
      await roles.upsertChannelOverwrite(
        world.channels.lobby,
        world.serverId,
        "member",
        world.noApps.id,
        0n,
        Permission.CONNECT,
      );
      await sweep(0);
      expect((await seat(id, world.noApps)).left_at).not.toBeNull();
      expect((await seat(id, world.owner)).left_at).toBeNull();
    });
  });

  describe("the seats of an instance that is gone (pitfall 18)", () => {
    async function heartbeat(instanceId: string, agoMs: number) {
      await q(
        `INSERT INTO voice_instances (instance_id, config_hash, heartbeat_at, snapshot)
         VALUES ($1, 'h', $2, '{}'::jsonb)
         ON CONFLICT (instance_id) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`,
        [instanceId, new Date(t0 - agoMs)],
      );
    }
    async function seatOwnedBy(id: string, user: DbUser, instanceId: string, seatId: string) {
      await q(
        `INSERT INTO app_session_participants (session_id, user_id, seat_id, role, instance_id)
         VALUES ($1, $2, $3, 'player', $4)`,
        [id, user.id, seatId, instanceId],
      );
    }

    it("holds them for 90 s, then releases them, and never touches a live instance's or its own", async () => {
      const id = await start(world.owner);
      await heartbeat(DEAD, 10 * MINUTE);
      // The live instance keeps beating while the fake clock runs ahead.
      await heartbeat(LIVE, -10 * MINUTE);
      await seatOwnedBy(id, world.member, DEAD, "deadDeadDeadDeadDeadDead");
      await seatOwnedBy(id, world.moderator, LIVE, "liveLiveLiveLiveLiveLive");
      await seatOwnedBy(id, world.manager, bus.INSTANCE_ID, "ownOwnOwnOwnOwnOwnOwnOwn");

      const first = await sweep(0);
      expect(first).toMatchObject({ deadSeatsHeld: 1, deadSeatsReleased: 0 });
      expect((await seat(id, world.member)).orphaned_at).toEqual(at(0));
      expect((await seat(id, world.member)).left_at).toBeNull();
      expect((await seat(id, world.moderator)).orphaned_at).toBeNull();
      expect((await seat(id, world.manager)).orphaned_at).toBeNull();

      expect((await sweep(89 * SECOND)).deadSeatsReleased).toBe(0);
      expect((await sweep(91 * SECOND)).deadSeatsReleased).toBe(1);
      expect((await seat(id, world.member)).left_at).not.toBeNull();
      expect((await seat(id, world.moderator)).left_at).toBeNull();
      expect(metrics.appCountersSnapshot().deadInstanceSeats).toEqual({ orphaned: 1, released: 1 });
    });

    it("a person who comes back inside the hold keeps the seat", async () => {
      const id = await start(world.owner);
      await heartbeat(DEAD, 10 * MINUTE);
      await seatOwnedBy(id, world.member, DEAD, "deadDeadDeadDeadDeadDead");
      await sweep(0);
      const back = await join(id, world.member);
      expect((back.ofType("app-session").at(-1) as unknown as { seatId: string }).seatId).toBe(
        "deadDeadDeadDeadDeadDead",
      );
      expect((await sweep(95 * SECOND)).deadSeatsReleased).toBe(0);
      expect((await seat(id, world.member)).instance_id).toBe(bus.INSTANCE_ID);
    });

    it("does not judge a sibling while this process cannot trust other leases", async () => {
      const id = await start(world.owner);
      await heartbeat(DEAD, 10 * MINUTE);
      await seatOwnedBy(id, world.member, DEAD, "deadDeadDeadDeadDeadDead");

      // Our own heartbeat failed and has just come back: other leases are stale because of us.
      registry.noteOwnHeartbeatForTests(false, t0 - 10 * SECOND);
      registry.noteOwnHeartbeatForTests(true, t0 - 5 * SECOND);
      expect((await sweep(0)).deadSeatsHeld).toBe(0);
      expect((await seat(id, world.member)).orphaned_at).toBeNull();
      // A full lease TTL after the recovery it may.
      expect((await sweeps.runAppSweep({ now: new Date(Date.now() + registry.INSTANCE_TTL_MS + 6000) })).deadSeatsHeld).toBe(1);
    });

    it("does not judge a sibling for a TTL after this process's own sweep failed", async () => {
      const id = await start(world.owner);
      await heartbeat(DEAD, 10 * MINUTE);
      await seatOwnedBy(id, world.member, DEAD, "deadDeadDeadDeadDeadDead");
      sweeps.noteAppSweepFailureForTests(Date.now());
      expect((await sweep(0)).deadSeatsHeld).toBe(0);
      expect(
        (await sweeps.runAppSweep({ now: new Date(Date.now() + registry.INSTANCE_TTL_MS + 5000) })).deadSeatsHeld,
      ).toBe(1);
    });

    it("does nothing without a cluster topology: with no heartbeats there is nobody to call dead", async () => {
      const id = await start(world.owner);
      await seatOwnedBy(id, world.member, OTHER, "otherOtherOtherOtherOth");
      delete process.env.VOICE_REGISTRY;
      delete process.env.CLUSTER_BUS;
      try {
        expect((await sweep(0)).deadSeatsHeld).toBe(0);
        expect((await seat(id, world.member)).orphaned_at).toBeNull();
      } finally {
        process.env.CLUSTER_BUS = "postgres";
      }
    });

    it("a single process adopts the seats of its earlier run at boot, held and then released by its own sweep", async () => {
      const id = await start(world.owner);
      await seatOwnedBy(id, world.member, EARLIER, "earlierEarlierEarlierEa");
      expect(await participants.adoptPreviousRunSeats(bus.INSTANCE_ID)).toBe(1);
      const adopted = await seat(id, world.member);
      expect(adopted.instance_id).toBe(bus.INSTANCE_ID);
      expect(adopted.orphaned_at).not.toBeNull();
      const swept = await wsApps.sweepOwnAppParticipants({
        now: new Date((adopted.orphaned_at as Date).getTime() + 91 * SECOND),
      });
      expect(swept.released).toBe(1);
    });
  });

  describe("a deleted channel", () => {
    it("ends its session first, while there is still somebody to tell, and the cascade then takes the row", async () => {
      const channel = await servers.createChannel(world.serverId, "to-delete", "text");
      const id = await start(world.owner, channel.id);
      const seated = await join(id, world.member);
      const viewer = recordingSocket(modules, world.moderator);
      viewer.frames.length = 0;

      expect(await sweeps.endSessionsOfChannel(channel.id)).toBe(1);
      await settle();
      expect(seated.ofType("app-ended")).toEqual([
        expect.objectContaining({ reason: "channel-gone" }),
      ]);
      expect((viewer.ofType("channel-app").at(-1) as unknown as { session: unknown }).session).toBeNull();
      expect(await servers.deleteChannel(channel.id)).toBe(true);
      expect((await q(`SELECT 1 FROM app_sessions WHERE id = $1`, [id])).rowCount).toBe(0);
    });

    it("has nothing to do for a channel without a session", async () => {
      expect(await sweeps.endSessionsOfChannel(world.channels.general)).toBe(0);
    });
  });

  describe("retention", () => {
    it("deletes ended sessions past 30 days in batches, with their seats, and keeps the timeline message", async () => {
      const keepId = await start(world.owner, world.channels.general);
      await join(keepId, world.member);
      const old = await start(world.owner, world.channels.lobby);
      await join(old, world.member);
      await sessions.endSessionRow(old, "host", world.owner.id);
      const message = (await row(old)).timeline_message_id as string;
      await q(`UPDATE app_sessions SET ended_at = NOW() - interval '31 days' WHERE id = $1`, [old]);
      // A recent ended one, and a pile of old ones to need more than one batch.
      const recent = await start(world.owner, world.channels.restricted);
      await sessions.endSessionRow(recent, "host", world.owner.id);
      await q(
        `INSERT INTO app_sessions (server_id, channel_id, app_id, app_version, status, ended_at, end_reason)
         SELECT $1, $2, $3, '1.0.0', 'ended', NOW() - interval '40 days', 'host'
           FROM generate_series(1, 1100)`,
        [world.serverId, world.channels.general, appId],
      );

      expect(await retention.sweepAppSessionRetention()).toBe(1101);
      expect((await q(`SELECT id FROM app_sessions ORDER BY started_at`)).rows.map((r) => r.id).sort()).toEqual(
        [keepId, recent].sort(),
      );
      expect(
        (await q(`SELECT 1 FROM app_session_participants WHERE session_id = $1`, [old])).rowCount,
      ).toBe(0);
      // The card stays, generic, in the timeline.
      expect((await q(`SELECT 1 FROM messages WHERE id = $1`, [message])).rowCount).toBe(1);
      expect(await retention.sweepAppSessionRetention()).toBe(0);
    });

    it("never deletes a live session, however old", async () => {
      const id = await start(world.owner);
      await q(`UPDATE app_sessions SET started_at = NOW() - interval '90 days' WHERE id = $1`, [id]);
      expect(await retention.sweepAppSessionRetention()).toBe(0);
      expect((await row(id)).status).toBe("live");
    });
  });

  describe("metrics", () => {
    it("reports live sessions and seats from the table, and the counters of this process", async () => {
      const a = await start(world.owner, world.channels.general);
      const b = await start(world.owner, world.channels.lobby);
      await join(a, world.owner);
      await join(a, world.member);
      await join(b, world.moderator);
      const block = await metrics.appsMetrics();
      expect(block.live).toEqual({ sessions: 2, seats: 3, byApp: { "pqp-eco": 2 } });
      expect(block.counters).toMatchObject({ starts: 2, joins: 3 });
      await sessions.endSessionRow(a, "host", world.owner.id);
      const after = await metrics.appsMetrics();
      expect(after.live).toEqual({ sessions: 1, seats: 1, byApp: { "pqp-eco": 1 } });
      expect(after.counters.ends).toEqual({ host: 1 });
    });
  });

  describe("the job", () => {
    it("is one process per tick under a lease, and a tick that fails is counted, not thrown", async () => {
      await q(`DELETE FROM singleton_leases WHERE key = 'apps.sweep'`);
      const first = await sweeps.runAppSweepJob({ now: at(0) });
      const second = await sweeps.runAppSweepJob({ now: at(0) });
      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(metrics.appCountersSnapshot().sweepRuns).toBe(1);
    });
  });
});

import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { appSessionSummarySchema, channelAppSchema, appEndedSchema } from "@pqp/shared";

/**
 * Starting and ending an app session, against a real Postgres, with the real
 * runtime flag snapshot and the real LISTEN/NOTIFY bus installed (production
 * runs `CLUSTER_BUS=postgres` and `VOICE_REGISTRY=postgres`: pitfall 12), the
 * HTTP routes reached through the real router, and frames read off recording
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
const metrics = await import("./metrics.js");
const { createRouter } = await import("../lib/router.js");
const { registerAppRoutes } = await import("../api/app-routes.js");
const { Created, HttpErrorWithDetail } = await import("../lib/route-results.js");
const { buildWorld, publishTestApp, recordingSocket } = await import("./testing-world.js");
import type { World } from "./testing-world.js";

const modules = { db, users, servers, roles, flags, catalog, sockets };
const q = <T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
) => db.getPool().query<T>(text, values);

describeDb("app sessions: start and end", () => {
  const router = createRouter();
  registerAppRoutes(router);
  let transport: ReturnType<typeof createPostgresBusTransport>;
  let world: World;
  let appId: string;

  /** Call a route as `user`, the way `handleApi` does, and give back what it answered. */
  async function call(
    user: World["owner"],
    method: "GET" | "POST",
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
      if (result instanceof Created) {
        return { status: 201, body: JSON.parse(JSON.stringify(result.body)) };
      }
      return { status: 200, body: JSON.parse(JSON.stringify(result)) };
    } catch (error) {
      if (error instanceof HttpErrorWithDetail) {
        return { status: error.status, body: { error: error.message, ...error.detail } };
      }
      if (error && typeof error === "object" && "status" in error) {
        return {
          status: (error as { status: number }).status,
          body: { error: (error as unknown as Error).message },
        };
      }
      if (error && typeof error === "object" && (error as Error).name === "ZodError") {
        return { status: 400, body: { error: "Invalid request" } };
      }
      throw error;
    }
  }

  const start = (user: World["owner"], channelId: string, id = appId, extra = {}) =>
    call(user, "POST", `/api/channels/${channelId}/app-sessions`, { appId: id, ...extra });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  async function resetApps(): Promise<void> {
    await q(`TRUNCATE app_admin_audit, app_sessions, app_session_participants, server_apps,
                      app_versions, apps, feature_flags, feature_flag_overrides, messages
                      RESTART IDENTITY CASCADE`);
    await q(
      `INSERT INTO app_publishers (id, display_name, kind)
       VALUES ('pqp', 'pqp', 'first_party') ON CONFLICT (id) DO NOTHING`,
    );
  }

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
    process.env.INSTANCE_MODERATOR_CLERK_IDS = "";
    world = await buildWorld(modules);
    process.env.INSTANCE_MODERATOR_CLERK_IDS = world.operator.clerk_id;
    appId = await publishTestApp(modules, world.serverId);
    await flags.setServerFlagOverride("apps", world.serverId, true, { kind: "dashboard" });
  });

  afterAll(async () => {
    flags.resetFeatureFlagsForTests();
    await transport.close().catch(() => {});
    await db.closePool();
  });

  describe("the checks of a start, in order", () => {
    it("1. the channel must exist, be a server channel and be viewable: 404", async () => {
      const unknown = await start(world.member, "00000000-0000-4000-8000-000000000000");
      expect(unknown.status).toBe(404);
      // A person who cannot see the channel learns nothing about it.
      const hidden = await start(world.member, world.channels.secret);
      expect(hidden.status).toBe(404);
      const stranger = await start(world.stranger, world.channels.general);
      expect(stranger.status).toBe(404);
      expect(await q(`SELECT 1 FROM app_sessions`)).toMatchObject({ rowCount: 0 });
    });

    it("2. the apps flag for the channel's server: 404, before anything else is said", async () => {
      await flags.setServerFlagOverride("apps", world.serverId, false, { kind: "dashboard" });
      // Even somebody who is not allowed to start is told nothing but 404.
      for (const user of [world.member, world.noApps]) {
        expect((await start(user, world.channels.general)).status).toBe(404);
      }
      expect(await q(`SELECT 1 FROM app_sessions`)).toMatchObject({ rowCount: 0 });
    });

    it("3. the app must be available for this channel type: 403 app_unavailable, with the reason", async () => {
      await q(`UPDATE apps SET global_enabled = FALSE WHERE id = $1`, [appId]);
      const off = await start(world.member, world.channels.general);
      expect(off).toMatchObject({ status: 403, body: { error: "app_unavailable", reason: "global-off" } });
      await q(`UPDATE apps SET global_enabled = TRUE WHERE id = $1`, [appId]);

      const voiceOnly = await publishTestApp(modules, world.serverId, {
        id: "voice-only-app",
        channelTypes: ["voice"],
      });
      const inText = await start(world.member, world.channels.general, voiceOnly);
      expect(inText).toMatchObject({ status: 403, body: { reason: "channel-type" } });
      const inForum = await start(world.owner, world.channels.forum);
      expect(inForum).toMatchObject({ status: 403, body: { reason: "channel-type" } });
      expect((await start(world.member, world.channels.lobby, voiceOnly)).status).toBe(201);

      const unknownApp = await start(world.member, world.channels.general, "no-such-app");
      expect(unknownApp).toMatchObject({ status: 403, body: { reason: "not-live" } });
    });

    it("3 before 4: a person who may not start still hears that the app is unavailable", async () => {
      await q(`UPDATE server_apps SET operator_enabled = FALSE WHERE app_id = $1`, [appId]);
      const result = await start(world.noApps, world.channels.restricted);
      expect(result).toMatchObject({ status: 403, body: { reason: "not-allowed-here" } });
    });

    it("4. USE_APPS in THIS channel, honouring channel overwrites: 403 cannot_start", async () => {
      expect((await start(world.noApps, world.channels.restricted)).status).toBe(403);
      expect((await start(world.noApps, world.channels.restricted)).body.error).toBe("cannot_start");
      // The same person starts one in another channel.
      expect((await start(world.noApps, world.channels.general)).status).toBe(201);
    });

    it("4. a manifest that requires MANAGE_CHANNELS also needs it, on top of USE_APPS", async () => {
      const staffOnly = await publishTestApp(modules, world.serverId, {
        id: "staff-only-app",
        requires: { start: "MANAGE_CHANNELS" },
      });
      expect((await start(world.member, world.channels.general, staffOnly)).body.error).toBe(
        "cannot_start",
      );
      expect((await start(world.moderator, world.channels.general, staffOnly)).status).toBe(403);
      expect((await start(world.manager, world.channels.general, staffOnly)).status).toBe(201);
    });

    it("5. one live session per channel: 409 session_live with the winner's summary", async () => {
      const first = await start(world.member, world.channels.general);
      expect(first.status).toBe(201);
      const second = await start(world.moderator, world.channels.general);
      expect(second.status).toBe(409);
      expect(second.body.error).toBe("session_live");
      expect(second.body.session.id).toBe(first.body.id);
      expect(await q(`SELECT 1 FROM app_sessions WHERE status = 'live'`)).toMatchObject({
        rowCount: 1,
      });
      // A different channel is its own.
      expect((await start(world.moderator, world.channels.lobby)).status).toBe(201);
    });

    it("5. two starts at once make one session and one 409", async () => {
      sessions.resetAppSessionLimitsForTests();
      const results = await Promise.all([
        start(world.member, world.channels.general),
        start(world.moderator, world.channels.general),
        start(world.manager, world.channels.general),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      const winner = results.find((r) => r.status === 201)!;
      for (const loser of results.filter((r) => r.status === 409)) {
        expect(loser.body.session.id).toBe(winner.body.id);
      }
      expect(await q(`SELECT 1 FROM app_sessions WHERE status = 'live'`)).toMatchObject({
        rowCount: 1,
      });
      // The loser did not leave a second timeline card behind.
      expect(
        (await q(`SELECT 1 FROM messages WHERE system_kind = 'app_session'`)).rowCount,
      ).toBe(1);
    });

    it("a start is rate limited per person, and a refusal does not spend the budget", async () => {
      for (let i = 0; i < 3; i += 1) {
        expect((await start(world.noApps, world.channels.restricted)).status).toBe(403);
      }
      const ok: number[] = [];
      for (let i = 0; i < 8; i += 1) {
        const result = await start(world.member, world.channels.general);
        ok.push(result.status);
        if (result.status === 201) {
          await sessions.endSessionRow(result.body.id, "host", world.member.id);
        }
      }
      expect(ok.filter((status) => status === 201)).toHaveLength(6);
      expect(ok.filter((status) => status === 429)).toHaveLength(2);
    });

    it("rejects a malformed app id with 400", async () => {
      expect(await start(world.member, world.channels.general, "Not A Slug")).toMatchObject({
        status: 400,
      });
      expect(
        (await call(world.member, "POST", `/api/channels/${world.channels.general}/app-sessions`, {}))
          .status,
      ).toBe(400);
    });
  });

  describe("what a start writes", () => {
    it("takes server_id from the channel row, never from the request", async () => {
      const otherOwner = await (await import("./testing-world.js")).makeUser(modules, "Other");
      const other = await servers.createServer("Elsewhere", otherOwner.id);
      const result = await start(world.member, world.channels.general, appId, {
        serverId: other.server.id,
        server_id: other.server.id,
      });
      expect(result.status).toBe(201);
      const row = (await q(`SELECT server_id, channel_id FROM app_sessions`)).rows[0]!;
      expect(row).toEqual({ server_id: world.serverId, channel_id: world.channels.general });
    });

    it("inserts a live row with the version pinned, the starter as host and nobody joined", async () => {
      const result = await start(world.member, world.channels.general);
      expect(result.status).toBe(201);
      const summary = appSessionSummarySchema.parse(result.body);
      expect(summary).toMatchObject({
        appId: "pqp-eco",
        appVersion: "1.0.0",
        startedBy: world.member.id,
        hostUserId: world.member.id,
        participants: [],
        players: 0,
        spectators: 0,
        handoff: null,
      });
      const row = (await q(`SELECT * FROM app_sessions WHERE id = $1`, [summary.id])).rows[0]!;
      expect(row).toMatchObject({
        status: "live",
        app_version: "1.0.0",
        state: {},
        state_rev: "0",
        host_gone_at: null,
        ended_at: null,
      });
      expect((await q(`SELECT 1 FROM app_session_participants`)).rowCount).toBe(0);
    });

    it("a later current_version never moves a live session off the version it started on", async () => {
      const first = await start(world.member, world.channels.general);
      await publishTestApp(modules, world.serverId, { version: "1.1.0" });
      await q(`UPDATE apps SET current_version = '1.1.0' WHERE id = $1`, [appId]);
      const row = (await q(`SELECT app_version FROM app_sessions WHERE id = $1`, [first.body.id])).rows[0]!;
      expect(row.app_version).toBe("1.0.0");
      await sessions.endSessionRow(first.body.id, "host", world.member.id);
      const next = await start(world.member, world.channels.general);
      expect(next.body.appVersion).toBe("1.1.0");
    });

    it("writes the timeline message in the same transaction and links it", async () => {
      const result = await start(world.member, world.channels.general);
      const row = (
        await q<{ timeline_message_id: string }>(
          `SELECT timeline_message_id FROM app_sessions WHERE id = $1`,
          [result.body.id],
        )
      ).rows[0]!;
      expect(row.timeline_message_id).toBeTruthy();
      const message = (
        await q(`SELECT channel_id, author_id, body, system_kind FROM messages WHERE id = $1`, [
          row.timeline_message_id,
        ])
      ).rows[0]!;
      expect(message).toEqual({
        channel_id: world.channels.general,
        author_id: world.member.id,
        body: "Member começou um app",
        system_kind: "app_session",
      });
    });

    it("uses the server nickname in the fallback line, with control characters removed", async () => {
      await q(`UPDATE server_members SET nickname = $3 WHERE server_id = $1 AND user_id = $2`, [
        world.serverId,
        world.member.id,
        "Raf\nael\u0007",
      ]);
      await start(world.member, world.channels.general);
      const body = (await q<{ body: string }>(`SELECT body FROM messages`)).rows[0]!.body;
      expect(body).toBe("Raf ael começou um app");
      expect(sessions.appSessionFallbackBody("   ")).toBe("? começou um app");
    });

    it("rolls back the row when the message cannot be written", async () => {
      await q(`ALTER TABLE messages ADD CONSTRAINT apps_test_no_app_session
                 CHECK (system_kind IS DISTINCT FROM 'app_session') NOT VALID`);
      try {
        await expect(start(world.member, world.channels.general)).rejects.toThrow();
      } finally {
        await q(`ALTER TABLE messages DROP CONSTRAINT apps_test_no_app_session`);
      }
      expect((await q(`SELECT 1 FROM app_sessions`)).rowCount).toBe(0);
      // And the channel is free to start again.
      sessions.resetAppSessionLimitsForTests();
      expect((await start(world.member, world.channels.general)).status).toBe(201);
    });

    it("counts starts and refusals", async () => {
      await start(world.member, world.channels.general);
      await start(world.moderator, world.channels.general);
      await start(world.noApps, world.channels.restricted);
      expect(metrics.appCountersSnapshot()).toMatchObject({
        starts: 1,
        startsRefused: { session_live: 1, cannot_start: 1 },
      });
    });
  });

  describe("fan-out", () => {
    it("sends the timeline message and channel-app to everyone who can view the channel, and no one else", async () => {
      const viewing = recordingSocket(modules, world.member);
      const elsewhere = recordingSocket(modules, world.moderator);
      const insider = recordingSocket(modules, world.insider);
      const stranger = recordingSocket(modules, world.stranger);
      // Only `viewing` has joined the channel; the others are looking elsewhere.
      const chat = await import("../ws/chat.js");
      await chat.handleChatMessage(
        { socket: viewing.socket, user: world.member },
        { type: "join-channel", channelId: world.channels.general },
      );
      viewing.frames.length = 0;

      const result = await start(world.manager, world.channels.general);
      await settle();
      expect(result.status).toBe(201);

      const summary = appSessionSummarySchema.parse(result.body);
      for (const rec of [viewing, elsewhere, insider]) {
        const frames = rec.ofType("channel-app");
        expect(frames).toHaveLength(1);
        const parsed = channelAppSchema.parse(frames[0]);
        expect(parsed.channelId).toBe(world.channels.general);
        expect(parsed.session?.id).toBe(summary.id);
      }
      expect(stranger.ofType("channel-app")).toHaveLength(0);
      // Only the channel's own viewers get the card message.
      const broadcast = viewing.ofType("message-broadcast");
      expect(broadcast).toHaveLength(1);
      expect((broadcast[0] as any).message).toMatchObject({
        systemKind: "app_session",
        body: "Manager começou um app",
      });
      expect(elsewhere.ofType("message-broadcast")).toHaveLength(0);
    });

    it("a private channel's session reaches only people who can view it", async () => {
      const insider = recordingSocket(modules, world.insider);
      const member = recordingSocket(modules, world.member);
      const result = await start(world.insider, world.channels.secret);
      await settle();
      expect(result.status).toBe(201);
      expect(insider.ofType("channel-app")).toHaveLength(1);
      expect(member.ofType("channel-app")).toHaveLength(0);
      // The member cannot read it over HTTP either.
      expect(
        (await call(world.member, "GET", `/api/channels/${world.channels.secret}/app-session`)).status,
      ).toBe(404);
    });

    it("an end sends channel-app with no session, and app-ended to the participants' sockets", async () => {
      const viewer = recordingSocket(modules, world.moderator);
      const seated = recordingSocket(modules, world.member);
      const result = await start(world.member, world.channels.general);
      wsApps.addSessionSocket(result.body.id, seated.socket);
      await settle();
      viewer.frames.length = 0;

      const ended = await call(world.member, "POST", `/api/app-sessions/${result.body.id}/end`);
      await settle();
      expect(ended).toMatchObject({ status: 200, body: { ended: true } });

      const none = channelAppSchema.parse(viewer.ofType("channel-app").at(-1));
      expect(none.session).toBeNull();
      const endedFrame = appEndedSchema.parse(seated.ofType("app-ended")[0]);
      expect(endedFrame).toMatchObject({
        sessionId: result.body.id,
        channelId: world.channels.general,
        reason: "host",
        summary: { participants: 0 },
      });
    });

    it("app-ended reaches everybody who can view the channel (D13), once, and nobody who cannot", async () => {
      const seated = recordingSocket(modules, world.member);
      const viewer = recordingSocket(modules, world.moderator);
      const stranger = recordingSocket(modules, world.stranger);
      const hidden = recordingSocket(modules, world.noApps);
      const result = await start(world.member, world.channels.general);
      wsApps.addSessionSocket(result.body.id, seated.socket);
      await settle();
      await call(world.member, "POST", `/api/app-sessions/${result.body.id}/end`);
      await settle();
      for (const rec of [seated, viewer, hidden]) {
        expect(rec.ofType("app-ended"), "a viewer").toHaveLength(1);
        expect(appEndedSchema.parse(rec.ofType("app-ended")[0])).toMatchObject({
          sessionId: result.body.id,
          reason: "host",
          summary: { participants: 0 },
        });
      }
      expect(stranger.ofType("app-ended")).toEqual([]);
    });
  });

  describe("the card on the timeline carries its session", () => {
    const card = async (channelId: string) => {
      const page = await (await import("../services/messages.js")).listMessages(channelId, {
        viewerId: world.member.id,
      });
      return page.messages.find((m) => m.system_kind === "app_session");
    };
    const mapped = async (channelId: string) => {
      const { mapMessage } = await import("../services/messages.js");
      const found = await card(channelId);
      return found ? mapMessage(found) : undefined;
    };

    it("is live while the session runs, then the quiet record, then null once retained away", async () => {
      const started = await start(world.member, world.channels.general);
      const live = await mapped(world.channels.general);
      expect(live).toMatchObject({
        systemKind: "app_session",
        appSession: {
          id: started.body.id,
          appId: "pqp-eco",
          appVersion: "1.0.0",
          status: "live",
          endReason: null,
          summary: null,
          startedBy: world.member.id,
        },
      });
      await call(world.manager, "POST", `/api/app-sessions/${started.body.id}/end`);
      expect((await mapped(world.channels.general))!.appSession).toMatchObject({
        status: "ended",
        endReason: "moderator",
        summary: { participants: 0 },
      });
      await q(`DELETE FROM app_sessions WHERE id = $1`, [started.body.id]);
      const gone = (await mapped(world.channels.general))!;
      expect(gone.systemKind).toBe("app_session");
      expect(gone.appSession).toBeNull();
    });

    it("is on the single read, and the live fan-out of the card", async () => {
      const viewing = recordingSocket(modules, world.moderator);
      const chat = await import("../ws/chat.js");
      await chat.handleChatMessage(
        { socket: viewing.socket, user: world.moderator },
        { type: "join-channel", channelId: world.channels.general },
      );
      viewing.frames.length = 0;
      const started = await start(world.member, world.channels.general);
      await settle();
      const broadcast = (viewing.ofType("message-broadcast")[0] as any).message;
      expect(broadcast.appSession).toMatchObject({ id: started.body.id, status: "live" });
      const { getHydratedMessage, mapMessage } = await import("../services/messages.js");
      const again = await getHydratedMessage(broadcast.id);
      expect(mapMessage(again!).appSession).toMatchObject({ id: started.body.id });
    });

    it("a failed session lookup degrades the cards and never fails the read of the page", async () => {
      const { listAppSessionsForMessages } = await import("./message-sessions.js");
      const spy = vi.spyOn(db.getPool(), "query").mockRejectedValueOnce(new Error("pool blip"));
      try {
        const out = await listAppSessionsForMessages([{ id: "x", system_kind: "app_session" }]);
        expect(out.size).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });

    it("never appears on an ordinary message, and costs a page with no card no extra read", async () => {
      const { mapMessage } = await import("../services/messages.js");
      const plain = mapMessage({
        id: "m",
        channel_id: "c",
        author_id: "a",
        body: "hi",
        created_at: new Date(),
        edited_at: null,
      } as never);
      expect("appSession" in plain).toBe(false);
      const { listAppSessionsForMessages } = await import("./message-sessions.js");
      expect((await listAppSessionsForMessages([{ id: "x", system_kind: null }])).size).toBe(0);
    });
  });

  describe("ending a session", () => {
    async function liveSession(host = world.member, channelId = world.channels.general) {
      const result = await start(host, channelId);
      expect(result.status).toBe(201);
      return result.body.id as string;
    }

    it("the host ends it: reason host, state cleared, summary written, seats released", async () => {
      const id = await liveSession();
      await q(`UPDATE app_sessions SET state = '{"x":1}'::jsonb, state_rev = 3 WHERE id = $1`, [id]);
      await q(
        `INSERT INTO app_session_participants (session_id, user_id, seat_id, role)
         VALUES ($1, $2, 'seatAAAAAAAAAAAAAAAAAA', 'player'), ($1, $3, 'seatBBBBBBBBBBBBBBBBBB', 'spectator')`,
        [id, world.member.id, world.moderator.id],
      );
      await q(`UPDATE app_sessions SET started_at = NOW() - interval '90 seconds' WHERE id = $1`, [id]);

      const result = await call(world.member, "POST", `/api/app-sessions/${id}/end`);
      expect(result).toMatchObject({ status: 200, body: { ended: true } });

      const row = (await q(`SELECT * FROM app_sessions WHERE id = $1`, [id])).rows[0]!;
      expect(row).toMatchObject({
        status: "ended",
        end_reason: "host",
        ended_by: world.member.id,
        state: {},
        state_rev: "3",
      });
      expect(row.ended_at).toBeInstanceOf(Date);
      const summary = row.summary as { participants: number; durationSeconds: number };
      expect(summary.participants).toBe(2);
      expect(summary.durationSeconds).toBeGreaterThanOrEqual(90);
      expect(summary.durationSeconds).toBeLessThan(100);
      expect(
        (await q(`SELECT 1 FROM app_session_participants WHERE left_at IS NULL`)).rowCount,
      ).toBe(0);
      expect(metrics.appCountersSnapshot().ends).toEqual({ host: 1 });
    });

    it("copies a small state.result into the summary before the state is cleared, and tells everybody", async () => {
      const id = await liveSession();
      const viewer = recordingSocket(modules, world.moderator);
      await q(
        `UPDATE app_sessions SET state = $2::jsonb WHERE id = $1`,
        [id, JSON.stringify({ votes: { a: 3 }, result: { winner: "a", tally: { a: 3, b: 1 } } })],
      );
      await call(world.member, "POST", `/api/app-sessions/${id}/end`);
      await settle();
      const row = (await q(`SELECT state, summary FROM app_sessions WHERE id = $1`, [id])).rows[0]!;
      expect(row.state).toEqual({});
      expect(row.summary).toMatchObject({
        participants: 0,
        result: { winner: "a", tally: { a: 3, b: 1 } },
      });
      const frame = appEndedSchema.parse(viewer.ofType("app-ended")[0]);
      expect(frame.summary.result).toEqual({ winner: "a", tally: { a: 3, b: 1 } });
      const { listMessages, mapMessage } = await import("../services/messages.js");
      const page = await listMessages(world.channels.general, { viewerId: world.member.id });
      const card = mapMessage(page.messages.find((m) => m.system_kind === "app_session")!);
      expect((card.appSession as { summary: { result: unknown } }).summary.result).toEqual({
        winner: "a",
        tally: { a: 3, b: 1 },
      });
    });

    it("drops a state.result that is not a small object: too big, an array, a scalar", async () => {
      const cases: unknown[] = [
        { blob: "x".repeat(600) },
        [1, 2, 3],
        "text",
        42,
      ];
      for (const result of cases) {
        sessions.resetAppSessionLimitsForTests();
        const id = await liveSession(world.member, world.channels.lobby);
        await q(`UPDATE app_sessions SET state = jsonb_build_object('result', $2::jsonb) WHERE id = $1`, [
          id,
          JSON.stringify(result),
        ]);
        await call(world.member, "POST", `/api/app-sessions/${id}/end`);
        const summary = (await q(`SELECT summary FROM app_sessions WHERE id = $1`, [id])).rows[0]!
          .summary as Record<string, unknown>;
        expect("result" in summary, JSON.stringify(result).slice(0, 30)).toBe(false);
      }
      // The pure rule, including the NUL jsonb itself cannot hold.
      expect(sessions.keptResult({ a: 1 })).toEqual({ a: 1 });
      expect(sessions.keptResult({ bad: "a\u0000b" })).toBeNull();
      expect(sessions.keptResult({ blob: "x".repeat(600) })).toBeNull();
      expect(sessions.keptResult({ blob: "x".repeat(490) })).not.toBeNull();
      expect(sessions.keptResult(null)).toBeNull();
    });

    it("MANAGE_CHANNELS ends somebody else's: reason moderator", async () => {
      const id = await liveSession();
      const result = await call(world.manager, "POST", `/api/app-sessions/${id}/end`);
      expect(result.status).toBe(200);
      const row = (await q(`SELECT end_reason, ended_by FROM app_sessions WHERE id = $1`, [id])).rows[0]!;
      expect(row).toEqual({ end_reason: "moderator", ended_by: world.manager.id });
    });

    it("an instance moderator who is not in the server ends it: reason operator", async () => {
      const id = await liveSession();
      const result = await call(world.operator, "POST", `/api/app-sessions/${id}/end`);
      expect(result.status).toBe(200);
      expect(
        (await q(`SELECT end_reason FROM app_sessions WHERE id = $1`, [id])).rows[0]!.end_reason,
      ).toBe("operator");
    });

    it("a plain member who is not the host is refused (403), and a person who cannot see the channel gets 404", async () => {
      const id = await liveSession(world.moderator);
      const refused = await call(world.noApps, "POST", `/api/app-sessions/${id}/end`);
      expect(refused).toMatchObject({ status: 403, body: { error: "cannot_end" } });
      expect(
        (await call(world.stranger, "POST", `/api/app-sessions/${id}/end`)).status,
      ).toBe(404);
      expect(
        (await q(`SELECT status FROM app_sessions WHERE id = $1`, [id])).rows[0]!.status,
      ).toBe("live");
      const secret = await liveSession(world.insider, world.channels.secret);
      expect((await call(world.member, "POST", `/api/app-sessions/${secret}/end`)).status).toBe(404);
    });

    it("is idempotent: ending an ended session answers 200 and tells nobody again", async () => {
      const id = await liveSession();
      const viewer = recordingSocket(modules, world.moderator);
      await call(world.member, "POST", `/api/app-sessions/${id}/end`);
      await settle();
      const sent = viewer.frames.length;
      const again = await call(world.member, "POST", `/api/app-sessions/${id}/end`);
      expect(again).toMatchObject({ status: 200, body: { ended: false } });
      await settle();
      expect(viewer.frames).toHaveLength(sent);
      expect(metrics.appCountersSnapshot().ends).toEqual({ host: 1 });
    });

    it("an unknown session is 404, and the system path takes every reason", async () => {
      expect(
        (await call(world.member, "POST", "/api/app-sessions/00000000-0000-4000-8000-000000000000/end"))
          .status,
      ).toBe(404);
      for (const reason of ["idle", "host-gone", "app-disabled", "empty", "max-duration", "flag-off"] as const) {
        sessions.resetAppSessionLimitsForTests();
        const id = await liveSession();
        const done = await sessions.endSessionRow(id, reason, null);
        expect(done).toEqual({ ended: true, channelId: world.channels.general });
        const row = (await q(`SELECT end_reason, ended_by FROM app_sessions WHERE id = $1`, [id])).rows[0]!;
        expect(row).toEqual({ end_reason: reason, ended_by: null });
      }
    });

    it("after an end the channel can start again, and the old row stays ended", async () => {
      const id = await liveSession();
      await call(world.member, "POST", `/api/app-sessions/${id}/end`);
      const next = await start(world.moderator, world.channels.general);
      expect(next.status).toBe(201);
      expect(next.body.id).not.toBe(id);
      const rows = (await q(`SELECT status FROM app_sessions ORDER BY started_at`)).rows;
      expect(rows.map((row) => row.status)).toEqual(["ended", "live"]);
    });
  });

  describe("reading", () => {
    it("GET channel: the summary, or null", async () => {
      expect(
        await call(world.member, "GET", `/api/channels/${world.channels.general}/app-session`),
      ).toEqual({ status: 200, body: null });
      const started = await start(world.member, world.channels.general);
      const read = await call(world.moderator, "GET", `/api/channels/${world.channels.general}/app-session`);
      expect(read.status).toBe(200);
      expect(read.body.id).toBe(started.body.id);
      expect(
        (await call(world.stranger, "GET", `/api/channels/${world.channels.general}/app-session`)).status,
      ).toBe(404);
    });

    it("GET server: every live session on a channel the caller can view", async () => {
      await start(world.member, world.channels.general);
      await start(world.moderator, world.channels.lobby);
      await start(world.insider, world.channels.secret);
      const asMember = await call(world.member, "GET", `/api/servers/${world.serverId}/app-sessions`);
      expect(asMember.status).toBe(200);
      expect(asMember.body.sessions.map((entry: any) => entry.channelId).sort()).toEqual(
        [world.channels.general, world.channels.lobby].sort(),
      );
      for (const entry of asMember.body.sessions) {
        appSessionSummarySchema.parse(entry.session);
      }
      const asInsider = await call(world.insider, "GET", `/api/servers/${world.serverId}/app-sessions`);
      expect(asInsider.body.sessions).toHaveLength(3);
      expect(
        (await call(world.stranger, "GET", `/api/servers/${world.serverId}/app-sessions`)).status,
      ).toBe(404);
    });
  });

  describe("with the flag off, every route is a 404 and no frame is sent", () => {
    it("answers 404 on every route and writes nothing", async () => {
      const id = (await start(world.member, world.channels.general)).body.id as string;
      await flags.setServerFlagOverride("apps", world.serverId, false, { kind: "dashboard" });
      const viewer = recordingSocket(modules, world.moderator);
      const paths: Array<[any, "GET" | "POST", string, unknown?]> = [
        [world.member, "POST", `/api/channels/${world.channels.lobby}/app-sessions`, { appId }],
        [world.member, "GET", `/api/channels/${world.channels.general}/app-session`],
        [world.member, "GET", `/api/servers/${world.serverId}/app-sessions`],
        [world.member, "POST", `/api/app-sessions/${id}/end`],
        [world.operator, "POST", `/api/app-sessions/${id}/end`],
      ];
      for (const [user, method, path, body] of paths) {
        expect((await call(user, method, path, body)).status, `${method} ${path}`).toBe(404);
      }
      await settle();
      expect(viewer.frames).toHaveLength(0);
      expect(
        (await q(`SELECT status FROM app_sessions WHERE id = $1`, [id])).rows[0]!.status,
      ).toBe("live");
      expect((await q(`SELECT 1 FROM app_sessions`)).rowCount).toBe(1);
    });
  });
});

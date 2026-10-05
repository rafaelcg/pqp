import { randomUUID } from "node:crypto";
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
import type { WebSocket } from "ws";
import {
  Permission,
  STREAM_ALERT_MAX_RECIPIENTS,
  STREAM_START_CHANNEL_COOLDOWN_MS,
  STREAM_START_STABLE_MS,
  serializePermissions,
} from "@pqp/shared";

/**
 * Who a start-of-stream notice reaches, against a real Postgres.
 *
 * The decision is the product's whole safety story (a notice that reaches the
 * wrong 4,000 people is the incident), so each rule is its own case with the
 * counter that proves it ran, and the two large-server cases are the ones that
 * matter most: a community notifies nobody who did not ask, and a person who
 * did ask is still subject to every other rule.
 *
 * Push is a spy (what is under test is the decision and the socket half); the
 * flag is the environment variable, which is what answers before the flag store
 * has started, exactly as the sibling tests do.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const pushed = vi.hoisted(() => vi.fn());
vi.mock("./push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./push.js")>()),
  pushStreamStarted: (event: unknown, onSent?: (n: number) => void) => {
    pushed(event);
    onSent?.(0);
  },
}));

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer, createChannel } = await import("./servers.js");
const alerts = await import("./stream-alerts.js");
const { setAuthenticatedSocket, deleteAuthenticatedSocket } = await import(
  "../ws/sockets.js"
);

interface Scene {
  serverId: string;
  channelId: string;
  sharerId: string;
  /** Member ids, sharer excluded. */
  memberIds: string[];
}

const created: WebSocket[] = [];

async function makeUser(name: string): Promise<string> {
  return (
    await upsertUser({ clerkId: `clerk_${name}_${randomUUID()}`, displayName: name, avatarUrl: null })
  ).id;
}

/**
 * A server with a sharer and `count` extra members, inserted in bulk so a
 * 4,000 member community is not 4,000 round trips.
 */
async function scene(
  count: number,
  options: { community?: boolean } = {},
): Promise<Scene> {
  const pool = getPool();
  const sharerId = await makeUser("sharer");
  const { server } = await createServer("Filminho", sharerId);
  const channel = await createChannel(server.id, "filminho", "voice");
  const tag = randomUUID().slice(0, 8);
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO users (clerk_id, display_name)
     SELECT 'bulk_' || $1 || '_' || g, 'Member ' || g
       FROM generate_series(1, $2::int) AS g
     RETURNING id`,
    [tag, count],
  );
  const memberIds = inserted.rows.map((row) => row.id);
  await pool.query(
    `INSERT INTO server_members (server_id, user_id, role)
     SELECT $1, u, 'member' FROM unnest($2::uuid[]) AS u`,
    [server.id, memberIds],
  );
  if (options.community) {
    await pool.query(`UPDATE servers SET is_community = TRUE WHERE id = $1`, [server.id]);
  }
  return { serverId: server.id, channelId: channel.id, sharerId, memberIds };
}

async function setPrefs(userId: string, settings: Record<string, unknown>) {
  await getPool().query(
    `INSERT INTO user_preferences (user_id, settings) VALUES ($1, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET settings = EXCLUDED.settings`,
    [userId, JSON.stringify(settings)],
  );
}

function decide(s: Scene, seated: string[] = []) {
  return alerts.decideStreamAlertRecipients({
    serverId: s.serverId,
    channel: { id: s.channelId, type: "voice", parent_id: null },
    sharerUserId: s.sharerId,
    seatedUserIds: seated,
  });
}

describeDb("who a start-of-stream notice reaches", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    alerts.resetStreamAlertsForTests();
    pushed.mockClear();
  });

  afterEach(() => {
    for (const socket of created.splice(0)) {
      deleteAuthenticatedSocket(socket);
    }
    delete process.env.STREAM_START_NOTIFICATIONS;
    vi.useRealTimers();
  });

  describe("a small server (150 members)", () => {
    it("tells everybody by default, minus the sharer", async () => {
      const s = await scene(150);
      const told = await decide(s);
      expect(told).toHaveLength(150);
      expect(told).not.toContain(s.sharerId);
      // The owner (the sharer here) is a member row too, and is skipped by rule.
      expect(alerts.streamAlertMetrics().skipped.sharer).toBe(1);
    });

    it("leaves out exactly the people who opted out, and counts them", async () => {
      const s = await scene(150);
      const [out, stays] = s.memberIds;
      await setPrefs(out!, { notifications: { streamAlerts: { [s.serverId]: false } } });
      const told = await decide(s);
      expect(told).not.toContain(out);
      expect(told).toContain(stays);
      expect(told).toHaveLength(149);
      expect(alerts.streamAlertMetrics().skipped.optedOut).toBe(1);
    });

    it("applies every other rule, each with its own counter", async () => {
      const s = await scene(150);
      const [seated, dnd, serverMuted, mentionsOnly, channelMuted, blockedBySharer, blocksSharer, noConnect, timedOut, plain] =
        s.memberIds;
      const pool = getPool();

      await setPrefs(dnd!, { status: "dnd" });
      await setPrefs(serverMuted!, { notifications: { servers: { [s.serverId]: "none" } } });
      await setPrefs(mentionsOnly!, { notifications: { servers: { [s.serverId]: "mentions" } } });
      await setPrefs(channelMuted!, { notifications: { channels: { [s.channelId]: "none" } } });
      await pool.query(`INSERT INTO user_blocks (user_id, blocked_user_id) VALUES ($1, $2), ($3, $1)`, [
        s.sharerId,
        blockedBySharer,
        blocksSharer,
      ]);
      await pool.query(
        `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
         VALUES ($1, 'member', $2, 0, $3)`,
        [s.channelId, noConnect, serializePermissions(Permission.CONNECT)],
      );
      await pool.query(
        `INSERT INTO member_timeouts (server_id, user_id, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
        [s.serverId, timedOut],
      );

      const told = new Set(await decide(s, [seated!]));
      for (const excluded of [
        seated,
        dnd,
        serverMuted,
        mentionsOnly,
        channelMuted,
        blockedBySharer,
        blocksSharer,
        noConnect,
        timedOut,
      ]) {
        expect(told.has(excluded!), `${excluded} should be excluded`).toBe(false);
      }
      expect(told.has(plain!)).toBe(true);
      expect(told.size).toBe(150 - 9);

      const m = alerts.streamAlertMetrics().skipped;
      expect(m).toMatchObject({
        sharer: 1,
        inRoom: 1,
        dnd: 1,
        muted: 3,
        blocked: 2,
        noAccess: 2,
      });
    });

    it("never reaches somebody who cannot see a private channel", async () => {
      const s = await scene(20);
      const room = await createChannel(s.serverId, "private", "voice", true);
      const invited = s.memberIds[0]!;
      await getPool().query(
        `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
         VALUES ($1, 'member', $2, $3, 0)`,
        [room.id, invited, serializePermissions(Permission.VIEW_CHANNEL)],
      );
      const told = await alerts.decideStreamAlertRecipients({
        serverId: s.serverId,
        channel: { id: room.id, type: "voice", parent_id: null },
        sharerUserId: s.sharerId,
        seatedUserIds: [],
      });
      expect(told).toEqual([invited]);
      expect(alerts.streamAlertMetrics().skipped.noAccess).toBe(19);
    });
  });

  describe("a server above the default, and a community", () => {
    it("a 4,000 member community tells nobody who did not ask", async () => {
      const s = await scene(4000, { community: true });
      const told = await decide(s);
      expect(told).toEqual([]);
      expect(alerts.streamAlertMetrics().skipped.optedOut).toBe(0);
    }, 60_000);

    it("a person who asked is told there, and every other rule still applies to them", async () => {
      const s = await scene(4000, { community: true });
      const [asked, askedButDnd, askedButSeated, askedThenOut] = s.memberIds;
      const on = { notifications: { streamAlerts: { [s.serverId]: true } } };
      await setPrefs(asked!, on);
      await setPrefs(askedButDnd!, { ...on, status: "dnd" });
      await setPrefs(askedButSeated!, on);
      await setPrefs(askedThenOut!, { notifications: { streamAlerts: { [s.serverId]: false } } });
      const told = await decide(s, [askedButSeated!]);
      expect(told).toEqual([asked]);
    }, 60_000);

    it("a plain server just above 200 members is off by default too", async () => {
      const s = await scene(250);
      expect(await decide(s)).toEqual([]);
      await setPrefs(s.memberIds[0]!, {
        notifications: { streamAlerts: { [s.serverId]: true } },
      });
      expect(await decide(s)).toEqual([s.memberIds[0]]);
    });

    it("a community that is small is still a community", async () => {
      const s = await scene(10, { community: true });
      expect(await decide(s)).toEqual([]);
    });

    it("walks past a first page of people who asked but cannot be told, to the ones behind them", async () => {
      // 1,200 members all opted in; the first 1,000 by id (a whole page) are on
      // DND. A bound applied BEFORE the filters would stop at those and tell
      // nobody; the bound is on people told.
      const s = await scene(1_200, { community: true });
      const sorted = [...s.memberIds].sort();
      await getPool().query(
        `INSERT INTO user_preferences (user_id, settings)
         SELECT u, jsonb_build_object(
                  'status', CASE WHEN u = ANY($3::uuid[]) THEN 'dnd' ELSE 'online' END,
                  'notifications',
                  jsonb_build_object('streamAlerts', jsonb_build_object($2::text, true)))
           FROM unnest($1::uuid[]) AS u`,
        [s.memberIds, s.serverId, sorted.slice(0, 1_000)],
      );
      const told = await decide(s);
      expect([...told].sort()).toEqual(sorted.slice(1_000));
      expect(alerts.streamAlertMetrics().skipped.dnd).toBe(1_000);
    }, 60_000);

    it("stops at the cap however many asked", async () => {
      const s = await scene(STREAM_ALERT_MAX_RECIPIENTS + 40, { community: true });
      await getPool().query(
        `INSERT INTO user_preferences (user_id, settings)
         SELECT u, jsonb_build_object('notifications',
                  jsonb_build_object('streamAlerts', jsonb_build_object($2::text, true)))
           FROM unnest($1::uuid[]) AS u`,
        [s.memberIds, s.serverId],
      );
      const told = await decide(s);
      expect(told).toHaveLength(STREAM_ALERT_MAX_RECIPIENTS);
      expect(alerts.streamAlertMetrics().skipped.overCap).toBeGreaterThan(0);
    }, 60_000);
  });

  describe("the claim", () => {
    it("lets one caller in per channel per cooldown, and a later one after it", async () => {
      const s = await scene(2);
      expect(await alerts.claimStreamAlert(s.channelId, null)).toBe(true);
      expect(await alerts.claimStreamAlert(s.channelId, null)).toBe(false);
      // Another channel is its own row.
      const other = await createChannel(s.serverId, "other", "voice");
      expect(await alerts.claimStreamAlert(other.id, null)).toBe(true);
      // Move the row past the cooldown and it opens again.
      await getPool().query(
        `UPDATE stream_alert_channels SET last_notified_at = NOW() - make_interval(secs => $2)
          WHERE channel_id = $1`,
        [s.channelId, STREAM_START_CHANNEL_COOLDOWN_MS / 1000 + 1],
      );
      expect(await alerts.claimStreamAlert(s.channelId, null)).toBe(true);
    });

    it("never lets the same party claim twice, even past the cooldown", async () => {
      const s = await scene(2);
      const session = randomUUID();
      expect(await alerts.claimStreamAlert(s.channelId, session)).toBe(true);
      await getPool().query(
        `UPDATE stream_alert_channels SET last_notified_at = NOW() - INTERVAL '2 hours'
          WHERE channel_id = $1`,
        [s.channelId],
      );
      expect(await alerts.claimStreamAlert(s.channelId, session)).toBe(false);
      expect(await alerts.claimStreamAlert(s.channelId, randomUUID())).toBe(true);
    });

    it("exactly one of many simultaneous claims wins", async () => {
      const s = await scene(2);
      const results = await Promise.all(
        Array.from({ length: 12 }, () => alerts.claimStreamAlert(s.channelId, null)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });

  describe("the 20 second debounce and the flags", () => {
    async function settle(check: () => boolean): Promise<void> {
      const deadline = Date.now() + 5_000;
      while (!check()) {
        if (Date.now() > deadline) {
          throw new Error("timed out waiting for the notice pipeline");
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    function listener(userId: string): { frames: Record<string, unknown>[] } {
      const frames: Record<string, unknown>[] = [];
      const socket = {
        readyState: 1,
        send: (payload: string) => frames.push(JSON.parse(payload) as Record<string, unknown>),
        on: () => {},
      } as unknown as WebSocket;
      created.push(socket);
      setAuthenticatedSocket(socket, { id: userId, display_name: "x", avatar_url: null } as never);
      return { frames };
    }

    async function armed(s: Scene, sharing = true) {
      process.env.STREAM_START_NOTIFICATIONS = "true";
      alerts.setStreamAlertRoomReader(async () => ({
        userIds: [s.sharerId],
        sharerUserIds: sharing ? [s.sharerId] : [],
      }));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      alerts.noteStreamStarted({
        channelId: s.channelId,
        sharerUserId: s.sharerId,
        sharerName: "Alberto",
        kind: "voice",
      });
    }

    it("a share that stops at 10 s notifies nobody and is counted", async () => {
      const s = await scene(5);
      await armed(s);
      expect(alerts.armedStreamAlertCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      alerts.noteStreamStopped(s.channelId, s.sharerId);
      await vi.advanceTimersByTimeAsync(STREAM_START_STABLE_MS);
      expect(alerts.armedStreamAlertCount()).toBe(0);
      const m = alerts.streamAlertMetrics();
      expect(m).toMatchObject({ starts: 1, debounced: 1, claimed: 0 });
      expect(pushed).not.toHaveBeenCalled();
    });

    it("a share that is gone from the room when the 20 s are up notifies nobody", async () => {
      const s = await scene(5);
      await armed(s, false);
      await vi.advanceTimersByTimeAsync(STREAM_START_STABLE_MS);
      await settle(() => alerts.streamAlertMetrics().debounced === 1);
      expect(alerts.streamAlertMetrics().claimed).toBe(0);
    });

    it("a stable share tells the members, once, on their sockets and by push", async () => {
      const s = await scene(5);
      const [a, b] = s.memberIds;
      const first = listener(a!);
      const second = listener(b!);
      const sharerSocket = listener(s.sharerId);
      await armed(s);
      await vi.advanceTimersByTimeAsync(STREAM_START_STABLE_MS - 1);
      expect(first.frames).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await settle(() => alerts.streamAlertMetrics().claimed === 1 && first.frames.length === 1);
      expect(first.frames[0]).toMatchObject({
        type: "stream-started",
        serverId: s.serverId,
        channelId: s.channelId,
        channelName: "filminho",
        serverName: "Filminho",
        sharerName: "sharer",
        kind: "voice",
      });
      expect(second.frames).toHaveLength(1);
      expect(sharerSocket.frames).toEqual([]);
      const m = alerts.streamAlertMetrics();
      expect(m.recipients).toBe(5);
      expect(m.delivered).toBe(2);
      expect(pushed).toHaveBeenCalledTimes(1);
      expect(pushed.mock.calls[0]![0]).toMatchObject({
        serverId: s.serverId,
        channelId: s.channelId,
        channelLabel: "#filminho",
        sharerName: "sharer",
      });
      expect((pushed.mock.calls[0]![0] as { userIds: string[] }).userIds).toHaveLength(5);
    });

    it("a second share in the cooldown window tells nobody", async () => {
      const s = await scene(3);
      await armed(s);
      await vi.advanceTimersByTimeAsync(STREAM_START_STABLE_MS);
      // The whole first notice, not only its claim: the fake clock below would
      // otherwise run out the first notice's own database timeouts.
      await settle(() => alerts.streamAlertMetrics().recipients === 3);
      alerts.noteStreamStarted({
        channelId: s.channelId,
        sharerUserId: s.sharerId,
        sharerName: "Alberto",
        kind: "voice",
      });
      await vi.advanceTimersByTimeAsync(STREAM_START_STABLE_MS);
      await settle(() => alerts.streamAlertMetrics().cooldown === 1);
      expect(alerts.streamAlertMetrics().claimed).toBe(1);
    });

    it("with the flag off at the start nothing is armed", async () => {
      const s = await scene(3);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      alerts.noteStreamStarted({
        channelId: s.channelId,
        sharerUserId: s.sharerId,
        sharerName: "Alberto",
        kind: "voice",
      });
      expect(alerts.armedStreamAlertCount()).toBe(0);
      expect(alerts.streamAlertMetrics()).toMatchObject({ starts: 0, flagOff: 1 });
    });

    it("a flag turned off inside the 20 s sends nothing", async () => {
      const s = await scene(3);
      await armed(s);
      delete process.env.STREAM_START_NOTIFICATIONS;
      await vi.advanceTimersByTimeAsync(STREAM_START_STABLE_MS);
      await settle(() => alerts.streamAlertMetrics().flagOff === 1);
      expect(alerts.streamAlertMetrics().claimed).toBe(0);
      expect(pushed).not.toHaveBeenCalled();
    });

    it("a share in a text channel's id, or a conversation's, is never a notice", async () => {
      const s = await scene(3);
      const text = await createChannel(s.serverId, "chat", "text");
      process.env.STREAM_START_NOTIFICATIONS = "true";
      alerts.setStreamAlertRoomReader(async () => ({
        userIds: [],
        sharerUserIds: [s.sharerId],
      }));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      alerts.noteStreamStarted({
        channelId: text.id,
        sharerUserId: s.sharerId,
        sharerName: "Alberto",
        kind: "voice",
      });
      alerts.noteStreamStarted({
        channelId: randomUUID(),
        sharerUserId: s.sharerId,
        sharerName: "Alberto",
        kind: "voice",
      });
      await vi.advanceTimersByTimeAsync(STREAM_START_STABLE_MS);
      // Real timers again: the pipeline's reads are real I/O and need a moment.
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(alerts.streamAlertMetrics().claimed).toBe(0);
      expect(alerts.armedStreamAlertCount()).toBe(0);
    });

    it("a decision that throws after the claim hands the claim back and retries once, so the notice is late and not lost", async () => {
      const s = await scene(3);
      const [a] = s.memberIds;
      const first = listener(a!);
      await armed(s);
      const pool = getPool();
      const real = pool.query.bind(pool);
      let failuresLeft = 1;
      const spy = vi.spyOn(pool, "query").mockImplementation(((text: unknown, ...rest: unknown[]) => {
        if (
          failuresLeft > 0 &&
          typeof text === "string" &&
          text.includes("FROM server_members sm") &&
          text.includes("user_preferences")
        ) {
          failuresLeft -= 1;
          return Promise.reject(new Error("connection terminated"));
        }
        return (real as (...args: unknown[]) => unknown)(text, ...rest);
      }) as never);
      try {
        await vi.advanceTimersByTimeAsync(STREAM_START_STABLE_MS);
        await settle(() => alerts.streamAlertMetrics().failures === 1);
        expect(first.frames).toEqual([]);
        // The claim was handed back: the next caller is not told "cooldown".
        const row = await pool.query<{ released: boolean }>(
          `SELECT last_notified_at < NOW() - INTERVAL '1 day' AS released
             FROM stream_alert_channels WHERE channel_id = $1`,
          [s.channelId],
        );
        expect(row.rows[0]?.released).toBe(true);
        expect(alerts.armedStreamAlertCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(alerts.STREAM_ALERT_RETRY_MS);
        await settle(() => first.frames.length === 1);
        expect(alerts.streamAlertMetrics()).toMatchObject({ claimed: 2, failures: 1 });
        // And only once: a retried notice is not retried again.
        expect(alerts.armedStreamAlertCount()).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });

    it("a failure that repeats on the retry gives up, and the third attempt does not exist", async () => {
      const s = await scene(2);
      await armed(s);
      const pool = getPool();
      const real = pool.query.bind(pool);
      const spy = vi.spyOn(pool, "query").mockImplementation(((text: unknown, ...rest: unknown[]) => {
        if (typeof text === "string" && text.includes("FROM server_members sm") && text.includes("user_preferences")) {
          return Promise.reject(new Error("still down"));
        }
        return (real as (...args: unknown[]) => unknown)(text, ...rest);
      }) as never);
      try {
        await vi.advanceTimersByTimeAsync(STREAM_START_STABLE_MS);
        await settle(() => alerts.streamAlertMetrics().failures === 1);
        await vi.advanceTimersByTimeAsync(alerts.STREAM_ALERT_RETRY_MS);
        await settle(() => alerts.streamAlertMetrics().failures === 2);
        await vi.advanceTimersByTimeAsync(alerts.STREAM_ALERT_RETRY_MS * 4);
        await new Promise((resolve) => setImmediate(resolve));
        expect(alerts.streamAlertMetrics().failures).toBe(2);
        expect(alerts.armedStreamAlertCount()).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });

    it("a watch party's notice is not cancelled by a share stopping in its room", async () => {
      const s = await scene(2);
      const party = await createChannel(s.serverId, "party", "watch_party");
      process.env.STREAM_START_NOTIFICATIONS = "true";
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      alerts.noteStreamStarted({
        channelId: party.id,
        sharerUserId: s.sharerId,
        sharerName: "Alberto",
        kind: "party",
        startKey: randomUUID(),
      });
      // The host's share restarting (or a guest's stopping) is not the party ending.
      alerts.noteStreamStopped(party.id, s.sharerId);
      alerts.noteStreamStopped(party.id, s.memberIds[0]!);
      alerts.noteStreamStopped(party.id);
      expect(alerts.armedStreamAlertCount()).toBe(1);
      expect(alerts.streamAlertMetrics().debounced).toBe(0);
    });

    it("a party whose room cannot be read is not announced to people who might be sitting in it", async () => {
      const s = await scene(2);
      const party = await createChannel(s.serverId, "party", "watch_party");
      const session = await getPool().query<{ id: string }>(
        `INSERT INTO channel_sessions (channel_id, server_id, title, starts_at, status, created_by, host_user_id)
         VALUES ($1, $2, 'Cinemoon', NOW(), 'live', $3, $3) RETURNING id`,
        [party.id, s.serverId, s.sharerId],
      );
      process.env.STREAM_START_NOTIFICATIONS = "true";
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const start = () =>
        alerts.noteStreamStarted({
          channelId: party.id,
          sharerUserId: s.sharerId,
          sharerName: "Alberto",
          kind: "party",
          startKey: session.rows[0]!.id,
        });
      // No reader at all, then a reader that fails: neither is "an empty room".
      start();
      await vi.advanceTimersByTimeAsync(STREAM_START_STABLE_MS);
      await settle(() => alerts.streamAlertMetrics().debounced === 1);
      alerts.setStreamAlertRoomReader(async () => {
        throw new Error("registry unreachable");
      });
      start();
      await vi.advanceTimersByTimeAsync(STREAM_START_STABLE_MS);
      await settle(() => alerts.streamAlertMetrics().debounced === 2);
      expect(alerts.streamAlertMetrics().claimed).toBe(0);
    });

    it("tidies old claims at most once an hour, however many notices win", async () => {
      const s = await scene(2);
      const second = await createChannel(s.serverId, "outro", "voice");
      process.env.STREAM_START_NOTIFICATIONS = "true";
      alerts.setStreamAlertRoomReader(async () => ({
        userIds: [s.sharerId],
        sharerUserIds: [s.sharerId],
      }));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pool = getPool();
      const real = pool.query.bind(pool);
      let deletes = 0;
      const spy = vi.spyOn(pool, "query").mockImplementation(((text: unknown, ...rest: unknown[]) => {
        if (typeof text === "string" && text.includes("DELETE FROM stream_alert_channels")) {
          deletes += 1;
        }
        return (real as (...args: unknown[]) => unknown)(text, ...rest);
      }) as never);
      try {
        for (const channelId of [s.channelId, second.id]) {
          alerts.noteStreamStarted({
            channelId,
            sharerUserId: s.sharerId,
            sharerName: "Alberto",
            kind: "voice",
          });
        }
        await vi.advanceTimersByTimeAsync(STREAM_START_STABLE_MS);
        await settle(() => alerts.streamAlertMetrics().claimed === 2);
        await new Promise((resolve) => setImmediate(resolve));
        expect(deletes).toBe(1);
      } finally {
        spy.mockRestore();
      }
    });

    it("a party notice carries the party's name and needs the session to be live", async () => {
      const s = await scene(2);
      const party = await createChannel(s.serverId, "party", "watch_party");
      const session = await getPool().query<{ id: string }>(
        `INSERT INTO channel_sessions (channel_id, server_id, title, starts_at, status, created_by, host_user_id)
         VALUES ($1, $2, 'Cinemoon', NOW(), 'live', $3, $3) RETURNING id`,
        [party.id, s.serverId, s.sharerId],
      );
      const listening = listener(s.memberIds[0]!);
      process.env.STREAM_START_NOTIFICATIONS = "true";
      alerts.setStreamAlertRoomReader(async () => ({ userIds: [], sharerUserIds: [] }));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      alerts.noteStreamStarted({
        channelId: party.id,
        sharerUserId: s.sharerId,
        sharerName: "Alberto",
        kind: "party",
        startKey: session.rows[0]!.id,
        partyName: "Cinemoon",
      });
      // Repeating the broadcast for the same party does not arm a second timer.
      alerts.noteStreamStarted({
        channelId: party.id,
        sharerUserId: s.sharerId,
        sharerName: "Alberto",
        kind: "party",
        startKey: session.rows[0]!.id,
        partyName: "Cinemoon",
      });
      expect(alerts.armedStreamAlertCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(STREAM_START_STABLE_MS);
      await settle(() => listening.frames.length === 1);
      expect(listening.frames[0]).toMatchObject({
        kind: "party",
        channelName: "Cinemoon",
        sharerName: "sharer",
      });
      expect((pushed.mock.calls[0]![0] as { channelLabel: string }).channelLabel).toBe("Cinemoon");
    });

    it("a party that ended inside the window is not announced", async () => {
      const s = await scene(2);
      const party = await createChannel(s.serverId, "party", "watch_party");
      const session = await getPool().query<{ id: string }>(
        `INSERT INTO channel_sessions (channel_id, server_id, title, starts_at, status, created_by, host_user_id)
         VALUES ($1, $2, 'Cinemoon', NOW(), 'ended', $3, $3) RETURNING id`,
        [party.id, s.serverId, s.sharerId],
      );
      process.env.STREAM_START_NOTIFICATIONS = "true";
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      alerts.noteStreamStarted({
        channelId: party.id,
        sharerUserId: s.sharerId,
        sharerName: "Alberto",
        kind: "party",
        startKey: session.rows[0]!.id,
      });
      await vi.advanceTimersByTimeAsync(STREAM_START_STABLE_MS);
      await settle(() => alerts.streamAlertMetrics().debounced === 1);
      expect(alerts.streamAlertMetrics().claimed).toBe(0);
    });
  });

  describe("the hot path", () => {
    it("does no database work and walks no sockets when a share starts or stops", async () => {
      const s = await scene(3);
      process.env.STREAM_START_NOTIFICATIONS = "true";
      const sockets = await import("../ws/sockets.js");
      const walk = vi.spyOn(sockets, "forEachSocketOfUser");
      const query = vi.spyOn(getPool(), "query");
      try {
        alerts.noteStreamStarted({
          channelId: s.channelId,
          sharerUserId: s.sharerId,
          sharerName: "Alberto",
          kind: "voice",
        });
        alerts.noteStreamStarted({
          channelId: s.channelId,
          sharerUserId: s.sharerId,
          sharerName: "Alberto",
          kind: "voice",
        });
        alerts.noteStreamStopped(s.channelId, s.sharerId);
        expect(query).not.toHaveBeenCalled();
        expect(walk).not.toHaveBeenCalled();
      } finally {
        query.mockRestore();
        walk.mockRestore();
      }
    });

    it("bounds the timers it holds", () => {
      process.env.STREAM_START_NOTIFICATIONS = "true";
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      for (let i = 0; i < 2_100; i += 1) {
        alerts.noteStreamStarted({
          channelId: randomUUID(),
          sharerUserId: randomUUID(),
          sharerName: "x",
          kind: "voice",
        });
      }
      expect(alerts.armedStreamAlertCount()).toBe(2_000);
      expect(alerts.streamAlertMetrics().failures).toBe(100);
    });
  });
});

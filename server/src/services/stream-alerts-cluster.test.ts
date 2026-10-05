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
import type { DbUser } from "../db.js";
import { createMemoryHub } from "../lib/bus.js";
import { STREAM_START_STABLE_MS } from "@pqp/shared";

/**
 * ONE SHARE, TWO API MACHINES, ONE NOTICE.
 *
 * Production runs two `pqp-api` containers with no session affinity. A share
 * can be SEEN by both: the sharer's socket drops and comes back on the other
 * machine inside the 20 second window, and the re-declare there is a start as
 * far as that machine can tell. Both arm a timer and both fire. The claim on
 * `stream_alert_channels` is what keeps that to one notice, and the relay on
 * the bus is what gets that one notice onto the OTHER machine's sockets.
 *
 * Two real module graphs over one memory hub (each with its own pool, sockets
 * and bus subscription), real Postgres because the claim is one SQL statement
 * and a fake would prove nothing about it. Push is a spy, shared by both
 * graphs: the assertion is that the machine that claimed sent it and the one
 * that relayed did not.
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

type BusModule = typeof import("../lib/bus.js");
type AlertsModule = typeof import("./stream-alerts.js");
type SocketsModule = typeof import("../ws/sockets.js");
type DbModule = typeof import("../db.js");
type ServersModule = typeof import("./servers.js");
type UsersModule = typeof import("./users.js");

interface Instance {
  bus: BusModule;
  alerts: AlertsModule;
  sockets: SocketsModule;
  db: DbModule;
  servers: ServersModule;
  users: UsersModule;
}

const hub = createMemoryHub();
const booted: Instance[] = [];

async function bootInstance(): Promise<Instance> {
  vi.resetModules();
  const bus = (await import("../lib/bus.js")) as BusModule;
  const db = (await import("../db.js")) as DbModule;
  const alerts = (await import("./stream-alerts.js")) as AlertsModule;
  const sockets = (await import("../ws/sockets.js")) as SocketsModule;
  const servers = (await import("./servers.js")) as ServersModule;
  const users = (await import("./users.js")) as UsersModule;
  bus.setBusTransport(bus.createMemoryTransport(hub));
  const instance = { bus, alerts, sockets, db, servers, users };
  booted.push(instance);
  return instance;
}

interface Frame {
  type: string;
  [key: string]: unknown;
}

function recorder(): { socket: WebSocket; frames: Frame[] } {
  const frames: Frame[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => frames.push(JSON.parse(payload) as Frame),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, frames };
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function asUser(id: string): DbUser {
  return { id, display_name: "x", avatar_url: null } as unknown as DbUser;
}

describeDb("one share seen by two API machines", () => {
  let a: Instance;
  let b: Instance;
  let sharerId: string;
  let onA: string;
  let onB: string;
  let onBoth: string;
  let serverId: string;
  let channelId: string;

  beforeAll(async () => {
    vi.resetModules();
    const db = (await import("../db.js")) as DbModule;
    await db.initDb();
    await db.closePool();
  });

  afterAll(async () => {
    for (const instance of booted) {
      await instance.db.closePool().catch(() => {});
    }
  });

  beforeEach(async () => {
    pushed.mockClear();
    process.env.STREAM_START_NOTIFICATIONS = "true";
    a = await bootInstance();
    b = await bootInstance();
    await a.db.getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    const make = async (name: string) =>
      (await a.users.upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null })).id;
    sharerId = await make("Alberto");
    onA = await make("onA");
    onB = await make("onB");
    onBoth = await make("onBoth");
    const { server } = await a.servers.createServer("Filminho", sharerId);
    serverId = server.id;
    const channel = await a.servers.createChannel(serverId, "filminho", "voice");
    channelId = channel.id;
    for (const id of [onA, onB, onBoth]) {
      await a.db.getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [serverId, id],
      );
    }
    // Both machines can see the room's roster (the registry is on in
    // production): the sharer is seated and sharing.
    for (const instance of [a, b]) {
      instance.alerts.setStreamAlertRoomReader(async () => ({
        userIds: [sharerId],
        sharerUserIds: [sharerId],
      }));
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.STREAM_START_NOTIFICATIONS;
    for (const instance of booted.splice(0)) {
      instance.alerts.resetStreamAlertsForTests();
      await instance.bus.closeBus().catch(() => {});
      await instance.db.closePool().catch(() => {});
    }
  });

  it("claims once, delivers once per socket on each machine, and pushes once", async () => {
    const recA = recorder();
    const recB = recorder();
    const bothOnA = recorder();
    const bothOnB = recorder();
    a.sockets.setAuthenticatedSocket(recA.socket, asUser(onA));
    b.sockets.setAuthenticatedSocket(recB.socket, asUser(onB));
    a.sockets.setAuthenticatedSocket(bothOnA.socket, asUser(onBoth));
    b.sockets.setAuthenticatedSocket(bothOnB.socket, asUser(onBoth));

    // Both machines saw the share start.
    for (const instance of [a, b]) {
      instance.alerts.noteStreamStarted({
        channelId,
        sharerUserId: sharerId,
        sharerName: "Alberto",
        kind: "voice",
      });
    }
    expect(a.alerts.armedStreamAlertCount()).toBe(1);
    expect(b.alerts.armedStreamAlertCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(STREAM_START_STABLE_MS);
    await waitFor(
      () =>
        recA.frames.length === 1 &&
        recB.frames.length === 1 &&
        bothOnA.frames.length === 1 &&
        bothOnB.frames.length === 1,
      "the notice to reach every socket",
    );
    // Give a duplicate every chance to arrive before asserting there is none.
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 150));

    for (const rec of [recA, recB, bothOnA, bothOnB]) {
      expect(rec.frames).toHaveLength(1);
      expect(rec.frames[0]).toMatchObject({
        type: "stream-started",
        serverId,
        channelId,
        channelName: "filminho",
        sharerName: "Alberto",
        kind: "voice",
      });
    }

    const claimed =
      a.alerts.streamAlertMetrics().claimed + b.alerts.streamAlertMetrics().claimed;
    const cooled =
      a.alerts.streamAlertMetrics().cooldown + b.alerts.streamAlertMetrics().cooldown;
    expect(claimed).toBe(1);
    expect(cooled).toBe(1);
    const rows = await a.db
      .getPool()
      .query(`SELECT 1 FROM stream_alert_channels WHERE channel_id = $1`, [channelId]);
    expect(rows.rowCount).toBe(1);

    // The machine that lost the race delivered only what the winner relayed.
    const winner = a.alerts.streamAlertMetrics().claimed === 1 ? a : b;
    const loser = winner === a ? b : a;
    expect(winner.alerts.streamAlertMetrics().relayed).toBe(1);
    expect(loser.alerts.streamAlertMetrics().relayed).toBe(0);
    // One push, from the claimer, whatever machine the phones were "on".
    expect(pushed).toHaveBeenCalledTimes(1);
  });

  it("a retried relay frame shows nobody a second notice", async () => {
    const recB = recorder();
    b.sockets.setAuthenticatedSocket(recB.socket, asUser(onB));
    a.alerts.noteStreamStarted({
      channelId,
      sharerUserId: sharerId,
      sharerName: "Alberto",
      kind: "voice",
    });
    await vi.advanceTimersByTimeAsync(STREAM_START_STABLE_MS);
    await waitFor(() => recB.frames.length === 1, "the relayed notice");

    a.bus.publishToCluster("stream-alert.deliver", {
      serverId,
      channelId,
      channelName: "filminho",
      serverName: "Filminho",
      sharerName: "Alberto",
      kind: "voice",
      startedAt: recB.frames[0]!.startedAt as number,
      userIds: [onB],
    });
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(recB.frames).toHaveLength(1);
  });

  it("ignores a malformed relayed frame", async () => {
    const recB = recorder();
    b.sockets.setAuthenticatedSocket(recB.socket, asUser(onB));
    a.bus.publishToCluster("stream-alert.deliver", { channelId, userIds: [onB] });
    a.bus.publishToCluster("stream-alert.deliver", null);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(recB.frames).toEqual([]);
  });
});

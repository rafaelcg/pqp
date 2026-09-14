import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";
import { createMemoryHub } from "../lib/bus.js";

/**
 * THE HOST'S GRACE CLOCK, ACROSS TWO MACHINES.
 *
 * `onHostSocketClosed` starts the five-minute clock that `sweepWatchPartyHosts`
 * eventually acts on, and it starts it on one condition: this was the host's
 * LAST socket. Until this suite that question was answered out of
 * `userHasAuthenticatedSocket`, which is this process's socket map and nothing
 * else. With two API machines behind one proxy the laptop and the phone land
 * wherever the load balancer puts them, so a host closing the laptop tab on A
 * looked, from B, exactly like a host who had gone home — B stamped
 * `host_disconnected_at` and the sweep ended a live party with its host sitting
 * right there watching it.
 *
 * The harness is the one `cluster.test.ts` uses (two module graphs over one
 * memory hub, so each "instance" has genuinely separate socket and status
 * maps), on a real Postgres because the stamp is a row and the absence of the
 * stamp is the assertion. Skips without a database, like the other cluster
 * suites.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

type BusModule = typeof import("../lib/bus.js");
type SocketsModule = typeof import("./sockets.js");
type StatusModule = typeof import("./status.js");
type EventsModule = typeof import("./watch-party-events.js");
type DbModule = typeof import("../db.js");

interface Instance {
  bus: BusModule;
  sockets: SocketsModule;
  status: StatusModule;
  events: EventsModule;
  db: DbModule;
}

let hub = createMemoryHub();
const booted: Instance[] = [];
const pools: DbModule[] = [];

async function bootInstance(): Promise<Instance> {
  vi.resetModules();
  const bus = (await import("../lib/bus.js")) as BusModule;
  const db = (await import("../db.js")) as DbModule;
  const sockets = (await import("./sockets.js")) as SocketsModule;
  const status = (await import("./status.js")) as StatusModule;
  const events = (await import("./watch-party-events.js")) as EventsModule;
  bus.setBusTransport(bus.createMemoryTransport(hub));
  const instance = { bus, sockets, status, events, db };
  booted.push(instance);
  return instance;
}

function asUser(id: string): DbUser {
  return { id, display_name: "Host", avatar_url: null } as unknown as DbUser;
}

function fakeSocket(): WebSocket {
  return {
    readyState: 1,
    send: () => {},
    on: () => {},
  } as unknown as WebSocket;
}

/** Authenticate a socket on one instance, the way `ws/index.ts` does. */
async function connect(instance: Instance, userId: string): Promise<WebSocket> {
  const socket = fakeSocket();
  instance.sockets.setAuthenticatedSocket(socket, asUser(userId));
  await instance.status.registerStatusSocket(socket, userId);
  return socket;
}

/** Close it, in `ws/index.ts`'s order: status first, then the socket map. */
async function disconnect(
  instance: Instance,
  socket: WebSocket,
  userId: string,
): Promise<void> {
  instance.status.unregisterStatusSocket(socket);
  instance.sockets.deleteAuthenticatedSocket(socket);
  await instance.events.onHostSocketClosed(userId).catch(() => {
    // `announceChannels` reaches the whole broadcast path, which is not what
    // this suite is about. The row below is.
  });
}

async function seedLiveParty(hostId: string): Promise<string> {
  const pool = pools[0]!.getPool();
  const server = await pool.query<{ id: string }>(
    `INSERT INTO servers (name, owner_id) VALUES ('Host presence', $1) RETURNING id`,
    [hostId],
  );
  const serverId = server.rows[0]!.id;
  const channel = await pool.query<{ id: string }>(
    `INSERT INTO channels (server_id, name, type) VALUES ($1, 'cinema', 'watch_party')
      RETURNING id`,
    [serverId],
  );
  const channelId = channel.rows[0]!.id;
  await pool.query(
    `INSERT INTO channel_sessions
       (channel_id, server_id, title, starts_at, status, created_by, host_user_id)
     VALUES ($1, $2, 'Sessão', NOW(), 'live', $3, $3)`,
    [channelId, serverId, hostId],
  );
  return channelId;
}

async function makeUser(): Promise<string> {
  const pool = pools[0]!.getPool();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (clerk_id, username, discriminator, display_name)
     VALUES ($1, $2, '0001', 'Host') RETURNING id`,
    [`clerk_${randomUUID()}`, `host_${randomUUID().slice(0, 8)}`],
  );
  return result.rows[0]!.id;
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function disconnectedAt(channelId: string): Promise<Date | null> {
  const result = await pools[0]!.getPool().query<{
    host_disconnected_at: Date | null;
  }>(`SELECT host_disconnected_at FROM channel_sessions WHERE channel_id = $1`, [
    channelId,
  ]);
  return result.rows[0]?.host_disconnected_at ?? null;
}

describeDb("the watch-party host's grace clock across two instances", () => {
  beforeAll(async () => {
    vi.resetModules();
    const db = (await import("../db.js")) as DbModule;
    await db.initDb();
    pools.push(db);
  });

  afterAll(async () => {
    await Promise.all(pools.map((db) => db.closePool().catch(() => {})));
  });

  beforeEach(() => {
    hub = createMemoryHub();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const instance of booted) {
      instance.events.resetHostPresenceCountersForTests();
      await instance.bus.closeBus();
      await instance.db.closePool().catch(() => {});
    }
    booted.length = 0;
    vi.restoreAllMocks();
  });

  it("B does not start the clock for a host whose only socket is on A", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    const hostId = await makeUser();
    const channelId = await seedLiveParty(hostId);

    await connect(a, hostId);
    // Something of the host's closed on B — a socket B never held, which is
    // exactly what a stray close or a second device's teardown looks like.
    await b.events.onHostSocketClosed(hostId).catch(() => {});

    expect(await disconnectedAt(channelId)).toBeNull();
    // And B knows WHY it said no, which is the counter that would have been
    // zero for a check that never ran.
    expect(b.events.readHostPresenceCounters().heldElsewhere).toBe(1);
  });

  it("closing the laptop on A leaves the clock alone while the phone is on B", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    const hostId = await makeUser();
    const channelId = await seedLiveParty(hostId);

    const laptop = await connect(a, hostId);
    await connect(b, hostId);

    await disconnect(a, laptop, hostId);

    expect(await disconnectedAt(channelId)).toBeNull();
    expect(a.events.readHostPresenceCounters().heldElsewhere).toBe(1);
  });

  it("the last socket anywhere going away does start the clock", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    const hostId = await makeUser();
    const channelId = await seedLiveParty(hostId);

    const laptop = await connect(a, hostId);
    const phone = await connect(b, hostId);

    await disconnect(a, laptop, hostId);
    expect(await disconnectedAt(channelId)).toBeNull();

    await disconnect(b, phone, hostId);
    expect(await disconnectedAt(channelId)).not.toBeNull();
  });

  it("both machines losing the host in the same instant still start the clock", async () => {
    // THE RACE A MERGED PRESENCE VIEW INTRODUCES. Each instance withdraws its
    // contribution over the bus, so for the length of the propagation both
    // can have dropped their own socket and still be holding the other's.
    // Both answer "still connected", neither stamps, and before the re-check
    // nothing would ever ask again: the party would stay live forever.
    const a = await bootInstance();
    const b = await bootInstance();
    a.events.setHostPresenceRecheckMsForTests(20);
    b.events.setHostPresenceRecheckMsForTests(20);
    const hostId = await makeUser();
    const channelId = await seedLiveParty(hostId);

    const laptop = await connect(a, hostId);
    const phone = await connect(b, hostId);

    // Both sockets go, neither withdrawal has crossed yet.
    a.sockets.deleteAuthenticatedSocket(laptop);
    b.sockets.deleteAuthenticatedSocket(phone);
    await a.events.onHostSocketClosed(hostId).catch(() => {});
    await b.events.onHostSocketClosed(hostId).catch(() => {});
    expect(await disconnectedAt(channelId)).toBeNull();

    // The withdrawals land, and the re-check asks the question again.
    a.status.unregisterStatusSocket(laptop);
    b.status.unregisterStatusSocket(phone);
    await waitFor(
      async () => (await disconnectedAt(channelId)) !== null,
      "the grace clock the race swallowed",
    );
  });

  it("one machine behaves exactly as it always did", async () => {
    // The bus is what carries the other instance's contribution, so with it
    // closed this is a single-instance deployment: the local socket map is
    // the whole answer and the cluster half can only agree with it.
    const only = await bootInstance();
    await only.bus.closeBus();
    const hostId = await makeUser();
    const channelId = await seedLiveParty(hostId);

    const tab = await connect(only, hostId);
    const second = await connect(only, hostId);

    await disconnect(only, tab, hostId);
    expect(await disconnectedAt(channelId)).toBeNull();

    await disconnect(only, second, hostId);
    expect(await disconnectedAt(channelId)).not.toBeNull();
    expect(only.events.readHostPresenceCounters().heldElsewhere).toBe(0);
  });
});

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The channel-access read-cache (`services/users.ts`'s `canAccessChannel`),
 * across two "instances" — the multi-process shape `docs/plans/ALWAYS_ON.md`
 * moves to next, with `CLUSTER_BUS=postgres` carrying cross-process events.
 *
 * `permission-caches.test.ts` next door already pins that this cache never
 * outlives a removal WITHIN one process. This file pins the harder property:
 * a write on one process must not leave a SIBLING process answering with a
 * pre-write authorization decision for the cache's TTL. `services/dms.ts`'s
 * hide/restore is the write path that matters here — a conversation has no
 * server, so it never runs through `servers.ts`'s audience chokepoint
 * (`invalidateServerAudience`), which is why it calls
 * `invalidateChannelAccessForChannel` directly, and why that function has to
 * carry its own cross-process fan-out rather than borrowing the chokepoint's.
 *
 * Same two-module-graph technique as `ws/cluster.test.ts`: `vi.resetModules()`
 * gives each "instance" its own copy of every singleton this exercises — the
 * read-cache's `store`/`inflight` maps, `db.ts`'s pooled connection, and
 * `lib/bus.ts`'s instance id — wired together by one shared in-memory bus hub
 * standing in for Postgres LISTEN/NOTIFY.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

type UsersModule = typeof import("./users.js");
type ServersModule = typeof import("./servers.js");
type DmsModule = typeof import("./dms.js");
type BusModule = typeof import("../lib/bus.js");
type DbModule = typeof import("../db.js");

interface Instance {
  users: UsersModule;
  servers: ServersModule;
  dms: DmsModule;
  bus: BusModule;
  db: DbModule;
}

const { createMemoryHub } = await import("../lib/bus.js");
let hub = createMemoryHub();

/** A fresh module graph per call, wired to the shared hub — the same shape
 *  `ws/cluster.test.ts` uses for two chat instances. `withBus: false` skips
 *  installing a transport at all, rather than installing one and swapping it
 *  for `null` afterward: `setBusTransport(null)` only stops this instance's
 *  own `publishToCluster` calls, it does not unregister the memory
 *  transport's `deliver` callback already sitting in `hub.listeners` — this
 *  instance would keep receiving frames it should never see. */
async function bootInstance(
  { withBus = true }: { withBus?: boolean } = {},
): Promise<Instance> {
  vi.resetModules();
  const bus = (await import("../lib/bus.js")) as BusModule;
  const db = (await import("../db.js")) as DbModule;
  const users = (await import("./users.js")) as UsersModule;
  const servers = (await import("./servers.js")) as ServersModule;
  const dms = (await import("./dms.js")) as DmsModule;
  if (withBus) {
    bus.setBusTransport(bus.createMemoryTransport(hub));
  }
  await db.initDb();
  return { bus, dms, db, servers, users };
}

/** Alice and Bob, co-members of a server (the reachability rule
 *  `assertReachable` allows, same setup `dms.test.ts` uses), and the DM
 *  channel between them — created through instance `a`. */
async function makeReachablePair(
  a: Instance,
): Promise<{ aliceId: string; bobId: string; channelId: string }> {
  const alice = await a.users.upsertUser({
    clerkId: `clerk_${Math.random()}_alice`,
    displayName: "Alice",
    avatarUrl: null,
  });
  const bob = await a.users.upsertUser({
    clerkId: `clerk_${Math.random()}_bob`,
    displayName: "Bob",
    avatarUrl: null,
  });
  const { server } = await a.servers.createServer("Shared", alice.id);
  await a.db.getPool().query(
    `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
    [server.id, bob.id],
  );
  const { channelId } = await a.dms.openConversation(alice.id, [bob.id]);
  return { aliceId: alice.id, bobId: bob.id, channelId };
}

describeDb("channel-access cache across two instances", () => {
  beforeEach(() => {
    hub = createMemoryHub();
  });

  afterAll(async () => {
    // Each `bootInstance()` call left behind its own pool on its own module
    // graph; the last one imported is the one still reachable here.
    const { closePool } = await import("../db.js");
    await closePool().catch(() => {});
  });

  it("does not let a sibling instance keep serving a hidden-then-restored DM's pre-write access answer", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    await a.db.getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);

    const { bobId, channelId } = await makeReachablePair(a);

    // Warm B's cache with the pre-hide answer.
    expect(await b.users.canAccessChannel(channelId, bobId)).toBe(true);

    // A hides the conversation on Bob's behalf — the write path that has no
    // server audience chokepoint to ride.
    expect(await a.dms.hideConversation(channelId, bobId)).toBe(true);

    // B must not still be answering from its now-stale cache entry.
    expect(await b.users.canAccessChannel(channelId, bobId)).toBe(false);

    // Restoring it (the other half of the same gap) must clear B's now-false
    // cached answer just as promptly.
    await a.dms.restoreDmParticipants(channelId);
    expect(await b.users.canAccessChannel(channelId, bobId)).toBe(true);
  });

  it("leaves a sibling instance's cache untouched with no bus transport installed", async () => {
    const a = await bootInstance();
    // B never installs a transport — the default, single-process shape.
    const b = await bootInstance({ withBus: false });
    await a.db.getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);

    const { bobId, channelId } = await makeReachablePair(a);

    expect(await b.users.canAccessChannel(channelId, bobId)).toBe(true);
    await a.dms.hideConversation(channelId, bobId);

    // With no transport installed on B, `isBusEnabled()` is false there and
    // `publishToCluster` on A returns before building a frame — the default,
    // documented single-instance behaviour: B's cache is unaware of a write
    // it never heard about, and only its own TTL will catch up. This pins
    // that the cross-process fix does not depend on a transport existing —
    // it degrades to exactly today's behaviour when one is not installed,
    // the same guarantee `lib/bus.ts`'s module doc makes for every topic.
    expect(await b.users.canAccessChannel(channelId, bobId)).toBe(true);
  });
});

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

/**
 * Account termination and auth-cache invalidation across two "instances" —
 * the multi-process shape production will run once a second `pqp-api`
 * machine joins with `CLUSTER_BUS=postgres` (see `docs/plans/ALWAYS_ON.md`).
 *
 * Before this file, both gaps were process-local by construction:
 *
 *  - `DELETE /api/me` / the operator termination route closed the target's
 *    WebSockets by walking `forEachAuthenticatedSocket` — a map that lives on
 *    the process that served the HTTP request. A socket the same account held
 *    open on a SIBLING instance kept receiving message bodies until it
 *    happened to drop on its own.
 *  - `forgetAuthUser` cleared `userCache` / `profileCache` — also per-process
 *    maps. A sibling instance kept authenticating the deleted identity from
 *    cache for up to `PROFILE_TTL_MS`, and `resolveDbUser`'s `upsertUser`
 *    could recreate the row the request just deleted.
 *  - A profile write (rename, avatar) called `invalidateUserCache` locally
 *    only, so a sibling instance kept serving the pre-write `DbUser` row for
 *    up to `USER_TTL_MS`.
 *
 * `evictUserAcrossCluster` and the bus relay on `invalidateUserCache` close
 * both gaps by publishing over `CLUSTER_BUS` and applying the identical local
 * effect on every instance that receives the frame. Same two-module-graph
 * technique as `ws/cluster.test.ts` and
 * `services/permission-caches-cluster.test.ts`: `vi.resetModules()` gives
 * each "instance" its own copy of every singleton this exercises —
 * `clerk.ts`'s caches, `ws/sockets.ts`'s socket map, and `lib/bus.ts`'s
 * instance id — wired together by one shared in-memory bus hub standing in
 * for Postgres LISTEN/NOTIFY.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
// `deleteAccount` skips the real Clerk API for a `dev_local_user`-prefixed
// clerk id only under the bypass — see `deleteClerkUser` in clerk.ts. Without
// this every call in this file would need a live Clerk secret key.
process.env.DEV_AUTH_BYPASS = "true";

type ClerkModule = typeof import("./clerk.js");
type BusModule = typeof import("../lib/bus.js");
type SocketsModule = typeof import("../ws/sockets.js");
type DbModule = typeof import("../db.js");
type UsersModule = typeof import("../services/users.js");
type AccountModule = typeof import("../services/account.js");

interface Instance {
  clerk: ClerkModule;
  bus: BusModule;
  sockets: SocketsModule;
  db: DbModule;
  users: UsersModule;
  account: AccountModule;
}

const { createMemoryHub } = await import("../lib/bus.js");
let hub = createMemoryHub();

/**
 * A fresh module graph per call, wired to the shared hub. `withBus: false`
 * skips installing a transport at all rather than installing one and tearing
 * it down afterward — `setBusTransport(null)` would not unregister the
 * memory transport's `deliver` callback already sitting in `hub.listeners`.
 */
async function bootInstance(
  { withBus = true }: { withBus?: boolean } = {},
): Promise<Instance> {
  vi.resetModules();
  const bus = (await import("../lib/bus.js")) as BusModule;
  const db = (await import("../db.js")) as DbModule;
  const sockets = (await import("../ws/sockets.js")) as SocketsModule;
  const clerk = (await import("./clerk.js")) as ClerkModule;
  const users = (await import("../services/users.js")) as UsersModule;
  const account = (await import("../services/account.js")) as AccountModule;
  if (withBus) {
    bus.setBusTransport(bus.createMemoryTransport(hub));
  }
  await db.initDb();
  return { bus, db, sockets, clerk, users, account };
}

interface Recorder {
  socket: WebSocket;
  closes: { code: number; reason: string }[];
}

function recordingSocket(): Recorder {
  const closes: { code: number; reason: string }[] = [];
  const socket = {
    readyState: 1,
    send: () => {},
    close: (code: number, reason: string) => closes.push({ code, reason }),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, closes };
}

describeDb("account termination and auth-cache invalidation across two instances", () => {
  beforeEach(() => {
    hub = createMemoryHub();
  });

  afterAll(async () => {
    // Each `bootInstance()` call left behind its own pool on its own module
    // graph; the last one imported is the one still reachable here.
    const { closePool } = await import("../db.js");
    await closePool().catch(() => {});
  });

  it("closes a socket on B and empties B's caches when the account is terminated on A, without double-closing A's own socket", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    await a.db.getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);

    const clerkId = "dev_local_user_term1";
    const created = await a.users.upsertUser({
      clerkId,
      displayName: "Term One",
      avatarUrl: null,
    });

    // Warm B's auth caches (and register a live socket there) the way a real
    // request on B would. `resolveDbUser` populates `userCache` before the
    // age gate is even checked, so this warms the cache regardless of a
    // fresh dev-bypass account's (pending) gate status — see `clerk.test.ts`
    // for the same pattern.
    await b.clerk.resolveAuthUser("Bearer dev-local-token:term1");
    expect(b.clerk.authCacheSizes().users).toBe(1);
    const remote = recordingSocket();
    b.sockets.setAuthenticatedSocket(remote.socket, created);

    // A's own socket, to pin that the origin guard stops the bus echo from
    // closing it a second time.
    const local = recordingSocket();
    a.sockets.setAuthenticatedSocket(local.socket, created);

    await a.account.deleteAccount(created.id, created.clerk_id);

    // B: the socket closed with the exact wire values the local path always
    // used, and every cache trace of the identity is gone.
    expect(remote.closes).toEqual([{ code: 4003, reason: "account deleted" }]);
    expect(b.clerk.authCacheSizes()).toEqual({ profiles: 0, users: 0 });
    // Proof the relay actually ran (pitfall 12 in CLAUDE.md) — not just that
    // the socket happened to close for some other reason.
    expect(b.clerk.authClusterRelayCounts().evictions).toBe(1);

    // A: closed exactly once — the direct local call, not the echo of its
    // own published frame (which `bus.ts`'s origin guard drops before any
    // subscriber runs).
    expect(local.closes).toEqual([{ code: 4003, reason: "account deleted" }]);
    expect(a.clerk.authClusterRelayCounts().evictions).toBe(0);
  });

  it("drops B's cached profile when a profile write invalidates it on A", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    await a.db.getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);

    const clerkId = "dev_local_user_prof1";
    await a.users.upsertUser({
      clerkId,
      displayName: "Prof One",
      avatarUrl: null,
    });

    // Warm B's `userCache` the way a real request on B would.
    await b.clerk.resolveAuthUser("Bearer dev-local-token:prof1");
    expect(b.clerk.authCacheSizes().users).toBe(1);

    a.clerk.invalidateUserCache(clerkId);

    expect(b.clerk.authCacheSizes().users).toBe(0);
    expect(b.clerk.authClusterRelayCounts().invalidations).toBe(1);
  });

  it("leaves a sibling instance's sockets and caches untouched with no bus transport installed", async () => {
    const a = await bootInstance();
    // B never installs a transport — the default, single-process shape.
    const b = await bootInstance({ withBus: false });
    await a.db.getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);

    const clerkId = "dev_local_user_nobus1";
    const created = await a.users.upsertUser({
      clerkId,
      displayName: "No Bus",
      avatarUrl: null,
    });

    await b.clerk.resolveAuthUser("Bearer dev-local-token:nobus1");
    expect(b.clerk.authCacheSizes().users).toBe(1);
    const remote = recordingSocket();
    b.sockets.setAuthenticatedSocket(remote.socket, created);

    await a.account.deleteAccount(created.id, created.clerk_id);

    // Single-instance behaviour unchanged: nothing crosses with the bus off.
    expect(remote.closes).toEqual([]);
    expect(b.clerk.authCacheSizes().users).toBe(1);
  });
});

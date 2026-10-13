import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { WebSocket } from "ws";
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

/**
 * Each person's own order of the server rail, over HTTP against a real
 * Postgres.
 *
 * What is pinned:
 *  - until somebody drags, the list is what it always was (creation date), so
 *    shipping the column moved nobody's rail;
 *  - a save is per person: another member of the same servers keeps theirs;
 *  - the order is read back by `GET /api/servers`, and survives;
 *  - a stale save is tolerated, not refused: an id the caller does not hold
 *    (left, someone else's) is dropped, and a server joined since lands after
 *    the named ones;
 *  - a server joined after a save goes to the BOTTOM;
 *  - the account's other sockets are told, with the saver's `origin`, and the
 *    frame reaches nobody else; with the bus on it also crosses instances.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const stubs = vi.hoisted(() => ({
  actor: null as { id: string; clerk_id: string } | null,
}));

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  forgetAuthUser: () => {},
  deleteClerkUser: async () => {},
  resolveAuthUser: async () => (stubs.actor ? { user: stubs.actor } : null),
  resolveAuthSession: async () =>
    stubs.actor ? { user: stubs.actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { setAuthenticatedSocket, deleteAuthenticatedSocket } = await import(
  "../ws/sockets.js"
);
const bus = await import("../lib/bus.js");

type Actor = { id: string; clerk_id: string };
type FakeSocket = WebSocket & { frames: { type: string }[] };

let server: Server;
let baseUrl: string;

async function call(
  as: Actor,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  stubs.actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: "Bearer session",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

async function railOf(as: Actor): Promise<string[]> {
  const { json } = await call(as, "GET", "/api/servers");
  return (json.servers as { name: string }[]).map((s) => s.name);
}

function fakeSocket(): FakeSocket {
  const frames: { type: string }[] = [];
  return {
    readyState: 1,
    frames,
    send: (data: string) => {
      frames.push(JSON.parse(data) as { type: string });
    },
  } as unknown as FakeSocket;
}

function orderFrames(socket: FakeSocket): unknown[] {
  return socket.frames.filter((frame) => frame.type === "server-order-update");
}

describeDb("the server rail order, per person", () => {
  let rafa: Actor;
  let bia: Actor;
  const ids: Record<string, string> = {};
  const open: FakeSocket[] = [];
  const busFrames: { topic: string; data: unknown }[] = [];
  let stopObserving: (() => void) | null = null;
  const hub = bus.createMemoryHub();

  function connect(user: Actor): FakeSocket {
    const socket = fakeSocket();
    setAuthenticatedSocket(socket, {
      id: user.id,
      clerk_id: user.clerk_id,
      display_name: user.id,
      username: user.id,
      discriminator: "0001",
      avatar_url: null,
    } as never);
    open.push(socket);
    return socket;
  }

  async function makeServer(name: string, createdAt: string, members: Actor[]) {
    const pool = getPool();
    const created = await pool.query<{ id: string }>(
      `INSERT INTO servers (name, owner_id, created_at) VALUES ($1, $2, $3) RETURNING id`,
      [name, members[0]!.id, createdAt],
    );
    ids[name] = created.rows[0]!.id;
    for (const [index, member] of members.entries()) {
      await pool.query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, $3)`,
        [ids[name], member.id, index === 0 ? "owner" : "member"],
      );
    }
  }

  beforeAll(async () => {
    await initDb();
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => server.listen(0, done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    bus.setBusTransport(bus.createMemoryTransport(hub));
    stopObserving = bus.observeBusFrames((frame) => {
      busFrames.push({ topic: frame.topic, data: frame.data });
    });
  });

  afterAll(async () => {
    stopObserving?.();
    bus.setBusTransport(null);
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    busFrames.length = 0;
    const pool = getPool();
    await pool.query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    rafa = await upsertUser({ clerkId: "clerk-rafa", displayName: "Rafa", avatarUrl: null });
    bia = await upsertUser({ clerkId: "clerk-bia", displayName: "Bia", avatarUrl: null });
    // Created A, B, C, D in that order: the rail's order before anybody drags.
    await makeServer("A", "2026-01-01T00:00:00Z", [rafa, bia]);
    await makeServer("B", "2026-02-01T00:00:00Z", [rafa, bia]);
    await makeServer("C", "2026-03-01T00:00:00Z", [rafa, bia]);
    await makeServer("D", "2026-04-01T00:00:00Z", [rafa, bia]);
  });

  afterEach(() => {
    for (const socket of open) {
      deleteAuthenticatedSocket(socket);
    }
    open.length = 0;
  });

  it("keeps the creation-date order until somebody drags", async () => {
    expect(await railOf(rafa)).toEqual(["A", "B", "C", "D"]);
  });

  it("saves an order, reads it back, and keeps it per person", async () => {
    const saved = await call(rafa, "PUT", "/api/servers/order", {
      serverIds: [ids.D, ids.B, ids.A, ids.C],
    });
    expect(saved.status).toBe(200);
    expect(saved.json.serverIds).toEqual([ids.D, ids.B, ids.A, ids.C]);

    expect(await railOf(rafa)).toEqual(["D", "B", "A", "C"]);
    // Bia holds the same four servers and was not touched.
    expect(await railOf(bia)).toEqual(["A", "B", "C", "D"]);
  });

  it("drops ids the caller does not hold instead of refusing the save", async () => {
    const pool = getPool();
    const other = await pool.query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('Z', $1) RETURNING id`,
      [bia.id],
    );
    await pool.query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [other.rows[0]!.id, bia.id],
    );
    const unknown = "00000000-0000-4000-8000-000000000000";

    const saved = await call(rafa, "PUT", "/api/servers/order", {
      serverIds: [ids.C, other.rows[0]!.id, unknown, ids.A],
    });

    expect(saved.status).toBe(200);
    // Named ones first, in the order given; the two the request left out keep
    // their relative place after them; nothing of Bia's server leaks back.
    expect(saved.json.serverIds).toEqual([ids.C, ids.A, ids.B, ids.D]);
    expect(await railOf(rafa)).toEqual(["C", "A", "B", "D"]);
    // And the server Rafa does not hold gained no position row for him.
    const rows = await pool.query(
      `SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2`,
      [other.rows[0]!.id, rafa.id],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("puts a server joined after a save at the bottom, ahead of nothing", async () => {
    await call(rafa, "PUT", "/api/servers/order", {
      serverIds: [ids.D, ids.C, ids.B, ids.A],
    });
    // An OLD server Rafa joins now (created before all of them).
    await makeServer("Old", "2025-06-01T00:00:00Z", [bia, rafa]);

    expect(await railOf(rafa)).toEqual(["D", "C", "B", "A", "Old"]);
  });

  it("keeps the order across a server being left", async () => {
    await call(rafa, "PUT", "/api/servers/order", {
      serverIds: [ids.C, ids.A, ids.D, ids.B],
    });
    await getPool().query(
      `DELETE FROM server_members WHERE server_id = $1 AND user_id = $2`,
      [ids.A, rafa.id],
    );
    expect(await railOf(rafa)).toEqual(["C", "D", "B"]);
    // Saving again with the stale list (still naming A) works.
    const saved = await call(rafa, "PUT", "/api/servers/order", {
      serverIds: [ids.B, ids.A, ids.C, ids.D],
    });
    expect(saved.status).toBe(200);
    expect(await railOf(rafa)).toEqual(["B", "C", "D"]);
  });

  it("refuses a malformed save", async () => {
    expect((await call(rafa, "PUT", "/api/servers/order", { serverIds: ["nope"] })).status).toBe(400);
    expect((await call(rafa, "PUT", "/api/servers/order", { serverIds: [ids.A, ids.A] })).status).toBe(400);
    expect((await call(rafa, "PUT", "/api/servers/order", {})).status).toBe(400);
    expect(await railOf(rafa)).toEqual(["A", "B", "C", "D"]);
  });

  it("accepts an empty list and changes nothing", async () => {
    await call(rafa, "PUT", "/api/servers/order", { serverIds: [ids.B, ids.A, ids.C, ids.D] });
    const saved = await call(rafa, "PUT", "/api/servers/order", { serverIds: [] });
    expect(saved.status).toBe(200);
    expect(await railOf(rafa)).toEqual(["B", "A", "C", "D"]);
  });

  it("two saves at once land whole, never a splice of both", async () => {
    const first = [ids.D, ids.C, ids.B, ids.A];
    const second = [ids.B, ids.A, ids.D, ids.C];
    await Promise.all([
      call(rafa, "PUT", "/api/servers/order", { serverIds: first }),
      call(rafa, "PUT", "/api/servers/order", { serverIds: second }),
    ]);
    const rail = (await railOf(rafa)).map((name) => ids[name]);
    expect([first, second]).toContainEqual(rail);
  });

  it("tells the account's other sockets, with the saver's origin, and nobody else", async () => {
    const laptop = connect(rafa);
    const phone = connect(rafa);
    const bystander = connect(bia);

    const saved = await call(rafa, "PUT", "/api/servers/order", {
      serverIds: [ids.D, ids.C, ids.B, ids.A],
      origin: "tab-1",
    });

    expect(saved.status).toBe(200);
    const expected = {
      type: "server-order-update",
      serverIds: [ids.D, ids.C, ids.B, ids.A],
      origin: "tab-1",
    };
    expect(orderFrames(laptop)).toEqual([expected]);
    expect(orderFrames(phone)).toEqual([expected]);
    expect(orderFrames(bystander)).toEqual([]);
  });

  it("delivers a reorder saved on another instance, to that account only", async () => {
    const laptop = connect(rafa);
    const bystander = connect(bia);
    const frame = {
      type: "server-order-update",
      serverIds: [ids.C, ids.A],
    };
    // An instance with a different origin id publishing on the same bus.
    const peer = bus.createMemoryTransport(hub);
    peer.publish({
      origin: "some-other-instance",
      topic: "chat.server-order",
      data: { frame, userId: rafa.id },
    });
    // Malformed frames are ignored, not delivered half-parsed.
    peer.publish({
      origin: "some-other-instance",
      topic: "chat.server-order",
      data: { frame: { ...frame, serverIds: ["nope"] }, userId: rafa.id },
    });
    peer.publish({
      origin: "some-other-instance",
      topic: "chat.server-order",
      data: { frame },
    });
    await peer.close();

    expect(orderFrames(laptop)).toEqual([frame]);
    expect(orderFrames(bystander)).toEqual([]);
  });

  it("publishes with the account on the bus so another instance can deliver it", async () => {
    await call(rafa, "PUT", "/api/servers/order", {
      serverIds: [ids.B, ids.A, ids.C, ids.D],
    });
    const published = busFrames.filter((frame) => frame.topic === "chat.server-order");
    expect(published).toHaveLength(1);
    expect(published[0]!.data).toMatchObject({
      userId: rafa.id,
      frame: { type: "server-order-update", serverIds: [ids.B, ids.A, ids.C, ids.D] },
    });
  });
});

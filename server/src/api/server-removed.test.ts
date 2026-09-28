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
 * Kick, ban and delete, over HTTP against a real Postgres, as seen from the
 * sockets of the people they happen to.
 *
 * Before this, all three were enforced on the next read and told to nobody:
 * the removed member's open tab kept the server, its channels and a member
 * list with them still in it until a reload. What is pinned:
 *  - a kick and a ban reach every socket the removed member holds, and no one
 *    else's;
 *  - a pre-emptive ban of somebody who was never a member sends nothing;
 *  - a delete reaches every member the server had, which is only possible
 *    because the route lists them BEFORE the cascade empties the table;
 *  - with the bus on, the frame goes out with its addressees, because another
 *    machine cannot look them up after a delete either.
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
): Promise<number> {
  stubs.actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: "Bearer session",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await response.text();
  return response.status;
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

function removals(socket: FakeSocket): unknown[] {
  return socket.frames.filter((frame) => frame.type === "server-removed");
}

describeDb("telling people a server left their list", () => {
  let owner: Actor;
  let admin: Actor;
  let member: Actor;
  let stranger: Actor;
  let serverId: string;
  const open: FakeSocket[] = [];
  const busFrames: { topic: string; data: unknown }[] = [];
  let stopObserving: (() => void) | null = null;
  const hub = bus.createMemoryHub();

  /** One open socket per person, registered the way `/ws` auth does it. */
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
    owner = await upsertUser({ clerkId: "clerk-owner", displayName: "Dona", avatarUrl: null });
    admin = await upsertUser({ clerkId: "clerk-admin", displayName: "Adm", avatarUrl: null });
    member = await upsertUser({ clerkId: "clerk-member", displayName: "Bia", avatarUrl: null });
    stranger = await upsertUser({ clerkId: "clerk-stranger", displayName: "Zé", avatarUrl: null });
    const created = await pool.query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('Casa da Resenha', $1) RETURNING id`,
      [owner.id],
    );
    serverId = created.rows[0]!.id;
    await pool.query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'member')`,
      [serverId, owner.id, admin.id, member.id],
    );
  });

  afterEach(() => {
    for (const socket of open) {
      deleteAuthenticatedSocket(socket);
    }
    open.length = 0;
  });

  it("tells a kicked member on every socket they hold, and nobody else", async () => {
    const laptop = connect(member);
    const phone = connect(member);
    const bystanders = [connect(owner), connect(admin), connect(stranger)];

    const status = await call(
      owner,
      "DELETE",
      `/api/servers/${serverId}/members/${member.id}`,
      { ban: false },
    );

    expect(status).toBe(200);
    for (const socket of [laptop, phone]) {
      expect(removals(socket)).toEqual([
        { type: "server-removed", serverId, reason: "kicked" },
      ]);
    }
    for (const socket of bystanders) {
      expect(removals(socket)).toEqual([]);
    }
  });

  it("says banned for a ban from the member menu", async () => {
    const socket = connect(member);

    expect(
      await call(owner, "DELETE", `/api/servers/${serverId}/members/${member.id}`, {
        ban: true,
      }),
    ).toBe(200);

    expect(removals(socket)).toEqual([
      { type: "server-removed", serverId, reason: "banned" },
    ]);
  });

  it("says banned for a ban from the bans list", async () => {
    const socket = connect(member);

    expect(
      await call(owner, "POST", `/api/servers/${serverId}/bans`, {
        userId: member.id,
      }),
    ).toBe(200);

    expect(removals(socket)).toEqual([
      { type: "server-removed", serverId, reason: "banned" },
    ]);
  });

  it("sends nothing for a pre-emptive ban of somebody who was never in", async () => {
    const socket = connect(stranger);

    expect(
      await call(owner, "POST", `/api/servers/${serverId}/bans`, {
        userId: stranger.id,
      }),
    ).toBe(200);

    expect(removals(socket)).toEqual([]);
  });

  it("tells every member of a deleted server, and nobody outside it", async () => {
    const members = [connect(owner), connect(admin), connect(member)];
    const outside = connect(stranger);

    expect(await call(owner, "DELETE", `/api/servers/${serverId}`)).toBe(200);

    for (const socket of members) {
      expect(removals(socket)).toEqual([
        { type: "server-removed", serverId, reason: "deleted" },
      ]);
    }
    expect(removals(outside)).toEqual([]);
  });

  it("puts the addressees on the bus, because the other machine cannot list them after a delete", async () => {
    expect(await call(owner, "DELETE", `/api/servers/${serverId}`)).toBe(200);

    const published = busFrames.filter((frame) => frame.topic === "chat.membership");
    expect(published).toHaveLength(1);
    const data = published[0]!.data as { userIds: string[] };
    expect(data).toMatchObject({ type: "server-removed", serverId, reason: "deleted" });
    expect([...data.userIds].sort()).toEqual(
      [owner.id, admin.id, member.id].sort(),
    );
  });
});

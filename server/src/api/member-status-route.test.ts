import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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

/**
 * `GET /api/servers/:id/members/status`: the live half of the member list on its
 * own, so a tab polling a 6000-member community stops downloading the whole
 * roster every 15 seconds. Real router, real SQL, real status registry; only the
 * identity layer is stubbed (same harness as `api.test.ts`).
 *
 * What is pinned:
 *  - it can never disagree with `/members` about who is online (the two read one
 *    function), including the floor: an invisible member is simply absent;
 *  - only people who are NOT offline are listed, and the count is the whole list;
 *  - the `roster` token is the same on both routes, moves when somebody joins or
 *    leaves, and does NOT move for a rename, which is what lets a client skip the
 *    big read;
 *  - the same membership check as `/members` (an outsider is refused).
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

let actor: { id: string; clerk_id: string } | null = null;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  resolveAuthSession: async () =>
    actor ? { user: actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser, invalidateServerMemberList } = await import(
  "../services/users.js"
);
const {
  applyManualStatus,
  registerStatusSocket,
  resetStatusRegistry,
  setSocketIdle,
} = await import("../ws/status.js");

type Person = { id: string; clerk_id: string };

let server: Server;
let baseUrl: string;

async function call<T>(
  as: Person | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

/** A socket stand-in the status registry accepts: open, nothing else is read. */
function fakeSocket(): WebSocket {
  return { readyState: 1, on: () => {} } as unknown as WebSocket;
}

interface FullRoster {
  roster: string;
  members: Array<{ id: string; status: string; displayName: string }>;
}
interface StatusRoster {
  roster: string;
  count: number;
  statuses: Record<string, string>;
}

describeDb("GET /api/servers/:id/members/status", () => {
  let owner: Person;
  let online: Person;
  let away: Person;
  let hidden: Person;
  let offline: Person;
  let outsider: Person;
  let serverId: string;

  beforeAll(async () => {
    await initDb();
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => server.listen(0, done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    resetStatusRegistry();
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, server_members
       RESTART IDENTITY CASCADE`,
    );
    const make = (name: string) =>
      upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null });
    owner = await make("owner");
    online = await make("online");
    away = await make("away");
    hidden = await make("hidden");
    offline = await make("offline");
    outsider = await make("outsider");

    const created = await call<{ server: { id: string } }>(
      owner,
      "POST",
      "/api/servers",
      { name: "Galera" },
    );
    expect(created.status).toBe(201);
    serverId = created.body.server.id;
    for (const person of [online, away, hidden, offline]) {
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [serverId, person.id],
      );
    }
    await invalidateServerMemberList(serverId);

    // owner and `online` have a live socket; `away` is idle; `hidden` is
    // connected but invisible; `offline` has no socket at all.
    const awaySocket = fakeSocket();
    await registerStatusSocket(fakeSocket(), owner.id);
    await registerStatusSocket(fakeSocket(), online.id);
    await registerStatusSocket(awaySocket, away.id);
    setSocketIdle(awaySocket, true);
    await registerStatusSocket(fakeSocket(), hidden.id);
    applyManualStatus(hidden.id, "invisible");
  });

  afterEach(() => {
    resetStatusRegistry();
  });

  it("agrees with /members about everybody, and lists only people who are not offline", async () => {
    const full = await call<FullRoster>(owner, "GET", `/api/servers/${serverId}/members`);
    const lean = await call<StatusRoster>(
      owner,
      "GET",
      `/api/servers/${serverId}/members/status`,
    );
    expect(full.status).toBe(200);
    expect(lean.status).toBe(200);

    // Rebuilding every status from the lean answer (absent = offline) must give
    // exactly what the full list says, member by member.
    for (const member of full.body.members) {
      expect(lean.body.statuses[member.id] ?? "offline", member.displayName).toBe(
        member.status,
      );
    }
    // The floor is not on the wire, and neither is an invisible member.
    expect(Object.values(lean.body.statuses)).not.toContain("offline");
    expect(lean.body.statuses[hidden.id]).toBeUndefined();
    expect(lean.body.statuses[offline.id]).toBeUndefined();
    // And the people who are there are there.
    expect(lean.body.statuses[owner.id]).toBe("online");
    expect(lean.body.statuses[online.id]).toBe("online");
    expect(lean.body.statuses[away.id]).toBe("idle");
    expect(lean.body.count).toBe(full.body.members.length);
  });

  it("is small: the payload does not grow with the offline majority", async () => {
    const lean = await call<StatusRoster>(
      owner,
      "GET",
      `/api/servers/${serverId}/members/status`,
    );
    expect(Object.keys(lean.body.statuses)).toHaveLength(3);
  });

  it("answers with the same roster token as /members, and the token ignores a rename and a status change", async () => {
    const full = await call<FullRoster>(owner, "GET", `/api/servers/${serverId}/members`);
    const lean = await call<StatusRoster>(
      owner,
      "GET",
      `/api/servers/${serverId}/members/status`,
    );
    expect(lean.body.roster).toBe(full.body.roster);

    // A rename that moves the person to the other end of the (name ordered)
    // list under any collation: the rows are reordered, the membership is not.
    await getPool().query(
      `UPDATE users SET display_name = 'zzz away', username = 'zzz_away' WHERE id = $1`,
      [away.id],
    );
    await invalidateServerMemberList(serverId);
    applyManualStatus(online.id, "dnd");
    const reread = await call<FullRoster>(owner, "GET", `/api/servers/${serverId}/members`);
    expect(reread.body.members.map((m) => m.id)).not.toEqual(
      full.body.members.map((m) => m.id),
    );
    const after = await call<StatusRoster>(
      owner,
      "GET",
      `/api/servers/${serverId}/members/status`,
    );
    expect(after.body.statuses[online.id]).toBe("dnd");
    expect(after.body.roster).toBe(full.body.roster);
    expect(reread.body.roster).toBe(full.body.roster);
  });

  it("moves the roster token when somebody joins and when somebody leaves", async () => {
    const before = (
      await call<StatusRoster>(owner, "GET", `/api/servers/${serverId}/members/status`)
    ).body;

    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, outsider.id],
    );
    await invalidateServerMemberList(serverId);
    const joined = (
      await call<StatusRoster>(owner, "GET", `/api/servers/${serverId}/members/status`)
    ).body;
    expect(joined.count).toBe(before.count + 1);
    expect(joined.roster).not.toBe(before.roster);

    await getPool().query(
      `DELETE FROM server_members WHERE server_id = $1 AND user_id = $2`,
      [serverId, outsider.id],
    );
    await invalidateServerMemberList(serverId);
    const left = (
      await call<StatusRoster>(owner, "GET", `/api/servers/${serverId}/members/status`)
    ).body;
    expect(left.count).toBe(before.count);
    expect(left.roster).toBe(before.roster);
  });

  it("is refused to somebody outside the server, like /members", async () => {
    const full = await call(outsider, "GET", `/api/servers/${serverId}/members`);
    const lean = await call(outsider, "GET", `/api/servers/${serverId}/members/status`);
    expect(full.status).toBeGreaterThanOrEqual(400);
    expect(lean.status).toBe(full.status);
  });

  it("is refused without a session", async () => {
    const lean = await call(null, "GET", `/api/servers/${serverId}/members/status`);
    expect(lean.status).toBe(401);
  });
});

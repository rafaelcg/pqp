import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * `GET /api/public/invites/:code`, over HTTP: the signed-out invite gate's
 * preview. Pinned here:
 *
 *  - it answers with no credential at all, and a garbage `Authorization`
 *    header does not veto it (pitfall 16's shape: a second credential must not
 *    be able to break the door that needs none);
 *  - the body is the server's name, icon URL and member count, and nothing
 *    that identifies a row or a person;
 *  - unknown, expired, exhausted, malformed and suspended codes are ONE answer,
 *    status and body alike, so the route cannot sort dead codes into kinds;
 *  - its own address-keyed bucket runs out.
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
const { upsertUser } = await import("../services/users.js");
const { createInvite } = await import("../services/invites.js");

let server: Server;
let baseUrl: string;

async function preview(
  code: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; cache: string | null }> {
  actor = null;
  const response = await fetch(`${baseUrl}/api/public/invites/${code}`, {
    headers,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    cache: response.headers.get("cache-control"),
  };
}

describeDb("public invite preview", () => {
  let serverId: string;
  let ownerId: string;

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
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, server_invites, server_bans,
                audit_log
       RESTART IDENTITY CASCADE`,
    );
    const owner = await upsertUser({
      clerkId: "clerk_owner",
      displayName: "Owner",
      avatarUrl: null,
    });
    const friend = await upsertUser({
      clerkId: "clerk_friend",
      displayName: "Friend",
      avatarUrl: null,
    });
    ownerId = owner.id;
    const created = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id, icon_url)
       VALUES ('Sala do Rafa', $1, 'https://cdn.example/icon.png')
       RETURNING id`,
      [owner.id],
    );
    serverId = created.rows[0]!.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
      [serverId, owner.id, friend.id],
    );
  });

  async function inviteCode(
    options: { maxUses?: number | null; expiresInHours?: number | null } = {},
  ): Promise<string> {
    return (await createInvite(serverId, ownerId, options)).code;
  }

  it("answers a live invite with no credential, and only name, icon and count", async () => {
    const code = await inviteCode();
    const res = await preview(code);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      invite: {
        serverName: "Sala do Rafa",
        iconUrl: "https://cdn.example/icon.png",
        memberCount: 2,
      },
    });
    expect(res.cache).toBe("public, max-age=60");
    // No id of any kind leaks in the JSON.
    expect(JSON.stringify(res.body)).not.toContain(serverId);
    expect(JSON.stringify(res.body)).not.toContain(ownerId);
  });

  it("ignores a garbage Authorization header instead of answering 401", async () => {
    const code = await inviteCode();
    const res = await preview(code, { Authorization: "Bearer not-a-jwt" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ invite: { serverName: "Sala do Rafa" } });
  });

  it("leaves the authenticated invite read behind auth", async () => {
    const code = await inviteCode();
    actor = null;
    const res = await fetch(`${baseUrl}/api/invites/${code}`);
    expect(res.status).toBe(401);
  });

  it("answers unknown, expired, exhausted, malformed and suspended with one identical 404", async () => {
    const expired = await inviteCode({ expiresInHours: 1 });
    await getPool().query(
      `UPDATE server_invites SET expires_at = now() - interval '1 minute'
        WHERE code = $1`,
      [expired],
    );
    const maxed = await inviteCode({ maxUses: 1 });
    await getPool().query(
      `UPDATE server_invites SET uses = 1 WHERE code = $1`,
      [maxed],
    );

    const unknown = await preview("zzzzzzzz");
    const answers = [
      unknown,
      await preview(expired),
      await preview(maxed),
      await preview("has%20space"),
      await preview("%E0%A4%A"),
    ];

    const live = await inviteCode();
    await getPool().query(
      `UPDATE servers SET is_community_suspended = TRUE WHERE id = $1`,
      [serverId],
    );
    answers.push(await preview(live));

    expect(unknown.status).toBe(404);
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      expect(answer.body).toEqual(unknown.body);
      expect(answer.cache).toBe(unknown.cache);
    }
  });

  it("still previews an invite with uses left", async () => {
    const code = await inviteCode({ maxUses: 2, expiresInHours: 24 });
    await getPool().query(
      `UPDATE server_invites SET uses = 1 WHERE code = $1`,
      [code],
    );
    expect((await preview(code)).status).toBe(200);
  });

  it("runs out of its address-keyed bucket", async () => {
    const code = await inviteCode();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      statuses.push((await preview(i % 2 === 0 ? code : "nope1234")).status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 200 || s === 404)).toBe(
      true,
    );
    expect(statuses[30]).toBe(429);
  });
});

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
 * The `Idempotency-Key` header on the two POSTs that make a room:
 * `POST /api/servers` and `POST /api/import/discord/apply`. Context is
 * pqp#807/#806: a client that loses the response to a create (network drop,
 * the response never lands) cannot tell whether the room was made, and a
 * naive retry made a second one. These tests drive the real HTTP routes, the
 * same shape a browser or a phone actually sends, rather than calling the
 * service functions directly (see idempotency-keys.test.ts for that half).
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

vi.mock("../lib/safe-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/safe-fetch.js")>();
  return { ...actual, safeFetch: vi.fn() };
});

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("./index.js");
const { upsertUser } = await import("../services/users.js");
const { safeFetch } = await import("../lib/safe-fetch.js");

interface Actor {
  id: string;
  clerk_id: string;
}

interface ApiResult<T> {
  status: number;
  body: T;
}

interface CreateServerBody {
  server: { id: string; name: string };
  channels: Array<{ id: string }>;
}

function guildTemplate() {
  return {
    updated_at: "2026-08-01T00:00:00+00:00",
    is_dirty: false,
    serialized_source_guild: {
      name: "Imported hall",
      roles: [
        { id: 0, name: "@everyone", color: 0, hoist: false, mentionable: false },
      ],
      channels: [
        { id: 1, name: "geral", type: 0, position: 0, parent_id: null, permission_overwrites: [] },
      ],
    },
  };
}

function fetchOk() {
  vi.mocked(safeFetch).mockResolvedValue({
    statusCode: 200,
    headers: {},
    body: Buffer.from(JSON.stringify(guildTemplate())),
    finalUrl: "https://discord.com/api/v10/guilds/templates/abcd1234",
  });
}

describeDb("idempotent room creation", () => {
  let server: Server;
  let baseUrl: string;
  let owner: Actor;
  let other: Actor;

  beforeAll(async () => {
    await initDb();
    stubs.actor = null;
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
    vi.mocked(safeFetch).mockReset();
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    const ownerRow = await upsertUser({
      clerkId: "clerk_idem_api_owner",
      displayName: "Owner",
      avatarUrl: null,
    });
    owner = { id: ownerRow.id, clerk_id: ownerRow.clerk_id };
    const otherRow = await upsertUser({
      clerkId: "clerk_idem_api_other",
      displayName: "Other",
      avatarUrl: null,
    });
    other = { id: otherRow.id, clerk_id: otherRow.clerk_id };
  });

  async function call<T = Record<string, unknown>>(
    as: Actor | null,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<ApiResult<T>> {
    stubs.actor = as;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(as ? { Authorization: "Bearer test" } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : {}) as T,
    };
  }

  describe("POST /api/servers", () => {
    it("answers 201 once and 200 with the same room on a repeat", async () => {
      const headers = { "Idempotency-Key": "onboarding-attempt-1" };
      const first = await call<CreateServerBody>(
        owner,
        "POST",
        "/api/servers",
        { name: "Sala" },
        headers,
      );
      expect(first.status).toBe(201);

      const second = await call<CreateServerBody>(
        owner,
        "POST",
        "/api/servers",
        { name: "Sala" },
        headers,
      );
      expect(second.status).toBe(200);
      expect(second.body.server.id).toBe(first.body.server.id);
      expect(second.body.channels.map((c) => c.id).sort()).toEqual(
        first.body.channels.map((c) => c.id).sort(),
      );

      const rows = await getPool().query(
        `SELECT id FROM servers WHERE owner_id = $1`,
        [owner.id],
      );
      expect(rows.rows).toHaveLength(1);
    });

    it("gives two users who happen to send the same key independent rooms", async () => {
      const headers = { "Idempotency-Key": "same-string-different-people" };
      const mine = await call<CreateServerBody>(
        owner,
        "POST",
        "/api/servers",
        { name: "Sala do Owner" },
        headers,
      );
      const theirs = await call<CreateServerBody>(
        other,
        "POST",
        "/api/servers",
        { name: "Sala do Other" },
        headers,
      );
      expect(mine.status).toBe(201);
      expect(theirs.status).toBe(201);
      expect(mine.body.server.id).not.toBe(theirs.body.server.id);
    });

    it("still makes two rooms for a retry with no key, exactly as before", async () => {
      const first = await call<CreateServerBody>(owner, "POST", "/api/servers", {
        name: "Sala",
      });
      const second = await call<CreateServerBody>(owner, "POST", "/api/servers", {
        name: "Sala",
      });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.body.server.id).not.toBe(second.body.server.id);
    });

    it("resolves a concurrent duplicate to one room instead of racing it", async () => {
      const headers = { "Idempotency-Key": "concurrent-attempt" };
      const [a, b] = await Promise.all([
        call<CreateServerBody>(owner, "POST", "/api/servers", { name: "Sala" }, headers),
        call<CreateServerBody>(owner, "POST", "/api/servers", { name: "Sala" }, headers),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(a.body.server.id).toBe(b.body.server.id);

      const rows = await getPool().query(
        `SELECT id FROM servers WHERE owner_id = $1`,
        [owner.id],
      );
      expect(rows.rows).toHaveLength(1);
    });

    it("ignores a blank idempotency key the same as no header at all", async () => {
      const headers = { "Idempotency-Key": "   " };
      const first = await call<CreateServerBody>(
        owner,
        "POST",
        "/api/servers",
        { name: "Sala" },
        headers,
      );
      const second = await call<CreateServerBody>(
        owner,
        "POST",
        "/api/servers",
        { name: "Sala" },
        headers,
      );
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.body.server.id).not.toBe(second.body.server.id);
    });
  });

  describe("POST /api/import/discord/apply", () => {
    it("answers 201 once, then 200 with the same room without fetching Discord again", async () => {
      fetchOk();
      const headers = { "Idempotency-Key": "import-attempt-1" };
      const first = await call<CreateServerBody>(
        owner,
        "POST",
        "/api/import/discord/apply",
        { source: "abcd1234" },
        headers,
      );
      expect(first.status).toBe(201);
      expect(safeFetch).toHaveBeenCalledTimes(1);

      const second = await call<CreateServerBody>(
        owner,
        "POST",
        "/api/import/discord/apply",
        { source: "abcd1234" },
        headers,
      );
      expect(second.status).toBe(200);
      expect(second.body.server.id).toBe(first.body.server.id);
      // The retry never re-fetched the template: the pre-check short-circuits
      // ahead of the outbound call and the rate-limit draw.
      expect(safeFetch).toHaveBeenCalledTimes(1);

      const rows = await getPool().query(
        `SELECT id FROM servers WHERE owner_id = $1`,
        [owner.id],
      );
      expect(rows.rows).toHaveLength(1);
    });
  });
});

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BRING_CREW_REMIND_AFTER_MS } from "@pqp/shared";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
// No `startFeatureFlags()` here, so the flag is its environment variable.
process.env.DISCORD_BRING_CREW = "true";

const stubs = vi.hoisted(() => ({
  actor: null as {
    id: string;
    clerk_id: string;
    is_character?: boolean;
  } | null,
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
  is_character?: boolean;
}

interface ApiResult<T> {
  status: number;
  body: T;
}


function guildTemplate(channels: unknown[], roles: unknown[] = []) {
  return {
    updated_at: "2026-08-01T00:00:00+00:00",
    is_dirty: false,
    serialized_source_guild: {
      name: "Imported hall",
      roles: [
        { id: 0, name: "@everyone", color: 0, hoist: false, mentionable: false },
        ...roles,
      ],
      channels,
    },
  };
}

function fetchOk(payload: unknown) {
  vi.mocked(safeFetch).mockResolvedValue({
    statusCode: 200,
    headers: {},
    body: Buffer.from(JSON.stringify(payload)),
    finalUrl: "https://discord.com/api/v10/guilds/templates/abcd1234",
  });
}

describeDb("Traz tua galera: import arrivals", () => {
  let server: Server;
  let baseUrl: string;
  let owner: Actor;

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
    process.env.DISCORD_BRING_CREW = "";
  });

  beforeEach(async () => {
    process.env.DISCORD_BRING_CREW = "true";
    resetApiRateLimits();
    vi.mocked(safeFetch).mockReset();
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    owner = await makeUser("clerk_crew_owner", "Owner");
  });

  async function makeUser(clerkId: string, name: string): Promise<Actor> {
    const row = await upsertUser({ clerkId, displayName: name, avatarUrl: null });
    return { id: row.id, clerk_id: row.clerk_id };
  }

  async function call<T = Record<string, unknown>>(
    as: Actor | null,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResult<T>> {
    stubs.actor = as;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(as ? { Authorization: "Bearer test" } : {}),
        Origin: "http://localhost:5173",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : {}) as T,
    };
  }

  async function importServer(): Promise<{
    serverId: string;
    inviteCode: string;
    bringCrew: unknown;
  }> {
    fetchOk(
      guildTemplate([
        { id: 1, type: 0, name: "general", position: 0, parent_id: null },
      ]),
    );
    const res = await call<{
      server: { id: string };
      invite: { code: string };
      bringCrew?: unknown;
    }>(owner, "POST", "/api/import/discord/apply", { source: "abcd1234" });
    expect(res.status).toBe(201);
    return {
      serverId: res.body.server.id,
      inviteCode: res.body.invite.code,
      bringCrew: res.body.bringCrew,
    };
  }

  async function join(
    serverId: string,
    who: Actor,
    joinRef: string | null,
    joinedAt: string = "now()",
  ) {
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role, joined_at, join_ref)
       VALUES ($1, $2, 'member', ${joinedAt}, $3)`,
      [serverId, who.id, joinRef],
    );
  }

  it("tells the apply the last screen is Traz tua galera", async () => {
    const { bringCrew } = await importServer();
    expect(bringCrew).toBe(true);
  });

  it("counts who arrived and how many came through the import's link", async () => {
    const { serverId, inviteCode } = await importServer();
    await join(serverId, await makeUser("clerk_a", "A"), "discord");
    await join(serverId, await makeUser("clerk_b", "B"), "discord");
    await join(serverId, await makeUser("clerk_c", "C"), "convite");
    const bot = await makeUser("clerk_bot", "Bot");
    await getPool().query(`UPDATE users SET is_character = TRUE WHERE id = $1`, [
      bot.id,
    ]);
    await join(serverId, bot, "discord");

    const res = await call(owner, "GET", `/api/servers/${serverId}/import-arrivals`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      phase: "fresh",
      arrived: 3,
      viaLink: 2,
      inviteCode,
    });
    expect(typeof res.body.importedAt).toBe("string");
  });

  it("turns into the reminder a day later when few came", async () => {
    const { serverId } = await importServer();
    await getPool().query(
      `UPDATE audit_log SET created_at = now() - make_interval(secs => $2)
        WHERE server_id = $1 AND action = 'server.discord_import'`,
      [serverId, BRING_CREW_REMIND_AFTER_MS / 1000 + 60],
    );
    await join(serverId, await makeUser("clerk_a", "A"), "discord");
    const res = await call(owner, "GET", `/api/servers/${serverId}/import-arrivals`);
    expect(res.body).toMatchObject({ phase: "reminder", arrived: 1 });
  });

  it("is over after a week, and stops handing out the invite", async () => {
    const { serverId } = await importServer();
    await getPool().query(
      `UPDATE audit_log SET created_at = now() - interval '8 days'
        WHERE server_id = $1 AND action = 'server.discord_import'`,
      [serverId],
    );
    const res = await call(owner, "GET", `/api/servers/${serverId}/import-arrivals`);
    expect(res.body).toMatchObject({ phase: "over", inviteCode: null });
  });

  it("does not count members who were there before the import", async () => {
    const { serverId } = await importServer();
    await join(
      serverId,
      await makeUser("clerk_early", "Early"),
      null,
      "now() - interval '1 hour'",
    );
    const res = await call(owner, "GET", `/api/servers/${serverId}/import-arrivals`);
    expect(res.body).toMatchObject({ arrived: 0 });
  });

  it("is only for people who manage the server", async () => {
    const { serverId } = await importServer();
    const member = await makeUser("clerk_m", "Member");
    await join(serverId, member, "discord");
    const asMember = await call(member, "GET", `/api/servers/${serverId}/import-arrivals`);
    expect(asMember.status).toBe(403);
    const stranger = await makeUser("clerk_s", "Stranger");
    const asStranger = await call(stranger, "GET", `/api/servers/${serverId}/import-arrivals`);
    expect([403, 404]).toContain(asStranger.status);
  });

  it("says nothing for a server that was not imported", async () => {
    const created = await call<{ server: { id: string } }>(owner, "POST", "/api/servers", {
      name: "Feita à mão",
    });
    const serverId = created.body.server.id;
    const res = await call(owner, "GET", `/api/servers/${serverId}/import-arrivals`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, importedAt: null, phase: null });
  });

  it("is silent with the flag off, on both routes", async () => {
    process.env.DISCORD_BRING_CREW = "";
    const { serverId, bringCrew } = await importServer();
    expect(bringCrew).toBe(false);
    const res = await call(owner, "GET", `/api/servers/${serverId}/import-arrivals`);
    expect(res.body).toEqual({
      enabled: false,
      importedAt: null,
      phase: null,
      arrived: 0,
      viaLink: 0,
      inviteCode: null,
    });
  });
});

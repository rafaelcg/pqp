import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DiscordPermission, Permission } from "@pqp/shared";
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
const { safeFetch, FetchTooLargeError } = await import("../lib/safe-fetch.js");

interface Actor {
  id: string;
  clerk_id: string;
  is_character?: boolean;
}

interface ApiResult<T> {
  status: number;
  body: T;
}

const DISCORD_VIEW = (1n << 10n).toString();

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

describeDb("discord layout import API", () => {
  let server: Server;
  let baseUrl: string;
  let user: Actor;

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
    const row = await upsertUser({
      clerkId: "clerk_import_api",
      displayName: "Importer",
      avatarUrl: null,
    });
    user = { id: row.id, clerk_id: row.clerk_id };
  });

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

  it("refuses a malformed paste without fetching Discord", async () => {
    const res = await call(user, "POST", "/api/import/discord/preview", {
      source: "https://evil.example/abcd1234",
    });
    expect(res.status).toBe(400);
    expect(vi.mocked(safeFetch)).not.toHaveBeenCalled();
  });

  it("maps Discord 404 to 404", async () => {
    vi.mocked(safeFetch).mockResolvedValue({
      statusCode: 404,
      headers: {},
      body: Buffer.from("{}"),
      finalUrl: "https://discord.com/api/v10/guilds/templates/nope",
    });
    const res = await call(user, "POST", "/api/import/discord/preview", {
      source: "nope12",
    });
    expect(res.status).toBe(404);
  });

  it("maps Discord 429 to 429", async () => {
    vi.mocked(safeFetch).mockResolvedValue({
      statusCode: 429,
      headers: { "retry-after": "12" },
      body: Buffer.from("{}"),
      finalUrl: "https://discord.com/api/v10/guilds/templates/abcd1234",
    });
    const res = await call(user, "POST", "/api/import/discord/preview", {
      source: "abcd1234",
    });
    expect(res.status).toBe(429);
  });

  it("maps a too-large Discord body to 413", async () => {
    vi.mocked(safeFetch).mockRejectedValue(new FetchTooLargeError());
    const res = await call(user, "POST", "/api/import/discord/preview", {
      source: "abcd1234",
    });
    expect(res.status).toBe(413);
  });

  it("refuses character accounts on both routes", async () => {
    const character: Actor = { ...user, is_character: true };
    const preview = await call(character, "POST", "/api/import/discord/preview", {
      source: "abcd1234",
    });
    const apply = await call(character, "POST", "/api/import/discord/apply", {
      source: "abcd1234",
    });
    expect(preview.status).toBe(403);
    expect(apply.status).toBe(403);
    expect(vi.mocked(safeFetch)).not.toHaveBeenCalled();
  });

  it("previews a template without writing a server", async () => {
    fetchOk(
      guildTemplate([
        { id: 1, type: 0, name: "general", position: 0, parent_id: null },
      ]),
    );
    const res = await call<{ serverName: string; channels: unknown[] }>(
      user,
      "POST",
      "/api/import/discord/preview",
      { source: "https://discord.new/abcd1234" },
    );
    expect(res.status).toBe(200);
    expect(res.body.serverName).toBe("Imported hall");
    expect(res.body.channels).toHaveLength(1);
    expect(vi.mocked(safeFetch).mock.calls[0]?.[0]).toBe(
      "https://discord.com/api/v10/guilds/templates/abcd1234",
    );
    const servers = await getPool().query(`SELECT count(*)::int AS n FROM servers`);
    expect(servers.rows[0]?.n).toBe(0);
  });

  it("applies privacy as @everyone deny VIEW, keeps the staff ladder above cosmetics, and does not add the owner to channel_members", async () => {
    fetchOk(
      guildTemplate(
        [
          {
            id: 1,
            type: 0,
            name: "staff",
            position: 0,
            parent_id: null,
            permission_overwrites: [
              { id: 0, type: 0, allow: "0", deny: DISCORD_VIEW },
              {
                id: 8,
                type: 0,
                allow: DiscordPermission.VIEW_CHANNEL.toString(),
                deny: "0",
              },
            ],
          },
          {
            id: 2,
            type: 0,
            name: "general",
            position: 1,
            parent_id: null,
            permission_overwrites: [],
          },
        ],
        [
          { id: 9, name: "Mods", color: 3447003, hoist: true, mentionable: true },
          {
            id: 8,
            name: "VIP",
            color: 0,
            hoist: false,
            mentionable: false,
            permissions: DiscordPermission.SEND_MESSAGES.toString(),
          },
        ],
      ),
    );

    const res = await call<{
      server: { id: string };
      channels: Array<{ id: string; name: string; isPrivate: boolean }>;
      roles: Array<{
        name: string;
        position: number;
        systemKey: string | null;
        permissions: string;
      }>;
      invite: { code: string };
    }>(user, "POST", "/api/import/discord/apply", { source: "abcd1234" });

    expect(res.status).toBe(201);
    expect(res.body.invite.code).toBeTruthy();

    const staff = res.body.channels.find((channel) => channel.name === "staff")!;
    const general = res.body.channels.find(
      (channel) => channel.name === "general",
    )!;
    expect(staff.isPrivate).toBe(true);
    expect(general.isPrivate).toBe(false);

    const overwrite = await getPool().query<{ deny: string }>(
      `SELECT deny::text AS deny FROM channel_overwrites
        WHERE channel_id = $1 AND target_type = 'role'`,
      [staff.id],
    );
    expect(overwrite.rows.length).toBeGreaterThanOrEqual(1);
    expect(
      overwrite.rows.some(
        (row) =>
          (BigInt(row.deny) & Permission.VIEW_CHANNEL) ===
          Permission.VIEW_CHANNEL,
      ),
    ).toBe(true);

    const ownerRows = await getPool().query(
      `SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
      [staff.id, user.id],
    );
    expect(ownerRows.rows).toHaveLength(0);

    const other = await upsertUser({
      clerkId: "clerk_import_member",
      displayName: "Member",
      avatarUrl: null,
    });
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [res.body.server.id, other.id],
    );
    const vis = await getPool().query<{ v: boolean }>(
      `SELECT channel_viewable($1, $2) AS v`,
      [staff.id, other.id],
    );
    expect(vis.rows[0]?.v).toBe(false);
    const ownerVis = await getPool().query<{ v: boolean }>(
      `SELECT channel_viewable($1, $2) AS v`,
      [staff.id, user.id],
    );
    expect(ownerVis.rows[0]?.v).toBe(true);

    const byName = Object.fromEntries(
      res.body.roles.map((role) => [role.name, role]),
    );
    expect(byName.everyone?.position).toBe(0);
    expect(byName.Mods?.position).toBe(1);
    expect(byName.VIP?.position).toBe(2);
    expect(byName.Moderator?.position).toBe(3);
    expect(byName.Moderator?.systemKey).toBe("moderator");
    expect(byName.Manager?.position).toBe(4);
    expect(byName.Admin?.position).toBe(5);
    expect(byName.Admin?.systemKey).toBe("admin");
    expect(byName.Owner?.position).toBe(6);
    expect(byName.Owner?.systemKey).toBe("owner");
    expect(BigInt(byName.VIP?.permissions ?? "0") & Permission.SEND_MESSAGES).toBe(
      Permission.SEND_MESSAGES,
    );
    expect(BigInt(byName.VIP?.permissions ?? "0") & Permission.ADMINISTRATOR).toBe(
      0n,
    );

    const staffOverwrites = await getPool().query<{
      allow: string;
      deny: string;
      name: string;
    }>(
      `SELECT o.allow::text AS allow, o.deny::text AS deny, r.name
         FROM channel_overwrites o
         JOIN roles r ON r.id = o.target_id
        WHERE o.channel_id = $1 AND o.target_type = 'role'`,
      [staff.id],
    );
    const everyoneRow = staffOverwrites.rows.find((row) => row.name === "everyone");
    expect(BigInt(everyoneRow?.deny ?? "0") & Permission.VIEW_CHANNEL).toBe(
      Permission.VIEW_CHANNEL,
    );
    const vipRow = staffOverwrites.rows.find((row) => row.name === "VIP");
    expect(BigInt(vipRow?.allow ?? "0") & Permission.VIEW_CHANNEL).toBe(
      Permission.VIEW_CHANNEL,
    );
  });
});

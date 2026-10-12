import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { forumConfigSchema } from "@pqp/shared";

/**
 * Forum channels PR 0: the runtime flag `forum_channels` and the one thing it
 * gates before any forum code exists, creating a `forum` channel.
 *
 * `channelTypeSchema` accepts `forum` from this PR on so every later PR codes
 * against one shape; this guard is what keeps that widening inert. Flags are
 * set the way production sets them: rows read after `startFeatureFlags()`,
 * never an environment variable (CLAUDE.md pitfall 12).
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
delete process.env.FORUM_CHANNELS;

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
const { createServer: createPqpServer } = await import("../services/servers.js");
const {
  resetFeatureFlagsForTests,
  setGlobalFlag,
  setServerFlagOverride,
  startFeatureFlags,
} = await import("../lib/flags.js");

let http: Server;
let baseUrl: string;
let serverId: string;
let otherServerId: string;

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: "Bearer test",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

const createForum = (server: string, name = "ajuda") =>
  call("POST", `/api/servers/${server}/channels`, { name, type: "forum" });

describeDb("forum_channels: config and the create guard", () => {
  beforeAll(async () => {
    await initDb();
    http = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => http.listen(0, done));
    baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => http.close(() => done()));
    resetFeatureFlagsForTests();
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    resetFeatureFlagsForTests();
    await getPool().query(
      `TRUNCATE users, servers, feature_flags, feature_flag_overrides, feature_flag_audit
       RESTART IDENTITY CASCADE`,
    );
    stubs.actor = await upsertUser({
      clerkId: "clerk_forum_flag",
      displayName: "Alice",
      avatarUrl: null,
    });
    serverId = (await createPqpServer("Fórum", stubs.actor.id)).server.id;
    otherServerId = (await createPqpServer("Outro", stubs.actor.id)).server.id;
    await startFeatureFlags();
  });

  it("is off by default: the config says so and a forum create is 403", async () => {
    const config = await call("GET", `/api/forum/config?serverId=${serverId}`);
    expect(config.status).toBe(200);
    expect(forumConfigSchema.parse(config.body)).toEqual({ enabled: false });

    const created = await createForum(serverId);
    expect(created.status).toBe(403);
    expect(created.body.error).toBe("forum_channels_off");
    const rows = await getPool().query(
      `SELECT 1 FROM channels WHERE server_id = $1 AND type = 'forum'`,
      [serverId],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("leaves every other channel type alone while it is off", async () => {
    const text = await call("POST", `/api/servers/${serverId}/channels`, {
      name: "geral-2",
      type: "text",
    });
    expect(text.status).toBe(201);
  });

  it("a per-server override turns it on for that server only", async () => {
    await setServerFlagOverride("forum_channels", serverId, true, { kind: "dashboard" });

    const on = await call("GET", `/api/forum/config?serverId=${serverId}`);
    expect(on.body).toEqual({ enabled: true });
    const off = await call("GET", `/api/forum/config?serverId=${otherServerId}`);
    expect(off.body).toEqual({ enabled: false });
    // No server (or garbage) is the global answer.
    expect((await call("GET", "/api/forum/config")).body).toEqual({ enabled: false });
    expect((await call("GET", "/api/forum/config?serverId=nope")).body).toEqual({
      enabled: false,
    });

    const created = await createForum(serverId);
    expect(created.status).toBe(201);
    expect((created.body.channel as { type: string }).type).toBe("forum");
    // The database accepts the type: the CHECK in schema.sql carries 'forum'.
    const row = await getPool().query<{ type: string }>(
      `SELECT type FROM channels WHERE id = $1`,
      [(created.body.channel as { id: string }).id],
    );
    expect(row.rows[0]?.type).toBe("forum");

    expect((await createForum(otherServerId)).status).toBe(403);
  });

  it("a server override off wins over a global on", async () => {
    await setGlobalFlag("forum_channels", true, { kind: "dashboard" });
    await setServerFlagOverride("forum_channels", otherServerId, false, {
      kind: "dashboard",
    });
    expect((await createForum(serverId)).status).toBe(201);
    expect((await createForum(otherServerId)).status).toBe(403);
  });
});

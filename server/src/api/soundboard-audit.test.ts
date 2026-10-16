import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the soundboard's management routes write to the audit log, through the
 * real router and SQL with the identity layer and S3 faked: one row per clip
 * created, one per delete, an update row that says what it changed from, and
 * no row for a request that changed nothing.
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
  resolveAuthSession: async () => (actor ? { user: actor, ageGate: "passed" as const } : null),
  verifyAuthHeader: async () => null,
}));

const s3 = vi.hoisted(() => ({
  objects: new Map<string, { contentType: string; contentLength: number }>(),
}));

vi.mock("../lib/s3.js", () => ({
  isStorageConfigured: () => true,
  presignPut: (key: string) => `https://bucket.test/${key}?sig=1`,
  presignGet: (key: string) => `https://bucket.test/${key}?get=1`,
  headObject: async (key: string) => s3.objects.get(key) ?? null,
  copyObject: async (from: string, to: string) => {
    const source = s3.objects.get(from);
    if (!source) {
      throw new Error("NoSuchKey");
    }
    s3.objects.set(to, source);
  },
  getObjectPrefix: async (key: string) => (s3.objects.has(key) ? new Uint8Array(16) : null),
  deleteObject: async (key: string) => {
    s3.objects.delete(key);
  },
}));

vi.mock("@pqp/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pqp/shared")>()),
  audioDurationMs: () => 1000,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");

let server: Server;
let baseUrl: string;

async function call<T = Record<string, unknown>>(
  as: { id: string; clerk_id: string } | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

interface AuditRow {
  action: string;
  changes: Array<{ key: string; old: unknown; new: unknown }> | null;
}

describeDb("soundboard management audit rows", () => {
  let owner: { id: string; clerk_id: string };
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
    delete process.env.SOUNDBOARD;
  });

  beforeEach(async () => {
    resetApiRateLimits();
    s3.objects.clear();
    process.env.SOUNDBOARD = "true";
    vi.spyOn(console, "log").mockImplementation(() => {});
    await getPool().query(
      `TRUNCATE users, servers, channels, server_members, channel_members, audit_log,
                soundboard_sounds, soundboard_pending_uploads
       RESTART IDENTITY CASCADE`,
    );
    owner = await upsertUser({ clerkId: "clerk_sb_owner", displayName: "Owner", avatarUrl: null });
    const created = await call<{ server: { id: string } }>(owner, "POST", "/api/servers", {
      name: "Board audit",
    });
    expect(created.status).toBe(201);
    serverId = created.body.server.id;
  });

  async function upload(): Promise<string> {
    const minted = await call<{ key: string }>(
      owner,
      "POST",
      `/api/servers/${serverId}/soundboard/uploads`,
      { contentType: "audio/mpeg", byteSize: 1000 },
    );
    expect(minted.status).toBe(200);
    s3.objects.set(minted.body.key, { contentType: "audio/mpeg", contentLength: 1000 });
    return minted.body.key;
  }

  function claim(key: string, name = "airhorn") {
    return call<{ sound: { id: string } }>(owner, "POST", `/api/servers/${serverId}/soundboard`, {
      key,
      name,
      emoji: "📣",
    });
  }

  async function audit(prefix = "soundboard."): Promise<AuditRow[]> {
    const rows = await getPool().query<AuditRow>(
      `SELECT action, changes FROM audit_log
        WHERE server_id = $1 AND action LIKE $2 ORDER BY id`,
      [serverId, `${prefix}%`],
    );
    return rows.rows;
  }

  it("writes one create row however many times the same upload is claimed", async () => {
    const key = await upload();
    const results = await Promise.all([claim(key), claim(key), claim(key)]);
    for (const result of results) {
      expect(result.status).toBe(200);
    }
    expect((await claim(key)).status).toBe(200);
    expect(await audit()).toEqual([
      { action: "soundboard.create", changes: [{ key: "name", old: null, new: "airhorn" }] },
    ]);
  });

  it("writes one delete row when the same clip is deleted in parallel", async () => {
    const created = await claim(await upload(), "contested");
    const path = `/api/servers/${serverId}/soundboard/${created.body.sound.id}`;
    const results = await Promise.all([
      call(owner, "DELETE", path),
      call(owner, "DELETE", path),
      call(owner, "DELETE", path),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 404, 404]);
    expect((await audit("soundboard.delete")).map((row) => row.changes)).toEqual([
      [{ key: "name", old: "contested", new: null }],
    ]);
  });

  it("stores what a rename and a volume change were before", async () => {
    const created = await claim(await upload(), "first name");
    const path = `/api/servers/${serverId}/soundboard/${created.body.sound.id}`;
    const patched = await call(owner, "PATCH", path, { name: "second name", volume: 0.5 });
    expect(patched.status).toBe(200);
    expect(await audit("soundboard.update")).toEqual([
      {
        action: "soundboard.update",
        changes: [
          { key: "name", old: "first name", new: "second name" },
          { key: "volume", old: 1, new: 0.5 },
        ],
      },
    ]);
  });

  it("writes no update row for a save that changes nothing", async () => {
    const created = await claim(await upload(), "steady");
    const path = `/api/servers/${serverId}/soundboard/${created.body.sound.id}`;
    expect((await call(owner, "PATCH", path, { name: "steady", volume: 1 })).status).toBe(200);
    expect(await audit("soundboard.update")).toEqual([]);
    expect((await call(owner, "PATCH", path, { volume: 0.3 })).status).toBe(200);
    expect((await call(owner, "PATCH", path, { volume: 0.3 })).status).toBe(200);
    expect(await audit("soundboard.update")).toEqual([
      {
        action: "soundboard.update",
        // A volume-only edit still names the clip it was made to.
        changes: [
          { key: "clip", old: null, new: "steady" },
          { key: "volume", old: 1, new: 0.3 },
        ],
      },
    ]);
  });

  it("deletes the server's clip files, and its uploads in flight, with the server", async () => {
    const claimedKey = await upload();
    expect((await claim(claimedKey)).status).toBe(200);
    const pendingKey = await upload();
    const stored = [...s3.objects.keys()].filter((key) => key.includes(".clip."));
    expect(stored).toHaveLength(1);
    expect((await call(owner, "DELETE", `/api/servers/${serverId}`)).status).toBe(200);
    // The file delete runs in the background after the rows cascade.
    await vi.waitFor(() => {
      expect(s3.objects.has(stored[0]!)).toBe(false);
      expect(s3.objects.has(pendingKey)).toBe(false);
    });
  });
});

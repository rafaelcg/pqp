import { readFileSync } from "node:fs";
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
 * Custom server emoji, end to end over HTTP.
 *
 * What has to hold:
 *  - any member may read the list (every member renders them), nobody else;
 *  - only Manage Emoji may mint, claim, rename or delete;
 *  - every row says who uploaded it, until that account is gone;
 *  - the mint validates name, type and size before signing, and says up front
 *    when the name is taken or the server is full;
 *  - the claim HEADs the object, re-checks name and limit, and cannot name
 *    another server's object;
 *  - the image route answers without a token and only for a real emoji.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const stubs = vi.hoisted(() => ({
  actor: null as { id: string; clerk_id: string } | null,
  load: null as
    | ((clerkId: string) => Promise<Record<string, unknown> | null>)
    | null,
}));

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => {
    const user = stubs.actor && (await stubs.load?.(stubs.actor.clerk_id));
    return user ? { user } : null;
  },
  resolveAuthSession: async () => {
    const user = stubs.actor && (await stubs.load?.(stubs.actor.clerk_id));
    return user ? { user, ageGate: "passed" as const } : null;
  },
  verifyAuthHeader: async () => null,
}));

const storage = vi.hoisted(() => ({
  configured: true,
  objects: new Map<string, { contentLength: number; contentType: string }>(),
  deletedKeys: [] as string[],
}));

vi.mock("../lib/s3.js", () => ({
  isStorageConfigured: () => storage.configured,
  presignPut: (key: string, contentType: string, byteSize: number) =>
    `https://storage.test/${key}?type=${encodeURIComponent(contentType)}&len=${byteSize}`,
  presignGet: (key: string) => `https://storage.test/${key}?sig=get`,
  headObject: async (key: string) => storage.objects.get(key) ?? null,
  deleteObject: async (key: string) => {
    storage.deletedKeys.push(key);
    storage.objects.delete(key);
  },
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { MAX_SERVER_EMOJI_BYTES, Permission, SERVER_EMOJI_DEFAULT_LIMIT } = await import(
  "@pqp/shared"
);

let server: Server;
let baseUrl: string;

type Actor = { id: string; clerk_id: string };

interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
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
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

/** Wait for the fire-and-forget object delete to land. */
async function flushDiscards(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describeDb("server emoji", () => {
  let owner: Actor;
  let admin: Actor;
  let member: Actor;
  let outsider: Actor;
  let serverId: string;
  let otherServerId: string;

  beforeAll(async () => {
    await initDb();
    stubs.load = async (clerkId) => {
      const result = await getPool().query(
        `SELECT id, clerk_id, display_name, username, discriminator,
                avatar_url, avatar_key, is_character
         FROM users WHERE clerk_id = $1`,
        [clerkId],
      );
      return result.rows[0] ?? null;
    };
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
    storage.configured = true;
    storage.objects.clear();
    storage.deletedKeys.length = 0;
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, server_invites, server_bans,
                audit_log, server_emoji
       RESTART IDENTITY CASCADE`,
    );
    owner = await upsertUser({ clerkId: "clerk_owner", displayName: "Owner", avatarUrl: null });
    admin = await upsertUser({ clerkId: "clerk_admin", displayName: "Admin", avatarUrl: null });
    member = await upsertUser({ clerkId: "clerk_member", displayName: "Member", avatarUrl: null });
    outsider = await upsertUser({
      clerkId: "clerk_outsider",
      displayName: "Outsider",
      avatarUrl: null,
    });
    const created = await call<{ server: { id: string } }>(owner, "POST", "/api/servers", {
      name: "Ghostty",
    });
    serverId = created.body.server.id;
    const other = await call<{ server: { id: string } }>(outsider, "POST", "/api/servers", {
      name: "Elsewhere",
    });
    otherServerId = other.body.server.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($1, $3, 'member')`,
      [serverId, admin.id, member.id],
    );
  });

  async function mint(
    as: Actor,
    body: { name?: string; contentType?: string; byteSize?: number } = {},
  ) {
    return call<{ key: string; uploadUrl: string; code?: string }>(
      as,
      "POST",
      `/api/servers/${serverId}/emoji/uploads`,
      { name: "pog", contentType: "image/png", byteSize: 4_000, ...body },
    );
  }

  /** Mint, "upload", claim: what a client does. */
  async function addEmoji(name: string, as: Actor = owner) {
    const minted = await mint(as, { name });
    expect(minted.status).toBe(201);
    storage.objects.set(minted.body.key, { contentLength: 4_000, contentType: "image/png" });
    const claimed = await call<{ emoji: { id: string; name: string; url: string } }>(
      as,
      "POST",
      `/api/servers/${serverId}/emoji`,
      { key: minted.body.key, name },
    );
    expect(claimed.status).toBe(201);
    return { ...claimed.body.emoji, key: minted.body.key };
  }

  describe("permissions", () => {
    it("needs a session to read the list", async () => {
      expect((await call(null, "GET", `/api/servers/${serverId}/emoji`)).status).toBe(401);
    });

    it("lets any member read the list, with the limit and upload state", async () => {
      await addEmoji("pog");
      const list = await call<{
        emoji: Array<{ name: string; url: string }>;
        limit: number;
        uploadEnabled: boolean;
        maxBytes: number;
      }>(member, "GET", `/api/servers/${serverId}/emoji`);
      expect(list.status).toBe(200);
      expect(list.body.emoji.map((e) => e.name)).toEqual(["pog"]);
      expect(list.body.emoji[0]!.url).toMatch(/^\/api\/emoji\/[0-9a-f-]{36}\?v=[0-9a-f]{8}$/);
      expect(list.body.limit).toBe(SERVER_EMOJI_DEFAULT_LIMIT);
      expect(list.body.uploadEnabled).toBe(true);
      expect(list.body.maxBytes).toBe(MAX_SERVER_EMOJI_BYTES);
    });

    it("hides the list from somebody outside the server", async () => {
      expect((await call(outsider, "GET", `/api/servers/${serverId}/emoji`)).status).toBe(404);
    });

    it("lets an admin add one", async () => {
      const emoji = await addEmoji("admin_made", admin);
      expect(emoji.name).toBe("admin_made");
    });

    it("refuses a plain member every write", async () => {
      const emoji = await addEmoji("pog");
      expect((await mint(member)).status).toBe(403);
      expect(
        (
          await call(member, "POST", `/api/servers/${serverId}/emoji`, {
            key: emoji.key,
            name: "again",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call(member, "PATCH", `/api/servers/${serverId}/emoji/${emoji.id}`, {
            name: "renamed",
          })
        ).status,
      ).toBe(403);
      expect(
        (await call(member, "DELETE", `/api/servers/${serverId}/emoji/${emoji.id}`)).status,
      ).toBe(403);
    });

    async function grantCargo(name: string, bits: bigint) {
      const role = await getPool().query<{ id: string }>(
        `INSERT INTO roles (server_id, name, permissions, position)
         VALUES ($1, $2, $3, 1) RETURNING id`,
        [serverId, name, bits.toString()],
      );
      await getPool().query(
        "INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)",
        [serverId, member.id, role.rows[0]!.id],
      );
    }

    it("lets a member with only Manage Emoji granted by a cargo add, rename and delete", async () => {
      await grantCargo("Emoji_crew", Permission.MANAGE_EMOJI);
      const emoji = await addEmoji("crew", member);
      expect(emoji.name).toBe("crew");
      expect(
        (
          await call(member, "PATCH", `/api/servers/${serverId}/emoji/${emoji.id}`, {
            name: "crew_two",
          })
        ).status,
      ).toBe(200);
      expect(
        (await call(member, "DELETE", `/api/servers/${serverId}/emoji/${emoji.id}`)).status,
      ).toBe(200);
    });

    it("no longer lets Manage Server alone touch emoji", async () => {
      await grantCargo("Server_crew", Permission.MANAGE_SERVER);
      const emoji = await addEmoji("pog");
      expect((await mint(member)).status).toBe(403);
      expect(
        (
          await call(member, "PATCH", `/api/servers/${serverId}/emoji/${emoji.id}`, {
            name: "renamed",
          })
        ).status,
      ).toBe(403);
      expect(
        (await call(member, "DELETE", `/api/servers/${serverId}/emoji/${emoji.id}`)).status,
      ).toBe(403);
    });

    it("gives the seeded Admin and Manager cargos Manage Emoji on a new server", async () => {
      const seeded = await getPool().query<{ system_key: string; permissions: string }>(
        `SELECT system_key, permissions::text FROM roles
          WHERE server_id = $1 AND system_key IN ('admin', 'manager', 'moderator', 'everyone')`,
        [serverId],
      );
      const holds = Object.fromEntries(
        seeded.rows.map((row) => [
          row.system_key,
          (BigInt(row.permissions) & Permission.MANAGE_EMOJI) === Permission.MANAGE_EMOJI,
        ]),
      );
      expect(holds).toEqual({ admin: true, manager: true, moderator: false, everyone: false });
    });

    it("backfills Manage Emoji onto an existing server's Admin and Manager once, and nowhere else", async () => {
      const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
      const start = schema.indexOf("-- MANAGE_EMOJI (bit 26");
      const block = schema.slice(
        schema.indexOf("DO $$", start),
        schema.indexOf("END $$;", start) + "END $$;".length,
      );
      const bit = Permission.MANAGE_EMOJI.toString();
      await grantCargo("Homemade", Permission.MANAGE_SERVER);
      // A server from before the bit existed.
      await getPool().query(
        `UPDATE roles SET permissions = permissions & ~$2::bigint WHERE server_id = $1`,
        [serverId, bit],
      );
      await getPool().query(
        `DELETE FROM data_migrations WHERE name = 'manage_emoji_bit_2026_10'`,
      );

      const holders = async () =>
        (
          await getPool().query<{ label: string }>(
            `SELECT COALESCE(system_key, name) AS label FROM roles
              WHERE server_id = $1 AND (permissions & $2::bigint) <> 0
              ORDER BY 1`,
            [serverId, bit],
          )
        ).rows.map((row) => row.label);

      await getPool().query(block);
      expect(await holders()).toEqual(["admin", "manager"]);

      // An owner who turns it off keeps it off on the next boot.
      await getPool().query(
        `UPDATE roles SET permissions = permissions & ~$2::bigint
          WHERE server_id = $1 AND system_key = 'manager'`,
        [serverId, bit],
      );
      await getPool().query(block);
      expect(await holders()).toEqual(["admin"]);
    });

    it("never signs a URL for an outsider", async () => {
      const result = await mint(outsider);
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.body).not.toHaveProperty("uploadUrl");
    });
  });

  describe("validation", () => {
    for (const name of ["A", "Pog", "two words", "x", "a".repeat(33), "pog!", "pão", ""]) {
      it(`refuses the name ${JSON.stringify(name)}`, async () => {
        expect((await mint(owner, { name })).status).toBe(400);
      });
    }

    for (const contentType of ["image/gif", "image/svg+xml", "text/html"]) {
      it(`refuses ${contentType}`, async () => {
        expect((await mint(owner, { contentType })).status).toBe(400);
      });
    }

    it("refuses an image over the byte cap, with a code", async () => {
      const result = await mint(owner, { byteSize: MAX_SERVER_EMOJI_BYTES + 1 });
      expect(result.status).toBe(413);
      expect(result.body.code).toBe("emoji_too_large");
    });

    it("signs the length and keeps the key under this server's emoji prefix", async () => {
      const result = await mint(owner, { byteSize: 1234 });
      expect(result.status).toBe(201);
      expect(result.body.key.startsWith(`servers/${serverId}/emoji/`)).toBe(true);
      expect(result.body.key.endsWith(".png")).toBe(true);
      expect(result.body.uploadUrl).toContain("len=1234");
    });

    it("says a name is taken before the upload", async () => {
      await addEmoji("pog");
      const result = await mint(owner, { name: "pog" });
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("emoji_name_taken");
    });

    it("says the server is full before the upload, and at the claim", async () => {
      const values = Array.from(
        { length: SERVER_EMOJI_DEFAULT_LIMIT },
        (_, i) => `('${serverId}', 'e${i}', 'servers/${serverId}/emoji/x${i}.png')`,
      ).join(",");
      await getPool().query(
        `INSERT INTO server_emoji (server_id, name, storage_key) VALUES ${values}`,
      );
      const minted = await mint(owner, { name: "one_more" });
      expect(minted.status).toBe(409);
      expect(minted.body.code).toBe("emoji_limit_reached");

      const key = `servers/${serverId}/emoji/late.png`;
      storage.objects.set(key, { contentLength: 4_000, contentType: "image/png" });
      const claimed = await call<{ code?: string }>(owner, "POST", `/api/servers/${serverId}/emoji`, {
        key,
        name: "one_more",
      });
      expect(claimed.status).toBe(409);
      expect(claimed.body.code).toBe("emoji_limit_reached");
      await flushDiscards();
      expect(storage.deletedKeys).toContain(key);
    });

    it("refuses a name taken between mint and claim, and drops the orphan", async () => {
      const first = await mint(owner, { name: "race" });
      await addEmoji("race");
      storage.objects.set(first.body.key, { contentLength: 4_000, contentType: "image/png" });
      const claimed = await call<{ code?: string }>(owner, "POST", `/api/servers/${serverId}/emoji`, {
        key: first.body.key,
        name: "race",
      });
      expect(claimed.status).toBe(409);
      expect(claimed.body.code).toBe("emoji_name_taken");
      await flushDiscards();
      expect(storage.deletedKeys).toContain(first.body.key);
    });
  });

  describe("the claim", () => {
    it("refuses a key that was never uploaded", async () => {
      const minted = await mint(owner);
      const result = await call<{ code?: string }>(owner, "POST", `/api/servers/${serverId}/emoji`, {
        key: minted.body.key,
        name: "pog",
      });
      expect(result.status).toBe(400);
      expect(result.body.code).toBe("emoji_upload_unverified");
    });

    it("refuses an object stored as another type", async () => {
      const minted = await mint(owner);
      storage.objects.set(minted.body.key, { contentLength: 4_000, contentType: "text/html" });
      const result = await call(owner, "POST", `/api/servers/${serverId}/emoji`, {
        key: minted.body.key,
        name: "pog",
      });
      expect(result.status).toBe(400);
    });

    it("refuses an object over the cap", async () => {
      const minted = await mint(owner);
      storage.objects.set(minted.body.key, {
        contentLength: MAX_SERVER_EMOJI_BYTES + 1,
        contentType: "image/png",
      });
      const result = await call(owner, "POST", `/api/servers/${serverId}/emoji`, {
        key: minted.body.key,
        name: "pog",
      });
      expect(result.status).toBe(400);
    });

    for (const key of [
      "servers/OTHER/emoji/x.png",
      "servers/SELF/icon/x.png",
      "servers/SELF/emoji/../../OTHER/emoji/x.png",
    ]) {
      it(`refuses the foreign key ${key}`, async () => {
        const resolved = key.replace("OTHER", otherServerId).replace("SELF", serverId);
        storage.objects.set(resolved, { contentLength: 4_000, contentType: "image/png" });
        const result = await call(owner, "POST", `/api/servers/${serverId}/emoji`, {
          key: resolved,
          name: "pog",
        });
        expect(result.status).toBe(400);
      });
    }

    it("answers 503 with a code when storage is off", async () => {
      storage.configured = false;
      const result = await mint(owner);
      expect(result.status).toBe(503);
      expect(result.body.code).toBe("emoji_storage_off");
    });

    it("writes an audit entry with the name and never the key", async () => {
      const emoji = await addEmoji("pog");
      const audit = await getPool().query(
        "SELECT action, target_type, target_id, changes FROM audit_log WHERE server_id = $1",
        [serverId],
      );
      const entry = audit.rows.find((row) => row.action === "emoji.create");
      expect(entry).toMatchObject({ target_type: "emoji", target_id: emoji.id });
      expect(JSON.stringify(entry.changes)).not.toContain(emoji.key);
    });
  });

  describe("the uploader", () => {
    type Uploaded = { createdBy: string | null; createdByName: string | null; name: string };

    it("names who uploaded each emoji, on the claim, the list and a rename", async () => {
      const minted = await mint(admin, { name: "pog" });
      storage.objects.set(minted.body.key, { contentLength: 4_000, contentType: "image/png" });
      const claimed = await call<{ emoji: Uploaded & { id: string } }>(
        admin,
        "POST",
        `/api/servers/${serverId}/emoji`,
        { key: minted.body.key, name: "pog" },
      );
      expect(claimed.body.emoji).toMatchObject({ createdBy: admin.id, createdByName: "Admin" });
      await addEmoji("owner_made");

      const list = await call<{ emoji: Uploaded[] }>(member, "GET", `/api/servers/${serverId}/emoji`);
      expect(list.body.emoji).toEqual([
        expect.objectContaining({ name: "owner_made", createdBy: owner.id, createdByName: "Owner" }),
        expect.objectContaining({ name: "pog", createdBy: admin.id, createdByName: "Admin" }),
      ]);

      const renamed = await call<{ emoji: Uploaded }>(
        owner,
        "PATCH",
        `/api/servers/${serverId}/emoji/${claimed.body.emoji.id}`,
        { name: "poggers" },
      );
      expect(renamed.body.emoji).toMatchObject({ createdBy: admin.id, createdByName: "Admin" });
    });

    it("keeps the emoji and drops the name once the uploader's account is gone", async () => {
      await addEmoji("pog", admin);
      await getPool().query("DELETE FROM users WHERE id = $1", [admin.id]);
      const list = await call<{ emoji: Uploaded[] }>(owner, "GET", `/api/servers/${serverId}/emoji`);
      expect(list.body.emoji).toEqual([
        expect.objectContaining({ name: "pog", createdBy: null, createdByName: null }),
      ]);
    });
  });

  describe("rename and delete", () => {
    it("renames, keeping the id and the url", async () => {
      const emoji = await addEmoji("pog");
      const result = await call<{ emoji: { id: string; name: string; url: string } }>(
        owner,
        "PATCH",
        `/api/servers/${serverId}/emoji/${emoji.id}`,
        { name: "poggers" },
      );
      expect(result.status).toBe(200);
      expect(result.body.emoji).toMatchObject({ id: emoji.id, name: "poggers", url: emoji.url });
    });

    it("refuses a rename onto a taken name", async () => {
      const emoji = await addEmoji("pog");
      await addEmoji("kek");
      const result = await call<{ code?: string }>(
        owner,
        "PATCH",
        `/api/servers/${serverId}/emoji/${emoji.id}`,
        { name: "kek" },
      );
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("emoji_name_taken");
    });

    it("cannot reach another server's emoji through this server's path", async () => {
      const emoji = await addEmoji("pog");
      await getPool().query(
        "INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'admin')",
        [otherServerId, owner.id],
      );
      const result = await call(
        owner,
        "DELETE",
        `/api/servers/${otherServerId}/emoji/${emoji.id}`,
      );
      expect(result.status).toBe(404);
    });

    it("deletes the row and drops the object, even with storage off", async () => {
      const emoji = await addEmoji("pog");
      const result = await call(owner, "DELETE", `/api/servers/${serverId}/emoji/${emoji.id}`);
      expect(result.status).toBe(200);
      const list = await call<{ emoji: unknown[] }>(owner, "GET", `/api/servers/${serverId}/emoji`);
      expect(list.body.emoji).toEqual([]);
      await flushDiscards();
      expect(storage.deletedKeys).toContain(emoji.key);

      const second = await addEmoji("kek");
      storage.configured = false;
      expect(
        (await call(owner, "DELETE", `/api/servers/${serverId}/emoji/${second.id}`)).status,
      ).toBe(200);
    });
  });

  describe("the image route", () => {
    it("redirects without a token", async () => {
      const emoji = await addEmoji("pog");
      stubs.actor = null;
      const response = await fetch(`${baseUrl}${emoji.url}`, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `https://storage.test/${emoji.key}?sig=get`,
      );
    });

    it("is a 404 for an unknown id", async () => {
      stubs.actor = null;
      const response = await fetch(
        `${baseUrl}/api/emoji/00000000-0000-4000-8000-000000000000`,
        { redirect: "manual" },
      );
      expect(response.status).toBe(404);
    });
  });
});

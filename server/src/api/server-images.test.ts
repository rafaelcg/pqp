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
 * A server's icon and banner, end to end over HTTP.
 *
 * In its own file for the same reason avatars.test.ts is: api.test.ts leaves
 * `lib/s3.js` real and therefore unconfigured, which is the shape a deployment
 * without `S3_*` is in. This needs both shapes, and flips the same fake.
 *
 * What has to hold:
 *
 *  - every route needs a session, the config read included (CLAUDE.md #8);
 *  - **Manage Server** may mint, claim or clear — name, icon and banner sit
 *    on that bit. An owner always has it. A plain member does not.
 *    Transfer, retention, SSO and delete stay owner-only.
 *  - the mint enforces the type allowlist and the *per-kind* byte cap before
 *    signing, so a banner's eight megabytes is not an icon's ceiling;
 *  - the claim HEADs the object and refuses anything it cannot vouch for —
 *    never uploaded, wrong stored type, over the cap;
 *  - a claim cannot name another server's object, nor traverse out of its own
 *    prefix;
 *  - what is claimed reaches `GET /api/servers` and the communities directory,
 *    which is the entire point of the feature;
 *  - the image route is servable by a browser, i.e. without a token, and
 *    cannot be aimed at an arbitrary object in the bucket.
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
const { MAX_SERVER_BANNER_BYTES, MAX_SERVER_ICON_BYTES } = await import(
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
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

/** No `Authorization` header at all — what an `<img src>` sends. */
async function fetchImage(path: string) {
  stubs.actor = null;
  return fetch(`${baseUrl}${path}`, { redirect: "manual" });
}

describeDb("server images", () => {
  let owner: Actor;
  let admin: Actor;
  let member: Actor;
  let serverId: string;

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
    delete process.env.COMMUNITIES_ENABLED;
  });

  beforeEach(async () => {
    resetApiRateLimits();
    storage.configured = true;
    storage.objects.clear();
    storage.deletedKeys.length = 0;

    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, server_invites, server_bans,
                channel_reads, message_mentions, message_reactions,
                message_attachments, user_blocks, dm_pairs, link_embeds,
                audit_log
       RESTART IDENTITY CASCADE`,
    );

    owner = await upsertUser({
      clerkId: "clerk_owner",
      displayName: "Owner",
      avatarUrl: null,
    });
    admin = await upsertUser({
      clerkId: "clerk_admin",
      displayName: "Admin",
      avatarUrl: null,
    });
    member = await upsertUser({
      clerkId: "clerk_member",
      displayName: "Member",
      avatarUrl: null,
    });

    const created = await call<{ server: { id: string } }>(
      owner,
      "POST",
      "/api/servers",
      { name: "Ghostty" },
    );
    serverId = created.body.server.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($1, $3, 'member')`,
      [serverId, admin.id, member.id],
    );
  });

  /** Mint, "upload", and claim — the whole dance a client does. */
  async function setImage(
    kind: "icon" | "banner",
    options: { contentType?: string; bytes?: number } = {},
  ): Promise<string> {
    const contentType = options.contentType ?? "image/jpeg";
    const bytes = options.bytes ?? 40_000;
    const mint = await call<{ key: string }>(
      owner,
      "POST",
      `/api/servers/${serverId}/${kind}`,
      { contentType, byteSize: bytes },
    );
    expect(mint.status).toBe(201);
    storage.objects.set(mint.body.key, { contentLength: bytes, contentType });
    const claimed = await call(
      owner,
      "POST",
      `/api/servers/${serverId}/${kind}/claim`,
      { key: mint.body.key },
    );
    expect(claimed.status).toBe(200);
    return mint.body.key;
  }

  describe("config", () => {
    it("needs a session, like every other /api route", async () => {
      const anonymous = await call(null, "GET", "/api/servers/images/config");
      expect(anonymous.status).toBe(401);
    });

    it("reports both caps and both target shapes in either state", async () => {
      const on = await call<{
        enabled: boolean;
        icon: { maxBytes: number };
        banner: { maxBytes: number; width: number; height: number };
      }>(member, "GET", "/api/servers/images/config");
      expect(on.body.enabled).toBe(true);
      expect(on.body.icon.maxBytes).toBe(MAX_SERVER_ICON_BYTES);
      expect(on.body.banner.maxBytes).toBe(MAX_SERVER_BANNER_BYTES);
      expect(on.body.banner.width).toBeGreaterThan(on.body.banner.height);

      storage.configured = false;
      const off = await call<{ enabled: boolean; icon: { maxBytes: number } }>(
        member,
        "GET",
        "/api/servers/images/config",
      );
      // Off is a deployment shape, not an error — and the limits still ride
      // along so a picker never has to guess.
      expect(off.body.enabled).toBe(false);
      expect(off.body.icon.maxBytes).toBe(MAX_SERVER_ICON_BYTES);
    });

    it("is not shadowed by the :serverId routes beside it", async () => {
      // `images` is not a UUID, but a path that could be read either way is a
      // bug waiting for the first server whose id is the word "images".
      const result = await call(member, "GET", "/api/servers/images/config");
      expect(result.status).toBe(200);
    });
  });

  describe("who may change a picture", () => {
    it("refuses an anonymous mint", async () => {
      const result = await call(null, "POST", `/api/servers/${serverId}/icon`, {
        contentType: "image/jpeg",
        byteSize: 1000,
      });
      expect(result.status).toBe(401);
    });

    for (const kind of ["icon", "banner"] as const) {
      it(`lets an admin mint a ${kind} (Manage Server)`, async () => {
        const result = await call(
          admin,
          "POST",
          `/api/servers/${serverId}/${kind}`,
          { contentType: "image/jpeg", byteSize: 1000 },
        );
        expect(result.status).toBe(201);
      });

      it(`refuses a plain member clearing the ${kind}`, async () => {
        const result = await call(
          member,
          "DELETE",
          `/api/servers/${serverId}/${kind}`,
        );
        expect(result.status).toBe(403);
      });
    }

    it("refuses somebody who is not in the server at all", async () => {
      const outsider = await upsertUser({
        clerkId: "clerk_outsider",
        displayName: "Outsider",
        avatarUrl: null,
      });
      const result = await call(
        outsider,
        "POST",
        `/api/servers/${serverId}/banner`,
        { contentType: "image/jpeg", byteSize: 1000 },
      );
      // 403/404 either way; what must never happen is a signed URL.
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.body).not.toHaveProperty("uploadUrl");
    });
  });

  describe("the mint", () => {
    it("signs a key under this server's own prefix", async () => {
      const result = await call<{ key: string; uploadUrl: string }>(
        owner,
        "POST",
        `/api/servers/${serverId}/icon`,
        { contentType: "image/jpeg", byteSize: 40_000 },
      );
      expect(result.status).toBe(201);
      expect(result.body.key.startsWith(`servers/${serverId}/icon/`)).toBe(true);
      // The length is in the signature, which is what stops a client minting
      // for 40 KB and pushing eight megabytes through it.
      expect(result.body.uploadUrl).toContain("len=40000");
    });

    for (const contentType of ["image/gif", "image/svg+xml", "text/html"]) {
      it(`refuses ${contentType}`, async () => {
        const result = await call(
          owner,
          "POST",
          `/api/servers/${serverId}/icon`,
          { contentType, byteSize: 1000 },
        );
        expect(result.status).toBe(400);
      });
    }

    it("holds an icon to the icon cap, not the banner's", async () => {
      const tooBig = await call(owner, "POST", `/api/servers/${serverId}/icon`, {
        contentType: "image/jpeg",
        byteSize: MAX_SERVER_ICON_BYTES + 1,
      });
      expect(tooBig.status).toBe(413);

      // The same number is fine for a banner, which is the whole point of
      // applying the cap per kind rather than in the shared schema.
      const banner = await call(
        owner,
        "POST",
        `/api/servers/${serverId}/banner`,
        { contentType: "image/jpeg", byteSize: MAX_SERVER_ICON_BYTES + 1 },
      );
      expect(banner.status).toBe(201);
    });

    it("refuses a banner over the banner cap", async () => {
      const result = await call(
        owner,
        "POST",
        `/api/servers/${serverId}/banner`,
        { contentType: "image/jpeg", byteSize: MAX_SERVER_BANNER_BYTES + 1 },
      );
      expect(result.status).toBe(400);
    });

    it("503s with no storage configured, rather than signing nothing", async () => {
      storage.configured = false;
      const result = await call(owner, "POST", `/api/servers/${serverId}/icon`, {
        contentType: "image/jpeg",
        byteSize: 1000,
      });
      expect(result.status).toBe(503);
    });
  });

  describe("the claim", () => {
    it("refuses a key that was never uploaded", async () => {
      const mint = await call<{ key: string }>(
        owner,
        "POST",
        `/api/servers/${serverId}/icon`,
        { contentType: "image/jpeg", byteSize: 40_000 },
      );
      // Deliberately no `storage.objects.set` — this is the case only a HEAD
      // can tell apart from a successful upload.
      const claimed = await call(
        owner,
        "POST",
        `/api/servers/${serverId}/icon/claim`,
        { key: mint.body.key },
      );
      expect(claimed.status).toBe(400);

      const servers = await call<{ servers: { iconUrl: string | null }[] }>(
        owner,
        "GET",
        "/api/servers",
      );
      expect(servers.body.servers[0]!.iconUrl).toBeNull();
    });

    it("refuses an object stored as a different type than was signed", async () => {
      const mint = await call<{ key: string }>(
        owner,
        "POST",
        `/api/servers/${serverId}/icon`,
        { contentType: "image/jpeg", byteSize: 40_000 },
      );
      storage.objects.set(mint.body.key, {
        contentLength: 40_000,
        contentType: "text/html",
      });
      const claimed = await call(
        owner,
        "POST",
        `/api/servers/${serverId}/icon/claim`,
        { key: mint.body.key },
      );
      expect(claimed.status).toBe(400);
    });

    it("refuses an object bigger than the cap, whatever was signed", async () => {
      const mint = await call<{ key: string }>(
        owner,
        "POST",
        `/api/servers/${serverId}/icon`,
        { contentType: "image/jpeg", byteSize: 40_000 },
      );
      // Covers a store that ignores the signed Content-Length.
      storage.objects.set(mint.body.key, {
        contentLength: MAX_SERVER_ICON_BYTES + 1,
        contentType: "image/jpeg",
      });
      const claimed = await call(
        owner,
        "POST",
        `/api/servers/${serverId}/icon/claim`,
        { key: mint.body.key },
      );
      expect(claimed.status).toBe(400);
    });

    it("refuses a key belonging to another server", async () => {
      const other = await call<{ server: { id: string } }>(
        owner,
        "POST",
        "/api/servers",
        { name: "Other" },
      );
      const otherId = other.body.server.id;
      const stolenKey = `servers/${otherId}/icon/aaaa.jpg`;
      storage.objects.set(stolenKey, {
        contentLength: 1000,
        contentType: "image/jpeg",
      });
      const claimed = await call(
        owner,
        "POST",
        `/api/servers/${serverId}/icon/claim`,
        { key: stolenKey },
      );
      expect(claimed.status).toBe(400);
    });

    it("refuses a key belonging to the other kind", async () => {
      // A banner claimed as an icon would be stored at the wrong aspect ratio
      // and, more importantly, means the prefix check is not doing its job.
      const bannerKey = await setImage("banner");
      const claimed = await call(
        owner,
        "POST",
        `/api/servers/${serverId}/icon/claim`,
        { key: bannerKey },
      );
      expect(claimed.status).toBe(400);
    });

    it("refuses traversal out of the prefix", async () => {
      const claimed = await call(
        owner,
        "POST",
        `/api/servers/${serverId}/icon/claim`,
        { key: `servers/${serverId}/icon/../../elsewhere/x.jpg` },
      );
      expect(claimed.status).toBe(400);
    });

    it("never puts the storage key on the wire", async () => {
      const key = await mintAndStore("icon");
      const claimed = await call<{ server: Record<string, unknown> }>(
        owner,
        "POST",
        `/api/servers/${serverId}/icon/claim`,
        { key },
      );
      expect(claimed.status).toBe(200);
      // The payload carries `iconUrl`, which is the *route* — never the bucket
      // key. `SERVER_COLUMNS` deliberately does not select `icon_key`.
      const wire = JSON.stringify(claimed.body);
      expect(wire).not.toContain(key);
      expect(wire).not.toContain("iconKey");
      expect(wire).not.toContain("icon_key");
    });
  });

  async function mintAndStore(kind: "icon" | "banner"): Promise<string> {
    const mint = await call<{ key: string }>(
      owner,
      "POST",
      `/api/servers/${serverId}/${kind}`,
      { contentType: "image/jpeg", byteSize: 40_000 },
    );
    storage.objects.set(mint.body.key, {
      contentLength: 40_000,
      contentType: "image/jpeg",
    });
    return mint.body.key;
  }

  describe("what a claimed picture reaches", () => {
    it("shows on GET /api/servers, for a member and not just the owner", async () => {
      await setImage("icon");
      await setImage("banner");

      const seen = await call<{
        servers: { id: string; iconUrl: string; bannerUrl: string }[];
      }>(member, "GET", "/api/servers");
      const row = seen.body.servers.find((s) => s.id === serverId)!;
      expect(row.iconUrl).toMatch(
        new RegExp(`^/api/servers/${serverId}/icon\\?v=[0-9a-f]{8}$`),
      );
      expect(row.bannerUrl).toMatch(
        new RegExp(`^/api/servers/${serverId}/banner\\?v=[0-9a-f]{8}$`),
      );
    });

    it("changes address when the picture changes, so no cache can hold a stale one", async () => {
      await setImage("icon");
      const first = (
        await call<{ servers: { id: string; iconUrl: string }[] }>(
          owner,
          "GET",
          "/api/servers",
        )
      ).body.servers.find((s) => s.id === serverId)!.iconUrl;

      await setImage("icon");
      const second = (
        await call<{ servers: { id: string; iconUrl: string }[] }>(
          owner,
          "GET",
          "/api/servers",
        )
      ).body.servers.find((s) => s.id === serverId)!.iconUrl;

      expect(second).not.toBe(first);
    });

    it("reaches the communities directory card", async () => {
      process.env.COMMUNITIES_ENABLED = "true";
      try {
        await setImage("icon");
        await setImage("banner");
        await call(owner, "PATCH", `/api/servers/${serverId}/community`, {
          isCommunity: true,
        });

        // Read by somebody who is not in it — a directory card is what a
        // stranger sees, and that is the payload the pictures have to reach.
        const outsider = await upsertUser({
          clerkId: "clerk_stranger",
          displayName: "Stranger",
          avatarUrl: null,
        });
        const page = await call<{
          communities: {
            id: string;
            iconUrl: string | null;
            bannerUrl: string | null;
          }[];
        }>(outsider, "GET", "/api/communities?search=Ghostty");
        const card = page.body.communities.find((c) => c.id === serverId)!;
        expect(card.iconUrl).toContain(`/api/servers/${serverId}/icon`);
        expect(card.bannerUrl).toContain(`/api/servers/${serverId}/banner`);
      } finally {
        delete process.env.COMMUNITIES_ENABLED;
      }
    });

    it("writes an audit entry an owner can read back", async () => {
      await setImage("banner");
      const log = await call<{ entries: { action: string }[] }>(
        owner,
        "GET",
        `/api/servers/${serverId}/audit-log`,
      );
      expect(log.body.entries.map((e) => e.action)).toContain(
        "server.banner_update",
      );
    });
  });

  describe("replacing and clearing", () => {
    it("drops the object the server stops pointing at", async () => {
      const first = await setImage("icon");
      const second = await setImage("icon");
      expect(second).not.toBe(first);
      // Give the fire-and-forget delete a tick to land.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(storage.deletedKeys).toEqual([first]);
    });

    it("leaves the other kind alone when one is replaced", async () => {
      const bannerKey = await setImage("banner");
      await setImage("icon");
      await setImage("icon");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(storage.deletedKeys).not.toContain(bannerKey);

      const row = await getPool().query<{ banner_key: string | null }>(
        `SELECT banner_key FROM servers WHERE id = $1`,
        [serverId],
      );
      expect(row.rows[0]!.banner_key).toBe(bannerKey);
    });

    it("clears the column and the object on DELETE", async () => {
      const key = await setImage("banner");
      const cleared = await call<{ server: { bannerUrl: string | null } }>(
        owner,
        "DELETE",
        `/api/servers/${serverId}/banner`,
      );
      expect(cleared.status).toBe(200);
      expect(cleared.body.server.bannerUrl).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(storage.deletedKeys).toEqual([key]);
    });

    it("stays clearable after storage is gone", async () => {
      await setImage("icon");
      storage.configured = false;
      // Deliberately not gated on storage: a server that lost its bucket must
      // still be able to stop pointing at an object nobody can serve.
      const cleared = await call(owner, "DELETE", `/api/servers/${serverId}/icon`);
      expect(cleared.status).toBe(200);
    });

    it("orphans both objects when the whole server is deleted", async () => {
      const iconKey = await setImage("icon");
      const bannerKey = await setImage("banner");
      const deleted = await call(owner, "DELETE", `/api/servers/${serverId}`);
      expect(deleted.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(storage.deletedKeys).toEqual(
        expect.arrayContaining([iconKey, bannerKey]),
      );
    });
  });

  describe("the image route", () => {
    it("redirects without any token — a browser cannot send one", async () => {
      await setImage("icon");
      const response = await fetchImage(`/api/servers/${serverId}/icon`);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        `servers/${serverId}/icon/`,
      );
    });

    it("serves the banner from its own path", async () => {
      await setImage("banner");
      const response = await fetchImage(`/api/servers/${serverId}/banner`);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        `servers/${serverId}/banner/`,
      );
    });

    it("404s for a server that set no picture", async () => {
      const response = await fetchImage(`/api/servers/${serverId}/banner`);
      expect(response.status).toBe(404);
    });

    it("404s for an id that is not a server, without confirming which", async () => {
      const response = await fetchImage(
        "/api/servers/11111111-1111-4111-8111-111111111111/icon",
      );
      expect(response.status).toBe(404);
    });

    it("cannot be aimed at an arbitrary object in the bucket", async () => {
      await setImage("icon");
      // The path names a server; there is no shape of request that carries a
      // storage key at all.
      const response = await fetchImage(
        `/api/servers/${serverId}/icon/../../avatars/x.jpg`,
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it("404s when storage is unconfigured, rather than 500ing", async () => {
      await setImage("icon");
      storage.configured = false;
      const response = await fetchImage(`/api/servers/${serverId}/icon`);
      expect(response.status).toBe(404);
    });
  });
});

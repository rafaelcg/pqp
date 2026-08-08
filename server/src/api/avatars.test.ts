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
 * Uploaded profile pictures, end to end over HTTP.
 *
 * In its own file rather than in api.test.ts because that suite deliberately
 * leaves `lib/s3.js` real — and therefore unconfigured — which is the shape a
 * deployment without `S3_*` is in. Avatars need both shapes: the "off" one is
 * asserted here too, by flipping the same fake.
 *
 * What has to hold:
 *
 *  - every route needs a session, including the config read (CLAUDE.md #8);
 *  - the mint enforces the type allowlist and the byte cap before signing;
 *  - the claim HEADs the object and refuses anything it cannot vouch for;
 *  - a claim cannot name another account's object, which is the one thing
 *    standing in for the ownership row `message_attachments` has and this
 *    does not;
 *  - the claimed avatar reaches `/api/me` and — the point of the whole
 *    feature — every payload that carries somebody else: message authors,
 *    member lists, user search, DM participants;
 *  - `DELETE` puts it back to nothing and drops the object;
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
  /**
   * Re-read the row on every request, rather than answering with a fixed
   * object the way the other suites' stubs do.
   *
   * That is not incidental here. `GET /api/me` renders the *session's* user
   * row, and the real `resolveAuthSession` re-reads it whenever
   * `invalidateUserCache` has been called — which the avatar routes do. A stub
   * that hands back a snapshot taken in `beforeEach` would show every avatar
   * write as having done nothing, and the test would be asserting on the stub.
   */
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

describeDb("avatars", () => {
  let alice: Actor;
  let bob: Actor;

  beforeAll(async () => {
    await initDb();
    stubs.load = async (clerkId) => {
      const result = await getPool().query(
        // `banner_url` rides along because `/api/me` renders the SESSION's row
        // and `toPublicUser` reads it off that object. A stub selecting a
        // narrower list would show every banner write as having done nothing —
        // the same trap the note on `load` above describes for avatars.
        `SELECT id, clerk_id, display_name, username, discriminator,
                avatar_url, avatar_key, banner_url, banner_key
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
                channel_reads, message_mentions, message_reactions,
                message_attachments, user_blocks, dm_pairs, link_embeds
       RESTART IDENTITY CASCADE`,
    );

    alice = await upsertUser({
      clerkId: "clerk_alice",
      displayName: "Alice",
      avatarUrl: null,
    });
    bob = await upsertUser({
      clerkId: "clerk_bob",
      displayName: "Bob",
      avatarUrl: null,
    });
  });

  /** Mint, "upload", and claim — the whole dance a client does. */
  async function setAvatar(
    as: Actor,
    options: { contentType?: string; bytes?: number } = {},
  ): Promise<string> {
    const contentType = options.contentType ?? "image/jpeg";
    const bytes = options.bytes ?? 40_000;
    const mint = await call<{ key: string; uploadUrl: string }>(
      as,
      "POST",
      "/api/me/avatar",
      { contentType, byteSize: bytes },
    );
    expect(mint.status).toBe(201);
    storage.objects.set(mint.body.key, {
      contentLength: bytes,
      contentType,
    });
    const claimed = await call(as, "POST", "/api/me/avatar/claim", {
      key: mint.body.key,
    });
    expect(claimed.status).toBe(200);
    return mint.body.key;
  }

  describe("config", () => {
    it("needs a session, like every other /api route", async () => {
      const anonymous = await call(null, "GET", "/api/avatars/config");
      expect(anonymous.status).toBe(401);
    });

    it("reports the cap and the target size in both states", async () => {
      const on = await call(alice, "GET", "/api/avatars/config");
      expect(on.body).toEqual({
        enabled: true,
        maxBytes: 5 * 1024 * 1024,
        size: 512,
      });

      storage.configured = false;
      const off = await call(alice, "GET", "/api/avatars/config");
      // Still a 200 with the same numbers: the picker rejects an over-size file
      // against this deployment's cap whether or not it can upload it.
      expect(off.status).toBe(200);
      expect(off.body).toMatchObject({ enabled: false, maxBytes: 5 * 1024 * 1024 });
    });
  });

  describe("mint", () => {
    it("refuses an anonymous caller", async () => {
      const result = await call(null, "POST", "/api/me/avatar", {
        contentType: "image/jpeg",
        byteSize: 100,
      });
      expect(result.status).toBe(401);
    });

    it("signs the declared type and length into the upload URL", async () => {
      const result = await call<{ key: string; uploadUrl: string }>(
        alice,
        "POST",
        "/api/me/avatar",
        { contentType: "image/png", byteSize: 1234 },
      );
      expect(result.status).toBe(201);
      expect(result.body.key).toContain(`avatars/${alice.id}/`);
      expect(result.body.uploadUrl).toContain("type=image%2Fpng");
      expect(result.body.uploadUrl).toContain("len=1234");
    });

    it("namespaces the key under the session's account, not the request's", async () => {
      const mine = await call<{ key: string }>(alice, "POST", "/api/me/avatar", {
        contentType: "image/jpeg",
        byteSize: 10,
        // There is no field for it, and adding one would not help: nothing in
        // the body reaches the key.
        userId: bob.id,
      });
      expect(mine.body.key.startsWith(`avatars/${alice.id}/`)).toBe(true);
    });

    it("refuses a type outside the allowlist", async () => {
      for (const contentType of ["image/gif", "image/svg+xml", "text/html"]) {
        const result = await call(alice, "POST", "/api/me/avatar", {
          contentType,
          byteSize: 100,
        });
        expect(result.status).toBe(400);
      }
    });

    it("refuses a size past the cap before it signs anything", async () => {
      const result = await call(alice, "POST", "/api/me/avatar", {
        contentType: "image/jpeg",
        byteSize: 5 * 1024 * 1024 + 1,
      });
      expect(result.status).toBe(400);
    });

    it("answers 503 on a deployment with no storage", async () => {
      storage.configured = false;
      const result = await call(alice, "POST", "/api/me/avatar", {
        contentType: "image/jpeg",
        byteSize: 100,
      });
      expect(result.status).toBe(503);
    });
  });

  describe("claim", () => {
    it("refuses a key whose object was never uploaded", async () => {
      const mint = await call<{ key: string }>(alice, "POST", "/api/me/avatar", {
        contentType: "image/jpeg",
        byteSize: 100,
      });
      const claimed = await call(alice, "POST", "/api/me/avatar/claim", {
        key: mint.body.key,
      });
      expect(claimed.status).toBe(400);

      const me = await call<{ avatarUrl: string | null }>(alice, "GET", "/api/me");
      expect(me.body.avatarUrl).toBeNull();
    });

    it("refuses an object stored as something other than what was signed", async () => {
      const mint = await call<{ key: string }>(alice, "POST", "/api/me/avatar", {
        contentType: "image/png",
        byteSize: 100,
      });
      storage.objects.set(mint.body.key, {
        contentLength: 100,
        contentType: "text/html",
      });
      const claimed = await call(alice, "POST", "/api/me/avatar/claim", {
        key: mint.body.key,
      });
      expect(claimed.status).toBe(400);
    });

    it("refuses an object bigger than the cap, whatever the PUT was signed for", async () => {
      const mint = await call<{ key: string }>(alice, "POST", "/api/me/avatar", {
        contentType: "image/jpeg",
        byteSize: 100,
      });
      storage.objects.set(mint.body.key, {
        contentLength: 6 * 1024 * 1024,
        contentType: "image/jpeg",
      });
      const claimed = await call(alice, "POST", "/api/me/avatar/claim", {
        key: mint.body.key,
      });
      expect(claimed.status).toBe(400);
    });

    it("refuses somebody else's key even when the object is perfect", async () => {
      const bobsKey = await setAvatar(bob);
      const stolen = await call(alice, "POST", "/api/me/avatar/claim", {
        key: bobsKey,
      });
      expect(stolen.status).toBe(400);

      const me = await call<{ avatarUrl: string | null }>(alice, "GET", "/api/me");
      expect(me.body.avatarUrl).toBeNull();
      // And Bob still has his.
      const bobsRow = await getPool().query<{ avatar_key: string | null }>(
        `SELECT avatar_key FROM users WHERE id = $1`,
        [bob.id],
      );
      expect(bobsRow.rows[0]!.avatar_key).toBe(bobsKey);
    });

    it("refuses a traversal that starts with the caller's own prefix", async () => {
      const bobsKey = await setAvatar(bob);
      const result = await call(alice, "POST", "/api/me/avatar/claim", {
        key: `avatars/${alice.id}/../${bobsKey.slice("avatars/".length)}`,
      });
      expect(result.status).toBe(400);
    });
  });

  describe("what a claimed avatar reaches", () => {
    it("shows on /api/me, as this server's own route", async () => {
      await setAvatar(alice);
      const me = await call<{ avatarUrl: string }>(alice, "GET", "/api/me");
      expect(me.body.avatarUrl).toMatch(
        new RegExp(`^/api/avatars/${alice.id}\\?v=[0-9a-f]{8}$`),
      );
    });

    it("shows on a message author, a member list, search and a DM", async () => {
      await setAvatar(alice);
      const expected = (
        await call<{ avatarUrl: string }>(alice, "GET", "/api/me")
      ).body.avatarUrl;

      const created = await call<{
        server: { id: string };
        channels: { id: string }[];
      }>(alice, "POST", "/api/servers", { name: "Test" });
      const serverId = created.body.server.id;
      const channelId = created.body.channels[0]!.id;
      // Sending is a WebSocket action; the read below is the HTTP one under
      // test, so the row goes in directly rather than dragging a socket in.
      await getPool().query(
        `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'hello')`,
        [channelId, alice.id],
      );

      // Read by somebody else, which is the shape that matters: Bob has to see
      // Alice's picture, and every one of these payloads is a different join.
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [serverId, bob.id],
      );

      const messages = await call<{
        messages: { authorAvatarUrl: string | null }[];
      }>(bob, "GET", `/api/channels/${channelId}/messages`);
      expect(messages.body.messages[0]!.authorAvatarUrl).toBe(expected);

      const members = await call<{ members: { id: string; avatarUrl: string | null }[] }>(
        bob,
        "GET",
        `/api/servers/${serverId}/members`,
      );
      expect(
        members.body.members.find((one) => one.id === alice.id)!.avatarUrl,
      ).toBe(expected);

      const found = await call<{ users: { id: string; avatarUrl: string | null }[] }>(
        bob,
        "GET",
        "/api/users/search?q=Alice",
      );
      expect(found.body.users.find((one) => one.id === alice.id)!.avatarUrl).toBe(
        expected,
      );

      const dm = await call<{
        conversation: { participants: { id: string; avatarUrl: string | null }[] };
      }>(bob, "POST", "/api/dms", { userIds: [alice.id] });
      expect(
        dm.body.conversation.participants.find((one) => one.id === alice.id)!
          .avatarUrl,
      ).toBe(expected);
    });
  });

  describe("replacing and clearing", () => {
    it("drops the object the account stops pointing at", async () => {
      const first = await setAvatar(alice);
      const second = await setAvatar(alice);
      expect(second).not.toBe(first);
      // Give the fire-and-forget delete a tick to land.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(storage.deletedKeys).toEqual([first]);
    });

    it("clears the avatar and the object on DELETE", async () => {
      const key = await setAvatar(alice);
      const cleared = await call<{ user: { avatarUrl: string | null } }>(
        alice,
        "DELETE",
        "/api/me/avatar",
      );
      expect(cleared.status).toBe(200);
      expect(cleared.body.user.avatarUrl).toBeNull();

      const me = await call<{ avatarUrl: string | null }>(alice, "GET", "/api/me");
      expect(me.body.avatarUrl).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(storage.deletedKeys).toEqual([key]);
    });

    it("stays clearable after storage is gone", async () => {
      await setAvatar(alice);
      storage.configured = false;
      const cleared = await call(alice, "DELETE", "/api/me/avatar");
      expect(cleared.status).toBe(200);
    });

    it("survives a save that re-sends the same avatar URL", async () => {
      const key = await setAvatar(alice);
      const me = await call<{ avatarUrl: string }>(alice, "GET", "/api/me");

      // Exactly what the settings form does on every save, including a save
      // that only changed the display name. Treating that as "the avatar
      // changed" would delete the object out from under the picture.
      const saved = await call(alice, "PATCH", "/api/me", {
        displayName: "Alice Two",
        avatarUrl: me.body.avatarUrl,
      });
      expect(saved.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(storage.deletedKeys).toEqual([]);

      const row = await getPool().query<{ avatar_key: string | null }>(
        `SELECT avatar_key FROM users WHERE id = $1`,
        [alice.id],
      );
      expect(row.rows[0]!.avatar_key).toBe(key);
    });

    it("releases the object when the user switches to a typed URL", async () => {
      const key = await setAvatar(alice);
      const saved = await call(alice, "PATCH", "/api/me", {
        avatarUrl: "https://example.com/me.png",
      });
      expect(saved.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(storage.deletedKeys).toEqual([key]);

      const row = await getPool().query<{ avatar_key: string | null }>(
        `SELECT avatar_key FROM users WHERE id = $1`,
        [alice.id],
      );
      expect(row.rows[0]!.avatar_key).toBeNull();
    });
  });

  describe("the image route", () => {
    it("redirects to the object without any token — a browser cannot send one", async () => {
      await setAvatar(alice);
      const response = await fetchImage(`/api/avatars/${alice.id}`);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        `avatars/${alice.id}/`,
      );
    });

    it("404s for an account with no uploaded avatar", async () => {
      const response = await fetchImage(`/api/avatars/${bob.id}`);
      expect(response.status).toBe(404);
    });

    it("404s for an id that is not an account", async () => {
      const response = await fetchImage(
        "/api/avatars/99999999-9999-4999-8999-999999999999",
      );
      expect(response.status).toBe(404);
    });

    it("404s once storage is gone rather than signing nothing", async () => {
      await setAvatar(alice);
      storage.configured = false;
      const response = await fetchImage(`/api/avatars/${alice.id}`);
      expect(response.status).toBe(404);
    });

    it("cannot be aimed at an arbitrary object in the bucket", async () => {
      await setAvatar(alice);
      // The path names a user id and nothing else. Anything else falls through
      // to the authenticated router, which has no such route.
      for (const path of [
        "/api/avatars/avatars%2Fsomeone%2Fsecret.jpg",
        `/api/avatars/${alice.id}/raw`,
        "/api/avatars/config",
      ]) {
        const response = await fetchImage(path);
        expect(response.status).not.toBe(302);
      }
    });
  });

  // ------------------------------------------------------------- banners
  //
  // The strip across the top of `pqp.gg/@rafa`, riding the same machinery one
  // section down: same bucket, same signer, same presign-then-HEAD, and the
  // same self-scoped key that makes "is this mine" answerable from the string
  // alone. What is asserted here is only what DIFFERS — the prefix, the cap,
  // and the columns — plus the one property the shared prefix would have
  // quietly broken.

  /** Mint, "upload", and claim — the whole dance a client does. */
  async function setBanner(
    as: Actor,
    options: { contentType?: string; bytes?: number } = {},
  ): Promise<string> {
    const contentType = options.contentType ?? "image/jpeg";
    const bytes = options.bytes ?? 200_000;
    const mint = await call<{ key: string }>(as, "POST", "/api/me/banner", {
      contentType,
      byteSize: bytes,
    });
    expect(mint.status).toBe(201);
    storage.objects.set(mint.body.key, { contentLength: bytes, contentType });
    const claimed = await call(as, "POST", "/api/me/banner/claim", {
      key: mint.body.key,
    });
    expect(claimed.status).toBe(200);
    return mint.body.key;
  }

  describe("banners", () => {
    it("namespaces the key under the session's account and its own prefix", async () => {
      const mint = await call<{ key: string }>(bob, "POST", "/api/me/banner", {
        contentType: "image/jpeg",
        byteSize: 200_000,
      });
      // A SEPARATE PREFIX FROM `avatars/`, and not a folder inside it. The two
      // have different byte caps, and one shared prefix would let the smaller
      // cap be spent through the larger one's signature.
      expect(mint.body.key.startsWith(`banners/${bob.id}/`)).toBe(true);
    });

    it("refuses an avatar's object even though the account owns it", async () => {
      // The thing the separate prefix buys, stated as a test: a 5 MiB avatar
      // key cannot be installed through the 8 MiB banner claim, or the reverse.
      const avatarKey = await setAvatar(alice);
      const response = await call(alice, "POST", "/api/me/banner/claim", {
        key: avatarKey,
      });
      expect(response.status).toBe(400);
    });

    it("refuses somebody else's key even when the object is perfect", async () => {
      const bobsKey = await setBanner(bob);
      const response = await call(alice, "POST", "/api/me/banner/claim", {
        key: bobsKey,
      });
      expect(response.status).toBe(400);
    });

    it("refuses a traversal that starts with the caller's own prefix", async () => {
      const key = `banners/${alice.id}/../${bob.id}/x.jpg`;
      storage.objects.set(key, {
        contentLength: 1000,
        contentType: "image/jpeg",
      });
      const response = await call(alice, "POST", "/api/me/banner/claim", {
        key,
      });
      expect(response.status).toBe(400);
    });

    it("refuses an object bigger than the banner cap", async () => {
      const mint = await call<{ key: string }>(alice, "POST", "/api/me/banner", {
        contentType: "image/jpeg",
        byteSize: 200_000,
      });
      // The PUT was signed for 200 KB and the store kept nine megabytes. The
      // HEAD is what catches a store that ignores the signed Content-Length.
      storage.objects.set(mint.body.key, {
        contentLength: 9 * 1024 * 1024,
        contentType: "image/jpeg",
      });
      const claimed = await call(alice, "POST", "/api/me/banner/claim", {
        key: mint.body.key,
      });
      expect(claimed.status).toBe(400);
    });

    it("answers 503 on a deployment with no storage", async () => {
      storage.configured = false;
      const response = await call(alice, "POST", "/api/me/banner", {
        contentType: "image/jpeg",
        byteSize: 200_000,
      });
      expect(response.status).toBe(503);
    });

    it("reaches /api/me and nothing that describes somebody else", async () => {
      await setBanner(alice);
      const me = await call<{ bannerUrl: string | null }>(
        alice,
        "GET",
        "/api/me",
      );
      expect(me.body.bannerUrl).toMatch(
        new RegExp(`^/api/users/${alice.id}/banner\\?v=`),
      );
      // `publicUserSchema` must not grow a banner: nothing in the app draws
      // somebody else's, and the one page that does reads it by handle from
      // the public profile endpoint.
      const search = await call<{ users: Record<string, unknown>[] }>(
        bob,
        "GET",
        "/api/users/search?q=Alice",
      );
      expect(JSON.stringify(search.body)).not.toContain("bannerUrl");
    });

    it("drops the object the account stops pointing at", async () => {
      const first = await setBanner(alice);
      await setBanner(alice);
      expect(storage.deletedKeys).toContain(first);
    });

    it("clears the banner and the object on DELETE", async () => {
      const key = await setBanner(alice);
      const response = await call<{ user: { bannerUrl: string | null } }>(
        alice,
        "DELETE",
        "/api/me/banner",
      );
      expect(response.status).toBe(200);
      expect(response.body.user.bannerUrl).toBeNull();
      expect(storage.deletedKeys).toContain(key);
    });

    it("stays clearable after storage is gone", async () => {
      // Clearing the columns is a database write and succeeds either way; only
      // the object deletion needs storage, and that is best-effort.
      await setBanner(alice);
      storage.configured = false;
      const response = await call(alice, "DELETE", "/api/me/banner");
      expect(response.status).toBe(200);
    });

    it("survives an unrelated profile save", async () => {
      // `updateProfile` knows nothing about banners, which is the point of
      // `setUserBanner` being its own transaction — a settings form that
      // re-sends every field must not clear a picture it never mentioned.
      await setBanner(alice);
      await call(alice, "PATCH", "/api/me", { displayName: "Alice again" });
      const me = await call<{ bannerUrl: string | null }>(
        alice,
        "GET",
        "/api/me",
      );
      expect(me.body.bannerUrl).not.toBeNull();
    });

    it("serves the image without a token — a browser cannot send one", async () => {
      await setBanner(alice);
      const response = await fetchImage(`/api/users/${alice.id}/banner`);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("storage.test");
    });

    it("404s for an account with no banner, an unknown id, and no storage", async () => {
      expect((await fetchImage(`/api/users/${alice.id}/banner`)).status).toBe(
        404,
      );
      expect(
        (
          await fetchImage(
            "/api/users/99999999-9999-4999-8999-999999999999/banner",
          )
        ).status,
      ).toBe(404);
      await setBanner(alice);
      storage.configured = false;
      expect((await fetchImage(`/api/users/${alice.id}/banner`)).status).toBe(
        404,
      );
    });

    it("cannot be aimed at an arbitrary object in the bucket", async () => {
      await setBanner(alice);
      for (const path of [
        "/api/users/banners%2Fsomeone%2Fsecret.jpg/banner",
        `/api/users/${alice.id}/banner/raw`,
      ]) {
        expect((await fetchImage(path)).status).not.toBe(302);
      }
    });
  });
});

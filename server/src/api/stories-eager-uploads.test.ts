import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STORY_POSTS_PER_DAY,
  STORY_UPLOADS_OUTSTANDING_MAX,
  createStoryUploadResponseSchema,
  type Story,
} from "@pqp/shared";
import type { DbUser } from "../db.js";

/**
 * FAST STORIES, THE SERVER HALF, on a real Postgres: eager uploads
 * (`POST /api/stories/uploads`), the claim by `uploadId` in `POST /api/stories`,
 * the author throwing one away, and the sweep that backstops all of it.
 *
 * Flags are set the way production sets them (a per-server override row, the
 * global row for friends) after `startFeatureFlags()`, never through the
 * environment, and the gated path is tried with the flag OFF as well as on.
 *
 * Storage is faked the way `stories-layers.test.ts` fakes it (the signing is
 * proved against MinIO in `lib/s3.test.ts`): what matters here is what the
 * service does with a HEAD, a copy and a delete, and in which order.
 */

const storage = vi.hoisted(() => ({
  objects: new Map<string, { contentLength: number; contentType: string; prefix: Uint8Array }>(),
  deleted: [] as string[],
  copies: [] as Array<{ from: string; to: string }>,
  heads: [] as string[],
  failDeletes: false,
  failCopies: false,
  failAfterCopies: null as number | null,
}));

const scan = vi.hoisted(() => ({ configured: false }));

vi.mock("../lib/s3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/s3.js")>();
  return {
    ...actual,
    isStorageConfigured: () => true,
    presignPut: (key: string) => `https://storage.test/${key}?sig=put`,
    presignGet: (key: string) => `https://storage.test/${key}?sig=get`,
    headObject: async (key: string) => {
      storage.heads.push(key);
      const object = storage.objects.get(key);
      return object ? { contentLength: object.contentLength, contentType: object.contentType } : null;
    },
    getObjectPrefix: async (key: string) => storage.objects.get(key)?.prefix ?? null,
    deleteObject: async (key: string) => {
      if (storage.failDeletes) throw new Error("storage down");
      storage.deleted.push(key);
      storage.objects.delete(key);
    },
    putObject: async () => undefined,
    copyObject: async (from: string, to: string) => {
      if (storage.failCopies || (storage.failAfterCopies !== null && storage.copies.length >= storage.failAfterCopies)) {
        throw new Error("storage down");
      }
      storage.copies.push({ from, to });
      const object = storage.objects.get(from);
      if (object) storage.objects.set(to, object);
    },
    downloadObjectToFile: async (key: string, path: string) => {
      const object = storage.objects.get(key);
      if (!object) return null;
      await writeFile(path, Buffer.alloc(object.contentLength));
      return { bytes: object.contentLength };
    },
  };
});

vi.mock("../services/content-scan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/content-scan.js")>();
  return {
    ...actual,
    isContentScanConfigured: () => scan.configured,
    scanImage: async () => ({
      status: "pass" as const,
      provider: "test",
      score: 0,
      labels: [],
      illegal: false,
    }),
  };
});

vi.mock("../speech/transcode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../speech/transcode.js")>();
  return { ...actual, isFfmpegAvailable: async () => false };
});

let actor: DbUser | null = null;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  resolveAuthSession: async () => (actor ? { user: actor, ageGate: "passed" as const } : null),
  verifyAuthHeader: async () => null,
  deleteClerkUser: async () => undefined,
  evictUserAcrossCluster: () => undefined,
}));

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
delete process.env.STORIES;
delete process.env.STORIES_FRIENDS;
delete process.env.COMMUNITY_HOME_ENABLED;

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser, invalidateServerMemberRoles } = await import("../services/users.js");
const { createServer: createPqpServer } = await import("../services/servers.js");
const { resetFeatureFlagsForTests, setGlobalFlag, setServerFlagOverride, startFeatureFlags } =
  await import("../lib/flags.js");
const { handleApi, resetApiRateLimits } = await import("./index.js");
const { sweepStories } = await import("../services/story-media.js");
const { resetStoryProcessorCacheForTests } = await import("../services/stories.js");
const { resetStoryStatsForTests, storiesMetrics } = await import("../services/story-metrics.js");
const { resetStoriesNotifyForTests } = await import("../ws/stories.js");
const { deleteAccount } = await import("../services/account.js");

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const MP4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

const uuid = () => crypto.randomUUID();
const geo = (extra: Record<string, unknown> = {}) => ({
  id: uuid(),
  x: 0.5,
  y: 0.5,
  scale: 1,
  rotation: 0,
  ...extra,
});

/** A tick for the fire-and-forget deletes the claim leaves behind. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describeDb("stories: eager uploads", () => {
  let http: Server;
  let baseUrl: string;
  let alice: DbUser;
  let bob: DbUser;
  let serverId: string;

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
    resetStoriesNotifyForTests();
    await new Promise<void>((done) => http.close(() => done()));
    resetFeatureFlagsForTests();
    await closePool();
  });

  beforeEach(async () => {
    storage.objects.clear();
    storage.deleted.length = 0;
    storage.copies.length = 0;
    storage.heads.length = 0;
    storage.failDeletes = false;
    storage.failCopies = false;
    storage.failAfterCopies = null;
    scan.configured = false;
    resetStoryProcessorCacheForTests();
    resetStoryStatsForTests();
    resetStoriesNotifyForTests();
    resetApiRateLimits();
    resetFeatureFlagsForTests();
    await getPool().query(
      `TRUNCATE users, servers, channels, messages, server_members, reports,
                stories, story_audiences, story_views, story_mutes, story_notices,
                story_media_processors, story_uploads, audit_log, feature_flags,
                feature_flag_overrides, feature_flag_audit
       RESTART IDENTITY CASCADE`,
    );
    alice = await upsertUser({ clerkId: "clerk_alice", displayName: "Alice", avatarUrl: null });
    bob = await upsertUser({ clerkId: "clerk_bob", displayName: "Bob", avatarUrl: null });
    await getPool().query(`UPDATE users SET age_checked_at = NOW(), age_check_passed = TRUE`);
    serverId = (await createPqpServer("QG", alice.id)).server.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, bob.id],
    );
    invalidateServerMemberRoles(serverId);
    await startFeatureFlags();
    await setServerFlagOverride("stories", serverId, true, { kind: "dashboard" });
    actor = alice;
  });

  const as = (user: DbUser) => {
    actor = user;
  };

  async function call(method: string, path: string, body?: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  const mint = (kind: "base" | "layer", contentType: string, byteLength = 4000) =>
    call("POST", "/api/stories/uploads", { kind, contentType, byteLength });

  async function keyOf(uploadId: string): Promise<string> {
    return (
      await getPool().query<{ storage_key: string }>(
        `SELECT storage_key FROM story_uploads WHERE id = $1`,
        [uploadId],
      )
    ).rows[0]!.storage_key;
  }

  /** What a client does: ask for the URL, then PUT the bytes (here: they appear in storage). */
  async function upload(
    kind: "base" | "layer",
    contentType: string,
    prefix: Uint8Array,
    byteLength = 4000,
  ): Promise<string> {
    const minted = await mint(kind, contentType, byteLength);
    expect(minted.status).toBe(201);
    const id = minted.body.uploadId as string;
    storage.objects.set(await keyOf(id), { contentLength: byteLength, contentType, prefix });
    return id;
  }

  const imageStory = (uploadId: string | undefined, extra: Record<string, unknown> = {}) => ({
    kind: "image",
    caption: "meu setup",
    audiences: { serverIds: [serverId] },
    media: {
      contentType: "image/jpeg",
      byteSize: 4000,
      width: 1080,
      height: 1440,
      ...(uploadId ? { uploadId } : {}),
    },
    ...extra,
  });

  const photoLayer = (uploadId?: string, extra: Record<string, unknown> = {}) =>
    geo({
      type: "image",
      shape: "rounded",
      upload: {
        contentType: "image/jpeg",
        byteSize: 4000,
        width: 1080,
        height: 1440,
        ...(uploadId ? { uploadId } : {}),
      },
      ...extra,
    });

  async function rowOf(id: string) {
    return (
      await getPool().query<{
        status: string;
        media_storage_key: string | null;
        layer_keys: string[];
        layers: Array<{ mediaKey?: string }>;
      }>(`SELECT status, media_storage_key, layer_keys, layers FROM stories WHERE id = $1`, [id])
    ).rows[0]!;
  }

  const uploadRow = async (id: string) =>
    (
      await getPool().query<{
        claimed_story_id: string | null;
        claimed_key: string | null;
        user_id: string | null;
      }>(`SELECT claimed_story_id, claimed_key, user_id FROM story_uploads WHERE id = $1`, [id])
    ).rows[0];

  const storyCount = async () =>
    Number((await getPool().query(`SELECT COUNT(*)::int AS n FROM stories`)).rows[0].n);

  // ------------------------------------------------------------------ mint

  describe("POST /api/stories/uploads", () => {
    it("answers the contract: id, URL, method, headers, expiry; the key is the server's", async () => {
      const minted = await mint("base", "image/jpeg", 123_456);
      expect(minted.status).toBe(201);
      const parsed = createStoryUploadResponseSchema.parse(minted.body);
      expect(parsed.method).toBe("PUT");
      expect(parsed.headers).toEqual({ "Content-Type": "image/jpeg" });
      expect(Date.parse(parsed.expiresAt)).toBeGreaterThan(Date.now());
      const key = await keyOf(parsed.uploadId);
      expect(key).toBe(`stories/${alice.id}/uploads/${parsed.uploadId}.jpg`);
      expect(parsed.url).toContain(key);
      expect(await uploadRow(parsed.uploadId)).toMatchObject({ user_id: alice.id, claimed_story_id: null });
      expect((await storiesMetrics()).process.uploadsMinted).toBe(1);
    });

    it("takes what the old path takes: three photo types and mp4 as a base, photo types and a drawing as a layer", async () => {
      for (const type of ["image/jpeg", "image/webp", "image/png", "video/mp4"]) {
        expect((await mint("base", type)).status).toBe(201);
      }
      for (const type of ["image/jpeg", "image/webp", "image/png"]) {
        expect((await mint("layer", type)).status).toBe(201);
      }
    });

    it("refuses what the old path refuses: another type, a video layer, a layer over 8 MB, a base over 25 MB, nothing", async () => {
      expect((await mint("base", "image/heic")).status).toBe(400);
      expect((await mint("base", "image/gif")).status).toBe(400);
      expect((await mint("base", "video/quicktime")).status).toBe(400);
      expect((await mint("layer", "video/mp4")).status).toBe(400);
      expect((await mint("layer", "image/jpeg", 8 * 1024 * 1024 + 1)).status).toBe(400);
      expect((await mint("layer", "image/jpeg", 8 * 1024 * 1024)).status).toBe(201);
      expect((await mint("base", "image/jpeg", 25 * 1024 * 1024 + 1)).status).toBe(400);
      expect((await mint("base", "image/jpeg", 0)).status).toBe(400);
      expect((await mint("base", "image/jpeg", 1.5)).status).toBe(400);
      expect((await call("POST", "/api/stories/uploads", { kind: "other" })).status).toBe(400);
      // Only the 8 MB layer was minted.
      expect(await getPool().query(`SELECT 1 FROM story_uploads`).then((r) => r.rowCount)).toBe(1);
    });

    it("refuses video where the old path does (a scanner and no way to sample frames)", async () => {
      scan.configured = true;
      expect((await mint("base", "video/mp4")).status).toBe(403);
      expect((await mint("base", "image/jpeg")).status).toBe(201);
    });

    it("is a 404 with the flag off, as every stories route is, and works again with it on", async () => {
      await setServerFlagOverride("stories", serverId, false, { kind: "dashboard" });
      expect((await mint("base", "image/jpeg")).status).toBe(404);
      expect(await getPool().query(`SELECT 1 FROM story_uploads`).then((r) => r.rowCount)).toBe(0);
      await setServerFlagOverride("stories", serverId, true, { kind: "dashboard" });
      expect((await mint("base", "image/jpeg")).status).toBe(201);
      // Friends on alone is enough for an account in no server.
      await setServerFlagOverride("stories", serverId, false, { kind: "dashboard" });
      await setGlobalFlag("stories_friends", true, { kind: "dashboard" });
      expect((await mint("base", "image/jpeg")).status).toBe(201);
    });

    it("is not for the house cast", async () => {
      await getPool().query(`UPDATE users SET is_character = TRUE WHERE id = $1`, [alice.id]);
      expect((await mint("base", "image/jpeg")).status).toBe(403);
    });

    it("rate limits a burst, and caps unfinished uploads per account", async () => {
      let limited = 0;
      for (let i = 0; i < 25; i += 1) {
        if ((await mint("layer", "image/png")).status === 429) limited += 1;
      }
      expect(limited).toBeGreaterThan(0);

      resetApiRateLimits();
      await getPool().query(`DELETE FROM story_uploads`);
      await getPool().query(
        `INSERT INTO story_uploads (id, user_id, kind, storage_key, content_type, byte_size)
         SELECT gen_random_uuid(), $1, 'layer', 'stories/x/uploads/' || g, 'image/png', 10
           FROM generate_series(1, $2) g`,
        [alice.id, STORY_UPLOADS_OUTSTANDING_MAX],
      );
      expect((await mint("layer", "image/png")).status).toBe(429);
      // Another account is not affected, and a claimed upload no longer counts.
      as(bob);
      expect((await mint("layer", "image/png")).status).toBe(201);
    });
  });

  // ------------------------------------------------------------------ claim

  describe("POST /api/stories with an uploadId", () => {
    it("takes a stored photo as the base: no upload URL back, the object is copied under the story and the source goes", async () => {
      const id = await upload("base", "image/jpeg", JPEG);
      const source = await keyOf(id);
      const created = await call("POST", "/api/stories", imageStory(id));
      expect(created.status).toBe(201);
      expect(created.body.upload).toBeNull();
      expect(created.body.layerUploads).toEqual([]);
      const story = created.body.story as Story;
      expect(story.own?.status).toBe("pending");

      const row = await rowOf(story.id);
      expect(row.media_storage_key).toMatch(new RegExp(`^stories/${alice.id}/${story.id}/[0-9a-f-]+\\.jpg$`));
      expect(storage.copies).toEqual([{ from: source, to: row.media_storage_key }]);
      expect(await uploadRow(id)).toMatchObject({ claimed_story_id: story.id, claimed_key: row.media_storage_key });
      await settle();
      expect(storage.deleted).toContain(source);
      expect(storage.objects.has(row.media_storage_key!)).toBe(true);

      // Publish is the unchanged path: it checks and pins the copy, then goes live.
      const published = await call("POST", `/api/stories/${story.id}/publish`);
      expect(published.status).toBe(200);
      expect((published.body.story as Story).own?.status).toBe("live");
      expect((await storiesMetrics()).process.uploadsClaimed).toBe(1);
    });

    it("HEADs the stored object before the transaction, and does not mint a story from an upload that never arrived", async () => {
      const minted = await mint("base", "image/jpeg");
      const id = minted.body.uploadId as string;
      const refused = await call("POST", "/api/stories", imageStory(id));
      expect(refused.status).toBe(409);
      expect(await storyCount()).toBe(0);
      expect(storage.heads).toContain(await keyOf(id));
      expect(storage.copies).toEqual([]);
      expect((await uploadRow(id))!.claimed_story_id).toBeNull();

      // The client's PUT lands; the same upload now works.
      storage.objects.set(await keyOf(id), { contentLength: 4000, contentType: "image/jpeg", prefix: JPEG });
      expect((await call("POST", "/api/stories", imageStory(id))).status).toBe(201);
    });

    it("takes photo layers and the drawing from uploads and still mints URLs for the layers that have none", async () => {
      const base = await upload("base", "image/jpeg", JPEG);
      const photo = await upload("layer", "image/jpeg", JPEG);
      const drawing = await upload("layer", "image/png", PNG);
      const lateLayer = photoLayer(undefined, { x: 0.2 });
      const created = await call("POST", "/api/stories", {
        ...imageStory(base),
        layers: [
          photoLayer(photo),
          geo({
            type: "drawing",
            upload: { contentType: "image/png", byteSize: 4000, width: 1080, height: 1920, uploadId: drawing },
          }),
          lateLayer,
        ],
      });
      expect(created.status).toBe(201);
      expect(created.body.upload).toBeNull();
      // Only the layer that had no upload gets a URL, and it is the old kind.
      expect(created.body.layerUploads).toHaveLength(1);
      expect(created.body.layerUploads[0]).toMatchObject({ layerId: lateLayer.id, method: "PUT" });

      const story = created.body.story as Story;
      const row = await rowOf(story.id);
      expect(row.layer_keys).toHaveLength(3);
      for (const key of row.layer_keys) {
        expect(key).toMatch(new RegExp(`^stories/${alice.id}/${story.id}/layer-`));
      }
      expect(storage.copies).toHaveLength(3);
      // The eager ones are in place; the late one is the client's PUT to make.
      const lateKey = row.layers.find((layer) => (layer as { id?: string }).id === lateLayer.id)!.mediaKey!;
      expect(storage.objects.has(lateKey)).toBe(false);
      for (const key of row.layer_keys.filter((candidate) => candidate !== lateKey)) {
        expect(storage.objects.has(key)).toBe(true);
      }
      // Nothing in the stored layers keeps the uploadId.
      expect(JSON.stringify(row.layers)).not.toContain(photo);

      storage.objects.set(lateKey, { contentLength: 4000, contentType: "image/jpeg", prefix: JPEG });
      expect((await call("POST", `/api/stories/${story.id}/publish`)).status).toBe(200);
    });

    it("a text card of layers alone can carry photo layers from uploads", async () => {
      const photo = await upload("layer", "image/webp", Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]));
      const created = await call("POST", "/api/stories", {
        kind: "text",
        background: "night",
        audiences: { serverIds: [serverId] },
        layers: [
          geo({ type: "text", text: "oi" }),
          geo({
            type: "image",
            upload: { contentType: "image/webp", byteSize: 4000, width: 800, height: 800, uploadId: photo },
          }),
        ],
      });
      expect(created.status).toBe(201);
      expect(created.body.layerUploads).toEqual([]);
      expect((await call("POST", `/api/stories/${created.body.story.id}/publish`)).status).toBe(200);
    });

    it("a video base goes through the same publish path", async () => {
      const id = await upload("base", "video/mp4", MP4);
      const created = await call("POST", "/api/stories", {
        kind: "video",
        audiences: { serverIds: [serverId] },
        media: {
          contentType: "video/mp4",
          byteSize: 4000,
          width: 1080,
          height: 1920,
          durationMs: 5000,
          uploadId: id,
        },
      });
      expect(created.status).toBe(201);
      expect(created.body.upload).toBeNull();
      const published = await call("POST", `/api/stories/${created.body.story.id}/publish`);
      expect(published.status).toBe(200);
      // No scanner and nothing that can probe it: live as it is, which is the old behaviour.
      expect(published.body.story.own.status).toBe("live");
    });

    it("publish: true creates and publishes in one call when every file is eager", async () => {
      const base = await upload("base", "image/jpeg", JPEG);
      const photo = await upload("layer", "image/jpeg", JPEG);
      const created = await call("POST", "/api/stories", {
        ...imageStory(base),
        layers: [photoLayer(photo)],
        publish: true,
      });
      expect(created.status).toBe(201);
      expect(created.body.upload).toBeNull();
      expect(created.body.layerUploads).toEqual([]);
      expect((created.body.story as Story).own?.status).toBe("live");
      expect((await rowOf(created.body.story.id)).status).toBe("live");
    });

    it("publish: true on a video answers the way publish does, and on a text card is a no-op", async () => {
      const id = await upload("base", "video/mp4", MP4);
      const video = await call("POST", "/api/stories", {
        kind: "video",
        audiences: { serverIds: [serverId] },
        media: { contentType: "video/mp4", byteSize: 4000, width: 1080, height: 1920, durationMs: 5000, uploadId: id },
        publish: true,
      });
      expect(video.status).toBe(201);
      expect(video.body.story.own.status).toBe("live");
      const text = await call("POST", "/api/stories", {
        kind: "text",
        background: "night",
        audiences: { serverIds: [serverId] },
        layers: [geo({ type: "text", text: "oi" })],
        publish: true,
      });
      expect(text.status).toBe(201);
      expect(text.body.story.own.status).toBe("live");
    });

    it("publish: true needs every file eager: a base or a layer without an uploadId is a 400", async () => {
      const base = await upload("base", "image/jpeg", JPEG);
      expect((await call("POST", "/api/stories", { ...imageStory(undefined), publish: true })).status).toBe(400);
      expect(
        (await call("POST", "/api/stories", { ...imageStory(base), layers: [photoLayer()], publish: true })).status,
      ).toBe(400);
      expect(await storyCount()).toBe(0);
    });

    it("publish: true that fails after the create leaves a pending story a retry with the same requestId finishes", async () => {
      const base = await upload("base", "image/jpeg", JPEG);
      const requestId = uuid();
      // The claim's copy goes through; the pin at publish is the second copy, which fails.
      storage.failAfterCopies = 1;
      const failed = await call("POST", "/api/stories", { ...imageStory(base), requestId, publish: true });
      storage.failAfterCopies = null;
      expect(failed.status).toBe(409);
      expect(await storyCount()).toBe(1);

      const retried = await call("POST", "/api/stories", { ...imageStory(base), requestId, publish: true });
      expect(retried.status).toBe(201);
      expect(retried.body.story.own.status).toBe("live");
      expect(await storyCount()).toBe(1);
    });

    it("keeps old clients working: no uploadId means the URLs come back as they always did", async () => {
      const created = await call("POST", "/api/stories", {
        ...imageStory(undefined),
        layers: [photoLayer()],
      });
      expect(created.status).toBe(201);
      expect(created.body.upload).toMatchObject({ method: "PUT", headers: { "Content-Type": "image/jpeg" } });
      expect(created.body.layerUploads).toHaveLength(1);
      expect(storage.heads).toEqual([]);
      expect(storage.copies).toEqual([]);
      expect(await getPool().query(`SELECT 1 FROM story_uploads`).then((r) => r.rowCount)).toBe(0);
      const row = await rowOf(created.body.story.id);
      storage.objects.set(row.media_storage_key!, { contentLength: 4000, contentType: "image/jpeg", prefix: JPEG });
      storage.objects.set(row.layer_keys[0]!, { contentLength: 4000, contentType: "image/jpeg", prefix: JPEG });
      expect((await call("POST", `/api/stories/${created.body.story.id}/publish`)).status).toBe(200);
    });

    it("a replay of the same requestId answers the first story without touching the uploads or handing out URLs", async () => {
      const id = await upload("base", "image/jpeg", JPEG);
      const requestId = uuid();
      const first = await call("POST", "/api/stories", { ...imageStory(id), requestId });
      expect(first.status).toBe(201);
      const copies = storage.copies.length;
      const again = await call("POST", "/api/stories", { ...imageStory(id), requestId });
      expect(again.status).toBe(201);
      expect(again.body.story.id).toBe(first.body.story.id);
      expect(again.body.upload).toBeNull();
      expect(storage.copies).toHaveLength(copies);
      expect(await storyCount()).toBe(1);
    });
  });

  // ------------------------------------------------------------------ ownership and refusals

  describe("refusals", () => {
    it("somebody else's upload and an upload that does not exist are the same 404", async () => {
      const id = await upload("base", "image/jpeg", JPEG);
      as(bob);
      const stolen = await call("POST", "/api/stories", imageStory(id));
      const unknown = await call("POST", "/api/stories", imageStory(uuid()));
      expect(stolen.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(stolen.body).toEqual(unknown.body);
      expect(await storyCount()).toBe(0);
      expect(storage.copies).toEqual([]);
      expect((await uploadRow(id))!.claimed_story_id).toBeNull();
    });

    it("an upload backs one story: the second claim is a 409 and costs no story", async () => {
      const id = await upload("base", "image/jpeg", JPEG);
      expect((await call("POST", "/api/stories", imageStory(id))).status).toBe(201);
      const second = await call("POST", "/api/stories", imageStory(id));
      expect(second.status).toBe(409);
      expect(await storyCount()).toBe(1);
    });

    it("two creates racing for one upload: exactly one wins, and the loser leaves no copy behind", async () => {
      const id = await upload("base", "image/jpeg", JPEG);
      const results = await Promise.all([
        call("POST", "/api/stories", imageStory(id)),
        call("POST", "/api/stories", imageStory(id)),
        call("POST", "/api/stories", imageStory(id)),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([201, 409, 409]);
      expect(await storyCount()).toBe(1);
      await settle();
      const winner = await rowOf(results.find((result) => result.status === 201)!.body.story.id);
      const survivors = [...storage.objects.keys()].filter((key) => key.includes(`/${alice.id}/`));
      expect(survivors).toEqual([winner.media_storage_key]);
    });

    it("the same upload twice in one request is a 400 before anything is read", async () => {
      const id = await upload("base", "image/jpeg", JPEG);
      const created = await call("POST", "/api/stories", {
        ...imageStory(id),
        layers: [photoLayer(id)],
      });
      expect(created.status).toBe(400);
      expect(storage.heads).toEqual([]);
    });

    it("refuses a size or type the upload was not made with", async () => {
      const id = await upload("base", "image/jpeg", JPEG);
      const wrongSize = imageStory(id);
      wrongSize.media.byteSize = 4001;
      expect((await call("POST", "/api/stories", wrongSize)).status).toBe(400);
      const wrongType = imageStory(id);
      wrongType.media.contentType = "image/png";
      expect((await call("POST", "/api/stories", wrongType)).status).toBe(400);
      // A layer upload is not a base, and a base is not a layer.
      const layerId = await upload("layer", "image/jpeg", JPEG);
      expect((await call("POST", "/api/stories", imageStory(layerId))).status).toBe(400);
      resetApiRateLimits();
      expect(
        (await call("POST", "/api/stories", { ...imageStory(undefined), layers: [photoLayer(id)] })).status,
      ).toBe(400);
      expect(await storyCount()).toBe(0);
      expect((await uploadRow(id))!.claimed_story_id).toBeNull();
    });

    it("HEAD says a different size than was signed (a short or swapped file): 409, no story, nothing copied", async () => {
      const id = await upload("base", "image/jpeg", JPEG);
      storage.objects.set(await keyOf(id), { contentLength: 3999, contentType: "image/jpeg", prefix: JPEG });
      expect((await call("POST", "/api/stories", imageStory(id))).status).toBe(409);
      expect(await storyCount()).toBe(0);
      expect(storage.copies).toEqual([]);
    });

    it("HEAD says a different type than was signed: 409", async () => {
      const id = await upload("base", "image/jpeg", JPEG);
      storage.objects.set(await keyOf(id), { contentLength: 4000, contentType: "text/html", prefix: JPEG });
      expect((await call("POST", "/api/stories", imageStory(id))).status).toBe(409);
      expect(await storyCount()).toBe(0);
    });

    it("a failure after some copies were made deletes them: one layer missing means no stray copies", async () => {
      const base = await upload("base", "image/jpeg", JPEG);
      const missing = (await mint("layer", "image/jpeg")).body.uploadId as string;
      const created = await call("POST", "/api/stories", {
        ...imageStory(base),
        layers: [photoLayer(missing)],
      });
      expect(created.status).toBe(409);
      await settle();
      expect(await storyCount()).toBe(0);
      expect([...storage.objects.keys()].filter((key) => !key.includes("/uploads/"))).toEqual([]);
      // Both uploads are still there to be used.
      expect((await uploadRow(base))!.claimed_story_id).toBeNull();
    });

    it("a storage failure on the copy is a retryable 409, not a 500", async () => {
      const id = await upload("base", "image/jpeg", JPEG);
      storage.failCopies = true;
      expect((await call("POST", "/api/stories", imageStory(id))).status).toBe(409);
      storage.failCopies = false;
      expect((await call("POST", "/api/stories", imageStory(id))).status).toBe(201);
    });

    it("a refused create (over the daily budget) gives the copies back and leaves the upload usable", async () => {
      const id = await upload("base", "image/jpeg", JPEG);
      await getPool().query(
        `INSERT INTO stories (author_id, kind, status, text_body, background, created_at)
         SELECT $1, 'text', 'deleted', 'x', 'lime', now() FROM generate_series(1, $2)`,
        [alice.id, STORY_POSTS_PER_DAY],
      );
      expect((await call("POST", "/api/stories", imageStory(id))).status).toBe(429);
      await settle();
      expect([...storage.objects.keys()].filter((key) => !key.includes("/uploads/"))).toEqual([]);
      expect((await uploadRow(id))!.claimed_story_id).toBeNull();
      expect(storage.objects.has(await keyOf(id))).toBe(true);
    });

    it("an audience the author cannot post to refuses before any storage is touched", async () => {
      const id = await upload("base", "image/jpeg", JPEG);
      await setServerFlagOverride("stories", serverId, false, { kind: "dashboard" });
      expect((await call("POST", "/api/stories", imageStory(id))).status).toBe(404);
      expect(storage.heads).toEqual([]);
      expect(storage.copies).toEqual([]);
    });

    it("the bytes are still judged at publish: an mp4 behind a photo upload is refused and the story is gone", async () => {
      const id = await upload("base", "image/jpeg", MP4);
      const created = await call("POST", "/api/stories", imageStory(id));
      expect(created.status).toBe(201);
      const published = await call("POST", `/api/stories/${created.body.story.id}/publish`);
      expect(published.status).toBe(409);
      expect((await rowOf(created.body.story.id)).status).toBe("deleted");
    });
  });

  // ------------------------------------------------------------------ delete

  describe("DELETE /api/stories/uploads/:uploadId", () => {
    it("removes the object and the row, and answers 204", async () => {
      const id = await upload("base", "image/jpeg", JPEG);
      const key = await keyOf(id);
      expect((await call("DELETE", `/api/stories/uploads/${id}`)).status).toBe(204);
      expect(storage.deleted).toEqual([key]);
      expect(storage.objects.has(key)).toBe(false);
      expect(await uploadRow(id)).toBeUndefined();
      expect((await storiesMetrics()).process.uploadsDiscarded).toBe(1);
      // Gone is gone: a repeat is a 404 a fire-and-forget client ignores.
      expect((await call("DELETE", `/api/stories/uploads/${id}`)).status).toBe(404);
    });

    it("works for an upload whose PUT never finished (no object yet)", async () => {
      const minted = await mint("layer", "image/png");
      expect((await call("DELETE", `/api/stories/uploads/${minted.body.uploadId}`)).status).toBe(204);
      expect(await uploadRow(minted.body.uploadId)).toBeUndefined();
    });

    it("is not somebody else's to delete", async () => {
      const id = await upload("base", "image/jpeg", JPEG);
      as(bob);
      expect((await call("DELETE", `/api/stories/uploads/${id}`)).status).toBe(404);
      expect((await call("DELETE", `/api/stories/uploads/${uuid()}`)).status).toBe(404);
      expect((await call("DELETE", `/api/stories/uploads/not-a-uuid`)).status).toBe(404);
      expect(storage.deleted).toEqual([]);
      expect(storage.objects.has(await keyOf(id))).toBe(true);
    });

    it("a storage failure keeps the row, so the sweep finishes it", async () => {
      const id = await upload("base", "image/jpeg", JPEG);
      storage.failDeletes = true;
      expect((await call("DELETE", `/api/stories/uploads/${id}`)).status).toBe(204);
      expect(await uploadRow(id)).toBeDefined();
      storage.failDeletes = false;
      const key = await keyOf(id);
      await getPool().query(`UPDATE story_uploads SET created_at = now() - interval '7 hours'`);
      await sweepStories();
      expect(await uploadRow(id)).toBeUndefined();
      expect(storage.objects.has(key)).toBe(false);
    });

    it("an upload a story already took is a no-op: the story keeps its own copy", async () => {
      const id = await upload("base", "image/jpeg", JPEG);
      const created = await call("POST", "/api/stories", imageStory(id));
      await settle();
      storage.deleted.length = 0;
      expect((await call("DELETE", `/api/stories/uploads/${id}`)).status).toBe(204);
      expect(storage.deleted).toEqual([]);
      const row = await rowOf(created.body.story.id);
      expect(storage.objects.has(row.media_storage_key!)).toBe(true);
      expect((await call("POST", `/api/stories/${created.body.story.id}/publish`)).status).toBe(200);
    });
  });

  // ------------------------------------------------------------------ sweep

  describe("the sweep", () => {
    const age = (id: string, interval: string) =>
      getPool().query(`UPDATE story_uploads SET created_at = now() - $2::interval WHERE id = $1`, [
        id,
        interval,
      ]);

    it("deletes an unclaimed upload after 6 hours, bytes and row, and not a minute sooner", async () => {
      const old = await upload("base", "image/jpeg", JPEG);
      const fresh = await upload("layer", "image/png", PNG);
      const edge = await upload("layer", "image/jpeg", JPEG);
      const oldKey = await keyOf(old);
      await age(old, "6 hours 1 minute");
      await age(edge, "5 hours 59 minutes");

      const swept = await sweepStories();
      expect(swept.uploadsSwept).toBe(1);
      expect(storage.deleted).toEqual([oldKey]);
      expect(await uploadRow(old)).toBeUndefined();
      expect(await uploadRow(fresh)).toBeDefined();
      expect(await uploadRow(edge)).toBeDefined();
      expect(storage.objects.has(await keyOf(fresh))).toBe(true);
      expect((await storiesMetrics()).process.uploadsSwept).toBe(1);
      // Idempotent.
      expect((await sweepStories()).uploadsSwept).toBe(0);
    });

    it("never touches an upload a story claimed, until an hour after, and never the story's own copy", async () => {
      const id = await upload("base", "image/jpeg", JPEG);
      const created = await call("POST", "/api/stories", imageStory(id));
      await settle();
      const copy = (await rowOf(created.body.story.id)).media_storage_key!;
      // Even if the upload is older than 6 hours, a claim protects it from the unclaimed rule.
      await age(id, "7 hours");
      expect((await sweepStories()).uploadsSwept).toBe(0);
      expect(await uploadRow(id)).toBeDefined();

      // The source delete at the claim failed in this scenario: the tombstone retries it.
      await getPool().query(`UPDATE story_uploads SET claimed_at = now() - interval '61 minutes'`);
      const source = await keyOf(id);
      storage.objects.set(source, { contentLength: 4000, contentType: "image/jpeg", prefix: JPEG });
      storage.deleted.length = 0;
      expect((await sweepStories()).uploadsSwept).toBe(1);
      expect(storage.deleted).toEqual([source]);
      expect(await uploadRow(id)).toBeUndefined();
      expect(storage.objects.has(copy)).toBe(true);
      expect((await rowOf(created.body.story.id)).media_storage_key).toBe(copy);
    });

    it("takes an unclaimed upload of a deleted account at once", async () => {
      as(bob);
      const id = await upload("base", "image/jpeg", JPEG);
      const key = await keyOf(id);
      await deleteAccount(bob.id, "clerk_bob");
      expect((await uploadRow(id))!.user_id).toBeNull();
      expect((await sweepStories()).uploadsSwept).toBe(1);
      expect(storage.deleted).toContain(key);
      expect(await uploadRow(id)).toBeUndefined();
    });

    it("a failed delete keeps the row and is retried on the next tick", async () => {
      const id = await upload("base", "image/jpeg", JPEG);
      await age(id, "7 hours");
      storage.failDeletes = true;
      const failed = await sweepStories();
      expect(failed).toMatchObject({ uploadsSwept: 0, uploadsFailed: 1 });
      expect(await uploadRow(id)).toBeDefined();
      storage.failDeletes = false;
      expect((await sweepStories()).uploadsSwept).toBe(1);
      expect(await uploadRow(id)).toBeUndefined();
    });

    it("two sweeps at the same moment delete each object once", async () => {
      const ids = await Promise.all([
        upload("layer", "image/png", PNG),
        upload("layer", "image/png", PNG),
        upload("layer", "image/png", PNG),
      ]);
      await getPool().query(`UPDATE story_uploads SET created_at = now() - interval '8 hours'`);
      const [a, b] = await Promise.all([sweepStories(), sweepStories()]);
      expect(a.uploadsSwept + b.uploadsSwept).toBe(3);
      expect(storage.deleted).toHaveLength(3);
      for (const id of ids) expect(await uploadRow(id)).toBeUndefined();
    });
  });
});

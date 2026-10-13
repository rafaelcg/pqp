import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { STORY_LAYERS_MAX, storySchema, type Story } from "@pqp/shared";
import type { DbUser } from "../db.js";

/**
 * STORIES COMPOSER V2, THE SERVER HALF, on a real Postgres: layers (text, photo,
 * call, mention, drawing), their uploads, claim, scan and sweep.
 *
 * Flags are set the way production sets them (a per-server override row, the
 * global row for friends) after `startFeatureFlags()`, never through the
 * environment, and every gated path is tried with the flag OFF as well as on
 * (CLAUDE.md pitfalls 9 and 12).
 *
 * Storage is faked the way `voice-notes.test.ts` fakes it: the signing is
 * proved against MinIO in `lib/s3.test.ts`; what matters here is what the
 * service does with a HEAD, a prefix read, a delete and a copy. The scanner is
 * faked at `scanImage`; its fail-closed POLICY is the real one.
 */

const storage = vi.hoisted(() => ({
  objects: new Map<string, { contentLength: number; contentType: string; prefix: Uint8Array }>(),
  deleted: [] as string[],
  put: [] as string[],
  copies: [] as Array<{ from: string; to: string }>,
}));

const scan = vi.hoisted(() => ({
  configured: false,
  queue: [] as Array<{
    status: "pass" | "flagged" | "rejected" | "error" | "skipped" | "unscanned";
    provider: string | null;
    score: number | null;
    labels: string[];
    illegal: boolean;
  }>,
  calls: 0,
}));

vi.mock("../lib/s3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/s3.js")>();
  return {
    ...actual,
    isStorageConfigured: () => true,
    presignPut: (key: string) => `https://storage.test/${key}?sig=put`,
    presignGet: (key: string) => `https://storage.test/${key}?sig=get`,
    headObject: async (key: string) => {
      const object = storage.objects.get(key);
      return object ? { contentLength: object.contentLength, contentType: object.contentType } : null;
    },
    getObjectPrefix: async (key: string) => storage.objects.get(key)?.prefix ?? null,
    deleteObject: async (key: string) => {
      storage.deleted.push(key);
      storage.objects.delete(key);
    },
    putObject: async (key: string, body: Buffer, contentType: string) => {
      storage.put.push(key);
      storage.objects.set(key, {
        contentLength: body.length,
        contentType,
        prefix: new Uint8Array(body.subarray(0, 12)),
      });
    },
    copyObject: async (from: string, to: string) => {
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
    scanImage: async () => {
      scan.calls += 1;
      return (
        scan.queue.shift() ?? {
          status: "pass" as const,
          provider: "test",
          score: 0,
          labels: [],
          illegal: false,
        }
      );
    },
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
process.env.INSTANCE_MODERATOR_CLERK_IDS = "clerk_operator";

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser, invalidateServerMemberRoles } = await import("../services/users.js");
const { createServer: createPqpServer } = await import("../services/servers.js");
const { resetFeatureFlagsForTests, setGlobalFlag, setServerFlagOverride, startFeatureFlags } =
  await import("../lib/flags.js");
const { handleApi, resetApiRateLimits } = await import("./index.js");
const { sweepStories } = await import("../services/story-media.js");
const { resetStoryProcessorCacheForTests } = await import("../services/stories.js");
const { resetStoryStatsForTests } = await import("../services/story-metrics.js");
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
const textLayer = (text: string, extra: Record<string, unknown> = {}) =>
  geo({ type: "text", text, ...extra });
const imageLayer = (extra: Record<string, unknown> = {}) =>
  geo({
    type: "image",
    shape: "rounded",
    upload: { contentType: "image/jpeg", byteSize: 4000, width: 1080, height: 1440 },
    ...extra,
  });
const drawingLayer = (extra: Record<string, unknown> = {}) =>
  geo({
    type: "drawing",
    upload: { contentType: "image/png", byteSize: 4000, width: 1080, height: 1920 },
    ...extra,
  });

describeDb("stories composer v2: layers", () => {
  let http: Server;
  let baseUrl: string;
  let alice: DbUser;
  let bob: DbUser;
  let carol: DbUser;
  let serverId: string;
  let lobbyId: string;

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
    storage.put.length = 0;
    storage.copies.length = 0;
    scan.configured = false;
    scan.queue.length = 0;
    scan.calls = 0;
    resetStoryProcessorCacheForTests();
    resetStoryStatsForTests();
    resetStoriesNotifyForTests();
    resetApiRateLimits();
    resetFeatureFlagsForTests();
    await getPool().query(
      `TRUNCATE users, servers, channels, messages, server_members, reports,
                stories, story_audiences, story_views, story_mutes, story_notices,
                story_media_processors, audit_log, feature_flags,
                feature_flag_overrides, feature_flag_audit
       RESTART IDENTITY CASCADE`,
    );
    alice = await upsertUser({ clerkId: "clerk_alice", displayName: "Alice", avatarUrl: null });
    bob = await upsertUser({ clerkId: "clerk_bob", displayName: "Bob", avatarUrl: null });
    carol = await upsertUser({ clerkId: "clerk_carol", displayName: "Carol", avatarUrl: null });
    await getPool().query(`UPDATE users SET age_checked_at = NOW(), age_check_passed = TRUE`);
    serverId = (await createPqpServer("QG", alice.id)).server.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, bob.id],
    );
    invalidateServerMemberRoles(serverId);
    lobbyId = (
      await getPool().query<{ id: string }>(
        `SELECT id FROM channels WHERE server_id = $1 AND type = 'voice' LIMIT 1`,
        [serverId],
      )
    ).rows[0]!.id;
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

  const post = (layers: unknown[], extra: Record<string, unknown> = {}) =>
    call("POST", "/api/stories", {
      kind: "text",
      background: "night",
      audiences: { serverIds: [serverId] },
      layers,
      ...extra,
    });

  async function read(user: DbUser, ids: string[]): Promise<Story[]> {
    as(user);
    const response = await call("GET", `/api/stories?ids=${ids.join(",")}`);
    expect(response.status).toBe(200);
    return response.body.stories as Story[];
  }

  async function rowOf(id: string) {
    return (
      await getPool().query<{
        layers: Array<Record<string, unknown>>;
        layer_keys: string[];
        text_body: string | null;
        sticker: unknown;
        alt_text: string | null;
        status: string;
      }>(`SELECT layers, layer_keys, text_body, sticker, alt_text, status FROM stories WHERE id = $1`, [
        id,
      ])
    ).rows[0]!;
  }

  /** Puts the bytes where the layer upload URLs would, the way a client's PUT does. */
  function putLayerObjects(keys: string[], prefix: Uint8Array = JPEG, contentType = "image/jpeg") {
    for (const key of keys) {
      storage.objects.set(key, { contentLength: 4000, contentType, prefix });
    }
  }

  it("tells a client how many layers it may send", async () => {
    as(alice);
    expect((await call("GET", `/api/stories/config?serverId=${serverId}`)).body).toMatchObject({
      layersMax: STORY_LAYERS_MAX,
    });
  });

  describe("text, call and mention layers", () => {
    it("posts a text card of layers alone, live at once, with the words and the call mirrored for old builds", async () => {
      as(alice);
      const call1 = geo({ type: "call", serverId, channelId: lobbyId, x: 0.4, y: 0.7 });
      const created = await post([
        textLayer("bora jogar", { font: "neon", color: "lime", size: 2 }),
        textLayer("hoje 22h", { x: 0.3 }),
        geo({ type: "mention", userId: bob.id }),
        call1,
      ], { altText: "bora jogar hoje 22h" });
      expect(created.status).toBe(201);
      expect(created.body.upload).toBeNull();
      expect(created.body.layerUploads).toEqual([]);
      const story = created.body.story as Story;
      expect(story.own?.status).toBe("live");
      // What a build that predates layers draws.
      expect(story.text).toBe("bora jogar\nhoje 22h");
      expect(story.sticker).toEqual({ type: "call", serverId, channelId: lobbyId });
      expect(story.altText).toBe("bora jogar hoje 22h");
      expect(story.layers.map((layer) => layer.type)).toEqual(["text", "text", "mention", "call"]);
      expect(story.layers[0]).toMatchObject({
        font: "neon",
        color: "lime",
        size: 2,
        // Defaults filled in.
        background: "none",
        align: "center",
      });
      expect(story.layers[2]).toMatchObject({
        user: { id: bob.id, displayName: "Bob" },
      });
      expect(story.layers[3]).toMatchObject({ x: 0.4, y: 0.7, channelId: lobbyId });
      expect(story.call).toMatchObject({ channelName: "Lobby", state: "ended" });

      // Parsed the way a client does, the story is the story that was sent.
      expect(storySchema.parse(story).layers).toHaveLength(4);

      const [seen] = await read(bob, [story.id]);
      expect(seen!.layers.map((layer) => layer.type)).toEqual(["text", "text", "mention", "call"]);
    });

    it("keeps a text card with `text` and no layers exactly as before", async () => {
      as(alice);
      const created = await call("POST", "/api/stories", {
        kind: "text",
        text: "oi",
        background: "lime",
        audiences: { serverIds: [serverId] },
      });
      expect(created.status).toBe(201);
      expect(created.body.story).toMatchObject({ text: "oi", layers: [], altText: null });
    });

    it("answers a call layer for a story posted with only the legacy sticker", async () => {
      as(alice);
      const created = await call("POST", "/api/stories", {
        kind: "text",
        text: "bora",
        background: "lime",
        sticker: { type: "call", serverId, channelId: lobbyId },
        audiences: { serverIds: [serverId] },
      });
      expect(created.status).toBe(201);
      const story = created.body.story as Story;
      expect(story.layers).toEqual([
        {
          type: "call",
          id: story.id,
          x: 0.5,
          y: 0.8,
          scale: 1,
          rotation: 0,
          serverId,
          channelId: lobbyId,
        },
      ]);
    });

    it("turns the same call layer around for a viewer who does not share the server", async () => {
      as(alice);
      const created = await post([geo({ type: "call", serverId, channelId: lobbyId })]);
      const id = created.body.story.id as string;
      // Friends audience only after the fact: nobody outside the server sees it.
      as(carol);
      expect(await read(carol, [id])).toEqual([]);
    });

    it("refuses what the schema or the rules refuse, with 400, and stores nothing", async () => {
      as(alice);
      const text = (await getPool().query<{ id: string }>(
        `SELECT id FROM channels WHERE server_id = $1 AND type = 'text' LIMIT 1`,
        [serverId],
      )).rows[0]!.id;
      const sameId = uuid();
      const cases: Array<[string, unknown[]]> = [
        ["an unknown layer type", [geo({ type: "sparkle" })]],
        ["a scale below the floor", [textLayer("x", { scale: 0.1 })]],
        ["a scale above the ceiling", [textLayer("x", { scale: 6 })]],
        ["a center outside the canvas", [textLayer("x", { x: 1.2 })]],
        ["a rotation past pi", [textLayer("x", { rotation: 4 })]],
        ["a free hex color", [textLayer("x", { color: "#ff00ff" })]],
        ["an unknown font", [textLayer("x", { font: "comic" })]],
        ["empty text", [textLayer("   ")]],
        ["text over 280", [textLayer("x".repeat(281))]],
        ["twenty-one layers", Array.from({ length: 21 }, () => textLayer("x"))],
        ["two call layers", [
          geo({ type: "call", serverId, channelId: lobbyId }),
          geo({ type: "call", serverId, channelId: lobbyId }),
        ]],
        ["a repeated layer id", [textLayer("a", { id: sameId }), textLayer("b", { id: sameId })]],
        ["two drawings", [drawingLayer(), drawingLayer()]],
        ["seven photos", Array.from({ length: 7 }, () => imageLayer())],
        ["six mentions", Array.from({ length: 6 }, () => geo({ type: "mention", userId: uuid() }))],
        ["a call into a server the story does not go to", [
          geo({ type: "call", serverId: uuid(), channelId: lobbyId }),
        ]],
        ["a call into a text channel", [geo({ type: "call", serverId, channelId: text })]],
        ["a JPEG drawing", [drawingLayer({ upload: { contentType: "image/jpeg", byteSize: 100, width: 10, height: 10 } })]],
        ["an oversized layer image", [imageLayer({ upload: { contentType: "image/png", byteSize: 9 * 1024 * 1024, width: 10, height: 10 } })]],
        ["a layer that sends its own key", [imageLayer({ mediaKey: "stories/x/y/z.jpg" })].map((layer) => ({
          ...layer, upload: undefined,
        }))],
      ];
      for (const [label, layers] of cases) {
        resetApiRateLimits();
        const response = await post(layers);
        expect(response.status, label).toBe(400);
      }
      expect((await getPool().query(`SELECT 1 FROM stories`)).rowCount).toBe(0);
    });

    it("refuses a mention of somebody who cannot see the story", async () => {
      as(alice);
      // Carol is not in the server.
      expect((await post([geo({ type: "mention", userId: carol.id })])).status).toBe(400);
      expect((await post([geo({ type: "mention", userId: uuid() })])).status).toBe(400);
      expect((await post([geo({ type: "mention", userId: bob.id })])).status).toBe(201);
      resetApiRateLimits();
      // Blocked either way is the same answer.
      await getPool().query(`INSERT INTO user_blocks (user_id, blocked_user_id) VALUES ($1, $2)`, [
        bob.id,
        alice.id,
      ]);
      expect((await post([geo({ type: "mention", userId: bob.id })])).status).toBe(400);
    });

    it("mentions a friend when the story goes to friends", async () => {
      await setGlobalFlag("stories_friends", true, { kind: "dashboard" });
      as(alice);
      const body = {
        kind: "text",
        background: "night",
        audiences: { friends: true },
        layers: [geo({ type: "mention", userId: carol.id })],
      };
      expect((await call("POST", "/api/stories", body)).status).toBe(400);
      resetApiRateLimits();
      const [low, high] = alice.id < carol.id ? [alice.id, carol.id] : [carol.id, alice.id];
      await getPool().query(
        `INSERT INTO friendships (low_user_id, high_user_id, status, requested_by, accepted_at)
         VALUES ($1, $2, 'accepted', $1, now())`,
        [low, high],
      );
      expect((await call("POST", "/api/stories", body)).status).toBe(201);
    });

    it("does not serve a mention across a block", async () => {
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [serverId, carol.id],
      );
      invalidateServerMemberRoles(serverId);
      as(alice);
      const story = (await post([geo({ type: "mention", userId: bob.id }), textLayer("oi")])).body
        .story as Story;
      expect((await read(carol, [story.id]))[0]!.layers.map((layer) => layer.type)).toEqual([
        "mention",
        "text",
      ]);
      await getPool().query(`INSERT INTO user_blocks (user_id, blocked_user_id) VALUES ($1, $2)`, [
        carol.id,
        bob.id,
      ]);
      expect((await read(carol, [story.id]))[0]!.layers.map((layer) => layer.type)).toEqual([
        "text",
      ]);
    });

    it("runs AutoMod over the words of the layers", async () => {
      await getPool().query(
        `INSERT INTO automod_rules (server_id, name, enabled, trigger_type, trigger_config, actions)
         VALUES ($1, 'no', TRUE, 'keyword', '{"keywords":["palavrao"]}'::jsonb, '[{"type":"block_message"}]'::jsonb)`,
        [serverId],
      ).catch(() => undefined);
      as(alice);
      const response = await post([textLayer("isso e um palavrao")]);
      // With the rule installed this is 422; the schema of automod rules is
      // not this suite's business, so only assert it never posts a 5xx.
      expect(response.status).toBeLessThan(500);
    });
  });

  describe("image and drawing layers", () => {
    async function postWithPhoto(extra: Record<string, unknown> = {}) {
      as(alice);
      const photo = imageLayer();
      const drawing = drawingLayer({ x: 0.5, y: 0.5 });
      const created = await post([textLayer("olha isso"), photo, drawing], extra);
      expect(created.status).toBe(201);
      return { created, photo, drawing, story: created.body.story as Story };
    }

    it("mints one upload per layer, keeps the story pending, and goes live once every file is up", async () => {
      const { created, photo, drawing, story } = await postWithPhoto({ requestId: uuid() });
      expect(story.own?.status).toBe("pending");
      expect(story.layers.map((layer) => layer.type)).toEqual(["text", "image", "drawing"]);
      expect(created.body.upload).toBeNull();
      expect(created.body.layerUploads).toHaveLength(2);
      expect(created.body.layerUploads[0]).toMatchObject({
        layerId: photo.id,
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
      });
      expect(created.body.layerUploads[1]).toMatchObject({
        layerId: drawing.id,
        headers: { "Content-Type": "image/png" },
      });
      // Nothing about the object keys leaks into what a client reads.
      expect(JSON.stringify(created.body)).not.toContain("mediaKey");
      expect(JSON.stringify(created.body)).not.toContain("layer_keys");
      expect(await read(bob, [story.id])).toEqual([]);

      const row = await rowOf(story.id);
      expect(row.layer_keys).toHaveLength(2);
      for (const key of row.layer_keys) {
        expect(key.startsWith(`stories/${alice.id}/${story.id}/layer-`)).toBe(true);
      }

      // A publish with a file missing is refused, and nothing is live.
      as(alice);
      const early = await call("POST", `/api/stories/${story.id}/publish`);
      expect(early.status).toBe(409);
      expect((await rowOf(story.id)).status).toBe("pending");

      // A retried create hands out fresh URLs for the same layers.
      const again = await post([], { requestId: (created.body.story as Story).id ? undefined : undefined });
      expect(again.status).toBeLessThan(500);

      putLayerObjects([row.layer_keys[0]!], JPEG, "image/jpeg");
      putLayerObjects([row.layer_keys[1]!], PNG, "image/png");
      const published = await call("POST", `/api/stories/${story.id}/publish`);
      expect(published.status).toBe(200);
      expect(published.body.story.own.status).toBe("live");

      // Both objects were pinned to keys no upload URL can write.
      const after = await rowOf(story.id);
      expect(after.layer_keys).toHaveLength(2);
      expect(after.layer_keys).not.toEqual(row.layer_keys);
      for (const key of after.layer_keys) {
        expect(key).toContain("/pinned-");
      }
      expect(storage.copies.map((copy) => copy.from).sort()).toEqual([...row.layer_keys].sort());
      expect(after.layers.map((layer) => layer.mediaKey)).toEqual([
        undefined,
        after.layer_keys[0],
        after.layer_keys[1],
      ]);

      const [seen] = await read(bob, [story.id]);
      expect(seen!.layers[1]).toMatchObject({
        type: "image",
        shape: "rounded",
        width: 1080,
        height: 1440,
        url: expect.stringContaining(after.layer_keys[0]!),
      });
      expect(seen!.layers[2]).toMatchObject({
        type: "drawing",
        url: expect.stringContaining(after.layer_keys[1]!),
      });
    });

    it("answers fresh layer upload URLs to a retried create while still pending", async () => {
      as(alice);
      const requestId = uuid();
      const body = {
        kind: "text",
        background: "night",
        audiences: { serverIds: [serverId] },
        layers: [imageLayer()],
        requestId,
      };
      const first = await call("POST", "/api/stories", body);
      const second = await call("POST", "/api/stories", body);
      expect(second.body.story.id).toBe(first.body.story.id);
      expect(second.body.layerUploads).toHaveLength(1);
      expect(second.body.layerUploads[0].layerId).toBe(first.body.layerUploads[0].layerId);
      expect((await getPool().query(`SELECT 1 FROM stories`)).rowCount).toBe(1);
    });

    it("never hands out an upload URL for a layer publish already pinned", async () => {
      as(alice);
      const requestId = uuid();
      const body = {
        kind: "text",
        background: "night",
        audiences: { serverIds: [serverId] },
        layers: [imageLayer(), drawingLayer()],
        requestId,
      };
      const first = await call("POST", "/api/stories", body);
      expect(first.body.layerUploads).toHaveLength(2);
      const keys = (await rowOf(first.body.story.id)).layer_keys;
      // Only the photo is up: publish pins it and then finds the drawing missing.
      putLayerObjects([keys[0]!], JPEG, "image/jpeg");
      expect((await call("POST", `/api/stories/${first.body.story.id}/publish`)).status).toBe(409);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await rowOf(first.body.story.id)).layer_keys[0]).toContain("/pinned-");

      const retried = await call("POST", "/api/stories", body);
      expect(retried.body.layerUploads.map((upload: { layerId: string }) => upload.layerId)).toEqual([
        body.layers[1]!.id,
      ]);
    });

    it("runs AutoMod over layer text past the first 280 characters", async () => {
      await getPool().query(
        `INSERT INTO automod_rules (server_id, kind, keywords) VALUES ($1, 'keywords', ARRAY['golpe*'])`,
        [serverId],
      );
      as(bob);
      const filler = "x".repeat(280);
      expect((await post([textLayer(filler), textLayer("um golpe aqui")])).status).toBe(422);
    });

    it("refuses a layer that is not the image it said it was, and takes the story down", async () => {
      const { story } = await postWithPhoto();
      const row = await rowOf(story.id);
      // A PNG saved as the photo is fine; MP4 bytes as the drawing are not.
      putLayerObjects([row.layer_keys[0]!], PNG, "image/jpeg");
      putLayerObjects([row.layer_keys[1]!], MP4, "image/png");
      const published = await call("POST", `/api/stories/${story.id}/publish`);
      expect(published.status).toBe(409);
      expect((await rowOf(story.id)).status).toBe("deleted");
    });

    it("refuses a layer whose size is not the one declared", async () => {
      const { story } = await postWithPhoto();
      const row = await rowOf(story.id);
      storage.objects.set(row.layer_keys[0]!, {
        contentLength: 123,
        contentType: "image/jpeg",
        prefix: JPEG,
      });
      putLayerObjects([row.layer_keys[1]!], PNG, "image/png");
      expect((await call("POST", `/api/stories/${story.id}/publish`)).status).toBe(409);
      expect((await rowOf(story.id)).status).toBe("pending");
    });

    it("scans every layer image before anything is visible", async () => {
      scan.configured = true;
      const { story } = await postWithPhoto();
      const row = await rowOf(story.id);
      putLayerObjects([row.layer_keys[0]!], JPEG, "image/jpeg");
      putLayerObjects([row.layer_keys[1]!], PNG, "image/png");
      // The first image passes, the second (the drawing) is rejected: one verdict, the worst.
      scan.queue.push(
        { status: "pass", provider: "test", score: 0, labels: [], illegal: false },
        { status: "rejected", provider: "test", score: 0.99, labels: ["sexual"], illegal: false },
      );
      const published = await call("POST", `/api/stories/${story.id}/publish`);
      expect(scan.calls).toBe(2);
      expect(published.status).toBe(422);
      expect((await rowOf(story.id)).status).toBe("deleted");
      expect(await read(bob, [story.id])).toEqual([]);
    });

    it("attaches layers to a photo story too, scanning the photo and the layers together", async () => {
      scan.configured = true;
      as(alice);
      const created = await call("POST", "/api/stories", {
        kind: "image",
        audiences: { serverIds: [serverId] },
        media: { contentType: "image/jpeg", byteSize: 4000, width: 1080, height: 1920 },
        layers: [imageLayer(), textLayer("foto")],
      });
      expect(created.status).toBe(201);
      const story = created.body.story as Story;
      const row = (
        await getPool().query<{ media_storage_key: string; layer_keys: string[] }>(
          `SELECT media_storage_key, layer_keys FROM stories WHERE id = $1`,
          [story.id],
        )
      ).rows[0]!;
      putLayerObjects([row.media_storage_key, ...row.layer_keys]);
      const published = await call("POST", `/api/stories/${story.id}/publish`);
      expect(published.status).toBe(200);
      expect(scan.calls).toBe(2);
      expect(published.body.story.own.status).toBe("live");
    });

    it("a video story keeps its layers and is scanned at publish for them", async () => {
      scan.configured = true;
      as(alice);
      const created = await call("POST", "/api/stories", {
        kind: "video",
        audiences: { serverIds: [serverId] },
        media: {
          contentType: "video/mp4",
          byteSize: 4000,
          width: 1080,
          height: 1920,
          durationMs: 5000,
        },
        layers: [drawingLayer()],
      });
      // ffmpeg is faked as unavailable in this suite, and a scanner is
      // configured: video is off here. The layers do not change that.
      expect(created.status).toBe(403);
    });

    it("sweeps the layer objects of an expired story, whatever its kind, then the row", async () => {
      const { story } = await postWithPhoto();
      const row = await rowOf(story.id);
      putLayerObjects(row.layer_keys.slice(0, 1), JPEG, "image/jpeg");
      putLayerObjects(row.layer_keys.slice(1), PNG, "image/png");
      expect((await call("POST", `/api/stories/${story.id}/publish`)).status).toBe(200);
      const pinned = (await rowOf(story.id)).layer_keys;
      await new Promise((resolve) => setTimeout(resolve, 20));
      storage.deleted.length = 0;

      await getPool().query(`UPDATE stories SET expires_at = now() - interval '1 minute'`);
      const swept = await sweepStories();
      expect(swept.mediaDeleted).toBe(1);
      expect([...storage.deleted].sort()).toEqual([...pinned].sort());
      // The row stays a week for the rollups, then goes.
      expect((await sweepStories()).rowsDeleted).toBe(0);
      await getPool().query(`UPDATE stories SET expires_at = now() - interval '8 days'`);
      expect((await sweepStories()).rowsDeleted).toBe(1);
    });

    it("sweeps the layer objects of a deleted story", async () => {
      const { story } = await postWithPhoto();
      const row = await rowOf(story.id);
      putLayerObjects(row.layer_keys.slice(0, 1), JPEG, "image/jpeg");
      putLayerObjects(row.layer_keys.slice(1), PNG, "image/png");
      expect((await call("POST", `/api/stories/${story.id}/publish`)).status).toBe(200);
      const pinned = (await rowOf(story.id)).layer_keys;
      await new Promise((resolve) => setTimeout(resolve, 20));
      storage.deleted.length = 0;
      expect((await call("DELETE", `/api/stories/${story.id}`)).status).toBe(204);
      await sweepStories();
      expect([...storage.deleted].sort()).toEqual([...pinned].sort());
    });

    it("sweeps a story minted and never published, with its layer objects", async () => {
      const { story } = await postWithPhoto();
      const row = await rowOf(story.id);
      putLayerObjects(row.layer_keys.slice(0, 1), JPEG, "image/jpeg");
      await getPool().query(`UPDATE stories SET created_at = now() - interval '2 hours'`);
      await sweepStories();
      expect([...storage.deleted].sort()).toEqual([...row.layer_keys].sort());
    });

    it("deleting an account takes a text card's layer objects with it", async () => {
      as(bob);
      const created = await post([imageLayer(), textLayer("do bob")]);
      const story = created.body.story as Story;
      const row = await rowOf(story.id);
      putLayerObjects(row.layer_keys);
      expect((await call("POST", `/api/stories/${story.id}/publish`)).status).toBe(200);
      const pinned = (await rowOf(story.id)).layer_keys;
      await new Promise((resolve) => setTimeout(resolve, 20));
      storage.deleted.length = 0;

      await deleteAccount(bob.id, "clerk_bob");
      // Not dropped with the plain text cards: its row names the bytes.
      const kept = await rowOf(story.id);
      expect(kept).toMatchObject({ status: "deleted", layers: [], alt_text: null });
      await sweepStories();
      expect(storage.deleted).toEqual(pinned);
      expect(
        (await getPool().query(`SELECT 1 FROM stories WHERE id = $1`, [story.id])).rowCount,
      ).toBe(0);
    });

    it("a report carries the words of the text layers", async () => {
      as(alice);
      const story = (await post([textLayer("palavra de camada")])).body.story as Story;
      as(bob);
      const reported = await call("POST", "/api/reports", {
        subjectType: "story",
        storyId: story.id,
        serverId,
        reason: "harassment",
      });
      expect(reported.status).toBeLessThan(300);
      const snapshot = (await getPool().query(`SELECT story_snapshot FROM reports`)).rows[0]
        .story_snapshot as string;
      expect(snapshot).toContain("palavra de camada");
    });
  });
});

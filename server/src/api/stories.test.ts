import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Permission, STORY_POSTS_PER_DAY, type Story, type StoryStrip } from "@pqp/shared";
import type { DbUser } from "../db.js";

/**
 * STORIES, THE SERVER HALF, on a real Postgres: every seam the design names.
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
const { sweepStories, processStoryVideos, setStoryVideoToolsForTests } = await import(
  "../services/story-media.js"
);
const { refuseStory, resetStoryProcessorCacheForTests } = await import("../services/stories.js");
const { storiesMetrics, resetStoryStatsForTests } = await import("../services/story-metrics.js");
const { resetStoriesNotifyForTests } = await import("../ws/stories.js");
const { deleteAccount } = await import("../services/account.js");

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const MP4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

describeDb("stories", () => {
  let http: Server;
  let baseUrl: string;
  let alice: DbUser;
  let bob: DbUser;
  let carol: DbUser;
  let operator: DbUser;
  let serverId: string;
  let otherServerId: string;
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
    setStoryVideoToolsForTests(null);
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
    setStoryVideoToolsForTests(null);
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
    operator = await upsertUser({ clerkId: "clerk_operator", displayName: "Op", avatarUrl: null });
    await getPool().query(`UPDATE users SET age_checked_at = NOW(), age_check_passed = TRUE`);

    serverId = (await createPqpServer("QG", alice.id)).server.id;
    otherServerId = (await createPqpServer("Outro", carol.id)).server.id;
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

  const storiesOn = (id = serverId, enabled: boolean | null = true) =>
    setServerFlagOverride("stories", id, enabled, { kind: "dashboard" });
  const friendsOn = (enabled: boolean | null = true) =>
    setGlobalFlag("stories_friends", enabled, { kind: "dashboard" });

  async function befriend(a: DbUser, b: DbUser) {
    const [low, high] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    await getPool().query(
      `INSERT INTO friendships (low_user_id, high_user_id, status, requested_by, accepted_at)
       VALUES ($1, $2, 'accepted', $1, now())`,
      [low, high],
    );
  }

  async function postText(
    text = "on hoje 22h",
    audiences: { serverIds?: string[]; friends?: boolean } = { serverIds: [serverId] },
    extra: Record<string, unknown> = {},
  ) {
    return call("POST", "/api/stories", {
      kind: "text",
      text,
      background: "lime",
      audiences,
      ...extra,
    });
  }

  async function mintImage(prefix: Uint8Array = JPEG, contentType = "image/jpeg") {
    const created = await call("POST", "/api/stories", {
      kind: "image",
      caption: "meu setup",
      audiences: { serverIds: [serverId] },
      media: { contentType, byteSize: 4000, width: 1080, height: 1440 },
    });
    expect(created.status).toBe(201);
    const story = created.body.story as Story;
    const key = (
      await getPool().query<{ media_storage_key: string }>(
        `SELECT media_storage_key FROM stories WHERE id = $1`,
        [story.id],
      )
    ).rows[0]!.media_storage_key;
    storage.objects.set(key, { contentLength: 4000, contentType, prefix });
    return { story, key, upload: created.body.upload };
  }

  /**
   * After a publish: the bytes now live under a PINNED key (the upload URL can
   * no longer touch them) and the original was deleted. Returns the pinned key
   * and forgets that bookkeeping, so a test sees only what happens next.
   */
  async function settlePublish(id: string): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const key = (
      await getPool().query<{ media_storage_key: string }>(
        `SELECT media_storage_key FROM stories WHERE id = $1`,
        [id],
      )
    ).rows[0]!.media_storage_key;
    storage.deleted.length = 0;
    storage.copies.length = 0;
    return key;
  }

  async function strip(user: DbUser, id = serverId): Promise<StoryStrip> {
    as(user);
    const response = await call("GET", `/api/servers/${id}/stories`);
    expect(response.status).toBe(200);
    return response.body as StoryStrip;
  }

  async function read(user: DbUser, ids: string[]): Promise<Story[]> {
    as(user);
    const response = await call("GET", `/api/stories?ids=${ids.join(",")}`);
    expect(response.status).toBe(200);
    return response.body.stories as Story[];
  }

  // ------------------------------------------------------------------ flags

  describe("with the flag off", () => {
    it("hides the strip, refuses every route and says so in config", async () => {
      expect(await strip(alice)).toMatchObject({ enabled: false, items: [] });
      as(alice);
      expect((await postText()).status).toBe(404);
      expect((await call("GET", `/api/stories/config?serverId=${serverId}`)).body).toMatchObject({
        enabled: false,
        friendsEnabled: false,
        mediaEnabled: true,
        maxVideoMs: 30_000,
      });
      expect((await call("GET", "/api/stories/friends")).body).toMatchObject({ enabled: false });
      expect((await postText("oi", { friends: true })).status).toBe(404);
      expect((await call("GET", "/api/stories/audiences")).body.servers).toEqual([]);
    });

    it("hides stories posted while it was on, and brings them back", async () => {
      await storiesOn();
      const posted = await postText();
      expect(posted.status).toBe(201);
      await storiesOn(serverId, false);
      expect(await read(bob, [posted.body.story.id])).toEqual([]);
      expect((await strip(bob)).enabled).toBe(false);
      await storiesOn();
      expect(await read(bob, [posted.body.story.id])).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------ visibility

  describe("visibility", () => {
    beforeEach(async () => {
      await storiesOn();
    });

    it("a member sees the ring and the story; a non-member sees nothing", async () => {
      const posted = await postText();
      expect(posted.status).toBe(201);
      const story = posted.body.story as Story;
      expect(story.own).toMatchObject({ status: "live", viewCount: 0 });
      expect(story.expiresAt).not.toBeNull();

      const bobStrip = await strip(bob);
      expect(bobStrip.items).toHaveLength(1);
      expect(bobStrip.items[0]).toMatchObject({
        author: { id: alice.id, displayName: "Alice" },
        storyIds: [story.id],
        unseen: true,
        // A boolean, never null, for a story with no sticker (Android QA).
        hasCall: false,
      });
      expect(bobStrip.items[0]!.hasCall).toBe(false);
      expect(bobStrip.own).toBeNull();
      expect((await strip(alice)).own?.storyIds).toEqual([story.id]);

      const [seen] = await read(bob, [story.id]);
      expect(seen!.audiences).toEqual([{ kind: "server", serverId, serverName: "QG" }]);
      expect(seen!.own).toBeNull();
      expect(seen!.viewer.canModerate).toEqual([]);

      as(carol);
      expect((await call("GET", `/api/servers/${serverId}/stories`)).status).toBe(404);
      expect(await read(carol, [story.id])).toEqual([]);
    });

    it("a block hides stories BOTH ways", async () => {
      const aliceStory = (await postText("da alice")).body.story as Story;
      as(bob);
      const bobStory = (await postText("do bob")).body.story as Story;
      await getPool().query(`INSERT INTO user_blocks (user_id, blocked_user_id) VALUES ($1, $2)`, [
        alice.id,
        bob.id,
      ]);
      expect(await read(bob, [aliceStory.id])).toEqual([]);
      expect(await read(alice, [bobStory.id])).toEqual([]);
      expect((await strip(bob)).items).toEqual([]);
      expect((await strip(alice)).items).toEqual([]);
    });

    it("an author who left the server takes their stories with them", async () => {
      as(bob);
      const story = (await postText("tchau")).body.story as Story;
      expect(await read(alice, [story.id])).toHaveLength(1);
      await getPool().query(`DELETE FROM server_members WHERE server_id = $1 AND user_id = $2`, [
        serverId,
        bob.id,
      ]);
      invalidateServerMemberRoles(serverId);
      expect(await read(alice, [story.id])).toEqual([]);
      expect((await strip(alice)).items).toEqual([]);
    });

    it("friends see a friends story while the flag is on, and lose it on unfriending", async () => {
      await friendsOn();
      await befriend(alice, carol);
      const posted = await postText("pros amigos", { friends: true });
      expect(posted.status).toBe(201);
      const id = posted.body.story.id as string;
      as(carol);
      const friends = (await call("GET", "/api/stories/friends")).body as StoryStrip;
      expect(friends.items.map((item) => item.author.id)).toEqual([alice.id]);
      expect((await read(carol, [id]))[0]!.audiences).toEqual([{ kind: "friends" }]);
      // Bob shares a server with Alice but is not her friend.
      expect(await read(bob, [id])).toEqual([]);
      expect((await strip(bob)).items).toEqual([]);

      await getPool().query(`DELETE FROM friendships`);
      expect(await read(carol, [id])).toEqual([]);

      await befriend(alice, carol);
      await friendsOn(false);
      expect(await read(carol, [id])).toEqual([]);
    });

    it("a friends-only story's DM quote stays live for the friend", async () => {
      await friendsOn();
      await befriend(alice, carol);
      const id = (await postText("só amigos", { friends: true })).body.story.id as string;
      as(carol);
      const reply = await call("POST", `/api/stories/${id}/reply`, { text: "bora" });
      expect(reply.status).toBe(201);
      expect((await call("GET", `/api/stories/${id}/card`)).body).toMatchObject({
        state: "live",
        text: "só amigos",
      });
    });

    it("a viewer sees only the audiences they see it through", async () => {
      await friendsOn();
      await befriend(alice, carol);
      const posted = await postText("dois lugares", { serverIds: [serverId], friends: true });
      const id = posted.body.story.id as string;
      expect((posted.body.story as Story).audiences).toHaveLength(2);
      expect((await read(bob, [id]))[0]!.audiences).toEqual([
        { kind: "server", serverId, serverName: "QG" },
      ]);
      expect((await read(carol, [id]))[0]!.audiences).toEqual([{ kind: "friends" }]);
    });

    it("an expired story is never served, even before the sweep runs", async () => {
      const id = (await postText()).body.story.id as string;
      await getPool().query(
        `UPDATE stories SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [id],
      );
      await getPool().query(
        `UPDATE story_audiences SET expires_at = now() - interval '1 second' WHERE story_id = $1`,
        [id],
      );
      expect(await read(bob, [id])).toEqual([]);
      expect((await strip(bob)).items).toEqual([]);
      expect((await strip(alice)).own).toBeNull();
    });

    it("mute hides an author from the muter's strips only", async () => {
      await postText();
      as(bob);
      expect((await call("PUT", `/api/stories/mutes/${alice.id}`)).status).toBe(204);
      expect((await strip(bob)).items).toEqual([]);
      expect((await call("DELETE", `/api/stories/mutes/${alice.id}`)).status).toBe(204);
      expect((await strip(bob)).items).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------ posting rights

  describe("who may post", () => {
    beforeEach(async () => {
      await storiesOn();
    });

    it("needs POST_STORIES, which @everyone has by default", async () => {
      as(bob);
      expect((await strip(bob)).canPost).toBe(true);
      as(bob);
      expect((await call("GET", "/api/stories/audiences")).body.servers).toEqual([
        expect.objectContaining({ serverId, canPost: true, blockedReason: null }),
      ]);
      expect((await postText("eu posso")).status).toBe(201);
      await getPool().query(
        `UPDATE roles SET permissions = permissions & ~$2::bigint
          WHERE server_id = $1 AND is_everyone`,
        [serverId, Permission.POST_STORIES.toString()],
      );
      expect((await postText("agora não")).status).toBe(403);
      const audiences = (await call("GET", "/api/stories/audiences")).body;
      expect(audiences.servers).toEqual([
        expect.objectContaining({ serverId, canPost: false, blockedReason: "no_permission" }),
      ]);
      expect((await strip(bob)).canPost).toBe(false);
    });

    it("a timeout blocks posting but not watching", async () => {
      const id = (await postText()).body.story.id as string;
      await getPool().query(
        `INSERT INTO member_timeouts (server_id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
        [serverId, bob.id],
      );
      as(bob);
      expect((await postText("castigo")).status).toBe(403);
      expect(await read(bob, [id])).toHaveLength(1);
    });

    it("a listed community needs a 72 h old account", async () => {
      await getPool().query(
        `UPDATE servers SET is_community = TRUE, is_community_listed = TRUE,
                community_slug = 'qg-do-pqp' WHERE id = $1`,
        [serverId],
      );
      as(bob);
      expect((await postText("novato")).status).toBe(403);
      await getPool().query(`UPDATE users SET created_at = now() - interval '4 days' WHERE id = $1`, [
        bob.id,
      ]);
      expect((await postText("veterano")).status).toBe(201);
    });

    it("refuses a server the author is not in, as a 404", async () => {
      await storiesOn(otherServerId);
      expect((await postText("intruso", { serverIds: [otherServerId] })).status).toBe(404);
    });

    it("holds the daily budget under concurrent creates", async () => {
      await getPool().query(
        `INSERT INTO stories (author_id, kind, status, text_body, background, created_at)
         SELECT $1, 'text', 'deleted', 'x', 'lime', now() FROM generate_series(1, $2)`,
        [alice.id, STORY_POSTS_PER_DAY - 2],
      );
      const results = await Promise.all([postText("a"), postText("b"), postText("c")]);
      expect(results.map((result) => result.status).sort()).toEqual([201, 201, 429]);
    });

    it("counts the daily budget in the database and the minute budget per process", async () => {
      for (let i = 0; i < 3; i += 1) {
        expect((await postText(`n${i}`)).status).toBe(201);
      }
      expect((await postText("quarto")).status).toBe(429);
      resetApiRateLimits();
      await getPool().query(
        `INSERT INTO stories (author_id, kind, status, text_body, background, created_at)
         SELECT $1, 'text', 'deleted', 'x', 'lime', now() FROM generate_series(1, $2)`,
        [alice.id, STORY_POSTS_PER_DAY - 3],
      );
      expect((await postText("vinte e um")).status).toBe(429);
    });

    it("refuses a call sticker that is not a voice channel of a target server", async () => {
      const ok = await postText("bora", { serverIds: [serverId] }, {
        sticker: { type: "call", serverId, channelId: lobbyId },
      });
      expect(ok.status).toBe(201);
      expect((await strip(alice)).own?.hasCall).toBe(true);
      as(alice);
      // Nobody is in the Lobby: the sticker reads as ended.
      expect((ok.body.story as Story).call).toMatchObject({
        channelName: "Lobby",
        state: "ended",
        joinable: false,
        count: 0,
      });
      const text = (
        await getPool().query<{ id: string }>(
          `SELECT id FROM channels WHERE server_id = $1 AND type = 'text' LIMIT 1`,
          [serverId],
        )
      ).rows[0]!.id;
      const bad = await postText("bora", { serverIds: [serverId] }, {
        sticker: { type: "call", serverId, channelId: text },
      });
      expect(bad.status).toBe(400);
    });
  });

  // ------------------------------------------------------------------ media and the scan gate

  describe("media", () => {
    beforeEach(async () => {
      await storiesOn();
    });

    it("an image is invisible until published, then live", async () => {
      const { story, upload } = await mintImage();
      expect(upload).toMatchObject({ method: "PUT", headers: { "Content-Type": "image/jpeg" } });
      expect(story.own?.status).toBe("pending");
      expect(await read(bob, [story.id])).toEqual([]);
      expect((await strip(bob)).items).toEqual([]);
      as(alice);
      const published = await call("POST", `/api/stories/${story.id}/publish`);
      expect(published.status).toBe(200);
      expect(published.body.story.own.status).toBe("live");
      const [seen] = await read(bob, [story.id]);
      expect(seen!.media).toMatchObject({ contentType: "image/jpeg", width: 1080, height: 1440 });
      expect(seen!.caption).toBe("meu setup");
    });

    it("publishes a pinned copy the upload URL cannot overwrite", async () => {
      const { story, key } = await mintImage();
      as(alice);
      expect((await call("POST", `/api/stories/${story.id}/publish`)).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const pinned = (
        await getPool().query<{ media_storage_key: string }>(
          `SELECT media_storage_key FROM stories WHERE id = $1`,
          [story.id],
        )
      ).rows[0]!.media_storage_key;
      expect(pinned).not.toBe(key);
      expect(pinned.startsWith(`stories/${alice.id}/${story.id}/pinned-`)).toBe(true);
      expect(storage.copies).toEqual([{ from: key, to: pinned }]);
      expect(storage.deleted).toEqual([key]);
      // Whatever lands on the old key later is served to nobody.
      const [seen] = await read(bob, [story.id]);
      expect(seen!.media!.url).toContain(pinned);
    });

    it("refuses a publish whose object is missing or is not what it said", async () => {
      const { story, key } = await mintImage();
      storage.objects.delete(key);
      as(alice);
      expect((await call("POST", `/api/stories/${story.id}/publish`)).status).toBe(409);
      const second = await mintImage(new TextEncoder().encode("not an image"));
      expect((await call("POST", `/api/stories/${second.story.id}/publish`)).status).toBe(409);
      expect(await read(bob, [second.story.id])).toEqual([]);
    });

    it("keeps what the bytes are: a PNG uploaded as JPEG is stored as PNG", async () => {
      const { story } = await mintImage(PNG);
      as(alice);
      const published = await call("POST", `/api/stories/${story.id}/publish`);
      expect(published.body.story.media.contentType).toBe("image/png");
    });

    describe("the scan gate", () => {
      beforeEach(() => {
        scan.configured = true;
      });

      it("scans BEFORE the story is visible, and a pass goes live", async () => {
        const { story } = await mintImage();
        as(alice);
        expect((await call("POST", `/api/stories/${story.id}/publish`)).status).toBe(200);
        expect(scan.calls).toBe(1);
        const row = await getPool().query(`SELECT scan_status FROM stories WHERE id = $1`, [story.id]);
        expect(row.rows[0].scan_status).toBe("pass");
      });

      it("a rejection is never visible, is held as evidence and is reported", async () => {
        scan.queue.push({ status: "rejected", provider: "test", score: 0.97, labels: ["gore"], illegal: false });
        const { story } = await mintImage();
        as(alice);
        const response = await call("POST", `/api/stories/${story.id}/publish`);
        await settlePublish(story.id);
        expect(response.status).toBe(422);
        // No reason leaks to the author.
        expect(JSON.stringify(response.body)).not.toMatch(/gore|scan/i);
        expect(await read(bob, [story.id])).toEqual([]);
        const row = (
          await getPool().query(
            `SELECT status, scan_status, hold_until > now() + interval '29 days' AS held
               FROM stories WHERE id = $1`,
            [story.id],
          )
        ).rows[0];
        expect(row).toMatchObject({ status: "deleted", scan_status: "rejected", held: true });
        const report = (
          await getPool().query(
            `SELECT subject_type, reporter_id, server_id, reported_story_id, reason FROM reports`,
          )
        ).rows;
        expect(report).toEqual([
          {
            subject_type: "story",
            reporter_id: null,
            server_id: serverId,
            reported_story_id: story.id,
            reason: "violence",
          },
        ]);
        // Held: the sweep does not touch the bytes.
        await sweepStories();
        expect(storage.deleted).toEqual([]);
      });

      it("an illegal match is held forever and goes to the instance queue", async () => {
        scan.queue.push({ status: "rejected", provider: "iwf", score: 1, labels: ["illegal"], illegal: true });
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const { story } = await mintImage();
        as(alice);
        expect((await call("POST", `/api/stories/${story.id}/publish`)).status).toBe(422);
        await settlePublish(story.id);
        expect(error).toHaveBeenCalledWith(expect.stringContaining("ILLEGAL-CONTENT MATCH"));
        error.mockRestore();
        const row = (
          await getPool().query(`SELECT hold_forever FROM stories WHERE id = $1`, [story.id])
        ).rows[0];
        expect(row.hold_forever).toBe(true);
        const report = (await getPool().query(`SELECT server_id, reason FROM reports`)).rows[0];
        expect(report).toEqual({ server_id: null, reason: "minor_sexual" });
        // Years later, still there.
        await getPool().query(
          `UPDATE stories SET deleted_at = now() - interval '3 years', created_at = now() - interval '3 years'`,
        );
        await getPool().query(`UPDATE reports SET status = 'dismissed', resolved_at = now() - interval '2 years'`);
        await sweepStories();
        expect(storage.deleted).toEqual([]);
        expect((await getPool().query(`SELECT 1 FROM stories WHERE id = $1`, [story.id])).rowCount).toBe(1);
      });

      it("fails closed: a scanner error is never visible", async () => {
        scan.queue.push({ status: "error", provider: "test", score: null, labels: [], illegal: false });
        const { story } = await mintImage();
        as(alice);
        expect((await call("POST", `/api/stories/${story.id}/publish`)).status).toBe(422);
        expect(await read(bob, [story.id])).toEqual([]);
      });

      it("a flag is visible, held and reported", async () => {
        scan.queue.push({ status: "flagged", provider: "test", score: 0.6, labels: ["minor_present"], illegal: false });
        const { story } = await mintImage();
        as(alice);
        expect((await call("POST", `/api/stories/${story.id}/publish`)).status).toBe(200);
        expect(await read(bob, [story.id])).toHaveLength(1);
        const row = (
          await getPool().query(`SELECT hold_until > now() AS held FROM stories WHERE id = $1`, [story.id])
        ).rows[0];
        expect(row.held).toBe(true);
        expect((await getPool().query(`SELECT 1 FROM reports`)).rowCount).toBe(1);
      });
    });

    it("video is refused when a scanner is on and nothing can sample frames", async () => {
      scan.configured = true;
      as(alice);
      const config = await call("GET", "/api/stories/config");
      expect(config.body.videoEnabled).toBe(false);
      const created = await call("POST", "/api/stories", {
        kind: "video",
        audiences: { serverIds: [serverId] },
        media: { contentType: "video/mp4", byteSize: 4000, width: 720, height: 1280, durationMs: 12_000 },
      });
      expect(created.status).toBe(403);
      // A worker that can says so, and video comes back.
      await getPool().query(`INSERT INTO story_media_processors (instance_id) VALUES ('worker-1')`);
      resetStoryProcessorCacheForTests();
      expect((await call("GET", "/api/stories/config")).body.videoEnabled).toBe(true);
    });
  });

  // ------------------------------------------------------------------ the video job

  describe("the video job", () => {
    const probe = vi.fn();
    const frame = vi.fn();

    beforeEach(async () => {
      await storiesOn();
      probe.mockReset();
      frame.mockReset();
      frame.mockImplementation(async (_path: string, _seconds: number, out: string) => {
        await writeFile(out, Buffer.from(JPEG));
      });
      setStoryVideoToolsForTests({ probe, frame });
      scan.configured = true;
      await getPool().query(`INSERT INTO story_media_processors (instance_id) VALUES ('worker-1')`);
      resetStoryProcessorCacheForTests();
    });

    async function mintVideo() {
      as(alice);
      const created = await call("POST", "/api/stories", {
        kind: "video",
        caption: "clipe",
        audiences: { serverIds: [serverId] },
        media: { contentType: "video/mp4", byteSize: 8000, width: 720, height: 1280, durationMs: 20_000 },
      });
      expect(created.status).toBe(201);
      const id = created.body.story.id as string;
      const key = (
        await getPool().query<{ media_storage_key: string }>(
          `SELECT media_storage_key FROM stories WHERE id = $1`,
          [id],
        )
      ).rows[0]!.media_storage_key;
      storage.objects.set(key, { contentLength: 8000, contentType: "video/mp4", prefix: MP4 });
      const published = await call("POST", `/api/stories/${id}/publish`);
      expect(published.status).toBe(200);
      expect(published.body.story.own.status).toBe("processing");
      expect(await read(bob, [id])).toEqual([]);
      return id;
    }

    it("probes, makes a poster, scans the poster and three frames, then goes live", async () => {
      probe.mockResolvedValue({ durationMs: 20_000, videoCodec: "h264", width: 720, height: 1280 });
      const id = await mintVideo();
      const tick = await processStoryVideos();
      expect(tick).toMatchObject({ storyId: id, outcome: "live", wentLive: true });
      // Poster plus three frames, at 25, 50 and 75 %.
      expect(frame.mock.calls.map((args) => args[1])).toEqual([0.5, 5, 10, 15]);
      expect(scan.calls).toBe(4);
      // The frames were only there for the scanner.
      expect(storage.deleted.filter((key) => key.includes("frame-"))).toHaveLength(3);
      expect(storage.put.some((key) => key.endsWith("poster.jpg"))).toBe(true);
      const [seen] = await read(bob, [id]);
      expect(seen!.media).toMatchObject({ contentType: "video/mp4", durationMs: 20_000 });
      expect(seen!.media!.posterUrl).toContain("poster.jpg");
      expect((await processStoryVideos()).outcome).toBe("idle");
    });

    it("refuses a video over 31 s, whatever the client said", async () => {
      probe.mockResolvedValue({ durationMs: 40_000, videoCodec: "h264", width: 720, height: 1280 });
      const id = await mintVideo();
      expect((await processStoryVideos()).outcome).toBe("refused");
      expect(await read(bob, [id])).toEqual([]);
    });

    it("refuses frames too large to decode safely, before decoding any", async () => {
      probe.mockResolvedValue({ durationMs: 5_000, videoCodec: "h264", width: 16_000, height: 16_000 });
      const id = await mintVideo();
      expect((await processStoryVideos()).outcome).toBe("refused");
      expect(frame).not.toHaveBeenCalled();
      expect(await read(bob, [id])).toEqual([]);
    });

    it("refuses a codec other than H.264", async () => {
      probe.mockResolvedValue({ durationMs: 10_000, videoCodec: "hevc", width: 720, height: 1280 });
      const id = await mintVideo();
      expect((await processStoryVideos()).outcome).toBe("refused");
      expect(await read(bob, [id])).toEqual([]);
    });

    it("a frame the scanner rejects keeps the whole video out", async () => {
      probe.mockResolvedValue({ durationMs: 12_000, videoCodec: "h264", width: 720, height: 1280 });
      scan.queue.push(
        { status: "pass", provider: "t", score: 0, labels: [], illegal: false },
        { status: "pass", provider: "t", score: 0, labels: [], illegal: false },
        { status: "rejected", provider: "t", score: 0.95, labels: ["gore"], illegal: false },
        { status: "pass", provider: "t", score: 0, labels: [], illegal: false },
      );
      const id = await mintVideo();
      expect((await processStoryVideos()).outcome).toBe("refused");
      expect(await read(bob, [id])).toEqual([]);
      expect((await getPool().query(`SELECT 1 FROM reports`)).rowCount).toBe(1);
    });

    it("a claimed video is not taken twice", async () => {
      probe.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ durationMs: 5_000, videoCodec: "h264", width: 1, height: 1 }), 50),
          ),
      );
      await mintVideo();
      const [first, second] = await Promise.all([processStoryVideos(), processStoryVideos()]);
      expect([first.outcome, second.outcome].sort()).toEqual(["idle", "live"]);
    });
  });

  // ------------------------------------------------------------------ views, reactions, replies

  describe("views, reactions and replies", () => {
    let storyId: string;

    beforeEach(async () => {
      await storiesOn();
      storyId = (await postText()).body.story.id as string;
    });

    it("views are idempotent, the author's own never counts, and only the author sees who", async () => {
      as(bob);
      expect((await call("POST", "/api/stories/views", { storyIds: [storyId] })).body).toEqual({ recorded: 1 });
      expect((await call("POST", "/api/stories/views", { storyIds: [storyId] })).body).toEqual({ recorded: 0 });
      as(alice);
      expect((await call("POST", "/api/stories/views", { storyIds: [storyId] })).body).toEqual({ recorded: 0 });
      // Carol cannot see it, so her view is not recorded either.
      as(carol);
      expect((await call("POST", "/api/stories/views", { storyIds: [storyId] })).body).toEqual({ recorded: 0 });

      expect((await strip(bob)).items[0]!.unseen).toBe(false);
      as(alice);
      const viewers = await call("GET", `/api/stories/${storyId}/viewers`);
      expect(viewers.body).toMatchObject({ viewCount: 1, nextCursor: null });
      expect(viewers.body.viewers).toEqual([
        expect.objectContaining({ user: expect.objectContaining({ id: bob.id }), reaction: null, replied: false }),
      ]);
      as(bob);
      expect((await call("GET", `/api/stories/${storyId}/viewers`)).status).toBe(404);
    });

    it("a reaction is one per viewer, changeable, and never a message", async () => {
      as(bob);
      expect((await call("PUT", `/api/stories/${storyId}/reaction`, { reaction: "fire" })).status).toBe(200);
      expect((await call("PUT", `/api/stories/${storyId}/reaction`, { reaction: "gg" })).status).toBe(200);
      expect((await read(bob, [storyId]))[0]!.viewer).toMatchObject({ seen: true, reaction: "gg" });
      as(alice);
      const viewers = await call("GET", `/api/stories/${storyId}/viewers`);
      expect(viewers.body).toMatchObject({ viewCount: 1, reactionCount: 1 });
      expect((await getPool().query(`SELECT 1 FROM messages`)).rowCount).toBe(0);
      as(alice);
      expect((await call("PUT", `/api/stories/${storyId}/reaction`, { reaction: "gg" })).status).toBe(400);
    });

    it("a reply becomes a DM quoting the story, and rides the DM rules", async () => {
      as(bob);
      const reply = await call("POST", `/api/stories/${storyId}/reply`, { text: "que isso" });
      expect(reply.status).toBe(201);
      const message = (
        await getPool().query(`SELECT channel_id, story_id, body FROM messages WHERE id = $1`, [
          reply.body.messageId,
        ])
      ).rows[0];
      expect(message).toEqual({ channel_id: reply.body.conversationId, story_id: storyId, body: "que isso" });
      as(alice);
      const viewers = await call("GET", `/api/stories/${storyId}/viewers`);
      expect(viewers.body.viewers[0].replied).toBe(true);
      // The history read carries the quote.
      const history = await call("GET", `/api/channels/${reply.body.conversationId}/messages`);
      expect(history.body.messages[0].storyId).toBe(storyId);
      // The quote card, for a participant, while it lives.
      const card = await call("GET", `/api/stories/${storyId}/card`);
      expect(card.body).toMatchObject({ state: "live", text: "on hoje 22h", authorId: alice.id });
      as(carol);
      expect((await call("GET", `/api/stories/${storyId}/card`)).status).toBe(404);

      // A block in either direction takes the quote's content away too.
      await getPool().query(`INSERT INTO user_blocks (user_id, blocked_user_id) VALUES ($1, $2)`, [
        bob.id,
        alice.id,
      ]);
      as(bob);
      expect((await call("GET", `/api/stories/${storyId}/card`)).body).toMatchObject({
        state: "removed",
        text: null,
        posterUrl: null,
      });
      await getPool().query(`DELETE FROM user_blocks`);

      // Bob leaves the server: still in the DM, no longer in the audience, so
      // the quote carries nothing for him.
      await getPool().query(`DELETE FROM server_members WHERE server_id = $1 AND user_id = $2`, [
        serverId,
        bob.id,
      ]);
      invalidateServerMemberRoles(serverId);
      as(bob);
      expect((await call("GET", `/api/stories/${storyId}/card`)).body).toMatchObject({
        state: "removed",
        text: null,
      });
      // The author still sees their own.
      as(alice);
      expect((await call("GET", `/api/stories/${storyId}/card`)).body.state).toBe("live");

      // After expiry the quote keeps nothing.
      await getPool().query(`UPDATE stories SET expires_at = now() - interval '1 second'`);
      as(alice);
      expect((await call("GET", `/api/stories/${storyId}/card`)).body).toMatchObject({
        state: "expired",
        text: null,
        posterUrl: null,
        caption: null,
      });
    });

    it("a closed DM inbox and replies turned off both refuse, and say which", async () => {
      await getPool().query(`UPDATE users SET dm_privacy = 'nobody' WHERE id = $1`, [alice.id]);
      expect((await read(bob, [storyId]))[0]!.viewer).toMatchObject({
        canReply: false,
        replyBlockedReason: "dm_closed",
      });
      as(bob);
      expect((await call("POST", `/api/stories/${storyId}/reply`, { text: "oi" })).status).toBe(403);
      await getPool().query(`UPDATE users SET dm_privacy = 'everyone' WHERE id = $1`, [alice.id]);
      await getPool().query(`UPDATE stories SET replies_enabled = FALSE`);
      expect((await read(bob, [storyId]))[0]!.viewer.replyBlockedReason).toBe("replies_off");
      expect((await call("POST", `/api/stories/${storyId}/reply`, { text: "oi" })).status).toBe(403);
      expect((await getPool().query(`SELECT 1 FROM messages`)).rowCount).toBe(0);
    });
  });

  // ------------------------------------------------------------------ moderation

  describe("moderation", () => {
    beforeEach(async () => {
      await storiesOn();
      await friendsOn();
    });

    it("staff take a story out of THEIR server only, audited, with a notice", async () => {
      await befriend(bob, carol);
      as(bob);
      const id = (await postText("dos dois", { serverIds: [serverId], friends: true })).body.story.id;
      as(alice);
      expect((await read(alice, [id]))[0]!.viewer.canModerate).toEqual([serverId]);
      const removed = await call("DELETE", `/api/servers/${serverId}/stories/${id}`, {
        reason: "spam no QG",
      });
      expect(removed.status).toBe(204);
      expect(await read(alice, [id])).toEqual([]);
      // Still up for Bob's friends.
      expect(await read(carol, [id])).toHaveLength(1);
      const audit = (await getPool().query(`SELECT action, actor_id, target_id, reason FROM audit_log`)).rows;
      expect(audit).toEqual([
        { action: "story.remove", actor_id: alice.id, target_id: bob.id, reason: "spam no QG" },
      ]);
      as(bob);
      const notices = await call("GET", "/api/stories/notices");
      expect(notices.body.notices).toEqual([
        expect.objectContaining({ storyId: id, serverId, serverName: "QG", reason: "spam no QG" }),
      ]);
      expect((await call("POST", `/api/stories/notices/${notices.body.notices[0].id}/ack`)).status).toBe(204);
      expect((await call("GET", "/api/stories/notices")).body.notices).toEqual([]);
      // Bob holds no MANAGE_MESSAGES.
      const other = (await postText("outro")).body.story.id;
      expect((await call("DELETE", `/api/servers/${serverId}/stories/${other}`)).status).toBe(403);
    });

    it("a report routes to the server, minor_sexual and friends to the instance, and holds the bytes", async () => {
      const { story } = await mintImage();
      as(alice);
      await call("POST", `/api/stories/${story.id}/publish`);
      const pinned = await settlePublish(story.id);
      as(bob);
      const filed = await call("POST", "/api/reports", {
        subjectType: "story",
        storyId: story.id,
        serverId,
        reason: "harassment",
      });
      expect(filed.status).toBe(201);
      expect(filed.body.report).toMatchObject({
        subjectType: "story",
        contextKind: "server",
        storyId: story.id,
        contentSnapshot: "meu setup",
      });
      // The same again is a duplicate, not a second row.
      expect(
        (
          await call("POST", "/api/reports", {
            subjectType: "story",
            storyId: story.id,
            serverId,
            reason: "harassment",
          })
        ).status,
      ).toBe(200);
      const minor = await call("POST", "/api/reports", {
        subjectType: "story",
        storyId: story.id,
        serverId,
        reason: "minor_sexual",
        details: "outra coisa",
      });
      // The open dedupe is per reporter and story, whatever the reason.
      expect(minor.status).toBe(200);
      // Carol, who cannot see it, gets the one 404 every subject gets.
      as(carol);
      expect(
        (await call("POST", "/api/reports", { subjectType: "story", storyId: story.id, reason: "spam" })).status,
      ).toBe(404);

      // Expired with an OPEN report: the bytes stay.
      await getPool().query(`UPDATE stories SET expires_at = now() - interval '1 second'`);
      await sweepStories();
      expect(storage.deleted).toEqual([]);
      // Resolved: held 30 more days.
      await getPool().query(`UPDATE reports SET status = 'actioned', resolved_at = now()`);
      await sweepStories();
      expect(storage.deleted).toEqual([]);
      await getPool().query(`UPDATE reports SET resolved_at = now() - interval '31 days'`);
      await sweepStories();
      expect(storage.deleted).toEqual([pinned]);
    });

    it("a server manager's remove-story takes only their server's slice", async () => {
      await befriend(bob, carol);
      as(bob);
      const id = (await postText("dos dois", { serverIds: [serverId], friends: true })).body.story.id;
      as(alice);
      const filed = await call("POST", "/api/reports", {
        subjectType: "story",
        storyId: id,
        serverId,
        reason: "spam",
      });
      expect(filed.body.report.contextKind).toBe("server");
      const removed = await call("POST", `/api/reports/${filed.body.report.id}/remove-story`);
      expect(removed.status).toBe(200);
      expect(await read(alice, [id])).toEqual([]);
      expect(await read(carol, [id])).toHaveLength(1);
    });

    it("minor_sexual goes to the instance queue even from a server", async () => {
      as(bob);
      const id = (await postText("x")).body.story.id;
      as(alice);
      const filed = await call("POST", "/api/reports", {
        subjectType: "story",
        storyId: id,
        serverId,
        reason: "minor_sexual",
      });
      expect(filed.status).toBe(201);
      expect(filed.body.report.contextKind).toBe("none");
      const row = (await getPool().query(`SELECT server_id FROM reports`)).rows[0];
      expect(row.server_id).toBeNull();
    });

    it("a friends story report goes to the instance queue, and the operator can remove it everywhere", async () => {
      await befriend(alice, carol);
      const id = (await postText("amigos", { serverIds: [serverId], friends: true })).body.story.id;
      as(carol);
      const filed = await call("POST", "/api/reports", { subjectType: "story", storyId: id, reason: "spam" });
      expect(filed.status).toBe(201);
      expect(filed.body.report.contextKind).toBe("none");
      as(operator);
      const removed = await call("POST", `/api/reports/${filed.body.report.id}/remove-story`);
      expect(removed.status).toBe(200);
      expect(await read(carol, [id])).toEqual([]);
      expect(await read(bob, [id])).toEqual([]);
      as(operator);
      const all = await call("GET", "/api/reports/all");
      expect(all).toMatchObject({ status: 200 });
      expect(all.body.reports[0]).toMatchObject({ subjectType: "story", storyId: id });
    });
  });

  // ------------------------------------------------------------------ the sweep

  describe("the sweep", () => {
    beforeEach(async () => {
      await storiesOn();
    });

    it("expires, deletes media and poster once, and the row a week later", async () => {
      const { story } = await mintImage();
      as(alice);
      await call("POST", `/api/stories/${story.id}/publish`);
      const pinned = await settlePublish(story.id);
      await getPool().query(`UPDATE stories SET poster_storage_key = $2 WHERE id = $1`, [
        story.id,
        `stories/${alice.id}/${story.id}/poster.jpg`,
      ]);
      await getPool().query(`UPDATE stories SET expires_at = now() - interval '1 minute'`);
      // Two processes sweeping at once delete each object exactly once.
      await Promise.all([sweepStories(), sweepStories()]);
      expect(storage.deleted.sort()).toEqual(
        [pinned, `stories/${alice.id}/${story.id}/poster.jpg`].sort(),
      );
      const row = (
        await getPool().query(
          `SELECT status, media_deleted_at IS NOT NULL AS gone FROM stories WHERE id = $1`,
          [story.id],
        )
      ).rows[0];
      expect(row).toEqual({ status: "expired", gone: true });
      await sweepStories();
      expect(storage.deleted).toHaveLength(2);
      await getPool().query(`UPDATE stories SET expires_at = now() - interval '8 days'`);
      expect((await sweepStories()).rowsDeleted).toBe(1);
    });

    it("keeps running with the flag off", async () => {
      const { story } = await mintImage();
      as(alice);
      await call("POST", `/api/stories/${story.id}/publish`);
      const pinned = await settlePublish(story.id);
      await storiesOn(serverId, false);
      await getPool().query(`UPDATE stories SET expires_at = now() - interval '1 minute'`);
      await sweepStories();
      expect(storage.deleted).toEqual([pinned]);
    });

    it("takes a media delete again when the process that claimed it died", async () => {
      const { story } = await mintImage();
      as(alice);
      await call("POST", `/api/stories/${story.id}/publish`);
      const pinned = await settlePublish(story.id);
      // Claimed by a process that is still at it: left alone, and the row is
      // not dropped while its bytes may still exist.
      await getPool().query(
        `UPDATE stories SET status = 'expired', expires_at = now() - interval '9 days',
                media_delete_claimed_at = now()`,
      );
      expect(await sweepStories()).toMatchObject({ mediaDeleted: 0, rowsDeleted: 0 });
      expect(storage.deleted).toEqual([]);
      // Claimed by a process that died: the lease lapses and it is taken again.
      await getPool().query(
        `UPDATE stories SET media_delete_claimed_at = now() - interval '11 minutes'`,
      );
      expect(await sweepStories()).toMatchObject({ mediaDeleted: 1, rowsDeleted: 1 });
      expect(storage.deleted).toEqual([pinned]);
    });

    it("deletes an orphan (minted, never published) after an hour, with its object", async () => {
      const { story, key } = await mintImage();
      await sweepStories();
      expect(storage.deleted).toEqual([]);
      await getPool().query(`UPDATE stories SET created_at = now() - interval '2 hours' WHERE id = $1`, [
        story.id,
      ]);
      const result = await sweepStories();
      expect(result.orphaned).toBe(1);
      expect(storage.deleted).toEqual([key]);
    });

    it("an author delete takes it down now and the bytes on the next tick", async () => {
      const { story } = await mintImage();
      as(alice);
      await call("POST", `/api/stories/${story.id}/publish`);
      const pinned = await settlePublish(story.id);
      expect((await call("DELETE", `/api/stories/${story.id}`)).status).toBe(204);
      expect(await read(bob, [story.id])).toEqual([]);
      await sweepStories();
      expect(storage.deleted).toEqual([pinned]);
      as(bob);
      expect((await call("DELETE", `/api/stories/${story.id}`)).status).toBe(404);
    });
  });

  // ------------------------------------------------------------------ Baú and metrics

  it("Salvar no Baú copies the media into a draft, for the author with MANAGE_SERVER", async () => {
    await storiesOn();
    await setGlobalFlag("community_home", true, { kind: "dashboard" });
    const { story } = await mintImage();
    as(alice);
    await call("POST", `/api/stories/${story.id}/publish`);
    const pinned = await settlePublish(story.id);
    expect((await read(alice, [story.id]))[0]!.viewer.canSaveToBau).toEqual([serverId]);
    const saved = await call("POST", `/api/stories/${story.id}/save-to-bau`, { serverId });
    expect(saved.status).toBe(201);
    expect(storage.copies).toEqual([{ from: pinned, to: expect.stringMatching(`^community-home/${serverId}/`) }]);
    const post = (
      await getPool().query(`SELECT status, body, media_storage_key FROM community_home_posts WHERE id = $1`, [
        saved.body.postId,
      ])
    ).rows[0];
    expect(post).toEqual({ status: "draft", body: "meu setup", media_storage_key: storage.copies[0]!.to });
    // The story's own object still goes on schedule; the copy stays.
    await getPool().query(`UPDATE stories SET expires_at = now() - interval '1 minute'`);
    await sweepStories();
    expect(storage.deleted).toEqual([pinned]);
    // Bob is not the author.
    as(bob);
    expect((await call("POST", `/api/stories/${story.id}/save-to-bau`, { serverId })).status).toBe(403);
  });

  describe("account deletion", () => {
    beforeEach(async () => {
      await storiesOn();
    });

    it("takes the author's stories and bytes, but keeps a held one as evidence", async () => {
      as(bob);
      const text = (await postText("do bob")).body.story.id as string;
      const plain = await (async () => {
        const created = await call("POST", "/api/stories", {
          kind: "image",
          caption: "foto do bob",
          audiences: { serverIds: [serverId] },
          media: { contentType: "image/jpeg", byteSize: 4000, width: 10, height: 10 },
        });
        const id = created.body.story.id as string;
        const key = (
          await getPool().query<{ media_storage_key: string }>(
            `SELECT media_storage_key FROM stories WHERE id = $1`,
            [id],
          )
        ).rows[0]!.media_storage_key;
        storage.objects.set(key, { contentLength: 4000, contentType: "image/jpeg", prefix: JPEG });
        await call("POST", `/api/stories/${id}/publish`);
        const pinned = await settlePublish(id);
        return { id, key: pinned };
      })();
      const reported = (await postText("denunciado")).body.story.id as string;
      as(alice);
      await call("POST", "/api/reports", {
        subjectType: "story",
        storyId: reported,
        serverId,
        reason: "harassment",
      });

      await deleteAccount(bob.id, "clerk_bob");
      const rows = (
        await getPool().query<{ id: string; status: string; author_id: string | null; caption: string | null }>(
          `SELECT id, status, author_id, caption FROM stories ORDER BY created_at`,
        )
      ).rows;
      // The plain text card is gone; the reported one survives, authorless.
      expect(rows.find((row) => row.id === text)).toBeUndefined();
      expect(rows.find((row) => row.id === reported)).toMatchObject({
        status: "deleted",
        author_id: null,
      });
      expect(rows.find((row) => row.id === plain.id)).toMatchObject({ caption: null });
      // The sweep removes the photo's bytes and then its row.
      await sweepStories();
      expect(storage.deleted).toEqual([plain.key]);
      expect(
        (await getPool().query(`SELECT 1 FROM stories WHERE id = $1`, [plain.id])).rowCount,
      ).toBe(0);
      // The report still points at the story it is about.
      const report = (await getPool().query(`SELECT reported_story_id FROM reports`)).rows[0];
      expect(report.reported_story_id).toBe(reported);
    });

    it("a viewer who deletes their account is taken off the counts", async () => {
      const id = (await postText()).body.story.id as string;
      as(bob);
      await call("PUT", `/api/stories/${id}/reaction`, { reaction: "fire" });
      as(alice);
      expect((await call("GET", `/api/stories/${id}/viewers`)).body).toMatchObject({
        viewCount: 1,
        reactionCount: 1,
      });
      await deleteAccount(bob.id, "clerk_bob");
      expect((await call("GET", `/api/stories/${id}/viewers`)).body).toMatchObject({
        viewCount: 0,
        reactionCount: 0,
        viewers: [],
      });
    });
  });

  describe("retries and races", () => {
    beforeEach(async () => {
      await storiesOn();
    });

    it("a create retried with its requestId answers the first story", async () => {
      const requestId = "9b2f0f2e-5d0b-4a43-9a51-6f8d1c2b3a4e";
      const first = await call("POST", "/api/stories", {
        kind: "image",
        audiences: { serverIds: [serverId] },
        media: { contentType: "image/jpeg", byteSize: 4000, width: 10, height: 10 },
        requestId,
      });
      const again = await call("POST", "/api/stories", {
        kind: "image",
        audiences: { serverIds: [serverId] },
        media: { contentType: "image/jpeg", byteSize: 4000, width: 10, height: 10 },
        requestId,
      });
      expect(first.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.body.story.id).toBe(first.body.story.id);
      expect(again.body.upload).toMatchObject({ method: "PUT" });
      expect((await getPool().query(`SELECT 1 FROM stories`)).rowCount).toBe(1);
    });

    it("a reply retried with its nonce sends one DM", async () => {
      const id = (await postText()).body.story.id as string;
      as(bob);
      const one = await call("POST", `/api/stories/${id}/reply`, { text: "que isso", nonce: "n-1" });
      const two = await call("POST", `/api/stories/${id}/reply`, { text: "que isso", nonce: "n-1" });
      expect(one.status).toBe(201);
      expect(two.body.messageId).toBe(one.body.messageId);
      expect((await getPool().query(`SELECT 1 FROM messages`)).rowCount).toBe(1);
    });

    it("a report cannot land on a story whose bytes the sweep already claimed", async () => {
      const { story } = await mintImage();
      as(alice);
      await call("POST", `/api/stories/${story.id}/publish`);
      await getPool().query(`UPDATE stories SET media_delete_claimed_at = now()`);
      as(bob);
      expect(
        (
          await call("POST", "/api/reports", {
            subjectType: "story",
            storyId: story.id,
            serverId,
            reason: "spam",
          })
        ).status,
      ).toBe(404);
    });

    it("a refusal from a lapsed video claim never takes down a live story", async () => {
      const id = (await postText()).body.story.id as string;
      await refuseStory(id, { until: "none" }, "stale worker", "2001-01-01T00:00:00Z");
      await refuseStory(id, { until: "none" }, "stale worker");
      expect(await read(bob, [id])).toHaveLength(1);
    });
  });

  it("reports itself on the metrics", async () => {
    await storiesOn();
    const id = (await postText()).body.story.id;
    as(bob);
    await call("POST", "/api/stories/views", { storyIds: [id] });
    await call("PUT", `/api/stories/${id}/reaction`, { reaction: "clap" });
    const metrics = await storiesMetrics();
    expect(metrics.process).toMatchObject({ published: 1, views: 1, reactions: 1 });
    expect(metrics.db).toMatchObject({
      posters24h: 1,
      stories24h: { total: 1, text: 1 },
      audiences24h: { server: 1, friends: 0 },
      openers24h: 1,
      reactions24h: 1,
      live: 1,
      sweepLagSeconds: 0,
    });
  });
});

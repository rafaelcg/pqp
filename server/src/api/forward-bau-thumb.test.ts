import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ENCAMINHAR, the picture on a Baú card, on a real Postgres.
 *
 * The thumbnail of a forwarded post is the post's PUBLIC cover route, and only
 * when the post has a public page. What this pins, in the order of the risk:
 *
 *   * NOTHING RESTRICTED GETS A PICTURE. A members-only (VIP) post, a post on a
 *     server with no public address, the `bau_public_posts` flag off, a post
 *     with media but no cover: no `mediaThumbUrl`, `mediaKind` still says what
 *     it has.
 *   * WHAT IS STORED IS NEVER SIGNED. A root-relative path, no query, no host.
 *   * THE ADDRESS IS THE ROUTE'S ANSWER, NOT A COPY OF IT. After the forward,
 *     the post stops qualifying (made members-only) and the stored address
 *     answers the one 404 every refusal gives, so a card in a chat cannot keep
 *     a picture alive that the page itself would no longer show.
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
  resolveAuthSession: async () =>
    actor ? { user: actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

/** A bucket that has the picture: configured, signs, describes and streams it. */
const PNG = new Uint8Array(2048);
PNG.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
PNG.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
new DataView(PNG.buffer).setUint32(16, 1200);
new DataView(PNG.buffer).setUint32(20, 630);

vi.mock("../lib/s3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/s3.js")>();
  return {
    ...actual,
    isStorageConfigured: () => true,
    presignGet: (key: string) => `https://storage.test/get/${key}?X-Amz-Signature=abc`,
    headObject: async () => ({ contentLength: PNG.length, contentType: "image/png" }),
    getObjectPrefix: async () => PNG.subarray(0, 1024),
    openObject: async () => new Response(PNG, { status: 200 }),
  };
});

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("./index.js");
const { startFeatureFlags, setGlobalFlag, resetFeatureFlagsForTests } = await import(
  "../lib/flags.js"
);
const { upsertUser } = await import("../services/users.js");
const { createServer: createChatServer } = await import("../services/servers.js");
const { messageForwardSchema } = await import("@pqp/shared");

type Person = { id: string; clerk_id: string };

let httpServer: Server;
let baseUrl: string;

async function call<T = Record<string, unknown>>(
  as: Person | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T; text: string }> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(as ? { Authorization: "Bearer test" } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed as T, text };
}

const ENV_KEYS = [
  "COMMUNITIES_ENABLED",
  "COMMUNITY_HOME_ENABLED",
  "COMMUNITY_HOME_VIP_ENABLED",
  "BAU_PUBLIC_POSTS",
] as const;

describeDb("forwarding a Baú post: its picture", () => {
  let owner: Person;
  let serverId: string;
  let generalId: string;
  const SLUG = "mesa-da-tues";

  beforeAll(async () => {
    await initDb();
    await startFeatureFlags();
    httpServer = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    resetFeatureFlagsForTests();
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(
      `TRUNCATE users, feature_flags, feature_flag_overrides, feature_flag_audit RESTART IDENTITY CASCADE`,
    );
    resetApiRateLimits();
    await setGlobalFlag("forward_messages", true, { kind: "dashboard" });
    process.env.COMMUNITIES_ENABLED = "true";
    process.env.COMMUNITY_HOME_ENABLED = "true";
    process.env.COMMUNITY_HOME_VIP_ENABLED = "true";
    process.env.BAU_PUBLIC_POSTS = "true";

    owner = await upsertUser({ clerkId: "clerk_thumb_owner", displayName: "Dona", avatarUrl: null });
    const created = await createChatServer("Mesa da Tues", owner.id);
    serverId = created.server.id;
    await getPool().query(
      `UPDATE servers
          SET community_home_enabled = TRUE, is_community = TRUE, community_slug = $2
        WHERE id = $1`,
      [serverId, SLUG],
    );
    const channels = await getPool().query<{ id: string; type: string }>(
      `SELECT id, type FROM channels WHERE server_id = $1 ORDER BY position`,
      [serverId],
    );
    generalId = channels.rows.find((c) => c.type === "text")!.id;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  interface Seed {
    visibility?: "free" | "members";
    mediaKind: "image" | "video" | "youtube";
    storageKey?: string | null;
    posterKey?: string | null;
    youtubeUrl?: string | null;
  }

  async function seed(post: Seed): Promise<string> {
    const result = await getPool().query<{ id: string }>(
      `INSERT INTO community_home_posts
         (server_id, author_id, title, body, teaser, visibility, status,
          media_kind, media_name, media_content_type, media_byte_size,
          media_storage_key, media_youtube_url, poster_storage_key, published_at)
       VALUES ($1, $2, 'Clip da sessao', 'o clip inteiro', NULL, $3, 'published',
               $4, 'arquivo', $5, $6, $7, $8, $9, now())
       RETURNING id`,
      [
        serverId,
        owner.id,
        post.visibility ?? "free",
        post.mediaKind,
        post.mediaKind === "image" ? "image/png" : post.mediaKind === "video" ? "video/mp4" : null,
        post.mediaKind === "youtube" ? null : 1234,
        post.storageKey === undefined
          ? post.mediaKind === "youtube"
            ? null
            : `bau/${serverId}/media-${Math.random().toString(36).slice(2)}.bin`
          : post.storageKey,
        post.youtubeUrl ?? null,
        post.posterKey ?? null,
      ],
    );
    return result.rows[0]!.id;
  }

  async function forwardPost(postId: string) {
    const res = await call<{
      results: { ok: boolean; reason?: string; message?: { forward?: Record<string, unknown> } }[];
    }>(owner, "POST", "/api/forwards", {
      source: { kind: "bau_post", id: postId, serverId },
      targets: [{ channelId: generalId }],
    });
    expect(res.status).toBe(200);
    const result = res.body.results[0]!;
    expect(result.ok).toBe(true);
    return messageForwardSchema.parse(result.message!.forward);
  }

  const coverPath = (postId: string) => `/api/public/communities/${SLUG}/posts/${postId}/cover`;

  it("an image post with a public page carries the public cover route, never a signed url", async () => {
    const postId = await seed({ mediaKind: "image" });
    const snapshot = await forwardPost(postId);
    expect(snapshot.mediaKind).toBe("image");
    expect(snapshot.mediaThumbUrl).toBe(coverPath(postId));
    expect(snapshot.mediaThumbUrl).not.toMatch(/[?#]|https?:/);
    // It is a real public address: no credential, and the bytes come back.
    const served = await fetch(`${baseUrl}${snapshot.mediaThumbUrl}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
  });

  it("a video's thumbnail is its chosen picture; a video with none has no thumbnail", async () => {
    const withPoster = await seed({ mediaKind: "video", posterKey: "bau/poster-1.png" });
    const without = await seed({ mediaKind: "video" });
    const a = await forwardPost(withPoster);
    expect(a.mediaKind).toBe("video");
    expect(a.mediaThumbUrl).toBe(coverPath(withPoster));
    const b = await forwardPost(without);
    expect(b.mediaKind).toBe("video");
    expect(b.mediaThumbUrl ?? null).toBeNull();
  });

  it("a YouTube post keeps its public poster", async () => {
    const postId = await seed({
      mediaKind: "youtube",
      youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    const snapshot = await forwardPost(postId);
    expect(snapshot.mediaThumbUrl).toMatch(/^https:\/\/i\.ytimg\.com\//);
  });

  it("a members-only post gets no picture, whoever forwards it", async () => {
    const postId = await seed({ mediaKind: "image", visibility: "members" });
    const snapshot = await forwardPost(postId);
    expect(snapshot.restricted).toBe(true);
    expect(snapshot.mediaThumbUrl ?? null).toBeNull();
    expect(snapshot.mediaKind).toBeUndefined();
  });

  it("no public page, no picture: flag off, no public address, a suspended community", async () => {
    const postId = await seed({ mediaKind: "image" });

    process.env.BAU_PUBLIC_POSTS = "false";
    expect((await forwardPost(postId)).mediaThumbUrl ?? null).toBeNull();
    process.env.BAU_PUBLIC_POSTS = "true";
    expect((await forwardPost(postId)).mediaThumbUrl).toBe(coverPath(postId));

    await getPool().query(`UPDATE servers SET is_community_suspended = TRUE WHERE id = $1`, [serverId]);
    expect((await forwardPost(postId)).mediaThumbUrl ?? null).toBeNull();
    await getPool().query(`UPDATE servers SET is_community_suspended = FALSE, is_community = FALSE WHERE id = $1`, [
      serverId,
    ]);
    const snapshot = await forwardPost(postId);
    expect(snapshot.mediaThumbUrl ?? null).toBeNull();
    expect(snapshot.mediaKind).toBe("image");
  });

  it("the stored address goes dark with the page: made members-only later, it answers the one 404", async () => {
    const postId = await seed({ mediaKind: "image" });
    const snapshot = await forwardPost(postId);
    expect((await fetch(`${baseUrl}${snapshot.mediaThumbUrl}`)).status).toBe(200);

    await getPool().query(`UPDATE community_home_posts SET visibility = 'members' WHERE id = $1`, [postId]);
    const gone = await fetch(`${baseUrl}${snapshot.mediaThumbUrl}`, { redirect: "manual" });
    expect(gone.status).toBe(404);
    const unknown = await fetch(
      `${baseUrl}/api/public/communities/${SLUG}/posts/11111111-2222-4333-8444-555555555555/cover`,
      { redirect: "manual" },
    );
    expect(unknown.status).toBe(404);
  });
});

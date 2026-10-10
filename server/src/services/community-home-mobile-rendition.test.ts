import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * The phone cut of a Baú video (`bau_mobile_rendition`): a second stored video
 * on a post, uploaded through the same mint / PUT / claim as the main one.
 *
 *   * FLAG OFF MEANS OFF. A write that names one is refused, and a read leaves
 *     `media.mobile` out even for a post that has one stored.
 *   * ONLY BESIDE A VIDEO, AND ONLY A VIDEO. An image post cannot carry one, a
 *     PDF cannot be one, and the main file cannot be its own phone cut.
 *   * IT GOES WITH ITS VIDEO. Replacing the main video drops the old cut, and
 *     deleting the post deletes both objects and both upload rows.
 *   * THE LOCK COVERS IT. It rides inside `media`, which a locked viewer never
 *     gets.
 *
 * Storage is an in-memory stand-in; the router, the permission check and
 * Postgres are real.
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

const stored = new Map<string, { bytes: Buffer; contentType: string }>();
const deleted: string[] = [];
/** Keys whose storage delete fails, to prove the row is kept for a retry. */
const failDeletes = new Set<string>();
/** Keys whose storage delete never answers: the process "stops" mid-cleanup. */
const hangDeletes = new Set<string>();

vi.mock("../lib/s3.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/s3.js")>()),
  isStorageConfigured: () => true,
  presignPut: (key: string) => `http://storage.test/put/${key}`,
  presignGet: (key: string) => `http://storage.test/get/${key}`,
  headObject: async (key: string) => {
    const object = stored.get(key);
    return object
      ? { contentLength: object.bytes.length, contentType: object.contentType }
      : null;
  },
  getObjectPrefix: async (key: string, length: number) =>
    stored.get(key)?.bytes.subarray(0, length) ?? null,
  deleteObject: async (key: string) => {
    if (hangDeletes.has(key)) {
      return new Promise<void>(() => {});
    }
    if (failDeletes.has(key)) {
      throw new Error("storage unreachable");
    }
    deleted.push(key);
    stored.delete(key);
  },
}));

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("../api/index.js");
const { upsertUser } = await import("./users.js");
const { sweepOrphanedCommunityHomeMedia } = await import("./community-home.js");
const { createServer: createChatServer } = await import("./servers.js");

let httpServer: Server;
let baseUrl: string;

async function call<T = Record<string, unknown>>(
  as: { id: string; clerk_id: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  actor = as;
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

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48,
  0x44, 0x52,
]);
/** Post-commit cleanup runs after the answer; wait for it to settle. */
async function settled(check: () => void | Promise<void>): Promise<void> {
  await vi.waitFor(check, { timeout: 2000, interval: 10 });
}

const MP4 = Buffer.from("\0\0\0\x18ftypmp42 fake video bytes");

type Mobile = {
  name: string;
  contentType: string | null;
  byteSize: number | null;
  url: string | null;
} | null;

interface PostBody {
  id: string;
  locked: boolean;
  media: { kind: string; url: string | null; mobile?: Mobile } | null;
}

interface FeedBody {
  posts: PostBody[];
  mobileRenditionEnabled: boolean;
}

describeDb("community home mobile rendition", () => {
  let owner: { id: string; clerk_id: string };
  let member: { id: string; clerk_id: string };
  let serverId: string;

  beforeAll(async () => {
    await initDb();
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
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    resetApiRateLimits();
    stored.clear();
    deleted.length = 0;
    failDeletes.clear();
    hangDeletes.clear();
    process.env.COMMUNITY_HOME_ENABLED = "true";
    process.env.COMMUNITY_HOME_VIP_ENABLED = "true";
    process.env.BAU_MOBILE_RENDITION = "true";
    owner = await upsertUser({
      clerkId: "clerk_owner",
      displayName: "owner",
      avatarUrl: null,
    });
    member = await upsertUser({
      clerkId: "clerk_member",
      displayName: "member",
      avatarUrl: null,
    });
    const created = await createChatServer("Lançamento", owner.id);
    serverId = created.server.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [serverId, member.id],
    );
  });

  afterEach(() => {
    delete process.env.COMMUNITY_HOME_ENABLED;
    delete process.env.COMMUNITY_HOME_VIP_ENABLED;
    delete process.env.BAU_MOBILE_RENDITION;
  });

  /** Mint, "PUT" the bytes, claim. Returns the upload id and its key. */
  async function upload(
    contentType: string,
    bytes: Buffer,
    filename: string,
  ): Promise<{ uploadId: string; key: string }> {
    const minted = await call<{ uploadId: string; key: string }>(
      owner,
      "POST",
      `/api/servers/${serverId}/home/media`,
      { contentType, byteSize: bytes.length, filename },
    );
    expect(minted.status).toBe(201);
    stored.set(minted.body.key, { bytes, contentType });
    const claimed = await call(
      owner,
      "POST",
      `/api/servers/${serverId}/home/media/claim`,
      { uploadId: minted.body.uploadId },
    );
    expect(claimed.status).toBe(200);
    return minted.body;
  }

  async function publish(body: Record<string, unknown>) {
    return call<{ post: PostBody; error?: string }>(
      owner,
      "POST",
      `/api/servers/${serverId}/home/posts`,
      { title: "Lançamento", body: "", status: "published", ...body },
    );
  }

  async function feed(as = member) {
    const res = await call<FeedBody>(
      as,
      "GET",
      `/api/servers/${serverId}/home/posts`,
    );
    expect(res.status).toBe(200);
    return res.body;
  }

  it("publishes a landscape video with a vertical cut, and readers get both", async () => {
    const main = await upload("video/mp4", MP4, "launch-16x9.mp4");
    const vertical = await upload("video/mp4", MP4, "launch-9x16.mp4");
    const res = await publish({
      mediaUploadId: main.uploadId,
      mobileMediaUploadId: vertical.uploadId,
    });
    expect(res.status).toBe(201);
    expect(res.body.post.media?.url).toBe(`http://storage.test/get/${main.key}`);
    expect(res.body.post.media?.mobile).toEqual({
      name: "launch-9x16.mp4",
      contentType: "video/mp4",
      byteSize: MP4.length,
      url: `http://storage.test/get/${vertical.key}`,
    });

    const read = await feed();
    expect(read.mobileRenditionEnabled).toBe(true);
    expect(read.posts[0]?.media?.mobile?.url).toBe(
      `http://storage.test/get/${vertical.key}`,
    );
    // Both uploads are claimed onto the post, so the orphan sweep leaves them.
    const rows = await getPool().query<{ claimed_post_id: string | null }>(
      `SELECT claimed_post_id FROM community_home_media_uploads`,
    );
    expect(rows.rows.map((r) => r.claimed_post_id)).toEqual([
      res.body.post.id,
      res.body.post.id,
    ]);
  });

  it("with the flag off, refuses the write and hides a stored cut on read", async () => {
    const main = await upload("video/mp4", MP4, "a.mp4");
    const vertical = await upload("video/mp4", MP4, "b.mp4");
    const created = await publish({
      mediaUploadId: main.uploadId,
      mobileMediaUploadId: vertical.uploadId,
    });
    expect(created.status).toBe(201);

    process.env.BAU_MOBILE_RENDITION = "false";
    const read = await feed();
    expect(read.mobileRenditionEnabled).toBe(false);
    expect(read.posts[0]?.media?.kind).toBe("video");
    expect(read.posts[0]?.media?.mobile ?? null).toBeNull();
    // Kept, not deleted: turning it back on brings the cut back.
    expect(deleted).toEqual([]);

    const another = await upload("video/mp4", MP4, "c.mp4");
    const anotherCut = await upload("video/mp4", MP4, "d.mp4");
    const refused = await publish({
      mediaUploadId: another.uploadId,
      mobileMediaUploadId: anotherCut.uploadId,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/off on this server/i);
  });

  it("only goes beside an uploaded video, and only a video can be one", async () => {
    const image = await upload("image/png", PNG, "foto.png");
    const cut = await upload("video/mp4", MP4, "cut.mp4");
    const besideImage = await publish({
      mediaUploadId: image.uploadId,
      mobileMediaUploadId: cut.uploadId,
    });
    expect(besideImage.status).toBe(400);
    expect(besideImage.body.error).toMatch(/needs an uploaded video/i);

    const besideYoutube = await publish({
      youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
      mobileMediaUploadId: cut.uploadId,
    });
    expect(besideYoutube.status).toBe(400);

    const main = await upload("video/mp4", MP4, "main.mp4");
    const pdf = await upload("application/pdf", Buffer.from("%PDF-1.7\n"), "x.pdf");
    const pdfCut = await publish({
      mediaUploadId: main.uploadId,
      mobileMediaUploadId: pdf.uploadId,
    });
    expect(pdfCut.status).toBe(400);
    expect(pdfCut.body.error).toMatch(/must be a video/i);

    const sameFile = await publish({
      mediaUploadId: main.uploadId,
      mobileMediaUploadId: main.uploadId,
    });
    expect(sameFile.status).toBe(400);
    expect(sameFile.body.error).toMatch(/different file/i);

    // Every refusal rolled back: nothing is on a post.
    const posts = await getPool().query(`SELECT 1 FROM community_home_posts`);
    expect(posts.rowCount).toBe(0);
  });

  it("an edit can add, replace and remove the cut; the replaced object is deleted", async () => {
    const main = await upload("video/mp4", MP4, "main.mp4");
    const created = await publish({ mediaUploadId: main.uploadId });
    const postId = created.body.post.id;
    expect(created.body.post.media?.mobile ?? null).toBeNull();

    const first = await upload("video/mp4", MP4, "v1.mp4");
    const added = await call<{ post: PostBody }>(
      owner,
      "PATCH",
      `/api/servers/${serverId}/home/posts/${postId}`,
      { mobileMediaUploadId: first.uploadId },
    );
    expect(added.status).toBe(200);
    expect(added.body.post.media?.mobile?.name).toBe("v1.mp4");
    expect(added.body.post.media?.url).toBe(`http://storage.test/get/${main.key}`);

    // An edit that does not mention it keeps it.
    const titled = await call<{ post: PostBody }>(
      owner,
      "PATCH",
      `/api/servers/${serverId}/home/posts/${postId}`,
      { title: "Novo título" },
    );
    expect(titled.body.post.media?.mobile?.name).toBe("v1.mp4");

    const second = await upload("video/mp4", MP4, "v2.mp4");
    const replaced = await call<{ post: PostBody }>(
      owner,
      "PATCH",
      `/api/servers/${serverId}/home/posts/${postId}`,
      { mobileMediaUploadId: second.uploadId },
    );
    expect(replaced.body.post.media?.mobile?.name).toBe("v2.mp4");
    await settled(() => expect(deleted).toEqual([first.key]));

    const removed = await call<{ post: PostBody }>(
      owner,
      "PATCH",
      `/api/servers/${serverId}/home/posts/${postId}`,
      { mobileMediaUploadId: null },
    );
    expect(removed.body.post.media?.mobile ?? null).toBeNull();
    expect(removed.body.post.media?.kind).toBe("video");
    await settled(async () => {
      expect(deleted).toEqual([first.key, second.key]);
      const rows = await getPool().query<{ storage_key: string }>(
        `SELECT storage_key FROM community_home_media_uploads`,
      );
      expect(rows.rows.map((r) => r.storage_key)).toEqual([main.key]);
    });
  });

  it("replacing or clearing the main video drops the old cut with it", async () => {
    const main = await upload("video/mp4", MP4, "main.mp4");
    const cut = await upload("video/mp4", MP4, "cut.mp4");
    const created = await publish({
      mediaUploadId: main.uploadId,
      mobileMediaUploadId: cut.uploadId,
    });
    const postId = created.body.post.id;

    const newMain = await upload("video/mp4", MP4, "main-v2.mp4");
    const swapped = await call<{ post: PostBody }>(
      owner,
      "PATCH",
      `/api/servers/${serverId}/home/posts/${postId}`,
      { mediaUploadId: newMain.uploadId },
    );
    expect(swapped.status).toBe(200);
    expect(swapped.body.post.media?.mobile ?? null).toBeNull();
    await settled(() =>
      expect([...deleted].sort()).toEqual([cut.key, main.key].sort()),
    );

    const newCut = await upload("video/mp4", MP4, "cut-v2.mp4");
    await call(owner, "PATCH", `/api/servers/${serverId}/home/posts/${postId}`, {
      mobileMediaUploadId: newCut.uploadId,
    });
    deleted.length = 0;
    const toImage = await upload("image/png", PNG, "foto.png");
    const asImage = await call<{ post: PostBody }>(
      owner,
      "PATCH",
      `/api/servers/${serverId}/home/posts/${postId}`,
      { mediaUploadId: toImage.uploadId },
    );
    expect(asImage.body.post.media?.kind).toBe("image");
    expect(asImage.body.post.media?.mobile ?? null).toBeNull();
    await settled(() =>
      expect([...deleted].sort()).toEqual([newCut.key, newMain.key].sort()),
    );
  });

  it("deleting the post deletes both objects and both upload rows", async () => {
    const main = await upload("video/mp4", MP4, "main.mp4");
    const cut = await upload("video/mp4", MP4, "cut.mp4");
    const created = await publish({
      mediaUploadId: main.uploadId,
      mobileMediaUploadId: cut.uploadId,
    });
    const res = await call(
      owner,
      "DELETE",
      `/api/servers/${serverId}/home/posts/${created.body.post.id}`,
    );
    expect(res.status).toBe(200);
    await settled(async () => {
      expect([...deleted].sort()).toEqual([cut.key, main.key].sort());
      const rows = await getPool().query(
        `SELECT 1 FROM community_home_media_uploads`,
      );
      expect(rows.rowCount).toBe(0);
    });
  });

  it("a storage delete that fails leaves the object to the orphan sweep, and the edit still succeeds", async () => {
    const main = await upload("video/mp4", MP4, "main.mp4");
    const cut = await upload("video/mp4", MP4, "cut.mp4");
    const created = await publish({
      mediaUploadId: main.uploadId,
      mobileMediaUploadId: cut.uploadId,
    });
    failDeletes.add(cut.key);
    const removed = await call<{ post: PostBody }>(
      owner,
      "PATCH",
      `/api/servers/${serverId}/home/posts/${created.body.post.id}`,
      { mobileMediaUploadId: null },
    );
    expect(removed.status).toBe(200);
    expect(removed.body.post.media?.mobile ?? null).toBeNull();
    // The row is the only handle on the object: kept, unclaimed, unverified.
    await settled(async () => {
      const row = await getPool().query<{
        claimed_post_id: string | null;
        verified_at: Date | null;
      }>(
        `SELECT claimed_post_id, verified_at FROM community_home_media_uploads WHERE storage_key = $1`,
        [cut.key],
      );
      expect(row.rows[0]).toEqual({ claimed_post_id: null, verified_at: null });
    });

    // Once storage answers again, the sweep finishes the job.
    failDeletes.clear();
    await getPool().query(
      `UPDATE community_home_media_uploads SET created_at = NOW() - INTERVAL '2 hours' WHERE storage_key = $1`,
      [cut.key],
    );
    expect(await sweepOrphanedCommunityHomeMedia()).toBe(1);
    expect(deleted).toEqual([cut.key]);
  });

  it("a deleted post's files are already the sweep's when the answer comes back", async () => {
    const main = await upload("video/mp4", MP4, "main.mp4");
    const cut = await upload("video/mp4", MP4, "cut.mp4");
    const created = await publish({
      mediaUploadId: main.uploadId,
      mobileMediaUploadId: cut.uploadId,
    });
    // The quick cleanup never finishes, as if the process stopped mid-way.
    hangDeletes.add(main.key);
    hangDeletes.add(cut.key);
    const res = await call(
      owner,
      "DELETE",
      `/api/servers/${serverId}/home/posts/${created.body.post.id}`,
    );
    expect(res.status).toBe(200);
    const rows = await getPool().query<{
      storage_key: string;
      claimed_post_id: string | null;
      verified_at: Date | null;
    }>(
      `SELECT storage_key, claimed_post_id, verified_at
         FROM community_home_media_uploads ORDER BY storage_key`,
    );
    expect(rows.rows).toEqual(
      [main.key, cut.key]
        .sort()
        .map((key) => ({ storage_key: key, claimed_post_id: null, verified_at: null })),
    );
  });

  it("a locked viewer gets no media at all, so no cut either", async () => {
    const main = await upload("video/mp4", MP4, "main.mp4");
    const cut = await upload("video/mp4", MP4, "cut.mp4");
    const created = await publish({
      visibility: "members",
      teaser: "Só pra VIP",
      mediaUploadId: main.uploadId,
      mobileMediaUploadId: cut.uploadId,
    });
    expect(created.status).toBe(201);
    const read = await feed(member);
    expect(read.posts[0]?.locked).toBe(true);
    expect(read.posts[0]?.media).toBeNull();
    expect(JSON.stringify(read)).not.toContain(cut.key);
  });

  it("the database refuses a cut on a post whose main media is not a video", async () => {
    const image = await upload("image/png", PNG, "foto.png");
    const created = await publish({ mediaUploadId: image.uploadId });
    await expect(
      getPool().query(
        `UPDATE community_home_posts SET mobile_media_storage_key = 'x' WHERE id = $1`,
        [created.body.post.id],
      ),
    ).rejects.toThrow(/community_home_posts_mobile_media_check/);
  });
});

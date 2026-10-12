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
 * The cover of a Baú video (`bau_custom_cover`): a picture the author chose,
 * shown before play instead of the video's first frame. A frame they picked in
 * the composer and an image they uploaded arrive the same way, as an image
 * upload through the same mint / PUT / claim as any Baú picture.
 *
 *   * ON BY DEFAULT, OFF MEANS OFF. With nothing set it works; with the flag
 *     off a write that names one is refused and a read leaves
 *     `media.posterUrl` out, even for a post that has one stored.
 *   * ONLY BESIDE A VIDEO, AND ONLY A STILL. An image or a YouTube post cannot
 *     carry one; a GIF, a PDF, a video or the main file itself cannot be one;
 *     a cover bigger than a cover should be is refused.
 *   * ONLY YOUR OWN UPLOAD. Somebody else's upload, or one from another
 *     server, is not found; one that was never claimed is not verified.
 *   * IT GOES WITH ITS VIDEO. Replacing the main video drops the old cover, an
 *     edit can add, replace and remove it, and deleting the post deletes it.
 *   * THE LOCK COVERS IT. It rides inside `media`, which a locked viewer never
 *     gets, and the chat card of a locked post carries none.
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
    deleted.push(key);
    stored.delete(key);
  },
}));

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("../api/index.js");
const { upsertUser } = await import("./users.js");
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

/** Post-commit cleanup runs after the answer; wait for it to settle. */
async function settled(check: () => void | Promise<void>): Promise<void> {
  await vi.waitFor(check, { timeout: 2000, interval: 10 });
}

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48,
  0x44, 0x52,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Buffer.from("RIFF\x10\0\0\0WEBPVP8 ", "latin1");
const GIF = Buffer.from("GIF89a\x01\0\x01\0", "latin1");
const MP4 = Buffer.from("\0\0\0\x18ftypmp42 fake video bytes");

interface PostBody {
  id: string;
  locked: boolean;
  media: {
    kind: string;
    url: string | null;
    posterUrl?: string | null;
  } | null;
}

interface FeedBody {
  posts: PostBody[];
  customCoverEnabled: boolean;
}

describeDb("community home video cover", () => {
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
    process.env.COMMUNITY_HOME_ENABLED = "true";
    process.env.COMMUNITY_HOME_VIP_ENABLED = "true";
    // BAU_CUSTOM_COVER deliberately unset: the flag is on by default.
    delete process.env.BAU_CUSTOM_COVER;
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
    await getPool().query(
      `UPDATE servers SET community_home_enabled = TRUE WHERE id = $1`,
      [serverId],
    );
  });

  afterEach(() => {
    delete process.env.COMMUNITY_HOME_ENABLED;
    delete process.env.COMMUNITY_HOME_VIP_ENABLED;
    delete process.env.BAU_CUSTOM_COVER;
  });

  /** Mint, "PUT" the bytes, and (unless told not to) claim. */
  async function upload(
    contentType: string,
    bytes: Buffer,
    filename: string,
    opts: { as?: { id: string; clerk_id: string }; server?: string; claim?: boolean } = {},
  ): Promise<{ uploadId: string; key: string }> {
    const as = opts.as ?? owner;
    const server = opts.server ?? serverId;
    const minted = await call<{ uploadId: string; key: string }>(
      as,
      "POST",
      `/api/servers/${server}/home/media`,
      { contentType, byteSize: bytes.length, filename },
    );
    expect(minted.status).toBe(201);
    stored.set(minted.body.key, { bytes, contentType });
    if (opts.claim !== false) {
      const claimed = await call(
        as,
        "POST",
        `/api/servers/${server}/home/media/claim`,
        { uploadId: minted.body.uploadId },
      );
      expect(claimed.status).toBe(200);
    }
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

  async function patch(postId: string, body: Record<string, unknown>) {
    return call<{ post: PostBody; error?: string }>(
      owner,
      "PATCH",
      `/api/servers/${serverId}/home/posts/${postId}`,
      body,
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

  it("is on by default: a video published with a cover serves it to readers, the feed and the chat card", async () => {
    const video = await upload("video/mp4", MP4, "launch.mp4");
    const cover = await upload("image/jpeg", JPEG, "capa.jpg");
    const res = await publish({
      mediaUploadId: video.uploadId,
      posterUploadId: cover.uploadId,
    });
    expect(res.status).toBe(201);
    expect(res.body.post.media?.url).toBe(`http://storage.test/get/${video.key}`);
    expect(res.body.post.media?.posterUrl).toBe(`http://storage.test/get/${cover.key}`);

    const read = await feed();
    expect(read.customCoverEnabled).toBe(true);
    expect(read.posts[0]?.media?.posterUrl).toBe(`http://storage.test/get/${cover.key}`);

    const card = await call<{ card: { mediaUrl: string | null; posterUrl: string | null } }>(
      member,
      "GET",
      `/api/servers/${serverId}/home/posts/${res.body.post.id}/card`,
    );
    expect(card.status).toBe(200);
    expect(card.body.card.mediaUrl).toBe(`http://storage.test/get/${video.key}`);
    expect(card.body.card.posterUrl).toBe(`http://storage.test/get/${cover.key}`);

    // Both uploads are claimed onto the post, so the orphan sweep leaves them.
    const rows = await getPool().query<{ claimed_post_id: string | null }>(
      `SELECT claimed_post_id FROM community_home_media_uploads`,
    );
    expect(rows.rows.map((r) => r.claimed_post_id)).toEqual([
      res.body.post.id,
      res.body.post.id,
    ]);
  });

  it("a video with no cover keeps the automatic one (no posterUrl)", async () => {
    const video = await upload("video/mp4", MP4, "launch.mp4");
    const res = await publish({ mediaUploadId: video.uploadId });
    expect(res.status).toBe(201);
    expect(res.body.post.media?.posterUrl ?? null).toBeNull();
  });

  it("takes PNG and WebP as well as JPEG", async () => {
    for (const [type, bytes, name] of [
      ["image/png", PNG, "capa.png"],
      ["image/webp", WEBP, "capa.webp"],
    ] as const) {
      const video = await upload("video/mp4", MP4, "v.mp4");
      const cover = await upload(type, bytes, name);
      const res = await publish({
        mediaUploadId: video.uploadId,
        posterUploadId: cover.uploadId,
      });
      expect(res.status).toBe(201);
      expect(res.body.post.media?.posterUrl).toBe(`http://storage.test/get/${cover.key}`);
    }
  });

  it("with the flag off, refuses the write and hides a stored cover on read", async () => {
    const video = await upload("video/mp4", MP4, "a.mp4");
    const cover = await upload("image/png", PNG, "capa.png");
    const created = await publish({
      mediaUploadId: video.uploadId,
      posterUploadId: cover.uploadId,
    });
    expect(created.status).toBe(201);

    process.env.BAU_CUSTOM_COVER = "false";
    const read = await feed();
    expect(read.customCoverEnabled).toBe(false);
    expect(read.posts[0]?.media?.kind).toBe("video");
    expect(read.posts[0]?.media?.posterUrl ?? null).toBeNull();
    // Kept, not deleted: turning it back on brings the cover back.
    expect(deleted).toEqual([]);

    const another = await upload("video/mp4", MP4, "b.mp4");
    const anotherCover = await upload("image/png", PNG, "capa2.png");
    const refused = await publish({
      mediaUploadId: another.uploadId,
      posterUploadId: anotherCover.uploadId,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/off on this server/i);

    delete process.env.BAU_CUSTOM_COVER;
    const back = await feed();
    expect(back.posts.find((p) => p.id === created.body.post.id)?.media?.posterUrl).toBe(
      `http://storage.test/get/${cover.key}`,
    );
  });

  it("only goes beside an uploaded video, and only a JPEG, PNG or WebP can be one", async () => {
    const cover = await upload("image/png", PNG, "capa.png");
    const image = await upload("image/png", PNG, "foto.png");
    const besideImage = await publish({
      mediaUploadId: image.uploadId,
      posterUploadId: cover.uploadId,
    });
    expect(besideImage.status).toBe(400);
    expect(besideImage.body.error).toMatch(/needs an uploaded video/i);

    const besideYoutube = await publish({
      youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
      posterUploadId: cover.uploadId,
    });
    expect(besideYoutube.status).toBe(400);

    const textOnly = await publish({ body: "só texto", posterUploadId: cover.uploadId });
    expect(textOnly.status).toBe(400);

    const main = await upload("video/mp4", MP4, "main.mp4");
    const gif = await upload("image/gif", GIF, "capa.gif");
    const gifCover = await publish({
      mediaUploadId: main.uploadId,
      posterUploadId: gif.uploadId,
    });
    expect(gifCover.status).toBe(400);
    expect(gifCover.body.error).toMatch(/JPEG, PNG or WebP/);

    const pdf = await upload("application/pdf", Buffer.from("%PDF-1.7\n"), "x.pdf");
    const pdfCover = await publish({
      mediaUploadId: main.uploadId,
      posterUploadId: pdf.uploadId,
    });
    expect(pdfCover.status).toBe(400);

    const otherVideo = await upload("video/mp4", MP4, "other.mp4");
    const videoCover = await publish({
      mediaUploadId: main.uploadId,
      posterUploadId: otherVideo.uploadId,
    });
    expect(videoCover.status).toBe(400);

    const sameFile = await publish({
      mediaUploadId: main.uploadId,
      posterUploadId: main.uploadId,
    });
    expect(sameFile.status).toBe(400);

    // Every refusal rolled back: nothing is on a post.
    const posts = await getPool().query(`SELECT 1 FROM community_home_posts`);
    expect(posts.rowCount).toBe(0);
  });

  it("refuses a cover bigger than a cover should be", async () => {
    const main = await upload("video/mp4", MP4, "main.mp4");
    const big = Buffer.concat([JPEG, Buffer.alloc(10 * 1024 * 1024)]);
    const cover = await upload("image/jpeg", big, "huge.jpg");
    const res = await publish({
      mediaUploadId: main.uploadId,
      posterUploadId: cover.uploadId,
    });
    expect(res.status).toBe(413);
    const posts = await getPool().query(`SELECT 1 FROM community_home_posts`);
    expect(posts.rowCount).toBe(0);
  });

  it("only takes the author's own, verified upload from this server", async () => {
    const main = await upload("video/mp4", MP4, "main.mp4");

    // The member owns a server of their own and uploads a picture there.
    const theirs = await createChatServer("Outro", member.id);
    const foreign = await upload("image/png", PNG, "deles.png", {
      as: member,
      server: theirs.server.id,
    });
    const notMine = await publish({
      mediaUploadId: main.uploadId,
      posterUploadId: foreign.uploadId,
    });
    expect(notMine.status).toBe(404);

    // Minted and PUT, never claimed: the HEAD and byte check never ran.
    const unclaimed = await upload("image/png", PNG, "capa.png", { claim: false });
    const unverified = await publish({
      mediaUploadId: main.uploadId,
      posterUploadId: unclaimed.uploadId,
    });
    expect(unverified.status).toBe(400);

    const posts = await getPool().query(`SELECT 1 FROM community_home_posts`);
    expect(posts.rowCount).toBe(0);
  });

  it("an edit can add, keep, replace and remove the cover; dropped objects are deleted", async () => {
    const main = await upload("video/mp4", MP4, "main.mp4");
    const created = await publish({ mediaUploadId: main.uploadId });
    const postId = created.body.post.id;

    const first = await upload("image/jpeg", JPEG, "capa1.jpg");
    const added = await patch(postId, { posterUploadId: first.uploadId });
    expect(added.status).toBe(200);
    expect(added.body.post.media?.posterUrl).toBe(`http://storage.test/get/${first.key}`);
    expect(added.body.post.media?.url).toBe(`http://storage.test/get/${main.key}`);

    // An edit that does not mention it keeps it.
    const titled = await patch(postId, { title: "Novo título" });
    expect(titled.body.post.media?.posterUrl).toBe(`http://storage.test/get/${first.key}`);

    const second = await upload("image/png", PNG, "capa2.png");
    const replaced = await patch(postId, { posterUploadId: second.uploadId });
    expect(replaced.body.post.media?.posterUrl).toBe(`http://storage.test/get/${second.key}`);
    await settled(() => expect(deleted).toEqual([first.key]));

    const removed = await patch(postId, { posterUploadId: null });
    expect(removed.status).toBe(200);
    expect(removed.body.post.media?.posterUrl ?? null).toBeNull();
    expect(removed.body.post.media?.kind).toBe("video");
    await settled(async () => {
      expect(deleted).toEqual([first.key, second.key]);
      const rows = await getPool().query<{ storage_key: string }>(
        `SELECT storage_key FROM community_home_media_uploads`,
      );
      expect(rows.rows.map((r) => r.storage_key)).toEqual([main.key]);
    });
  });

  it("replacing the main video drops the old cover, unless a new one comes with it", async () => {
    const main = await upload("video/mp4", MP4, "main.mp4");
    const cover = await upload("image/png", PNG, "capa.png");
    const created = await publish({
      mediaUploadId: main.uploadId,
      posterUploadId: cover.uploadId,
    });
    const postId = created.body.post.id;

    const newMain = await upload("video/mp4", MP4, "main-v2.mp4");
    const swapped = await patch(postId, { mediaUploadId: newMain.uploadId });
    expect(swapped.status).toBe(200);
    expect(swapped.body.post.media?.posterUrl ?? null).toBeNull();
    await settled(() =>
      expect([...deleted].sort()).toEqual([cover.key, main.key].sort()),
    );

    deleted.length = 0;
    const third = await upload("video/mp4", MP4, "main-v3.mp4");
    const newCover = await upload("image/webp", WEBP, "capa-v3.webp");
    const both = await patch(postId, {
      mediaUploadId: third.uploadId,
      posterUploadId: newCover.uploadId,
    });
    expect(both.status).toBe(200);
    expect(both.body.post.media?.url).toBe(`http://storage.test/get/${third.key}`);
    expect(both.body.post.media?.posterUrl).toBe(`http://storage.test/get/${newCover.key}`);
    await settled(() => expect(deleted).toEqual([newMain.key]));
  });

  it("deleting the post deletes the cover too", async () => {
    const main = await upload("video/mp4", MP4, "main.mp4");
    const cover = await upload("image/png", PNG, "capa.png");
    const created = await publish({
      mediaUploadId: main.uploadId,
      posterUploadId: cover.uploadId,
    });
    const res = await call(
      owner,
      "DELETE",
      `/api/servers/${serverId}/home/posts/${created.body.post.id}`,
    );
    expect(res.status).toBe(200);
    await settled(async () => {
      expect([...deleted].sort()).toEqual([cover.key, main.key].sort());
      const rows = await getPool().query(
        `SELECT 1 FROM community_home_media_uploads`,
      );
      expect(rows.rowCount).toBe(0);
    });
  });

  it("a locked viewer gets no media, so no cover, in the feed and in the chat card", async () => {
    const main = await upload("video/mp4", MP4, "main.mp4");
    const cover = await upload("image/png", PNG, "capa.png");
    const created = await publish({
      visibility: "members",
      teaser: "Só pra VIP",
      mediaUploadId: main.uploadId,
      posterUploadId: cover.uploadId,
    });
    expect(created.status).toBe(201);
    const read = await feed(member);
    expect(read.posts[0]?.locked).toBe(true);
    expect(read.posts[0]?.media).toBeNull();
    expect(JSON.stringify(read)).not.toContain(cover.key);

    const card = await call<{ card: { posterUrl: string | null; locked: boolean } }>(
      member,
      "GET",
      `/api/servers/${serverId}/home/posts/${created.body.post.id}/card`,
    );
    expect(card.status).toBe(200);
    expect(card.body.card.locked).toBe(true);
    expect(card.body.card.posterUrl).toBeNull();
    expect(JSON.stringify(card.body)).not.toContain(cover.key);
  });

  it("the database refuses a cover on a post whose main media is not a video", async () => {
    const image = await upload("image/png", PNG, "foto.png");
    const created = await publish({ mediaUploadId: image.uploadId });
    await expect(
      getPool().query(
        `UPDATE community_home_posts SET poster_storage_key = 'x' WHERE id = $1`,
        [created.body.post.id],
      ),
    ).rejects.toThrow(/community_home_posts_poster_check/);
  });
});

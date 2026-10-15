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
 * `GET /api/public/communities/:slug/posts/:postId` and its `/cover`, over
 * HTTP against a real Postgres: a Baú post for somebody with no account.
 *
 * Pinned here, and the order is the order of the risk:
 *
 *  - EVERY REFUSAL IS ONE ANSWER. Draft, scheduled, members-only, deleted,
 *    unknown, malformed, another community's post under this slug, a server
 *    with no public address, a suspended one, the Baú switched off for the
 *    server, communities off, the Baú off, `bau_public_posts` off (by
 *    environment AND by a per-server override): status, body and headers are
 *    the unknown post's, byte for byte. A refusal that differed would sort
 *    stranger-guessed ids into "exists" and "VIP".
 *  - NOTHING ABOUT MEMBERS. No author, no comment words, no channel ids, no
 *    user ids anywhere in the answer.
 *  - IT NEEDS NO CREDENTIAL, and a garbage `Authorization` header does not veto
 *    it (pitfall 16's shape).
 *  - `publicUrl` ON THE MEMBERS' OWN PAYLOADS follows the same predicate, so a
 *    Compartilhar button never sits over a page that answers 404.
 *  - THE COVER is a stable address that serves the picture itself (200, a
 *    length, an ETag, ranges, 304, a size cap with the redirect as the
 *    fallback), because a link crawler takes a redirect to another domain for
 *    "no image".
 *  - HEAD IS GET WITHOUT THE BODY on every public community read: the same
 *    status and headers (a crawler probes with HEAD and reads a 401 as "nothing
 *    here"), refusals included.
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

/** The lifetimes asked of every signed GET, to pin the public path's short one. */
const signedTtls: number[] = [];

/**
 * A bucket in memory. What the real one is asked is counted in `storageCalls`
 * (a 304 must cost the bucket nothing), `storageFault` makes every call fail
 * the way an outage does, `storageIgnoresRange` makes it answer a ranged GET
 * with the whole object as a store that does not implement Range would, and
 * `openedStreams` lets a test see whether a body was cancelled.
 */
const store = new Map<string, { bytes: Uint8Array; type: string }>();
const storageCalls = { head: 0, prefix: 0, open: 0 };
const storage = {
  fault: false,
  ignoresRange: false,
  /** Resolves never: a bucket that does not answer (until its request is aborted). */
  hang: false,
  /** Only the ranged read never answers (the HEAD beside it does, or fails). */
  hangPrefix: false,
  /** Calls that were told to stop (their AbortSignal fired). */
  aborted: 0,
  /** A store that ignores Range, then dies partway through the whole body. */
  bodyFails: false,
  /** How long a lookup takes to answer, when it answers. */
  delayMs: 0,
  cancelled: false,
};

/** Waits `storage.delayMs`, and notes (and obeys) a cancellation during it. */
function answerAfterDelay(signal?: AbortSignal): Promise<void> {
  if (!storage.delayMs) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, storage.delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      storage.aborted += 1;
      reject(new Error("aborted"));
    });
  });
}

/** A call that never answers on its own, and notes when it is cancelled. */
function hangUntilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      storage.aborted += 1;
      reject(new Error("aborted"));
    });
  });
}

vi.mock("../lib/s3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/s3.js")>();
  return {
    ...actual,
    isStorageConfigured: () => true,
    presignGet: (key: string, options?: { ttlSeconds?: number }) => {
      signedTtls.push(options?.ttlSeconds ?? -1);
      return `https://storage.test/get/${key}?sig=abc`;
    },
    headObject: async (key: string, signal?: AbortSignal) => {
      storageCalls.head += 1;
      if (storage.hang) {
        return hangUntilAborted(signal);
      }
      await answerAfterDelay(signal);
      if (storage.fault) {
        throw new actual.StorageError("storage is down");
      }
      const object = store.get(key);
      return object
        ? { contentLength: object.bytes.length, contentType: object.type }
        : null;
    },
    getObjectPrefix: async (key: string, length: number, signal?: AbortSignal) => {
      storageCalls.prefix += 1;
      if (storage.hang || storage.hangPrefix) {
        return hangUntilAborted(signal);
      }
      await answerAfterDelay(signal);
      if (storage.fault) {
        throw new actual.StorageError("storage is down");
      }
      return store.get(key)?.bytes.subarray(0, length) ?? null;
    },
    openObject: async (key: string, range?: { start: number; end: number }) => {
      storageCalls.open += 1;
      if (storage.fault) {
        throw new actual.StorageError("storage is down");
      }
      const object = store.get(key);
      if (!object) {
        return null;
      }
      const slice =
        range && !storage.ignoresRange
          ? object.bytes.subarray(range.start, range.end + 1)
          : object.bytes;
      // Pulled in 64 KiB pieces, so a viewer that hangs up mid-body leaves
      // the rest unread and the cancel is observable.
      let at = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (storage.bodyFails) {
            controller.error(new Error("connection reset"));
            return;
          }
          if (at >= slice.length) {
            controller.close();
            return;
          }
          controller.enqueue(slice.subarray(at, at + 65_536));
          at += 65_536;
        },
        cancel() {
          storage.cancelled = true;
        },
      });
      return new Response(body, {
        status: range && !storage.ignoresRange ? 206 : 200,
      });
    },
  };
});

/** A PNG header with the size it claims and `total` bytes in all. */
function pngBytes(width: number, height: number, total = 2048): Uint8Array {
  const bytes = new Uint8Array(total);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  // The rest is distinct per position, so a wrong slice cannot pass for a right one.
  for (let i = 24; i < total; i += 1) {
    bytes[i] = (i * 31) % 251;
  }
  return bytes;
}

/** A JPEG that is a header and a start-of-frame, then filler. */
function jpegBytes(width: number, height: number, total = 1024): Uint8Array {
  const bytes = new Uint8Array(total);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 0);
  bytes.set([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00], 6);
  // SOF0 at offset 20: marker, length 17, precision 8, height, width.
  bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08], 20);
  const view = new DataView(bytes.buffer);
  view.setUint16(25, height);
  view.setUint16(27, width);
  for (let i = 40; i < total; i += 1) {
    bytes[i] = (i * 17) % 249;
  }
  return bytes;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("./index.js");
const { upsertUser } = await import("../services/users.js");
const { createServer: createChatServer, createChannel } = await import("../services/servers.js");
const flags = await import("../lib/flags.js");
const { getBauPublicUrl } = await import("../services/community-home-public.js");
const { resetCoverInfoCache, coverProbesInFlight } = await import(
  "../services/community-home-cover-info.js"
);
const {
  publicBauPostResponseSchema,
  parseBauPublicPostPath,
  bauShareUrl,
  BAU_PUBLIC_REDACTED_CHANNEL_ID,
  BAU_PUBLIC_MEDIA_TTL_SECONDS,
} = await import("@pqp/shared");

let httpServer: Server;
let baseUrl: string;

type Person = { id: string; clerk_id: string };

const ENV_KEYS = [
  "COMMUNITIES_ENABLED",
  "COMMUNITY_HOME_ENABLED",
  "COMMUNITY_HOME_VIP_ENABLED",
  "BAU_PUBLIC_POSTS",
  "PUBLIC_APP_URL",
] as const;

interface Wire {
  status: number;
  /** Everything an observer could compare between two refusals. */
  signature: string;
  headers: Headers;
  text: string;
  body: Record<string, unknown> | null;
  location: string | null;
}

const CACHE_HIT = "public, max-age=0, s-maxage=60, stale-while-revalidate=60";
const CACHE_MISS = "public, max-age=0, s-maxage=60";

async function get(path: string, headers: Record<string, string> = {}): Promise<Wire> {
  actor = null;
  const response = await fetch(`${baseUrl}${path}`, { headers, redirect: "manual" });
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  const signature = JSON.stringify([
    response.status,
    text,
    response.headers.get("content-type"),
    response.headers.get("cache-control"),
    response.headers.get("vary"),
    response.headers.get("access-control-allow-origin"),
  ]);
  return {
    status: response.status,
    signature,
    headers: response.headers,
    text,
    body,
    location: response.headers.get("location"),
  };
}

const COVER_CACHE = "public, max-age=3600, s-maxage=3600";

interface RawWire {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

/** Any method, the body as bytes, no redirect followed, no credential. */
async function rawGet(
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<RawWire> {
  actor = null;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    redirect: "manual",
  });
  return {
    status: response.status,
    headers: response.headers,
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

/** The headers a HEAD must share with its GET (the date is the only one that may differ). */
const SAME_ON_HEAD = [
  "content-type",
  "content-length",
  "cache-control",
  "etag",
  "accept-ranges",
  "content-range",
  "location",
  "vary",
  "access-control-allow-origin",
  "x-content-type-options",
  "cross-origin-resource-policy",
] as const;

async function expectHeadMatchesGet(
  path: string,
  extra: Record<string, string> = {},
): Promise<RawWire> {
  const got = await rawGet(path, extra, "GET");
  const head = await rawGet(path, extra, "HEAD");
  expect(head.status).toBe(got.status);
  for (const name of SAME_ON_HEAD) {
    expect(head.headers.get(name), `${name} of HEAD ${path}`).toBe(got.headers.get(name));
  }
  expect(head.bytes.length).toBe(0);
  return got;
}

async function asMember<T = Record<string, unknown>>(
  as: Person,
  path: string,
): Promise<{ status: number; body: T }> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: "Bearer test" },
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

describeDb("public Baú post", () => {
  let owner: Person;
  let member: Person;
  let serverId: string;
  const SLUG = "mesa-da-tues";
  const CHANNEL_ID = "5b0f3e2a-6c1d-4a3e-8d57-0a1b2c3d4e5f";

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
    flags.resetFeatureFlagsForTests();
    signedTtls.length = 0;
    resetCoverInfoCache();
    store.clear();
    storageCalls.head = 0;
    storageCalls.prefix = 0;
    storageCalls.open = 0;
    storage.fault = false;
    storage.ignoresRange = false;
    storage.hang = false;
    storage.hangPrefix = false;
    storage.aborted = 0;
    storage.delayMs = 0;
    storage.bodyFails = false;
    storage.cancelled = false;
    process.env.COMMUNITIES_ENABLED = "true";
    process.env.COMMUNITY_HOME_ENABLED = "true";
    process.env.COMMUNITY_HOME_VIP_ENABLED = "true";
    process.env.BAU_PUBLIC_POSTS = "true";
    delete process.env.PUBLIC_APP_URL;

    const makeUser = (name: string) =>
      upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null });
    owner = await makeUser("Dona Fulana");
    member = await makeUser("Membro Beltrano");

    const created = await createChatServer("Mesa da Tues", owner.id);
    serverId = created.server.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [serverId, member.id],
    );
    await getPool().query(
      `UPDATE servers
          SET community_home_enabled = TRUE,
              is_community = TRUE,
              community_slug = $2,
              community_tagline = 'A mesa de quem joga'
        WHERE id = $1`,
      [serverId, SLUG],
    );
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    flags.resetFeatureFlagsForTests();
  });

  interface Seed {
    title?: string | null;
    body?: string;
    teaser?: string | null;
    visibility?: "free" | "members";
    status?: "published" | "draft" | "scheduled";
    mediaKind?: "image" | "video" | "youtube" | "file" | null;
    storageKey?: string | null;
    posterKey?: string | null;
    youtubeUrl?: string | null;
    server?: string;
  }

  async function seed(post: Seed = {}): Promise<string> {
    const status = post.status ?? "published";
    const result = await getPool().query<{ id: string }>(
      `INSERT INTO community_home_posts
         (server_id, author_id, title, body, teaser, visibility, status,
          media_kind, media_name, media_content_type, media_byte_size,
          media_storage_key, media_youtube_url, poster_storage_key,
          published_at, scheduled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, $16)
       RETURNING id`,
      [
        post.server ?? serverId,
        owner.id,
        post.title === undefined ? "Patch novo" : post.title,
        post.body ?? "Tem coisa nova",
        post.teaser ?? null,
        post.visibility ?? "free",
        status,
        post.mediaKind ?? null,
        post.mediaKind ? "arquivo" : null,
        post.mediaKind === "image"
          ? "image/png"
          : post.mediaKind === "video"
            ? "video/mp4"
            : null,
        post.mediaKind === "image" || post.mediaKind === "video" ? 1234 : null,
        post.storageKey ?? null,
        post.youtubeUrl ?? null,
        post.posterKey ?? null,
        status === "published" ? new Date() : null,
        status === "scheduled" ? new Date(Date.now() + 3_600_000) : null,
      ],
    );
    return result.rows[0]!.id;
  }

  async function createChatServerChannel(name: string, isPrivate: boolean): Promise<string> {
    const channel = await createChannel(serverId, name, "text", isPrivate);
    return channel.id;
  }

  const url = (postId: string, slug = SLUG) =>
    `/api/public/communities/${slug}/posts/${postId}`;

  const UNKNOWN_ID = "11111111-2222-4333-8444-555555555555";

  it("serves a free published post to somebody with no account, and nothing about members", async () => {
    const id = await seed({
      title: "Patch 1.2",
      body: `Olha o canal <#${CHANNEL_ID}> e o resto.`,
    });
    // A member's comment and like exist and must not travel.
    const comment = await getPool().query(
      `INSERT INTO community_home_comments (post_id, author_id, body)
       VALUES ($1, $2, 'palavras do membro') RETURNING id`,
      [id, member.id],
    );
    expect(comment.rowCount).toBe(1);
    await getPool().query(
      `INSERT INTO community_home_likes (post_id, user_id) VALUES ($1, $2)`,
      [id, member.id],
    );

    const res = await get(url(id));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(CACHE_HIT);
    expect(res.headers.get("set-cookie")).toBeNull();

    const parsed = publicBauPostResponseSchema.parse(res.body);
    expect(parsed.post).toMatchObject({
      id,
      title: "Patch 1.2",
      likeCount: 1,
      commentCount: 1,
      media: null,
      coverUrl: null,
    });
    expect(parsed.post.publishedAt).not.toBeNull();
    expect(parsed.community).toMatchObject({
      slug: SLUG,
      name: "Mesa da Tues",
      tagline: "A mesa de quem joga",
    });
    expect(Object.keys(res.body!.post as object).sort()).toEqual([
      "body",
      "channels",
      "commentCount",
      "coverBytes",
      "coverHeight",
      "coverType",
      "coverUrl",
      "coverWidth",
      "id",
      "likeCount",
      "media",
      "posterUrl",
      "publicUrl",
      "publishedAt",
      "teaser",
      "title",
    ]);
    expect(parsed.post.publicUrl).toBe(`https://pqp.gg/c/${SLUG}/p/${id}`);
    expect(parsed.post.channels).toEqual([]);

    // The channel reference is redacted to one that resolves to nothing.
    expect(parsed.post.body).toBe(
      `Olha o canal <#${BAU_PUBLIC_REDACTED_CHANNEL_ID}> e o resto.`,
    );
    expect(res.text).not.toContain(CHANNEL_ID);
    // Nobody: not the author, not the commenter, not an id of either.
    for (const secret of [
      "Dona Fulana",
      "Membro Beltrano",
      "palavras do membro",
      owner.id,
      member.id,
      serverId,
    ]) {
      expect(res.text).not.toContain(secret);
    }
  });

  it("never lets a channel id through the teaser, the title or a hand-written teaser", async () => {
    const fromBody = await seed({
      title: `Regras em <#${CHANNEL_ID}>`,
      body: `Leia <#${CHANNEL_ID}> antes de entrar.`,
    });
    const handWritten = await seed({
      body: "corpo",
      teaser: `Vem <#${CHANNEL_ID}>`,
    });
    for (const id of [fromBody, handWritten]) {
      const res = await get(url(id));
      expect(res.status).toBe(200);
      expect(res.text.toLowerCase()).not.toContain(CHANNEL_ID);
    }
    const parsed = publicBauPostResponseSchema.parse((await get(url(fromBody))).body);
    expect(parsed.post.teaser).toBe("Leia um canal antes de entrar.");
  });

  it("needs no credential, and a garbage Authorization header does not veto it", async () => {
    const id = await seed();
    const bare = await get(url(id));
    const withGarbage = await get(url(id), { Authorization: "Bearer expired.jwt.token" });
    expect(bare.status).toBe(200);
    expect(withGarbage.status).toBe(200);
    expect(withGarbage.body).toEqual(bare.body);
  });

  it("answers for any case of the slug and the id", async () => {
    const id = await seed();
    const res = await get(url(id.toUpperCase(), SLUG.toUpperCase()));
    expect(res.status).toBe(200);
  });

  it("an unlisted community with an address still has public posts", async () => {
    await getPool().query(
      `UPDATE servers SET is_community_listed = FALSE WHERE id = $1`,
      [serverId],
    );
    const id = await seed();
    expect((await get(url(id))).status).toBe(200);
  });

  it("carries the media the feed draws: an uploaded image is a signed GET, with a stable cover", async () => {
    const key = `community-home/${serverId}/imagem.png`;
    const png = pngBytes(1200, 630);
    store.set(key, { bytes: png, type: "image/png" });
    const id = await seed({
      mediaKind: "image",
      storageKey: key,
    });
    const res = await get(url(id));
    expect(res.status).toBe(200);
    const parsed = publicBauPostResponseSchema.parse(res.body);
    expect(parsed.post.media).toMatchObject({
      kind: "image",
      contentType: "image/png",
      url: `https://storage.test/get/community-home/${serverId}/imagem.png?sig=abc`,
    });
    expect(parsed.post.coverUrl).toBe(`/api/public/communities/${SLUG}/posts/${id}/cover`);
    // What the share card is told about the picture, read from its own bytes.
    expect(parsed.post).toMatchObject({
      coverType: "image/png",
      coverWidth: 1200,
      coverHeight: 630,
      coverBytes: png.length,
    });

    // The picture itself, not a redirect to another domain.
    const cover = await rawGet(`${url(id)}/cover`);
    expect(cover.status).toBe(200);
    expect(cover.headers.get("location")).toBeNull();
    expect(cover.headers.get("content-type")).toBe("image/png");
    expect(cover.headers.get("content-length")).toBe(String(png.length));
    expect(cover.headers.get("cache-control")).toBe(COVER_CACHE);
    expect(Buffer.from(cover.bytes).equals(Buffer.from(png))).toBe(true);
  });

  it("a video's cover is its chosen picture; with none there is no cover", async () => {
    const jpeg = jpegBytes(1280, 720);
    store.set(`community-home/${serverId}/p.jpg`, { bytes: jpeg, type: "image/jpeg" });
    const withCover = await seed({
      mediaKind: "video",
      storageKey: `community-home/${serverId}/v.mp4`,
      posterKey: `community-home/${serverId}/p.jpg`,
    });
    const without = await seed({
      mediaKind: "video",
      storageKey: `community-home/${serverId}/w.mp4`,
    });

    const a = publicBauPostResponseSchema.parse((await get(url(withCover))).body);
    expect(a.post.coverUrl).toBe(
      `/api/public/communities/${SLUG}/posts/${withCover}/cover`,
    );
    expect(a.post).toMatchObject({
      coverType: "image/jpeg",
      coverWidth: 1280,
      coverHeight: 720,
      coverBytes: jpeg.length,
    });
    const cover = await rawGet(`${url(withCover)}/cover`);
    expect(cover.status).toBe(200);
    expect(cover.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(cover.bytes).equals(Buffer.from(jpeg))).toBe(true);

    const b = publicBauPostResponseSchema.parse((await get(url(without))).body);
    expect(b.post.coverUrl).toBeNull();
    expect(b.post.coverWidth).toBeNull();
    expect((await get(`${url(without)}/cover`)).status).toBe(404);
  });

  it("a YouTube post carries the public poster as its stable cover", async () => {
    const id = await seed({
      mediaKind: "youtube",
      youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    const parsed = publicBauPostResponseSchema.parse((await get(url(id))).body);
    expect(parsed.post.media).toMatchObject({
      kind: "youtube",
      youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(parsed.post.posterUrl).toMatch(/^https:\/\/i\.ytimg\.com\//);
    expect(parsed.post.coverUrl).toBe(parsed.post.posterUrl);
    // Not ours, so nothing is claimed about it.
    expect(parsed.post).toMatchObject({
      coverType: null,
      coverWidth: null,
      coverHeight: null,
      coverBytes: null,
    });
    // Nothing of ours to serve.
    expect((await get(`${url(id)}/cover`)).status).toBe(404);
  });

  describe("the cover is a file a crawler can validate", () => {
    const COVER_BYTES = pngBytes(1200, 630, 5000);
    let coverPath: string;
    let etag: string;

    beforeEach(async () => {
      const key = `community-home/${serverId}/capa.png`;
      store.set(key, { bytes: COVER_BYTES, type: "image/png" });
      const id = await seed({ mediaKind: "image", storageKey: key });
      coverPath = `${url(id)}/cover`;
      etag = (await rawGet(coverPath)).headers.get("etag")!;
    });

    it("answers HEAD like GET without the body: type, length, validator, ranges", async () => {
      const got = await expectHeadMatchesGet(coverPath);
      expect(got.status).toBe(200);
      expect(got.headers.get("content-type")).toBe("image/png");
      expect(got.headers.get("content-length")).toBe("5000");
      expect(got.headers.get("accept-ranges")).toBe("bytes");
      expect(got.headers.get("cache-control")).toBe(COVER_CACHE);
      expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
      // No Authorization, and none needed: this is what X sends.
      expect((await rawGet(coverPath, {}, "HEAD")).status).toBe(200);
    });

    it("HEAD costs the bucket one HEAD and never a body read", async () => {
      storageCalls.open = 0;
      await rawGet(coverPath, {}, "HEAD");
      expect(storageCalls.open).toBe(0);
    });

    it("serves a byte range as 206 with the right slice and Content-Range", async () => {
      const first = await rawGet(coverPath, { Range: "bytes=0-99" });
      expect(first.status).toBe(206);
      expect(first.headers.get("content-range")).toBe("bytes 0-99/5000");
      expect(first.headers.get("content-length")).toBe("100");
      expect(first.headers.get("content-type")).toBe("image/png");
      expect(first.headers.get("etag")).toBe(etag);
      expect(Buffer.from(first.bytes).equals(Buffer.from(COVER_BYTES.subarray(0, 100)))).toBe(true);

      const middle = await rawGet(coverPath, { Range: "bytes=1000-1999" });
      expect(Buffer.from(middle.bytes).equals(Buffer.from(COVER_BYTES.subarray(1000, 2000)))).toBe(true);

      const open = await rawGet(coverPath, { Range: "bytes=4900-" });
      expect(open.status).toBe(206);
      expect(open.headers.get("content-range")).toBe("bytes 4900-4999/5000");
      expect(open.bytes.length).toBe(100);

      const suffix = await rawGet(coverPath, { Range: "bytes=-50" });
      expect(suffix.status).toBe(206);
      expect(suffix.headers.get("content-range")).toBe("bytes 4950-4999/5000");
      expect(Buffer.from(suffix.bytes).equals(Buffer.from(COVER_BYTES.subarray(4950)))).toBe(true);

      // An end past the object is clamped, as the RFC says.
      const clamped = await rawGet(coverPath, { Range: "bytes=4990-99999" });
      expect(clamped.headers.get("content-range")).toBe("bytes 4990-4999/5000");

      // A HEAD with a Range is the 206's headers and no body.
      const head = await rawGet(coverPath, { Range: "bytes=0-99" }, "HEAD");
      expect(head.status).toBe(206);
      expect(head.headers.get("content-length")).toBe("100");
      expect(head.bytes.length).toBe(0);
    });

    it("a store that ignores Range still gets the client exactly the bytes it asked for", async () => {
      storage.ignoresRange = true;
      const res = await rawGet(coverPath, { Range: "bytes=10-19" });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-length")).toBe("10");
      expect(Buffer.from(res.bytes).equals(Buffer.from(COVER_BYTES.subarray(10, 20)))).toBe(true);
    });

    it("416s a range that starts past the end; ignores one it cannot read", async () => {
      const past = await rawGet(coverPath, { Range: "bytes=5000-" });
      expect(past.status).toBe(416);
      expect(past.headers.get("content-range")).toBe("bytes */5000");

      for (const odd of ["bytes=0-9,20-29", "items=0-9", "bytes=9-2", "bytes=abc", "bytes=-"]) {
        const res = await rawGet(coverPath, { Range: odd });
        expect(res.status, odd).toBe(200);
        expect(res.bytes.length, odd).toBe(5000);
      }
    });

    it("If-Range honours the range only for the version the client holds", async () => {
      const same = await rawGet(coverPath, { Range: "bytes=0-9", "If-Range": etag });
      expect(same.status).toBe(206);
      const other = await rawGet(coverPath, { Range: "bytes=0-9", "If-Range": '"someone-else"' });
      expect(other.status).toBe(200);
      expect(other.bytes.length).toBe(5000);
    });

    it("answers a conditional GET with a 304 that needs no storage at all", async () => {
      resetCoverInfoCache();
      storageCalls.head = 0;
      storageCalls.prefix = 0;
      storageCalls.open = 0;
      for (const header of [etag, `W/${etag}`, `"nope", ${etag}`, "*"]) {
        const res = await rawGet(coverPath, { "If-None-Match": header });
        expect(res.status, header).toBe(304);
        expect(res.bytes.length).toBe(0);
        expect(res.headers.get("etag")).toBe(etag);
        expect(res.headers.get("cache-control")).toBe(COVER_CACHE);
      }
      expect(storageCalls).toEqual({ head: 0, prefix: 0, open: 0 });

      const stale = await rawGet(coverPath, { "If-None-Match": '"not-this-one"' });
      expect(stale.status).toBe(200);
      expect(stale.bytes.length).toBe(5000);
    });

    it("never answers 304 for a post that stopped being public", async () => {
      await getPool().query(
        `UPDATE community_home_posts SET visibility = 'members'`,
      );
      const want = await rawGet(url(UNKNOWN_ID));
      for (const method of ["GET", "HEAD"]) {
        const res = await rawGet(coverPath, { "If-None-Match": etag }, method);
        expect(res.status).toBe(404);
        expect(res.headers.get("cache-control")).toBe(CACHE_MISS);
        expect(res.headers.get("content-length")).toBe(want.headers.get("content-length"));
      }
    });

    it("asks the bucket once for a cover however many people open the link", async () => {
      resetCoverInfoCache();
      storageCalls.head = 0;
      storageCalls.prefix = 0;
      await Promise.all(Array.from({ length: 8 }, () => rawGet(coverPath, {}, "HEAD")));
      await rawGet(coverPath);
      expect(storageCalls.head).toBe(1);
      expect(storageCalls.prefix).toBe(1);
    });

    it("keeps the 5 MB line: the cap itself is served, one byte over is the old redirect", async () => {
      const MAX = 5 * 1024 * 1024;
      const at = `community-home/${serverId}/no-limite.png`;
      const over = `community-home/${serverId}/passou.png`;
      store.set(at, { bytes: pngBytes(4000, 2000, MAX), type: "image/png" });
      store.set(over, { bytes: pngBytes(4000, 2000, MAX + 1), type: "image/png" });
      const atId = await seed({ mediaKind: "image", storageKey: at });
      const overId = await seed({ mediaKind: "image", storageKey: over });

      const served = await rawGet(`${url(atId)}/cover`);
      expect(served.status).toBe(200);
      expect(served.bytes.length).toBe(MAX);

      for (const method of ["GET", "HEAD"]) {
        const redirected = await rawGet(`${url(overId)}/cover`, {}, method);
        expect(redirected.status, method).toBe(302);
        expect(redirected.headers.get("location")).toBe(
          `https://storage.test/get/${over}?sig=abc`,
        );
        expect(redirected.headers.get("cache-control")).toBe(CACHE_MISS);
      }
      // The page tells the card how big it is, so the edge can pass over it.
      const parsed = publicBauPostResponseSchema.parse((await get(url(overId))).body);
      expect(parsed.post.coverBytes).toBe(MAX + 1);
    });

    it("never serves bytes of a type a browser would render as a document", async () => {
      for (const [name, type] of [
        ["x.svg", "image/svg+xml"],
        ["x.html", "text/html"],
        ["x.bin", "application/octet-stream"],
      ] as const) {
        const key = `community-home/${serverId}/${name}`;
        store.set(key, { bytes: new TextEncoder().encode("<svg onload=alert(1)/>"), type });
        const id = await seed({ mediaKind: "image", storageKey: key });
        const res = await rawGet(`${url(id)}/cover`);
        expect(res.status, type).toBe(302);
        expect(res.headers.get("location")).toBe(`https://storage.test/get/${key}?sig=abc`);
      }
    });

    it("says 503 when the bucket is down and 404 when the object is gone, never a redirect", async () => {
      resetCoverInfoCache();
      storage.fault = true;
      expect((await rawGet(coverPath)).status).toBe(503);
      expect((await rawGet(coverPath, {}, "HEAD")).status).toBe(503);
      storage.fault = false;

      store.clear();
      resetCoverInfoCache();
      const gone = await rawGet(coverPath);
      expect(gone.status).toBe(404);
      expect(gone.headers.get("cache-control")).toBe(CACHE_MISS);
    });

    it("says what the bytes are when the stored type disagrees: the header wins, in the file and on the card", async () => {
      // Stored as a jpeg, but the bytes are a png.
      const key = `community-home/${serverId}/mentiu.jpg`;
      store.set(key, { bytes: pngBytes(1200, 630), type: "image/jpeg" });
      const id = await seed({ mediaKind: "image", storageKey: key });
      const cover = await rawGet(`${url(id)}/cover`);
      expect(cover.status).toBe(200);
      expect(cover.headers.get("content-type")).toBe("image/png");
      const parsed = publicBauPostResponseSchema.parse((await get(url(id))).body);
      expect(parsed.post.coverType).toBe("image/png");
      expect(cover.headers.get("content-type")).toBe(parsed.post.coverType);
    });

    it("answers a controlled 503, not a crash, when a store that ignores Range dies mid-body", async () => {
      storage.ignoresRange = true;
      storage.bodyFails = true;
      const res = await rawGet(coverPath, { Range: "bytes=10-19" });
      expect(res.status).toBe(503);
      expect(res.headers.get("content-type")).toBe("application/json");
    });

    it("stops reading the bucket when the viewer hangs up mid-image", async () => {
      const key = `community-home/${serverId}/grande.png`;
      store.set(key, { bytes: pngBytes(4000, 2000, 4 * 1024 * 1024), type: "image/png" });
      const id = await seed({ mediaKind: "image", storageKey: key });
      const controller = new AbortController();
      actor = null;
      const response = await fetch(`${baseUrl}${url(id)}/cover`, { signal: controller.signal });
      const reader = response.body!.getReader();
      await reader.read();
      controller.abort();
      await reader.cancel().catch(() => undefined);
      for (let i = 0; i < 50 && !storage.cancelled; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(storage.cancelled).toBe(true);
    });
  });

  describe("the page tells the card about its picture, and never waits on the bucket for it", () => {
    it("fails open: a bucket that is down or silent costs the page nothing but the hints", async () => {
      const key = `community-home/${serverId}/capa.png`;
      store.set(key, { bytes: pngBytes(1200, 630), type: "image/png" });
      const id = await seed({ mediaKind: "image", storageKey: key });

      storage.fault = true;
      const down = await get(url(id));
      expect(down.status).toBe(200);
      const downParsed = publicBauPostResponseSchema.parse(down.body);
      expect(downParsed.post.coverUrl).toBe(`/api/public/communities/${SLUG}/posts/${id}/cover`);
      expect(downParsed.post).toMatchObject({
        coverType: null,
        coverWidth: null,
        coverHeight: null,
        coverBytes: null,
      });

      storage.fault = false;
      storage.hang = true;
      const startedAt = Date.now();
      const silent = await get(url(id));
      expect(silent.status).toBe(200);
      expect(Date.now() - startedAt).toBeLessThan(4000);
    });

    it("cancels the bucket requests when the page stops waiting, and does not start more than it can afford", async () => {
      storage.hang = true;
      const ids: string[] = [];
      for (let i = 0; i < 24; i += 1) {
        const key = `community-home/${serverId}/lenta-${i}.png`;
        store.set(key, { bytes: pngBytes(1200, 630), type: "image/png" });
        ids.push(await seed({ mediaKind: "image", storageKey: key }));
      }
      const pages = await Promise.all(ids.map((id) => get(url(id))));
      for (const page of pages) {
        expect(page.status).toBe(200);
      }
      // A cap on probes started by the page: 24 distinct cold covers, a bucket that
      // answers nothing, and never more than 16 of them were asked.
      expect(storageCalls.head).toBeLessThanOrEqual(16);
      expect(storageCalls.head).toBeGreaterThan(0);
      // Every one of those was told to stop when the page gave up on it.
      for (let i = 0; i < 50 && coverProbesInFlight() > 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(coverProbesInFlight()).toBe(0);
      expect(storage.aborted).toBeGreaterThanOrEqual(storageCalls.head);
    });

    it("a HEAD that fails takes the ranged read beside it down, instead of leaving it holding a connection", async () => {
      const key = `community-home/${serverId}/falha.png`;
      store.set(key, { bytes: pngBytes(1200, 630), type: "image/png" });
      const id = await seed({ mediaKind: "image", storageKey: key });
      storage.fault = true;
      storage.hangPrefix = true;
      const page = await get(url(id));
      expect(page.status).toBe(200);
      expect(publicBauPostResponseSchema.parse(page.body).post.coverWidth).toBeNull();
      for (let i = 0; i < 50 && storage.aborted === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(storage.aborted).toBe(1);
      expect(coverProbesInFlight()).toBe(0);
    });

    it("does not abort a lookup the cover route is still waiting on when the page gives up", async () => {
      const key = `community-home/${serverId}/espera.png`;
      store.set(key, { bytes: pngBytes(1200, 630, 3000), type: "image/png" });
      const id = await seed({ mediaKind: "image", storageKey: key });
      // A bucket slower than the page's budget and well inside the probe's own.
      storage.delayMs = 1500;
      // The cover route joins first and waits; the page then peeks at the same
      // lookup, gives up, and must leave it running for the route.
      const cover = rawGet(`${url(id)}/cover`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const page = await get(url(id));
      expect(page.status).toBe(200);
      expect(publicBauPostResponseSchema.parse(page.body).post.coverWidth).toBeNull();
      const done = await cover;
      expect(done.status).toBe(200);
      expect(done.bytes.length).toBe(3000);
      expect(storage.aborted).toBe(0);
    });

    it("a picture whose header cannot be read is still served, with bytes but no size", async () => {
      const key = `community-home/${serverId}/estranha.png`;
      store.set(key, { bytes: new Uint8Array(500).fill(7), type: "image/png" });
      const id = await seed({ mediaKind: "image", storageKey: key });
      const parsed = publicBauPostResponseSchema.parse((await get(url(id))).body);
      expect(parsed.post).toMatchObject({
        coverType: null,
        coverWidth: null,
        coverHeight: null,
        coverBytes: 500,
      });
      expect((await rawGet(`${url(id)}/cover`)).status).toBe(200);
    });
  });

  describe("HEAD is GET without the body on every public community read", () => {
    it("the community poster, its config and the post, found or refused", async () => {
      const id = await seed({ title: "Patch 1.2" });
      for (const path of [
        `/api/public/communities/${SLUG}`,
        `/api/public/communities/nao-existe-aqui`,
        `/api/public/communities/config`,
        url(id),
        url(UNKNOWN_ID),
        `${url(id)}/cover`,
      ]) {
        const got = await expectHeadMatchesGet(path);
        expect(got.status, path).not.toBe(401);
        expect(Number(got.headers.get("content-length")), path).toBeGreaterThan(0);
      }
      const found = await rawGet(url(id), {}, "HEAD");
      expect(found.status).toBe(200);
      expect(found.headers.get("content-type")).toBe("application/json");
      expect(found.headers.get("cache-control")).toBe(CACHE_HIT);
    });

    it("a garbage Authorization header does not turn a HEAD into a 401", async () => {
      const id = await seed();
      const res = await rawGet(url(id), { Authorization: "Bearer expired.jwt.token" }, "HEAD");
      expect(res.status).toBe(200);
    });

    it("answers a preflight on each of them", async () => {
      const id = await seed();
      for (const path of [`/api/public/communities/${SLUG}`, url(id), `${url(id)}/cover`]) {
        const res = await rawGet(path, { Origin: "https://pqp.gg" }, "OPTIONS");
        expect(res.status, path).toBe(204);
        expect(res.headers.get("access-control-allow-origin"), path).toBeTruthy();
      }
    });

    it("refuses what GET refuses, with the same flag semantics (communities off, bau_public_posts off)", async () => {
      const id = await seed({ mediaKind: "image", storageKey: `community-home/${serverId}/a.png` });
      store.set(`community-home/${serverId}/a.png`, { bytes: pngBytes(800, 400), type: "image/png" });
      expect((await rawGet(`${url(id)}/cover`, {}, "HEAD")).status).toBe(200);

      process.env.BAU_PUBLIC_POSTS = "false";
      flags.resetFeatureFlagsForTests();
      const want = await rawGet(url(UNKNOWN_ID));
      for (const path of [url(id), `${url(id)}/cover`]) {
        const head = await rawGet(path, {}, "HEAD");
        expect(head.status, path).toBe(404);
        expect(head.headers.get("content-length")).toBe(want.headers.get("content-length"));
        expect(head.headers.get("cache-control")).toBe(CACHE_MISS);
      }
      // And the byte-for-byte rule holds with the bucket never touched.
      storageCalls.open = 0;
      await rawGet(`${url(id)}/cover`);
      expect(storageCalls.open).toBe(0);

      process.env.BAU_PUBLIC_POSTS = "true";
      flags.resetFeatureFlagsForTests();
      process.env.COMMUNITIES_ENABLED = "false";
      expect((await rawGet(url(id), {}, "HEAD")).status).toBe(404);
      expect((await rawGet(`/api/public/communities/${SLUG}`, {}, "HEAD")).status).toBe(404);
    });

    it("still refuses what is not a read: a POST or a DELETE is not answered as one", async () => {
      const id = await seed();
      for (const method of ["POST", "PUT", "DELETE"]) {
        const res = await rawGet(url(id), {}, method);
        expect(res.status, method).toBe(401);
      }
    });
  });

  describe("every refusal is one answer", () => {
    /** The unknown post's own 404: what every case below must equal. */
    async function baseline(): Promise<Wire> {
      const res = await get(url(UNKNOWN_ID));
      expect(res.status).toBe(404);
      // Cacheable for the same short time as a hit, and the same on every
      // refusal: a flood of guessed ids lands on the edge, and no refusal can
      // be told from another by how it is cached.
      expect(res.headers.get("cache-control")).toBe(CACHE_MISS);
      expect(res.body).toEqual({ error: "Not found" });
      return res;
    }

    async function expectRefused(path: string): Promise<void> {
      const want = await baseline();
      const got = await get(path);
      expect(got.signature).toBe(want.signature);
      // And so does its cover.
      const cover = await get(`${path}/cover`);
      expect(cover.status).toBe(404);
      expect(cover.signature).toBe(want.signature);
      // And a HEAD of either is that same refusal, header for header, so a
      // crawler's probe cannot tell the kinds apart either.
      for (const probe of [path, `${path}/cover`]) {
        const head = await rawGet(probe, {}, "HEAD");
        expect(head.status, probe).toBe(404);
        for (const name of SAME_ON_HEAD) {
          expect(head.headers.get(name), `${name} of HEAD ${probe}`).toBe(
            (await rawGet(url(UNKNOWN_ID))).headers.get(name),
          );
        }
      }
    }

    it("a draft", async () => {
      await expectRefused(url(await seed({ status: "draft" })));
    });

    it("a scheduled post", async () => {
      await expectRefused(url(await seed({ status: "scheduled" })));
    });

    it("a members-only post, with the VIP flag on or off", async () => {
      const id = await seed({ visibility: "members", mediaKind: "image", storageKey: "k/x.png" });
      await expectRefused(url(id));
      delete process.env.COMMUNITY_HOME_VIP_ENABLED;
      await expectRefused(url(id));
    });

    it("an unpublished post", async () => {
      const id = await seed();
      expect((await get(url(id))).status).toBe(200);
      await getPool().query(
        `UPDATE community_home_posts SET status = 'draft', published_at = NULL WHERE id = $1`,
        [id],
      );
      await expectRefused(url(id));
    });

    it("a deleted post", async () => {
      const id = await seed();
      await getPool().query(`DELETE FROM community_home_posts WHERE id = $1`, [id]);
      await expectRefused(url(id));
    });

    it("a malformed id and a malformed slug", async () => {
      await expectRefused(url("not-a-uuid"));
      await expectRefused(url(`${UNKNOWN_ID}x`));
      const id = await seed();
      await expectRefused(url(id, "-"));
      await expectRefused(url(id, "a"));
      await expectRefused(url(id, "%E0%A4%A"));
    });

    it("a post of another community under this slug", async () => {
      const other = await createChatServer("Outra Mesa", owner.id);
      await getPool().query(
        `UPDATE servers SET community_home_enabled = TRUE, is_community = TRUE,
                community_slug = 'outra-mesa' WHERE id = $1`,
        [other.server.id],
      );
      const id = await seed({ server: other.server.id });
      expect((await get(url(id, "outra-mesa"))).status).toBe(200);
      await expectRefused(url(id, SLUG));
    });

    it("a server with no public address, even if its slug is still set", async () => {
      const id = await seed();
      await getPool().query(`UPDATE servers SET is_community = FALSE WHERE id = $1`, [serverId]);
      await expectRefused(url(id));
    });

    it("a suspended community", async () => {
      const id = await seed();
      await getPool().query(
        `UPDATE servers SET is_community_suspended = TRUE WHERE id = $1`,
        [serverId],
      );
      await expectRefused(url(id));
    });

    it("a server that switched its own Baú off", async () => {
      const id = await seed();
      await getPool().query(
        `UPDATE servers SET community_home_enabled = FALSE WHERE id = $1`,
        [serverId],
      );
      await expectRefused(url(id));
    });

    it("communities off on the instance", async () => {
      const id = await seed();
      delete process.env.COMMUNITIES_ENABLED;
      await expectRefused(url(id));
    });

    it("the Baú off on the instance", async () => {
      const id = await seed();
      delete process.env.COMMUNITY_HOME_ENABLED;
      await expectRefused(url(id));
    });

    it("bau_public_posts off by default", async () => {
      const id = await seed();
      delete process.env.BAU_PUBLIC_POSTS;
      await expectRefused(url(id));
    });

    it("a per-server override that says no beats an environment that says yes", async () => {
      const id = await seed();
      await flags.startFeatureFlags();
      await flags.setServerFlagOverride("bau_public_posts", serverId, false, {
        kind: "dashboard",
      });
      await expectRefused(url(id));
    });
  });

  it("a per-server override turns it on for one community with the flag off everywhere else", async () => {
    const id = await seed();
    delete process.env.BAU_PUBLIC_POSTS;
    await flags.startFeatureFlags();
    expect((await get(url(id))).status).toBe(404);
    await flags.setServerFlagOverride("bau_public_posts", serverId, true, {
      kind: "dashboard",
    });
    expect((await get(url(id))).status).toBe(200);
    await flags.setServerFlagOverride("bau_public_posts", serverId, null, {
      kind: "dashboard",
    });
    expect((await get(url(id))).status).toBe(404);
  });

  it("runs out of its own address-keyed bucket, which is roomier than the poster's", async () => {
    // The bucket refills while the loop runs (8 a second), so the first 429
    // lands a little past the burst on a slow runner. Never before it.
    const statuses: number[] = [];
    for (let i = 0; i < 2000 && !statuses.includes(429); i += 1) {
      statuses.push((await get(url(UNKNOWN_ID))).status);
    }
    const firstLimited = statuses.indexOf(429);
    expect(firstLimited).toBeGreaterThanOrEqual(240);
    expect(statuses.slice(0, firstLimited).every((s) => s === 404)).toBe(true);
    // A 429 is never cached: the limiter must not be served from the edge.
    const limited = await get(url(UNKNOWN_ID));
    expect(limited.headers.get("cache-control")).toBe("no-store");
  });

  it("answers a shared cache the same way for every origin: ACAO *, no Vary", async () => {
    const id = await seed();
    process.env.CORS_ALLOWED_ORIGINS = "https://pqp.gg";
    try {
      for (const origin of ["https://pqp.gg", "https://evil.example", ""]) {
        const headers: Record<string, string> = origin ? { Origin: origin } : {};
        for (const path of [url(id), url(UNKNOWN_ID), `${url(id)}/cover`]) {
          const res = await get(path, headers);
          expect(res.headers.get("access-control-allow-origin"), `${origin} ${path}`).toBe("*");
          expect(res.headers.get("vary"), `${origin} ${path}`).toBeNull();
        }
      }
    } finally {
      delete process.env.CORS_ALLOWED_ORIGINS;
    }
  });

  it("signs the public media for ten minutes, not the twelve hours a member's feed gets", async () => {
    store.set(`community-home/${serverId}/p.jpg`, {
      bytes: jpegBytes(800, 450),
      type: "image/jpeg",
    });
    const id = await seed({
      mediaKind: "video",
      storageKey: `community-home/${serverId}/v.mp4`,
      posterKey: `community-home/${serverId}/p.jpg`,
    });
    signedTtls.length = 0;
    expect((await get(url(id))).status).toBe(200);
    expect((await get(`${url(id)}/cover`)).status).toBe(200);
    expect(signedTtls.length).toBeGreaterThanOrEqual(3);
    expect(signedTtls.every((ttl) => ttl === BAU_PUBLIC_MEDIA_TTL_SECONDS)).toBe(true);
    expect(BAU_PUBLIC_MEDIA_TTL_SECONDS).toBe(600);

    // The same post read by a member keeps the long one.
    signedTtls.length = 0;
    await asMember(member, `/api/servers/${serverId}/home/posts/${id}`);
    expect(signedTtls.length).toBeGreaterThanOrEqual(1);
    expect(signedTtls.every((ttl) => ttl === 12 * 60 * 60)).toBe(true);
  });

  describe("channel mentions", () => {
    it("names a channel everybody can see, and hides a private one behind a neutral reference", async () => {
      const open = await createChatServerChannel("anuncios", false);
      const staff = await createChatServerChannel("so-staff", true);
      const id = await seed({
        title: `Veja <#${open}>`,
        body: `Passa em <#${open}> e nao em <#${staff}>, ta?`,
      });
      const res = await get(url(id));
      const parsed = publicBauPostResponseSchema.parse(res.body);

      // The open channel keeps its id and travels with its name; the private
      // one is the neutral reference and its name is nowhere.
      expect(parsed.post.channels).toEqual([{ id: open, name: "anuncios" }]);
      expect(parsed.post.body).toBe(
        `Passa em <#${open}> e nao em <#${BAU_PUBLIC_REDACTED_CHANNEL_ID}>, ta?`,
      );
      expect(parsed.post.title).toBe(`Veja <#${open}>`);
      expect(res.text).not.toContain(staff);
      expect(res.text).not.toContain("so-staff");

      // The teaser reads as a sentence either way.
      expect(parsed.post.teaser).toBe("Passa em #anuncios e nao em um canal, ta?");
    });

    it("a hand-written teaser is resolved the same way", async () => {
      const open = await createChatServerChannel("geral2", false);
      const staff = await createChatServerChannel("diretoria", true);
      const id = await seed({ body: "corpo", teaser: `Vem <#${open}> ou <#${staff}>` });
      const parsed = publicBauPostResponseSchema.parse((await get(url(id))).body);
      expect(parsed.post.teaser).toBe("Vem #geral2 ou um canal");
    });

    it("an id from another server, a voice-less thread id or garbage resolves to nothing", async () => {
      const other = await createChatServer("Outra Mesa", owner.id);
      const foreign = await getPool().query<{ id: string }>(
        `SELECT id FROM channels WHERE server_id = $1 LIMIT 1`,
        [other.server.id],
      );
      const id = await seed({ body: `Olha <#${foreign.rows[0]!.id}> e <#${CHANNEL_ID}>` });
      const res = await get(url(id));
      const parsed = publicBauPostResponseSchema.parse(res.body);
      expect(parsed.post.channels).toEqual([]);
      expect(res.text.toLowerCase()).not.toContain(foreign.rows[0]!.id);
      expect(res.text.toLowerCase()).not.toContain(CHANNEL_ID);
    });

    it("a failed channel lookup redacts the mentions and still serves the post", async () => {
      const open = await createChatServerChannel("anuncios2", false);
      const id = await seed({ body: `Passa em <#${open}> hoje` });
      const pool = getPool();
      const original = pool.query.bind(pool);
      const spy = vi.spyOn(pool, "query").mockImplementation(((text: unknown, ...rest: unknown[]) =>
        typeof text === "string" && text.includes("channel_overwrites")
          ? Promise.reject(new Error("transient"))
          : (original as (...args: unknown[]) => unknown)(text, ...rest)) as never);
      const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const res = await get(url(id));
        expect(res.status).toBe(200);
        const parsed = publicBauPostResponseSchema.parse(res.body);
        expect(parsed.post.channels).toEqual([]);
        expect(parsed.post.body).toBe(`Passa em <#${BAU_PUBLIC_REDACTED_CHANNEL_ID}> hoje`);
        expect(parsed.post.teaser).toBe("Passa em um canal hoje");
      } finally {
        spy.mockRestore();
        quiet.mockRestore();
      }
    });

    it("a channel that denies @everyone VIEW_CHANNEL is hidden even when it is not flagged private", async () => {
      const channel = await createChatServerChannel("restrito", false);
      const everyone = await getPool().query<{ id: string }>(
        `SELECT id FROM roles WHERE server_id = $1 AND is_everyone`,
        [serverId],
      );
      await getPool().query(
        `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
         VALUES ($1, 'role', $2, 0, 64)`,
        [channel, everyone.rows[0]!.id],
      );
      const id = await seed({ body: `Ver <#${channel}>` });
      const parsed = publicBauPostResponseSchema.parse((await get(url(id))).body);
      expect(parsed.post.channels).toEqual([]);
      expect(parsed.post.teaser).toBe("Ver um canal");
    });
  });

  it("only GET reaches it", async () => {
    const id = await seed();
    actor = null;
    const res = await fetch(`${baseUrl}${url(id)}`, { method: "POST" });
    expect(res.status).not.toBe(200);
  });

  describe("getBauPublicUrl, the helper a delivery uses to link the page", () => {
    it("answers the address while the post qualifies and null the moment it does not", async () => {
      const id = await seed();
      const want = `https://pqp.gg/c/${SLUG}/p/${id}`;
      expect(await getBauPublicUrl(serverId, id)).toBe(want);
      // The same address the page answers at.
      expect((await get(url(id))).status).toBe(200);

      await getPool().query(`UPDATE community_home_posts SET visibility = 'members' WHERE id = $1`, [id]);
      expect(await getBauPublicUrl(serverId, id)).toBeNull();
      await getPool().query(`UPDATE community_home_posts SET visibility = 'free' WHERE id = $1`, [id]);
      expect(await getBauPublicUrl(serverId, id)).toBe(want);

      delete process.env.BAU_PUBLIC_POSTS;
      expect(await getBauPublicUrl(serverId, id)).toBeNull();
      process.env.BAU_PUBLIC_POSTS = "true";
      await getPool().query(`UPDATE servers SET is_community = FALSE WHERE id = $1`, [serverId]);
      expect(await getBauPublicUrl(serverId, id)).toBeNull();
    });

    it("a failed query is null, not a throw, so the caller can fall back to the in-app link", async () => {
      const id = await seed();
      const pool = getPool();
      const spy = vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("connection reset"));
      const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await expect(getBauPublicUrl(serverId, id)).resolves.toBeNull();
      } finally {
        spy.mockRestore();
        quiet.mockRestore();
      }
      expect(await getBauPublicUrl(serverId, id)).toBe(`https://pqp.gg/c/${SLUG}/p/${id}`);
    });

    it("is null for a draft, a deleted post, another server's pair and non-ids, and never throws", async () => {
      const draft = await seed({ status: "draft" });
      expect(await getBauPublicUrl(serverId, draft)).toBeNull();
      const gone = await seed();
      await getPool().query(`DELETE FROM community_home_posts WHERE id = $1`, [gone]);
      expect(await getBauPublicUrl(serverId, gone)).toBeNull();
      const live = await seed();
      expect(await getBauPublicUrl("11111111-2222-4333-8444-555555555555", live)).toBeNull();
      expect(await getBauPublicUrl(serverId, "not-a-uuid")).toBeNull();
      expect(await getBauPublicUrl("x", live)).toBeNull();
    });
  });

  describe("publicUrl on the members' own payloads", () => {
    it("is on a qualifying post of the feed, the single read and the chat card, and nowhere else", async () => {
      const free = await seed({ title: "livre" });
      const vip = await seed({ title: "vip", visibility: "members" });
      const draft = await seed({ title: "rascunho", status: "draft" });
      const want = `https://pqp.gg/c/${SLUG}/p/${free}`;

      const feed = await asMember<{ posts: Array<{ id: string; publicUrl?: string | null }> }>(
        member,
        `/api/servers/${serverId}/home/posts`,
      );
      expect(feed.status).toBe(200);
      const byId = new Map(feed.body.posts.map((p) => [p.id, p.publicUrl ?? null]));
      expect(byId.get(free)).toBe(want);
      // The members-only post is in the feed (VIP on) and has no public page.
      expect(byId.get(vip)).toBeNull();

      const one = await asMember<{ post: { publicUrl?: string | null } }>(
        member,
        `/api/servers/${serverId}/home/posts/${free}`,
      );
      expect(one.body.post.publicUrl).toBe(want);

      const card = await asMember<{ card: { publicUrl?: string | null } }>(
        member,
        `/api/servers/${serverId}/home/posts/${free}/card`,
      );
      expect(card.status).toBe(200);
      expect(card.body.card.publicUrl).toBe(want);
      const vipCard = await asMember<{ card: { publicUrl?: string | null } }>(
        member,
        `/api/servers/${serverId}/home/posts/${vip}/card`,
      );
      expect(vipCard.body.card.publicUrl ?? null).toBeNull();

      const drafts = await asMember<{ posts: Array<{ id: string; publicUrl?: string | null }> }>(
        owner,
        `/api/servers/${serverId}/home/drafts`,
      );
      expect(drafts.body.posts.find((p) => p.id === draft)?.publicUrl ?? null).toBeNull();

      // The address a client shows is the address that answers.
      const path = new URL(want).pathname;
      expect(parseBauPublicPostPath(path)).toEqual({ slug: SLUG, postId: free });
      expect((await get(url(free))).status).toBe(200);
      expect(bauShareUrl(want, "x")).toBe(
        `${want}?utm_source=x&utm_medium=share&utm_campaign=bau`,
      );
    });

    it("is null whenever the page would 404", async () => {
      const id = await seed();
      const readUrl = async () =>
        (
          await asMember<{ post: { publicUrl?: string | null } }>(
            member,
            `/api/servers/${serverId}/home/posts/${id}`,
          )
        ).body.post.publicUrl ?? null;

      expect(await readUrl()).not.toBeNull();
      delete process.env.BAU_PUBLIC_POSTS;
      expect(await readUrl()).toBeNull();
      process.env.BAU_PUBLIC_POSTS = "true";
      delete process.env.COMMUNITIES_ENABLED;
      expect(await readUrl()).toBeNull();
      process.env.COMMUNITIES_ENABLED = "true";
      await getPool().query(`UPDATE servers SET is_community = FALSE WHERE id = $1`, [serverId]);
      expect(await readUrl()).toBeNull();
    });

    it("follows PUBLIC_APP_URL on a deployment that is not pqp.gg", async () => {
      const id = await seed();
      process.env.PUBLIC_APP_URL = "https://pqp.example.org, https://other.example.org";
      const one = await asMember<{ post: { publicUrl?: string | null } }>(
        member,
        `/api/servers/${serverId}/home/posts/${id}`,
      );
      expect(one.body.post.publicUrl).toBe(`https://pqp.example.org/c/${SLUG}/p/${id}`);
    });
  });
});

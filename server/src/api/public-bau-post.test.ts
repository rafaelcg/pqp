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
 *  - THE COVER is a stable address that redirects to a fresh signature.
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

vi.mock("../lib/s3.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/s3.js")>()),
  isStorageConfigured: () => true,
  presignGet: (key: string, options?: { ttlSeconds?: number }) => {
    signedTtls.push(options?.ttlSeconds ?? -1);
    return `https://storage.test/get/${key}?sig=abc`;
  },
}));

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("./index.js");
const { upsertUser } = await import("../services/users.js");
const { createServer: createChatServer, createChannel } = await import("../services/servers.js");
const flags = await import("../lib/flags.js");
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
      "coverUrl",
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
    const id = await seed({
      mediaKind: "image",
      storageKey: `community-home/${serverId}/imagem.png`,
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

    const cover = await get(`${url(id)}/cover`);
    expect(cover.status).toBe(302);
    expect(cover.location).toBe(
      `https://storage.test/get/community-home/${serverId}/imagem.png?sig=abc`,
    );
    expect(cover.headers.get("cache-control")).toBe(CACHE_MISS);
  });

  it("a video's cover is its chosen picture; with none there is no cover", async () => {
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
    const cover = await get(`${url(withCover)}/cover`);
    expect(cover.status).toBe(302);
    expect(cover.location).toBe(`https://storage.test/get/community-home/${serverId}/p.jpg?sig=abc`);

    const b = publicBauPostResponseSchema.parse((await get(url(without))).body);
    expect(b.post.coverUrl).toBeNull();
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
    // Nothing of ours to redirect to.
    expect((await get(`${url(id)}/cover`)).status).toBe(404);
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
    const statuses: number[] = [];
    for (let i = 0; i < 241; i += 1) {
      statuses.push((await get(url(UNKNOWN_ID))).status);
    }
    expect(statuses.slice(0, 240).every((s) => s === 404)).toBe(true);
    expect(statuses[240]).toBe(429);
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
    const id = await seed({
      mediaKind: "video",
      storageKey: `community-home/${serverId}/v.mp4`,
      posterKey: `community-home/${serverId}/p.jpg`,
    });
    signedTtls.length = 0;
    expect((await get(url(id))).status).toBe(200);
    expect((await get(`${url(id)}/cover`)).status).toBe(302);
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

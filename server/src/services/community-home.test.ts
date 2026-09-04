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
 * Baú, pinned at the boundaries that matter:
 *
 *   * WITH THE FLAG OFF NOTHING EXISTS. Every `/home/*` route 404s; the
 *     config endpoint still answers so the client can tell off from down.
 *   * VISIBILITY IS ENFORCED HERE. A members-only post reaches a plain
 *     member as title + teaser + `locked: true`, with body, media and
 *     comment words stripped. Staff and the VIP cargo get the whole thing.
 *   * VIP OFF MEANS NO VIP. `visibility: members` is refused on write and
 *     existing members-only rows leave the member feed.
 *   * DRAFTS ARE STAFF-ONLY. A member never sees a draft or a scheduled post,
 *     not in the feed and not by id.
 *
 * Same harness as communities.test.ts: the real router with only the
 * identity layer stubbed.
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

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("../api/index.js");
const { upsertUser } = await import("./users.js");
const { createServer: createChatServer } = await import("./servers.js");

let httpServer: Server;
let baseUrl: string;

interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  as: { id: string; clerk_id: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
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

interface PostBody {
  id: string;
  title: string | null;
  body: string | null;
  teaser: string | null;
  visibility: "free" | "members";
  status: "draft" | "published" | "scheduled";
  media: { kind: string; youtubeUrl: string | null } | null;
  locked: boolean;
  commentCount: number;
  commentTeaser: { body: string }[];
  likeCount: number;
  likedByMe: boolean;
  pinned: boolean;
}

describeDb("community home (Baú)", () => {
  let owner: { id: string; clerk_id: string };
  let member: { id: string; clerk_id: string };
  let vip: { id: string; clerk_id: string };
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
    process.env.COMMUNITY_HOME_ENABLED = "true";
    process.env.COMMUNITY_HOME_VIP_ENABLED = "true";

    const makeUser = (name: string) =>
      upsertUser({
        clerkId: `clerk_${name}`,
        displayName: name,
        avatarUrl: null,
      });
    owner = await makeUser("owner");
    member = await makeUser("member");
    vip = await makeUser("vip");

    const created = await createChatServer("Mesa da Tues", owner.id);
    serverId = created.server.id;
    for (const person of [member, vip]) {
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role)
         VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
        [serverId, person.id],
      );
    }
    // The VIP cargo is seeded on every server; hand it to `vip`.
    await getPool().query(
      `INSERT INTO member_roles (server_id, user_id, role_id)
       SELECT $1, $2, id FROM roles WHERE server_id = $1 AND system_key = 'vip'
       ON CONFLICT DO NOTHING`,
      [serverId, vip.id],
    );
  });

  afterEach(() => {
    delete process.env.COMMUNITY_HOME_ENABLED;
    delete process.env.COMMUNITY_HOME_VIP_ENABLED;
  });

  const base = () => `/api/servers/${serverId}/home`;

  async function publish(post: Record<string, unknown>): Promise<PostBody> {
    const res = await call<{ post: PostBody }>(owner, "POST", `${base()}/posts`, {
      status: "published",
      ...post,
    });
    expect(res.status).toBe(201);
    return res.body.post;
  }

  // ------------------------------------------------------------- the flag

  describe("with COMMUNITY_HOME_ENABLED unset", () => {
    beforeEach(() => {
      delete process.env.COMMUNITY_HOME_ENABLED;
      delete process.env.COMMUNITY_HOME_VIP_ENABLED;
    });

    it("reports itself off through the config endpoint rather than 404ing it", async () => {
      const res = await call(member, "GET", "/api/community-home/config");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        enabled: false,
        vipEnabled: false,
        mediaEnabled: false,
      });
    });

    it("404s the feed, the drafts, a write and a like", async () => {
      expect((await call(member, "GET", `${base()}/posts`)).status).toBe(404);
      expect((await call(owner, "GET", `${base()}/drafts`)).status).toBe(404);
      expect(
        (
          await call(owner, "POST", `${base()}/posts`, {
            title: "x",
            body: "y",
            status: "published",
          })
        ).status,
      ).toBe(404);
      expect(
        (await call(member, "GET", `${base()}/media/config`)).status,
      ).toBe(404);
    });
  });

  it("VIP flag alone does nothing without the main flag", async () => {
    delete process.env.COMMUNITY_HOME_ENABLED;
    const res = await call<{ vipEnabled: boolean }>(
      member,
      "GET",
      "/api/community-home/config",
    );
    expect(res.body.vipEnabled).toBe(false);
  });

  // ----------------------------------------------------------- publishing

  it("only MANAGE_SERVER can post; a member gets 403", async () => {
    const res = await call(member, "POST", `${base()}/posts`, {
      title: "nope",
      body: "nope",
      status: "published",
    });
    expect(res.status).toBe(403);
  });

  it("publishing needs a title and a body or media", async () => {
    const noTitle = await call(owner, "POST", `${base()}/posts`, {
      body: "sem título",
      status: "published",
    });
    expect(noTitle.status).toBe(400);
    const noContent = await call(owner, "POST", `${base()}/posts`, {
      title: "só título",
      status: "published",
    });
    expect(noContent.status).toBe(400);
    // A draft may be anything.
    const draft = await call<{ post: PostBody }>(owner, "POST", `${base()}/posts`, {
      body: "rascunho solto",
    });
    expect(draft.status).toBe(201);
    expect(draft.body.post.status).toBe("draft");
  });

  it("drafts and scheduled posts never reach a member", async () => {
    const draft = await call<{ post: PostBody }>(owner, "POST", `${base()}/posts`, {
      title: "rascunho",
      body: "ainda não",
    });
    const scheduled = await call<{ post: PostBody }>(owner, "POST", `${base()}/posts`, {
      title: "amanhã",
      body: "agendado",
      status: "scheduled",
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      scheduleTimezone: "America/Sao_Paulo",
    });
    expect(scheduled.status).toBe(201);
    expect(scheduled.body.post.status).toBe("scheduled");

    const feed = await call<{ posts: PostBody[] }>(member, "GET", `${base()}/posts`);
    expect(feed.body.posts).toEqual([]);
    expect(
      (await call(member, "GET", `${base()}/posts/${draft.body.post.id}`)).status,
    ).toBe(404);
    expect((await call(member, "GET", `${base()}/drafts`)).status).toBe(403);

    const staff = await call<{ posts: PostBody[] }>(owner, "GET", `${base()}/drafts`);
    expect(staff.body.posts.map((p) => p.title).sort()).toEqual(["amanhã", "rascunho"]);
  });

  it("the schedule sweep flips a due post to published", async () => {
    const { publishDueCommunityHomePosts } = await import("./community-home.js");
    const res = await call<{ post: PostBody }>(owner, "POST", `${base()}/posts`, {
      title: "já era pra ter subido",
      body: "atrasado",
      status: "scheduled",
      scheduledAt: new Date(Date.now() + 2000).toISOString(),
      scheduleTimezone: "UTC",
    });
    expect(res.status).toBe(201);
    // Backdate it rather than waiting.
    await getPool().query(
      `UPDATE community_home_posts SET scheduled_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
      [res.body.post.id],
    );
    expect(await publishDueCommunityHomePosts()).toEqual([serverId]);
    const feed = await call<{ posts: PostBody[] }>(member, "GET", `${base()}/posts`);
    expect(feed.body.posts.map((p) => p.title)).toEqual(["já era pra ter subido"]);
  });

  // ----------------------------------------------------------- visibility

  it("a members-only post is stripped for a member and whole for staff and VIP", async () => {
    const post = await publish({
      title: "Sessão 11",
      body: "o clip inteiro: sessao-11-clip.webm",
      teaser: "só o inner vê",
      visibility: "members",
      youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
    });
    // A comment by staff, to prove the words are stripped too.
    await call(owner, "POST", `${base()}/posts/${post.id}/comments`, {
      body: "esse clip é o sessao-11",
    });

    const asMember = await call<{ posts: PostBody[] }>(member, "GET", `${base()}/posts`);
    const locked = asMember.body.posts[0]!;
    expect(locked.locked).toBe(true);
    expect(locked.title).toBe("Sessão 11");
    expect(locked.teaser).toBe("só o inner vê");
    expect(locked.body).toBeNull();
    expect(locked.media).toBeNull();
    expect(locked.commentCount).toBe(1);
    expect(locked.commentTeaser).toEqual([]);
    expect(JSON.stringify(asMember.body)).not.toContain("sessao-11");

    for (const viewer of [owner, vip]) {
      const res = await call<{ posts: PostBody[] }>(viewer, "GET", `${base()}/posts`);
      const open = res.body.posts[0]!;
      expect(open.locked).toBe(false);
      expect(open.body).toContain("sessao-11-clip.webm");
      expect(open.media?.kind).toBe("youtube");
      expect(open.commentTeaser.map((c) => c.body)).toEqual(["esse clip é o sessao-11"]);
    }
  });

  it("a free post carries no lock for anybody", async () => {
    await publish({ title: "Mapa", body: "mapa-porao.png" });
    const res = await call<{ posts: PostBody[] }>(member, "GET", `${base()}/posts`);
    expect(res.body.posts[0]!.locked).toBe(false);
    expect(res.body.posts[0]!.body).toBe("mapa-porao.png");
  });

  describe("with COMMUNITY_HOME_VIP_ENABLED unset", () => {
    it("refuses a members-only post on create and on edit", async () => {
      process.env.COMMUNITY_HOME_VIP_ENABLED = "true";
      const post = await publish({ title: "Livre", body: "livre" });
      delete process.env.COMMUNITY_HOME_VIP_ENABLED;

      const create = await call(owner, "POST", `${base()}/posts`, {
        title: "VIP",
        body: "x",
        visibility: "members",
        status: "published",
      });
      expect(create.status).toBe(400);
      const edit = await call(owner, "PATCH", `${base()}/posts/${post.id}`, {
        visibility: "members",
      });
      expect(edit.status).toBe(400);
    });

    it("hides existing members-only posts from the feed but keeps them in drafts", async () => {
      process.env.COMMUNITY_HOME_VIP_ENABLED = "true";
      await publish({ title: "VIP antigo", body: "x", visibility: "members" });
      await publish({ title: "Livre", body: "y" });
      delete process.env.COMMUNITY_HOME_VIP_ENABLED;

      const feed = await call<{ posts: PostBody[] }>(owner, "GET", `${base()}/posts`);
      expect(feed.body.posts.map((p) => p.title)).toEqual(["Livre"]);
    });
  });

  // ------------------------------------------------------- spam and scale

  it("stops a comment flood without stopping a conversation", async () => {
    const post = await publish({ title: "Papo", body: "x" });
    const say = (body: string) =>
      call(member, "POST", `${base()}/posts/${post.id}/comments`, { body });

    // A burst is a person replying; the budget allows it.
    for (let i = 0; i < 6; i += 1) {
      expect((await say(`comentário ${i}`)).status).toBe(201);
    }
    // Sustained is a script.
    const flooded = await say("e mais um");
    expect(flooded.status).toBe(429);
  });

  it("refuses a comment longer than the limit rather than truncating it", async () => {
    const post = await publish({ title: "Papo", body: "x" });
    const tooLong = await call(member, "POST", `${base()}/posts/${post.id}/comments`, {
      body: "a".repeat(1001),
    });
    expect(tooLong.status).toBe(400);
    const enormous = await call(member, "POST", `${base()}/posts/${post.id}/comments`, {
      body: "a".repeat(50_000),
    });
    expect(enormous.status).toBe(400);
  });

  it("caps the feed rather than returning every post a server ever had", async () => {
    // Straight into the table: the point is the read path, and the write
    // path's own budget would (correctly) refuse sixty posts in a row.
    await getPool().query(
      `INSERT INTO community_home_posts
         (server_id, author_id, title, body, status, published_at)
       SELECT $1, $2, 'post ' || g, 'corpo', 'published', NOW() - (g || ' minutes')::interval
         FROM generate_series(1, 60) AS g`,
      [serverId, owner.id],
    );
    const feed = await call<{ posts: PostBody[] }>(member, "GET", `${base()}/posts`);
    expect(feed.body.posts).toHaveLength(50);
    // Newest first, so the page is the useful end.
    expect(feed.body.posts[0]!.title).toBe("post 1");
  });

  it("hides a blocked person's comments, and does not count them either", async () => {
    const post = await publish({ title: "Papo", body: "x" });
    await call(member, "POST", `${base()}/posts/${post.id}/comments`, {
      body: "do membro",
    });
    await call(vip, "POST", `${base()}/posts/${post.id}/comments`, {
      body: "do vip",
    });

    const seen = await call<{ posts: PostBody[] }>(member, "GET", `${base()}/posts`);
    expect(seen.body.posts[0]!.commentCount).toBe(2);

    // `member` blocks `vip`.
    expect(
      (await call(member, "POST", "/api/blocks", { userId: vip.id })).status,
    ).toBeLessThan(300);

    const after = await call<{ posts: PostBody[] }>(member, "GET", `${base()}/posts`);
    // A card that says 2 and shows 1 is how a blocked person keeps a
    // presence on your screen: the count moves too.
    expect(after.body.posts[0]!.commentCount).toBe(1);
    expect(after.body.posts[0]!.commentTeaser.map((c) => c.body)).toEqual([
      "do membro",
    ]);

    const list = await call<{ comments: { body: string }[] }>(
      member,
      "GET",
      `${base()}/posts/${post.id}/comments`,
    );
    expect(list.body.comments.map((c) => c.body)).toEqual(["do membro"]);

    // The person who did the blocking is the only one whose view changes.
    const vipView = await call<{ posts: PostBody[] }>(vip, "GET", `${base()}/posts`);
    expect(vipView.body.posts[0]!.commentCount).toBe(2);
  });

  // ------------------------------------------------------------- pinning

  it("a pinned post leads the feed whatever its date, and only one can be pinned", async () => {
    const welcome = await publish({ title: "Bem-vindo", body: "o vídeo" });
    // Two later posts, so date order alone would bury the welcome.
    await publish({ title: "Segundo", body: "x" });
    const third = await publish({ title: "Terceiro", body: "y" });

    const pinned = await call<{ post: PostBody }>(
      owner,
      "POST",
      `${base()}/posts/${welcome.id}/pin`,
      { pinned: true },
    );
    expect(pinned.status).toBe(200);
    expect(pinned.body.post.pinned).toBe(true);

    const feed = await call<{ posts: PostBody[] }>(member, "GET", `${base()}/posts`);
    expect(feed.body.posts.map((p) => p.title)).toEqual([
      "Bem-vindo",
      "Terceiro",
      "Segundo",
    ]);

    // Pinning another one replaces it: the top slot is a slot, not a pile.
    await call(owner, "POST", `${base()}/posts/${third.id}/pin`, { pinned: true });
    const after = await call<{ posts: PostBody[] }>(member, "GET", `${base()}/posts`);
    expect(after.body.posts.map((p) => p.title)).toEqual([
      "Terceiro",
      "Segundo",
      "Bem-vindo",
    ]);
    expect(after.body.posts.filter((p) => p.pinned)).toHaveLength(1);

    // And unpinning gives the feed back to the dates.
    await call(owner, "POST", `${base()}/posts/${third.id}/pin`, { pinned: false });
    const plain = await call<{ posts: PostBody[] }>(member, "GET", `${base()}/posts`);
    expect(plain.body.posts.map((p) => p.title)).toEqual([
      "Terceiro",
      "Segundo",
      "Bem-vindo",
    ]);
    expect(plain.body.posts.some((p) => p.pinned)).toBe(false);
  });

  it("refuses to pin a draft, and refuses a member outright", async () => {
    const draft = await call<{ post: PostBody }>(owner, "POST", `${base()}/posts`, {
      title: "rascunho",
      body: "ainda não",
    });
    expect(
      (
        await call(owner, "POST", `${base()}/posts/${draft.body.post.id}/pin`, {
          pinned: true,
        })
      ).status,
    ).toBe(400);

    const post = await publish({ title: "Livre", body: "x" });
    expect(
      (await call(member, "POST", `${base()}/posts/${post.id}/pin`, { pinned: true }))
        .status,
    ).toBe(403);
  });

  // -------------------------------------------------------------- unread

  it("counts posts a person has not seen, ignores their own, and clears on read", async () => {
    const unread = () =>
      call<{ count: number }>(member, "GET", `${base()}/unread`);

    // Nothing published yet.
    expect((await unread()).body.count).toBe(0);

    await publish({ title: "Um", body: "x" });
    await publish({ title: "Dois", body: "y" });
    expect((await unread()).body.count).toBe(2);

    // Opening the feed is reading it.
    expect((await call(member, "POST", `${base()}/read`)).status).toBe(200);
    expect((await unread()).body.count).toBe(0);

    // A later post counts again.
    await publish({ title: "Três", body: "z" });
    expect((await unread()).body.count).toBe(1);

    // The author never badges themselves for their own post.
    const ownerUnread = await call<{ count: number }>(
      owner,
      "GET",
      `${base()}/unread`,
    );
    expect(ownerUnread.body.count).toBe(0);
  });

  // ------------------------------------------------------ edits and media

  it("editing without mentioning the teaser keeps it", async () => {
    const post = await publish({
      title: "VIP",
      body: "x",
      teaser: "teaser original",
      visibility: "members",
    });
    const edited = await call<{ post: PostBody }>(
      owner,
      "PATCH",
      `${base()}/posts/${post.id}`,
      { body: "y" },
    );
    expect(edited.status).toBe(200);
    expect(edited.body.post.teaser).toBe("teaser original");
    // Flipping to free clears it.
    const freed = await call<{ post: PostBody }>(
      owner,
      "PATCH",
      `${base()}/posts/${post.id}`,
      { visibility: "free" },
    );
    expect(freed.body.post.teaser).toBeNull();
  });

  it("a bad YouTube URL is a 400, not a post", async () => {
    const res = await call(owner, "POST", `${base()}/posts`, {
      title: "x",
      body: "y",
      status: "published",
      youtubeUrl: "https://example.com/not-youtube",
    });
    expect(res.status).toBe(400);
  });

  // ------------------------------------------------- comments and likes

  it("comments are a flat list; the card teases the oldest two", async () => {
    const post = await publish({ title: "Mapa", body: "mapa" });
    for (const body of ["um", "dois", "três"]) {
      const res = await call(member, "POST", `${base()}/posts/${post.id}/comments`, {
        body,
      });
      expect(res.status).toBe(201);
    }
    const feed = await call<{ posts: PostBody[] }>(member, "GET", `${base()}/posts`);
    const card = feed.body.posts[0]!;
    expect(card.commentCount).toBe(3);
    // Oldest two, not newest two. A card that reshuffles every time somebody
    // comments turns the feed into a slow chat, which is the one thing this
    // surface is not.
    expect(card.commentTeaser.map((c) => c.body)).toEqual(["um", "dois"]);

    const all = await call<{ comments: { body: string }[] }>(
      member,
      "GET",
      `${base()}/posts/${post.id}/comments`,
    );
    expect(all.body.comments.map((c) => c.body)).toEqual(["um", "dois", "três"]);
  });

  it("the author's own reply takes the card over older comments", async () => {
    // The half of the teaser rule worth having: when the person who posted has
    // answered, that answer is what a passer-by should see, even though three
    // other comments came first.
    const post = await publish({ title: "Aviso", body: "aviso" });
    for (const body of ["um", "dois", "três"]) {
      const res = await call(member, "POST", `${base()}/posts/${post.id}/comments`, {
        body,
      });
      expect(res.status).toBe(201);
    }
    const reply = await call(owner, "POST", `${base()}/posts/${post.id}/comments`, {
      body: "resposta",
    });
    expect(reply.status).toBe(201);

    const feed = await call<{ posts: PostBody[] }>(member, "GET", `${base()}/posts`);
    const card = feed.body.posts[0]!;
    expect(card.commentCount).toBe(4);
    expect(card.commentTeaser.map((c) => c.body)).toEqual(["resposta"]);
  });

  it("comments off refuses a new one and hides the list from members", async () => {
    const post = await publish({ title: "Quieto", body: "x", commentsEnabled: false });
    const res = await call(member, "POST", `${base()}/posts/${post.id}/comments`, {
      body: "oi",
    });
    expect(res.status).toBe(403);
  });

  it("a like toggles and is counted once per person", async () => {
    const post = await publish({ title: "Curte", body: "x" });
    const first = await call<{ liked: boolean; likeCount: number }>(
      member,
      "POST",
      `${base()}/posts/${post.id}/likes`,
    );
    expect(first.body).toEqual({ liked: true, likeCount: 1 });
    const second = await call<{ liked: boolean; likeCount: number }>(
      member,
      "POST",
      `${base()}/posts/${post.id}/likes`,
    );
    expect(second.body).toEqual({ liked: false, likeCount: 0 });
  });

  it("deleting a post takes its comments and likes with it", async () => {
    const post = await publish({ title: "Some", body: "x" });
    await call(member, "POST", `${base()}/posts/${post.id}/comments`, { body: "oi" });
    await call(member, "POST", `${base()}/posts/${post.id}/likes`);
    expect((await call(owner, "DELETE", `${base()}/posts/${post.id}`)).status).toBe(200);
    const comments = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM community_home_comments WHERE post_id = $1`,
      [post.id],
    );
    expect(comments.rows[0].n).toBe(0);
    expect((await call(member, "GET", `${base()}/posts/${post.id}`)).status).toBe(404);
  });
});

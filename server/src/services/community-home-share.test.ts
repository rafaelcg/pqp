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
 * Baú posts in chat, pinned where it matters:
 *
 *   * THE CARD IS AUTHORIZED LIKE THE FEED. A stranger, a draft, a post from
 *     another server, and a server with Baú switched off are all 404, so the
 *     client falls back to the plain link.
 *   * A LOCKED POST LEAKS NOTHING. A member who cannot unlock gets the title,
 *     the teaser and (YouTube only) the public poster, never the body or the
 *     uploaded media url.
 *   * SHARING IS CHAT. The message goes through the chat send path, so a
 *     channel the caller cannot speak in refuses it, a channel of another
 *     server is refused, and a member cannot share at all.
 *   * ANNOUNCING NEVER FAILS A PUBLISH.
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
const { assignRole, createRole, upsertChannelOverwrite } = await import(
  "./roles.js"
);
const { Permission } = await import("@pqp/shared");
const { teaserFromBody, toPostCard, safeShareOrigin } = await import(
  "./community-home-share.js"
);

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

type Card = {
  postId: string;
  serverName: string;
  title: string | null;
  teaser: string | null;
  mediaKind: string | null;
  mediaUrl: string | null;
  locked: boolean;
  author: { displayName: string };
};

describe("teaserFromBody", () => {
  it("flattens markdown and cuts long text at a word", () => {
    expect(teaserFromBody("**bold** and `x`\n\nnext")).toBe("bold and x next");
    expect(teaserFromBody("   ")).toBeNull();
    const long = `${"palavra ".repeat(80)}`;
    const cut = teaserFromBody(long)!;
    expect(cut.endsWith("...")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(226);
  });
});

describe("safeShareOrigin", () => {
  it("keeps an http(s) origin and falls back to pqp.gg otherwise", () => {
    expect(safeShareOrigin("https://pqp.gg/anything")).toBe("https://pqp.gg");
    expect(safeShareOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    expect(safeShareOrigin("javascript:alert(1)")).toBe("https://pqp.gg");
    expect(safeShareOrigin(null)).toBe("https://pqp.gg");
  });
});

describe("toPostCard", () => {
  const base = {
    id: "11111111-1111-4111-8111-111111111111",
    serverId: "22222222-2222-4222-8222-222222222222",
    author: {
      id: "33333333-3333-4333-8333-333333333333",
      displayName: "Rafa",
      username: "rafa",
      tag: "rafa#0001",
      avatarUrl: null,
      customStatus: null,
    },
    authorBadge: null,
    title: "Sessão 11",
    body: "corpo **longo**",
    teaser: null,
    visibility: "free" as const,
    status: "published" as const,
    commentsEnabled: true,
    media: null,
    hasMedia: false,
    posterUrl: null,
    locked: false,
    likeCount: 2,
    likedByMe: false,
    commentCount: 1,
    commentTeaser: [],
    pinned: false,
    scheduledAt: null,
    scheduleTimezone: null,
    publishedAt: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    translation: null,
  };

  it("uses the signed url for an image or video and the poster for YouTube", () => {
    const video = toPostCard(
      {
        ...base,
        hasMedia: true,
        media: {
          kind: "video",
          name: "a.mp4",
          contentType: "video/mp4",
          byteSize: 1,
          url: "https://bucket/a.mp4?sig=1",
          youtubeUrl: null,
          twitchUrl: null,
        },
      },
      "Mesa",
    );
    expect(video.mediaKind).toBe("video");
    expect(video.mediaUrl).toBe("https://bucket/a.mp4?sig=1");
    expect(video.teaser).toBe("corpo longo");

    const yt = toPostCard(
      {
        ...base,
        hasMedia: true,
        posterUrl: "https://i.ytimg.com/vi/x/hqdefault.jpg",
        media: {
          kind: "youtube",
          name: "YouTube",
          contentType: null,
          byteSize: null,
          url: null,
          youtubeUrl: "https://youtu.be/x",
          twitchUrl: null,
        },
      },
      "Mesa",
    );
    expect(yt.mediaKind).toBe("youtube");
    expect(yt.mediaUrl).toBe("https://i.ytimg.com/vi/x/hqdefault.jpg");
  });

  it("a locked post keeps the teaser and the public poster and nothing else", () => {
    const card = toPostCard(
      {
        ...base,
        visibility: "members",
        locked: true,
        body: null,
        teaser: "só o inner vê",
        hasMedia: true,
        media: null,
      },
      "Mesa",
    );
    expect(card.teaser).toBe("só o inner vê");
    expect(card.mediaKind).toBeNull();
    expect(card.mediaUrl).toBeNull();
    expect(card.locked).toBe(true);
  });
});

describeDb("Baú card and share endpoints", () => {
  let owner: { id: string; clerk_id: string };
  let member: { id: string; clerk_id: string };
  let stranger: { id: string; clerk_id: string };
  let serverId: string;
  let generalId: string;
  let voiceId: string;
  let otherServerChannelId: string;

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
      upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null });
    owner = await makeUser("owner");
    member = await makeUser("member");
    stranger = await makeUser("stranger");

    const created = await createChatServer("Mesa da Tues", owner.id);
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
    const channels = await getPool().query<{ id: string; type: string; name: string }>(
      `SELECT id, type, name FROM channels WHERE server_id = $1 ORDER BY position`,
      [serverId],
    );
    generalId = channels.rows.find((c) => c.type === "text")!.id;
    const voice = channels.rows.find((c) => c.type === "voice");
    voiceId = voice?.id ?? "";

    const other = await createChatServer("Outra", owner.id);
    const otherText = await getPool().query<{ id: string }>(
      `SELECT id FROM channels WHERE server_id = $1 AND type = 'text' LIMIT 1`,
      [other.server.id],
    );
    otherServerChannelId = otherText.rows[0]!.id;
  });

  afterEach(() => {
    delete process.env.COMMUNITY_HOME_ENABLED;
    delete process.env.COMMUNITY_HOME_VIP_ENABLED;
  });

  const base = () => `/api/servers/${serverId}/home`;

  async function publish(extra: Record<string, unknown> = {}) {
    const res = await call<{ post: { id: string }; announced?: boolean }>(
      owner,
      "POST",
      `${base()}/posts`,
      { status: "published", title: "Sessão 11", body: "o clip inteiro", ...extra },
    );
    expect(res.status).toBe(201);
    return res.body;
  }

  async function lastMessageBody(channelId: string): Promise<string[]> {
    const res = await getPool().query<{ body: string }>(
      `SELECT body FROM messages WHERE channel_id = $1 ORDER BY created_at`,
      [channelId],
    );
    return res.rows.map((r) => r.body);
  }

  it("a member gets the card; a stranger, another server and a draft get 404", async () => {
    const { post } = await publish();
    const ok = await call<{ card: Card }>(member, "GET", `${base()}/posts/${post.id}/card`);
    expect(ok.status).toBe(200);
    expect(ok.body.card.title).toBe("Sessão 11");
    expect(ok.body.card.teaser).toBe("o clip inteiro");
    expect(ok.body.card.serverName).toBe("Mesa da Tues");
    expect(ok.body.card.author.displayName).toBe("owner");

    const outsider = await call(stranger, "GET", `${base()}/posts/${post.id}/card`);
    expect(outsider.status).toBeGreaterThanOrEqual(403);
    expect(outsider.status).toBeLessThanOrEqual(404);

    const draft = await call<{ post: { id: string } }>(owner, "POST", `${base()}/posts`, {
      status: "draft",
      title: "rascunho",
      body: "x",
    });
    const draftCard = await call(owner, "GET", `${base()}/posts/${draft.body.post.id}/card`);
    expect(draftCard.status).toBe(404);
    const memberDraft = await call(member, "GET", `${base()}/posts/${draft.body.post.id}/card`);
    expect(memberDraft.status).toBe(404);

    const wrongServer = await call(
      owner,
      "GET",
      `/api/servers/${randomUuid()}/home/posts/${post.id}/card`,
    );
    expect(wrongServer.status).toBeGreaterThanOrEqual(403);
  });

  it("404s when Baú is off for the server or for the instance", async () => {
    const { post } = await publish();
    await getPool().query(`UPDATE servers SET community_home_enabled = FALSE WHERE id = $1`, [
      serverId,
    ]);
    expect((await call(member, "GET", `${base()}/posts/${post.id}/card`)).status).toBe(404);
    await getPool().query(`UPDATE servers SET community_home_enabled = TRUE WHERE id = $1`, [
      serverId,
    ]);
    process.env.COMMUNITY_HOME_ENABLED = "false";
    expect((await call(member, "GET", `${base()}/posts/${post.id}/card`)).status).toBe(404);
  });

  it("a members-only post is a locked card without body words for a plain member", async () => {
    const { post } = await publish({
      visibility: "members",
      teaser: "só o inner vê",
      body: "segredo-do-clip",
      youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
    });
    const asMember = await call<{ card: Card }>(member, "GET", `${base()}/posts/${post.id}/card`);
    expect(asMember.status).toBe(200);
    expect(asMember.body.card.locked).toBe(true);
    expect(asMember.body.card.teaser).toBe("só o inner vê");
    expect(JSON.stringify(asMember.body)).not.toContain("segredo-do-clip");
    expect(JSON.stringify(asMember.body)).not.toContain("youtu.be");
    const asOwner = await call<{ card: Card }>(owner, "GET", `${base()}/posts/${post.id}/card`);
    expect(asOwner.body.card.locked).toBe(false);
  });

  it("share posts a normal chat message with the permalink; members cannot share", async () => {
    const { post } = await publish();
    const denied = await call(member, "POST", `${base()}/posts/${post.id}/share`, {
      channelId: generalId,
    });
    expect(denied.status).toBe(403);

    const res = await call(owner, "POST", `${base()}/posts/${post.id}/share`, {
      channelId: generalId,
      message: "Saiu no Baú",
    });
    expect(res.status).toBe(200);
    const bodies = await lastMessageBody(generalId);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatch(
      new RegExp(`^Saiu no Baú\\nhttps?://[^\\s]+/app/server/${serverId}/bau/${post.id}$`),
    );
  });

  it("share refuses another server's channel, a voice channel and a channel the caller cannot speak in", async () => {
    const { post } = await publish();
    const otherServer = await call(owner, "POST", `${base()}/posts/${post.id}/share`, {
      channelId: otherServerChannelId,
    });
    expect(otherServer.status).toBe(400);
    if (voiceId) {
      const voice = await call(owner, "POST", `${base()}/posts/${post.id}/share`, {
        channelId: voiceId,
      });
      expect(voice.status).toBe(400);
    }
    const unknownChannel = await call(owner, "POST", `${base()}/posts/${post.id}/share`, {
      channelId: randomUuid(),
    });
    expect(unknownChannel.status).toBe(400);
  });

  it("a manager who may not speak in the channel gets 403, and the announce is skipped", async () => {
    const editor = await createRole(serverId, {
      name: "Editor",
      permissions: Permission.MANAGE_SERVER | Permission.VIEW_CHANNEL,
    });
    await assignRole(serverId, member.id, editor.id);
    await upsertChannelOverwrite(
      generalId,
      serverId,
      "role",
      editor.id,
      0n,
      Permission.SEND_MESSAGES,
    );
    const published = await call<{ post: { id: string } }>(member, "POST", `${base()}/posts`, {
      status: "published",
      title: "Do editor",
      body: "texto",
      announceChannelId: generalId,
    });
    expect(published.status).toBe(201);
    expect((published.body as { announced?: boolean }).announced).toBe(false);
    const share = await call(member, "POST", `${base()}/posts/${published.body.post.id}/share`, {
      channelId: generalId,
    });
    expect(share.status).toBe(403);
    expect(await lastMessageBody(generalId)).toHaveLength(0);
  });

  it("publishing with announceChannelId posts the card; a bad channel never fails the publish", async () => {
    const ok = await publish({ announceChannelId: generalId });
    expect(ok.announced).toBe(true);
    const bodies = await lastMessageBody(generalId);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(`/app/server/${serverId}/bau/${ok.post.id}`);

    const bad = await publish({ announceChannelId: otherServerChannelId });
    expect(bad.announced).toBe(false);
    expect(await lastMessageBody(otherServerChannelId)).toHaveLength(0);

    const draft = await call<{ post: { id: string }; announced?: boolean }>(
      owner,
      "POST",
      `${base()}/posts`,
      { status: "draft", title: "d", body: "d", announceChannelId: generalId },
    );
    expect(draft.body.announced).toBe(false);
    expect(await lastMessageBody(generalId)).toHaveLength(1);
  });

  it("publish-now of a draft can announce too, and with no body still works", async () => {
    const draft = await call<{ post: { id: string } }>(owner, "POST", `${base()}/posts`, {
      status: "draft",
      title: "d",
      body: "d",
    });
    const plain = await call(owner, "POST", `${base()}/posts/${draft.body.post.id}/publish`);
    expect(plain.status).toBe(200);

    const draft2 = await call<{ post: { id: string } }>(owner, "POST", `${base()}/posts`, {
      status: "draft",
      title: "d2",
      body: "d2",
    });
    const announced = await call<{ announced: boolean }>(
      owner,
      "POST",
      `${base()}/posts/${draft2.body.post.id}/publish`,
      { announceChannelId: generalId },
    );
    expect(announced.body.announced).toBe(true);
    expect(await lastMessageBody(generalId)).toHaveLength(1);
  });
});

function randomUuid(): string {
  return "99999999-9999-4999-8999-999999999999";
}

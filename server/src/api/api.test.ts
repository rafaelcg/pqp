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
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * The authorization matrix is the highest-risk untested surface in the app: a
 * missing membership check silently exposes another server's private channel.
 * These tests drive the real router, services and SQL against a real Postgres,
 * with only the identity layer stubbed.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

/** The identity the next request will authenticate as. */
let actor: { id: string; clerk_id: string } | null = null;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  verifyAuthHeader: async () => null,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { handleChatMessage, resetChatRateLimits } = await import(
  "../ws/chat.js"
);

let server: Server;
let baseUrl: string;

interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  as: { id: string; clerk_id: string } | null,
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
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
  };
}

describeDb("API authorization", () => {
  let owner: { id: string; clerk_id: string };
  let admin: { id: string; clerk_id: string };
  let member: { id: string; clerk_id: string };
  let outsider: { id: string; clerk_id: string };

  beforeAll(async () => {
    await initDb();
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => server.listen(0, done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    resetChatRateLimits();
    // servers/messages cascade; users are the only root we must clear.
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, server_invites, server_bans,
                channel_reads, message_mentions, message_reactions
       RESTART IDENTITY CASCADE`,
    );

    owner = await upsertUser({
      clerkId: "clerk_owner",
      displayName: "Owner",
      avatarUrl: null,
    });
    admin = await upsertUser({
      clerkId: "clerk_admin",
      displayName: "Admin",
      avatarUrl: null,
    });
    member = await upsertUser({
      clerkId: "clerk_member",
      displayName: "Member",
      avatarUrl: null,
    });
    outsider = await upsertUser({
      clerkId: "clerk_outsider",
      displayName: "Outsider",
      avatarUrl: null,
    });
  });

  async function makeServer() {
    const created = await call<{
      server: { id: string };
      channels: Array<{ id: string; type: string }>;
    }>(owner, "POST", "/api/servers", { name: "Test server" });
    expect(created.status).toBe(201);

    const serverId = created.body.server.id;
    const textChannel = created.body.channels.find((c) => c.type === "text")!;

    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [serverId, admin.id],
    );
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, member.id],
    );

    return { serverId, textChannelId: textChannel.id };
  }

  it("rejects unauthenticated requests", async () => {
    const res = await call(null, "GET", "/api/servers");
    expect(res.status).toBe(401);
  });

  it("only lists servers the caller belongs to", async () => {
    const { serverId } = await makeServer();

    const mine = await call<{ servers: Array<{ id: string }> }>(
      member,
      "GET",
      "/api/servers",
    );
    expect(mine.body.servers.map((s) => s.id)).toContain(serverId);

    const theirs = await call<{ servers: unknown[] }>(
      outsider,
      "GET",
      "/api/servers",
    );
    expect(theirs.body.servers).toHaveLength(0);
  });

  it("hides a server's channels from non-members", async () => {
    const { serverId } = await makeServer();
    const res = await call(outsider, "GET", `/api/servers/${serverId}/channels`);
    expect(res.status).toBe(404);
  });

  it("hides message history from non-members", async () => {
    const { textChannelId } = await makeServer();
    const res = await call(
      outsider,
      "GET",
      `/api/channels/${textChannelId}/messages`,
    );
    expect(res.status).toBe(404);
  });

  it("stops plain members from creating channels", async () => {
    const { serverId } = await makeServer();

    const asMember = await call(member, "POST", `/api/servers/${serverId}/channels`, {
      name: "nope",
      type: "text",
    });
    expect(asMember.status).toBe(403);

    const asAdmin = await call(admin, "POST", `/api/servers/${serverId}/channels`, {
      name: "yes",
      type: "text",
    });
    expect(asAdmin.status).toBe(201);
  });

  it("keeps private channels out of a plain member's channel list and history", async () => {
    const { serverId } = await makeServer();

    const created = await call<{ channel: { id: string } }>(
      owner,
      "POST",
      `/api/servers/${serverId}/channels`,
      { name: "secret", type: "text", isPrivate: true },
    );
    expect(created.status).toBe(201);
    const privateId = created.body.channel.id;

    const memberChannels = await call<{ channels: Array<{ id: string }> }>(
      member,
      "GET",
      `/api/servers/${serverId}/channels`,
    );
    expect(memberChannels.body.channels.map((c) => c.id)).not.toContain(privateId);

    const history = await call(
      member,
      "GET",
      `/api/channels/${privateId}/messages`,
    );
    expect(history.status).toBe(404);

    // Admins see every channel in their server by design.
    const adminChannels = await call<{ channels: Array<{ id: string }> }>(
      admin,
      "GET",
      `/api/servers/${serverId}/channels`,
    );
    expect(adminChannels.body.channels.map((c) => c.id)).toContain(privateId);

    // Granting access opens it up.
    const granted = await call(owner, "POST", `/api/channels/${privateId}/members`, {
      userId: member.id,
    });
    expect(granted.status).toBe(201);

    const after = await call(member, "GET", `/api/channels/${privateId}/messages`);
    expect(after.status).toBe(200);
  });

  it("keeps owner and admin access when a public channel is made private", async () => {
    const { serverId, textChannelId } = await makeServer();

    expect(
      (
        await call(owner, "PATCH", `/api/channels/${textChannelId}`, {
          isPrivate: true,
        })
      ).status,
    ).toBe(200);

    // Owners and admins see every channel in their server, with or without a
    // channel_members row — the eviction path must use the same rule.
    expect(
      (await call(owner, "GET", `/api/channels/${textChannelId}/messages`))
        .status,
    ).toBe(200);
    expect(
      (await call(admin, "GET", `/api/channels/${textChannelId}/messages`))
        .status,
    ).toBe(200);
    expect(
      (await call(member, "GET", `/api/channels/${textChannelId}/messages`))
        .status,
    ).toBe(404);

    const visible = await call<{ channels: Array<{ id: string }> }>(
      member,
      "GET",
      `/api/servers/${serverId}/channels`,
    );
    expect(visible.body.channels.map((c) => c.id)).not.toContain(textChannelId);
  });

  it("only lets the owner change roles", async () => {
    const { serverId } = await makeServer();

    const byAdmin = await call(
      admin,
      "PATCH",
      `/api/servers/${serverId}/members/${member.id}`,
      { role: "admin" },
    );
    expect(byAdmin.status).toBe(403);

    const byOwner = await call(
      owner,
      "PATCH",
      `/api/servers/${serverId}/members/${member.id}`,
      { role: "admin" },
    );
    expect(byOwner.status).toBe(200);
  });

  it("only lets the owner delete or rename the server", async () => {
    const { serverId } = await makeServer();

    expect(
      (await call(admin, "PATCH", `/api/servers/${serverId}`, { name: "x" })).status,
    ).toBe(403);
    expect((await call(admin, "DELETE", `/api/servers/${serverId}`)).status).toBe(
      403,
    );
    expect(
      (await call(owner, "PATCH", `/api/servers/${serverId}`, { name: "Renamed" }))
        .status,
    ).toBe(200);
    expect((await call(owner, "DELETE", `/api/servers/${serverId}`)).status).toBe(
      200,
    );
  });

  it("refuses to let the owner leave and abandon the server", async () => {
    const { serverId } = await makeServer();
    const res = await call(owner, "POST", `/api/servers/${serverId}/leave`);
    expect(res.status).toBe(400);
  });

  describe("moderation", () => {
    it("lets an admin kick a member but not another admin or the owner", async () => {
      const { serverId } = await makeServer();

      expect(
        (
          await call(admin, "DELETE", `/api/servers/${serverId}/members/${owner.id}`, {
            ban: false,
          })
        ).status,
      ).toBe(403);

      const secondAdmin = await upsertUser({
        clerkId: "clerk_admin2",
        displayName: "Admin Two",
        avatarUrl: null,
      });
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'admin')`,
        [serverId, secondAdmin.id],
      );
      expect(
        (
          await call(
            admin,
            "DELETE",
            `/api/servers/${serverId}/members/${secondAdmin.id}`,
            { ban: false },
          )
        ).status,
      ).toBe(403);

      expect(
        (
          await call(admin, "DELETE", `/api/servers/${serverId}/members/${member.id}`, {
            ban: false,
          })
        ).status,
      ).toBe(200);
    });

    it("stops a banned user from rejoining with an invite", async () => {
      const { serverId } = await makeServer();

      const invite = await call<{ invite: { code: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/invites`,
        {},
      );
      const code = invite.body.invite.code;

      expect(
        (
          await call(owner, "DELETE", `/api/servers/${serverId}/members/${member.id}`, {
            ban: true,
          })
        ).status,
      ).toBe(200);

      const rejoin = await call(member, "POST", `/api/invites/${code}/join`);
      expect(rejoin.status).toBe(400);

      // A different user can still use the same invite.
      expect((await call(outsider, "POST", `/api/invites/${code}/join`)).status).toBe(
        200,
      );
    });
  });

  describe("invites", () => {
    it("does not burn a use when an existing member re-opens the link", async () => {
      const { serverId } = await makeServer();

      const created = await call<{ invite: { code: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/invites`,
        { maxUses: 1 },
      );
      const code = created.body.invite.code;

      // Already a member: joining is a no-op and must not consume the single use.
      expect((await call(member, "POST", `/api/invites/${code}/join`)).status).toBe(
        200,
      );
      expect((await call(outsider, "POST", `/api/invites/${code}/join`)).status).toBe(
        200,
      );

      const third = await upsertUser({
        clerkId: "clerk_third",
        displayName: "Third",
        avatarUrl: null,
      });
      const exhausted = await call(third, "POST", `/api/invites/${code}/join`);
      expect(exhausted.status).toBe(400);
    });

    it("only lets managers create and list invites", async () => {
      const { serverId } = await makeServer();
      expect(
        (await call(member, "POST", `/api/servers/${serverId}/invites`, {})).status,
      ).toBe(403);
      expect(
        (await call(member, "GET", `/api/servers/${serverId}/invites`)).status,
      ).toBe(403);
    });
  });

  describe("messages", () => {
    async function postMessage(channelId: string, author = owner) {
      const result = await getPool().query<{ id: string }>(
        `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, $3) RETURNING id`,
        [channelId, author.id, "hello"],
      );
      return result.rows[0]!.id;
    }

    it("lets an author edit their own message and nobody else", async () => {
      const { textChannelId } = await makeServer();
      const messageId = await postMessage(textChannelId);

      expect(
        (await call(member, "PATCH", `/api/messages/${messageId}`, { body: "hack" }))
          .status,
      ).toBe(403);

      const edited = await call<{ message: { body: string; editedAt: string } }>(
        owner,
        "PATCH",
        `/api/messages/${messageId}`,
        { body: "edited" },
      );
      expect(edited.status).toBe(200);
      expect(edited.body.message.body).toBe("edited");
      expect(edited.body.message.editedAt).not.toBeNull();
    });

    it("lets moderators delete anyone's message, and members only their own", async () => {
      const { textChannelId } = await makeServer();

      const ownersMessage = await postMessage(textChannelId, owner);
      expect(
        (await call(member, "DELETE", `/api/messages/${ownersMessage}`)).status,
      ).toBe(403);
      expect(
        (await call(admin, "DELETE", `/api/messages/${ownersMessage}`)).status,
      ).toBe(200);

      const membersMessage = await postMessage(textChannelId, member);
      expect(
        (await call(member, "DELETE", `/api/messages/${membersMessage}`)).status,
      ).toBe(200);
    });

    it("hides a message in another server from an outsider", async () => {
      const { textChannelId } = await makeServer();
      const messageId = await postMessage(textChannelId);
      expect(
        (await call(outsider, "PATCH", `/api/messages/${messageId}`, { body: "x" }))
          .status,
      ).toBe(404);
    });

    it("paginates history with a stable cursor", async () => {
      const { textChannelId } = await makeServer();
      for (let i = 0; i < 5; i++) {
        await getPool().query(
          `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, $3)`,
          [textChannelId, owner.id, `m${i}`],
        );
      }

      const first = await call<{
        messages: Array<{ id: string; body: string }>;
        hasMore: boolean;
      }>(owner, "GET", `/api/channels/${textChannelId}/messages?limit=2`);
      expect(first.body.messages.map((m) => m.body)).toEqual(["m3", "m4"]);
      expect(first.body.hasMore).toBe(true);

      const second = await call<{
        messages: Array<{ body: string }>;
        hasMore: boolean;
      }>(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?limit=2&before=${first.body.messages[0]!.id}`,
      );
      expect(second.body.messages.map((m) => m.body)).toEqual(["m1", "m2"]);
    });

    it("clamps an absurd limit instead of scanning the whole channel", async () => {
      const { textChannelId } = await makeServer();
      const res = await call(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?limit=100000000`,
      );
      expect(res.status).toBe(200);
    });

    it("rejects a malformed cursor with 400, not 500", async () => {
      const { textChannelId } = await makeServer();
      const res = await call(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?before=not-a-uuid`,
      );
      expect(res.status).toBe(400);
    });

    it("rejects a cursor whose message was deleted, rather than claiming history ran out", async () => {
      const { textChannelId } = await makeServer();
      for (let i = 0; i < 3; i++) {
        await getPool().query(
          `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, $3)`,
          [textChannelId, owner.id, `m${i}`],
        );
      }
      const cursor = await postMessage(textChannelId);
      await call(owner, "DELETE", `/api/messages/${cursor}`);

      const res = await call(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?before=${cursor}`,
      );
      expect(res.status).toBe(400);
    });
  });

  describe("replies", () => {
    interface HistoryMessage {
      id: string;
      body: string;
      replyTo: {
        id: string;
        authorId: string | null;
        authorName: string | null;
        excerpt: string;
        deleted: boolean;
      } | null;
    }

    /** The chat handler only ever touches these three members of a socket. */
    function fakeSocket(): WebSocket {
      return {
        readyState: 1,
        send: () => {},
        on: () => {},
      } as unknown as WebSocket;
    }

    async function asDbUser(id: string): Promise<DbUser> {
      const result = await getPool().query<DbUser>(
        `SELECT * FROM users WHERE id = $1`,
        [id],
      );
      return result.rows[0]!;
    }

    /** Replies are only creatable over the socket, so these drive it directly. */
    async function send(
      as: { id: string },
      channelId: string,
      body: string,
      replyToId?: string,
    ) {
      await handleChatMessage(
        { socket: fakeSocket(), user: await asDbUser(as.id) },
        {
          type: "message-create",
          channelId,
          body,
          ...(replyToId ? { replyToId } : {}),
        },
      );
    }

    async function history(
      as: { id: string; clerk_id: string },
      channelId: string,
    ): Promise<HistoryMessage[]> {
      const res = await call<{ messages: HistoryMessage[] }>(
        as,
        "GET",
        `/api/channels/${channelId}/messages`,
      );
      expect(res.status).toBe(200);
      return res.body.messages;
    }

    async function mentionCount(): Promise<number> {
      const result = await getPool().query(`SELECT 1 FROM message_mentions`);
      return result.rowCount ?? 0;
    }

    it("carries a snapshot of the message it answers", async () => {
      const { textChannelId } = await makeServer();
      await send(owner, textChannelId, "the original question");
      const [parent] = await history(owner, textChannelId);

      await send(member, textChannelId, "the answer", parent!.id);

      const messages = await history(owner, textChannelId);
      expect(messages.map((m) => m.body)).toEqual([
        "the original question",
        "the answer",
      ]);
      expect(messages[0]!.replyTo).toBeNull();
      expect(messages[1]!.replyTo).toEqual({
        id: parent!.id,
        authorId: owner.id,
        authorName: "Owner",
        excerpt: "the original question",
        deleted: false,
      });
    });

    it("counts a reply as a mention of the person being answered", async () => {
      const { serverId, textChannelId } = await makeServer();
      await send(owner, textChannelId, "question");
      const [parent] = await history(owner, textChannelId);
      await send(member, textChannelId, "answer", parent!.id);

      const unread = await call<{
        unread: Array<{ channelId: string; count: number; mentions: number }>;
      }>(owner, "GET", `/api/servers/${serverId}/unread`);
      const row = unread.body.unread.find((u) => u.channelId === textChannelId);
      expect(row?.mentions).toBe(1);
    });

    it("does not notify someone for answering themselves", async () => {
      const { textChannelId } = await makeServer();
      await send(owner, textChannelId, "thinking out loud");
      const [parent] = await history(owner, textChannelId);
      await send(owner, textChannelId, "and the answer", parent!.id);

      expect(await mentionCount()).toBe(0);
    });

    it("keeps the reply notification when the reply is edited", async () => {
      const { textChannelId } = await makeServer();
      await send(owner, textChannelId, "question");
      const [parent] = await history(owner, textChannelId);
      await send(member, textChannelId, "answer", parent!.id);
      const messages = await history(owner, textChannelId);

      const edited = await call(
        member,
        "PATCH",
        `/api/messages/${messages[1]!.id}`,
        { body: "answer, corrected" },
      );
      expect(edited.status).toBe(200);
      // An edit wipes and re-derives the mention rows; the reply must survive it.
      expect(await mentionCount()).toBe(1);
    });

    it("refuses a parent that lives in another channel", async () => {
      const { serverId, textChannelId } = await makeServer();
      const other = await call<{ channel: { id: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/channels`,
        { name: "elsewhere", type: "text" },
      );
      const otherChannelId = other.body.channel.id;
      await send(owner, otherChannelId, "over here");
      const [foreign] = await history(owner, otherChannelId);

      await send(member, textChannelId, "smuggled", foreign!.id);

      expect(await history(owner, textChannelId)).toHaveLength(0);
    });

    it("still posts when the message being answered is already gone", async () => {
      const { textChannelId } = await makeServer();
      // A parent deleted while the reply was being typed is an ordinary race;
      // throwing away what somebody wrote would be the worse failure.
      await send(
        member,
        textChannelId,
        "answer",
        "00000000-0000-4000-8000-0000000000ff",
      );

      const messages = await history(owner, textChannelId);
      expect(messages.map((m) => m.body)).toEqual(["answer"]);
      expect(messages[0]!.replyTo).toBeNull();
    });

    it("keeps replies alive when the message they answer is deleted", async () => {
      const { textChannelId } = await makeServer();
      await send(owner, textChannelId, "question");
      const [parent] = await history(owner, textChannelId);
      await send(member, textChannelId, "answer", parent!.id);

      expect(
        (await call(owner, "DELETE", `/api/messages/${parent!.id}`)).status,
      ).toBe(200);

      // SET NULL, not CASCADE: the answer outlives the question.
      const messages = await history(owner, textChannelId);
      expect(messages.map((m) => m.body)).toEqual(["answer"]);
      expect(messages[0]!.replyTo).toBeNull();
    });
  });

  describe("unread", () => {
    it("counts other people's messages until the channel is marked read", async () => {
      const { serverId, textChannelId } = await makeServer();

      await getPool().query(
        `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'hi @member')`,
        [textChannelId, owner.id],
      );
      await getPool().query(
        `INSERT INTO message_mentions (message_id, user_id)
         SELECT id, $2 FROM messages WHERE channel_id = $1`,
        [textChannelId, member.id],
      );

      const before = await call<{
        unread: Array<{ channelId: string; count: number; mentions: number }>;
      }>(member, "GET", `/api/servers/${serverId}/unread`);
      const row = before.body.unread.find((u) => u.channelId === textChannelId);
      expect(row?.count).toBe(1);
      expect(row?.mentions).toBe(1);

      // The author never has unread of their own.
      const authorView = await call<{
        unread: Array<{ channelId: string; count: number }>;
      }>(owner, "GET", `/api/servers/${serverId}/unread`);
      expect(
        authorView.body.unread.find((u) => u.channelId === textChannelId)?.count,
      ).toBe(0);

      expect(
        (await call(member, "POST", `/api/channels/${textChannelId}/read`)).status,
      ).toBe(200);

      const after = await call<{
        unread: Array<{ channelId: string; count: number }>;
      }>(member, "GET", `/api/servers/${serverId}/unread`);
      expect(
        after.body.unread.find((u) => u.channelId === textChannelId)?.count,
      ).toBe(0);
    });
  });

  describe("ownership", () => {
    it("refuses to hand the server to someone who is not a member", async () => {
      const { serverId } = await makeServer();
      const res = await call(owner, "PATCH", `/api/servers/${serverId}`, {
        ownerId: outsider.id,
      });
      expect(res.status).toBe(400);
    });

    it("swaps owner and previous owner roles atomically", async () => {
      const { serverId } = await makeServer();
      expect(
        (
          await call(owner, "PATCH", `/api/servers/${serverId}`, {
            ownerId: admin.id,
          })
        ).status,
      ).toBe(200);

      const members = await call<{
        members: Array<{ id: string; role: string }>;
      }>(admin, "GET", `/api/servers/${serverId}/members`);
      const roles = Object.fromEntries(
        members.body.members.map((m) => [m.id, m.role]),
      );
      expect(roles[admin.id]).toBe("owner");
      expect(roles[owner.id]).toBe("admin");

      // The old owner may no longer do owner-only things.
      expect(
        (await call(owner, "DELETE", `/api/servers/${serverId}`)).status,
      ).toBe(403);
    });
  });

  describe("preferences", () => {
    // Deliberately not typed from the shared schema: these assertions are about
    // what actually reaches and leaves the database, so a mistake in the schema
    // should fail them rather than be assumed away.
    interface PrefsBody {
      preferences: Record<string, unknown>;
    }

    it("round-trips a patch and carries it on /api/me", async () => {
      const saved = await call<PrefsBody>(owner, "PATCH", "/api/me/preferences", {
        theme: "light",
        muteOnJoin: true,
        inputVolume: 1.5,
      });
      expect(saved.status).toBe(200);
      expect(saved.body.preferences).toEqual({
        theme: "light",
        muteOnJoin: true,
        inputVolume: 1.5,
      });

      // The bootstrap request already carries them, so the client needs no
      // second round-trip before it can paint.
      const me = await call<PrefsBody>(owner, "GET", "/api/me");
      expect(me.body.preferences).toEqual({
        theme: "light",
        muteOnJoin: true,
        inputVolume: 1.5,
      });
    });

    it("merges shallowly instead of replacing the stored object", async () => {
      const fresh = await call<PrefsBody>(owner, "GET", "/api/me");
      expect(fresh.body.preferences).toEqual({});

      await call(owner, "PATCH", "/api/me/preferences", {
        theme: "dark",
        compactPeers: true,
        outputVolume: 0.4,
      });

      // A client that only knows about `theme` must not drop the rest.
      const merged = await call<PrefsBody>(owner, "PATCH", "/api/me/preferences", {
        theme: "light",
      });
      expect(merged.body.preferences).toEqual({
        theme: "light",
        compactPeers: true,
        outputVolume: 0.4,
      });
    });

    it("keeps one account's preferences out of another's", async () => {
      await call(owner, "PATCH", "/api/me/preferences", { theme: "light" });
      const other = await call<PrefsBody>(member, "GET", "/api/me");
      expect(other.body.preferences).toEqual({});
    });

    it("rejects values outside the allowed set with 400 and stores nothing", async () => {
      const invalid = [
        { theme: "neon" },
        { inputVolume: 4 },
        { outputVolume: -1 },
        { muteOnJoin: "yes" },
      ];
      for (const body of invalid) {
        const res = await call(owner, "PATCH", "/api/me/preferences", body);
        expect(res.status).toBe(400);
      }

      const me = await call<PrefsBody>(owner, "GET", "/api/me");
      expect(me.body.preferences).toEqual({});
    });

    it("drops audio device ids, which name nothing on another machine", async () => {
      const saved = await call<PrefsBody>(owner, "PATCH", "/api/me/preferences", {
        muteOnJoin: true,
        inputDeviceId: "3f9c…-mic",
        outputDeviceId: "a71b…-speakers",
      });
      expect(saved.status).toBe(200);
      expect(saved.body.preferences).toEqual({ muteOnJoin: true });

      const me = await call<PrefsBody>(owner, "GET", "/api/me");
      expect(me.body.preferences).toEqual({ muteOnJoin: true });
    });

    it("rejects unauthenticated writes", async () => {
      const res = await call(null, "PATCH", "/api/me/preferences", {
        theme: "dark",
      });
      expect(res.status).toBe(401);
    });
  });

  describe("gifs", () => {
    interface GifsBody {
      gifs: Array<Record<string, unknown>>;
    }

    /** One upstream entry, shaped like GIPHY's — trimmed to what we read. */
    function giphyEntry(overrides: Record<string, unknown> = {}) {
      return {
        id: "abc123",
        title: "a cat  ",
        images: {
          downsized_medium: {
            url: "https://media3.giphy.com/media/abc123/giphy.gif?cid=track&ct=g",
            width: "480",
            height: "270",
          },
          fixed_width: {
            url: "https://media3.giphy.com/media/abc123/200w.gif?cid=track",
            width: "200",
            height: "112",
          },
          fixed_width_still: {
            url: "https://media3.giphy.com/media/abc123/200w_s.gif",
            width: "200",
            height: "112",
          },
        },
        ...overrides,
      };
    }

    /** URLs GIPHY was asked for, so the forced parameters can be asserted. */
    let upstreamCalls: string[];
    let upstreamReply: () => Response;
    const realFetch = globalThis.fetch;

    beforeEach(() => {
      upstreamCalls = [];
      upstreamReply = () =>
        new Response(JSON.stringify({ data: [giphyEntry()] }), {
          headers: { "Content-Type": "application/json" },
        });

      process.env.GIPHY_API_KEY = "test-key";
      // Only GIPHY is intercepted: `call()` reaches the API under test with the
      // same global, and stubbing that too would break every request here.
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = String(input);
        if (!url.startsWith("https://api.giphy.com/")) {
          return realFetch(input, init);
        }
        upstreamCalls.push(url);
        return Promise.resolve(upstreamReply());
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      delete process.env.GIPHY_API_KEY;
    });

    it("normalises upstream results to the wire shape and drops tracking", async () => {
      const res = await call<GifsBody>(owner, "GET", "/api/gifs/search?q=cat");
      expect(res.status).toBe(200);
      expect(res.body.gifs).toEqual([
        {
          id: "abc123",
          // The chosen URL becomes a message body that outlives the session
          // that fetched it, so the per-request analytics id must not ride along.
          url: "https://media3.giphy.com/media/abc123/giphy.gif",
          previewUrl: "https://media3.giphy.com/media/abc123/200w.gif",
          previewStillUrl: "https://media3.giphy.com/media/abc123/200w_s.gif",
          width: 200,
          height: 112,
          title: "a cat",
        },
      ]);
    });

    it("forces a pg-13 rating on every upstream call", async () => {
      await call(owner, "GET", "/api/gifs/search?q=cat");
      await call(owner, "GET", "/api/gifs/trending");
      expect(upstreamCalls).toHaveLength(2);
      for (const url of upstreamCalls) {
        expect(new URL(url).searchParams.get("rating")).toBe("pg-13");
      }
    });

    it("never leaks the API key to the caller", async () => {
      const res = await call(owner, "GET", "/api/gifs/search?q=cat");
      expect(JSON.stringify(res.body)).not.toContain("test-key");
      expect(new URL(upstreamCalls[0]!).searchParams.get("api_key")).toBe(
        "test-key",
      );
    });

    it("clamps the page size a caller may ask for", async () => {
      await call(owner, "GET", "/api/gifs/trending?limit=5000");
      expect(new URL(upstreamCalls[0]!).searchParams.get("limit")).toBe("50");
    });

    it("drops a result whose media host is outside the allowlist", async () => {
      // A provider that ever served a third-party URL would otherwise get an
      // <img> pointed at it in every reader's browser.
      upstreamReply = () =>
        new Response(
          JSON.stringify({
            data: [
              giphyEntry({
                images: {
                  original: { url: "https://evil.example/x.gif", width: "1", height: "1" },
                },
              }),
              giphyEntry(),
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        );

      const res = await call<GifsBody>(owner, "GET", "/api/gifs/trending");
      expect(res.body.gifs).toHaveLength(1);
      expect(res.body.gifs[0]!.url).toBe(
        "https://media3.giphy.com/media/abc123/giphy.gif",
      );
    });

    it("rejects a search with no query", async () => {
      const res = await call(owner, "GET", "/api/gifs/search");
      expect(res.status).toBe(400);
      expect(upstreamCalls).toHaveLength(0);
    });

    it("answers 502 when the provider fails, not 500", async () => {
      upstreamReply = () => new Response("nope", { status: 500 });
      const res = await call(owner, "GET", "/api/gifs/trending");
      expect(res.status).toBe(502);
    });

    it("reports itself disabled and refuses with 503 when no key is set", async () => {
      delete process.env.GIPHY_API_KEY;

      const config = await call<{ enabled: boolean }>(
        owner,
        "GET",
        "/api/gifs/config",
      );
      expect(config.body.enabled).toBe(false);

      for (const path of ["/api/gifs/search?q=cat", "/api/gifs/trending"]) {
        const res = await call(owner, "GET", path);
        expect(res.status).toBe(503);
      }
      expect(upstreamCalls).toHaveLength(0);
    });

    it("treats a placeholder key as no key at all", async () => {
      // `.env.example` copies are the usual source of this.
      process.env.GIPHY_API_KEY = "your-giphy-api-key";
      const res = await call(owner, "GET", "/api/gifs/trending");
      expect(res.status).toBe(503);
    });

    it("reports itself enabled when a key is set", async () => {
      const res = await call<{ enabled: boolean }>(
        owner,
        "GET",
        "/api/gifs/config",
      );
      expect(res.body.enabled).toBe(true);
    });

    it("spends someone else's quota only for signed-in callers", async () => {
      const res = await call(null, "GET", "/api/gifs/search?q=cat");
      expect(res.status).toBe(401);
      expect(upstreamCalls).toHaveLength(0);
    });

    it("rate limits search harder than ordinary reads", async () => {
      let last = 200;
      for (let attempt = 0; attempt < 40 && last === 200; attempt += 1) {
        last = (await call(owner, "GET", "/api/gifs/trending")).status;
      }
      expect(last).toBe(429);
      // The bucket is spent before the provider is called again.
      expect(upstreamCalls.length).toBeLessThan(40);
    });
  });

  describe("request hygiene", () => {
    it("answers 404 for a malformed id rather than surfacing a database error", async () => {
      const res = await call(owner, "GET", "/api/servers/not-a-uuid/channels");
      expect(res.status).toBe(404);
    });

    it("answers 405 when the path exists under a different method", async () => {
      const res = await call(owner, "DELETE", "/api/me");
      expect(res.status).toBe(405);
    });

    it("rejects invalid bodies with 400", async () => {
      const { serverId } = await makeServer();
      const res = await call(owner, "POST", `/api/servers/${serverId}/channels`, {
        name: "has spaces and $ymbols",
        type: "text",
      });
      expect(res.status).toBe(400);
    });

    it("rejects an oversized body with 413", async () => {
      const res = await call(owner, "PATCH", "/api/me", {
        displayName: "x".repeat(100_000),
      });
      expect(res.status).toBe(413);
    });
  });
});

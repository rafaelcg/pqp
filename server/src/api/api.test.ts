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
import { parseSearchSnippet } from "@pqp/shared";
import type { DbUser } from "../db.js";

/**
 * The authorization matrix is the highest-risk untested surface in the app: a
 * missing membership check silently exposes another server's private channel.
 * These tests drive the real router, services and SQL against a real Postgres,
 * with only the identity layer stubbed.
 */

// TEST_DATABASE_URL wins. These tests truncate the tables they touch, and the
// other order made the opt-out unreachable: a developer always has
// DATABASE_URL set, so it always won and `pnpm test` silently ate the dev
// database. CI sets only DATABASE_URL and is unaffected.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
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
const {
  handleVoiceMessage,
  isSocketInVoice,
  removeVoicePeerBySocket,
  resetVoiceRateLimits,
} = await import("../ws/voice.js");

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
    resetVoiceRateLimits();
    // servers/messages cascade; users are the only root we must clear.
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, server_invites, server_bans,
                channel_reads, message_mentions, message_reactions,
                message_attachments, user_blocks, dm_pairs
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

  /** The chat handler only ever touches these three members of a socket. */
  function fakeSocket(): WebSocket {
    return {
      readyState: 1,
      send: () => {},
      on: () => {},
    } as unknown as WebSocket;
  }

  /**
   * A socket that keeps what was fanned out to it, so a test can assert on what
   * a *third party* received rather than on what the sender's own call returned.
   * Eviction is only observable this way: the membership row and the socket's
   * live view are two separate pieces of state, and a leak in the second one
   * looks entirely correct from every HTTP response.
   */
  function recordingSocket(): { socket: WebSocket; received: string[] } {
    const received: string[] = [];
    const socket = {
      readyState: 1,
      send: (payload: string) => received.push(payload),
      on: () => {},
    } as unknown as WebSocket;
    return { socket, received };
  }

  function typesOf(received: string[]): string[] {
    return received.map((raw) => (JSON.parse(raw) as { type: string }).type);
  }

  async function asDbUser(id: string): Promise<DbUser> {
    const result = await getPool().query<DbUser>(
      `SELECT * FROM users WHERE id = $1`,
      [id],
    );
    return result.rows[0]!;
  }

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

    it("centres a page on the message a permalink points at", async () => {
      const { textChannelId } = await makeServer();
      const ids: string[] = [];
      for (let i = 0; i < 9; i++) {
        const inserted = await getPool().query<{ id: string }>(
          `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, $3) RETURNING id`,
          [textChannelId, owner.id, `m${i}`],
        );
        ids.push(inserted.rows[0]!.id);
      }

      const middle = await call<{
        messages: Array<{ id: string; body: string }>;
        hasMore: boolean;
        hasNewer: boolean;
      }>(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?limit=4&around=${ids[4]}`,
      );
      expect(middle.body.messages.map((m) => m.body)).toEqual([
        "m3",
        "m4",
        "m5",
        "m6",
      ]);
      expect(middle.body.hasMore).toBe(true);
      expect(middle.body.hasNewer).toBe(true);

      // The anchor rides in the older half, so the newest message still centres
      // on itself rather than falling off the end of its own page.
      const newest = await call<{
        messages: Array<{ body: string }>;
        hasMore: boolean;
        hasNewer: boolean;
      }>(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?limit=4&around=${ids[8]}`,
      );
      expect(newest.body.messages.map((m) => m.body)).toEqual(["m7", "m8"]);
      expect(newest.body.hasNewer).toBe(false);
      expect(newest.body.hasMore).toBe(true);
    });

    it("walks back and forth around an anchor without repeating or skipping", async () => {
      const { textChannelId } = await makeServer();
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const inserted = await getPool().query<{ id: string }>(
          `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, $3) RETURNING id`,
          [textChannelId, owner.id, `m${i}`],
        );
        ids.push(inserted.rows[0]!.id);
      }

      type Page = {
        messages: Array<{ id: string; body: string }>;
        hasMore: boolean;
        hasNewer: boolean;
      };
      const around = await call<Page>(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?limit=4&around=${ids[5]}`,
      );
      expect(around.body.messages.map((m) => m.body)).toEqual([
        "m4",
        "m5",
        "m6",
        "m7",
      ]);

      const older = await call<Page>(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?limit=2&before=${around.body.messages[0]!.id}`,
      );
      expect(older.body.messages.map((m) => m.body)).toEqual(["m2", "m3"]);
      expect(older.body.hasNewer).toBe(true);

      const newer = await call<Page>(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?limit=2&after=${around.body.messages[3]!.id}`,
      );
      expect(newer.body.messages.map((m) => m.body)).toEqual(["m8", "m9"]);
      expect(newer.body.hasMore).toBe(true);
      expect(newer.body.hasNewer).toBe(false);

      const walked = [
        ...older.body.messages,
        ...around.body.messages,
        ...newer.body.messages,
      ].map((m) => m.id);
      expect(walked).toEqual(ids.slice(2));
      expect(new Set(walked).size).toBe(walked.length);
    });

    it("rejects an anchor whose message was deleted, rather than paging from nowhere", async () => {
      const { textChannelId } = await makeServer();
      for (let i = 0; i < 3; i++) {
        await getPool().query(
          `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, $3)`,
          [textChannelId, owner.id, `m${i}`],
        );
      }
      const anchor = await postMessage(textChannelId);
      await call(owner, "DELETE", `/api/messages/${anchor}`);

      const res = await call(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?around=${anchor}`,
      );
      expect(res.status).toBe(400);
    });

    it("refuses to guess which end a page hangs off when cursors are combined", async () => {
      const { textChannelId } = await makeServer();
      const anchor = await postMessage(textChannelId);
      const res = await call(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages?around=${anchor}&before=${anchor}`,
      );
      expect(res.status).toBe(400);
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

  describe("attachments", () => {
    /**
     * Storage that is configured but never contacted. Presigning is pure HMAC
     * over strings, so the routes under test — mint, refresh, read — need
     * credentials to exist and a bucket to name, and nothing else. The signature
     * itself is proved against a real MinIO in `lib/s3.test.ts`.
     */
    function configureStorage() {
      process.env.S3_ENDPOINT = "https://storage.test";
      process.env.S3_BUCKET = "pqp-test";
      process.env.S3_ACCESS_KEY_ID = "test-access-key";
      process.env.S3_SECRET_ACCESS_KEY = "test-secret-key";
      process.env.S3_FORCE_PATH_STYLE = "true";
    }

    afterEach(() => {
      for (const name of [
        "S3_ENDPOINT",
        "S3_BUCKET",
        "S3_ACCESS_KEY_ID",
        "S3_SECRET_ACCESS_KEY",
        "S3_FORCE_PATH_STYLE",
        "MAX_ATTACHMENT_BYTES",
      ]) {
        delete process.env[name];
      }
    });

    function mintBody(overrides: Record<string, unknown> = {}) {
      return {
        filename: "shot.png",
        contentType: "image/png",
        byteSize: 1024,
        ...overrides,
      };
    }

    async function postMessage(channelId: string, author = owner) {
      const result = await getPool().query<{ id: string }>(
        `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'look')
         RETURNING id`,
        [channelId, author.id],
      );
      return result.rows[0]!.id;
    }

    /**
     * A claimed attachment, inserted directly. The claim path needs a real HEAD
     * against a real object to accept anything, and it has its own suite; what
     * these tests are about is who the API will hand the row to afterwards.
     */
    async function seedAttachment(
      channelId: string,
      messageId: string,
      uploader = owner,
    ) {
      const result = await getPool().query<{ id: string }>(
        `INSERT INTO message_attachments
           (message_id, channel_id, uploader_id, storage_key, filename,
            content_type, byte_size)
         VALUES ($1, $2, $3, $4, 'shot.png', 'image/png', 1024)
         RETURNING id`,
        [messageId, channelId, uploader.id, `${channelId}/seeded.png`],
      );
      return result.rows[0]!.id;
    }

    async function attachmentCount(): Promise<number> {
      const result = await getPool().query(`SELECT 1 FROM message_attachments`);
      return result.rowCount ?? 0;
    }

    it("reports whether this deployment can accept uploads at all", async () => {
      const off = await call<{ enabled: boolean }>(
        owner,
        "GET",
        "/api/attachments/config",
      );
      expect(off.status).toBe(200);
      expect(off.body.enabled).toBe(false);

      configureStorage();
      const on = await call<{ enabled: boolean; maxBytes: number }>(
        owner,
        "GET",
        "/api/attachments/config",
      );
      expect(on.body.enabled).toBe(true);
      // The composer sizes its own check off this, so it has to be the number
      // the server would actually enforce.
      expect(on.body.maxBytes).toBe(10 * 1024 * 1024);
    });

    it("refuses to mint an upload URL for a channel the caller cannot see", async () => {
      configureStorage();
      const { serverId, textChannelId } = await makeServer();

      const byOutsider = await call(
        outsider,
        "POST",
        `/api/channels/${textChannelId}/attachments`,
        mintBody(),
      );
      expect(byOutsider.status).toBe(404);

      const created = await call<{ channel: { id: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/channels`,
        { name: "secret", type: "text", isPrivate: true },
      );
      const byNonMember = await call(
        member,
        "POST",
        `/api/channels/${created.body.channel.id}/attachments`,
        mintBody(),
      );
      expect(byNonMember.status).toBe(404);

      // Not even a reserved row: minting *is* the write, and a refused caller
      // must not be able to leave anything behind for the sweeper to pay for.
      expect(await attachmentCount()).toBe(0);

      const allowed = await call<{ attachmentId: string; uploadUrl: string }>(
        member,
        "POST",
        `/api/channels/${textChannelId}/attachments`,
        mintBody(),
      );
      expect(allowed.status).toBe(201);
      expect(allowed.body.uploadUrl).toContain("X-Amz-Signature");
      // The key is the server's, derived from the content type — never the
      // filename the caller sent.
      const stored = await getPool().query<{ storage_key: string }>(
        `SELECT storage_key FROM message_attachments WHERE id = $1`,
        [allowed.body.attachmentId],
      );
      expect(stored.rows[0]!.storage_key).not.toContain("shot");
    });

    it("refuses to mint anything on a deployment with no storage", async () => {
      const { textChannelId } = await makeServer();
      const res = await call(
        owner,
        "POST",
        `/api/channels/${textChannelId}/attachments`,
        mintBody(),
      );
      expect(res.status).toBe(503);
      expect(await attachmentCount()).toBe(0);
    });

    it("answers 413 for a file over this deployment's own cap", async () => {
      configureStorage();
      // Under the shared ceiling the schema enforces, over what this server has
      // been told to accept — the only case that reaches the service's check.
      process.env.MAX_ATTACHMENT_BYTES = "1024";
      const { textChannelId } = await makeServer();

      const res = await call(
        owner,
        "POST",
        `/api/channels/${textChannelId}/attachments`,
        mintBody({ byteSize: 4096 }),
      );
      expect(res.status).toBe(413);
    });

    it("rejects a content type outside the allowlist", async () => {
      configureStorage();
      const { textChannelId } = await makeServer();
      const res = await call(
        owner,
        "POST",
        `/api/channels/${textChannelId}/attachments`,
        mintBody({ filename: "payload.html", contentType: "text/html" }),
      );
      expect(res.status).toBe(400);
      expect(await attachmentCount()).toBe(0);
    });

    it("hands a fresh URL only to someone who can see the channel", async () => {
      configureStorage();
      const { serverId } = await makeServer();
      const created = await call<{ channel: { id: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/channels`,
        { name: "secret", type: "text", isPrivate: true },
      );
      const privateId = created.body.channel.id;
      const attachmentId = await seedAttachment(
        privateId,
        await postMessage(privateId),
      );

      // 404 rather than 403, so refreshing a guessed id cannot be used to learn
      // that an attachment exists in a channel you are not in.
      expect(
        (await call(member, "GET", `/api/attachments/${attachmentId}/url`))
          .status,
      ).toBe(404);
      expect(
        (await call(outsider, "GET", `/api/attachments/${attachmentId}/url`))
          .status,
      ).toBe(404);

      const fresh = await call<{ url: string; expiresAt: string }>(
        owner,
        "GET",
        `/api/attachments/${attachmentId}/url`,
      );
      expect(fresh.status).toBe(200);
      expect(fresh.body.url).toContain("X-Amz-Signature");
      expect(Date.parse(fresh.body.expiresAt)).toBeGreaterThan(Date.now());

      // Granting access opens it, on the same predicate as history.
      await call(owner, "POST", `/api/channels/${privateId}/members`, {
        userId: member.id,
      });
      expect(
        (await call(member, "GET", `/api/attachments/${attachmentId}/url`))
          .status,
      ).toBe(200);
    });

    it("hides an attachment no message has claimed", async () => {
      configureStorage();
      const { textChannelId } = await makeServer();
      const minted = await call<{ attachmentId: string }>(
        owner,
        "POST",
        `/api/channels/${textChannelId}/attachments`,
        mintBody(),
      );

      // Until a message carries it, an upload is not content anyone can read —
      // not even the person who uploaded it.
      expect(
        (
          await call(
            owner,
            "GET",
            `/api/attachments/${minted.body.attachmentId}/url`,
          )
        ).status,
      ).toBe(404);
    });

    it("carries attachments on history, one presigned URL per row", async () => {
      configureStorage();
      const { textChannelId } = await makeServer();
      const messageId = await postMessage(textChannelId);
      await seedAttachment(textChannelId, messageId);

      const res = await call<{
        messages: Array<{
          attachments: Array<{ filename: string; byteSize: number; url: string }>;
        }>;
      }>(owner, "GET", `/api/channels/${textChannelId}/messages`);

      const [attachment] = res.body.messages[0]!.attachments;
      expect(attachment!.filename).toBe("shot.png");
      // BIGINT arrives from node-postgres as a string; a read that forgot to
      // convert it fails `attachmentSchema` on the client.
      expect(attachment!.byteSize).toBe(1024);
      expect(attachment!.url).toContain("X-Amz-Signature");
    });

    it("does not post an empty message when every attachment failed", async () => {
      configureStorage();
      const { textChannelId } = await makeServer();
      const minted = await call<{ attachmentId: string }>(
        owner,
        "POST",
        `/api/channels/${textChannelId}/attachments`,
        mintBody(),
      );

      // Nothing was ever uploaded, so the HEAD guarding the claim finds nothing
      // and the attachment is dropped. A message whose only content was that
      // file is then not a message at all, and the frame goes the way every
      // other frame that describes nothing goes.
      await handleChatMessage(
        { socket: fakeSocket(), user: await asDbUser(owner.id) },
        {
          type: "message-create",
          channelId: textChannelId,
          body: "",
          attachmentIds: [minted.body.attachmentId],
        },
      );

      const history = await call<{ messages: unknown[] }>(
        owner,
        "GET",
        `/api/channels/${textChannelId}/messages`,
      );
      expect(history.body.messages).toHaveLength(0);
      // The reserved row survives the rollback and is left to the sweeper,
      // which is the only thing that ever deletes an unclaimed upload.
      expect(await attachmentCount()).toBe(1);
    });

    it("lets a message with attachments be edited down to no caption", async () => {
      configureStorage();
      const { textChannelId } = await makeServer();
      const plain = await postMessage(textChannelId);
      const withFile = await postMessage(textChannelId);
      await seedAttachment(textChannelId, withFile);

      // Text and nothing else has nothing left when the text goes: that is a
      // delete, and the edit schema keeps refusing it.
      expect(
        (await call(owner, "PATCH", `/api/messages/${plain}`, { body: "" }))
          .status,
      ).toBe(400);

      const edited = await call<{
        message: { body: string; attachments: unknown[] };
      }>(owner, "PATCH", `/api/messages/${withFile}`, { body: "" });
      expect(edited.status).toBe(200);
      expect(edited.body.message.body).toBe("");
      expect(edited.body.message.attachments).toHaveLength(1);
    });
  });

  describe("message search", () => {
    interface SearchBody {
      results: Array<{
        messageId: string;
        channelId: string;
        channelName: string;
        authorName: string;
        snippet: string;
        createdAt: string;
      }>;
      hasMore: boolean;
      nextCursor: string | null;
    }

    async function seed(channelId: string, body: string, author = owner) {
      const result = await getPool().query<{ id: string }>(
        `INSERT INTO messages (channel_id, author_id, body)
         VALUES ($1, $2, $3) RETURNING id`,
        [channelId, author.id, body],
      );
      return result.rows[0]!.id;
    }

    function search(
      as: { id: string; clerk_id: string },
      serverId: string,
      query: string,
      extra = "",
    ) {
      return call<SearchBody>(
        as,
        "GET",
        `/api/servers/${serverId}/search?q=${encodeURIComponent(query)}${extra}`,
      );
    }

    it("finds a message and says which channel it lives in", async () => {
      const { serverId, textChannelId } = await makeServer();
      const messageId = await seed(textChannelId, "the penguin waddles home");
      await seed(textChannelId, "nothing to see here");

      const res = await search(owner, serverId, "penguin");
      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);

      const [hit] = res.body.results;
      expect(hit!.messageId).toBe(messageId);
      expect(hit!.channelId).toBe(textChannelId);
      expect(hit!.channelName).toBe("general");
      expect(hit!.authorName).toBe("Owner");
      // The snippet marks the matched term rather than returning HTML.
      expect(
        parseSearchSnippet(hit!.snippet)
          .filter((segment) => segment.match)
          .map((segment) => segment.text),
      ).toContain("penguin");
    });

    it("stems, so a search finds the other forms of a word", async () => {
      const { serverId, textChannelId } = await makeServer();
      await seed(textChannelId, "we are deploying on friday");

      const res = await search(owner, serverId, "deploy");
      expect(res.body.results).toHaveLength(1);
    });

    it("never returns a private channel's messages to a non-member", async () => {
      const { serverId } = await makeServer();
      const created = await call<{ channel: { id: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/channels`,
        { name: "secret", type: "text", isPrivate: true },
      );
      const privateId = created.body.channel.id;
      await seed(privateId, "the passphrase is armadillo");

      const hidden = await search(member, serverId, "armadillo");
      expect(hidden.status).toBe(200);
      expect(hidden.body.results).toHaveLength(0);

      // Owners and admins keep access without a channel_members row, exactly as
      // the channel list and history do.
      expect((await search(owner, serverId, "armadillo")).body.results).toHaveLength(1);
      expect((await search(admin, serverId, "armadillo")).body.results).toHaveLength(1);

      await call(owner, "POST", `/api/channels/${privateId}/members`, {
        userId: member.id,
      });
      const granted = await search(member, serverId, "armadillo");
      expect(granted.body.results.map((r) => r.channelId)).toEqual([privateId]);
    });

    it("keeps results inside the server that was asked about", async () => {
      const mine = await makeServer();
      const other = await makeServer();
      await seed(mine.textChannelId, "shared word narwhal here");
      const elsewhere = await seed(other.textChannelId, "narwhal over there");

      const res = await search(owner, mine.serverId, "narwhal");
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results.map((r) => r.messageId)).not.toContain(elsewhere);
    });

    it("hides search from someone who is not in the server", async () => {
      const { serverId, textChannelId } = await makeServer();
      await seed(textChannelId, "narwhal");
      const res = await search(outsider, serverId, "narwhal");
      expect(res.status).toBe(404);
    });

    it("paginates without repeating or skipping a result", async () => {
      const { serverId, textChannelId } = await makeServer();
      const seeded: string[] = [];
      for (let i = 0; i < 5; i++) {
        // Varying length and repetition so the rows do not all rank identically,
        // which is what makes the rank half of the cursor load-bearing.
        seeded.push(
          await seed(
            textChannelId,
            i % 2 === 0
              ? `otter ${"padding ".repeat(i + 1)}`
              : `otter otter sighting ${i}`,
          ),
        );
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const res: ApiResult<SearchBody> = await search(
          owner,
          serverId,
          "otter",
          `&limit=2${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`,
        );
        expect(res.status).toBe(200);
        seen.push(...res.body.results.map((r) => r.messageId));
        cursor = res.body.nextCursor;
        if (!res.body.hasMore) {
          break;
        }
      }

      expect(new Set(seen).size).toBe(seen.length);
      expect([...seen].sort()).toEqual([...seeded].sort());
    });

    it("rejects a query that is too short, and a forged cursor, with 400", async () => {
      const { serverId } = await makeServer();
      expect((await search(owner, serverId, "a")).status).toBe(400);
      expect(
        (await search(owner, serverId, "otter", "&before=not-a-cursor")).status,
      ).toBe(400);
    });

    it("rate limits search harder than ordinary reads", async () => {
      const { serverId } = await makeServer();
      let last = 200;
      for (let attempt = 0; attempt < 40 && last === 200; attempt += 1) {
        last = (await search(owner, serverId, "otter")).status;
      }
      expect(last).toBe(429);
    });
  });

  describe("user discovery", () => {
    /** The whole shape a search result may ever have. */
    const PUBLIC_KEYS = ["avatarUrl", "displayName", "id", "tag", "username"];

    async function tagOf(userId: string): Promise<string> {
      const row = await getPool().query<{ username: string; discrim: string }>(
        `SELECT username, discriminator AS discrim FROM users WHERE id = $1`,
        [userId],
      );
      return `${row.rows[0]!.username}#${row.rows[0]!.discrim}`;
    }

    it("finds a user by exact tag, and never carries a clerk id", async () => {
      const tag = await tagOf(member.id);
      const res = await call<{ user: Record<string, unknown> }>(
        outsider,
        "GET",
        `/api/users/lookup?tag=${encodeURIComponent(tag)}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(member.id);
      expect(Object.keys(res.body.user).sort()).toEqual(PUBLIC_KEYS);
    });

    it("answers 400 for something that is not a tag and 404 for one nobody holds", async () => {
      expect(
        (await call(owner, "GET", "/api/users/lookup?tag=member")).status,
      ).toBe(400);
      expect(
        (await call(owner, "GET", "/api/users/lookup?tag=nobody%230001"))
          .status,
      ).toBe(404);
    });

    it("searches by prefix, excludes the caller, and stays inside the public shape", async () => {
      const res = await call<{ users: Array<Record<string, unknown>> }>(
        outsider,
        "GET",
        "/api/users/search?q=me",
      );
      expect(res.status).toBe(200);
      expect(res.body.users.map((u) => u.id)).toEqual([member.id]);
      expect(Object.keys(res.body.users[0]!).sort()).toEqual(PUBLIC_KEYS);

      const self = await call<{ users: Array<{ id: string }> }>(
        member,
        "GET",
        "/api/users/search?q=me",
      );
      expect(self.body.users.map((u) => u.id)).not.toContain(member.id);
    });

    it("refuses a query below the minimum length", async () => {
      expect((await call(owner, "GET", "/api/users/search?q=m")).status).toBe(
        400,
      );
    });

    it("does not let a LIKE wildcard widen a search", async () => {
      // `_` is legal in a username and is also a LIKE wildcard, so an
      // unescaped query turns a search for one person into a pattern match
      // over the directory.
      await getPool().query(`UPDATE users SET username = 'ab_cd' WHERE id = $1`, [
        member.id,
      ]);
      await getPool().query(`UPDATE users SET username = 'abxcd' WHERE id = $1`, [
        admin.id,
      ]);

      const res = await call<{ users: Array<{ id: string }> }>(
        outsider,
        "GET",
        "/api/users/search?q=ab_c",
      );
      expect(res.body.users.map((u) => u.id)).toEqual([member.id]);
    });

    it("throttles discovery on its own bucket", async () => {
      let last = 200;
      for (let i = 0; i < 25 && last === 200; i++) {
        last = (await call(owner, "GET", "/api/users/search?q=me")).status;
      }
      expect(last).toBe(429);
    });
  });

  describe("blocking", () => {
    it("blocks, lists and unblocks", async () => {
      const first = await call(member, "POST", "/api/blocks", {
        userId: outsider.id,
      });
      expect(first.status).toBe(201);
      // Blocking somebody already blocked is not an error and not a new block.
      expect(
        (await call(member, "POST", "/api/blocks", { userId: outsider.id }))
          .status,
      ).toBe(200);

      const listed = await call<{
        blocked: Array<Record<string, unknown>>;
      }>(member, "GET", "/api/blocks");
      expect(listed.body.blocked.map((b) => b.id)).toEqual([outsider.id]);
      expect(Object.keys(listed.body.blocked[0]!).sort()).toEqual([
        "avatarUrl",
        "blockedAt",
        "displayName",
        "id",
        "tag",
        "username",
      ]);

      expect(
        (await call(member, "DELETE", `/api/blocks/${outsider.id}`)).status,
      ).toBe(200);
      expect(
        (await call<{ blocked: unknown[] }>(member, "GET", "/api/blocks")).body
          .blocked,
      ).toHaveLength(0);
    });

    it("refuses to block yourself or somebody who does not exist", async () => {
      expect(
        (await call(member, "POST", "/api/blocks", { userId: member.id }))
          .status,
      ).toBe(400);
      expect(
        (
          await call(member, "POST", "/api/blocks", {
            userId: "00000000-0000-4000-8000-000000000000",
          })
        ).status,
      ).toBe(404);
    });

    it("shows a block only to the person who made it", async () => {
      await call(member, "POST", "/api/blocks", { userId: outsider.id });
      const theirs = await call<{ blocked: unknown[] }>(
        outsider,
        "GET",
        "/api/blocks",
      );
      expect(theirs.body.blocked).toHaveLength(0);
    });
  });

  describe("conversations", () => {
    /** Both are members of the same server, so the default privacy allows it. */
    async function openWith(
      as: { id: string; clerk_id: string },
      userIds: string[],
    ) {
      return call<{ conversation: { channelId: string } }>(as, "POST", "/api/dms", {
        userIds,
      });
    }

    async function send(
      as: { id: string; clerk_id: string },
      channelId: string,
      body: string,
    ) {
      await handleChatMessage(
        { socket: fakeSocket(), user: await asDbUser(as.id) },
        { type: "message-create", channelId, body },
      );
    }

    it("creates once and reuses after that", async () => {
      await makeServer();
      const first = await openWith(member, [admin.id]);
      expect(first.status).toBe(201);

      const again = await openWith(admin, [member.id]);
      expect(again.status).toBe(200);
      expect(again.body.conversation.channelId).toBe(
        first.body.conversation.channelId,
      );
    });

    it("hides a conversation from a non-participant and from the server's owner", async () => {
      // The owner runs the server both of them are in. That must buy nothing:
      // a server administrator has no business in their members' messages.
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;

      for (const stranger of [owner, outsider]) {
        expect(
          (await call(stranger, "GET", `/api/channels/${channelId}/messages`))
            .status,
        ).toBe(404);
        expect(
          (await call(stranger, "POST", `/api/channels/${channelId}/read`))
            .status,
        ).toBe(404);
        const theirList = await call<{ conversations: unknown[] }>(
          stranger,
          "GET",
          "/api/dms",
        );
        expect(theirList.body.conversations).toHaveLength(0);
      }
    });

    it("cannot be administered as if it were a server channel", async () => {
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;

      // Every one of these goes on to ask a question about the channel's
      // server, and a conversation has none.
      expect(
        (await call(member, "PATCH", `/api/channels/${channelId}`, {
          name: "renamed",
        })).status,
      ).toBe(404);
      expect(
        (await call(member, "DELETE", `/api/channels/${channelId}`)).status,
      ).toBe(404);
      expect(
        (await call(member, "GET", `/api/channels/${channelId}/members`)).status,
      ).toBe(404);
      expect(
        (
          await call(member, "POST", `/api/channels/${channelId}/members`, {
            userId: owner.id,
          })
        ).status,
      ).toBe(404);
    });

    it("carries messages, unread and history on the ordinary channel routes", async () => {
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;

      await send(admin, channelId, "just between us");

      const history = await call<{ messages: Array<{ body: string }> }>(
        member,
        "GET",
        `/api/channels/${channelId}/messages`,
      );
      expect(history.body.messages.map((m) => m.body)).toEqual([
        "just between us",
      ]);

      const list = await call<{
        conversations: Array<{
          channelId: string;
          kind: string;
          participants: Array<{ id: string }>;
          unread: { count: number };
        }>;
      }>(member, "GET", "/api/dms");
      expect(list.body.conversations).toHaveLength(1);
      expect(list.body.conversations[0]!.kind).toBe("dm");
      expect(list.body.conversations[0]!.unread.count).toBe(1);
      expect(list.body.conversations[0]!.participants.map((p) => p.id)).toEqual([
        admin.id,
      ]);

      await call(member, "POST", `/api/channels/${channelId}/read`);
      const afterRead = await call<{
        conversations: Array<{ unread: { count: number } }>;
      }>(member, "GET", "/api/dms");
      expect(afterRead.body.conversations[0]!.unread.count).toBe(0);
    });

    it("has no moderators: a server admin cannot delete a message in one", async () => {
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;
      await send(member, channelId, "mine");

      const history = await call<{ messages: Array<{ id: string }> }>(
        member,
        "GET",
        `/api/channels/${channelId}/messages`,
      );
      const messageId = history.body.messages[0]!.id;

      // admin is a participant *and* an admin of the shared server. Being an
      // admin is what must not help: there is no server to manage here.
      expect(
        (await call(admin, "DELETE", `/api/messages/${messageId}`)).status,
      ).toBe(403);
      expect(
        (await call(member, "DELETE", `/api/messages/${messageId}`)).status,
      ).toBe(200);
    });

    it("refuses when either party has blocked the other", async () => {
      await makeServer();
      await call(admin, "POST", "/api/blocks", { userId: member.id });

      expect((await openWith(member, [admin.id])).status).toBe(403);
      // Symmetric: the blocker cannot reach through their own block either.
      expect((await openWith(admin, [member.id])).status).toBe(403);
    });

    it("drops a message into a 1:1 once a block goes up", async () => {
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;

      await call(admin, "POST", "/api/blocks", { userId: member.id });
      await send(member, channelId, "let me in");

      const history = await call<{ messages: unknown[] }>(
        admin,
        "GET",
        `/api/channels/${channelId}/messages`,
      );
      expect(history.body.messages).toHaveLength(0);
    });

    it("refuses everyone once dm_privacy is 'nobody'", async () => {
      await makeServer();
      expect(
        (await call(admin, "PATCH", "/api/me", { dmPrivacy: "nobody" })).status,
      ).toBe(200);

      // Even a co-member of the same server.
      expect((await openWith(member, [admin.id])).status).toBe(403);
      expect((await openWith(outsider, [admin.id])).status).toBe(403);
    });

    it("under 'server_members' refuses a stranger and allows a co-member", async () => {
      await makeServer();
      // outsider shares no server with anyone; member and admin share one.
      expect((await openWith(outsider, [admin.id])).status).toBe(403);
      expect((await openWith(member, [admin.id])).status).toBe(201);
    });

    it("under 'everyone' allows a complete stranger", async () => {
      await call(admin, "PATCH", "/api/me", { dmPrivacy: "everyone" });
      expect((await openWith(outsider, [admin.id])).status).toBe(201);
    });

    it("reports dm_privacy back on /api/me", async () => {
      const before = await call<{ dmPrivacy: string }>(admin, "GET", "/api/me");
      expect(before.body.dmPrivacy).toBe("server_members");

      await call(admin, "PATCH", "/api/me", { dmPrivacy: "nobody" });
      const after = await call<{ dmPrivacy: string }>(admin, "GET", "/api/me");
      expect(after.body.dmPrivacy).toBe("nobody");
    });

    it("closes a conversation for one side without deleting anything", async () => {
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;
      await send(admin, channelId, "history");

      expect(
        (await call(member, "DELETE", `/api/dms/${channelId}`)).status,
      ).toBe(200);
      expect(
        (await call<{ conversations: unknown[] }>(member, "GET", "/api/dms"))
          .body.conversations,
      ).toHaveLength(0);
      // The other side is untouched, and so is the history.
      expect(
        (await call<{ conversations: unknown[] }>(admin, "GET", "/api/dms")).body
          .conversations,
      ).toHaveLength(1);

      // The next thing said in it brings the conversation back with its
      // history, rather than dropping the message on the floor.
      await send(admin, channelId, "still here?");
      const back = await call<{
        conversations: Array<{ channelId: string }>;
      }>(member, "GET", "/api/dms");
      expect(back.body.conversations.map((c) => c.channelId)).toEqual([
        channelId,
      ]);
      const history = await call<{ messages: unknown[] }>(
        member,
        "GET",
        `/api/channels/${channelId}/messages`,
      );
      expect(history.body.messages).toHaveLength(2);
    });

    it("keeps a block in force after the blocker closes the conversation", async () => {
      // The whole sequence, end to end: block, close, and then the blocked
      // person says something. Closing removes the blocker's own membership
      // row, and a guard that resolved the counterparty through that row let
      // the message through *and* restored the blocker into the conversation,
      // so it reappeared in their list carrying the message they blocked to
      // avoid. Nothing about that is visible to the person who blocked.
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;

      await call(admin, "POST", "/api/blocks", { userId: member.id });
      expect(
        (await call(admin, "DELETE", `/api/dms/${channelId}`)).status,
      ).toBe(200);

      await send(member, channelId, "let me in");

      const stored = await getPool().query(
        `SELECT id FROM messages WHERE channel_id = $1`,
        [channelId],
      );
      expect(stored.rows).toHaveLength(0);
      expect(
        (await call<{ conversations: unknown[] }>(admin, "GET", "/api/dms")).body
          .conversations,
      ).toHaveLength(0);
    });

    it("enforces a block in a group once it has shrunk to two people", async () => {
      // A group never becomes a 'dm', so gating enforcement on kind left this
      // channel exempt for good once the third participant closed it.
      await makeServer();
      const opened = await openWith(member, [admin.id, owner.id]);
      const channelId = opened.body.conversation.channelId;
      expect(
        (await call(owner, "DELETE", `/api/dms/${channelId}`)).status,
      ).toBe(200);

      await call(admin, "POST", "/api/blocks", { userId: member.id });
      await send(member, channelId, "the group is our back door");

      const stored = await getPool().query(
        `SELECT id FROM messages WHERE channel_id = $1`,
        [channelId],
      );
      expect(stored.rows).toHaveLength(0);
    });

    it("records a mention into a 1:1 the recipient had closed", async () => {
      // `recordMentions` resolves a conversation's mentionable set through
      // `channel_members`, so restoring the recipient after the insert left
      // them out of their own mention: the live badge says "mention" and the
      // badge after a refresh says none.
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;
      expect(
        (await call(member, "DELETE", `/api/dms/${channelId}`)).status,
      ).toBe(200);

      const memberRow = await asDbUser(member.id);
      await send(admin, channelId, `come back @${memberRow.username}`);

      const mentions = await getPool().query<{ user_id: string }>(
        `SELECT user_id FROM message_mentions`,
      );
      expect(mentions.rows.map((row) => row.user_id)).toEqual([member.id]);

      const list = await call<{
        conversations: Array<{ unread: { count: number; mentions: number } }>;
      }>(member, "GET", "/api/dms");
      expect(list.body.conversations[0]!.unread).toEqual({
        count: 1,
        mentions: 1,
      });
    });

    it("evicts the closer's live view, and nobody else's", async () => {
      // Closing drops the membership row but the socket's channelId survives,
      // and `broadcastToChannel` fans out on that field alone — the client
      // sends no leave frame here. Without the eviction the person who closed
      // the conversation goes on receiving its message bodies, reactions and
      // typing frames for as long as the socket lives.
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;

      const closer = recordingSocket();
      await handleChatMessage(
        { socket: closer.socket, user: await asDbUser(member.id) },
        { type: "join-channel", channelId },
      );
      const stayer = recordingSocket();
      await handleChatMessage(
        { socket: stayer.socket, user: await asDbUser(admin.id) },
        { type: "join-channel", channelId },
      );

      expect(
        (await call(member, "DELETE", `/api/dms/${channelId}`)).status,
      ).toBe(200);
      closer.received.length = 0;
      stayer.received.length = 0;

      await handleChatMessage(
        { socket: stayer.socket, user: await asDbUser(admin.id) },
        { type: "message-create", channelId, body: "are you still reading?" },
      );
      expect(typesOf(closer.received)).not.toContain("message-broadcast");

      // And only the closer: the other participant never left, so the next
      // thing said still reaches them.
      closer.received.length = 0;
      stayer.received.length = 0;
      await handleChatMessage(
        { socket: closer.socket, user: await asDbUser(member.id) },
        { type: "message-create", channelId, body: "i am" },
      );
      expect(typesOf(stayer.received)).toContain("message-broadcast");
    });

    it("does not let a blocked person type into the blocker's conversation", async () => {
      // A typing indicator is a notification like any other, and the client
      // does not filter it — without the guard a blocked person can park
      // "X is typing…" in the blocker's open conversation indefinitely.
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;

      const blocker = recordingSocket();
      await handleChatMessage(
        { socket: blocker.socket, user: await asDbUser(admin.id) },
        { type: "join-channel", channelId },
      );
      const blocked = recordingSocket();
      await handleChatMessage(
        { socket: blocked.socket, user: await asDbUser(member.id) },
        { type: "join-channel", channelId },
      );

      await handleChatMessage(
        { socket: blocked.socket, user: await asDbUser(member.id) },
        { type: "typing", channelId },
      );
      expect(typesOf(blocker.received)).toContain("typing-broadcast");

      await call(admin, "POST", "/api/blocks", { userId: member.id });
      blocker.received.length = 0;
      await handleChatMessage(
        { socket: blocked.socket, user: await asDbUser(member.id) },
        { type: "typing", channelId },
      );
      expect(typesOf(blocker.received)).not.toContain("typing-broadcast");
    });

    it("answers 404 when closing a conversation the caller is not in", async () => {
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      expect(
        (
          await call(
            outsider,
            "DELETE",
            `/api/dms/${opened.body.conversation.channelId}`,
          )
        ).status,
      ).toBe(404);
    });

    it("refuses to open one with yourself", async () => {
      expect((await openWith(member, [member.id])).status).toBe(403);
    });

    it("stops a blocked person from reacting into a 1:1", async () => {
      // A reaction is a persistent, visible poke at somebody's message. Closing
      // only `message-create` would leave it as the way through.
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;
      await send(admin, channelId, "hello");

      const history = await call<{ messages: Array<{ id: string }> }>(
        member,
        "GET",
        `/api/channels/${channelId}/messages`,
      );
      const messageId = history.body.messages[0]!.id;

      await call(admin, "POST", "/api/blocks", { userId: member.id });
      await handleChatMessage(
        { socket: fakeSocket(), user: await asDbUser(member.id) },
        { type: "reaction-toggle", channelId, messageId, emoji: "👍" },
      );

      const reactions = await getPool().query(
        `SELECT 1 FROM message_reactions WHERE message_id = $1`,
        [messageId],
      );
      expect(reactions.rows).toHaveLength(0);
    });

    it("stops a blocked person from editing an old message into new abuse", async () => {
      // Every guard above sits on a WebSocket frame, but an edit arrives over
      // HTTP and re-broadcasts the new body live. Without a check here the
      // block stops new messages and lets arbitrary new text through anyway,
      // using a message that was legitimately sent before it went up.
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;
      await send(member, channelId, "innocent");

      const history = await call<{ messages: Array<{ id: string }> }>(
        member,
        "GET",
        `/api/channels/${channelId}/messages`,
      );
      const messageId = history.body.messages[0]!.id;

      await call(admin, "POST", "/api/blocks", { userId: member.id });

      expect(
        (
          await call(member, "PATCH", `/api/messages/${messageId}`, {
            body: "abuse",
          })
        ).status,
      ).toBe(403);

      const stored = await getPool().query<{ body: string }>(
        `SELECT body FROM messages WHERE id = $1`,
        [messageId],
      );
      expect(stored.rows[0]!.body).toBe("innocent");
    });

    it("lets a conversation take a call, and closes it to a blocked caller", async () => {
      // A conversation is stored as a text channel, so gating voice on
      // `type = 'voice'` used to reject every DM call.
      await makeServer();
      const opened = await openWith(member, [admin.id]);
      const channelId = opened.body.conversation.channelId;

      const allowed = fakeSocket();
      await handleVoiceMessage(
        { socket: allowed, user: await asDbUser(member.id) },
        { type: "join-voice-room", voiceChannelId: channelId },
      );
      expect(isSocketInVoice(allowed)).toBe(true);
      removeVoicePeerBySocket(allowed);

      await call(admin, "POST", "/api/blocks", { userId: member.id });
      const refused = fakeSocket();
      await handleVoiceMessage(
        { socket: refused, user: await asDbUser(member.id) },
        { type: "join-voice-room", voiceChannelId: channelId },
      );
      expect(isSocketInVoice(refused)).toBe(false);
    });

    it("marks a blocked author's messages in history without dropping them", async () => {
      const { textChannelId } = await makeServer();
      await send(admin, textChannelId, "one");
      await send(member, textChannelId, "two");
      await call(owner, "POST", "/api/blocks", { userId: admin.id });

      const history = await call<{
        messages: Array<{ body: string; blocked: boolean }>;
      }>(owner, "GET", `/api/channels/${textChannelId}/messages`);
      expect(history.body.messages.map((m) => m.body)).toEqual(["one", "two"]);
      expect(history.body.messages.map((m) => m.blocked)).toEqual([true, false]);
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

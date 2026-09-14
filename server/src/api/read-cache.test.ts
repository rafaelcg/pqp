import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The read-cache wiring end to end: the three reads it actually sits in
 * front of (`GET /api/channels/:id/messages`'s latest page,
 * `GET /api/servers/:id/channels`, `GET /api/channels/:id/watch-party`),
 * driven through the real HTTP router against a real Postgres, the same
 * posture as `etag.test.ts` and `watch-parties.test.ts`.
 *
 * `server/src/lib/read-cache.test.ts` already pins the cache module itself
 * (coalescing, TTL, stale-while-revalidate, the rollback switch, the LRU).
 * This file pins the part that module cannot see on its own: that each of
 * the three call sites invalidates on the writes that change its answer, and
 * — the property that matters most, because a caching bug in the wrong
 * direction is a cross-account leak — that per-viewer authorization still
 * runs on every request even when the shared cache is warm from someone
 * else's read.
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

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { createMessage, deleteMessage, updateMessageBody } = await import(
  "../services/messages.js"
);
const { assignRole, createRole } = await import("../services/roles.js");
const { Permission } = await import("@pqp/shared");
const { readCacheMetrics, resetReadCacheForTests } = await import(
  "../lib/read-cache.js"
);

type User = { id: string; clerk_id: string };

let server: Server;
let baseUrl: string;

interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  as: User | null,
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

describeDb("read-cache: end-to-end wiring", () => {
  let owner: User;
  let member: User;
  let outsider: User;

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
    resetReadCacheForTests();
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, roles, member_roles,
                channel_sessions, channel_session_cohosts,
                channel_session_stage_invites, server_invites, server_bans,
                channel_reads, message_mentions, message_reactions,
                message_attachments, user_blocks, dm_pairs, link_embeds
       RESTART IDENTITY CASCADE`,
    );
    owner = await upsertUser({
      clerkId: "clerk_owner",
      displayName: "Owner",
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

  afterEach(() => {
    resetReadCacheForTests();
  });

  async function makeServer() {
    const created = await call<{
      server: { id: string };
      channels: Array<{ id: string; type: string }>;
    }>(owner, "POST", "/api/servers", { name: "Test server" });
    expect(created.status).toBe(201);
    const serverId = created.body.server.id;
    const textChannelId = created.body.channels.find((c) => c.type === "text")!
      .id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, member.id],
    );
    return { serverId, textChannelId };
  }

  // ============================================================= messages

  describe("the latest message page", () => {
    it("coalesces concurrent reads of the same channel into one query", async () => {
      const { textChannelId } = await makeServer();
      await getPool().query(
        `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'seed')`,
        [textChannelId, owner.id],
      );

      const before = readCacheMetrics();
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          call(member, "GET", `/api/channels/${textChannelId}/messages`),
        ),
      );
      for (const r of results) {
        expect(r.status).toBe(200);
      }
      const after = readCacheMetrics();
      // Exactly one caller actually queried Postgres — every other request,
      // whichever way scheduling landed it (joining the in-flight load, or
      // finding a just-written fresh entry), shared that one answer rather
      // than issuing a query of its own.
      expect(after.misses - before.misses).toBe(1);
      expect(
        after.coalesced - before.coalesced + (after.hits - before.hits),
      ).toBe(49);
    });

    it("shows a message created after the cache was warmed", async () => {
      const { textChannelId } = await makeServer();
      const first = await call<{ messages: unknown[] }>(
        member,
        "GET",
        `/api/channels/${textChannelId}/messages`,
      );
      expect(first.body.messages).toHaveLength(0);

      const ownerRow = await getPool().query(`SELECT * FROM users WHERE id = $1`, [
        owner.id,
      ]);
      await createMessage(textChannelId, ownerRow.rows[0], "hello reload storm");

      const second = await call<{ messages: { body: string }[] }>(
        member,
        "GET",
        `/api/channels/${textChannelId}/messages`,
      );
      expect(second.body.messages).toHaveLength(1);
      expect(second.body.messages[0]!.body).toBe("hello reload storm");
    });

    it("shows an edited body immediately, not the cached pre-edit text", async () => {
      const { textChannelId } = await makeServer();
      const inserted = await getPool().query<{ id: string }>(
        `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'before') RETURNING id`,
        [textChannelId, owner.id],
      );
      const messageId = inserted.rows[0]!.id;

      const warm = await call<{ messages: { body: string }[] }>(
        member,
        "GET",
        `/api/channels/${textChannelId}/messages`,
      );
      expect(warm.body.messages[0]!.body).toBe("before");

      await updateMessageBody(messageId, "after");

      const fresh = await call<{ messages: { body: string }[] }>(
        member,
        "GET",
        `/api/channels/${textChannelId}/messages`,
      );
      expect(fresh.body.messages[0]!.body).toBe("after");
    });

    it("drops a deleted message immediately", async () => {
      const { textChannelId } = await makeServer();
      const inserted = await getPool().query<{ id: string }>(
        `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'gone soon') RETURNING id`,
        [textChannelId, owner.id],
      );
      const messageId = inserted.rows[0]!.id;

      const warm = await call<{ messages: unknown[] }>(
        member,
        "GET",
        `/api/channels/${textChannelId}/messages`,
      );
      expect(warm.body.messages).toHaveLength(1);

      await deleteMessage(messageId);

      const fresh = await call<{ messages: unknown[] }>(
        member,
        "GET",
        `/api/channels/${textChannelId}/messages`,
      );
      expect(fresh.body.messages).toHaveLength(0);
    });

    it("still refuses a non-member while the cache is warm from a member's read", async () => {
      const { textChannelId } = await makeServer();
      await getPool().query(
        `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'members only')`,
        [textChannelId, owner.id],
      );

      const warm = await call(member, "GET", `/api/channels/${textChannelId}/messages`);
      expect(warm.status).toBe(200);

      const denied = await call(outsider, "GET", `/api/channels/${textChannelId}/messages`);
      expect([403, 404]).toContain(denied.status);
    });
  });

  // ============================================================== channels

  describe("a server's channel list", () => {
    async function makePrivateChannel(serverId: string) {
      const created = await call<{ channel: { id: string; name: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/channels`,
        { name: "staff-only", type: "text", isPrivate: true },
      );
      expect(created.status).toBe(201);
      return created.body.channel.id;
    }

    it("coalesces concurrent reads of the same server into one query", async () => {
      const { serverId } = await makeServer();
      const before = readCacheMetrics();
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          call(member, "GET", `/api/servers/${serverId}/channels`),
        ),
      );
      for (const r of results) {
        expect(r.status).toBe(200);
      }
      const after = readCacheMetrics();
      // Same invariant as the message-page version of this test: one real
      // query, and every other caller served from that one answer, however
      // scheduling split them between joining the in-flight load and
      // finding a just-written fresh entry.
      expect(after.misses - before.misses).toBe(1);
      expect(
        after.coalesced - before.coalesced + (after.hits - before.hits),
      ).toBe(49);
    });

    it("keeps a private channel out of a plain member's list even though the shared cache holds it", async () => {
      const { serverId } = await makeServer();
      const privateId = await makePrivateChannel(serverId);

      // The owner's read warms the SHARED cache — and the owner can see the
      // private channel, so that raw cached data includes it.
      const ownerView = await call<{ channels: { id: string }[] }>(
        owner,
        "GET",
        `/api/servers/${serverId}/channels`,
      );
      expect(ownerView.body.channels.map((c) => c.id)).toContain(privateId);

      // A plain member, reading the SAME warm cache entry, must still have
      // the private channel filtered out by a fresh per-viewer check.
      const memberView = await call<{ channels: { id: string }[] }>(
        member,
        "GET",
        `/api/servers/${serverId}/channels`,
      );
      expect(memberView.body.channels.map((c) => c.id)).not.toContain(privateId);
    });

    it("refuses a non-member of the server outright, cache warm or not", async () => {
      const { serverId } = await makeServer();
      const warm = await call(owner, "GET", `/api/servers/${serverId}/channels`);
      expect(warm.status).toBe(200);
      const denied = await call(outsider, "GET", `/api/servers/${serverId}/channels`);
      expect([403, 404]).toContain(denied.status);
    });

    it("shows a channel created after the cache was warmed", async () => {
      const { serverId } = await makeServer();
      const warm = await call<{ channels: unknown[] }>(
        member,
        "GET",
        `/api/servers/${serverId}/channels`,
      );
      const before = warm.body.channels.length;

      await call(owner, "POST", `/api/servers/${serverId}/channels`, {
        name: "general-2",
        type: "text",
      });

      const fresh = await call<{ channels: unknown[] }>(
        member,
        "GET",
        `/api/servers/${serverId}/channels`,
      );
      expect(fresh.body.channels.length).toBe(before + 1);
    });

    it("shows a rename immediately", async () => {
      const { serverId, textChannelId } = await makeServer();
      await call(member, "GET", `/api/servers/${serverId}/channels`);

      await call(owner, "PATCH", `/api/channels/${textChannelId}`, {
        name: "renamed-channel",
      });

      const fresh = await call<{ channels: { id: string; name: string }[] }>(
        member,
        "GET",
        `/api/servers/${serverId}/channels`,
      );
      const renamed = fresh.body.channels.find((c) => c.id === textChannelId);
      expect(renamed?.name).toBe("renamed-channel");
    });

    it("drops a deleted channel immediately", async () => {
      const { serverId } = await makeServer();
      const privateId = await makePrivateChannel(serverId);
      await call(owner, "GET", `/api/servers/${serverId}/channels`);

      const del = await call(owner, "DELETE", `/api/channels/${privateId}`);
      expect(del.status).toBe(200);

      const fresh = await call<{ channels: { id: string }[] }>(
        owner,
        "GET",
        `/api/servers/${serverId}/channels`,
      );
      expect(fresh.body.channels.map((c) => c.id)).not.toContain(privateId);
    });
  });

  // ========================================================= watch parties

  describe("a channel's watch-party state", () => {
    async function makePartyChannel() {
      const { serverId } = await makeServer();
      const created = await call<{ channel: { id: string } }>(
        owner,
        "POST",
        `/api/servers/${serverId}/channels`,
        { name: "sessao", type: "watch_party" },
      );
      expect(created.status).toBe(201);
      const channelId = created.body.channel.id;

      const hostRole = await createRole(serverId, {
        name: "Apresentador",
        permissions: Permission.START_WATCH_PARTY,
      });
      await assignRole(serverId, owner.id, hostRole.id);
      return { serverId, channelId };
    }

    async function goLive(channelId: string) {
      const created = await call<{ party: { id: string } }>(
        owner,
        "POST",
        `/api/channels/${channelId}/watch-parties`,
        { name: "Sessão" },
      );
      expect(created.status).toBe(200);
      const sessionId = created.body.party.id;
      const live = await call(owner, "POST", `/api/watch-parties/${sessionId}/state`, {
        state: "live",
      });
      expect(live.status).toBe(200);
      return sessionId;
    }

    it("coalesces concurrent reads of the same channel into one query", async () => {
      const { channelId } = await makePartyChannel();
      await goLive(channelId);

      const before = readCacheMetrics();
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          call(member, "GET", `/api/channels/${channelId}/watch-party`),
        ),
      );
      for (const r of results) {
        expect(r.status).toBe(200);
      }
      const after = readCacheMetrics();
      // Same invariant as the message-page version of this test: one real
      // query, and every other caller served from that one answer, however
      // scheduling split them between joining the in-flight load and
      // finding a just-written fresh entry.
      expect(after.misses - before.misses).toBe(1);
      expect(
        after.coalesced - before.coalesced + (after.hits - before.hits),
      ).toBe(49);
    });

    it("shows the party to a plain member once live, sharing the host's cached read", async () => {
      const { channelId } = await makePartyChannel();
      await goLive(channelId);

      const hostView = await call<{ party: { state: string } | null }>(
        owner,
        "GET",
        `/api/channels/${channelId}/watch-party`,
      );
      expect(hostView.body.party?.state).toBe("live");

      const memberView = await call<{ party: { state: string } | null }>(
        member,
        "GET",
        `/api/channels/${channelId}/watch-party`,
      );
      expect(memberView.body.party?.state).toBe("live");
    });

    it("refuses a non-member of the server, cache warm or not", async () => {
      const { channelId } = await makePartyChannel();
      await goLive(channelId);
      const warm = await call(owner, "GET", `/api/channels/${channelId}/watch-party`);
      expect(warm.status).toBe(200);
      const denied = await call(outsider, "GET", `/api/channels/${channelId}/watch-party`);
      expect([403, 404]).toContain(denied.status);
    });

    it("reflects the party ending immediately, not a cached live state", async () => {
      const { channelId } = await makePartyChannel();
      const sessionId = await goLive(channelId);

      const warm = await call<{ party: { state: string } | null }>(
        member,
        "GET",
        `/api/channels/${channelId}/watch-party`,
      );
      expect(warm.body.party?.state).toBe("live");

      const ended = await call(owner, "POST", `/api/watch-parties/${sessionId}/state`, {
        state: "ended",
      });
      expect(ended.status).toBe(200);

      const fresh = await call<{ party: unknown }>(
        member,
        "GET",
        `/api/channels/${channelId}/watch-party`,
      );
      // An ended (terminal) party is not shown as an active party.
      expect(fresh.body.party).toBeNull();
    });
  });
});

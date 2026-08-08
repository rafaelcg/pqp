import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Conditional GETs on the four reads a client hits on every screen change.
 *
 * The property worth a test of its own is the *order*: a 304 must be
 * unreachable for anybody who would not have been handed the 200. The tag is
 * computed from the body the route produced, so authorization has by
 * construction already run — but "by construction" is exactly the kind of
 * claim that quietly stops being true, so it is asserted here against a real
 * database with a real outsider holding a real, valid validator.
 */

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
  resolveAuthSession: async () =>
    actor ? { user: actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");

let server: Server;
let baseUrl: string;

interface ApiResult<T = unknown> {
  status: number;
  body: T;
  etag: string | null;
  /** Raw response text, so "a 304 carries no body" is assertable. */
  text: string;
}

async function call<T = Record<string, unknown>>(
  as: { id: string; clerk_id: string } | null,
  method: string,
  path: string,
  options: { body?: unknown; ifNoneMatch?: string } = {},
): Promise<ApiResult<T>> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test",
      ...(options.ifNoneMatch ? { "If-None-Match": options.ifNoneMatch } : {}),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
    etag: response.headers.get("etag"),
    text,
  };
}

describeDb("conditional reads (ETag / 304)", () => {
  let owner: { id: string; clerk_id: string };
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
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, server_invites, server_bans,
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

  async function makeServer() {
    const created = await call<{
      server: { id: string };
      channels: Array<{ id: string; type: string }>;
    }>(owner, "POST", "/api/servers", { body: { name: "Test server" } });
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

  async function seedMessage(channelId: string, body: string) {
    const result = await getPool().query<{ id: string }>(
      `INSERT INTO messages (channel_id, author_id, body)
       VALUES ($1, $2, $3) RETURNING id`,
      [channelId, owner.id, body],
    );
    return result.rows[0]!.id;
  }

  // ------------------------------------------------------------ the property

  it("runs authorization BEFORE comparing validators", async () => {
    const { textChannelId } = await makeServer();
    await seedMessage(textChannelId, "members only");

    // A real, current validator — minted for somebody who *can* read it.
    const authorized = await call(
      owner,
      "GET",
      `/api/channels/${textChannelId}/messages`,
    );
    expect(authorized.status).toBe(200);
    const validator = authorized.etag!;
    expect(validator).toBeTruthy();

    // The same validator in the hands of somebody who cannot see the channel
    // must not turn into a 304. A 304 would be an oracle: it would confirm the
    // channel exists and that its contents are exactly what the tag describes.
    const stolen = await call(outsider, "GET", `/api/channels/${textChannelId}/messages`, {
      ifNoneMatch: validator,
    });
    expect(stolen.status).not.toBe(304);
    expect([403, 404]).toContain(stolen.status);

    // And `*`, the wildcard that matches any current representation, is
    // likewise powerless without access.
    const wildcard = await call(
      outsider,
      "GET",
      `/api/channels/${textChannelId}/messages`,
      { ifNoneMatch: "*" },
    );
    expect(wildcard.status).not.toBe(304);
  });

  it("refuses an unauthenticated conditional request with 401, not 304", async () => {
    const { textChannelId } = await makeServer();
    const first = await call(owner, "GET", `/api/channels/${textChannelId}/messages`);
    const anonymous = await call(null, "GET", `/api/channels/${textChannelId}/messages`, {
      ifNoneMatch: first.etag!,
    });
    expect(anonymous.status).toBe(401);
  });

  // -------------------------------------------------------------- behaviour

  it("answers 304 with no body when the message page has not changed", async () => {
    const { textChannelId } = await makeServer();
    await seedMessage(textChannelId, "hello");

    const first = await call<{ messages: unknown[] }>(
      owner,
      "GET",
      `/api/channels/${textChannelId}/messages`,
    );
    expect(first.status).toBe(200);
    expect(first.body.messages).toHaveLength(1);

    const second = await call(owner, "GET", `/api/channels/${textChannelId}/messages`, {
      ifNoneMatch: first.etag!,
    });
    expect(second.status).toBe(304);
    expect(second.text).toBe("");
    // The validator is repeated on the 304 so a client can keep using it.
    expect(second.etag).toBe(first.etag);
  });

  it("accepts a weak-prefixed echo of its own tag", async () => {
    const { textChannelId } = await makeServer();
    const first = await call(owner, "GET", `/api/channels/${textChannelId}/messages`);
    const second = await call(owner, "GET", `/api/channels/${textChannelId}/messages`, {
      ifNoneMatch: `W/${first.etag!}`,
    });
    expect(second.status).toBe(304);
  });

  it("returns a fresh 200 once a new message lands", async () => {
    const { textChannelId } = await makeServer();
    await seedMessage(textChannelId, "first");
    const before = await call(owner, "GET", `/api/channels/${textChannelId}/messages`);

    await seedMessage(textChannelId, "second");
    const after = await call<{ messages: unknown[] }>(
      owner,
      "GET",
      `/api/channels/${textChannelId}/messages`,
      { ifNoneMatch: before.etag! },
    );
    expect(after.status).toBe(200);
    expect(after.body.messages).toHaveLength(2);
    expect(after.etag).not.toBe(before.etag);
  });

  it("changes the tag on an edit that leaves the newest id and the count alone", async () => {
    const { textChannelId } = await makeServer();
    const id = await seedMessage(textChannelId, "before");
    await seedMessage(textChannelId, "newest");
    const before = await call(owner, "GET", `/api/channels/${textChannelId}/messages`);

    await call(owner, "PATCH", `/api/messages/${id}`, { body: { body: "after" } });

    const after = await call(owner, "GET", `/api/channels/${textChannelId}/messages`, {
      ifNoneMatch: before.etag!,
    });
    expect(after.status).toBe(200);
  });

  it("gives two viewers of the same channel different tags when the page differs per viewer", async () => {
    const { textChannelId } = await makeServer();
    const id = await seedMessage(textChannelId, "react to me");
    await getPool().query(
      `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, '👍')`,
      [id, owner.id],
    );

    const mine = await call(owner, "GET", `/api/channels/${textChannelId}/messages`);
    const theirs = await call(member, "GET", `/api/channels/${textChannelId}/messages`);
    // `me` on the reaction differs, so the bodies differ, so the validators
    // must differ — otherwise one viewer's 304 would pin the other's view.
    expect(mine.etag).not.toBe(theirs.etag);

    const crossed = await call(member, "GET", `/api/channels/${textChannelId}/messages`, {
      ifNoneMatch: mine.etag!,
    });
    expect(crossed.status).toBe(200);
  });

  it("never invites a shared cache to hold one of these responses", async () => {
    const { textChannelId } = await makeServer();
    const response = await fetch(
      `${baseUrl}/api/channels/${textChannelId}/messages`,
      { headers: { Authorization: "Bearer test" } },
    );
    await response.text();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cache-control")).not.toContain("max-age");
  });

  it("covers the server list, a server's channels and the DM list too", async () => {
    const { serverId } = await makeServer();

    for (const path of [
      "/api/servers",
      `/api/servers/${serverId}/channels`,
      "/api/dms",
    ]) {
      const first = await call(owner, "GET", path);
      expect(first.status).toBe(200);
      expect(first.etag).toBeTruthy();

      const second = await call(owner, "GET", path, { ifNoneMatch: first.etag! });
      expect(second.status).toBe(304);
      expect(second.text).toBe("");
    }
  });

  it("re-issues a 200 for a server list that gained a server", async () => {
    await makeServer();
    const before = await call(owner, "GET", "/api/servers");

    await call(owner, "POST", "/api/servers", { body: { name: "Another" } });

    const after = await call<{ servers: unknown[] }>(owner, "GET", "/api/servers", {
      ifNoneMatch: before.etag!,
    });
    expect(after.status).toBe(200);
    expect(after.body.servers).toHaveLength(2);
  });

  it("keeps the non-member refusal on the channel list ahead of the validator", async () => {
    const { serverId } = await makeServer();
    const mine = await call(owner, "GET", `/api/servers/${serverId}/channels`);

    const theirs = await call(outsider, "GET", `/api/servers/${serverId}/channels`, {
      ifNoneMatch: mine.etag!,
    });
    expect(theirs.status).not.toBe(304);
    expect([403, 404]).toContain(theirs.status);
  });
});

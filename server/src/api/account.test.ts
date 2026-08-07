import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { formatUserTag } from "@pqp/shared";

/**
 * The two LGPD art. 18 routes a data subject drives themselves:
 * `GET /api/me/export` and `DELETE /api/me`.
 *
 * In its own file rather than in api.test.ts because deletion has to be able to
 * make the *Clerk* call fail on demand, which means owning the stub of
 * `auth/clerk.js` rather than sharing that suite's fixed one.
 *
 * What has to hold:
 *
 *  - an export contains the caller's own data and nobody else's message bodies,
 *    including in a DM (see `EXPORT_NOTES` in services/account.ts for why);
 *  - both routes are scoped to the caller and cannot be aimed at anyone else;
 *  - an unconfirmed delete is refused;
 *  - owning a server with other members in it blocks deletion, by name;
 *  - the records that must outlive an account genuinely do;
 *  - a failed Clerk call leaves the account whole, and an interrupted one is
 *    finished by the sweeper.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const stubs = vi.hoisted(() => ({
  /** The identity the next request authenticates as. */
  actor: null as { id: string; clerk_id: string } | null,
  deleteClerkUser: vi.fn(async (_clerkId: string) => {}),
  forgetAuthUser: vi.fn(),
}));

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  forgetAuthUser: stubs.forgetAuthUser,
  deleteClerkUser: stubs.deleteClerkUser,
  resolveAuthUser: async () => (stubs.actor ? { user: stubs.actor } : null),
  resolveAuthSession: async () =>
    stubs.actor ? { user: stubs.actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { sweepPendingAccountDeletions } = await import(
  "../services/account.js"
);

let server: Server;
let baseUrl: string;

interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
}

type Actor = { id: string; clerk_id: string };

async function call<T = Record<string, unknown>>(
  as: Actor | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  stubs.actor = as;
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

describeDb("LGPD art. 18 — own account", () => {
  let alice: Actor;
  let bob: Actor;
  let carol: Actor;

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
    stubs.deleteClerkUser.mockReset();
    stubs.deleteClerkUser.mockResolvedValue(undefined);
    stubs.forgetAuthUser.mockReset();

    // `reports` and `audit_log` are named explicitly: neither cascades from
    // `users` (both are SET NULL, which is the property under test), so
    // truncating users alone would leave the previous test's rows behind and
    // make "the record survived" pass for the wrong reason.
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, server_invites, server_bans,
                channel_reads, message_mentions, message_reactions,
                message_attachments, user_blocks, dm_pairs, link_embeds,
                reports, audit_log
       RESTART IDENTITY CASCADE`,
    );

    alice = await upsertUser({
      clerkId: "clerk_alice",
      displayName: "Alice",
      avatarUrl: null,
    });
    bob = await upsertUser({
      clerkId: "clerk_bob",
      displayName: "Bob",
      avatarUrl: null,
    });
    carol = await upsertUser({
      clerkId: "clerk_carol",
      displayName: "Carol",
      avatarUrl: null,
    });
  });

  async function tagOf(userId: string): Promise<string> {
    const row = await getPool().query<{
      username: string | null;
      discriminator: string | null;
    }>(`SELECT username, discriminator FROM users WHERE id = $1`, [userId]);
    return formatUserTag(row.rows[0]!.username, row.rows[0]!.discriminator)!;
  }

  async function userExists(userId: string): Promise<boolean> {
    const row = await getPool().query(`SELECT 1 FROM users WHERE id = $1`, [
      userId,
    ]);
    return row.rowCount === 1;
  }

  /** A server owned by `owner`, with a text channel, plus any extra members. */
  async function makeServer(owner: Actor, others: Actor[] = []) {
    const created = await call<{
      server: { id: string };
      channels: Array<{ id: string; type: string }>;
    }>(owner, "POST", "/api/servers", { name: "Test server" });
    expect(created.status).toBe(201);
    const serverId = created.body.server.id;
    for (const other of others) {
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role)
         VALUES ($1, $2, 'member')`,
        [serverId, other.id],
      );
    }
    return {
      serverId,
      textChannelId: created.body.channels.find((c) => c.type === "text")!.id,
    };
  }

  async function say(channelId: string, author: Actor, body: string) {
    const row = await getPool().query<{ id: string }>(
      `INSERT INTO messages (channel_id, author_id, body)
       VALUES ($1, $2, $3) RETURNING id`,
      [channelId, author.id, body],
    );
    return row.rows[0]!.id;
  }

  /** Opens a 1:1 between two accounts through the real route. */
  async function openDm(from: Actor, to: Actor): Promise<string> {
    const res = await call<{ conversation: { channelId: string } }>(
      from,
      "POST",
      "/api/dms",
      { userIds: [to.id] },
    );
    expect([200, 201]).toContain(res.status);
    return res.body.conversation.channelId;
  }

  // ------------------------------------------------------------- the export

  interface Export {
    format: string;
    notes: string[];
    account: { id: string; tag: string | null; clerkId: string };
    servers: Array<{ id: string; name: string; role: string }>;
    conversations: Array<{
      channelId: string;
      kind: string;
      otherParticipants: Array<{ id: string; displayName: string }>;
      yourMessageCount: number;
    }>;
    messages: Array<{ body: string; channelId: string; serverName: string | null }>;
    blockedUsers: Array<{ id: string }>;
    reportsYouFiled: Array<{ reason: string; subjectLabel: string | null }>;
    auditEntries: Array<{ action: string }>;
    truncated: boolean;
  }

  async function exportFor(as: Actor): Promise<ApiResult<Export>> {
    return call<Export>(as, "GET", "/api/me/export");
  }

  describe("GET /api/me/export", () => {
    it("returns the caller's own profile, servers and messages", async () => {
      const { serverId, textChannelId } = await makeServer(alice, [bob]);
      await say(textChannelId, alice, "mine");
      await say(textChannelId, bob, "bob's");

      const res = await exportFor(alice);
      expect(res.status).toBe(200);
      expect(res.body.format).toBe("pqp.personal-data-export.v1");
      expect(res.body.account.id).toBe(alice.id);
      expect(res.body.account.tag).toBe(await tagOf(alice.id));
      expect(res.body.servers).toMatchObject([
        { id: serverId, name: "Test server", role: "owner" },
      ]);
      expect(res.body.messages.map((m) => m.body)).toEqual(["mine"]);
      expect(res.body.messages[0]!.serverName).toBe("Test server");
      expect(res.body.truncated).toBe(false);
    });

    it("never contains another person's message bodies, in a server or a DM", async () => {
      const { textChannelId } = await makeServer(alice, [bob]);
      await say(textChannelId, bob, "bob in the server");
      const dm = await openDm(alice, bob);
      await say(dm, alice, "alice in the dm");
      await say(dm, bob, "bob in the dm");

      const res = await exportFor(alice);
      const bodies = res.body.messages.map((m) => m.body);
      expect(bodies).toContain("alice in the dm");
      expect(bodies).not.toContain("bob in the dm");
      expect(bodies).not.toContain("bob in the server");
    });

    it("describes each conversation without transcribing it", async () => {
      // A shared server first: `dm_privacy` defaults to 'server_members', so
      // there is no way to open a conversation with a stranger.
      await makeServer(alice, [bob]);
      const dm = await openDm(alice, bob);
      await say(dm, alice, "one");
      await say(dm, alice, "two");
      await say(dm, bob, "three");

      const res = await exportFor(alice);
      expect(res.body.conversations).toHaveLength(1);
      const conversation = res.body.conversations[0]!;
      expect(conversation.channelId).toBe(dm);
      expect(conversation.kind).toBe("dm");
      // Who it was with is Alice's own data; what they said is not.
      expect(conversation.otherParticipants).toMatchObject([
        { id: bob.id, displayName: "Bob" },
      ]);
      expect(conversation.yourMessageCount).toBe(2);
      // The other participant is named, but never with a Clerk id: the export
      // going to Alice does not make Bob's identity hers to receive.
      expect(conversation.otherParticipants[0]).not.toHaveProperty("clerkId");
      // And the exclusion is stated inside the file, not left to be inferred.
      expect(res.body.notes.join(" ")).toMatch(/written by OTHER people/i);
    });

    it("includes blocks, reports filed, and audit entries the caller made", async () => {
      const { serverId, textChannelId } = await makeServer(alice, [bob]);
      const offending = await say(textChannelId, bob, "rude");

      await call(alice, "POST", "/api/blocks", { userId: carol.id });
      await call(alice, "POST", "/api/reports", {
        subjectType: "message",
        messageId: offending,
        reason: "harassment",
      });
      // An audit entry with Alice as the actor.
      await call(alice, "DELETE", `/api/servers/${serverId}/members/${bob.id}`);

      const res = await exportFor(alice);
      expect(res.body.blockedUsers.map((b) => b.id)).toEqual([carol.id]);
      expect(res.body.reportsYouFiled).toHaveLength(1);
      expect(res.body.reportsYouFiled[0]!.reason).toBe("harassment");
      expect(res.body.auditEntries.some((e) => e.action.startsWith("member"))).toBe(
        true,
      );
    });

    it("omits the reported content snapshot, which is the reported person's data", async () => {
      const { textChannelId } = await makeServer(alice, [bob]);
      const offending = await say(textChannelId, bob, "SECRET-BOB-TEXT");
      await call(alice, "POST", "/api/reports", {
        subjectType: "message",
        messageId: offending,
        reason: "harassment",
      });

      const res = await exportFor(alice);
      expect(JSON.stringify(res.body)).not.toContain("SECRET-BOB-TEXT");
    });

    it("is scoped to the caller — one account cannot export another", async () => {
      const { textChannelId } = await makeServer(alice, [bob]);
      await say(textChannelId, alice, "alice only");
      await say(textChannelId, bob, "bob only");

      const asBob = await exportFor(bob);
      expect(asBob.status).toBe(200);
      expect(asBob.body.account.id).toBe(bob.id);
      expect(asBob.body.messages.map((m) => m.body)).toEqual(["bob only"]);
      // There is no route that takes somebody else's id, so the only way to
      // aim this at another account is not to exist.
      const aimed = await call(bob, "GET", `/api/users/${alice.id}/export`);
      expect(aimed.status).toBe(404);
    });

    it("sends the file as a download and rate limits repeats", async () => {
      stubs.actor = alice;
      const raw = await fetch(`${baseUrl}/api/me/export`, {
        headers: { Authorization: "Bearer test" },
      });
      expect(raw.status).toBe(200);
      expect(raw.headers.get("content-type")).toBe("application/json");
      expect(raw.headers.get("content-disposition")).toContain(
        "attachment; filename=",
      );
      await raw.text();

      // Capacity is 2, so the second succeeds and the third is refused.
      expect((await exportFor(alice)).status).toBe(200);
      expect((await exportFor(alice)).status).toBe(429);
    });
  });

  // ----------------------------------------------------------- the deletion

  async function deleteMe(as: Actor, confirm?: string) {
    return call<{ code?: string; servers?: Array<{ id: string; name: string }> }>(
      as,
      "DELETE",
      "/api/me",
      confirm === undefined ? {} : { confirm },
    );
  }

  describe("DELETE /api/me", () => {
    it("refuses a delete with no confirmation at all", async () => {
      const res = await deleteMe(alice);
      expect(res.status).toBe(400);
      expect(await userExists(alice.id)).toBe(true);
      expect(stubs.deleteClerkUser).not.toHaveBeenCalled();
    });

    it("refuses a confirmation that is not the caller's own handle", async () => {
      const res = await deleteMe(alice, "definitely-not-my-handle");
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        error: expect.stringContaining(await tagOf(alice.id)),
      });
      expect(await userExists(alice.id)).toBe(true);
    });

    it("cannot be aimed at another account by confirming with their handle", async () => {
      const res = await deleteMe(bob, await tagOf(alice.id));
      expect(res.status).toBe(400);
      expect(await userExists(alice.id)).toBe(true);
      expect(await userExists(bob.id)).toBe(true);
    });

    it("deletes the account, its messages, and the Clerk identity", async () => {
      const { textChannelId } = await makeServer(alice, [bob]);
      await say(textChannelId, alice, "alice said this");
      await say(textChannelId, bob, "bob said this");
      // Alice owns this server but Bob is in it, so hand it over first.
      await getPool().query(
        `UPDATE server_members SET role = 'owner' WHERE user_id = $1`,
        [bob.id],
      );
      await getPool().query(`UPDATE servers SET owner_id = $1`, [bob.id]);
      await getPool().query(
        `UPDATE server_members SET role = 'member' WHERE user_id = $1`,
        [alice.id],
      );

      const res = await deleteMe(alice, await tagOf(alice.id));
      expect(res.status).toBe(200);
      expect(await userExists(alice.id)).toBe(false);
      expect(stubs.deleteClerkUser).toHaveBeenCalledWith("clerk_alice");

      const remaining = await getPool().query<{ body: string }>(
        `SELECT body FROM messages WHERE channel_id = $1`,
        [textChannelId],
      );
      expect(remaining.rows.map((r) => r.body)).toEqual(["bob said this"]);
    });

    it("takes a server nobody else is in with it", async () => {
      const { serverId } = await makeServer(alice);
      expect((await deleteMe(alice, await tagOf(alice.id))).status).toBe(200);

      const survived = await getPool().query(
        `SELECT 1 FROM servers WHERE id = $1`,
        [serverId],
      );
      expect(survived.rowCount).toBe(0);
    });

    describe("owned servers", () => {
      it("refuses, naming each server that has other members in it", async () => {
        const { serverId } = await makeServer(alice, [bob]);

        const res = await deleteMe(alice, await tagOf(alice.id));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe("owned_servers");
        expect(res.body.servers).toMatchObject([
          { id: serverId, name: "Test server", otherMemberCount: 1 },
        ]);
        expect(await userExists(alice.id)).toBe(true);
        // Nothing at Clerk was touched: the refusal is a pre-flight.
        expect(stubs.deleteClerkUser).not.toHaveBeenCalled();
      });

      it("lets the delete through once ownership is transferred", async () => {
        const { serverId } = await makeServer(alice, [bob]);
        await getPool().query(
          `INSERT INTO server_members (server_id, user_id, role)
           VALUES ($1, $2, 'admin')
           ON CONFLICT (server_id, user_id) DO UPDATE SET role = 'admin'`,
          [serverId, bob.id],
        );

        expect(
          (
            await call(alice, "PATCH", `/api/servers/${serverId}`, {
              ownerId: bob.id,
            })
          ).status,
        ).toBe(200);

        expect((await deleteMe(alice, await tagOf(alice.id))).status).toBe(200);
        expect(await userExists(alice.id)).toBe(false);
        // Bob's server is untouched — the whole point of refusing first.
        const still = await getPool().query(
          `SELECT owner_id FROM servers WHERE id = $1`,
          [serverId],
        );
        expect(still.rows[0]).toMatchObject({ owner_id: bob.id });
      });

      it("lets the delete through once the server is deleted", async () => {
        const { serverId } = await makeServer(alice, [bob]);
        expect(
          (await call(alice, "DELETE", `/api/servers/${serverId}`)).status,
        ).toBe(200);
        expect((await deleteMe(alice, await tagOf(alice.id))).status).toBe(200);
      });
    });

    describe("what survives", () => {
      it("keeps audit entries, with the actor detached", async () => {
        const { serverId } = await makeServer(alice, [bob]);
        await call(alice, "DELETE", `/api/servers/${serverId}/members/${bob.id}`);
        // Hand the server over so the delete is not blocked, and so the audit
        // rows are not carried off by the server cascade.
        await getPool().query(
          `INSERT INTO server_members (server_id, user_id, role)
           VALUES ($1, $2, 'admin')`,
          [serverId, carol.id],
        );
        await call(alice, "PATCH", `/api/servers/${serverId}`, {
          ownerId: carol.id,
        });

        expect((await deleteMe(alice, await tagOf(alice.id))).status).toBe(200);

        const entries = await getPool().query<{
          action: string;
          actor_id: string | null;
        }>(`SELECT action, actor_id FROM audit_log WHERE server_id = $1`, [
          serverId,
        ]);
        expect(entries.rowCount).toBeGreaterThan(0);
        expect(entries.rows.every((row) => row.actor_id === null)).toBe(true);
      });

      it("keeps bans it issued against other people", async () => {
        const { serverId } = await makeServer(alice, [bob, carol]);
        await call(alice, "POST", `/api/servers/${serverId}/bans`, {
          userId: bob.id,
          reason: "spam",
        });
        await call(alice, "PATCH", `/api/servers/${serverId}`, {
          ownerId: carol.id,
        });

        expect((await deleteMe(alice, await tagOf(alice.id))).status).toBe(200);

        const bans = await getPool().query<{
          user_id: string;
          banned_by: string | null;
          reason: string | null;
        }>(`SELECT user_id, banned_by, reason FROM server_bans WHERE server_id = $1`, [
          serverId,
        ]);
        expect(bans.rows).toMatchObject([
          { user_id: bob.id, banned_by: null, reason: "spam" },
        ]);
      });

      it("keeps reports filed about it, and reports it filed", async () => {
        const { textChannelId } = await makeServer(alice, [bob]);
        const aliceMessage = await say(textChannelId, alice, "the reported one");
        const bobMessage = await say(textChannelId, bob, "also reported");

        // Bob reports Alice…
        await call(bob, "POST", "/api/reports", {
          subjectType: "message",
          messageId: aliceMessage,
          reason: "harassment",
        });
        // …and Alice reports Bob.
        await call(alice, "POST", "/api/reports", {
          subjectType: "message",
          messageId: bobMessage,
          reason: "spam",
        });

        await getPool().query(`UPDATE servers SET owner_id = $1`, [bob.id]);
        await getPool().query(
          `UPDATE server_members SET role = 'owner' WHERE user_id = $1`,
          [bob.id],
        );
        await getPool().query(
          `UPDATE server_members SET role = 'member' WHERE user_id = $1`,
          [alice.id],
        );

        expect((await deleteMe(alice, await tagOf(alice.id))).status).toBe(200);

        const reports = await getPool().query<{
          reason: string;
          reporter_id: string | null;
          reported_user_id: string | null;
          content_snapshot: string | null;
        }>(
          `SELECT reason, reporter_id, reported_user_id, content_snapshot
           FROM reports ORDER BY reason`,
        );
        expect(reports.rowCount).toBe(2);

        const about = reports.rows.find((r) => r.reason === "harassment")!;
        expect(about.reported_user_id).toBeNull();
        expect(about.reporter_id).toBe(bob.id);
        // The evidence outlives the account it is about — the whole reason
        // `reports` uses SET NULL rather than CASCADE.
        expect(about.content_snapshot).toBe("the reported one");

        const byAlice = reports.rows.find((r) => r.reason === "spam")!;
        expect(byAlice.reporter_id).toBeNull();
        expect(byAlice.content_snapshot).toBe("also reported");
      });
    });

    describe("partial failure", () => {
      it("changes nothing when Clerk refuses, and stays retryable", async () => {
        stubs.deleteClerkUser.mockRejectedValueOnce(new Error("clerk is down"));

        const res = await deleteMe(alice, await tagOf(alice.id));
        expect(res.status).toBe(502);
        expect(await userExists(alice.id)).toBe(true);

        // The deletion stamp was rolled back, so nothing is left half-done and
        // the sweeper has nothing to pick up.
        const stamp = await getPool().query<{ deletion_started_at: Date | null }>(
          `SELECT deletion_started_at FROM users WHERE id = $1`,
          [alice.id],
        );
        expect(stamp.rows[0]!.deletion_started_at).toBeNull();

        // Retrying works, which is what the 502 tells the user to do.
        expect((await deleteMe(alice, await tagOf(alice.id))).status).toBe(200);
        expect(await userExists(alice.id)).toBe(false);
      });

      it("finishes a deletion interrupted after the Clerk call", async () => {
        // Exactly the state a crash between step 2 and step 3 leaves behind.
        await getPool().query(
          `UPDATE users SET deletion_started_at = NOW() - INTERVAL '1 hour'
           WHERE id = $1`,
          [alice.id],
        );

        const finished = await sweepPendingAccountDeletions();
        expect(finished).toBe(1);
        expect(await userExists(alice.id)).toBe(false);
        expect(stubs.deleteClerkUser).toHaveBeenCalledWith("clerk_alice");
      });

      it("leaves the row alone while Clerk is still failing", async () => {
        stubs.deleteClerkUser.mockRejectedValue(new Error("still down"));
        await getPool().query(
          `UPDATE users SET deletion_started_at = NOW() - INTERVAL '1 hour'
           WHERE id = $1`,
          [alice.id],
        );

        expect(await sweepPendingAccountDeletions()).toBe(0);
        // Local data is NOT deleted for an identity that might still sign in.
        expect(await userExists(alice.id)).toBe(true);
      });

      it("ignores a stamp that is younger than the grace period", async () => {
        await getPool().query(
          `UPDATE users SET deletion_started_at = NOW() WHERE id = $1`,
          [alice.id],
        );
        expect(await sweepPendingAccountDeletions()).toBe(0);
        expect(await userExists(alice.id)).toBe(true);
      });
    });
  });
});

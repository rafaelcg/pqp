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
import type { WebSocket } from "ws";

/**
 * Timeouts, pinned at the places they can silently stop working.
 *
 * A sanction has an unusual failure mode: when it breaks, nothing throws and no
 * page goes red. The person just carries on talking, and the only observer is a
 * moderator who assumed the button worked. So the assertions here are about the
 * two things that are invisible from any HTTP response:
 *
 *   * BOTH SURFACES. Text sends go over the WebSocket and never touch the
 *     router, so an HTTP-only guard would pass every route test in the suite
 *     while silencing nobody. Both chokepoints are proved separately, on the
 *     same sanction.
 *   * EXPIRY WITH NOTHING RUNNING. `pruneExpiredTimeouts` is never called in
 *     this file, deliberately. A design where a sweeper has to run for a
 *     sentence to end is one where a restarted process keeps somebody silenced
 *     past their time, and nobody notices because it looks like the feature
 *     working.
 *
 * Plus the boundaries a sanction must not cross: rank (an admin cannot silence
 * a peer), conversations (a server's moderators have no authority over DMs),
 * and the escape hatches (leaving, marking read, reporting).
 */

// TEST_DATABASE_URL wins — see the note in api.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

/** The identity the next HTTP request will authenticate as. */
let actor: { id: string; clerk_id: string } | null = null;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  forgetAuthUser: () => {},
  deleteClerkUser: async () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  resolveAuthSession: async () =>
    actor ? { user: actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("../api/index.js");
const { upsertUser } = await import("./users.js");
const { createServer: createChatServer, createChannel } = await import(
  "./servers.js"
);
const { createMessage } = await import("./messages.js");
const { openConversation } = await import("./dms.js");
const { handleChatMessage, resetChatRateLimits } = await import(
  "../ws/chat.js"
);
const { handleVoiceMessage, isSocketInVoice, removeVoicePeerBySocket } =
  await import("../ws/voice.js");
const { findTimeoutInServer, issueTimeout, pruneExpiredTimeouts } =
  await import("./sanctions.js");

let httpServer: Server;
let baseUrl: string;

interface ApiResult<T = Record<string, unknown>> {
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
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

/** The chat handler only ever touches these three members of a socket. */
function fakeSocket(): WebSocket {
  return {
    readyState: 1,
    send: () => {},
    on: () => {},
  } as unknown as WebSocket;
}

/** Keeps what was fanned out to it — the only way an eviction or a fan-out is
 * observable, since neither shows up in any HTTP response. */
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

describeDb("sanctions — timeouts", () => {
  let owner: { id: string; clerk_id: string };
  let admin: { id: string; clerk_id: string };
  let otherAdmin: { id: string; clerk_id: string };
  let member: { id: string; clerk_id: string };
  let bystander: { id: string; clerk_id: string };

  let serverId: string;
  let channelId: string;
  let voiceChannelId: string;
  let privateChannelId: string;

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
    resetChatRateLimits();
    delete process.env.INSTANCE_MODERATOR_CLERK_IDS;

    const makeUser = (name: string) =>
      upsertUser({
        clerkId: `clerk_${name}`,
        displayName: name,
        avatarUrl: null,
      });
    owner = await makeUser("owner");
    admin = await makeUser("admin");
    otherAdmin = await makeUser("otheradmin");
    member = await makeUser("member");
    bystander = await makeUser("bystander");

    const created = await createChatServer("Sanctions", owner.id);
    serverId = created.server.id;
    channelId = created.channels.find((c) => c.type === "text")!.id;
    voiceChannelId = created.channels.find((c) => c.type === "voice")!.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($1, $3, 'admin'), ($1, $4, 'member'),
              ($1, $5, 'member')`,
      [serverId, admin.id, otherAdmin.id, member.id, bystander.id],
    );
    privateChannelId = (await createChannel(serverId, "secret", "text", true))
      .id;
  });

  async function dbUser(userId: string) {
    const result = await getPool().query(`SELECT * FROM users WHERE id = $1`, [
      userId,
    ]);
    return result.rows[0]!;
  }

  /** Issue through the route, so the rank rule and the audit write are on the
   * same path every assertion below exercises. */
  function timeout(
    as: { id: string; clerk_id: string },
    userId: string,
    minutes = 60,
    reason: string | null = "cool off",
  ) {
    return call(as, "POST", `/api/servers/${serverId}/timeouts`, {
      userId,
      minutes,
      reason,
    });
  }

  async function say(
    socket: WebSocket,
    as: { id: string },
    channel: string,
    body: string,
  ) {
    await handleChatMessage(
      { socket, user: await dbUser(as.id) },
      { type: "message-create", channelId: channel, body },
    );
  }

  async function messageCount(channel: string): Promise<number> {
    const result = await getPool().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM messages WHERE channel_id = $1`,
      [channel],
    );
    return Number(result.rows[0]!.count);
  }

  // ------------------------------------------------------ both chokepoints

  it("refuses a timed-out member's send over the WebSocket", async () => {
    expect((await timeout(owner, member.id)).status).toBe(201);

    const before = await messageCount(channelId);
    const sender = recordingSocket();
    await say(sender.socket, member, channelId, "still here");
    expect(await messageCount(channelId)).toBe(before);

    // And they are TOLD. A frame that is merely dropped shows up in the client
    // as a red bubble after the send timer expires — indistinguishable from the
    // network being down, which is the failure this notice exists to prevent.
    const notice = sender.received
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((frame) => frame.type === "sanction-notice");
    expect(notice).toBeDefined();
    expect(notice!.sanction).toBe("timeout");
    expect(notice!.serverId).toBe(serverId);
    expect(typeof notice!.expiresAt).toBe("string");
    // The sentence names when it ends. "You are timed out" with no end time is
    // indistinguishable from a ban.
    expect(String(notice!.message)).toContain(String(notice!.expiresAt));
  });

  it("refuses a timed-out member's write over HTTP", async () => {
    // Sends are WebSocket-only in this product, so the HTTP participation write
    // is an edit — putting new words into the channel through the router rather
    // than through the socket. Same sanction, different chokepoint.
    const posted = await createMessage(
      channelId,
      await dbUser(member.id),
      "original",
    );
    expect((await timeout(owner, member.id)).status).toBe(201);

    const edit = await call<{ error: string }>(
      member,
      "PATCH",
      `/api/messages/${posted!.id}`,
      { body: "edited while timed out" },
    );
    expect(edit.status).toBe(403);
    expect(edit.body.error).toContain("timed out");

    // A write that names the server rather than a message goes through the same
    // guard — the chokepoint resolves all three path shapes, so a route nobody
    // has written yet is covered the day it appears.
    const invite = await call(owner, "POST", `/api/servers/${serverId}/invites`, {});
    expect(invite.status).toBe(201);
    expect(
      (await call(member, "POST", `/api/servers/${serverId}/invites`, {}))
        .status,
    ).toBe(403);

    // Reading is untouched. That is the whole difference between this and a
    // kick, and it is the reason the guard runs on write methods only.
    expect(
      (await call(member, "GET", `/api/channels/${channelId}/messages`)).status,
    ).toBe(200);
  });

  it("refuses a timed-out member's voice join and evicts them from the room", async () => {
    const inRoom = fakeSocket();
    await handleVoiceMessage(
      { socket: inRoom, user: await dbUser(member.id) },
      { type: "join-voice-room", voiceChannelId },
    );
    expect(isSocketInVoice(inRoom)).toBe(true);

    // Already in the room when the sanction lands: refusing the join alone
    // would leave them talking through the entire timeout.
    expect((await timeout(owner, member.id)).status).toBe(201);
    expect(isSocketInVoice(inRoom)).toBe(false);

    const rejoin = fakeSocket();
    await handleVoiceMessage(
      { socket: rejoin, user: await dbUser(member.id) },
      { type: "join-voice-room", voiceChannelId },
    );
    expect(isSocketInVoice(rejoin)).toBe(false);
    removeVoicePeerBySocket(rejoin);
  });

  // ------------------------------------------------------------ expiry

  it("stops binding the moment it expires, with no sweeper having run", async () => {
    // Issued directly rather than through the route so the duration can be
    // negative — a sanction that ran out one minute ago. Nothing in this test
    // calls `pruneExpiredTimeouts`: if expiry needed a sweeper to be correct,
    // this row would still be silencing them.
    await issueTimeout({
      serverId,
      userId: member.id,
      issuedBy: owner.id,
      minutes: -1,
      reason: "already served",
    });

    // The row is still there…
    const rows = await getPool().query(
      `SELECT 1 FROM member_timeouts WHERE server_id = $1 AND user_id = $2`,
      [serverId, member.id],
    );
    expect(rows.rows).toHaveLength(1);
    // …and binds nobody, because every read filters on `expires_at > NOW()`.
    expect(await findTimeoutInServer(member.id, serverId)).toBeNull();

    const before = await messageCount(channelId);
    await say(fakeSocket(), member, channelId, "my time is up");
    expect(await messageCount(channelId)).toBe(before + 1);

    // And it is absent from the moderator's list, which shows live sanctions
    // rather than every row in the table.
    const list = await call<{ timeouts: unknown[] }>(
      owner,
      "GET",
      `/api/servers/${serverId}/timeouts`,
    );
    expect(list.body.timeouts).toHaveLength(0);

    // The prune only ever reclaims disk. Running it here changes the row count
    // and changes nothing about who may speak.
    expect(await pruneExpiredTimeouts()).toBe(1);
  });

  it("a still-running timeout survives the prune", async () => {
    expect((await timeout(owner, member.id, 60)).status).toBe(201);
    expect(await pruneExpiredTimeouts()).toBe(0);
    expect(await findTimeoutInServer(member.id, serverId)).not.toBeNull();
  });

  // -------------------------------------------------------------- rank

  it("refuses a moderator acting on an equal or higher rank", async () => {
    // Admin against admin: a temporary sanction is still a sanction, and an
    // admin who could silence a peer for 28 days would have routed around "an
    // admin cannot kick an admin".
    expect((await timeout(admin, otherAdmin.id)).status).toBe(403);
    // Admin against the owner.
    expect((await timeout(admin, owner.id)).status).toBe(403);
    // And against themselves, which is a different refusal with a different
    // message — it is not a rank problem.
    expect((await timeout(admin, admin.id)).status).toBe(400);

    // The rule is the same one kick and ban use, so what an admin *may* do is
    // unchanged: act on a plain member.
    expect((await timeout(admin, member.id)).status).toBe(201);
    // And the owner outranks everybody.
    expect((await timeout(owner, admin.id)).status).toBe(201);
  });

  it("refuses a plain member issuing a timeout at all", async () => {
    expect((await timeout(member, bystander.id)).status).toBe(403);
    expect(
      (await call(member, "GET", `/api/servers/${serverId}/timeouts`)).status,
    ).toBe(403);
  });

  it("refuses a timeout on somebody who is not a member", async () => {
    const stranger = await upsertUser({
      clerkId: "clerk_stranger",
      displayName: "stranger",
      avatarUrl: null,
    });
    // Unlike a ban, a timeout cannot be pre-emptive: there is nothing to
    // silence about somebody who is not there.
    expect((await timeout(owner, stranger.id)).status).toBe(404);
  });

  // ------------------------------------------------------------- audit

  it("writes every sanction to the audit log", async () => {
    expect((await timeout(owner, member.id, 45, "flooding #general")).status).toBe(
      201,
    );

    const log = await call<{
      entries: Array<{
        action: string;
        targetId: string | null;
        reason: string | null;
        changes: Array<{ key: string; old: unknown; new: unknown }> | null;
      }>;
    }>(owner, "GET", `/api/servers/${serverId}/audit-log`);

    const issued = log.body.entries.find((e) => e.action === "member.timeout");
    expect(issued).toBeDefined();
    expect(issued!.targetId).toBe(member.id);
    expect(issued!.reason).toBe("flooding #general");
    // The row is deleted when it expires, so this entry is the only durable
    // record of how long the sanction was for.
    expect(
      issued!.changes?.find((c) => c.key === "minutes")?.new,
    ).toBe(45);
    expect(
      issued!.changes?.find((c) => c.key === "expiresAt")?.old,
    ).toBeNull();

    // An extension replaces the row rather than adding one, and the entry says
    // so — old expiry to new, which is what makes escalation visible.
    expect((await timeout(owner, member.id, 60 * 24)).status).toBe(201);
    const after = await call<{
      entries: Array<{
        action: string;
        changes: Array<{ key: string; old: unknown; new: unknown }> | null;
      }>;
    }>(owner, "GET", `/api/servers/${serverId}/audit-log`);
    const extended = after.body.entries.find(
      (e) =>
        e.action === "member.timeout" &&
        e.changes?.some((c) => c.key === "expiresAt" && c.old !== null),
    );
    expect(extended).toBeDefined();

    // Lifting is logged too. A sanction that quietly disappears from the trail
    // is how a moderator loses track of what they did.
    expect(
      (
        await call(
          owner,
          "DELETE",
          `/api/servers/${serverId}/timeouts/${member.id}`,
        )
      ).status,
    ).toBe(200);
    const lifted = await call<{ entries: Array<{ action: string }> }>(
      owner,
      "GET",
      `/api/servers/${serverId}/audit-log`,
    );
    expect(lifted.body.entries.map((e) => e.action)).toContain(
      "member.timeout_lift",
    );
  });

  it("shows a moderator who did it, when, why and when it ends", async () => {
    expect((await timeout(admin, member.id, 60, "slurs")).status).toBe(201);
    const list = await call<{
      timeouts: Array<{
        userId: string;
        issuedByName: string | null;
        reason: string | null;
        createdAt: string;
        expiresAt: string;
      }>;
    }>(owner, "GET", `/api/servers/${serverId}/timeouts`);

    expect(list.body.timeouts).toHaveLength(1);
    const entry = list.body.timeouts[0]!;
    expect(entry.userId).toBe(member.id);
    expect(entry.issuedByName).toBe("admin");
    expect(entry.reason).toBe("slurs");
    expect(new Date(entry.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(entry.createdAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  // -------------------------------------------------------- what it spares

  it("never reaches a conversation", async () => {
    // A server's moderators have no authority over their members' direct
    // messages — the same rule that keeps DM reports out of server queues.
    // `findTimeoutForChannel` reaches a server only through
    // `channels.server_id`, which is NULL here, so this is structural rather
    // than a check somebody remembered.
    const dm = await openConversation(member.id, [bystander.id]);
    expect((await timeout(owner, member.id)).status).toBe(201);

    const before = await messageCount(dm.channelId);
    await say(fakeSocket(), member, dm.channelId, "unaffected");
    expect(await messageCount(dm.channelId)).toBe(before + 1);
  });

  it("leaves the escape hatches open", async () => {
    expect((await timeout(owner, member.id)).status).toBe(201);

    // Reporting. `POST /api/reports` names no server in its path, so it matches
    // no scope — the person most likely to be timed out in a fight is sometimes
    // the one with the legitimate complaint.
    const report = await call(member, "POST", "/api/reports", {
      subjectType: "user",
      userId: bystander.id,
      serverId,
      reason: "harassment",
    });
    expect([200, 201]).toContain(report.status);

    // Marking a channel read. Reading is untouched by a timeout, so the badge
    // for a channel they may still read has to be clearable.
    expect(
      (await call(member, "POST", `/api/channels/${channelId}/read`)).status,
    ).toBe(200);

    // Leaving. A sanction that traps somebody in the server sanctioning them is
    // a different and much worse product.
    expect(
      (await call(member, "POST", `/api/servers/${serverId}/leave`)).status,
    ).toBe(200);
  });

  it("does not silence the same person in another server", async () => {
    const other = await createChatServer("Elsewhere", member.id);
    const otherChannel = other.channels.find((c) => c.type === "text")!.id;
    expect((await timeout(owner, member.id)).status).toBe(201);

    const before = await messageCount(otherChannel);
    await say(fakeSocket(), member, otherChannel, "different place");
    expect(await messageCount(otherChannel)).toBe(before + 1);
  });

  it("lifts early and lets them speak again immediately", async () => {
    expect((await timeout(owner, member.id, 60 * 24)).status).toBe(201);
    const before = await messageCount(channelId);
    await say(fakeSocket(), member, channelId, "blocked");
    expect(await messageCount(channelId)).toBe(before);

    expect(
      (
        await call(
          owner,
          "DELETE",
          `/api/servers/${serverId}/timeouts/${member.id}`,
        )
      ).status,
    ).toBe(200);
    await say(fakeSocket(), member, channelId, "back");
    expect(await messageCount(channelId)).toBe(before + 1);

    // Nothing to lift twice.
    expect(
      (
        await call(
          owner,
          "DELETE",
          `/api/servers/${serverId}/timeouts/${member.id}`,
        )
      ).status,
    ).toBe(404);
  });

  // ---------------------------------------------------- report → sanction

  it("applies a timeout in the same action that resolves a report", async () => {
    const offending = await createMessage(
      channelId,
      await dbUser(member.id),
      "buy followers",
    );
    const filed = await call<{ report: { id: string } }>(
      bystander,
      "POST",
      "/api/reports",
      { subjectType: "message", messageId: offending!.id, reason: "spam" },
    );
    expect([200, 201]).toContain(filed.status);

    const resolved = await call(
      owner,
      "PATCH",
      `/api/reports/${filed.body.report.id}`,
      { status: "actioned", note: "third time today", timeoutMinutes: 60 },
    );
    expect(resolved.status).toBe(200);

    // The note the moderator already typed became the sanction's reason, rather
    // than being asked for twice and left empty.
    const active = await findTimeoutInServer(member.id, serverId);
    expect(active).not.toBeNull();
    expect(active!.reason).toBe("third time today");

    const before = await messageCount(channelId);
    await say(fakeSocket(), member, channelId, "buy more followers");
    expect(await messageCount(channelId)).toBe(before);
  });

  it("refuses the sanction before closing the report when the rank is wrong", async () => {
    const offending = await createMessage(
      channelId,
      await dbUser(otherAdmin.id),
      "from an admin",
    );
    const filed = await call<{ report: { id: string } }>(
      bystander,
      "POST",
      "/api/reports",
      { subjectType: "message", messageId: offending!.id, reason: "spam" },
    );

    // An admin cannot sanction a peer through the queue any more than through
    // the members panel — and the report must NOT be closed on the way to
    // finding that out, or the moderator is left with a cleared queue and
    // nobody sanctioned.
    const refused = await call(
      admin,
      "PATCH",
      `/api/reports/${filed.body.report.id}`,
      { status: "actioned", timeoutMinutes: 60 },
    );
    expect(refused.status).toBe(403);
    expect(await findTimeoutInServer(otherAdmin.id, serverId)).toBeNull();

    const stillOpen = await call<{
      reports: Array<{ id: string; status: string }>;
    }>(owner, "GET", `/api/servers/${serverId}/reports`);
    expect(stillOpen.body.reports[0]!.status).toBe("open");
  });

  it("refuses a timeout on a report with no server behind it", async () => {
    process.env.INSTANCE_MODERATOR_CLERK_IDS = owner.clerk_id;
    const dm = await openConversation(member.id, [bystander.id]);
    const said = await createMessage(
      dm.channelId,
      await dbUser(member.id),
      "in a dm",
    );
    const filed = await call<{ report: { id: string } }>(
      bystander,
      "POST",
      "/api/reports",
      { subjectType: "message", messageId: said!.id, reason: "harassment" },
    );

    // Silencing somebody's direct messages is not a sanction this product has,
    // and the instance queue must not be the place one gets invented.
    const refused = await call(
      owner,
      "PATCH",
      `/api/reports/${filed.body.report.id}`,
      { status: "actioned", timeoutMinutes: 60 },
    );
    expect(refused.status).toBe(400);
  });

  // ------------------------------------------------- demotion eviction

  it("evicts a demoted admin from the private channels they lose", async () => {
    // `channelVisibleSql` admits admins to a private channel on rank alone, so
    // a demotion revokes access without touching one membership row — which is
    // exactly why the kick path's eviction never fired for it. Invalidating the
    // audience cache fixes the next query; the socket already inside the
    // channel goes on receiving every message body until it navigates away.
    const demoted = recordingSocket();
    await handleChatMessage(
      { socket: demoted.socket, user: await dbUser(admin.id) },
      { type: "join-channel", channelId: privateChannelId },
    );
    const stayer = recordingSocket();
    await handleChatMessage(
      { socket: stayer.socket, user: await dbUser(owner.id) },
      { type: "join-channel", channelId: privateChannelId },
    );

    // Proof the view is live before the demotion, or the assertion after it
    // would pass for a socket that was never receiving anything.
    demoted.received.length = 0;
    await say(stayer.socket, owner, privateChannelId, "before");
    expect(typesOf(demoted.received)).toContain("message-broadcast");

    expect(
      (
        await call(owner, "PATCH", `/api/servers/${serverId}/members/${admin.id}`, {
          role: "member",
        })
      ).status,
    ).toBe(200);

    demoted.received.length = 0;
    stayer.received.length = 0;
    await say(stayer.socket, owner, privateChannelId, "after");
    expect(typesOf(demoted.received)).not.toContain("message-broadcast");

    // And the demotion is not a kick: they keep the public channel.
    const publicView = recordingSocket();
    await handleChatMessage(
      { socket: publicView.socket, user: await dbUser(admin.id) },
      { type: "join-channel", channelId },
    );
    publicView.received.length = 0;
    await say(fakeSocket(), owner, channelId, "still visible");
    expect(typesOf(publicView.received)).toContain("message-broadcast");
  });

  it("does not evict a demoted admin from a private channel they were added to", async () => {
    // The `NOT EXISTS` half of the query. An admin who was *also* explicitly
    // added keeps the channel as a plain member, and evicting them would be a
    // bug in the opposite direction.
    expect(
      (
        await call(
          owner,
          "POST",
          `/api/channels/${privateChannelId}/members`,
          { userId: admin.id },
        )
      ).status,
    ).toBe(201);

    const kept = recordingSocket();
    await handleChatMessage(
      { socket: kept.socket, user: await dbUser(admin.id) },
      { type: "join-channel", channelId: privateChannelId },
    );

    expect(
      (
        await call(owner, "PATCH", `/api/servers/${serverId}/members/${admin.id}`, {
          role: "member",
        })
      ).status,
    ).toBe(200);

    kept.received.length = 0;
    await say(fakeSocket(), owner, privateChannelId, "still theirs");
    expect(typesOf(kept.received)).toContain("message-broadcast");
  });

  // ------------------------------------------- operator account termination

  it("lets an instance moderator terminate an account, and nobody else", async () => {
    process.env.INSTANCE_MODERATOR_CLERK_IDS = bystander.clerk_id;

    // A server owner has no standing here: destroying an account reaches every
    // server it is in and every conversation it is part of. 404, not 403 —
    // whether this deployment has operators at all is not a fact to confirm.
    expect(
      (await call(owner, "DELETE", `/api/admin/users/${member.id}`)).status,
    ).toBe(404);

    expect(
      (await call(bystander, "DELETE", `/api/admin/users/${member.id}`)).status,
    ).toBe(200);
    const gone = await getPool().query(`SELECT 1 FROM users WHERE id = $1`, [
      member.id,
    ]);
    expect(gone.rows).toHaveLength(0);
  });

  it("refuses to terminate an account that owns a populated server", async () => {
    process.env.INSTANCE_MODERATOR_CLERK_IDS = bystander.clerk_id;
    // Same rule as self-serve deletion, and not a formality: `servers.owner_id`
    // cascades, so overriding it would destroy every message every other member
    // of that server ever wrote in order to remove one person.
    const refused = await call<{ code: string; servers: unknown[] }>(
      bystander,
      "DELETE",
      `/api/admin/users/${owner.id}`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("owned_servers");
    expect(refused.body.servers).toHaveLength(1);
  });
});

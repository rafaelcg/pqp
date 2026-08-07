import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isThreadArchived, THREAD_AUTO_ARCHIVE_DAYS } from "@pqp/shared";

/**
 * Threads: the model is "a thread is a channel", so most of what these tests
 * pin is that the existing machinery really does cover threads by
 * construction — and above all that VISIBILITY FOLLOWS THE PARENT. A thread
 * under a private channel failing anything but closed for a non-member is the
 * one bug this feature must not ship with, so it is asked three ways: the
 * canonical predicate, the fan-out audience, and search.
 */

// TEST_DATABASE_URL wins — see the note in api.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { canAccessChannel, upsertUser } = await import("./users.js");
const {
  addChannelMember,
  createChannel,
  createServer,
  deleteChannel,
  getChannelAudience,
  listChannels,
  moveChannel,
  InvalidChannelMoveError,
} = await import("./servers.js");
const { createMessage, listMessages } = await import("./messages.js");
const {
  createThreadForMessage,
  getThreadInfo,
  listThreadChannelIds,
  listThreadsForMessages,
  ThreadTargetError,
} = await import("./threads.js");
const { searchMessages } = await import("./search.js");

describe("isThreadArchived", () => {
  it("flips exactly at the auto-archive window, with no sweeper involved", () => {
    const now = new Date("2026-08-07T12:00:00Z");
    const dayMs = 24 * 3600 * 1000;
    const fresh = new Date(now.getTime() - dayMs);
    const stale = new Date(
      now.getTime() - (THREAD_AUTO_ARCHIVE_DAYS + 1) * dayMs,
    );
    expect(isThreadArchived(fresh, now)).toBe(false);
    expect(isThreadArchived(stale, now)).toBe(true);
  });
});

describeDb("threads", () => {
  type TestUser = Awaited<ReturnType<typeof upsertUser>>;
  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let serverId: string;
  let publicChannelId: string;
  let privateChannelId: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);

    const makeUser = (name: string) =>
      upsertUser({
        clerkId: `clerk_${name}`,
        displayName: name,
        avatarUrl: null,
      });
    owner = await makeUser("owner");
    member = await makeUser("member");
    outsider = await makeUser("outsider");

    const createdServer = await createServer("Threads", owner.id);
    serverId = createdServer.server.id;
    publicChannelId = createdServer.channels.find((c) => c.type === "text")!.id;

    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [serverId, member.id],
    );

    privateChannelId = (
      await createChannel(serverId, "secret", "text", true)
    ).id;
  });

  async function postMessage(channelId: string, author: TestUser, body: string) {
    const message = await createMessage(channelId, author, body);
    expect(message).not.toBeNull();
    return message!;
  }

  it("starts a thread from a message and keeps it out of the channel list", async () => {
    const origin = await postMessage(publicChannelId, owner, "origin message");
    const result = await createThreadForMessage(origin.id, null);

    expect(result).not.toBeNull();
    expect(result!.created).toBe(true);
    expect(result!.thread.parentChannelId).toBe(publicChannelId);
    expect(result!.thread.rootMessageId).toBe(origin.id);
    expect(result!.thread.name).toBe("origin message");
    expect(result!.thread.replyCount).toBe(0);
    expect(result!.thread.archived).toBe(false);

    // A thread is not a sidebar row — for anyone.
    for (const user of [owner, member]) {
      const channels = await listChannels(serverId, user.id);
      expect(channels.map((c) => c.id)).not.toContain(result!.thread.channelId);
    }
    // But it IS an accessible channel.
    expect(await canAccessChannel(result!.thread.channelId, member.id)).toBe(
      true,
    );
  });

  it("hands the same thread back on a second start (one thread per message)", async () => {
    const origin = await postMessage(publicChannelId, owner, "double tap");
    const first = await createThreadForMessage(origin.id, null);
    const second = await createThreadForMessage(origin.id, "renamed attempt");

    expect(second!.created).toBe(false);
    expect(second!.thread.channelId).toBe(first!.thread.channelId);
    // The loser's name suggestion changes nothing.
    expect(second!.thread.name).toBe(first!.thread.name);
  });

  it("counts replies and surfaces the summary on the origin message", async () => {
    const origin = await postMessage(publicChannelId, owner, "start here");
    const { thread } = (await createThreadForMessage(origin.id, null))!;

    await postMessage(thread.channelId, member, "first reply");
    await postMessage(thread.channelId, owner, "second reply");

    const info = await getThreadInfo(thread.channelId);
    expect(info!.replyCount).toBe(2);

    // The chip data rides the parent channel's history page.
    const page = await listMessages(publicChannelId, { viewerId: member.id });
    const hydrated = page.messages.find((m) => m.id === origin.id);
    expect(hydrated?.thread?.channelId).toBe(thread.channelId);
    expect(hydrated?.thread?.replyCount).toBe(2);

    const byMessage = await listThreadsForMessages([origin.id]);
    expect(byMessage.get(origin.id)?.replyCount).toBe(2);
  });

  it("FAILS CLOSED: a thread under a private channel is invisible to a plain member", async () => {
    await addChannelMember(privateChannelId, owner.id);
    const origin = await postMessage(privateChannelId, owner, "private origin");
    const { thread } = (await createThreadForMessage(origin.id, null))!;
    await postMessage(thread.channelId, owner, "sensitive reply findable word");

    // The canonical predicate: the thread row itself is not private, so a
    // predicate that asked the row instead of the parent would answer true
    // here. This is the leak the parent-following branch exists to close.
    expect(await canAccessChannel(thread.channelId, member.id)).toBe(false);
    expect(await canAccessChannel(thread.channelId, outsider.id)).toBe(false);

    // The fan-out audience — what decides who gets badges.
    const audience = await getChannelAudience(thread.channelId);
    expect(audience?.has(member.id)).toBe(false);
    expect(audience?.has(owner.id)).toBe(true);

    // Search — the widest read surface in the app.
    const asOwner = await searchMessages(serverId, owner.id, "findable", 10);
    expect(asOwner.results.map((r) => r.messageId)).toContain(
      (await listMessages(thread.channelId, {})).messages[0]!.id,
    );
    const asMember = await searchMessages(serverId, member.id, "findable", 10);
    expect(asMember.results).toHaveLength(0);
  });

  it("opens with the parent: adding the member to the private channel admits them to its thread", async () => {
    await addChannelMember(privateChannelId, owner.id);
    const origin = await postMessage(privateChannelId, owner, "private origin");
    const { thread } = (await createThreadForMessage(origin.id, null))!;

    await addChannelMember(privateChannelId, member.id);
    expect(await canAccessChannel(thread.channelId, member.id)).toBe(true);
    const audience = await getChannelAudience(thread.channelId);
    expect(audience?.has(member.id)).toBe(true);
  });

  it("hides a public channel's thread from someone outside the server", async () => {
    const origin = await postMessage(publicChannelId, owner, "public origin");
    const { thread } = (await createThreadForMessage(origin.id, null))!;
    expect(await canAccessChannel(thread.channelId, outsider.id)).toBe(false);
  });

  it("refuses to nest: no thread on a message that lives in a thread", async () => {
    const origin = await postMessage(publicChannelId, owner, "origin");
    const { thread } = (await createThreadForMessage(origin.id, null))!;
    const reply = await postMessage(thread.channelId, member, "reply");

    await expect(createThreadForMessage(reply.id, null)).rejects.toBeInstanceOf(
      ThreadTargetError,
    );
  });

  it("refuses to move a thread through the sidebar-reorder path", async () => {
    const origin = await postMessage(publicChannelId, owner, "origin");
    const { thread } = (await createThreadForMessage(origin.id, null))!;

    await expect(
      moveChannel(serverId, thread.channelId, null, 0),
    ).rejects.toBeInstanceOf(InvalidChannelMoveError);
  });

  it("deletes a channel's threads with the channel", async () => {
    const origin = await postMessage(publicChannelId, owner, "origin");
    const { thread } = (await createThreadForMessage(origin.id, null))!;
    await postMessage(thread.channelId, member, "reply");

    expect(await listThreadChannelIds(publicChannelId)).toContain(
      thread.channelId,
    );
    await deleteChannel(publicChannelId);

    expect(await getThreadInfo(thread.channelId)).toBeNull();
    const orphan = await getPool().query(
      `SELECT 1 FROM channels WHERE id = $1`,
      [thread.channelId],
    );
    expect(orphan.rows).toHaveLength(0);
  });

  it("keeps the thread when the origin message is deleted, chip anchor gone", async () => {
    const origin = await postMessage(publicChannelId, owner, "origin");
    const { thread } = (await createThreadForMessage(origin.id, null))!;
    await postMessage(thread.channelId, member, "survives");

    await getPool().query(`DELETE FROM messages WHERE id = $1`, [origin.id]);

    const info = await getThreadInfo(thread.channelId);
    expect(info).not.toBeNull();
    expect(info!.rootMessageId).toBeNull();
    expect(info!.replyCount).toBe(1);
  });
});

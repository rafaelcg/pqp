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
const { canAccessChannel, markChannelRead, upsertUser } = await import(
  "./users.js"
);
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
  listActiveThreadsByParent,
  listThreadChannelIds,
  listThreadsForMessages,
  setThreadMembership,
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

  it("names who is in a thread, newest speaker first and capped", async () => {
    const origin = await postMessage(publicChannelId, owner, "who is here");
    const { thread } = (await createThreadForMessage(origin.id, null))!;
    expect(thread.participants).toEqual([]);

    await postMessage(thread.channelId, owner, "first");
    await postMessage(thread.channelId, member, "second");
    const fresh = await getThreadInfo(thread.channelId);
    expect(fresh?.participants.map((p) => p.id)).toEqual([member.id, owner.id]);

    // Somebody who spoke twice appears once, at their most recent turn.
    await postMessage(thread.channelId, owner, "third");
    const again = await getThreadInfo(thread.channelId);
    expect(again?.participants.map((p) => p.id)).toEqual([owner.id, member.id]);
  });

  it("lists a channel's active threads for the sidebar, newest first", async () => {
    const first = await postMessage(publicChannelId, owner, "older topic");
    const older = (await createThreadForMessage(first.id, null))!.thread;
    const second = await postMessage(publicChannelId, owner, "newer topic");
    const newer = (await createThreadForMessage(second.id, null))!.thread;
    await postMessage(newer.channelId, owner, "keeps it on top");

    const byParent = await listActiveThreadsByParent(
      serverId,
      [publicChannelId], 3, owner.id);
    const ids = byParent.get(publicChannelId)?.map((one) => one.channelId);
    expect(ids?.[0]).toBe(newer.channelId);
    expect(ids).toContain(older.channelId);

    // The cap is per parent, so one busy channel cannot crowd out the rest.
    expect(
      (await listActiveThreadsByParent(
      serverId,
      [publicChannelId], 1, owner.id)).get(
        publicChannelId,
      ),
    ).toHaveLength(1);
  });

  it("carries faces on a thread handed back to a second creator", async () => {
    const origin = await postMessage(publicChannelId, owner, "race the create");
    const first = (await createThreadForMessage(origin.id, null))!;
    await postMessage(first.thread.channelId, member, "said something");

    // The idempotent branch: somebody else taps "start thread" on the same
    // message and gets the existing one back. It is the same summary the chip
    // draws, so it needs the same faces.
    const second = (await createThreadForMessage(origin.id, null))!;
    expect(second.created).toBe(false);
    expect(second.thread.participants.map((p) => p.id)).toEqual([member.id]);
  });

  it("lists only the threads the reader is in", async () => {
    // Somebody else's conversation, which this reader has never touched.
    // outsider wrote it and member threaded it, so the two halves of "started
    // it" are different people and the query cannot conflate them.
    const theirs = await postMessage(publicChannelId, member, "their topic");
    const theirThread = (await createThreadForMessage(theirs.id, null))!.thread;
    await postMessage(theirThread.channelId, member, "their reply");

    const forOwner = await listActiveThreadsByParent(
      serverId,
      [publicChannelId],
      10,
      owner.id,
    );
    expect(
      (forOwner.get(publicChannelId) ?? []).map((one) => one.channelId),
    ).not.toContain(theirThread.channelId);

    // Its own author is in it, by having started it and spoken in it.
    const forMember = await listActiveThreadsByParent(
      serverId,
      [publicChannelId],
      10,
      member.id,
    );
    expect(
      (forMember.get(publicChannelId) ?? []).map((one) => one.channelId),
    ).toContain(theirThread.channelId);

    // Replying is joining.
    await postMessage(theirThread.channelId, owner, "now I am in it");
    const afterReply = await listActiveThreadsByParent(
      serverId,
      [publicChannelId],
      10,
      owner.id,
    );
    expect(
      (afterReply.get(publicChannelId) ?? []).map((one) => one.channelId),
    ).toContain(theirThread.channelId);
  });

  async function listedFor(user: TestUser): Promise<string[]> {
    const byParent = await listActiveThreadsByParent(
      serverId,
      [publicChannelId],
      10,
      user.id,
    );
    return (byParent.get(publicChannelId) ?? []).map((one) => one.channelId);
  }

  it("admits the origin's author and whoever started the thread", async () => {
    // owner wrote the message; member threads it without saying anything.
    // Both are in it: the author has a stake in the answers, and starting a
    // thread is joining it.
    const origin = await postMessage(publicChannelId, owner, "my message");
    const { thread } = (await createThreadForMessage(
      origin.id,
      null,
      member.id,
    ))!;

    expect(await listedFor(owner)).toContain(thread.channelId);
    expect(await listedFor(member)).toContain(thread.channelId);
    // outsider neither wrote the origin, started it, nor took part.
    expect(await listedFor(outsider)).not.toContain(thread.channelId);
  });

  it("joins only the starter who created it, not one who tapped start on an existing thread", async () => {
    const origin = await postMessage(publicChannelId, owner, "one thread");
    const { thread } = (await createThreadForMessage(
      origin.id,
      null,
      owner.id,
    ))!;
    const again = await createThreadForMessage(origin.id, null, member.id);
    expect(again!.created).toBe(false);
    expect(await listedFor(member)).not.toContain(thread.channelId);
  });

  it("does not count opening a thread as joining it", async () => {
    const theirs = await postMessage(publicChannelId, member, "opened topic");
    const thread = (await createThreadForMessage(theirs.id, null))!.thread;
    await postMessage(thread.channelId, member, "their reply");

    // What the panel does on open: a read cursor, and nothing else. One
    // curious click used to pin a stranger's thread for days.
    await markChannelRead(thread.channelId, owner.id);

    expect(await listedFor(owner)).not.toContain(thread.channelId);
  });

  it("leaving hides a thread until the reader speaks in it again", async () => {
    const origin = await postMessage(publicChannelId, owner, "leave topic");
    const { thread } = (await createThreadForMessage(origin.id, null))!;
    await postMessage(thread.channelId, owner, "said before leaving");
    await postMessage(thread.channelId, member, "somebody else keeps going");
    expect(await listedFor(owner)).toContain(thread.channelId);

    // A leave overrides every derived reason at once: author of the origin,
    // and having spoken before.
    await setThreadMembership(thread.channelId, owner.id, false);
    expect(await listedFor(owner)).not.toContain(thread.channelId);

    // Other people's replies do not bring it back.
    await postMessage(thread.channelId, member, "still going");
    expect(await listedFor(owner)).not.toContain(thread.channelId);
    // Nor does leaving change anybody else's list.
    expect(await listedFor(member)).toContain(thread.channelId);

    // Speaking after the leave does. Nudge the leave into the past so the
    // reply is unambiguously after it, whatever the clock resolution.
    await getPool().query(
      `UPDATE thread_memberships SET updated_at = now() - interval '1 second'
        WHERE thread_id = $1 AND user_id = $2`,
      [thread.channelId, owner.id],
    );
    await postMessage(thread.channelId, owner, "back in");
    expect(await listedFor(owner)).toContain(thread.channelId);
  });

  it("joining lists a thread the reader never spoke in, and leaving undoes it", async () => {
    const theirs = await postMessage(publicChannelId, member, "lurk topic");
    const { thread } = (await createThreadForMessage(theirs.id, null))!;
    await postMessage(thread.channelId, member, "their reply");
    expect(await listedFor(owner)).not.toContain(thread.channelId);

    await setThreadMembership(thread.channelId, owner.id, true);
    expect(await listedFor(owner)).toContain(thread.channelId);

    await setThreadMembership(thread.channelId, owner.id, false);
    expect(await listedFor(owner)).not.toContain(thread.channelId);
  });

  it("leaves archived threads out of the sidebar list", async () => {
    const origin = await postMessage(publicChannelId, owner, "quiet topic");
    const { thread } = (await createThreadForMessage(origin.id, null))!;
    const longAgo = new Date(
      Date.now() - (THREAD_AUTO_ARCHIVE_DAYS + 1) * 24 * 3600 * 1000,
    );
    await getPool().query(
      `UPDATE channels SET created_at = $2 WHERE id = $1`,
      [thread.channelId, longAgo],
    );

    const byParent = await listActiveThreadsByParent(
      serverId,
      [publicChannelId], 3, owner.id);
    expect(
      (byParent.get(publicChannelId) ?? []).map((one) => one.channelId),
    ).not.toContain(thread.channelId);
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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Conversations, pinned at the service layer.
 *
 * Direct messages are the first content in this product that is private by
 * default, so the assertions that matter most here are the negative ones: who
 * *cannot* read a conversation. A predicate that is merely usually right is a
 * privacy leak, and the two ways this could go wrong quietly are a server's
 * owner reaching into their members' DMs through the role branch, and a
 * conversation's messages surfacing in a server-scoped read that assumed every
 * channel has a server.
 */

// TEST_DATABASE_URL wins — see the note in api.test.ts. Set it to point the
// suite at a scratch database instead of the one `pnpm dev` is using.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { canAccessChannel, listUnread, markChannelRead, upsertUser } =
  await import("./users.js");
const {
  addChannelMember,
  createChannel,
  createServer,
  getChannel,
  getChannelAudience,
  listChannels,
} = await import("./servers.js");
const {
  DmRefusedError,
  getConversation,
  hideConversation,
  isDmSendBlocked,
  listConversations,
  openConversation,
  restoreDmParticipants,
} = await import("./dms.js");
const { blockUser } = await import("./blocks.js");
const { createMessage } = await import("./messages.js");
const { searchMessages } = await import("./search.js");

describeDb("conversations", () => {
  let alice: { id: string };
  let bob: { id: string };
  /** In no server with anyone — the stranger every privacy rule is about. */
  let carol: { id: string };
  let serverId: string;
  let serverChannelId: string;

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
    alice = await makeUser("alice");
    bob = await makeUser("bob");
    carol = await makeUser("carol");

    const created = await createServer("Shared", alice.id);
    serverId = created.server.id;
    serverChannelId = created.channels.find((c) => c.type === "text")!.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, bob.id],
    );
  });

  async function setPrivacy(userId: string, value: string): Promise<void> {
    await getPool().query(`UPDATE users SET dm_privacy = $2 WHERE id = $1`, [
      userId,
      value,
    ]);
  }

  async function dbUser(userId: string) {
    const result = await getPool().query(`SELECT * FROM users WHERE id = $1`, [
      userId,
    ]);
    return result.rows[0]!;
  }

  /** Post a message the way the WS handler does, mentions and all. */
  async function say(
    channelId: string,
    authorId: string,
    body: string,
  ): Promise<void> {
    const created = await createMessage(channelId, await dbUser(authorId), body);
    expect(created).not.toBeNull();
  }

  // ------------------------------------------------------------- creation

  it("opens a 1:1 and hands the same one back on the second attempt", async () => {
    const first = await openConversation(alice.id, [bob.id]);
    expect(first.created).toBe(true);

    const second = await openConversation(bob.id, [alice.id]);
    expect(second.created).toBe(false);
    expect(second.channelId).toBe(first.channelId);

    const channel = await getChannel(first.channelId);
    expect(channel?.kind).toBe("dm");
    expect(channel?.server_id).toBeNull();
  });

  it("survives two people opening the same 1:1 at the same instant", async () => {
    // The sorted-pair primary key is the only lock. Opened from both sides at
    // once so the two inserts arrive with the pair in opposite orders, which is
    // exactly the case an unsorted key would let through as two conversations.
    const [one, two] = await Promise.all([
      openConversation(alice.id, [bob.id]),
      openConversation(bob.id, [alice.id]),
    ]);
    expect(one.channelId).toBe(two.channelId);

    const pairs = await getPool().query(`SELECT * FROM dm_pairs`);
    expect(pairs.rows).toHaveLength(1);
    // The loser's channel is rolled back rather than left orphaned.
    const channels = await getPool().query(
      `SELECT id FROM channels WHERE kind = 'dm'`,
    );
    expect(channels.rows).toHaveLength(1);
  });

  it("refuses to open a conversation with yourself", async () => {
    await expect(openConversation(alice.id, [alice.id])).rejects.toThrow(
      DmRefusedError,
    );
  });

  it("creates a new group every time and records no pair for it", async () => {
    await setPrivacy(carol.id, "everyone");

    const first = await openConversation(alice.id, [bob.id, carol.id]);
    const second = await openConversation(alice.id, [bob.id, carol.id]);

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.channelId).not.toBe(first.channelId);

    const channel = await getChannel(first.channelId);
    expect(channel?.kind).toBe("group");
    const pairs = await getPool().query(`SELECT * FROM dm_pairs`);
    expect(pairs.rows).toHaveLength(0);
  });

  // ---------------------------------------------------------------- access

  it("hides a conversation from everyone who is not in it", async () => {
    const { channelId } = await openConversation(alice.id, [bob.id]);

    expect(await canAccessChannel(channelId, alice.id)).toBe(true);
    expect(await canAccessChannel(channelId, bob.id)).toBe(true);
    expect(await canAccessChannel(channelId, carol.id)).toBe(false);

    const audience = await getChannelAudience(channelId);
    expect(new Set(audience?.userIds)).toEqual(new Set([alice.id, bob.id]));
    expect(audience?.serverId).toBeNull();
    expect(audience?.kind).toBe("dm");
  });

  it("keeps a server's owner out of a conversation between two of its members", async () => {
    // The whole reason the predicate's two branches are not symmetric. Alice
    // owns the server bob and carol are both in; that must buy her nothing.
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, carol.id],
    );
    const { channelId } = await openConversation(bob.id, [carol.id]);

    expect(await canAccessChannel(channelId, alice.id)).toBe(false);
    expect(await getConversation(channelId, alice.id)).toBeNull();
    expect(new Set((await getChannelAudience(channelId))?.userIds)).toEqual(
      new Set([bob.id, carol.id]),
    );

    // And an admin of that server fares no better than its owner.
    const dave = await upsertUser({
      clerkId: "clerk_dave",
      displayName: "dave",
      avatarUrl: null,
    });
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [serverId, dave.id],
    );
    expect(await canAccessChannel(channelId, dave.id)).toBe(false);
  });

  it("never lets a conversation appear in a server's channel list", async () => {
    const { channelId } = await openConversation(alice.id, [bob.id]);
    const listed = await listChannels(serverId, alice.id);
    expect(listed.map((c) => c.id)).not.toContain(channelId);
    expect(listed.map((c) => c.id)).toContain(serverChannelId);
  });

  // -------------------------------------------------------------- privacy

  it("refuses everyone when dm_privacy is 'nobody', co-member or not", async () => {
    await setPrivacy(bob.id, "nobody");
    await expect(openConversation(alice.id, [bob.id])).rejects.toThrow(
      DmRefusedError,
    );
  });

  it("under 'server_members' allows a co-member and refuses a stranger", async () => {
    // The default, so this is what an untouched account does.
    await expect(openConversation(alice.id, [carol.id])).rejects.toThrow(
      DmRefusedError,
    );
    await expect(openConversation(alice.id, [bob.id])).resolves.toMatchObject({
      created: true,
    });
  });

  it("under 'everyone' allows a complete stranger", async () => {
    await setPrivacy(carol.id, "everyone");
    await expect(openConversation(alice.id, [carol.id])).resolves.toMatchObject(
      { created: true },
    );
  });

  it("refuses a group when any one recipient refuses", async () => {
    // A group is opened with everybody or with nobody: quietly dropping the one
    // who said no would put them in a room they refused to be in.
    await setPrivacy(carol.id, "nobody");
    await expect(
      openConversation(alice.id, [bob.id, carol.id]),
    ).rejects.toThrow(DmRefusedError);
    const channels = await getPool().query(
      `SELECT id FROM channels WHERE kind <> 'server'`,
    );
    expect(channels.rows).toHaveLength(0);
  });

  // -------------------------------------------------------------- blocking

  it("refuses to open a 1:1 in either direction once either side blocks", async () => {
    await blockUser(bob.id, alice.id);

    await expect(openConversation(alice.id, [bob.id])).rejects.toThrow(
      DmRefusedError,
    );
    // Symmetric: the person who did the blocking cannot reach through it either.
    await expect(openConversation(bob.id, [alice.id])).rejects.toThrow(
      DmRefusedError,
    );
  });

  it("closes an existing 1:1 to messages once either side blocks", async () => {
    const { channelId } = await openConversation(alice.id, [bob.id]);
    expect(await isDmSendBlocked(channelId, alice.id)).toBe(false);

    await blockUser(bob.id, alice.id);

    expect(await isDmSendBlocked(channelId, alice.id)).toBe(true);
    expect(await isDmSendBlocked(channelId, bob.id)).toBe(true);
  });

  it("does not let one block silence a whole group", async () => {
    // Nobody can be removed from a group, so a hard refusal there would let any
    // participant mute the room for everybody else.
    await setPrivacy(carol.id, "everyone");
    const { channelId } = await openConversation(alice.id, [bob.id, carol.id]);
    await blockUser(carol.id, alice.id);

    expect(await isDmSendBlocked(channelId, alice.id)).toBe(false);
  });

  it("keeps enforcing a block after the blocker closes the conversation", async () => {
    // Block, then close: two items in the same context menu, in the order a
    // person actually performs them. Closing deletes the blocker's own
    // `channel_members` row, so a guard that looks the other participant up
    // there finds nobody left to test and answers "not blocked" — the block
    // silently stops existing at the exact moment its owner acts on it.
    const { channelId } = await openConversation(alice.id, [bob.id]);
    await blockUser(alice.id, bob.id);
    expect(await hideConversation(channelId, alice.id)).toBe(true);

    expect(await isDmSendBlocked(channelId, bob.id)).toBe(true);
    // And still symmetric with the blocker's own row gone.
    expect(await isDmSendBlocked(channelId, alice.id)).toBe(true);
  });

  it("enforces a block in a group that has shrunk to two people", async () => {
    // A group never becomes a 'dm'. Gating on kind left this channel exempt
    // forever: bob opens it while still permitted, carol leaves, and what is
    // left is bob and alice alone with blocking permanently switched off.
    await setPrivacy(carol.id, "everyone");
    const { channelId } = await openConversation(bob.id, [alice.id, carol.id]);
    await blockUser(alice.id, bob.id);
    expect(await isDmSendBlocked(channelId, bob.id)).toBe(false);

    expect(await hideConversation(channelId, carol.id)).toBe(true);

    expect(await isDmSendBlocked(channelId, bob.id)).toBe(true);
    expect(await isDmSendBlocked(channelId, alice.id)).toBe(true);
  });

  it("does not let a block silence a two-person private server channel", async () => {
    // The membership half of the participant set is still gated on
    // `kind <> 'server'`. A private channel's allowlist is not a conversation,
    // and two people who happen to be its only members must keep their channel
    // even if one blocks the other.
    const secret = await createChannel(serverId, "secret", "text", true);
    await addChannelMember(secret.id, bob.id);
    await addChannelMember(secret.id, carol.id);
    await blockUser(bob.id, carol.id);

    expect(await isDmSendBlocked(secret.id, bob.id)).toBe(false);
    expect(await isDmSendBlocked(secret.id, carol.id)).toBe(false);
  });

  // ---------------------------------------------------------------- unread

  it("counts unread in a conversation without going through server_members", async () => {
    const { channelId } = await openConversation(alice.id, [bob.id]);
    await say(channelId, bob.id, "one");
    await say(channelId, bob.id, "two @alice");

    const [summary] = await listConversations(alice.id);
    expect(summary?.channelId).toBe(channelId);
    expect(summary?.unread.count).toBe(2);
    expect(summary?.unread.mentions).toBe(1);
    expect(summary?.lastMessageAt).not.toBeNull();
    // The viewer is never in their own participant list — the client titles the
    // row from it.
    expect(summary?.participants.map((p) => p.id)).toEqual([bob.id]);

    // And a conversation contributes nothing to any server's unread map.
    const serverUnread = await listUnread(serverId, alice.id);
    expect(serverUnread.map((row) => row.channelId)).not.toContain(channelId);

    await markChannelRead(channelId, alice.id);
    const [afterRead] = await listConversations(alice.id);
    expect(afterRead?.unread).toEqual({ count: 0, mentions: 0 });
  });

  it("does not carry a clerk id into a participant list", async () => {
    const { channelId } = await openConversation(alice.id, [bob.id]);
    const [summary] = await listConversations(alice.id);
    expect(summary?.channelId).toBe(channelId);
    expect(Object.keys(summary!.participants[0]!).sort()).toEqual([
      "avatarUrl",
      "displayName",
      "id",
      "tag",
      "username",
    ]);
  });

  it("resolves a mention in a conversation against its participants", async () => {
    // The old query reached the mentionable set through the channel's server,
    // which for a conversation is NULL and matches nobody — every DM mention
    // would have silently recorded no row at all.
    const { channelId } = await openConversation(alice.id, [bob.id]);
    const aliceRow = await dbUser(alice.id);
    await say(channelId, bob.id, `hey @${aliceRow.username}`);

    const mentions = await getPool().query(
      `SELECT user_id FROM message_mentions`,
    );
    expect(mentions.rows.map((r) => r.user_id)).toEqual([alice.id]);
  });

  it("does not mention somebody who is not in the conversation", async () => {
    await setPrivacy(carol.id, "everyone");
    const { channelId } = await openConversation(alice.id, [bob.id]);
    const carolRow = await dbUser(carol.id);
    await say(channelId, bob.id, `hey @${carolRow.username}`);

    const mentions = await getPool().query(
      `SELECT user_id FROM message_mentions`,
    );
    expect(mentions.rows).toHaveLength(0);
  });

  // ----------------------------------------------------------------- hide

  it("hides a conversation for one side only, and restores it on a reply", async () => {
    const { channelId } = await openConversation(alice.id, [bob.id]);
    await say(channelId, bob.id, "still here");

    expect(await hideConversation(channelId, alice.id)).toBe(true);

    // Gone from her list and from her reach — but the channel, its history and
    // the other participant are untouched.
    expect(await listConversations(alice.id)).toHaveLength(0);
    expect(await canAccessChannel(channelId, alice.id)).toBe(false);
    expect(await listConversations(bob.id)).toHaveLength(1);
    const messages = await getPool().query(
      `SELECT id FROM messages WHERE channel_id = $1`,
      [channelId],
    );
    expect(messages.rows).toHaveLength(1);

    // The next thing said in it brings her back, with the history intact.
    await restoreDmParticipants(channelId);
    expect(await canAccessChannel(channelId, alice.id)).toBe(true);
    const [restored] = await listConversations(alice.id);
    expect(restored?.channelId).toBe(channelId);
  });

  it("refuses to hide a server channel through the conversation route", async () => {
    // `c.kind <> 'server'` is load-bearing: without it this becomes a way to
    // drop a `channel_members` row that belongs to a private server channel's
    // allowlist. Asked against a channel bob genuinely has a row in, because a
    // channel nobody has a row in answers "nothing deleted" either way and
    // proves nothing.
    const secret = await createChannel(serverId, "secret", "text", true);
    await addChannelMember(secret.id, bob.id);

    expect(await hideConversation(secret.id, bob.id)).toBe(false);
    expect(await canAccessChannel(secret.id, bob.id)).toBe(true);
    // And the public one, where the caller has no row at all.
    expect(await hideConversation(serverChannelId, alice.id)).toBe(false);
  });

  it("reopening after hiding returns the original conversation, not a second one", async () => {
    const first = await openConversation(alice.id, [bob.id]);
    await say(first.channelId, bob.id, "history");
    await hideConversation(first.channelId, alice.id);

    const reopened = await openConversation(alice.id, [bob.id]);
    expect(reopened.created).toBe(false);
    expect(reopened.channelId).toBe(first.channelId);
    expect(await canAccessChannel(first.channelId, alice.id)).toBe(true);
  });

  // --------------------------------------------------------------- search

  it("never returns a conversation's messages from server search", async () => {
    // Search is the widest read surface in the app. It is server-scoped, and
    // the point of this assertion is that "scoped" holds by construction rather
    // than by luck once channels exist that belong to no server.
    const { channelId } = await openConversation(alice.id, [bob.id]);
    await say(channelId, bob.id, "pineapple in the direct message");
    await say(serverChannelId, bob.id, "pineapple in the server channel");

    const results = await searchMessages(serverId, alice.id, "pineapple", 20);
    expect(results.results).toHaveLength(1);
    expect(results.results[0]?.channelId).toBe(serverChannelId);
  });
});

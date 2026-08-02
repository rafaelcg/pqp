import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Blocking, pinned where it is actually enforced.
 *
 * A client-side hide is not a block, so none of these go through the UI's idea
 * of one: each asserts on the server-side path a blocked person would have to
 * travel to reach somebody — the mention table, the unread count, and the
 * message payload. The one thing deliberately *not* asserted is that their
 * messages disappear from a shared server channel, because they must not:
 * dropping rows would corrupt the keyset pagination that reports whether there
 * is more history.
 */

// TEST_DATABASE_URL wins — see the note in api.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { listUnread, upsertUser } = await import("./users.js");
const { createServer } = await import("./servers.js");
const {
  blockUser,
  listBlockedAmong,
  listBlockersOf,
  listBlocks,
  SelfBlockError,
  unblockUser,
} = await import("./blocks.js");
const { createMessage, listMessages, mapMessage } = await import(
  "./messages.js"
);

describeDb("blocking", () => {
  let target: { id: string };
  let nuisance: { id: string };
  let bystander: { id: string };
  let serverId: string;
  let channelId: string;

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
    target = await makeUser("target");
    nuisance = await makeUser("nuisance");
    bystander = await makeUser("bystander");

    const created = await createServer("Shared", target.id);
    serverId = created.server.id;
    channelId = created.channels.find((c) => c.type === "text")!.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
      [serverId, nuisance.id, bystander.id],
    );
  });

  async function dbUser(userId: string) {
    const result = await getPool().query(`SELECT * FROM users WHERE id = $1`, [
      userId,
    ]);
    return result.rows[0]!;
  }

  async function say(authorId: string, body: string): Promise<string> {
    const created = await createMessage(channelId, await dbUser(authorId), body);
    expect(created).not.toBeNull();
    return created!.id;
  }

  async function unreadFor(userId: string) {
    const rows = await listUnread(serverId, userId);
    return rows.find((row) => row.channelId === channelId)!;
  }

  // ------------------------------------------------------------ bookkeeping

  it("is idempotent, and says which call actually created the block", async () => {
    expect(await blockUser(target.id, nuisance.id)).toBe(true);
    expect(await blockUser(target.id, nuisance.id)).toBe(false);

    const rows = await getPool().query(`SELECT * FROM user_blocks`);
    expect(rows.rows).toHaveLength(1);
  });

  it("refuses to block yourself", async () => {
    await expect(blockUser(target.id, target.id)).rejects.toThrow(
      SelfBlockError,
    );
  });

  it("unblocks", async () => {
    await blockUser(target.id, nuisance.id);
    await unblockUser(target.id, nuisance.id);
    expect(await listBlocks(target.id)).toHaveLength(0);
  });

  it("describes a blocked person with no more than any stranger could see", async () => {
    // Blocking somebody must not become a way to learn more about them.
    await blockUser(target.id, nuisance.id);
    const [entry] = await listBlocks(target.id);
    expect(Object.keys(entry!).sort()).toEqual([
      "avatarUrl",
      "blockedAt",
      "displayName",
      "id",
      "tag",
      "username",
    ]);
    expect(entry!.id).toBe(nuisance.id);
  });

  it("lists a block only for the person who made it", async () => {
    await blockUser(target.id, nuisance.id);
    expect(await listBlocks(nuisance.id)).toHaveLength(0);
  });

  it("reads the blocker set from the blocked person's side", async () => {
    await blockUser(target.id, nuisance.id);
    expect(await listBlockersOf(nuisance.id)).toEqual(new Set([target.id]));
    expect(await listBlockersOf(target.id)).toEqual(new Set());
  });

  it("answers which of a set of authors the viewer has blocked", async () => {
    await blockUser(target.id, nuisance.id);
    expect(
      await listBlockedAmong(target.id, [nuisance.id, bystander.id]),
    ).toEqual(new Set([nuisance.id]));
    expect(await listBlockedAmong(target.id, [])).toEqual(new Set());
  });

  // ----------------------------------------------------------- enforcement

  it("stops a blocked person from mentioning you", async () => {
    const targetRow = await dbUser(target.id);
    await blockUser(target.id, nuisance.id);

    await say(nuisance.id, `oi @${targetRow.username}`);
    expect(
      (await getPool().query(`SELECT user_id FROM message_mentions`)).rows,
    ).toHaveLength(0);

    // Everybody else's mentions still land, so this is a block and not a
    // broken mention parser.
    await say(bystander.id, `hello @${targetRow.username}`);
    expect(
      (await getPool().query(`SELECT user_id FROM message_mentions`)).rows.map(
        (r) => r.user_id,
      ),
    ).toEqual([target.id]);
  });

  it("stops a blocked person from mentioning you by replying to you", async () => {
    // A reply is a mention, so leaving this out would make quote-and-respond
    // the way around a block.
    const parentId = await say(target.id, "the original");
    await blockUser(target.id, nuisance.id);

    const reply = await createMessage(
      channelId,
      await dbUser(nuisance.id),
      "answering you",
      parentId,
    );
    expect(reply).not.toBeNull();
    expect(
      (await getPool().query(`SELECT user_id FROM message_mentions`)).rows,
    ).toHaveLength(0);
  });

  it("keeps a blocked person's messages out of your unread count", async () => {
    await say(nuisance.id, "before the block");
    expect((await unreadFor(target.id)).count).toBe(1);

    await blockUser(target.id, nuisance.id);
    expect((await unreadFor(target.id)).count).toBe(0);

    // Only for the person who blocked them.
    expect((await unreadFor(bystander.id)).count).toBe(1);

    await say(bystander.id, "and this still counts");
    expect((await unreadFor(target.id)).count).toBe(1);
  });

  it("marks a blocked author's messages rather than dropping them", async () => {
    // Filtering server-channel history server-side would corrupt the keyset
    // page: `hasMore` is derived from how many rows the query read, so a page
    // silently short of its limit reads as "history ran out".
    await say(nuisance.id, "one");
    await say(bystander.id, "two");
    await say(nuisance.id, "three");
    await blockUser(target.id, nuisance.id);

    const page = await listMessages(channelId, { viewerId: target.id });
    const mapped = page.messages.map(mapMessage);
    expect(mapped).toHaveLength(3);
    expect(mapped.map((m) => m.blocked)).toEqual([true, false, true]);
  });

  it("marks nothing for a viewer who has blocked nobody", async () => {
    await say(nuisance.id, "one");
    await blockUser(target.id, nuisance.id);

    const page = await listMessages(channelId, { viewerId: bystander.id });
    expect(page.messages.map(mapMessage).map((m) => m.blocked)).toEqual([false]);
  });

  it("goes away again when the block is lifted", async () => {
    await say(nuisance.id, "one");
    await blockUser(target.id, nuisance.id);
    await unblockUser(target.id, nuisance.id);

    expect((await unreadFor(target.id)).count).toBe(1);
    const page = await listMessages(channelId, { viewerId: target.id });
    expect(page.messages.map(mapMessage).map((m) => m.blocked)).toEqual([false]);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The channel-visibility predicate, pinned on its own.
 *
 * Every read path in the app now defers to one function, so a change to it can
 * no longer be caught by whichever endpoint test happened to cover a channel of
 * that shape. These state the rule directly — and re-ask it through the two
 * set-returning queries that interpolate the same fragment, because the failure
 * that matters is not "the predicate is wrong" but "the predicate and the list
 * queries disagree", which is exactly what four hand-copied predicates produced.
 */

// TEST_DATABASE_URL wins — see the note in api.test.ts. Set it to point the
// suite at a scratch database instead of the one `pnpm dev` is using.
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
  getChannelAudience,
  listChannels,
} = await import("./servers.js");

describeDb("channel visibility", () => {
  let owner: { id: string };
  let admin: { id: string };
  let member: { id: string };
  let outsider: { id: string };
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
    // Everything else references users, so one CASCADE clears the graph.
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);

    const makeUser = (name: string) =>
      upsertUser({
        clerkId: `clerk_${name}`,
        displayName: name,
        avatarUrl: null,
      });
    owner = await makeUser("owner");
    admin = await makeUser("admin");
    member = await makeUser("member");
    outsider = await makeUser("outsider");

    const created = await createServer("Access", owner.id);
    serverId = created.server.id;
    publicChannelId = created.channels.find((c) => c.type === "text")!.id;

    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($1, $3, 'member')`,
      [serverId, admin.id, member.id],
    );

    privateChannelId = (
      await createChannel(serverId, "secret", "text", true)
    ).id;
  });

  /** Ids the audience query hands a new message to, as a set for containment. */
  async function audience(channelId: string): Promise<Set<string>> {
    const result = await getChannelAudience(channelId);
    return new Set(result?.userIds ?? []);
  }

  async function visibleChannelIds(userId: string): Promise<Set<string>> {
    const channels = await listChannels(serverId, userId);
    return new Set(channels.map((c) => c.id));
  }

  it("shows a public channel to every member of the server", async () => {
    for (const user of [owner, admin, member]) {
      expect(await canAccessChannel(publicChannelId, user.id)).toBe(true);
      expect(await visibleChannelIds(user.id)).toContain(publicChannelId);
    }
    expect(await audience(publicChannelId)).toEqual(
      new Set([owner.id, admin.id, member.id]),
    );
  });

  it("hides a private channel from a member with no channel_members row", async () => {
    expect(await canAccessChannel(privateChannelId, member.id)).toBe(false);
    expect(await visibleChannelIds(member.id)).not.toContain(privateChannelId);
    expect(await audience(privateChannelId)).not.toContain(member.id);
  });

  it("shows a private channel to the owner and to admins without such a row", async () => {
    for (const user of [owner, admin]) {
      expect(await canAccessChannel(privateChannelId, user.id)).toBe(true);
      expect(await visibleChannelIds(user.id)).toContain(privateChannelId);
    }
    expect(await audience(privateChannelId)).toEqual(
      new Set([owner.id, admin.id]),
    );
  });

  it("shows a private channel to a plain member who has one", async () => {
    await addChannelMember(privateChannelId, member.id);

    expect(await canAccessChannel(privateChannelId, member.id)).toBe(true);
    expect(await visibleChannelIds(member.id)).toContain(privateChannelId);
    expect(await audience(privateChannelId)).toContain(member.id);
  });

  it("hides every channel from someone who is not in the server", async () => {
    expect(await canAccessChannel(publicChannelId, outsider.id)).toBe(false);
    expect(await canAccessChannel(privateChannelId, outsider.id)).toBe(false);
    expect(await visibleChannelIds(outsider.id)).toEqual(new Set());
    expect(await audience(publicChannelId)).not.toContain(outsider.id);
  });

  it("does not let a stale channel_members row outlive server membership", async () => {
    // A channel_members row alone must never grant access: the row survives a
    // direct insert, a future DM model reuses this table, and the server_members
    // join is the only thing standing between the two.
    await addChannelMember(privateChannelId, outsider.id);

    expect(await canAccessChannel(privateChannelId, outsider.id)).toBe(false);
    expect(await audience(privateChannelId)).not.toContain(outsider.id);
  });
});

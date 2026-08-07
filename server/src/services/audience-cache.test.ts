import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The channel-audience cache, pinned as an ACCESS-CONTROL cache.
 *
 * `access.test.ts` next door pins what the predicate answers. This pins that
 * the cache in front of it stops answering the moment the answer changes —
 * which is a different property and a more dangerous one to get wrong, because
 * a cache is silent when it is stale. Every test here is of the form "warm the
 * cache, revoke something, ask again", in that order, because the bug this
 * cache can have is invisible if the read happens first.
 */

// TEST_DATABASE_URL wins — see the note in api.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const {
  canAccessChannel,
  leaveServer,
  updateMemberRole,
  upsertUser,
} = await import("./users.js");
const {
  addChannelMember,
  channelAudienceCacheStats,
  clearChannelAudienceCache,
  createChannel,
  createServer,
  deleteChannel,
  getChannelAudience,
  removeChannelMember,
  sweepChannelAudiences,
  updateChannel,
} = await import("./servers.js");
const { banMember, kickMember } = await import("./moderation.js");
const { hideConversation, openConversation } = await import("./dms.js");
const { blockUser, listBlockersOf } = await import("./blocks.js");

describeDb("channel audience cache", () => {
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
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    // A raw TRUNCATE goes round every invalidation hook there is, which is
    // exactly why the cache exports this.
    clearChannelAudienceCache();

    const makeUser = (name: string) =>
      upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null });
    owner = await makeUser("owner");
    admin = await makeUser("admin");
    member = await makeUser("member");
    outsider = await makeUser("outsider");

    const created = await createServer("Audience", owner.id);
    serverId = created.server.id;
    publicChannelId = created.channels.find((c) => c.type === "text")!.id;

    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($1, $3, 'member')`,
      [serverId, admin.id, member.id],
    );
    privateChannelId = (await createChannel(serverId, "secret", "text", true)).id;
    await addChannelMember(privateChannelId, member.id);
  });

  async function audience(channelId: string): Promise<Set<string>> {
    return new Set((await getChannelAudience(channelId))?.userIds ?? []);
  }

  /**
   * The audience read through `canAccessChannel`, one user at a time. That
   * function takes no part in the cache, so this is the uncached answer — and
   * the only comparison worth making, since the whole risk is the two drifting.
   */
  async function byPredicate(channelId: string): Promise<Set<string>> {
    const everyone = [owner, admin, member, outsider];
    const allowed = new Set<string>();
    for (const user of everyone) {
      if (await canAccessChannel(channelId, user.id)) {
        allowed.add(user.id);
      }
    }
    return allowed;
  }

  // ------------------------------------------------- cached === uncached

  it("agrees with the uncached predicate on a public channel, warm and cold", async () => {
    expect(await audience(publicChannelId)).toEqual(await byPredicate(publicChannelId));
    // Second time is the cached read. Same question, same answer.
    expect(await audience(publicChannelId)).toEqual(
      new Set([owner.id, admin.id, member.id]),
    );
    expect(channelAudienceCacheStats().entries).toBe(1);
  });

  it("agrees with the uncached predicate on a private channel, warm and cold", async () => {
    expect(await audience(privateChannelId)).toEqual(
      await byPredicate(privateChannelId),
    );
    expect(await audience(privateChannelId)).toEqual(
      new Set([owner.id, admin.id, member.id]),
    );
  });

  it("agrees with the uncached predicate on a conversation, and never caches one", async () => {
    // Two members of the same server, so default `server_members` DM privacy
    // lets the conversation open at all.
    const { channelId } = await openConversation(member.id, [admin.id]);

    expect(await audience(channelId)).toEqual(await byPredicate(channelId));
    expect(await audience(channelId)).toEqual(new Set([member.id, admin.id]));

    // A conversation's audience is two rows off an index, and
    // `restoreDmParticipants` rewrites its membership on the message path
    // itself — so caching one would buy nothing and could swallow the first
    // message into a reopened DM. Nothing is stored.
    expect(channelAudienceCacheStats().entries).toBe(0);

    await hideConversation(channelId, admin.id);
    expect(await audience(channelId)).toEqual(new Set([member.id]));
  });

  // -------------------------------------------------------- revocation

  it("drops a kicked member from a warm audience immediately", async () => {
    expect(await audience(publicChannelId)).toContain(member.id);

    await kickMember(serverId, member.id);

    expect(await audience(publicChannelId)).not.toContain(member.id);
    expect(await audience(privateChannelId)).not.toContain(member.id);
    expect(await audience(publicChannelId)).toEqual(
      await byPredicate(publicChannelId),
    );
  });

  it("drops a banned member from a warm audience immediately", async () => {
    expect(await audience(publicChannelId)).toContain(member.id);

    await banMember(serverId, member.id, owner.id, "spam");

    expect(await audience(publicChannelId)).not.toContain(member.id);
  });

  it("drops a member who left from a warm audience immediately", async () => {
    expect(await audience(publicChannelId)).toContain(member.id);

    await leaveServer(serverId, member.id);

    expect(await audience(publicChannelId)).not.toContain(member.id);
  });

  it("drops someone removed from a private channel's list immediately", async () => {
    expect(await audience(privateChannelId)).toContain(member.id);

    await removeChannelMember(privateChannelId, member.id);

    expect(await audience(privateChannelId)).not.toContain(member.id);
    expect(await audience(privateChannelId)).toEqual(
      await byPredicate(privateChannelId),
    );
    // Still in the server, so still in the public channel. A channel-scoped
    // invalidation must not be read as a server-scoped one.
    expect(await audience(publicChannelId)).toContain(member.id);
  });

  it("drops a demoted admin from a private channel immediately", async () => {
    // The narrowing with no membership row to delete and no live view to
    // evict: `channelVisibleSql` admits admins to private channels on their
    // rank alone, so `admin` → `member` revokes access invisibly.
    expect(await audience(privateChannelId)).toContain(admin.id);

    await updateMemberRole(serverId, admin.id, "member");

    expect(await audience(privateChannelId)).not.toContain(admin.id);
    expect(await audience(privateChannelId)).toEqual(
      await byPredicate(privateChannelId),
    );
  });

  it("drops everyone without a list row when a channel is turned private", async () => {
    expect(await audience(publicChannelId)).toContain(member.id);

    await updateChannel(publicChannelId, { isPrivate: true });

    expect(await audience(publicChannelId)).toEqual(new Set([owner.id, admin.id]));
  });

  it("stops answering at all once the channel is deleted", async () => {
    expect(await audience(publicChannelId)).toContain(owner.id);

    await deleteChannel(publicChannelId);

    expect(await getChannelAudience(publicChannelId)).toBeNull();
  });

  it("admits a newly added private-channel member without waiting for the TTL", async () => {
    // The widening direction. Getting it wrong costs a badge rather than
    // leaking one, but "you were added and the channel looks dead" is still a
    // bug somebody would file.
    expect(await audience(privateChannelId)).not.toContain(outsider.id);
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, outsider.id],
    );

    await addChannelMember(privateChannelId, outsider.id);

    expect(await audience(privateChannelId)).toContain(outsider.id);
  });

  // ------------------------------------------------------------- blocks

  it("does not cache who has blocked an author", async () => {
    // `listBlockersOf` is the other half of the notification decision and is
    // deliberately left uncached: it is one index probe returning almost
    // always zero rows (measured at 0.4ms against the audience query's 144ms
    // on a 20k-member server), and a block is the one sanction a user applies
    // for themselves — "I blocked them and they can still ping me for three
    // seconds" is precisely what a block exists to prevent.
    expect(await listBlockersOf(outsider.id)).toEqual(new Set());

    await blockUser(member.id, outsider.id);

    expect(await listBlockersOf(outsider.id)).toEqual(new Set([member.id]));
    // And the block does not change who may *see* the channel — a block takes
    // away the notification, not the access.
    expect(await audience(publicChannelId)).toEqual(
      await byPredicate(publicChannelId),
    );
  });

  // -------------------------------------------------------------- bounds

  it("gives its memory back when swept", async () => {
    await audience(publicChannelId);
    await audience(privateChannelId);
    expect(channelAudienceCacheStats().entries).toBe(2);
    expect(channelAudienceCacheStats().userIds).toBeGreaterThan(0);

    sweepChannelAudiences(Date.now() + 60_000);

    // Both counters, not just the map: an id count that only ever climbs would
    // make the id cap fire forever and evict every entry on every store.
    expect(channelAudienceCacheStats()).toEqual({ entries: 0, userIds: 0 });
  });

  it("keeps entries that have not expired", async () => {
    await audience(publicChannelId);
    sweepChannelAudiences(Date.now());
    expect(channelAudienceCacheStats().entries).toBe(1);
  });
});

/**
 * Two instances, one database, one bus — the shape a second Fly machine
 * creates. The failure this pins is the whole reason the cache publishes at
 * all: instance A holds an audience, instance B processes the removal, and
 * nothing in A's own process ever learns about it.
 */
describeDb("channel audience cache across instances", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  it("drops an audience cached here when another instance revokes access", async () => {
    const busA = await import("../lib/bus.js");
    const hub = busA.createMemoryHub();
    const onTheWire: { topic: string }[] = [];
    hub.listeners.add((frame) => onTheWire.push(frame));

    // A second module graph is the only way to have two "instances" in one
    // process: the cache, like every other piece of realtime state here, is a
    // module-level map.
    vi.resetModules();
    const busB = await import("../lib/bus.js");
    const serversB = await import("./servers.js");
    const dbB = await import("../db.js");

    busA.setBusTransport(busA.createMemoryTransport(hub));
    busB.setBusTransport(busB.createMemoryTransport(hub));

    try {
      await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
      clearChannelAudienceCache();

      const owner = await upsertUser({
        clerkId: "clerk_cluster_owner",
        displayName: "owner",
        avatarUrl: null,
      });
      const guest = await upsertUser({
        clerkId: "clerk_cluster_guest",
        displayName: "guest",
        avatarUrl: null,
      });
      const { server } = await createServer("Cluster", owner.id);
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [server.id, guest.id],
      );
      const channelId = (await createChannel(server.id, "secret", "text", true))
        .id;
      await addChannelMember(channelId, guest.id);

      // A holds the audience.
      const warm = await getChannelAudience(channelId);
      expect(warm?.has(guest.id)).toBe(true);

      // B does the revoking, and never touches A's memory.
      await serversB.removeChannelMember(channelId, guest.id);
      expect(onTheWire.some((f) => f.topic === "audience.invalidate")).toBe(true);

      const after = await getChannelAudience(channelId);
      expect(after?.has(guest.id)).toBe(false);
    } finally {
      busA.setBusTransport(null);
      busB.setBusTransport(null);
      await dbB.closePool();
    }
  });
});

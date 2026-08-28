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
const {
  assignRole,
  createRole,
  deleteChannelOverwrite,
  listRoles,
  reorderRoles,
  unassignRole,
  updateRole,
  upsertChannelOverwrite,
} = await import("./roles.js");
const { parsePermissions, Permission } = await import("@pqp/shared");
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

  // -------------------------------------------------------------- roles

  /**
   * The invalidation edges the roles feature added, which are the youngest and
   * least-proven ones here.
   *
   * Before roles, an audience changed only when a *membership row* changed, and
   * every test above is of that shape. `channel_viewable` now also reads
   * `roles.permissions`, `member_roles` and `channel_overwrites`, so three more
   * tables can silently narrow access with no membership row touched at all.
   * These pin that each of them still invalidates.
   */

  /** The @everyone role, which every server bootstraps and nothing deletes. */
  async function everyoneRole() {
    return (await listRoles(serverId)).find((role) => role.is_everyone)!;
  }

  it("drops a member denied VIEW by a member overwrite immediately", async () => {
    expect(await audience(publicChannelId)).toContain(member.id);

    await upsertChannelOverwrite(
      publicChannelId,
      serverId,
      "member",
      member.id,
      0n,
      Permission.VIEW_CHANNEL,
    );

    expect(await audience(publicChannelId)).not.toContain(member.id);
    expect(await audience(publicChannelId)).toEqual(
      await byPredicate(publicChannelId),
    );
  });

  it("readmits them when the overwrite is deleted", async () => {
    // The widening direction of the same edge. `deleteChannelOverwrite` is a
    // separate function from the upsert and invalidates on its own account.
    await upsertChannelOverwrite(
      publicChannelId,
      serverId,
      "member",
      member.id,
      0n,
      Permission.VIEW_CHANNEL,
    );
    expect(await audience(publicChannelId)).not.toContain(member.id);

    await deleteChannelOverwrite(publicChannelId, serverId, "member", member.id);

    expect(await audience(publicChannelId)).toContain(member.id);
  });

  it("drops a member the moment they are given a role that denies VIEW", async () => {
    // Two writes, two tables, and only the second one touches the member:
    // the overwrite names a role nobody holds yet, so the audience cannot
    // change until `assignRole` writes the `member_roles` row.
    const role = await createRole(serverId, { name: "Silenced", permissions: 0n });
    await upsertChannelOverwrite(
      publicChannelId,
      serverId,
      "role",
      role.id,
      0n,
      Permission.VIEW_CHANNEL,
    );
    expect(await audience(publicChannelId)).toContain(member.id);

    await assignRole(serverId, member.id, role.id);

    expect(await audience(publicChannelId)).not.toContain(member.id);
    expect(await audience(publicChannelId)).toEqual(
      await byPredicate(publicChannelId),
    );
  });

  it("readmits them the moment that role is taken away", async () => {
    const role = await createRole(serverId, { name: "Silenced", permissions: 0n });
    await upsertChannelOverwrite(
      publicChannelId,
      serverId,
      "role",
      role.id,
      0n,
      Permission.VIEW_CHANNEL,
    );
    await assignRole(serverId, member.id, role.id);
    expect(await audience(publicChannelId)).not.toContain(member.id);

    await unassignRole(serverId, member.id, role.id);

    expect(await audience(publicChannelId)).toContain(member.id);
  });

  it("drops everyone when @everyone loses VIEW on the server", async () => {
    // The widest narrowing there is, and it touches no channel row and no
    // membership row: editing one role's bits. Owner stays, because
    // `channel_viewable` returns early for them.
    expect(await audience(publicChannelId)).toContain(member.id);
    const everyone = await everyoneRole();

    await updateRole(everyone, {
      permissions: parsePermissions(everyone.permissions) & ~Permission.VIEW_CHANNEL,
    });

    expect(await audience(publicChannelId)).not.toContain(member.id);
    expect(await audience(publicChannelId)).toEqual(
      await byPredicate(publicChannelId),
    );
  });

  it("admits a member as soon as a role grants them Administrator", async () => {
    // Administrator is a short-circuit inside `channel_viewable`, so this is
    // the one grant that opens a private channel without an overwrite or a
    // list row anywhere.
    expect(await audience(privateChannelId)).not.toContain(outsider.id);
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, outsider.id],
    );
    const role = await createRole(serverId, {
      name: "Staff",
      permissions: Permission.ADMINISTRATOR,
    });

    await assignRole(serverId, outsider.id, role.id);

    expect(await audience(privateChannelId)).toContain(outsider.id);
  });

  it("does not invalidate on a reorder, because rank cannot change who sees what", async () => {
    // A deliberate NON-invalidation, pinned so it stays deliberate.
    //
    // `reorderRoles` bumps `permissions_version` and every other write that
    // does so also invalidates, which makes its absence here look like an
    // oversight. It is not: `channel_viewable` aggregates role overwrites with
    // `bit_or` and never reads `roles.position`, so the resolved VIEW bit is
    // order-independent by construction. If that ever stops being true — a
    // highest-role-wins rule, say — this test fails and the invalidation has
    // to be added with it.
    const low = await createRole(serverId, { name: "Low", permissions: 0n });
    const high = await createRole(serverId, { name: "High", permissions: 0n });
    await upsertChannelOverwrite(
      publicChannelId,
      serverId,
      "role",
      low.id,
      Permission.VIEW_CHANNEL,
      0n,
    );
    await upsertChannelOverwrite(
      publicChannelId,
      serverId,
      "role",
      high.id,
      0n,
      Permission.VIEW_CHANNEL,
    );
    await assignRole(serverId, member.id, low.id);
    await assignRole(serverId, member.id, high.id);
    const before = await audience(publicChannelId);

    // Every movable role, not just the two made here: `createServer`
    // bootstraps system roles too, and a reorder must name all of them.
    // Owner is pinned at the top and may be omitted; leftover ids are ignored.
    const movable = (await listRoles(serverId))
      .filter((role) => !role.is_everyone && role.system_key !== "owner")
      .map((role) => role.id);
    await reorderRoles(serverId, [...movable].reverse(), {
      isOwner: true,
      hasAdministrator: true,
      position: 0,
    });

    expect(await audience(publicChannelId)).toEqual(before);
    expect(await audience(publicChannelId)).toEqual(
      await byPredicate(publicChannelId),
    );
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

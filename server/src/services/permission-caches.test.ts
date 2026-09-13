import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The four per-request caches added for the 2026-09-13 Vultr cutover query
 * budget: the server member list, a member's role, the channel access
 * check, and the 18+ gate status. All four share the same shape — coalesce
 * with `lib/read-cache.ts`, invalidate on the write that can move the
 * answer — and the same failure mode to guard against: a cache that outlives
 * a removal. `server/src/lib/read-cache.test.ts` and
 * `server/src/api/read-cache.test.ts` already pin the cache module itself;
 * this file pins these four call sites' own invalidation tables.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const {
  upsertUser,
  listServerMembers,
  getMemberRole,
  setMemberNickname,
  updateMemberRole,
  canAccessChannel,
} = await import("./users.js");
const { createServer, updateChannel } = await import("./servers.js");
const { kickMember, banMember } = await import("./moderation.js");
const { recordAgeDeclaration, getAgeGateStatus } = await import(
  "./age-gate.js"
);
const { resetReadCacheForTests } = await import("../lib/read-cache.js");

async function addMember(
  serverId: string,
  userId: string,
  role: "owner" | "admin" | "member" = "member",
): Promise<void> {
  await getPool().query(
    `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, $3)`,
    [serverId, userId, role],
  );
}

describeDb("per-request permission caches", () => {
  beforeAll(async () => {
    await initDb();
  });

  beforeEach(async () => {
    resetReadCacheForTests();
    await getPool().query(
      `TRUNCATE users, servers, channels, server_members, channel_members,
                roles, member_roles, server_bans
       RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    await closePool();
  });

  async function makeServerWithMember() {
    const owner = await upsertUser({
      clerkId: "clerk-owner",
      displayName: "Owner",
      avatarUrl: null,
    });
    const member = await upsertUser({
      clerkId: "clerk-member",
      displayName: "Member",
      avatarUrl: null,
    });
    const { server, channels } = await createServer("Test", owner.id);
    await addMember(server.id, member.id, "member");
    const textChannel = channels.find((c) => c.type === "text")!;
    return { owner, member, serverId: server.id, textChannelId: textChannel.id };
  }

  // ==================================================== the member list

  describe("the server member list", () => {
    it("coalesces repeated reads of the same server into one query", async () => {
      const { serverId } = await makeServerWithMember();
      const spy = vi.spyOn(getPool(), "query");
      await Promise.all(
        Array.from({ length: 10 }, () => listServerMembers(serverId)),
      );
      const memberQueries = spy.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" && call[0].includes("FROM server_members sm"),
      );
      spy.mockRestore();
      expect(memberQueries).toHaveLength(1);
    });

    it("shows a kicked member gone on the very next read", async () => {
      const { serverId, member } = await makeServerWithMember();
      const before = await listServerMembers(serverId);
      expect(before.map((m) => m.id)).toContain(member.id);

      await kickMember(serverId, member.id);

      const after = await listServerMembers(serverId);
      expect(after.map((m) => m.id)).not.toContain(member.id);
    });

    it("shows a ban's removal on the very next read", async () => {
      const { serverId, member, owner } = await makeServerWithMember();
      await listServerMembers(serverId);

      await banMember(serverId, member.id, owner.id, null);

      const after = await listServerMembers(serverId);
      expect(after.map((m) => m.id)).not.toContain(member.id);
    });

    it("shows a nickname change immediately", async () => {
      const { serverId, member } = await makeServerWithMember();
      await listServerMembers(serverId);

      await setMemberNickname(serverId, member.id, "Apelido");

      const after = await listServerMembers(serverId);
      expect(after.find((m) => m.id === member.id)?.nickname).toBe("Apelido");
    });

    it("shows a role grant immediately", async () => {
      const { serverId, member } = await makeServerWithMember();
      await listServerMembers(serverId);

      await updateMemberRole(serverId, member.id, "admin");

      const after = await listServerMembers(serverId);
      expect(after.find((m) => m.id === member.id)?.role).toBe("admin");
    });
  });

  // ===================================================== the role cache

  describe("a member's cached role", () => {
    it("denies a kicked member on the next check despite a warm cache", async () => {
      const { serverId, member } = await makeServerWithMember();
      expect(await getMemberRole(serverId, member.id)).toBe("member");

      await kickMember(serverId, member.id);

      expect(await getMemberRole(serverId, member.id)).toBeNull();
    });

    it("denies a banned member on the next check despite a warm cache", async () => {
      const { serverId, member, owner } = await makeServerWithMember();
      expect(await getMemberRole(serverId, member.id)).toBe("member");

      await banMember(serverId, member.id, owner.id, null);

      expect(await getMemberRole(serverId, member.id)).toBeNull();
    });

    it("reflects a promotion on the next check", async () => {
      const { serverId, member } = await makeServerWithMember();
      expect(await getMemberRole(serverId, member.id)).toBe("member");

      await updateMemberRole(serverId, member.id, "admin");

      expect(await getMemberRole(serverId, member.id)).toBe("admin");
    });
  });

  // =============================================== the channel access check

  describe("the channel access check", () => {
    it("denies a kicked member on the very next check despite a warm cache", async () => {
      const { serverId, member, textChannelId } = await makeServerWithMember();
      expect(await canAccessChannel(textChannelId, member.id)).toBe(true);

      await kickMember(serverId, member.id);

      expect(await canAccessChannel(textChannelId, member.id)).toBe(false);
    });

    it("denies a banned member on the very next check despite a warm cache", async () => {
      const { serverId, member, owner, textChannelId } =
        await makeServerWithMember();
      expect(await canAccessChannel(textChannelId, member.id)).toBe(true);

      await banMember(serverId, member.id, owner.id, null);

      expect(await canAccessChannel(textChannelId, member.id)).toBe(false);
    });

    it("reflects a channel going private immediately", async () => {
      const { member, textChannelId } = await makeServerWithMember();
      expect(await canAccessChannel(textChannelId, member.id)).toBe(true);

      // A plain member with no `channel_members` row of their own: turning
      // the channel private takes their access away without touching
      // `server_members` at all, which is exactly the write
      // `invalidateChannelAudience`/`invalidateChannelAccessForChannel`
      // exist to catch.
      await updateChannel(textChannelId, { isPrivate: true });

      expect(await canAccessChannel(textChannelId, member.id)).toBe(false);
    });
  });

  // ========================================================= age gate

  describe("the age gate status cache", () => {
    it("reflects a just-recorded declaration on the very next read", async () => {
      const user = await upsertUser({
        clerkId: "clerk-age",
        displayName: "Adult",
        avatarUrl: null,
      });
      expect(await getAgeGateStatus(user.id)).toBe("pending");

      await recordAgeDeclaration(user.id, { year: 1990, month: 1, day: 1 });

      expect(await getAgeGateStatus(user.id)).toBe("passed");
    });

    it("does not re-issue the query for a repeated check inside the TTL", async () => {
      const user = await upsertUser({
        clerkId: "clerk-age-2",
        displayName: "Adult",
        avatarUrl: null,
      });
      await getAgeGateStatus(user.id);
      const spy = vi.spyOn(getPool(), "query");
      await getAgeGateStatus(user.id);
      const ageQueries = spy.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" &&
          call[0].includes("age_checked_at, age_check_passed FROM users"),
      );
      spy.mockRestore();
      expect(ageQueries).toHaveLength(0);
    });
  });
});

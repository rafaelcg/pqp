import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

// These exercise real authorization/moderation logic against Postgres. They run
// only when DATABASE_URL is set (CI provides a service; locally point it at a
// throwaway database).
const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("channel access + moderation (DB-backed)", () => {
  let db: typeof import("../dist/db.js");
  let users: typeof import("../dist/services/users.js");
  let servers: typeof import("../dist/services/servers.js");
  let invites: typeof import("../dist/services/invites.js");
  let moderation: typeof import("../dist/services/moderation.js");

  beforeAll(async () => {
    db = await import("../dist/db.js");
    await db.initDb();
    users = await import("../dist/services/users.js");
    servers = await import("../dist/services/servers.js");
    invites = await import("../dist/services/invites.js");
    moderation = await import("../dist/services/moderation.js");
  });

  const makeUser = (name: string) =>
    users.upsertUser({
      clerkId: `test_${randomUUID()}`,
      displayName: name,
      avatarUrl: null,
    });

  it("lets members into channels and keeps non-members out", async () => {
    const owner = await makeUser("Owner");
    const outsider = await makeUser("Outsider");
    const { channels } = await servers.createServer("Access", owner.id);
    const textChannel = channels.find((c) => c.type === "text")!;

    expect(await users.isChannelMember(textChannel.id, owner.id)).toBe(true);
    expect(await users.isChannelMember(textChannel.id, outsider.id)).toBe(false);
  });

  it("enforces private-channel membership for plain members", async () => {
    const owner = await makeUser("PrivOwner");
    const member = await makeUser("PrivMember");
    const { server } = await servers.createServer("Private", owner.id);
    const invite = await invites.createInvite(server.id, owner.id, {});
    await invites.redeemInvite(invite.code, member.id);

    const priv = await servers.createChannel(server.id, "secret", "text", true);
    // Owner always sees it; a plain member does not until added.
    expect(await users.isChannelMember(priv.id, owner.id)).toBe(true);
    expect(await users.isChannelMember(priv.id, member.id)).toBe(false);

    await servers.addChannelMember(priv.id, member.id);
    expect(await users.isChannelMember(priv.id, member.id)).toBe(true);
  });

  it("kicks members and blocks banned users from rejoining", async () => {
    const owner = await makeUser("BanOwner");
    const member = await makeUser("BanMember");
    const { server } = await servers.createServer("Bans", owner.id);
    const invite = await invites.createInvite(server.id, owner.id, {});

    await invites.redeemInvite(invite.code, member.id);
    expect(await users.isServerMember(server.id, member.id)).toBe(true);

    await moderation.kickMember(server.id, member.id);
    expect(await users.isServerMember(server.id, member.id)).toBe(false);

    // Rejoin is possible after a kick...
    await invites.redeemInvite(invite.code, member.id);
    expect(await users.isServerMember(server.id, member.id)).toBe(true);

    // ...but not after a ban.
    await moderation.banMember(server.id, member.id, owner.id, "spam");
    expect(await users.isServerMember(server.id, member.id)).toBe(false);
    expect(await moderation.isBanned(server.id, member.id)).toBe(true);
    await expect(
      invites.redeemInvite(invite.code, member.id),
    ).rejects.toThrow(/banned/i);
  });

  it("supports pre-emptive bans of users who were never members", async () => {
    const owner = await makeUser("PreOwner");
    const stranger = await makeUser("Stranger");
    const { server } = await servers.createServer("Preemptive", owner.id);
    const invite = await invites.createInvite(server.id, owner.id, {});

    expect(await users.isServerMember(server.id, stranger.id)).toBe(false);
    // Banning a non-member succeeds and blocks a future join.
    await moderation.banMember(server.id, stranger.id, owner.id, null);
    expect(await moderation.isBanned(server.id, stranger.id)).toBe(true);
    await expect(
      invites.redeemInvite(invite.code, stranger.id),
    ).rejects.toThrow(/banned/i);
  });
});

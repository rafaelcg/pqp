import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Where a brand new account lands, pinned against a real database.
 *
 * Every rule here exists to stop the feature becoming obnoxious, and every one
 * of them is the kind of thing a plausible refactor quietly reverses. The one
 * that matters most is the third: placement is recorded in preferences, not
 * derived from membership, so leaving the community does not put you back in it
 * on the next page load.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
process.env.COMMUNITIES_ENABLED = "true";

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer } = await import("./servers.js");
const { placeInDefaultCommunity } = await import("./default-community.js");

describeDb("placeInDefaultCommunity", () => {
  beforeAll(async () => {
    await initDb();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    await getPool().query(`TRUNCATE servers RESTART IDENTITY CASCADE`);
    delete process.env.DEFAULT_COMMUNITY_SLUG;
  });

  afterAll(async () => {
    delete process.env.DEFAULT_COMMUNITY_SLUG;
    await closePool();
  });

  async function freshUser(clerkId: string) {
    return upsertUser({ clerkId, displayName: "Ana", avatarUrl: null });
  }

  /** A listed community with a slug, owned by somebody else. */
  async function community(slug: string, ownerClerkId = "clerk-owner") {
    const owner = await freshUser(ownerClerkId);
    const { server } = await createServer("QG do pqp", owner.id);
    await getPool().query(
      `UPDATE servers
          SET is_community = TRUE, community_slug = $2,
              is_community_suspended = FALSE
        WHERE id = $1`,
      [server.id, slug],
    );
    return server.id;
  }

  async function isMember(serverId: string, userId: string) {
    const result = await getPool().query(
      `SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2`,
      [serverId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  it("does nothing at all when no slug is configured", async () => {
    // Unset means off. A self-hosted instance must never silently inherit
    // pqp.gg's community, so there is no fallback value to inherit.
    const user = await freshUser("clerk-a");
    await expect(placeInDefaultCommunity(user.id)).resolves.toEqual({
      placed: false,
      reason: "disabled",
    });
  });

  it("places a brand new account", async () => {
    const serverId = await community("qg-do-pqp");
    process.env.DEFAULT_COMMUNITY_SLUG = "qg-do-pqp";
    const user = await freshUser("clerk-b");

    const result = await placeInDefaultCommunity(user.id);
    expect(result).toEqual({ placed: true, serverId });
    expect(await isMember(serverId, user.id)).toBe(true);
  });

  it("leaves alone an account that already has a community", async () => {
    // They have already answered the question this is asking.
    await community("qg-do-pqp");
    process.env.DEFAULT_COMMUNITY_SLUG = "qg-do-pqp";
    const user = await freshUser("clerk-c");
    await createServer("A turma dele", user.id);

    await expect(placeInDefaultCommunity(user.id)).resolves.toEqual({
      placed: false,
      reason: "has-servers",
    });
  });

  it("does not put somebody back after they leave", async () => {
    // THE RULE THAT MATTERS. Deriving "should we place them" from current
    // membership would re-add anybody who walked out, on their next page load,
    // forever. Placement is a fact about what we did, not about where they are.
    const serverId = await community("qg-do-pqp");
    process.env.DEFAULT_COMMUNITY_SLUG = "qg-do-pqp";
    const user = await freshUser("clerk-d");

    await placeInDefaultCommunity(user.id);
    await getPool().query(
      `DELETE FROM server_members WHERE server_id = $1 AND user_id = $2`,
      [serverId, user.id],
    );

    await expect(placeInDefaultCommunity(user.id)).resolves.toEqual({
      placed: false,
      reason: "already",
    });
    expect(await isMember(serverId, user.id)).toBe(false);
  });

  it("keeps trying while the community is unavailable, and places once it exists", async () => {
    // The first version stamped the preference on failure, so an account that
    // signed up while the community was missing could never be placed again.
    // Not being placed is a temporary state of the community, not a fact about
    // the person, so it must stay retryable.
    process.env.DEFAULT_COMMUNITY_SLUG = "qg-do-pqp";
    const user = await freshUser("clerk-e");

    await expect(placeInDefaultCommunity(user.id)).resolves.toEqual({
      placed: false,
      reason: "unavailable",
    });

    const serverId = await community("qg-do-pqp");
    await expect(placeInDefaultCommunity(user.id)).resolves.toEqual({
      placed: true,
      serverId,
    });
    expect(await isMember(serverId, user.id)).toBe(true);
  });

  it("refuses a suspended community rather than joining it", async () => {
    const serverId = await community("qg-do-pqp");
    await getPool().query(
      `UPDATE servers SET is_community_suspended = TRUE WHERE id = $1`,
      [serverId],
    );
    process.env.DEFAULT_COMMUNITY_SLUG = "qg-do-pqp";
    const user = await freshUser("clerk-f");

    await expect(placeInDefaultCommunity(user.id)).resolves.toEqual({
      placed: false,
      reason: "unavailable",
    });
    expect(await isMember(serverId, user.id)).toBe(false);
  });
});

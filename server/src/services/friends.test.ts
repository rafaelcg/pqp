import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

/**
 * Friendships, pinned at the layer that enforces them.
 *
 * The properties under test are the ones the feature's safety rests on: one
 * row per pair however the handshake interleaves, a block dominating every
 * state of the relationship (including via the schema trigger, which is why
 * these tests need a real Postgres), a decline that leaves no trace to
 * re-request against, a durable cap on outstanding requests, and — because the
 * friends list is the one surface that shows presence across server
 * boundaries — that an invisible friend resolves to offline through the exact
 * function the route stamps statuses with.
 */

// TEST_DATABASE_URL wins — see the note in api.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { blockUser, unblockUser } = await import("./blocks.js");
const { mergePreferences } = await import("./preferences.js");
const {
  acceptFriendRequest,
  areFriends,
  areFriendsSql,
  FriendRequestFloodError,
  FriendRequestRefusedError,
  listFriendships,
  removeFriendship,
  sendFriendRequest,
} = await import("./friends.js");
const { registerStatusSocket, resetStatusRegistry, resolveStatuses } =
  await import("../ws/status.js");

describeDb("friendships", () => {
  let alice: { id: string };
  let bruno: { id: string };
  let carla: { id: string };

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    resetStatusRegistry();

    const makeUser = (name: string) =>
      upsertUser({
        clerkId: `clerk_${name}`,
        displayName: name,
        avatarUrl: null,
      });
    alice = await makeUser("alice");
    bruno = await makeUser("bruno");
    carla = await makeUser("carla");
  });

  async function rows() {
    const result = await getPool().query(
      `SELECT * FROM friendships ORDER BY created_at`,
    );
    return result.rows;
  }

  // ---------------------------------------------------------- the handshake

  it("creates one pending row, listed as outgoing for the sender and incoming for the target", async () => {
    expect(await sendFriendRequest(alice.id, bruno.id)).toBe("pending");

    const mine = await listFriendships(alice.id);
    expect(mine.outgoing.map((r) => r.id)).toEqual([bruno.id]);
    expect(mine.incoming).toHaveLength(0);
    expect(mine.friends).toHaveLength(0);

    const theirs = await listFriendships(bruno.id);
    expect(theirs.incoming.map((r) => r.id)).toEqual([alice.id]);
    expect(theirs.outgoing).toHaveLength(0);
  });

  it("keeps one row per pair, and a resend neither duplicates nor re-freshens it", async () => {
    await sendFriendRequest(alice.id, bruno.id);
    const [before] = await rows();

    // The idempotent resend: no new row, and — the abuse half — created_at
    // untouched, so nothing keyed on it can be made to re-fire by resending.
    expect(await sendFriendRequest(alice.id, bruno.id)).toBe("already-pending");
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]!.created_at).toEqual(before!.created_at);
  });

  it("treats a request from someone who already asked you as the acceptance", async () => {
    await sendFriendRequest(alice.id, bruno.id);
    expect(await sendFriendRequest(bruno.id, alice.id)).toBe("accepted");

    expect(await rows()).toHaveLength(1);
    expect(await areFriends(alice.id, bruno.id)).toBe(true);
    expect((await listFriendships(alice.id)).friends.map((f) => f.id)).toEqual([
      bruno.id,
    ]);
    expect((await listFriendships(bruno.id)).friends.map((f) => f.id)).toEqual([
      alice.id,
    ]);
  });

  it("only lets the person who was asked accept", async () => {
    await sendFriendRequest(alice.id, bruno.id);

    // The requester "accepting" their own request must not close the handshake.
    expect(await acceptFriendRequest(alice.id, bruno.id)).toBe(false);
    expect(await areFriends(alice.id, bruno.id)).toBe(false);

    expect(await acceptFriendRequest(bruno.id, alice.id)).toBe(true);
    expect(await areFriends(alice.id, bruno.id)).toBe(true);
  });

  it("answers already-friends to a request between friends", async () => {
    await sendFriendRequest(alice.id, bruno.id);
    await acceptFriendRequest(bruno.id, alice.id);
    expect(await sendFriendRequest(alice.id, bruno.id)).toBe("already-friends");
    expect(await rows()).toHaveLength(1);
  });

  it("refuses a request to yourself", async () => {
    await expect(sendFriendRequest(alice.id, alice.id)).rejects.toThrow(
      FriendRequestRefusedError,
    );
  });

  // ------------------------------------------------- decline / cancel / end

  it("declines silently and leaves nothing behind, and a re-request is allowed", async () => {
    await sendFriendRequest(alice.id, bruno.id);

    // Decline = the recipient removes the row. Silent by construction: there
    // is nothing to notify from, and the sender's next list simply omits it.
    expect(await removeFriendship(bruno.id, alice.id)).toBe(true);
    expect(await rows()).toHaveLength(0);
    expect((await listFriendships(alice.id)).outgoing).toHaveLength(0);

    // Discord's rule: declined is not banned. The defence against a pest is
    // the rate limit and the block, not a tombstone.
    expect(await sendFriendRequest(alice.id, bruno.id)).toBe("pending");
  });

  it("cancels an outgoing request, and unfriends, through the same removal", async () => {
    await sendFriendRequest(alice.id, bruno.id);
    expect(await removeFriendship(alice.id, bruno.id)).toBe(true);

    await sendFriendRequest(alice.id, bruno.id);
    await acceptFriendRequest(bruno.id, alice.id);
    expect(await removeFriendship(alice.id, bruno.id)).toBe(true);
    expect(await areFriends(alice.id, bruno.id)).toBe(false);

    // Nothing standing answers false, so the route can 404 honestly.
    expect(await removeFriendship(alice.id, bruno.id)).toBe(false);
  });

  // ---------------------------------------------------------------- blocks

  it("refuses a request across a block, whichever side blocked", async () => {
    await blockUser(bruno.id, alice.id);
    await expect(sendFriendRequest(alice.id, bruno.id)).rejects.toThrow(
      FriendRequestRefusedError,
    );

    await unblockUser(bruno.id, alice.id);
    await blockUser(alice.id, bruno.id);
    await expect(sendFriendRequest(alice.id, bruno.id)).rejects.toThrow(
      FriendRequestRefusedError,
    );
  });

  it("ends an accepted friendship the moment either side blocks", async () => {
    await sendFriendRequest(alice.id, bruno.id);
    await acceptFriendRequest(bruno.id, alice.id);

    // The schema trigger, not application code: any path that writes a block
    // must end the friendship, so it is enforced where the block is stored.
    await blockUser(bruno.id, alice.id);
    expect(await rows()).toHaveLength(0);
    expect(await areFriends(alice.id, bruno.id)).toBe(false);
    expect((await listFriendships(alice.id)).friends).toHaveLength(0);
    expect((await listFriendships(bruno.id)).friends).toHaveLength(0);
  });

  it("kills pending requests in both directions on a block", async () => {
    await sendFriendRequest(alice.id, bruno.id);
    await blockUser(bruno.id, alice.id);
    expect(await rows()).toHaveLength(0);

    // And the mirrored direction: the *sender* blocking sweeps their own
    // outgoing request too.
    await unblockUser(bruno.id, alice.id);
    await sendFriendRequest(alice.id, bruno.id);
    await blockUser(alice.id, bruno.id);
    expect(await rows()).toHaveLength(0);
  });

  it("does not resurrect anything on unblock", async () => {
    await sendFriendRequest(alice.id, bruno.id);
    await acceptFriendRequest(bruno.id, alice.id);
    await blockUser(bruno.id, alice.id);
    await unblockUser(bruno.id, alice.id);

    // The block deleted the row; lifting the block must not bring it back —
    // a friendship that survives a block in hiding is also proof, after the
    // fact, that the block happened.
    expect(await areFriends(alice.id, bruno.id)).toBe(false);
    expect(await rows()).toHaveLength(0);
  });

  // ------------------------------------------------------------- the cap

  it("caps outstanding outgoing requests, counting only what is still pending", async () => {
    await sendFriendRequest(alice.id, bruno.id, { maxOutgoingPending: 2 });
    await sendFriendRequest(alice.id, carla.id, { maxOutgoingPending: 2 });

    const dora = await upsertUser({
      clerkId: "clerk_dora",
      displayName: "dora",
      avatarUrl: null,
    });
    await expect(
      sendFriendRequest(alice.id, dora.id, { maxOutgoingPending: 2 }),
    ).rejects.toThrow(FriendRequestFloodError);

    // An answered request frees its slot: the cap bounds standing contact
    // with strangers, not friendships.
    await acceptFriendRequest(bruno.id, alice.id);
    expect(
      await sendFriendRequest(alice.id, dora.id, { maxOutgoingPending: 2 }),
    ).toBe("pending");

    // And a resend of something already pending never burns budget.
    expect(
      await sendFriendRequest(alice.id, carla.id, { maxOutgoingPending: 2 }),
    ).toBe("already-pending");
  });

  // ------------------------------------------------------------- statuses

  it("resolves an invisible friend to offline through the function the route uses", async () => {
    await sendFriendRequest(alice.id, bruno.id);
    await acceptFriendRequest(bruno.id, alice.id);

    // Bruno chose invisible, then connected. `registerStatusSocket` reads the
    // stored choice before the socket becomes visible to anything.
    await mergePreferences(bruno.id, { status: "invisible" });
    const socket = { readyState: 1 } as unknown as WebSocket;
    await registerStatusSocket(socket, bruno.id);

    // GET /api/friends stamps status via resolveStatuses and nothing else, so
    // this equality IS the leak test: the merge can only produce `UserStatus`,
    // which cannot carry `invisible`.
    const statuses = resolveStatuses([bruno.id]);
    expect(statuses.get(bruno.id)).toBe("offline");
  });

  it("shows a connected friend as online", async () => {
    const socket = { readyState: 1 } as unknown as WebSocket;
    await registerStatusSocket(socket, bruno.id);
    expect(resolveStatuses([bruno.id]).get(bruno.id)).toBe("online");
  });

  // ----------------------------------------------- the DM-privacy fragment

  it("satisfies server_members DM privacy for a friend, via areFriendsSql", async () => {
    // The exact shape services/dms.ts's assertReachable would run with the
    // fragment added: privacy is server_members, no shared server, so only
    // the friendship can open the door.
    const reachable = async (actor: string, target: string) => {
      const result = await getPool().query<{
        dm_privacy: string;
        shares_server: boolean;
        is_friend: boolean;
      }>(
        `SELECT u.dm_privacy,
                EXISTS (
                  SELECT 1 FROM server_members mine
                  JOIN server_members theirs
                    ON theirs.server_id = mine.server_id
                   AND theirs.user_id = u.id
                  WHERE mine.user_id = $1
                ) AS shares_server,
                ${areFriendsSql("u.id", "$1")} AS is_friend
         FROM users u WHERE u.id = $2`,
        [actor, target],
      );
      const row = result.rows[0]!;
      if (row.dm_privacy === "nobody") {
        return false;
      }
      if (row.dm_privacy === "server_members") {
        return row.shares_server || row.is_friend;
      }
      return true;
    };

    await getPool().query(
      `UPDATE users SET dm_privacy = 'server_members' WHERE id = $1`,
      [bruno.id],
    );
    expect(await reachable(alice.id, bruno.id)).toBe(false);

    await sendFriendRequest(alice.id, bruno.id);
    expect(await reachable(alice.id, bruno.id)).toBe(false); // pending is not friendship

    await acceptFriendRequest(bruno.id, alice.id);
    expect(await reachable(alice.id, bruno.id)).toBe(true);

    // `nobody` stays absolute even for a friend — the decision argued on
    // `areFriendsSql`: an explicit "no DMs at all" is not voided by a
    // handshake that happened under different rules.
    await getPool().query(`UPDATE users SET dm_privacy = 'nobody' WHERE id = $1`, [
      bruno.id,
    ]);
    expect(await reachable(alice.id, bruno.id)).toBe(false);
  });
});

import {
  FRIEND_MAX_OUTGOING_PENDING,
  type FriendRequestEntry,
  type PublicUser,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { noBlockBetweenSql } from "./blocks.js";
import { toPublicUserSummary } from "./users.js";

/**
 * Friendships: requests, acceptance, and the list.
 *
 * The storage model (one row per unordered pair, state + direction) and the
 * lifecycle semantics are argued in `packages/shared/src/friends.ts` and on the
 * `friendships` table in schema.sql. What this file owns is the enforcement:
 *
 * - A BLOCK DOMINATES. The schema's trigger deletes the pair's row the moment
 *   a block is written; this file's job is the other half — never *creating* a
 *   row across a block, including in the race where the block lands between
 *   this process's check and its INSERT (the predicate rides inside the INSERT
 *   itself, so Postgres serialises the question).
 * - A REFUSAL IS NOT AN ORACLE. `FriendRequestRefusedError` carries a reason
 *   for the log and the route's own branching, but the route answers every
 *   refusal with one message — the same deal `DmRefusedError` makes, and the
 *   same one Discord makes ("unable to send") — so probing friend requests
 *   does not report who has blocked you.
 * - AN IGNORED REQUEST STAYS QUIET. Re-sending an already-pending request is a
 *   no-op that does not touch `created_at`: whatever surface ever sorts or
 *   badges on that timestamp cannot be made to re-fire by resending.
 *
 * Status is deliberately absent here. The friends *list* shows presence, but
 * presence lives in the socket registry (ws/status.ts), so the route stamps it
 * on — the same division of labour as the members list, and the reason this
 * module stays testable against nothing but Postgres.
 */

export type FriendRequestRefusalReason = "self" | "blocked";

/**
 * Why a request could not be sent. The reason must never reach the response
 * body — see the module note.
 */
export class FriendRequestRefusedError extends Error {
  constructor(readonly reason: FriendRequestRefusalReason) {
    super("Cannot send a friend request to this user");
    this.name = "FriendRequestRefusedError";
  }
}

/** Too many outstanding outgoing requests — the durable cap, not the bucket. */
export class FriendRequestFloodError extends Error {
  constructor() {
    super("Too many pending friend requests");
    this.name = "FriendRequestFloodError";
  }
}

/**
 * "These two are friends right now", as a SQL fragment — the shape
 * `noBlockBetweenSql` established. Both arguments must be UUID-typed
 * expressions.
 *
 * This is the fragment the DM privacy check wants: in `assertReachable`
 * (services/dms.ts), select it alongside `shares_server` and let it satisfy
 * the `server_members` privacy level — a friend may always DM you past
 * "server members only", because both of you said so when the request was
 * accepted. It deliberately does NOT override `nobody`: that setting is an
 * explicit "no DMs at all", chosen with full knowledge, and accepting a friend
 * request months earlier must not quietly void it.
 */
export function areFriendsSql(left: string, right: string): string {
  return `EXISTS (
           SELECT 1 FROM friendships f
           WHERE f.status = 'accepted'
             AND f.low_user_id = LEAST(${left}, ${right})
             AND f.high_user_id = GREATEST(${left}, ${right})
         )`;
}

/** The sorted pair the table is keyed by — same helper `dms.ts` keeps. */
function sortedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export async function areFriends(a: string, b: string): Promise<boolean> {
  if (a === b) {
    return false;
  }
  const result = await getPool().query<{ is_friend: boolean }>(
    `SELECT ${areFriendsSql("$1::uuid", "$2::uuid")} AS is_friend`,
    [a, b],
  );
  return result.rows[0]?.is_friend ?? false;
}

export type SendFriendRequestResult =
  | "pending"
  | "accepted"
  | "already-friends"
  | "already-pending";

interface SendOptions {
  /** Test seam for the outgoing cap; production callers never pass it. */
  maxOutgoingPending?: number;
}

/**
 * Send a request, with the four idempotent outcomes flattened into a value
 * rather than errors — none of them are: asking twice, asking somebody who
 * already asked you, and asking an existing friend are all a person tapping a
 * button whose state they had no way to know.
 */
export async function sendFriendRequest(
  actorId: string,
  targetId: string,
  options: SendOptions = {},
): Promise<SendFriendRequestResult> {
  if (actorId === targetId) {
    // The `low < high` CHECK would refuse this too, but as a 500.
    throw new FriendRequestRefusedError("self");
  }

  const blocked = await getPool().query<{ no_block: boolean }>(
    `SELECT ${noBlockBetweenSql("$1::uuid", "$2::uuid")} AS no_block`,
    [actorId, targetId],
  );
  if (!blocked.rows[0]?.no_block) {
    throw new FriendRequestRefusedError("blocked");
  }

  const [low, high] = sortedPair(actorId, targetId);

  // Two passes at most: the second only runs when this INSERT lost a race, and
  // by then the row that beat it exists (or a block does), so the second pass
  // always terminates in one of the branches below.
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await getPool().query<{
      status: "pending" | "accepted";
      requested_by: string;
    }>(
      `SELECT status, requested_by FROM friendships
       WHERE low_user_id = $1 AND high_user_id = $2`,
      [low, high],
    );
    const row = existing.rows[0];
    if (row) {
      if (row.status === "accepted") {
        return "already-friends";
      }
      if (row.requested_by === actorId) {
        // DELIBERATELY NOT `SET created_at = NOW()`: an ignored request must
        // not be re-freshened by resending, or resending becomes a bell.
        return "already-pending";
      }
      // They already asked you. Both people have now said yes — accept.
      const accepted = await getPool().query(
        `UPDATE friendships
         SET status = 'accepted', accepted_at = NOW()
         WHERE low_user_id = $1 AND high_user_id = $2
           AND status = 'pending' AND requested_by = $3`,
        [low, high, targetId],
      );
      if ((accepted.rowCount ?? 0) > 0) {
        return "accepted";
      }
      // The row changed under us (declined, or a block's trigger removed it).
      // Loop: the fresh read decides.
      continue;
    }

    // The durable cap, counted only when a new row is actually about to exist —
    // resends and auto-accepts above must not burn budget.
    const cap = options.maxOutgoingPending ?? FRIEND_MAX_OUTGOING_PENDING;
    const standing = await getPool().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM friendships
       WHERE requested_by = $1 AND status = 'pending'`,
      [actorId],
    );
    if (Number(standing.rows[0]!.count) >= cap) {
      throw new FriendRequestFloodError();
    }

    // The no-block predicate rides INSIDE the insert: between the check at the
    // top of this function and here, a block may have landed (and its trigger
    // swept the table). Re-asking in the same statement means a block and a
    // request can interleave in either order and the block still wins.
    const inserted = await getPool().query(
      `INSERT INTO friendships (low_user_id, high_user_id, requested_by)
       SELECT $1, $2, $3
       WHERE ${noBlockBetweenSql("$1::uuid", "$2::uuid")}
       ON CONFLICT (low_user_id, high_user_id) DO NOTHING`,
      [low, high, actorId],
    );
    if ((inserted.rowCount ?? 0) > 0) {
      return "pending";
    }
    // Nothing inserted: either somebody else's row won the conflict (loop and
    // read it) or the block predicate refused (loop, find nothing, fall out).
  }

  throw new FriendRequestRefusedError("blocked");
}

/**
 * Accept a pending request from `otherId`. Only the person who was ASKED may
 * accept — `requested_by = $other` is the direction check, and it is why a
 * requester cannot accept their own request from a second session. Returns
 * false when there was nothing to accept, so the route can answer 404 rather
 * than inventing a friendship.
 */
export async function acceptFriendRequest(
  actorId: string,
  otherId: string,
): Promise<boolean> {
  if (actorId === otherId) {
    return false;
  }
  const [low, high] = sortedPair(actorId, otherId);
  const result = await getPool().query(
    `UPDATE friendships
     SET status = 'accepted', accepted_at = NOW()
     WHERE low_user_id = $1 AND high_user_id = $2
       AND status = 'pending' AND requested_by = $3`,
    [low, high, otherId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * End whatever stands between these two: decline an incoming request, cancel
 * an outgoing one, or unfriend. One operation on purpose — all three are "make
 * this row not exist", their differences are entirely in who is looking, and
 * all three are silent to the other side, which is what makes declining cheap
 * enough that people actually do it.
 *
 * Returns false when there was nothing to remove.
 */
export async function removeFriendship(
  actorId: string,
  otherId: string,
): Promise<boolean> {
  if (actorId === otherId) {
    return false;
  }
  const [low, high] = sortedPair(actorId, otherId);
  const result = await getPool().query(
    `DELETE FROM friendships WHERE low_user_id = $1 AND high_user_id = $2`,
    [low, high],
  );
  return (result.rowCount ?? 0) > 0;
}

/** A friend as this module can know them — the route stamps status on top. */
export type FriendWithoutStatus = PublicUser & { friendsSince: string };

export interface Friendships {
  friends: FriendWithoutStatus[];
  incoming: FriendRequestEntry[];
  outgoing: FriendRequestEntry[];
}

interface FriendshipRow {
  status: "pending" | "accepted";
  requested_by: string;
  created_at: Date;
  accepted_at: Date | null;
  id: string;
  display_name: string;
  username: string | null;
  discriminator: string | null;
  avatar_url: string | null;
}

/**
 * Everything the viewer has: friends, requests waiting on them, requests
 * waiting on somebody else. One query — the three lists are one table read
 * apart, and splitting them would triple the round trips on the view the app
 * now opens onto.
 *
 * Every person here is `publicUserSchema` and nothing wider: a friend, and
 * even more so a stranger mid-request, sees the same shape a search result
 * shows. No block filter is needed on the read — the schema's trigger
 * guarantees a block and a friendship row never coexist.
 */
export async function listFriendships(userId: string): Promise<Friendships> {
  const result = await getPool().query<FriendshipRow>(
    `SELECT f.status, f.requested_by, f.created_at, f.accepted_at,
            u.id, u.display_name, u.username, u.discriminator, u.avatar_url
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.low_user_id = $1
                                 THEN f.high_user_id
                                 ELSE f.low_user_id END
     WHERE f.low_user_id = $1 OR f.high_user_id = $1
     ORDER BY u.display_name ASC, u.id ASC`,
    [userId],
  );

  const friends: FriendWithoutStatus[] = [];
  const incoming: FriendRequestEntry[] = [];
  const outgoing: FriendRequestEntry[] = [];

  for (const row of result.rows) {
    const person = toPublicUserSummary(row);
    if (row.status === "accepted") {
      friends.push({
        ...person,
        // `accepted_at` is non-null on every accepted row by CHECK; the
        // fallback only keeps TypeScript honest about the column's type.
        friendsSince: (row.accepted_at ?? row.created_at).toISOString(),
      });
    } else if (row.requested_by === userId) {
      outgoing.push({ ...person, requestedAt: row.created_at.toISOString() });
    } else {
      incoming.push({ ...person, requestedAt: row.created_at.toISOString() });
    }
  }

  return { friends, incoming, outgoing };
}

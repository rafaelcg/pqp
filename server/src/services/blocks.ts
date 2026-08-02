import type { BlockedUser } from "@pqp/shared";
import { getPool } from "../db.js";
import { toPublicUserSummary } from "./users.js";

/**
 * User-to-user blocking.
 *
 * Every other sanction in this product is something a moderator does on a
 * server's behalf. A block is the opposite: it is the only thing a user can do
 * for themselves, and it has to work without anybody else's involvement,
 * because a direct message is a contact channel nobody else moderates.
 *
 * Enforcement is server-side at every point. A client that hides a blocked
 * person's messages has not blocked them — they can still open a conversation,
 * still ping you, and still see everything about you they could before. What
 * follows is what makes the block real; the client's job is only to collapse
 * what the server has already decided to deliver.
 */

/**
 * "Neither of these two has blocked the other", as a SQL fragment.
 *
 * A block is stored one-directionally (blocker → blocked) but enforced
 * symmetrically: once you block somebody, neither of you can reach the other.
 * Anything less is a block that only stops the polite half of the problem.
 *
 * Both directions are indexed — the primary key serves `(user_id, ...)` and
 * `idx_user_blocks_blocked` serves the reverse — because this sits on the
 * message-send path.
 */
export function noBlockBetweenSql(left: string, right: string): string {
  return `NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.user_id = ${left} AND b.blocked_user_id = ${right})
              OR (b.user_id = ${right} AND b.blocked_user_id = ${left})
         )`;
}

/**
 * "The viewer has not blocked this author", as a SQL fragment.
 *
 * One-directional on purpose, unlike `noBlockBetweenSql`: this is the notify
 * side of a block, and the question there is only ever whose feed a message is
 * allowed into. Someone you blocked still sees your messages in a shared
 * server — blocking is not a way to hide from people.
 */
export function notBlockedSql(viewer: string, author: string): string {
  return `NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE b.user_id = ${viewer} AND b.blocked_user_id = ${author}
         )`;
}

export class SelfBlockError extends Error {
  constructor() {
    super("You cannot block yourself");
    this.name = "SelfBlockError";
  }
}

/**
 * Returns false when the block was already there, so the route can answer 200
 * rather than 201 without a second round trip.
 */
export async function blockUser(
  userId: string,
  blockedUserId: string,
): Promise<boolean> {
  if (userId === blockedUserId) {
    // The CHECK constraint would refuse this too, but as a 500. The rule is
    // worth stating where it can be answered properly.
    throw new SelfBlockError();
  }
  const result = await getPool().query(
    `INSERT INTO user_blocks (user_id, blocked_user_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, blocked_user_id) DO NOTHING`,
    [userId, blockedUserId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function unblockUser(
  userId: string,
  blockedUserId: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM user_blocks WHERE user_id = $1 AND blocked_user_id = $2`,
    [userId, blockedUserId],
  );
}

/**
 * The caller's own block list. Each entry is only ever `publicUserSchema` plus
 * the block's timestamp: blocking somebody must not become a way to learn more
 * about them than you could before.
 */
export async function listBlocks(userId: string): Promise<BlockedUser[]> {
  const result = await getPool().query<{
    id: string;
    display_name: string;
    username: string | null;
    discriminator: string | null;
    avatar_url: string | null;
    created_at: Date;
  }>(
    `SELECT u.id, u.display_name, u.username, u.discriminator, u.avatar_url,
            b.created_at
     FROM user_blocks b
     JOIN users u ON u.id = b.blocked_user_id
     WHERE b.user_id = $1
     ORDER BY b.created_at DESC`,
    [userId],
  );
  return result.rows.map((row) => ({
    ...toPublicUserSummary(row),
    blockedAt: row.created_at.toISOString(),
  }));
}

/**
 * Who has blocked this author — the set every notification path subtracts from
 * its audience before it sends anything.
 *
 * Read as a whole set rather than asked per recipient because the callers are
 * fan-outs: one message can reach an entire server's worth of sockets, and a
 * query each would put the block table on the hot path once per member.
 */
export async function listBlockersOf(authorId: string): Promise<Set<string>> {
  const result = await getPool().query<{ user_id: string }>(
    `SELECT user_id FROM user_blocks WHERE blocked_user_id = $1`,
    [authorId],
  );
  return new Set(result.rows.map((row) => row.user_id));
}

/**
 * Which of these authors the viewer has blocked.
 *
 * Used to stamp `blocked` onto a page of history. Server-channel messages are
 * deliberately *not* filtered out of the page: `listMessages` pages by keyset
 * and reports `hasMore` from the row count it read, so dropping rows after the
 * fact would make it claim history had run out in the middle of a conversation.
 * The client collapses them instead.
 */
export async function listBlockedAmong(
  viewerId: string,
  authorIds: string[],
): Promise<Set<string>> {
  if (authorIds.length === 0) {
    return new Set();
  }
  const result = await getPool().query<{ blocked_user_id: string }>(
    `SELECT blocked_user_id FROM user_blocks
     WHERE user_id = $1 AND blocked_user_id = ANY($2::uuid[])`,
    [viewerId, authorIds],
  );
  return new Set(result.rows.map((row) => row.blocked_user_id));
}

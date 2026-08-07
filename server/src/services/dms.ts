import {
  DM_MAX_RECIPIENTS,
  type ConversationKind,
  type DmPrivacy,
  type DmSummary,
  type PublicUser,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { noBlockBetweenSql, notBlockedSql } from "./blocks.js";
import { areFriendsSql } from "./friends.js";
import { toPublicUserSummary } from "./users.js";

/**
 * Conversations: 1:1 and group direct messages.
 *
 * A conversation is a `channels` row with no server, which is what lets
 * messages, edits, reactions, typing, read cursors, mentions and attachments
 * carry over untouched — the alternative, a parallel messaging path, is how
 * this feature turns into a rewrite. What is genuinely new is only how one is
 * opened, listed, and refused.
 *
 * Access is decided by `canAccessChannel`, never here. This file's job is the
 * question one step earlier: whether these two people are allowed to start
 * talking at all.
 */

/**
 * A conversation has no name — the client derives its title and its avatars
 * from the participant list. Stored empty rather than as a generated string
 * because any string we invented would be wrong the moment somebody renames
 * themselves, and `channels.name` is NOT NULL.
 */
const CONVERSATION_NAME = "";

export type DmRefusalReason =
  | "self"
  | "unknown-user"
  | "blocked"
  | "privacy"
  | "too-many";

/**
 * Why a conversation could not be opened.
 *
 * The reason is for the log and for the route's own branching, NOT for the
 * response body. "You are blocked" and "their settings refuse you" must read
 * identically to the caller: telling them apart turns a refusal into an oracle
 * that reports whether a specific person has blocked you, which is exactly what
 * somebody working around a block would probe for.
 */
export class DmRefusedError extends Error {
  constructor(readonly reason: DmRefusalReason) {
    super("Cannot open a conversation with this user");
    this.name = "DmRefusedError";
  }
}

interface ReachabilityRow {
  id: string;
  dm_privacy: DmPrivacy;
  no_block: boolean;
  shares_server: boolean;
  is_friend: boolean;
}

/**
 * Whether each of these people is open to a conversation from `actorId`.
 *
 * One query for the whole recipient list: a group is up to nine people and a
 * check each would be nine round trips on a request that has not done anything
 * yet.
 *
 * `dm_privacy` is read from the row rather than from any cached session user —
 * this is the setting that decides whether a stranger may contact somebody, so
 * it is the last place a stale read is acceptable.
 */
async function assertReachable(
  actorId: string,
  userIds: string[],
): Promise<void> {
  if (userIds.includes(actorId)) {
    // `dm_pairs` would refuse a self-pair through its `low < high` CHECK, but
    // as a 500 well after the channel row was written.
    throw new DmRefusedError("self");
  }

  const result = await getPool().query<ReachabilityRow>(
    `SELECT u.id, u.dm_privacy,
            ${noBlockBetweenSql("u.id", "$1")} AS no_block,
            EXISTS (
              SELECT 1 FROM server_members mine
              JOIN server_members theirs
                ON theirs.server_id = mine.server_id AND theirs.user_id = u.id
              WHERE mine.user_id = $1
            ) AS shares_server,
            ${areFriendsSql("u.id", "$1")} AS is_friend
     FROM users u
     WHERE u.id = ANY($2::uuid[])`,
    [actorId, userIds],
  );

  if (result.rows.length !== userIds.length) {
    throw new DmRefusedError("unknown-user");
  }

  for (const row of result.rows) {
    if (!row.no_block) {
      throw new DmRefusedError("blocked");
    }
    // 'server_members' is "we already share a server", which is the only
    // relationship this product models — and, since the friend system landed,
    // an accepted friendship is the other one: friends can DM past the
    // server-members default, because that is half of what "friend" means.
    // `nobody` stays absolute: an explicit "no DMs at all" is not voided by a
    // handshake made under different rules.
    if (
      row.dm_privacy === "nobody" ||
      (row.dm_privacy === "server_members" &&
        !row.shares_server &&
        !row.is_friend)
    ) {
      throw new DmRefusedError("privacy");
    }
  }
}

/** The sorted pair `dm_pairs` is keyed by. */
function sortedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Put the participants of a 1:1 conversation back on its member list.
 *
 * Closing a conversation removes only your own `channel_members` row, so the
 * channel and its history survive untouched but you stop being in it — which
 * would also mean the next message from the other side went nowhere and you
 * never learned it existed. `dm_pairs` still records who the two people are, so
 * a send re-materialises the membership and the conversation reappears with its
 * history, the way closing a DM works everywhere else.
 *
 * Group conversations have no `dm_pairs` row and so cannot be restored: leaving
 * a group is leaving it. That is the same asymmetry that makes a group always
 * create new rather than reuse.
 */
export async function restoreDmParticipants(channelId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO channel_members (channel_id, user_id)
     SELECT p.channel_id, participant
     FROM dm_pairs p
     CROSS JOIN LATERAL (VALUES (p.low_user_id), (p.high_user_id))
       AS pair(participant)
     WHERE p.channel_id = $1
     ON CONFLICT DO NOTHING`,
    [channelId],
  );
}

/**
 * Whether a block stands between the author and the only other person here.
 *
 * The rule is about *two people alone*, not about `kind`. Blocking one member
 * of a real group does not silence the room — there is no way to remove
 * somebody from a group, so a single block would otherwise let any participant
 * mute a conversation for everybody else; there the block is enforced the
 * softer way, with no mention row, no activity ping and a collapsed message.
 * But a `kind = 'group'` channel whose third participant has left is two people
 * alone, and gating on `kind = 'dm'` left it permanently exempt: open a group
 * while still permitted, wait for the third to close it, and messages,
 * reactions and voice all flow through a block forever.
 *
 * The participant set is the union of `channel_members` and `dm_pairs`, and the
 * `dm_pairs` half is the load-bearing one. Closing a 1:1 deletes exactly the
 * caller's `channel_members` row, so "block, then close the conversation" — two
 * items in the same context menu, the most natural order a person performs them
 * in — would leave no counterpart row to test, this guard would answer false,
 * and the blocked party's next message would be ungated *and* would restore the
 * blocker's membership, putting the conversation back in their list. `dm_pairs`
 * is the durable record of who the two people are and survives a hide, which is
 * why it is read here and why a refactor must not "simplify" this back to
 * `channel_members` alone.
 *
 * `c.kind <> 'server'` still gates the membership half: a two-person private
 * server channel is not a conversation, and blocking must not silence one.
 */
export async function isDmSendBlocked(
  channelId: string,
  authorId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `WITH participants AS (
       SELECT cm.user_id AS participant
       FROM channels c
       JOIN channel_members cm ON cm.channel_id = c.id
       WHERE c.id = $1 AND c.kind <> 'server'
       UNION
       SELECT pair.participant
       FROM dm_pairs p
       CROSS JOIN LATERAL (VALUES (p.low_user_id), (p.high_user_id))
         AS pair(participant)
       WHERE p.channel_id = $1
     )
     SELECT 1
     WHERE (SELECT COUNT(*) FROM participants) <= 2
       AND EXISTS (
         SELECT 1 FROM participants
         WHERE participant <> $2
           AND NOT ${noBlockBetweenSql("participant", "$2")}
       )`,
    [channelId, authorId],
  );
  return result.rows.length > 0;
}

export interface OpenedConversation {
  channelId: string;
  /** False when an existing 1:1 was reused, which is what makes POST idempotent. */
  created: boolean;
}

/**
 * Open a conversation, or hand back the one that already exists.
 *
 * The 1:1 case is idempotent through `dm_pairs` and its sorted key, so two
 * people tapping "message" on each other in the same instant end up in one
 * conversation rather than two half-threads. The losing insert is detected by
 * `ON CONFLICT DO NOTHING` returning no row — the transaction is rolled back
 * (discarding the channel it had just written) and the winner's channel is read
 * back instead. No lock is taken; the primary key is the lock.
 *
 * A group is always created new. There is no canonical identity for a set of
 * people — the same three may legitimately want two separate rooms — so there
 * is deliberately no `dm_pairs` row for one, and two taps do make two groups.
 * That matches Discord and is the intended behaviour, not an oversight.
 */
export async function openConversation(
  actorId: string,
  userIds: string[],
): Promise<OpenedConversation> {
  if (userIds.length === 0 || userIds.length > DM_MAX_RECIPIENTS) {
    throw new DmRefusedError("too-many");
  }
  await assertReachable(actorId, userIds);

  const isPair = userIds.length === 1;
  const participants = [actorId, ...userIds];

  if (isPair) {
    const [low, high] = sortedPair(actorId, userIds[0]!);
    const existing = await getPool().query<{ channel_id: string }>(
      `SELECT channel_id FROM dm_pairs
       WHERE low_user_id = $1 AND high_user_id = $2`,
      [low, high],
    );
    const found = existing.rows[0];
    if (found) {
      // Either side may have closed it. Reopening is what makes the history
      // come back rather than starting a second empty thread beside it.
      await restoreDmParticipants(found.channel_id);
      return { channelId: found.channel_id, created: false };
    }
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const kind: ConversationKind = isPair ? "dm" : "group";
    const channel = await client.query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position, is_private, kind)
       VALUES (NULL, $1, 'text', 0, FALSE, $2)
       RETURNING id`,
      [CONVERSATION_NAME, kind],
    );
    const channelId = channel.rows[0]!.id;

    if (isPair) {
      const [low, high] = sortedPair(actorId, userIds[0]!);
      const claimed = await client.query(
        `INSERT INTO dm_pairs (low_user_id, high_user_id, channel_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (low_user_id, high_user_id) DO NOTHING
         RETURNING channel_id`,
        [low, high, channelId],
      );
      if (claimed.rows.length === 0) {
        // Somebody else got there between the SELECT above and this INSERT.
        // Throwing away our own channel is the whole point: the alternative is
        // two conversations for one pair, each holding half the thread.
        await client.query("ROLLBACK");
        const winner = await getPool().query<{ channel_id: string }>(
          `SELECT channel_id FROM dm_pairs
           WHERE low_user_id = $1 AND high_user_id = $2`,
          [low, high],
        );
        const channelIdOfWinner = winner.rows[0]?.channel_id;
        if (!channelIdOfWinner) {
          throw new Error("dm_pairs row vanished during a concurrent open");
        }
        await restoreDmParticipants(channelIdOfWinner);
        return { channelId: channelIdOfWinner, created: false };
      }
    }

    await client.query(
      `INSERT INTO channel_members (channel_id, user_id)
       SELECT $1, unnest($2::uuid[])
       ON CONFLICT DO NOTHING`,
      [channelId, participants],
    );

    await client.query("COMMIT");
    return { channelId, created: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Close a conversation for one person.
 *
 * Hide, not delete: the channel, its messages and the other participant are
 * untouched — only the caller's own membership row goes, which is what takes it
 * out of their list. `c.kind <> 'server'` is load-bearing, or this becomes a
 * way to remove yourself from a private server channel through the DM route.
 *
 * Returns false when there was nothing to close, so the route can answer 404
 * rather than pretending it hid a channel the caller was never in.
 */
export async function hideConversation(
  channelId: string,
  userId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `DELETE FROM channel_members cm
     USING channels c
     WHERE c.id = cm.channel_id
       AND cm.channel_id = $1
       AND cm.user_id = $2
       AND c.kind <> 'server'`,
    [channelId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

interface DmRow {
  channel_id: string;
  kind: ConversationKind;
  last_message_at: Date | null;
  count: string;
  mentions: string;
}

/**
 * The viewer's conversation list, with unread and a last-activity timestamp.
 *
 * It cannot reuse `listUnread`: that query reaches its channels through
 * `server_members`, and a conversation has no rows there — the join alone would
 * return nothing for every DM in the instance. This one starts from
 * `channel_members` instead, which is both the participant list and, for a
 * conversation, the entire access rule, so the list can never show somebody a
 * conversation they are not in.
 *
 * `last_message_at` is a separate scalar subquery rather than a MAX over the
 * joined messages, because that join is filtered down to *unread* rows: reusing
 * it would make a fully-read conversation report no activity at all and sort to
 * the bottom of the list.
 */
export async function listConversations(
  userId: string,
  onlyChannelId?: string,
): Promise<DmSummary[]> {
  const rows = await getPool().query<DmRow>(
    `SELECT c.id AS channel_id,
            c.kind,
            (SELECT MAX(created_at) FROM messages any_m
              WHERE any_m.channel_id = c.id) AS last_message_at,
            COUNT(m.id)::text AS count,
            COUNT(mm.user_id)::text AS mentions
     FROM channel_members me
     JOIN channels c ON c.id = me.channel_id AND c.kind <> 'server'
     LEFT JOIN channel_reads cr
       ON cr.channel_id = c.id AND cr.user_id = $1
     LEFT JOIN messages m
       ON m.channel_id = c.id
      AND m.author_id <> $1
      AND m.created_at > COALESCE(cr.last_read_at, TIMESTAMPTZ '-infinity')
      AND ${notBlockedSql("$1", "m.author_id")}
     LEFT JOIN message_mentions mm
       ON mm.message_id = m.id AND mm.user_id = $1
     WHERE me.user_id = $1
       AND ($2::uuid IS NULL OR c.id = $2)
     GROUP BY c.id, c.kind
     ORDER BY last_message_at DESC NULLS LAST, c.id`,
    [userId, onlyChannelId ?? null],
  );

  const channelIds = rows.rows.map((row) => row.channel_id);
  const participants = await listParticipants(channelIds, userId);

  return rows.rows.map((row) => ({
    channelId: row.channel_id,
    kind: row.kind,
    participants: participants.get(row.channel_id) ?? [],
    lastMessageAt: row.last_message_at?.toISOString() ?? null,
    unread: { count: Number(row.count), mentions: Number(row.mentions) },
  }));
}

/**
 * Participants of each conversation, the viewer excluded.
 *
 * Excluding the viewer is a contract of `dmSummarySchema`, not a saving: the
 * client builds the title and the avatars from this list, so leaving yourself
 * in would put your own face on every 1:1 and make a two-person row look like a
 * three-person one.
 *
 * `publicUserSchema` and nothing wider. These rows describe people the viewer
 * may share no server with, so they must not carry what `toPublicUser` carries.
 */
async function listParticipants(
  channelIds: string[],
  viewerId: string,
): Promise<Map<string, PublicUser[]>> {
  const byChannel = new Map<string, PublicUser[]>();
  if (channelIds.length === 0) {
    return byChannel;
  }

  const result = await getPool().query<{
    channel_id: string;
    id: string;
    display_name: string;
    username: string | null;
    discriminator: string | null;
    avatar_url: string | null;
  }>(
    `SELECT cm.channel_id, u.id, u.display_name, u.username, u.discriminator,
            u.avatar_url
     FROM channel_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.channel_id = ANY($1::uuid[]) AND cm.user_id <> $2
     ORDER BY u.display_name ASC, u.id ASC`,
    [channelIds, viewerId],
  );

  for (const row of result.rows) {
    const list = byChannel.get(row.channel_id) ?? [];
    list.push(toPublicUserSummary(row));
    byChannel.set(row.channel_id, list);
  }
  return byChannel;
}

// --- conversation calls ----------------------------------------------------

/**
 * May `callerId` ring this conversation — and if so, whom?
 *
 * Returns the participant user ids (the caller included) of a conversation the
 * caller is allowed to call, or null when the call must not happen at all:
 * the channel is a server channel (server channels do not ring), the caller is
 * not a participant, or a block stands between the two people of a 1:1.
 *
 * Ringing is the loudest thing one account can do to another, so the block
 * check is `isDmSendBlocked` — the exact predicate the message path uses,
 * including its two-people-alone reading of a shrunken group. The voice join
 * already enforces the same rule; re-checking here means a `call-ring` frame
 * forged without a join still rings nobody.
 *
 * A 1:1 the callee had closed is restored first, exactly as a message would
 * restore it: a call that cannot reach somebody because they tidied their
 * sidebar is a phone that rings nowhere. Groups have no `dm_pairs` row, so for
 * them this is a no-op and someone who left a group is *not* rung — leaving is
 * leaving.
 */
export async function resolveRingableConversation(
  channelId: string,
  callerId: string,
): Promise<string[] | null> {
  if (await isDmSendBlocked(channelId, callerId)) {
    return null;
  }
  await restoreDmParticipants(channelId);
  const result = await getPool().query<{ user_id: string }>(
    `SELECT cm.user_id
     FROM channels c
     JOIN channel_members cm ON cm.channel_id = c.id
     WHERE c.id = $1 AND c.kind <> 'server'`,
    [channelId],
  );
  const participants = result.rows.map((row) => row.user_id);
  if (!participants.includes(callerId)) {
    return null;
  }
  return participants;
}

// --- end conversation calls -------------------------------------------------

/** One conversation as the viewer sees it, or null when they are not in it. */
export async function getConversation(
  channelId: string,
  viewerId: string,
): Promise<DmSummary | null> {
  const [only] = await listConversations(viewerId, channelId);
  return only ?? null;
}

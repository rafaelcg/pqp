import type { ConversationKind } from "@pqp/shared";
import { getPool } from "../db.js";

/**
 * Conversas: who sees "digitando…" in their conversation LIST.
 *
 * Its own module rather than part of `dms.ts` so the many socket suites that
 * fake `dms.js` wholesale do not have to learn about it.
 */

// --- typing in the list ----------------------------------------------------

/**
 * How long a conversation's typing audience is reused. Typing is the hottest
 * ephemeral frame there is (one per typist per two seconds at the limiter's
 * sustained rate), so a lookup per frame would put a query on every keystroke
 * burst; a short TTL makes it one per typist per conversation per window. What
 * the window can get wrong is small and self-healing: somebody who just closed
 * a group or blocked the typist may see "digitando…" in their list for up to
 * this long. Closing a conversation also drops the entry at once
 * (`forgetConversationTypingAudience`, called from the eviction path).
 */
const TYPING_AUDIENCE_TTL_MS = 15_000;
/** A server channel never becomes a conversation, so the "no" is kept, bounded. */
const SERVER_CHANNEL_MEMO_MAX = 5_000;

const typingAudience = new Map<
  string,
  Map<string, { recipients: readonly string[]; expiresAt: number }>
>();
const serverChannelMemo = new Set<string>();
/**
 * Bumped by every forget, per channel, so a lookup that was already in flight
 * when the membership changed cannot write its stale answer back afterwards.
 */
const generations = new Map<string, number>();
let globalGeneration = 0;

function generationOf(channelId: string): string {
  return `${globalGeneration}:${generations.get(channelId) ?? 0}`;
}

/**
 * The cached answer, without asking the database: the recipients, null for a
 * server channel, or undefined when nothing fresh is known. Lets the socket
 * path publish at once on a hit and look up off the hot path on a miss.
 */
export function peekConversationTypingAudience(
  channelId: string,
  typistId: string,
  now: number = Date.now(),
): readonly string[] | null | undefined {
  if (serverChannelMemo.has(channelId)) {
    return null;
  }
  const cached = typingAudience.get(channelId)?.get(typistId);
  return cached && cached.expiresAt > now ? cached.recipients : undefined;
}

/**
 * Who should see "digitando…" in their conversation LIST when `typistId`
 * types in `channelId`: every other participant, minus anybody who blocked
 * the typist. Null for a server channel, which has no list to light.
 *
 * A block between the two people of a 1:1 is already refused before this is
 * asked (`isDmSendBlocked`), which covers both directions. In a group the
 * typist stays visible to the members who did not block them, the same rule
 * `channel-activity` follows for badges.
 */
export async function conversationTypingAudience(
  channelId: string,
  typistId: string,
  now: number = Date.now(),
): Promise<readonly string[] | null> {
  const known = peekConversationTypingAudience(channelId, typistId, now);
  if (known !== undefined) {
    return known;
  }
  const asked = generationOf(channelId);
  const result = await getPool().query<{ kind: ConversationKind | "server"; recipients: string[] }>(
    `SELECT c.kind,
            COALESCE(
              array_agg(cm.user_id) FILTER (
                WHERE cm.user_id IS NOT NULL
                  AND cm.user_id <> $2
                  AND NOT EXISTS (
                    SELECT 1 FROM user_blocks b
                     WHERE b.user_id = cm.user_id AND b.blocked_user_id = $2
                  )
              ),
              '{}'
            ) AS recipients
       FROM channels c
       LEFT JOIN channel_members cm ON cm.channel_id = c.id AND c.kind <> 'server'
      WHERE c.id = $1
      GROUP BY c.kind`,
    [channelId, typistId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  if (row.kind === "server") {
    // A channel's kind never changes, so no generation check is needed here.
    // Bounded by evicting the OLDEST entry (a Set keeps insertion order), not
    // by clearing: past the bound, a clear would put a query back on every
    // typing frame of every busy channel at once.
    if (serverChannelMemo.size >= SERVER_CHANNEL_MEMO_MAX) {
      const oldest = serverChannelMemo.values().next().value;
      if (oldest !== undefined) {
        serverChannelMemo.delete(oldest);
      }
    }
    serverChannelMemo.add(channelId);
    return null;
  }
  // The membership changed (or a block landed) while this was in flight: the
  // answer is still the best this frame has, but it must not be kept.
  if (generationOf(channelId) !== asked) {
    return row.recipients;
  }
  // Entries are only replaced when asked again, so a long uptime would keep
  // every conversation anybody ever typed in. Past the bound the conversation
  // touched longest ago goes (re-inserting below moves this one to the end).
  const byTypist = typingAudience.get(channelId) ?? new Map();
  typingAudience.delete(channelId);
  if (typingAudience.size >= SERVER_CHANNEL_MEMO_MAX) {
    const oldest = typingAudience.keys().next().value;
    if (oldest !== undefined) {
      typingAudience.delete(oldest);
    }
  }
  byTypist.set(typistId, {
    recipients: row.recipients,
    expiresAt: now + TYPING_AUDIENCE_TTL_MS,
  });
  typingAudience.set(channelId, byTypist);
  return row.recipients;
}

/** A membership changed (closed, left, evicted): ask again next time. */
export function forgetConversationTypingAudience(channelId: string): void {
  typingAudience.delete(channelId);
  generations.set(channelId, (generations.get(channelId) ?? 0) + 1);
  if (generations.size > SERVER_CHANNEL_MEMO_MAX) {
    generations.clear();
    globalGeneration += 1;
  }
}

/**
 * Somebody blocked somebody: the cached audiences were filtered against the
 * old block list, so none of them can be trusted. Blocks are rare and the
 * cache refills one query per active typist, so dropping all of it is cheaper
 * than tracking which entries named whom.
 */
export function forgetAllConversationTypingAudiences(): void {
  typingAudience.clear();
  generations.clear();
  globalGeneration += 1;
}

/** Test seam. */
export function resetConversationTypingAudience(): void {
  forgetAllConversationTypingAudiences();
  serverChannelMemo.clear();
}

// --- end typing in the list --------------------------------------------------

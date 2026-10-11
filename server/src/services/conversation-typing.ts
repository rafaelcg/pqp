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
  if (serverChannelMemo.has(channelId)) {
    return null;
  }
  const cached = typingAudience.get(channelId)?.get(typistId);
  if (cached && cached.expiresAt > now) {
    return cached.recipients;
  }
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
    if (serverChannelMemo.size >= SERVER_CHANNEL_MEMO_MAX) {
      serverChannelMemo.clear();
    }
    serverChannelMemo.add(channelId);
    return null;
  }
  // Entries are only replaced when asked again, so a long uptime would keep
  // every conversation anybody ever typed in. A bounded reset costs one query
  // per active typist afterwards, which is the same as a TTL expiring.
  if (typingAudience.size >= SERVER_CHANNEL_MEMO_MAX && !typingAudience.has(channelId)) {
    typingAudience.clear();
  }
  const byTypist = typingAudience.get(channelId) ?? new Map();
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
}

/** Test seam. */
export function resetConversationTypingAudience(): void {
  typingAudience.clear();
  serverChannelMemo.clear();
}

// --- end typing in the list --------------------------------------------------

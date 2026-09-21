import {
  deriveThreadName,
  isThreadArchived,
  THREAD_AUTO_ARCHIVE_DAYS,
  THREAD_PARTICIPANT_FACES,
  type ThreadSummary,
} from "@pqp/shared";
import { getPool } from "../db.js";

/**
 * Threads: the service half of "a thread is a channel".
 *
 * Everything here reads or writes ordinary `channels` rows with
 * `type = 'thread'`. There is deliberately no thread-specific message code —
 * messages in a thread go through services/messages.ts untouched, which is the
 * whole point of the model (see the `-- threads` block in schema.sql).
 *
 * WHY replyCount / lastActivity ARE COMPUTED, NOT STORED. A denormalised
 * counter would need a write on every message, every delete, and every
 * retention sweep — three places to drift, on the hottest write path in the
 * app. Computed, the count is a `count(*)` over one thread's messages (small
 * by nature) and the last activity is the first row of
 * idx_messages_channel_created — and message deletion and retention keep the
 * chip honest for free. "Archived" falls out of the same read: a thread whose
 * newest message is older than THREAD_AUTO_ARCHIVE_DAYS reads archived, and
 * saying something in it un-archives it by making that false. No sweeper.
 */

interface ThreadRow {
  id: string;
  parent_id: string | null;
  thread_root_message_id: string | null;
  name: string;
  created_at: Date;
  reply_count: number;
  last_message_at: Date | null;
}

/** The two subselects every thread read shares. `c` must be `channels`. */
const THREAD_COLUMNS = `c.id, c.parent_id, c.thread_root_message_id, c.name, c.created_at,
       (SELECT count(*) FROM messages m WHERE m.channel_id = c.id)::int AS reply_count,
       (SELECT max(m.created_at) FROM messages m WHERE m.channel_id = c.id) AS last_message_at`;

/** The predicate behind `archived`, in SQL, so a read can exclude them. */
const ACTIVE_THREAD_SQL = `coalesce(
    (SELECT max(m.created_at) FROM messages m WHERE m.channel_id = c.id),
    c.created_at
  ) > now() - interval '${THREAD_AUTO_ARCHIVE_DAYS} days'`;

/**
 * The faces on the chip: up to THREAD_PARTICIPANT_FACES people per thread,
 * most recent speaker first.
 *
 * ITS OWN QUERY, over thread ids the caller has ALREADY narrowed. As a column
 * on THREAD_COLUMNS it ran for every candidate row before any cap applied,
 * and its LIMIT sits after a GROUP BY, so the limit never shortened the scan.
 * Asked separately it runs once, over the handful of threads actually being
 * returned, and a caller that does not draw faces does not pay for them.
 */
async function participantsFor(
  threadIds: string[],
): Promise<Map<string, ThreadSummary["participants"]>> {
  const byThread = new Map<string, ThreadSummary["participants"]>();
  if (threadIds.length === 0) {
    return byThread;
  }
  const result = await getPool().query<{
    channel_id: string;
    id: string;
    display_name: string;
    avatar_url: string | null;
  }>(
    `SELECT spoke.channel_id, u.id, u.display_name, u.avatar_url
       FROM (
         SELECT m.channel_id,
                m.author_id,
                max(m.created_at) AS said_at,
                row_number() OVER (
                  PARTITION BY m.channel_id ORDER BY max(m.created_at) DESC
                ) AS rank
           FROM messages m
          WHERE m.channel_id = ANY($1::uuid[])
          GROUP BY m.channel_id, m.author_id
       ) spoke
       JOIN users u ON u.id = spoke.author_id
      WHERE spoke.rank <= $2
      ORDER BY spoke.channel_id, spoke.rank`,
    [threadIds, THREAD_PARTICIPANT_FACES],
  );
  for (const row of result.rows) {
    const list = byThread.get(row.channel_id) ?? [];
    list.push({
      id: row.id,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
    });
    byThread.set(row.channel_id, list);
  }
  return byThread;
}

/** Fold `participantsFor` into summaries that were built without faces. */
async function withParticipants(
  summaries: ThreadSummary[],
): Promise<ThreadSummary[]> {
  const faces = await participantsFor(
    summaries.filter((one) => one.replyCount > 0).map((one) => one.channelId),
  );
  for (const summary of summaries) {
    summary.participants = faces.get(summary.channelId) ?? [];
  }
  return summaries;
}

function toSummary(row: ThreadRow): ThreadSummary {
  const lastActivity = row.last_message_at ?? row.created_at;
  return {
    channelId: row.id,
    // A thread whose parent was deleted is mid-cleanup (deleteChannel removes
    // child threads in the same transaction); the summary still has to encode,
    // and the root message id is the only honest stand-in nothing routes on.
    parentChannelId: row.parent_id ?? row.id,
    rootMessageId: row.thread_root_message_id,
    name: row.name,
    replyCount: row.reply_count,
    lastActivityAt: lastActivity.toISOString(),
    archived: isThreadArchived(lastActivity),
    // Filled by withParticipants, which asks for them once per capped set.
    participants: [],
  };
}

/** A message that cannot host a thread: wrong kind of channel, or already in one. */
export class ThreadTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreadTargetError";
  }
}

export interface CreateThreadResult {
  thread: ThreadSummary;
  /** False when the message already had one and that one was returned. */
  created: boolean;
  parentChannelId: string;
}

/**
 * Start a thread from a message, or hand back the one it already has.
 *
 * Idempotent under concurrency by the partial unique index on
 * `thread_root_message_id`: two people tapping "start thread" at once both get
 * the same row, one as creator and one as reader. Returns null for a message
 * that does not exist; throws `ThreadTargetError` for one that exists but
 * cannot host a thread — a conversation (threads are a server feature; a DM is
 * already the scoped side-conversation threads exist to create), a voice
 * channel's message (cannot happen today), or a message already inside a
 * thread (no nesting — the visibility predicate's parent lookup is one level
 * deep on purpose).
 *
 * ACCESS IS NOT CHECKED HERE. The route checks the caller can see the parent
 * channel via `requireChannelAccess`, which is the same predicate the thread
 * itself inherits — anyone who can read the message can start its thread.
 */
export async function createThreadForMessage(
  messageId: string,
  requestedName: string | null,
): Promise<CreateThreadResult | null> {
  const origin = await getPool().query<{
    channel_id: string;
    server_id: string | null;
    body: string;
    kind: string;
    type: string;
  }>(
    `SELECT m.channel_id, m.body, c.server_id, c.kind, c.type
     FROM messages m
     JOIN channels c ON c.id = m.channel_id
     WHERE m.id = $1`,
    [messageId],
  );
  const row = origin.rows[0];
  if (!row) {
    return null;
  }
  if (row.kind !== "server" || !row.server_id) {
    throw new ThreadTargetError(
      "Threads only exist in servers — a conversation already is one",
    );
  }
  if (row.type === "thread") {
    throw new ThreadTargetError("A thread cannot contain another thread");
  }
  if (row.type !== "text") {
    throw new ThreadTargetError("Threads can only be started in text channels");
  }

  const name = requestedName?.trim() || deriveThreadName(row.body);

  // `ON CONFLICT ... DO NOTHING` rather than read-then-insert: the unique
  // index is what serialises two simultaneous "start thread" taps, and the
  // loser falls through to the SELECT below and reads the winner's row.
  const inserted = await getPool().query<ThreadRow>(
    `WITH created AS (
       INSERT INTO channels
         (server_id, name, type, position, is_private, kind, parent_id, thread_root_message_id)
       VALUES ($1, $2, 'thread', 0, FALSE, 'server', $3, $4)
       ON CONFLICT (thread_root_message_id) WHERE thread_root_message_id IS NOT NULL
       DO NOTHING
       RETURNING id, parent_id, thread_root_message_id, name, created_at
     )
     SELECT c.id, c.parent_id, c.thread_root_message_id, c.name, c.created_at,
            0 AS reply_count, NULL::timestamptz AS last_message_at
     FROM created c`,
    [row.server_id, name, row.channel_id, messageId],
  );

  const createdRow = inserted.rows[0];
  if (createdRow) {
    return {
      thread: toSummary(createdRow),
      created: true,
      parentChannelId: row.channel_id,
    };
  }

  const existing = await getPool().query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS}
     FROM channels c
     WHERE c.thread_root_message_id = $1`,
    [messageId],
  );
  const existingRow = existing.rows[0];
  if (!existingRow) {
    // The conflicting thread was deleted between the insert and this read; a
    // retry from the client will simply create it.
    return null;
  }
  return {
    thread: toSummary(existingRow),
    created: false,
    parentChannelId: row.channel_id,
  };
}

/**
 * The thread a channel id names, or null when the id is not a thread at all.
 * The message path calls this once per send to decide whether a `thread-update`
 * chip refresh is owed to the parent channel — one indexed primary-key read.
 */
export async function getThreadInfo(
  channelId: string,
): Promise<ThreadSummary | null> {
  const result = await getPool().query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS}
     FROM channels c
     WHERE c.id = $1 AND c.type = 'thread'`,
    [channelId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  const [summary] = await withParticipants([toSummary(row)]);
  return summary ?? null;
}

/**
 * Thread summaries for a page of messages, keyed by origin message id — the
 * batched read `hydrate` in services/messages.ts folds into each history page,
 * exactly the way reactions and attachments already are.
 */
export async function listThreadsForMessages(
  messageIds: string[],
): Promise<Map<string, ThreadSummary>> {
  const byMessage = new Map<string, ThreadSummary>();
  if (messageIds.length === 0) {
    return byMessage;
  }
  const result = await getPool().query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS}
     FROM channels c
     WHERE c.thread_root_message_id = ANY($1::uuid[])`,
    [messageIds],
  );
  const summaries: ThreadSummary[] = [];
  for (const row of result.rows) {
    if (row.thread_root_message_id) {
      const summary = toSummary(row);
      byMessage.set(row.thread_root_message_id, summary);
      summaries.push(summary);
    }
  }
  // One query for the page's threads, not one per thread root.
  await withParticipants(summaries);
  return byMessage;
}

/**
 * The active threads under a set of parent channels that THIS READER is in,
 * newest activity first, capped per parent — what the channel list nests
 * under a channel row.
 *
 * Archived threads are left out on purpose: the sidebar is for what is going
 * on now, and a thread quiet for THREAD_AUTO_ARCHIVE_DAYS is reachable the
 * way it always was, from its origin message. The cap is per parent rather
 * than overall so a busy channel cannot crowd out every other one.
 */
export async function listActiveThreadsByParent(
  parentChannelIds: string[],
  perParent: number,
  viewerId: string,
): Promise<Map<string, ThreadSummary[]>> {
  const byParent = new Map<string, ThreadSummary[]>();
  if (parentChannelIds.length === 0 || perParent <= 0) {
    return byParent;
  }
  // Both the archived filter and the per-parent cap live in SQL. Applied in
  // TypeScript afterwards they bounded what was RETURNED and nothing else:
  // Postgres had already produced, summarised and serialised every thread the
  // reader was in, on a server that may have thousands.
  const result = await getPool().query<ThreadRow>(
    `WITH mine AS (
       SELECT c.id
         FROM channels c
        WHERE c.parent_id = ANY($1::uuid[])
          AND c.type = 'thread'
          AND ${ACTIVE_THREAD_SQL}
          -- ONLY THREADS THIS READER IS IN. A thread has no members of its
          -- own (its audience is its parent's), so membership is derived from
          -- having taken part: started it, said something in it, or opened it
          -- — the same "created, replied, or joined" Discord gates its own
          -- sidebar on. Listing every active thread to everybody turns a busy
          -- channel's rail into a feed of other people's conversations.
          AND (
            EXISTS (SELECT 1 FROM messages said
                     WHERE said.channel_id = c.id AND said.author_id = $3)
            OR EXISTS (SELECT 1 FROM messages root
                        WHERE root.id = c.thread_root_message_id
                          AND root.author_id = $3)
            -- Opening the panel writes a read cursor, so this is "joined". A
            -- thread never opened has no row here, which is also why unread
            -- cannot be the test: with no cursor everything reads unread.
            OR EXISTS (SELECT 1 FROM channel_reads cr
                        WHERE cr.channel_id = c.id AND cr.user_id = $3)
          )
     ),
     ranked AS (
       SELECT c.id,
              row_number() OVER (
                PARTITION BY c.parent_id
                ORDER BY coalesce(
                  (SELECT max(m.created_at) FROM messages m
                    WHERE m.channel_id = c.id), c.created_at) DESC
              ) AS rank
         FROM channels c
         JOIN mine ON mine.id = c.id
     )
     SELECT ${THREAD_COLUMNS}
       FROM channels c
       JOIN ranked ON ranked.id = c.id AND ranked.rank <= $2
      ORDER BY c.parent_id, ranked.rank`,
    [parentChannelIds, perParent, viewerId],
  );
  const summaries = result.rows.map(toSummary);
  await withParticipants(summaries);
  for (const summary of summaries) {
    const list = byParent.get(summary.parentChannelId) ?? [];
    list.push(summary);
    byParent.set(summary.parentChannelId, list);
  }
  return byParent;
}

/**
 * Ids of every thread under one parent channel. Used by the routes that
 * narrow the parent's audience (going private, removing a member) to evict
 * the threads' live viewers with the same scope — the thread's audience IS
 * the parent's, so the same allow-list applies verbatim.
 */
export async function listThreadChannelIds(
  parentChannelId: string,
): Promise<string[]> {
  const result = await getPool().query<{ id: string }>(
    `SELECT id FROM channels WHERE parent_id = $1 AND type = 'thread'`,
    [parentChannelId],
  );
  return result.rows.map((r) => r.id);
}

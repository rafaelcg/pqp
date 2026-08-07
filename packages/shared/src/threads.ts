import { z } from "zod";

/**
 * Threads — a reply-chain that becomes its own scoped conversation off a
 * message, Discord-style.
 *
 * THE MODEL, STATED ONCE: A THREAD IS A CHANNEL. `channels.type = 'thread'`,
 * `kind = 'server'`, `parent_id` pointing at the text channel it was started
 * in, and `thread_root_message_id` pointing at the message it grew out of.
 * Nothing else in this file — and very little anywhere else — is new
 * machinery: messages, reactions, edits, attachments, mentions, read cursors,
 * search, retention, timeouts and reporting all apply to a thread because a
 * thread IS a channel and every one of those systems is keyed by channel id.
 * The alternative (a `thread_root_id` self-reference on messages) would have
 * meant teaching each of those systems about threads one at a time, and every
 * lesson skipped is a place a private channel's thread leaks.
 *
 * The one thing a thread does NOT inherit is its own privacy: a thread's
 * visibility FOLLOWS ITS PARENT (see `channelVisibleSql` in
 * server/src/services/users.ts). The thread row itself is never private and
 * never has members of its own.
 *
 * This file only ever describes the wire shapes; nothing here imports the rest
 * of the shared package, so `api.ts` and `chat.ts` can safely import it.
 */

/**
 * A thread with no message for this many days reads as archived. Purely a
 * read-time computation over the thread's last activity — there is no sweeper,
 * no stored flag, and nothing to un-archive: saying something in an archived
 * thread makes it active again by making the condition false.
 */
export const THREAD_AUTO_ARCHIVE_DAYS = 7;

/** Thread names are titles, not slugs — spaces and punctuation are fine. */
export const THREAD_NAME_MAX_LENGTH = 80;

// Same rule as `safeTextSchema` in api.ts, restated because this module must
// not import api.ts (api.ts imports this one for the message shape).
// eslint-disable-next-line no-control-regex
const THREAD_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * What every consumer of "this message has a thread" gets: enough to draw the
 * chip (count, freshness, archived state) and to open the panel (channel id).
 *
 * `rootMessageId` is nullable because deleting the origin message keeps the
 * thread — the conversation that grew out of a message is not the message —
 * and the anchor column is ON DELETE SET NULL for exactly that reason.
 */
export const threadSummarySchema = z.object({
  channelId: z.string().uuid(),
  parentChannelId: z.string().uuid(),
  rootMessageId: z.string().uuid().nullable(),
  name: z.string(),
  /** Messages in the thread. The origin message lives in the parent channel,
   * so a fresh thread reads 0 — every message in the thread is a reply. */
  replyCount: z.number().int().nonnegative(),
  /** ISO instant of the last message, or of the thread's creation. */
  lastActivityAt: z.string(),
  /** Computed from `lastActivityAt` at read time — see THREAD_AUTO_ARCHIVE_DAYS. */
  archived: z.boolean(),
});

export type ThreadSummary = z.infer<typeof threadSummarySchema>;

/** POST /api/messages/:messageId/threads — the name is optional; the server
 * derives one from the origin message when it is absent. */
export const createThreadSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(THREAD_NAME_MAX_LENGTH)
    .refine((value) => !THREAD_CONTROL_CHARS.test(value), "Invalid characters")
    .optional(),
});

export type CreateThreadRequest = z.infer<typeof createThreadSchema>;

/**
 * Derive a thread's default name from its origin message, the way Discord
 * seeds the rename box: one flattened line of the body, cut to fit. Shared so
 * the server's stored name and any optimistic client rendering agree.
 */
export function deriveThreadName(originBody: string): string {
  const flat = originBody.replace(/\s+/g, " ").trim();
  if (flat.length === 0) {
    return "thread";
  }
  if (flat.length <= THREAD_NAME_MAX_LENGTH) {
    return flat;
  }
  let cut = THREAD_NAME_MAX_LENGTH - 1;
  // Same surrogate-pair guard as buildReplyExcerpt: cutting by code unit can
  // split an emoji into U+FFFD.
  const lead = flat.charCodeAt(cut - 1);
  if (lead >= 0xd800 && lead <= 0xdbff) {
    cut -= 1;
  }
  return `${flat.slice(0, cut).trimEnd()}…`;
}

/** Compute the archived flag the same way everywhere. */
export function isThreadArchived(
  lastActivityAt: string | Date,
  now: Date = new Date(),
): boolean {
  const last =
    lastActivityAt instanceof Date ? lastActivityAt : new Date(lastActivityAt);
  return (
    now.getTime() - last.getTime() > THREAD_AUTO_ARCHIVE_DAYS * 24 * 3600 * 1000
  );
}

// ------------------------------------------------------------- WS frames

/**
 * Open a thread's live view *beside* the channel view. Deliberately not
 * `join-channel`: a connection has exactly one primary channel, and joining
 * the thread through that slot would silently stop delivery for the parent
 * channel the panel is open next to. The server holds one extra slot per
 * connection for the thread the panel is showing.
 */
export const threadJoinMessageSchema = z.object({
  type: z.literal("thread-join"),
  channelId: z.string().uuid(),
});

export const threadLeaveMessageSchema = z.object({
  type: z.literal("thread-leave"),
});

/**
 * Fanned out to viewers of the PARENT channel whenever a thread is created or
 * gains a message, so the chip on the origin message updates live without the
 * parent's unread badge being involved at all. Carries no message content —
 * the thread's messages travel only to the thread's own viewers.
 */
export const threadUpdateBroadcastSchema = z.object({
  type: z.literal("thread-update"),
  /** The parent channel — where the origin message (and its chip) lives. */
  channelId: z.string().uuid(),
  /** The origin message the chip hangs off. */
  messageId: z.string().uuid(),
  thread: threadSummarySchema,
});

export type ThreadJoinMessage = z.infer<typeof threadJoinMessageSchema>;
export type ThreadUpdateBroadcast = z.infer<typeof threadUpdateBroadcastSchema>;

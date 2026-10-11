import { getPool } from "../db.js";

/**
 * Forum channels, the guards the rest of the product needs before any forum
 * code runs (forum PR 2). The model is in packages/shared/src/forums.ts: a
 * forum is a `channels` row of type `forum` that never holds a message, and a
 * post is a `thread` under it with a `forum_posts` row. Everything here reads
 * `forum_posts` with raw SQL on purpose, so it works whether or not the forum
 * service itself (`services/forums.ts`) is deployed.
 *
 * Kept apart from `services/forums.ts` so the send path, the generic channel
 * routes and the webhook route can depend on these few reads without pulling
 * in the list and create machinery.
 */

/**
 * Whether a post is closed to replies. `null` when the channel is not a forum
 * post at all (a chat thread, which has no `forum_posts` row), so a caller
 * can tell "open post" from "not a post" without a second query.
 *
 * One primary-key probe, only ever asked for a `thread` channel.
 */
export async function forumPostLockState(
  channelId: string,
): Promise<{ locked: boolean } | null> {
  const result = await getPool().query<{ locked: boolean }>(
    `SELECT locked_at IS NOT NULL AS locked
       FROM forum_posts
      WHERE channel_id = $1`,
    [channelId],
  );
  const row = result.rows[0];
  return row ? { locked: row.locked } : null;
}

/** Whether a channel is a forum post (a shell counts: it is still a post). */
export async function isForumPost(channelId: string): Promise<boolean> {
  return (await forumPostLockState(channelId)) !== null;
}

/**
 * The refusal the generic `PATCH` / `DELETE /api/channels/:channelId` answer
 * for a forum post. A post is renamed, retagged and deleted through
 * `/api/forum-posts/:postId`, which runs AutoMod on the title, writes the
 * forum audit rows and sends `forum-post-removed`; the generic routes would
 * skip all three.
 */
export const FORUM_POST_USE_POST_ROUTES =
  "This is a forum post: use /api/forum-posts/:postId";

/**
 * Discord's answer to an execute into a forum with no `thread_name`, sent
 * verbatim so a tool that already handles Discord forums recognises it. Until
 * forum PR 4 turns an execute into a post, every execute into a forum gets it.
 */
export const WEBHOOK_FORUM_THREAD_NAME_MESSAGE =
  "Webhooks posted to a forum channel must have a thread_name or thread_id";

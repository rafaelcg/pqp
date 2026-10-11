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
 * Thread ids known NOT to be forum posts. Whether a thread is a post never
 * changes: the forum service writes the `forum_posts` row in the transaction
 * that creates the thread, and a chat thread never gains one. So a chat
 * thread is probed once per process and then answered from here, and the send
 * path pays nothing per message in an ordinary thread. A post is still read
 * every time, because its lock state does change. Bounded: past the cap the
 * oldest entries go, which only costs them one more probe.
 */
const NOT_A_POST_MAX = 20_000;
const notAPost = new Set<string>();

function rememberNotAPost(channelId: string): void {
  if (notAPost.size >= NOT_A_POST_MAX) {
    const oldest = notAPost.values().next().value;
    if (oldest !== undefined) {
      notAPost.delete(oldest);
    }
  }
  notAPost.add(channelId);
}

/** Tests only: forget every remembered chat thread. */
export function resetForumGuardCacheForTests(): void {
  notAPost.clear();
}

/**
 * Whether a post is closed to replies. `null` when the channel is not a forum
 * post at all (a chat thread, which has no `forum_posts` row), so a caller
 * can tell "open post" from "not a post" without a second query.
 *
 * One primary-key probe, only ever asked for a `thread` channel, and none at
 * all for a chat thread this process has already seen.
 */
export async function forumPostLockState(
  channelId: string,
): Promise<{ locked: boolean } | null> {
  if (notAPost.has(channelId)) {
    return null;
  }
  const result = await getPool().query<{ locked: boolean }>(
    `SELECT locked_at IS NOT NULL AS locked
       FROM forum_posts
      WHERE channel_id = $1`,
    [channelId],
  );
  const row = result.rows[0];
  if (!row) {
    rememberNotAPost(channelId);
    return null;
  }
  return { locked: row.locked };
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

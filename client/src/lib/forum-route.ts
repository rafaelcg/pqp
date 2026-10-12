import type { ForumPostSummary, ThreadSummary } from "@pqp/shared";

/**
 * Where a link to a channel id that is not in the channel list should go.
 *
 * The channel list never carries threads (chat threads or forum posts), so a
 * permalink, a search hit or a push into one used to stop at "That channel no
 * longer exists or is private" (spec §9.2, the bug that predates forums). The
 * id is asked about in order:
 *
 *   1. as a forum post (`GET /api/forum-posts/:id`): open its forum with the
 *      post on top. The answer is only trusted when its forum is in this
 *      viewer's list, which is the visibility check the server already made
 *      and the client can see.
 *   2. as a chat thread among the server's active threads: open its parent
 *      channel with the thread panel on top.
 *
 * Both are asked at once, so a chat-thread link does not wait a round trip
 * for the post lookup to say no; the post wins when both answer.
 *
 * Anything else (a thread that has gone quiet and left the active list, a
 * post this viewer cannot see, a deleted channel) is `null`, which keeps the
 * honest "no longer exists or is private" line. A 404 or 403 from the post
 * lookup is that kind of answer (and the normal one from an API that
 * predates forums). Anything else, a 5xx or the network, is NOT proof the
 * thing is gone: when no lookup found it, that failure is thrown, so the
 * caller says "could not load" rather than "does not exist".
 */
export type RoutedThread =
  | { kind: "forum-post"; forumId: string; post: ForumPostSummary }
  | { kind: "thread"; thread: ThreadSummary };

export async function resolveRoutedThread(
  id: string,
  {
    listedChannelIds,
    fetchPost,
    fetchThreads,
  }: {
    listedChannelIds: ReadonlySet<string>;
    fetchPost: (postId: string) => Promise<{ post: ForumPostSummary }>;
    fetchThreads: () => Promise<{ threads: Record<string, ThreadSummary[]> }>;
  },
): Promise<RoutedThread | null> {
  const [postAnswer, threadsAnswer] = await Promise.allSettled([
    fetchPost(id),
    fetchThreads(),
  ]);
  if (postAnswer.status === "fulfilled") {
    const { post } = postAnswer.value;
    if (post.id === id && listedChannelIds.has(post.forumId)) {
      return { kind: "forum-post", forumId: post.forumId, post };
    }
  }
  if (threadsAnswer.status === "fulfilled") {
    for (const list of Object.values(threadsAnswer.value.threads)) {
      const thread = list.find((one) => one.channelId === id);
      if (thread && listedChannelIds.has(thread.parentChannelId)) {
        return { kind: "thread", thread };
      }
    }
  }
  if (postAnswer.status === "rejected" && !isNotThere(postAnswer.reason)) {
    throw postAnswer.reason;
  }
  if (threadsAnswer.status === "rejected") {
    throw threadsAnswer.reason;
  }
  return null;
}

/** A refusal that means "not a post, or not one you can see". */
function isNotThere(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 404 || status === 403;
}

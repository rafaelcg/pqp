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
 * Anything else (a thread that has gone quiet and left the active list, a
 * post this viewer cannot see, a deleted channel) is `null`, which keeps the
 * honest "no longer exists or is private" line. Every lookup failing is also
 * `null`, never an exception: a 404 from an API that predates forums is the
 * normal answer for step 1 on an old server.
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
  try {
    const { post } = await fetchPost(id);
    if (post.id === id && listedChannelIds.has(post.forumId)) {
      return { kind: "forum-post", forumId: post.forumId, post };
    }
  } catch {
    // Not a post, or not one this viewer can reach: try the next kind.
  }
  try {
    const { threads } = await fetchThreads();
    for (const list of Object.values(threads)) {
      const thread = list.find((one) => one.channelId === id);
      if (thread && listedChannelIds.has(thread.parentChannelId)) {
        return { kind: "thread", thread };
      }
    }
  } catch {
    // Nothing more to try.
  }
  return null;
}

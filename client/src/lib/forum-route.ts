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
 * A chat thread the sidebar already holds is answered first, with no request,
 * so the usual thread link does not wait on a post lookup; a post link costs
 * one request, and the server's thread list is asked only when both miss.
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
    heldThreads = {},
    fetchPost,
    fetchThreads,
  }: {
    listedChannelIds: ReadonlySet<string>;
    /**
     * The active threads the sidebar already holds for this server. A thread
     * link among them opens with no request at all; that is the common case,
     * since the server's thread list is exactly this list, refreshed.
     */
    heldThreads?: Record<string, readonly ThreadSummary[]>;
    fetchPost: (postId: string) => Promise<{ post: ForumPostSummary }>;
    fetchThreads: () => Promise<{ threads: Record<string, ThreadSummary[]> }>;
  },
): Promise<RoutedThread | null> {
  const held = findThread(heldThreads, id, listedChannelIds);
  if (held) {
    return { kind: "thread", thread: held };
  }
  // Then the post, and only when it is not one the server's thread list is
  // asked for, so a post link costs one request.
  let postFailure: unknown = null;
  try {
    const { post } = await fetchPost(id);
    if (post.id === id && listedChannelIds.has(post.forumId)) {
      return { kind: "forum-post", forumId: post.forumId, post };
    }
  } catch (error) {
    if (!isNotThere(error)) {
      postFailure = error;
    }
  }
  try {
    const { threads } = await fetchThreads();
    const thread = findThread(threads, id, listedChannelIds);
    if (thread) {
      return { kind: "thread", thread };
    }
  } catch (error) {
    throw postFailure ?? error;
  }
  if (postFailure) {
    throw postFailure;
  }
  return null;
}

function findThread(
  threads: Record<string, readonly ThreadSummary[]>,
  id: string,
  listedChannelIds: ReadonlySet<string>,
): ThreadSummary | null {
  for (const list of Object.values(threads)) {
    const thread = list.find((one) => one.channelId === id);
    if (thread && listedChannelIds.has(thread.parentChannelId)) {
      return thread;
    }
  }
  return null;
}

/** A refusal that means "not a post, or not one you can see". */
function isNotThere(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 404 || status === 403;
}

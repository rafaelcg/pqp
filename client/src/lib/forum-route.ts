import type {
  ForumPostRemoved,
  ForumPostSummary,
  ForumPostUpsert,
  ThreadSummary,
} from "@pqp/shared";

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

/**
 * Keep the open post's panel in step with the forum's live frames: a retitle,
 * a new tag, a lock or a resolve shows in its header at once, and a delete
 * marks it removed so the panel can say so instead of vanishing. Anything
 * about another post, or an open thread that is not a post, returns the
 * same object, so React skips the render.
 */
export function applyForumFrameToOpenPost<
  T extends {
    thread: ThreadSummary;
    forumPost?: { post: ForumPostSummary; removed: boolean } | null;
  },
>(open: T | null, frame: ForumPostUpsert | ForumPostRemoved): T | null {
  const current = open?.forumPost;
  if (!open || !current) {
    return open;
  }
  if (frame.type === "forum-post-removed") {
    if (frame.postId !== current.post.id || current.removed) {
      return open;
    }
    return { ...open, forumPost: { ...current, removed: true } };
  }
  if (frame.post.id !== current.post.id) {
    return open;
  }
  return {
    ...open,
    thread: {
      ...open.thread,
      name: frame.post.title,
      replyCount: frame.post.replyCount,
      lastActivityAt: frame.post.lastActivityAt,
    },
    forumPost: { post: frame.post, removed: current.removed },
  };
}

/**
 * A post as the thread panel takes it. A post IS a thread channel (with no
 * root message), so App's existing panel, controller and read cursor carry
 * it; forum PR 3b teaches the panel to draw it as a post
 * (`variant="forum-post"`) from the summary App keeps beside it.
 */
export function threadSummaryForPost(post: ForumPostSummary): ThreadSummary {
  return {
    channelId: post.id,
    parentChannelId: post.forumId,
    rootMessageId: null,
    name: post.title,
    replyCount: post.replyCount,
    lastActivityAt: post.lastActivityAt,
    // A post never archives (spec §3.7); the panel must not say "Arquivada".
    archived: false,
    participants: [],
  };
}

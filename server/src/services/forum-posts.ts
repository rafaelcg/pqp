import {
  FORUM_ERRORS,
  FORUM_POSTS_PER_WINDOW,
  FORUM_POST_WINDOW_MS,
  hasPermission,
  Permission,
  type CreateForumPostRequest,
  type ForumPostSummary,
  type ForumPostViewer,
  type MessageRejectReason,
} from "@pqp/shared";
import type { DbUser } from "../db.js";
import { sharedRateLimit } from "../lib/cluster-rate-limit.js";
import {
  announceForumPost,
  announceForumPostUpdate,
  applyAutomodEffects,
  postChannelMessage,
  takeMessageBudget,
} from "../ws/chat.js";
import { checkAutomod, recordAutomodHit } from "./automod.js";
import {
  checkTagChange,
  createForumPostShell,
  discardForumPostShell,
  ForumError,
  getForumPostSummary,
  getForumSettings,
  listForumTagRefs,
  publishForumPost,
  readForumPostViewers,
} from "./forums.js";
import { computeMemberPermissions } from "./permissions.js";
import type { ChannelRow } from "./servers.js";
import { chargeSlowMode, refundSlowMode } from "./slow-mode.js";

/**
 * Creating a forum post: one request, no half posts (plan §1.5).
 *
 * Kept apart from `services/forums.ts` because it ends in `postChannelMessage`
 * and the live frames, which live in `ws/chat.ts`, and `ws/chat.ts` itself
 * reads `forums.ts` to bump a post on every reply. See that file's header.
 *
 * The order of the gates is the chat send's order, for the chat send's
 * reason: every refusal that is a decision about WHO (no access, no
 * SEND_MESSAGES, a staff-only tag) comes before anything that spends a
 * budget, and the slow-mode charge is the last thing before the write, so a
 * post refused for any other reason does not also cost the member their turn.
 */

/** Five posts per ten minutes per person, counted across every instance. */
export const FORUM_POST_BUCKET = {
  bucket: "forum-post",
  capacity: FORUM_POSTS_PER_WINDOW,
  refillPerSecond: FORUM_POSTS_PER_WINDOW / (FORUM_POST_WINDOW_MS / 1000),
} as const;

/** One token's worth of wait, for the `retryAfterMs` of a refusal. */
const POST_BUCKET_RETRY_MS = Math.ceil(1000 / FORUM_POST_BUCKET.refillPerSecond);

/**
 * A refusal the composer renders with the chat composer's own copy. `field`
 * names which half AutoMod refused, so the composer can say "esse título"
 * rather than "esse post" (forum QA P18).
 */
function rejected(
  reason: MessageRejectReason,
  extra: {
    retryAfterMs?: number;
    automodMessage?: string;
    field?: "title" | "body";
  } = {},
): ForumError {
  return new ForumError(422, FORUM_ERRORS.postRejected, {
    reason,
    ...(extra.retryAfterMs && extra.retryAfterMs > 0
      ? { retryAfterMs: extra.retryAfterMs }
      : {}),
    ...(extra.automodMessage ? { automodMessage: extra.automodMessage } : {}),
    ...(extra.field ? { field: extra.field } : {}),
  });
}

export interface CreateForumPostInput {
  author: DbUser;
  /** The forum channel, already access-checked and known to be a forum. */
  forum: ChannelRow & { server_id: string };
  request: CreateForumPostRequest;
}

export interface CreateForumPostResult {
  post: ForumPostSummary;
  viewer: ForumPostViewer;
  /** False when the nonce named a post that already existed (answer 200). */
  created: boolean;
}

export async function createForumPost(
  input: CreateForumPostInput,
): Promise<CreateForumPostResult> {
  const { author, forum, request } = input;
  const serverId = forum.server_id;

  const memberPerms = await computeMemberPermissions(serverId, author.id, forum.id);
  if (!hasPermission(memberPerms, Permission.SEND_MESSAGES)) {
    throw new ForumError(403, "You cannot post in this forum");
  }
  const isStaff =
    hasPermission(memberPerms, Permission.MANAGE_MESSAGES) ||
    hasPermission(memberPerms, Permission.MANAGE_CHANNELS);

  const tagIds = request.tagIds ?? [];
  const [forumTags, settings] = await Promise.all([
    listForumTagRefs(forum.id),
    getForumSettings(forum.id),
  ]);
  checkTagChange(forumTags, tagIds, [], isStaff);
  if (settings.requireTag && tagIds.length === 0) {
    throw new ForumError(422, FORUM_ERRORS.tagRequired);
  }

  // AutoMod on the title, before anything is charged, the send budget
  // included: a refused post costs the author nothing but the attempt. The
  // body is checked by the message path itself, on the post's id.
  const automodInput = {
    serverId,
    channelId: forum.id,
    // The title is checked on the forum itself, which has no parent.
    parentChannelId: null,
    authorId: author.id,
    memberPerms,
    body: request.title,
  };
  const verdict = await checkAutomod(automodInput);
  if (verdict) {
    void recordAutomodHit(automodInput, verdict)
      .then(applyAutomodEffects)
      .catch((error: unknown) => {
        console.error("[automod] forum title hit effects failed:", error);
      });
    throw rejected("automod", {
      automodMessage: verdict.customMessage ?? undefined,
      field: "title",
    });
  }

  // The per-user send bucket every door shares (socket, bot HTTP, and now
  // this), so a post is never a way around the chat budget.
  const budget = takeMessageBudget(author.id);
  if (!budget.ok) {
    throw rejected("rate-limited", { retryAfterMs: budget.retryAfterMs });
  }

  // A nonce retry is answered before the post bucket and slow mode, which
  // exist to decide whether a NEW post may be created; a retry of one that
  // landed cost the author its turn already.
  const shell = await createForumPostShell({
    forumId: forum.id,
    serverId,
    authorId: author.id,
    title: request.title,
    tagIds,
    nonce: request.nonce,
    attachmentIds: request.attachmentIds,
  });
  if (shell.kind === "existing") {
    if (!shell.published) {
      // The first attempt is still between its shell and its opening
      // message. The composer retries; by then it has landed or been undone.
      throw new ForumError(409, "Post is being created");
    }
    const post = await getForumPostSummary(shell.postId);
    if (!post) {
      throw new ForumError(409, "Post is being created");
    }
    // The first attempt may have published and then failed before (or while)
    // announcing. The upsert is idempotent, so a retry repairs the live row.
    announceForumPostUpdate(post);
    const [viewer] = await readForumPostViewers([post.id], author.id);
    return { post, viewer: viewer!, created: false };
  }
  const postId = shell.postId;

  // From here on a refusal must undo the shell, or it would sit invisible
  // until the sweep and keep the composer's staged files away from a retry.
  let slowModeCharged = false;
  try {
    // Cluster-wide, so two containers allow five, not ten.
    if (!(await sharedRateLimit(FORUM_POST_BUCKET, author.id))) {
      throw rejected("rate-limited", { retryAfterMs: POST_BUCKET_RETRY_MS });
    }

    // A forum's slow mode is the interval between NEW POSTS, charged on the
    // forum id; replies inside a post read the post's own interval (0). The
    // same pair walks through it as through a channel's.
    const slowModeSeconds = isStaff ? 0 : (forum.slowmode_seconds ?? 0);
    if (slowModeSeconds > 0) {
      const charge = await chargeSlowMode(forum.id, author.id, slowModeSeconds);
      if (!charge.ok) {
        throw rejected("slow-mode", { retryAfterMs: charge.retryAfterMs });
      }
      slowModeCharged = true;
    }

    const posted = await postChannelMessage({
      author,
      channelId: postId,
      body: request.body,
      attachmentIds: request.attachmentIds,
      nonce: request.nonce,
    });
    if (!posted.ok) {
      switch (posted.reason) {
        case "bad-reply":
        case "empty":
          // Every staged file failed its check and there was no text.
          throw new ForumError(400, "A post needs text or a file");
        case "no-access":
          throw new ForumError(404, "Forum not found");
        case "cannot-send":
          throw new ForumError(403, "You cannot post in this forum");
        default:
          throw rejected(posted.reason, {
            retryAfterMs: posted.retryAfterMs,
            automodMessage: posted.automodMessage,
            // The message path checked the opening message: the body.
            ...(posted.reason === "automod" ? { field: "body" as const } : {}),
          });
      }
    }

    await publishForumPost(postId, posted.message.id);
  } catch (error) {
    if (slowModeCharged) {
      await refundSlowMode(forum.id, author.id).catch((refundError: unknown) => {
        console.error("[forums] slow-mode refund failed:", refundError);
      });
    }
    await discardForumPostShell(postId, forum.id).catch((discardError: unknown) => {
      // The sweep removes it within FORUM_SHELL_TTL_MS.
      console.error("[forums] shell cleanup failed:", discardError);
    });
    throw error;
  }

  const post = await getForumPostSummary(postId);
  if (!post) {
    // Published a moment ago and gone already: a moderator deleted it.
    throw new ForumError(404, "Post not found");
  }
  // The post exists from here on: a failed fan-out is logged, never answered
  // as a failed create (the client would retry, and the nonce would hand back
  // this post and re-announce it anyway).
  await announceForumPost(post, author.id).catch((error: unknown) => {
    console.error("[forums] announce failed:", error);
  });
  const [viewer] = await readForumPostViewers([postId], author.id);
  return { post, viewer: viewer!, created: true };
}

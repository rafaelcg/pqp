import {
  FORUM_ERRORS,
  FORUM_MAX_PINNED,
  FORUM_MAX_TAGS_PER_POST,
  FORUM_TITLE_MAX,
  type ForumAcceptedAnswer,
  type ForumPostDetailResponse,
  type ForumPostSummary,
  type ForumTag,
  type UpdateForumPostRequest,
} from "@pqp/shared";
import {
  ArrowDown,
  ArrowLeft,
  Bell,
  BellOff,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleCheck,
  Link2,
  Lock,
  LockOpen,
  Maximize2,
  MessagesSquare,
  Minimize2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ComposerSlashContext } from "@/components/chat/message-composer";
import type {
  MessageAuthorInfo,
  MessageRoleColor,
} from "@/components/chat/message-list";
import { ThreadPanel } from "@/components/chat/thread-panel";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import { Dialog } from "@/components/ui/dialog";
import { Menu } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import type { ChatController, ChatMessage } from "@/hooks/use-chat";
import { ApiError, fetchMessages } from "@/lib/api";
import {
  deleteForumPost,
  fetchForumPost,
  readForumPublishError,
  setForumPostFollow,
  updateForumPost,
  type ForumTagsStatus,
} from "@/lib/forum-api";
import { useForumTagLabel } from "@/lib/forum-tag-icons";
import { useTranslation } from "@/lib/i18n";
import type { MentionCandidate } from "@/lib/mention-autocomplete";
import { backfillForLanding } from "@/lib/forum-landing";
import {
  readSolutionNudgeDismissed,
  writeSolutionNudgeDismissed,
} from "@/lib/forum-prefs";
import { forgetCursorRead, readCursorOnce } from "@/lib/forum-visit";
import { findFirstUnreadMessageId } from "@/lib/unread-divider";
import { cn } from "@/lib/utils";
import { ForumTagList } from "./forum-post-card";
import { ForumTagIcon } from "./forum-tag-icon";

/**
 * One post, read and replied to (UX §2.4). The transcript, the composer and
 * the live machinery are the thread panel's (`variant="forum-post"`), pointed
 * at the post's channel through App's second chat controller, the one on the
 * `thread-join` slot, so the forum list (on `join-channel`) stays live beside
 * it. This file adds what a post has and a chat thread does not: the title,
 * tags and status, the accepted answer under the question, and the actions
 * grouped by who may take them.
 *
 * Every action is optimistic and rolls back with "Não deu pra salvar" when the
 * server says no; the list receives the same patch so the card and the pane
 * never disagree.
 */

export interface ForumPostViewProps {
  post: ForumPostSummary;
  forumName: string;
  serverId: string;
  tags: readonly ForumTag[];
  /** The forum asks for at least one tag: Edit tags cannot save none. */
  requireTag?: boolean;
  /** Whether `tags` is an answered read: a failed one is not "no tags". */
  tagsStatus?: ForumTagsStatus;
  /** The tags are read again as the editor opens (a saved list is not replayed). */
  onRefreshTags?: () => void;
  onRetryTags?: () => void;
  /** MANAGE_CHANNELS: an empty editor links to the Tags settings. */
  canManageTags?: boolean;
  onOpenTagSettings?: () => void;
  tagsById: ReadonlyMap<string, ForumTag>;
  viewerId: string | null;
  /** MANAGE_MESSAGES or MANAGE_CHANNELS on the forum. */
  isStaff: boolean;
  canSend: boolean;
  layout: "side" | "full";
  /** The full-area layout because the window is narrow, not by choice. */
  forcedFull: boolean;
  /**
   * A phone: the title and status scroll with the transcript, and the top bar
   * takes the title over once they have scrolled off (UX §2.4 #22).
   */
  isPhone?: boolean;
  maximized: boolean;
  onToggleMaximize: () => void;
  /** Deleted while open: the pane says so instead of closing on the reader. */
  removed: boolean;
  pinnedCount: number;
  href: string;
  controller: ChatController;
  currentUser: {
    id: string;
    displayName: string;
    username: string | null;
    tag: string | null;
    avatarUrl: string | null;
  } | null;
  mentionCandidates: MentionCandidate[];
  blockedAuthorIds: ReadonlySet<string>;
  authors?: ReadonlyMap<string, MessageAuthorInfo>;
  /** `authors` is the server's whole roster: see MessageList. */
  authorsComplete?: boolean;
  roles?: readonly MessageRoleColor[];
  showLinkEmbeds: boolean;
  slashContext?: Omit<
    ComposerSlashContext,
    "sendChance" | "sendPoll" | "canPurgeMessages" | "openPurgeDialog"
  >;
  onReportMessage?: (message: ChatMessage) => void;
  onForward?: (message: ChatMessage) => void;
  /** Moves the read cursor to now; answers the cursor it replaced. */
  markRead: (channelId: string) => Promise<string | null>;
  onClose: () => void;
  onPostChange: (post: ForumPostSummary) => void;
  onDeleted: (postId: string) => void;
  onShowPinned: () => void;
  notify: (text: string, action?: { label: string; onClick: () => void }) => void;
}

/** The detail's people count refreshes at most this often as replies land. */
const DETAIL_REFRESH_MS = 30_000;
/** A failed detail read is asked again this many times. */
const DETAIL_RETRIES = 3;

/** See the transcript effect: the closing read waits a beat for a remount. */
const leaveTimers = new Map<string, number>();

function PostIconButton({
  label,
  onClick,
  children,
  pressed,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={pressed}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-control)] text-text-tertiary transition-colors duration-[var(--duration-fast)] hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:h-11 max-sm:w-11"
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** Edit tags: the same toggle chips as the composer, staff tags for staff. */
export function EditTagsDialog({
  open,
  tags,
  tagsStatus = "ready",
  requireTag = false,
  current,
  isStaff,
  canManageTags = false,
  onRefresh,
  onRetry,
  onOpenSettings,
  onClose,
  onSave,
}: {
  open: boolean;
  tags: readonly ForumTag[];
  tagsStatus?: ForumTagsStatus;
  requireTag?: boolean;
  current: readonly string[];
  isStaff: boolean;
  canManageTags?: boolean;
  onRefresh?: () => void;
  onRetry?: () => void;
  onOpenSettings?: () => void;
  onClose: () => void;
  onSave: (tagIds: string[]) => void;
}) {
  const { t } = useTranslation();
  const tagLabel = useForumTagLabel();
  const [picked, setPicked] = useState<string[]>([...current]);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  useEffect(() => {
    if (open) {
      setPicked([...current]);
      refreshRef.current?.();
    }
    // Reseed per opening only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const atMax = picked.length >= FORUM_MAX_TAGS_PER_POST;
  // A member never puts on or takes off a staff tag; one already on the post
  // still shows, unchangeable. With none of those the dialog would be a title
  // and two buttons around nothing, so it says why instead.
  const shown = tags.filter((tag) => !(tag.moderated && !isStaff) || picked.includes(tag.id));
  // The forum asks for a tag: unticking the last one would be refused, so
  // Save waits and the reason is written under the chips.
  const noneLeft = requireTag && shown.length > 0 && picked.length === 0;
  return (
    <Dialog
      open={open}
      title={t("forum.editTags")}
      size="sm"
      onClose={onClose}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("forum.edit.cancel")}
          </Button>
          {shown.length > 0 && (
            <Button disabled={noneLeft} onClick={() => onSave(picked)}>
              {t("forum.edit.save")}
            </Button>
          )}
        </div>
      }
    >
      {shown.length === 0 && (
        <div
          data-forum-edit-tags-empty={tagsStatus === "ready" ? "none" : tagsStatus}
          className="flex flex-col items-start gap-2 px-5 py-4 text-sm text-text-secondary"
        >
          <p role={tagsStatus === "error" ? "alert" : "status"}>
            {tagsStatus === "loading"
              ? t("common.loading")
              : tagsStatus === "error"
                ? t("forum.editTags.loadError")
                : t("forum.editTags.none")}
          </p>
          {tagsStatus === "error" && onRetry && (
            <Button size="sm" variant="secondary" onClick={onRetry}>
              {t("forum.retry")}
            </Button>
          )}
          {tagsStatus === "ready" && canManageTags && onOpenSettings && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                onClose();
                onOpenSettings();
              }}
            >
              {t("forum.empty.setupTags")}
            </Button>
          )}
        </div>
      )}
      <div className={cn("flex flex-wrap gap-1.5 px-5 py-4", shown.length === 0 && "hidden")}>
        {shown.map((tag) => {
          const on = picked.includes(tag.id);
          const locked = tag.moderated && !isStaff;
          const disabled = locked || (!on && atMax);
          return (
            <button
              key={tag.id}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              title={tag.moderated ? t("forum.tags.moderatedHint") : undefined}
              onClick={() =>
                setPicked((list) =>
                  list.includes(tag.id)
                    ? list.filter((one) => one !== tag.id)
                    : [...list, tag.id],
                )
              }
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] transition-[background-color,color,transform] duration-[var(--duration-fast)] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50 max-sm:h-11 max-sm:px-4",
                on
                  ? "bg-text font-semibold text-surface-0"
                  : "text-text-secondary ring-1 ring-inset ring-border hover:bg-surface-3 hover:text-text",
              )}
            >
              <ForumTagIcon tag={tag} className="h-3.5 w-3.5" />
              {tagLabel(tag)}
              {on && <Check className="h-3.5 w-3.5" aria-hidden />}
            </button>
          );
        })}
      </div>
      {noneLeft && (
        <p
          role="status"
          data-forum-edit-tags-required=""
          className="-mt-2 px-5 pb-4 text-xs text-text-secondary"
        >
          {t("forum.composer.tagsRequiredError")}
        </p>
      )}
    </Dialog>
  );
}

function SolutionCard({
  answer,
  onJump,
  viewerId,
  compact = false,
}: {
  answer: ForumAcceptedAnswer;
  onJump: () => void;
  viewerId: string | null;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  // Who picked it, as mock 02 draws it (forum QA P9). Nobody named when the
  // server does not know (an answer marked before it kept the marker).
  const markedBy =
    answer.markedById && answer.markedById === viewerId
      ? t("forum.solution.markedByYou")
      : answer.markedByName
        ? t("forum.solution.markedBy", { name: answer.markedByName })
        : null;
  const heading =
    answer.deleted || !answer.authorName
      ? t("forum.solution.title")
      : t("forum.solution.from", { name: answer.authorName });
  return (
    <section
      aria-label={t("forum.solution.title")}
      data-forum-solution={answer.messageId}
      className={cn(
        "animate-pop-in rounded-[var(--radius-panel)] bg-success-soft text-on-success-soft",
        compact ? "mx-3 mb-2 mt-2 px-3.5 py-2.5 sm:mx-4" : "mx-3 my-3 px-4 py-3.5 sm:mx-5",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 text-[13px] font-semibold">
        <CircleCheck className="h-4 w-4 shrink-0" aria-hidden />
        <span className="truncate">{heading}</span>
        {markedBy && (
          <span className="min-w-0 truncate font-normal opacity-80 max-sm:hidden">· {markedBy}</span>
        )}
        {!answer.deleted && (
          <button
            type="button"
            onClick={onJump}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-control)] px-1 text-xs font-semibold underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:hit-44"
          >
            {t("forum.solution.jump")}
            <ArrowDown className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>
      {!compact && (
        <p className="mt-2 line-clamp-3 text-sm leading-[21px] text-text">
          {answer.deleted ? (
            <span className="italic text-on-success-soft">{t("forum.solution.deleted")}</span>
          ) : (
            answer.excerpt
          )}
        </p>
      )}
    </section>
  );
}

/** "14 respostas · 6 pessoas": where the question ends and the replies begin. */
function RepliesDivider({ count, people }: { count: number; people: number | null }) {
  const { t } = useTranslation();
  return (
    <div
      className="mx-4 mb-1 mt-5 flex items-baseline gap-2.5 sm:mx-5"
      data-forum-replies-divider=""
    >
      <span className="shrink-0 font-display text-[17px] font-bold leading-[22px] tabular-nums text-text">
        {t("forum.post.repliesDivider", { count })}
      </span>
      {people !== null && people > 0 && (
        <span className="text-[13px] tabular-nums text-text-secondary">
          {t("forum.post.people", { count: people })}
        </span>
      )}
      <span aria-hidden className="h-px flex-1 self-center bg-border/60" />
    </div>
  );
}

export function ForumPostView({
  post,
  forumName,
  serverId,
  tags,
  requireTag = false,
  tagsStatus = "ready",
  onRefreshTags,
  onRetryTags,
  canManageTags = false,
  onOpenTagSettings,
  tagsById,
  viewerId,
  isStaff,
  canSend,
  layout,
  forcedFull,
  isPhone = false,
  maximized,
  onToggleMaximize,
  removed,
  pinnedCount,
  href,
  controller,
  currentUser,
  mentionCandidates,
  blockedAuthorIds,
  authors,
  authorsComplete,
  roles,
  showLinkEmbeds,
  slashContext,
  onReportMessage,
  onForward,
  markRead,
  onClose,
  onPostChange,
  onDeleted,
  onShowPinned,
  notify,
}: ForumPostViewProps) {
  const { t } = useTranslation();
  const postId = post.id;
  const isAuthor = viewerId !== null && post.authorId === viewerId;
  const canEdit = isAuthor || isStaff;

  // ------------------------------------------------------------ transcript
  const [loading, setLoading] = useState(true);
  const [unreadSince, setUnreadSince] = useState<string | null>(null);
  const [firstVisit, setFirstVisit] = useState(false);
  const markReadRef = useRef(markRead);
  markReadRef.current = markRead;
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setUnreadSince(null);
    controller.joinChannel(postId);
    // A remount of the same post (React's dev double mount, a layout swap)
    // must not move the cursor twice: the second answer would be the first
    // one's "now", and a first visit would read as a revisit.
    const pendingLeave = leaveTimers.get(postId);
    if (pendingLeave !== undefined) {
      window.clearTimeout(pendingLeave);
      leaveTimers.delete(postId);
    }
    let transcriptLoaded = false;
    void fetchMessages(postId)
      .then(async (page) => {
        if (cancelled) {
          return;
        }
        controller.setMessages(page.messages, page.hasMore);
        transcriptLoaded = true;
        // Read only once the transcript is in: a failed load must not mark
        // the post read. A failed read is treated as a first visit rather
        // than throwing away the transcript.
        const previous = await readCursorOnce(postId, markReadRef.current).catch(
          () => null,
        );
        if (cancelled) {
          return;
        }
        // The newest page ends on the newest reply, which is the one place a
        // post must not open on: page back to the question (first visit) or
        // to the first reply this reader has not seen (a revisit).
        await backfillForLanding(controller, previous, {
          cancelled: () => cancelled,
        });
        if (cancelled) {
          return;
        }
        const loaded = controller.getMessages();
        setFirstVisit(previous === null);
        setUnreadSince(
          previous && findFirstUnreadMessageId(loaded, previous, viewerId)
            ? previous
            : null,
        );
      })
      .catch(() => {
        // Opens empty; live replies and sending still work, and reopening
        // retries the read.
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      controller.leaveChannel();
      // Everything the pane showed is read now; a beat later, so a remount
      // of the same post cancels it.
      const markReadNow = markReadRef.current;
      // A post whose replies never loaded was not read: the cursor stays.
      if (!transcriptLoaded) {
        return;
      }
      leaveTimers.set(
        postId,
        window.setTimeout(() => {
          leaveTimers.delete(postId);
          forgetCursorRead(postId);
          void markReadNow(postId);
        }, 0),
      );
    };
    // The controller is App's, stable for the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId]);

  // -------------------------------------------------------------- detail
  const [detail, setDetail] = useState<ForumPostDetailResponse | null>(null);
  // Replies only change the people count, so they refresh it at most every
  // 30 s; a new answer refreshes at once.
  const repliesBucket = Math.floor(Date.now() / DETAIL_REFRESH_MS);
  const detailKey = `${postId}:${post.acceptedAnswerId ?? ""}:${
    post.replyCount > 0 ? repliesBucket : 0
  }`;
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const read = (attempt: number) => {
      fetchForumPost(postId)
        .then((next) => {
          if (!cancelled) {
            setDetail(next);
          }
        })
        .catch(() => {
          // A blip leaves the answer card and Seguir missing for the visit
          // unless it is asked again.
          if (!cancelled && attempt < DETAIL_RETRIES) {
            timer = window.setTimeout(() => read(attempt + 1), 2000 * 2 ** attempt);
          }
        });
    };
    read(0);
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [detailKey, postId]);
  const [following, setFollowing] = useState<boolean | null>(null);
  useEffect(() => {
    setFollowing(detail?.viewer.following ?? null);
  }, [detail?.viewer.following]);
  const [followSupported, setFollowSupported] = useState(true);

  // A local answer card while the detail catches up with a mark made here.
  const [localAnswer, setLocalAnswer] = useState<ForumAcceptedAnswer | null>(null);
  const answer: ForumAcceptedAnswer | null = post.acceptedAnswerId
    ? detail?.acceptedAnswer?.messageId === post.acceptedAnswerId
      ? detail.acceptedAnswer
      : localAnswer?.messageId === post.acceptedAnswerId
        ? localAnswer
        : null
    : null;

  // --------------------------------------------------------------- actions
  // Two quick actions overlap; only the newest one's answer is applied, so an
  // older response arriving late cannot undo the newer state on screen.
  const patchSeqRef = useRef(0);
  const patch = useCallback(
    async (update: UpdateForumPostRequest, optimistic: ForumPostSummary) => {
      const before = post;
      const seq = ++patchSeqRef.current;
      const latest = () => patchSeqRef.current === seq;
      onPostChange(optimistic);
      try {
        const { post: saved } = await updateForumPost(postId, update);
        if (latest()) {
          onPostChange(saved);
        }
      } catch (error) {
        // The server's copy, not a snapshot: a second action or a live frame
        // that landed meanwhile must not be undone by this one's rollback.
        fetchForumPost(postId)
          .then(({ post: fresh }) => {
            if (latest()) {
              onPostChange(fresh);
            }
          })
          .catch(() => {
            if (latest()) {
              onPostChange(before);
            }
          });
        if (
          error instanceof ApiError &&
          (error.message === FORUM_ERRORS.pinLimit ||
            (error.details as { error?: string } | null)?.error === FORUM_ERRORS.pinLimit)
        ) {
          notify(t("forum.pin.full", { max: FORUM_MAX_PINNED }), {
            label: t("forum.pin.seeAll"),
            onClick: onShowPinned,
          });
          return;
        }
        const refusal = readForumPublishError(error);
        if (refusal.kind === "tag-required") {
          notify(t("forum.composer.tagsRequiredError"));
        } else if (refusal.kind === "tag-moderated") {
          notify(t("forum.composer.tagModerated"));
        } else if (refusal.kind === "tag-unknown") {
          notify(t("forum.composer.tagUnknown"));
          onRefreshTags?.();
        } else {
          notify(t("forum.saveFailed"));
        }
      }
    },
    [post, postId, onPostChange, notify, onShowPinned, onRefreshTags, t],
  );

  const nowIso = () => new Date().toISOString();

  const toggleAnswer = useCallback(
    (messageId: string) => {
      if (post.acceptedAnswerId === messageId) {
        setLocalAnswer(null);
        void patch(
          { acceptedAnswerId: null },
          { ...post, acceptedAnswerId: null },
        );
        return;
      }
      const message = controller.getMessages().find((one) => one.id === messageId);
      if (message) {
        setLocalAnswer({
          messageId,
          deleted: false,
          authorId: message.authorId,
          authorName: message.authorName,
          excerpt: message.body.replace(/\s+/g, " ").trim().slice(0, 280) || null,
          createdAt: message.createdAt,
          markedById: viewerId,
          markedByName: currentUser?.displayName ?? null,
        });
      }
      void patch(
        { acceptedAnswerId: messageId },
        {
          ...post,
          acceptedAnswerId: messageId,
          resolvedAt: post.resolvedAt ?? nowIso(),
        },
      );
    },
    [controller, patch, post, viewerId, currentUser?.displayName],
  );

  function toggleResolved() {
    if (post.resolvedAt) {
      setLocalAnswer(null);
      void patch(
        { resolved: false },
        { ...post, resolvedAt: null, acceptedAnswerId: null },
      );
    } else {
      void patch({ resolved: true }, { ...post, resolvedAt: nowIso() });
    }
  }

  const [followBusy, setFollowBusy] = useState(false);
  async function toggleFollow() {
    if (followBusy) {
      return;
    }
    const next = !following;
    setFollowing(next);
    setFollowBusy(true);
    try {
      const { viewer } = await setForumPostFollow(postId, next);
      setFollowing(viewer.following);
      notify(viewer.following ? t("forum.follow.on") : t("forum.follow.off"));
    } catch (error) {
      setFollowing(!next);
      if (error instanceof ApiError && error.status === 404) {
        // An API without follows yet: the control goes, nothing breaks.
        setFollowSupported(false);
        return;
      }
      notify(t("forum.saveFailed"));
    } finally {
      setFollowBusy(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.origin).toString());
      notify(t("forum.post.linkCopied"));
    } catch {
      notify(t("forum.saveFailed"));
    }
  }

  // Inline title edit.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(post.title);
  const titleInputRef = useRef<HTMLInputElement>(null);
  // From the More menu the menu hands focus back to its button as it closes,
  // after the input has autofocused: take it again once that has settled, so
  // typing and Enter reach the field.
  useEffect(() => {
    if (!editingTitle) {
      return;
    }
    const id = window.setTimeout(() => {
      const input = titleInputRef.current;
      if (input && document.activeElement !== input) {
        input.focus();
      }
    }, 80);
    return () => window.clearTimeout(id);
  }, [editingTitle]);
  function saveTitle() {
    const next = titleDraft.replace(/\s+/g, " ").trim();
    setEditingTitle(false);
    if (!next || next === post.title) {
      return;
    }
    void patch({ title: next }, { ...post, title: next });
  }

  const [editTagsOpen, setEditTagsOpen] = useState(false);
  // The action opens a dialog of toggle chips: with no chip this person could
  // toggle it would open an empty box, so it is not offered. Managers find the
  // way to the Tags settings in the forum's empty state and in the composer.
  const canEditTags =
    tagsStatus !== "ready" ||
    tags.some((tag) => !tag.moderated || isStaff || post.tagIds.includes(tag.id));
  const [deleteOpen, setDeleteOpen] = useState(false);
  async function confirmDelete() {
    setDeleteOpen(false);
    try {
      await deleteForumPost(postId);
      onDeleted(postId);
    } catch {
      notify(t("forum.saveFailed"));
    }
  }

  const menuItems: ContextMenuItemDef[] = [
    { id: "heading-post", label: t("forum.menu.post"), heading: true },
    ...(canEdit
      ? [
          ...(canEditTags
            ? [
                {
                  id: "edit-tags",
                  label: t("forum.editTags"),
                  icon: Tags,
                  onSelect: () => setEditTagsOpen(true),
                },
              ]
            : []),
          {
            id: "edit-title",
            label: t("forum.editTitle"),
            icon: Pencil,
            onSelect: () => {
              setTitleDraft(post.title);
              setEditingTitle(true);
            },
          },
        ]
      : []),
    {
      id: "copy-link",
      label: t("forum.post.copyLink"),
      icon: Link2,
      onSelect: () => void copyLink(),
    },
    ...(isStaff
      ? [
          { id: "sep-staff", label: "", separator: true },
          { id: "heading-staff", label: t("forum.menu.staff"), heading: true },
          post.pinnedAt
            ? {
                id: "unpin",
                label: t("forum.unpin"),
                icon: PinOff,
                onSelect: () =>
                  void patch({ pinned: false }, { ...post, pinnedAt: null }),
              }
            : {
                id: "pin",
                label: `${t("forum.pin")} · ${t("forum.pin.count", {
                  count: pinnedCount,
                  max: FORUM_MAX_PINNED,
                })}`,
                icon: Pin,
                onSelect: () => {
                  if (pinnedCount >= FORUM_MAX_PINNED) {
                    notify(t("forum.pin.full", { max: FORUM_MAX_PINNED }), {
                      label: t("forum.pin.seeAll"),
                      onClick: onShowPinned,
                    });
                    return;
                  }
                  void patch({ pinned: true }, { ...post, pinnedAt: nowIso() });
                },
              },
          post.lockedAt
            ? {
                id: "unlock",
                label: t("forum.unlock"),
                icon: LockOpen,
                onSelect: () =>
                  void patch({ locked: false }, { ...post, lockedAt: null }),
              }
            : {
                id: "lock",
                label: t("forum.lock"),
                icon: Lock,
                onSelect: () =>
                  void patch({ locked: true }, { ...post, lockedAt: nowIso() }),
              },
          { id: "sep-delete", label: "", separator: true },
          {
            id: "delete",
            label: t("forum.delete"),
            icon: Trash2,
            danger: true,
            onSelect: () => setDeleteOpen(true),
          },
        ]
      : []),
  ];

  // ---------------------------------------------------------- answer jump
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const jumpToAnswer = useCallback(() => {
    if (post.acceptedAnswerId) {
      setHighlightId(post.acceptedAnswerId);
    }
  }, [post.acceptedAnswerId]);

  const openingLoaded = !controller.hasMoreHistory() && !loading;

  // -------------------------------------------------------------- header
  // Phone: once the title block scrolls under the bar, the bar shows the title.
  const titleBlockRef = useRef<HTMLDivElement>(null);
  const [titleInBar, setTitleInBar] = useState(false);
  useEffect(() => {
    const node = titleBlockRef.current;
    if (!isPhone || !node || typeof IntersectionObserver === "undefined") {
      setTitleInBar(false);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setTitleInBar(entry ? !entry.isIntersecting : false),
      // The bar is 48px tall; the title counts as gone once it is under it.
      { rootMargin: "-48px 0px 0px 0px", threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [isPhone, loading]);
  const people = detail?.participantCount ?? null;
  const replyLine = [
    t("forum.replies", { count: post.replyCount }),
    people !== null && people > 0 ? t("forum.post.people", { count: people }) : null,
  ]
    .filter(Boolean)
    .join(" · ");


  const topBar = (
      <div className="flex h-14 items-center gap-1 px-2 sm:px-3">
        {(layout === "full" || forcedFull) && (
          <PostIconButton label={t("forum.post.back")} onClick={onClose}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </PostIconButton>
        )}
        <div className="relative min-w-0 flex-1 self-stretch">
          <p
            className={cn(
              "absolute inset-0 flex items-center gap-1.5 px-1 text-[13px] text-text-secondary transition-[opacity,transform] duration-[var(--duration-base)] ease-[var(--ease-standard)] motion-reduce:transition-none",
              titleInBar && "pointer-events-none -translate-y-1 opacity-0",
            )}
            aria-hidden={titleInBar || undefined}
          >
            <MessagesSquare className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{forumName}</span>
            <span className="truncate sm:hidden">· {replyLine}</span>
          </p>
          {isPhone && (
            <p
              className={cn(
                "absolute inset-0 flex items-center truncate px-1 font-display text-[15px] font-bold text-text transition-[opacity,transform] duration-[var(--duration-base)] ease-[var(--ease-standard)] motion-reduce:transition-none",
                titleInBar ? "opacity-100" : "pointer-events-none translate-y-1 opacity-0",
              )}
              aria-hidden={!titleInBar || undefined}
              data-forum-bar-title=""
            >
              <span className="truncate">{post.title}</span>
            </p>
          )}
        </div>
        {!forcedFull && (
          <span className="max-sm:hidden">
            <PostIconButton
              label={maximized ? t("forum.post.collapse") : t("forum.post.expand")}
              onClick={onToggleMaximize}
              pressed={maximized}
            >
              {maximized ? (
                <Minimize2 className="h-4 w-4" aria-hidden />
              ) : (
                <Maximize2 className="h-4 w-4" aria-hidden />
              )}
            </PostIconButton>
          </span>
        )}
        {layout === "side" && !forcedFull && (
          <PostIconButton label={t("forum.post.back")} onClick={onClose}>
            <X className="h-4 w-4" aria-hidden />
          </PostIconButton>
        )}
        <span className="sm:hidden">
          {/* Phones open on the menu the mock draws beside the bell. */}
          <Menu items={menuItems} align="end">
            <button
              type="button"
              aria-label={t("forum.post.menu")}
              className="grid h-11 w-11 place-items-center rounded-[var(--radius-control)] text-text-tertiary hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <MoreHorizontal className="h-5 w-5" aria-hidden />
            </button>
          </Menu>
        </span>
      </div>
  );

  // The author's "did a reply solve it?" nudge: only on their own open post
  // once somebody else answered (`people` counts the author, so 2 or more),
  // and gone for good once dismissed.
  const [nudgeDismissed, setNudgeDismissed] = useState(() =>
    readSolutionNudgeDismissed(postId),
  );
  const showNudge =
    isAuthor &&
    !post.resolvedAt &&
    !post.lockedAt &&
    post.replyCount > 0 &&
    people !== null &&
    people > 1 &&
    !nudgeDismissed;

  const statusLabel = post.resolvedAt ? t("forum.status.resolved") : t("forum.status.open");
  // One control for the post's state, where the eye already is. The author
  // and staff change it; everybody else reads a badge (open says nothing).
  const statusControl = canEdit ? (
    <Menu
      align="start"
      items={[
        {
          id: "status-open",
          label: t("forum.status.open"),
          icon: Circle,
          checked: !post.resolvedAt,
          onSelect: () => {
            if (post.resolvedAt) {
              toggleResolved();
            }
          },
        },
        {
          id: "status-resolved",
          label: t("forum.status.resolved"),
          icon: CheckCircle2,
          checked: Boolean(post.resolvedAt),
          detail: t("forum.status.hint"),
          onSelect: () => {
            if (!post.resolvedAt) {
              toggleResolved();
            }
          },
        },
      ]}
    >
      <button
        type="button"
        aria-label={`${t("forum.status.label")}: ${statusLabel}`}
        data-forum-resolve={post.resolvedAt ? "reopen" : "resolve"}
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] pl-2 pr-1.5 text-[13px] font-semibold transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:h-11",
          post.resolvedAt
            ? "bg-success-soft text-on-success-soft"
            : "bg-surface-1 text-text-secondary hover:bg-surface-2 hover:text-text",
        )}
      >
        {post.resolvedAt ? (
          <CheckCircle2 className="h-4 w-4" aria-hidden />
        ) : (
          <Circle className="h-4 w-4 [stroke-dasharray:3_3]" aria-hidden />
        )}
        {statusLabel}
        <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden />
      </button>
    </Menu>
  ) : post.resolvedAt ? (
    <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-success-soft px-2 text-[13px] font-semibold text-on-success-soft">
      <CheckCircle2 className="h-4 w-4" aria-hidden />
      {t("forum.badge.resolved")}
    </span>
  ) : null;

  const wide = layout === "full" && !isPhone;

  const titleBlock = (
      <div
        ref={titleBlockRef}
        className={cn(
          wide ? "px-5 pb-4 pt-1" : "px-4 pb-3.5 pt-1",
          isPhone && "border-b border-border/60 pb-4 pt-4",
        )}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {statusControl}
          {post.lockedAt && (
            <span className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-control)] px-1.5 text-[13px] text-text-secondary">
              <Lock className="h-3.5 w-3.5" aria-hidden />
              {t("forum.badge.locked")}
            </span>
          )}
          {post.pinnedAt && (
            <span className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-control)] px-1.5 text-[13px] text-text-secondary">
              <Pin className="h-3.5 w-3.5" aria-hidden />
              {t("forum.badge.pinned")}
            </span>
          )}
          <ForumTagList tagIds={post.tagIds} tagsById={tagsById} max={FORUM_MAX_TAGS_PER_POST} />
          {canEdit && tags.length > 0 && post.tagIds.length === 0 && (
            // No tags yet: a lone pencil read as "edit the title" or as
            // nothing at all (forum QA P12). Say what it adds.
            <button
              type="button"
              onClick={() => setEditTagsOpen(true)}
              data-forum-add-tags=""
              className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-border-strong px-2.5 text-xs text-text-secondary transition-colors duration-[var(--duration-fast)] hover:border-text-tertiary hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:h-9 max-sm:px-3"
            >
              <Plus className="h-3 w-3" aria-hidden />
              {t("forum.post.addTags")}
            </button>
          )}
          {canEdit && tags.length > 0 && post.tagIds.length > 0 && (
            <Tooltip label={t("forum.editTags")}>
              <button
                type="button"
                onClick={() => setEditTagsOpen(true)}
                aria-label={t("forum.editTags")}
                className="grid h-7 w-7 place-items-center rounded-[var(--radius-control)] text-text-secondary hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:h-9 max-sm:w-9"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
          )}
        </div>
        {editingTitle ? (
          <input
            ref={titleInputRef}
            autoFocus
            value={titleDraft}
            maxLength={FORUM_TITLE_MAX}
            aria-label={t("forum.editTitle")}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={saveTitle}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveTitle();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setEditingTitle(false);
              }
            }}
            className={cn(
              "mt-3 w-full rounded-[var(--radius-control)] border border-border bg-surface-0 px-2 py-1 font-display font-extrabold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
              wide ? "text-[30px] leading-[38px]" : "text-[22px] leading-7",
            )}
          />
        ) : (
          <h2
            className={cn(
              "mt-3 font-display font-extrabold tracking-[-0.015em] text-text [overflow-wrap:anywhere]",
              wide ? "text-[30px] leading-[38px]" : "text-[22px] leading-7",
              canEdit && "cursor-text",
            )}
            onDoubleClick={() => {
              if (canEdit) {
                setTitleDraft(post.title);
                setEditingTitle(true);
              }
            }}
          >
            {post.title}
          </h2>
        )}
        <div className="-ml-1 mt-3 flex items-center gap-1">
          {followSupported && following !== null && (
            <Button
              size="sm"
              variant={following ? "secondary" : "ghost"}
              onClick={() => void toggleFollow()}
              disabled={followBusy}
              aria-pressed={following}
              className="gap-1.5 rounded-full max-sm:h-11"
            >
              {following ? (
                <Bell className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <BellOff className="h-3.5 w-3.5" aria-hidden />
              )}
              {following ? t("forum.following") : t("forum.follow")}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void copyLink()}
            className="gap-1.5 rounded-full max-sm:h-11"
          >
            <Link2 className="h-3.5 w-3.5" aria-hidden />
            {t("forum.post.copyLink")}
          </Button>
          <span className="ml-auto max-sm:hidden">
            <Menu items={menuItems} align="end">
              <button
                type="button"
                aria-label={t("forum.post.menu")}
                data-forum-post-menu=""
                className="grid h-8 w-8 place-items-center rounded-full text-text-secondary hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden />
              </button>
            </Menu>
          </span>
        </div>
        {showNudge && (
          <div
            role="status"
            data-forum-solution-nudge=""
            className="mt-3 flex items-start gap-2.5 rounded-[var(--radius-card)] bg-surface-1 px-3.5 py-3 text-[13px] leading-[19px] text-text-secondary animate-door-reveal"
          >
            <CheckCircle2 className="mt-px h-4 w-4 shrink-0 text-success" aria-hidden />
            <span className="min-w-0 flex-1">{t("forum.solution.nudge")}</span>
            <button
              type="button"
              aria-label={t("forum.solution.nudgeDismiss")}
              onClick={() => {
                setNudgeDismissed(true);
                writeSolutionNudgeDismissed(postId);
              }}
              className="-m-1 grid h-6 w-6 shrink-0 place-items-center rounded-[var(--radius-control)] hover:bg-surface-2 hover:text-text max-sm:hit-44"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        )}
      </div>
  );

  // Desktop: the header holds the title and stays put. Phone: only the bar
  // stays; the title block scrolls with the transcript as its first row.
  const header = (
    <header className="shrink-0 border-b border-border/60">
      {topBar}
      {!isPhone && titleBlock}
    </header>
  );

  const decor = {
    authorId: post.authorId,
    acceptedAnswerId: post.acceptedAnswerId,
    // Under the question: its answer, then where the replies start (mock 02,
    // forum QA P5). Neither on a post nobody answered yet.
    afterOpening:
      answer || post.replyCount > 0 ? (
        <>
          {answer && <SolutionCard answer={answer} onJump={jumpToAnswer} viewerId={viewerId} />}
          {post.replyCount > 0 && <RepliesDivider count={post.replyCount} people={people} />}
        </>
      ) : null,
    onToggleAnswer: canEdit ? toggleAnswer : undefined,
    landAtTop: firstVisit,
    listHeader: isPhone ? titleBlock : null,
  };

  if (removed) {
    return (
      <aside
        aria-label={post.title}
        className={cn(
          "relative flex h-full min-h-0 w-full shrink-0 flex-col items-center justify-center gap-3 border-border/60 bg-surface-0 px-6 text-center max-md:fixed max-md:inset-0 max-md:z-30",
          layout === "side" ? "md:w-[488px] md:border-l" : "md:flex-1",
        )}
        data-forum-post-removed=""
      >
        <Trash2 className="h-7 w-7 text-text-tertiary" aria-hidden />
        <p className="font-display text-base font-bold text-text">{t("forum.removed")}</p>
        <Button variant="secondary" onClick={onClose}>
          {t("forum.post.back")}
        </Button>
      </aside>
    );
  }

  const thread = {
    channelId: post.id,
    parentChannelId: post.forumId,
    rootMessageId: null,
    name: post.title,
    replyCount: post.replyCount,
    lastActivityAt: post.lastActivityAt,
    archived: false,
    participants: [],
  };

  return (
    <>
      <ThreadPanel
        thread={thread}
        variant="forum-post"
        forumPost={{
          header,
          beforeList:
            answer && !openingLoaded ? (
              <SolutionCard answer={answer} onJump={jumpToAnswer} viewerId={viewerId} compact />
            ) : null,
          decor,
          locked: post.lockedAt !== null,
          canReplyLocked: isStaff,
          placeholder:
            post.title.length > 28
              ? t("forum.reply.placeholder", { title: `${post.title.slice(0, 26)}…` })
              : t("forum.reply.placeholder", { title: post.title }),
          layout: forcedFull ? "full" : layout,
          highlightMessageId: highlightId,
          onHighlightHandled: () => setHighlightId(null),
        }}
        origin={null}
        controller={controller}
        currentUser={currentUser}
        serverId={serverId}
        parentChannelName={forumName}
        canModerate={isStaff}
        canSend={canSend}
        blockedAuthorIds={blockedAuthorIds}
        mentionCandidates={mentionCandidates}
        isLoading={loading}
        showLinkEmbeds={showLinkEmbeds}
        onClose={onClose}
        onReportMessage={onReportMessage}
        authors={authors}
        authorsComplete={authorsComplete}
        roles={roles}
        unreadSince={unreadSince}
        onForward={onForward}
        onMarkRead={() => void markRead(postId)}
        slashContext={slashContext}
      />
      <EditTagsDialog
        open={editTagsOpen}
        tags={tags}
        tagsStatus={tagsStatus}
        requireTag={requireTag}
        current={post.tagIds}
        isStaff={isStaff}
        canManageTags={canManageTags}
        onRefresh={onRefreshTags}
        onRetry={onRetryTags}
        onOpenSettings={onOpenTagSettings}
        onClose={() => setEditTagsOpen(false)}
        onSave={(tagIds) => {
          setEditTagsOpen(false);
          void patch({ tagIds }, { ...post, tagIds });
        }}
      />
      <ConfirmDialog
        open={deleteOpen}
        title={t("forum.delete.title")}
        description={
          post.replyCount === 0
            ? t("forum.delete.body_zero")
            : t("forum.delete.body", { count: post.replyCount })
        }
        confirmLabel={t("forum.delete")}
        onConfirm={() => void confirmDelete()}
        onClose={() => setDeleteOpen(false)}
      />
    </>
  );
}

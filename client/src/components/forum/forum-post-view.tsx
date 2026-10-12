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
  RotateCcw,
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
  setForumPostFollow,
  updateForumPost,
  type ForumTagsStatus,
} from "@/lib/forum-api";
import { useTranslation } from "@/lib/i18n";
import type { MentionCandidate } from "@/lib/mention-autocomplete";
import { backfillForLanding } from "@/lib/forum-landing";
import { forgetCursorRead, readCursorOnce } from "@/lib/forum-visit";
import { findFirstUnreadMessageId } from "@/lib/unread-divider";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ForumTagList } from "./forum-post-card";

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
          <Button disabled={shown.length === 0} onClick={() => onSave(picked)}>
            {t("forum.edit.save")}
          </Button>
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
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-[background-color,border-color,color,transform] duration-[var(--duration-fast)] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50 max-sm:h-11",
                on
                  ? "border-transparent bg-accent-soft font-semibold text-on-accent-soft"
                  : "border-border text-text-secondary hover:bg-surface-2",
              )}
            >
              {tag.emoji && <span aria-hidden>{tag.emoji}</span>}
              {tag.name}
              {on && <Check className="h-3.5 w-3.5" aria-hidden />}
            </button>
          );
        })}
      </div>
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
  return (
    <section
      aria-label={t("forum.solution.title")}
      data-forum-solution={answer.messageId}
      className={cn(
        "animate-pop-in rounded-[var(--radius-card)] bg-success-soft text-on-success-soft",
        compact ? "mx-3 mb-2 mt-2 px-3 py-2 sm:mx-4" : "mx-3 my-2 px-3.5 py-3 sm:mx-5",
      )}
    >
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide">
        <CircleCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {t("forum.solution.title")}
        {markedBy && (
          <span className="min-w-0 truncate font-normal normal-case tracking-normal opacity-80">
            · {markedBy}
          </span>
        )}
      </p>
      {!compact && (
        <p className="mt-1.5 line-clamp-2 text-sm">
          {answer.deleted ? (
            <span className="italic">{t("forum.solution.deleted")}</span>
          ) : (
            <>
              <span className="font-semibold">
                {answer.authorName ?? t("forum.deletedAuthor")}
              </span>{" "}
              {answer.excerpt}
            </>
          )}
        </p>
      )}
      {!answer.deleted && (
        <button
          type="button"
          onClick={onJump}
          className="mt-1.5 inline-flex items-center gap-1 rounded-[var(--radius-control)] text-xs font-semibold underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {t("forum.solution.jump")}
          <ArrowDown className="h-3 w-3" aria-hidden />
        </button>
      )}
    </section>
  );
}

/** "23 RESPOSTAS" and a rule: where the question ends and the replies begin. */
function RepliesDivider({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <div
      className="mx-4 mb-1 mt-3 flex items-center gap-3 sm:mx-5"
      data-forum-replies-divider=""
    >
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.12em] tabular-nums text-text-tertiary">
        {t("forum.post.repliesDivider", { count })}
      </span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

export function ForumPostView({
  post,
  forumName,
  serverId,
  tags,
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
        notify(t("forum.saveFailed"));
      }
    },
    [post, postId, onPostChange, notify, onShowPinned, t],
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
  // toggle, and nobody to send to the settings, it would open an empty box.
  const canEditTags =
    tagsStatus !== "ready" ||
    canManageTags ||
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

  const hasHeaderChips =
    Boolean(post.resolvedAt || post.lockedAt || post.pinnedAt) ||
    post.tagIds.length > 0 ||
    (canEdit && tags.length > 0);

  const topBar = (
      <div className="flex h-12 items-center gap-1 px-2 sm:px-3">
        {(layout === "full" || forcedFull) && (
          <PostIconButton label={t("forum.post.back")} onClick={onClose}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </PostIconButton>
        )}
        <div className="relative min-w-0 flex-1 self-stretch">
          <p
            className={cn(
              "absolute inset-0 flex items-center gap-1.5 px-1 text-xs text-text-tertiary transition-[opacity,transform] duration-[var(--duration-base)] ease-[var(--ease-standard)] motion-reduce:transition-none",
              titleInBar && "pointer-events-none -translate-y-1 opacity-0",
            )}
            aria-hidden={titleInBar || undefined}
          >
            <MessagesSquare className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate font-semibold text-text-secondary">{forumName}</span>
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
        <span className="max-sm:hidden">
          <PostIconButton label={t("forum.post.copyLink")} onClick={() => void copyLink()}>
            <Link2 className="h-4 w-4" aria-hidden />
          </PostIconButton>
        </span>
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

  const titleBlock = (
      <div
        ref={titleBlockRef}
        className={cn("px-4 pb-3 sm:px-4", isPhone && "border-b border-border/60 pb-4")}
      >
        {editingTitle ? (
          <input
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
            className="w-full rounded-[var(--radius-control)] border border-border bg-surface-0 px-2 py-1 font-display text-[21px] font-bold leading-7 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          />
        ) : (
          <h2
            className={cn(
              "group/title font-display text-[21px] font-bold leading-7 text-text",
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
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {post.resolvedAt && (
            <Badge variant="success" icon={CheckCircle2}>
              {t("forum.badge.resolved")}
            </Badge>
          )}
          {post.lockedAt && (
            <Badge variant="neutral" icon={Lock}>
              {t("forum.badge.locked")}
            </Badge>
          )}
          {post.pinnedAt && (
            <Badge variant="accent" icon={Pin}>
              {t("forum.badge.pinned")}
            </Badge>
          )}
          <ForumTagList tagIds={post.tagIds} tagsById={tagsById} max={FORUM_MAX_TAGS_PER_POST} />
          {canEdit && tags.length > 0 && post.tagIds.length === 0 && (
            // No tags yet: a lone pencil read as "edit the title" or as
            // nothing at all (forum QA P12). Say what it adds.
            <button
              type="button"
              onClick={() => setEditTagsOpen(true)}
              data-forum-add-tags=""
              className="inline-flex h-5 items-center gap-1 rounded-full border border-dashed border-border-strong px-2 text-[11px] text-text-tertiary transition-colors duration-[var(--duration-fast)] hover:border-text-tertiary hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:h-9 max-sm:px-3 max-sm:text-xs"
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
                className="grid h-6 w-6 place-items-center rounded-[var(--radius-control)] text-text-tertiary hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:h-9 max-sm:w-9"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
          )}
          {/* Right after the status and tags, not pushed to the far edge: on
              a post with no tags, or a pane as wide as the screen, the line
              floated alone on the right and read as belonging to nothing. */}
          <span
            className={cn(
              "text-xs tabular-nums text-text-tertiary max-sm:hidden",
              hasHeaderChips &&
                "before:mr-1.5 before:text-text-tertiary/60 before:content-['·']",
            )}
          >
            {replyLine}
          </span>
        </div>
        <div className="mt-3 flex items-center gap-1.5">
          {followSupported && following !== null && (
            <Button
              size="sm"
              variant={following ? "secondary" : "ghost"}
              onClick={() => void toggleFollow()}
              disabled={followBusy}
              aria-pressed={following}
              className="gap-1.5 max-sm:h-11"
            >
              {following ? (
                <Bell className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <BellOff className="h-3.5 w-3.5" aria-hidden />
              )}
              {following ? t("forum.following") : t("forum.follow")}
            </Button>
          )}
          {canEdit && (
            <Button
              size="sm"
              variant="ghost"
              onClick={toggleResolved}
              className="gap-1.5 max-sm:h-11"
              data-forum-resolve={post.resolvedAt ? "reopen" : "resolve"}
            >
              {post.resolvedAt ? (
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
              )}
              {post.resolvedAt ? t("forum.reopen") : t("forum.resolve")}
            </Button>
          )}
          <span className="ml-auto max-sm:hidden">
            <Menu items={menuItems} align="end">
              <button
                type="button"
                aria-label={t("forum.post.menu")}
                data-forum-post-menu=""
                className="grid h-8 w-8 place-items-center rounded-[var(--radius-control)] text-text-tertiary hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden />
              </button>
            </Menu>
          </span>
        </div>
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
          {post.replyCount > 0 && <RepliesDivider count={post.replyCount} />}
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

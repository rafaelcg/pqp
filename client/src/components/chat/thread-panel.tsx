import {
  THREAD_AUTO_ARCHIVE_DAYS,
  type ThreadSummary,
} from "@pqp/shared";
import { Archive, ChevronLeft, MessageSquareText, X } from "lucide-react";
import { useRef, useState } from "react";
import {
  MessageComposer,
  type ComposerSlashContext,
} from "@/components/chat/message-composer";
import {
  MessageList,
  type MessageAuthorInfo,
  type MessageRoleColor,
} from "@/components/chat/message-list";
import { RightColumnTabs } from "@/components/chat/right-column-tabs";
import { threadChipLabel } from "@/components/chat/thread-chip";
import type { ChatController, ChatMessage } from "@/hooks/use-chat";
import { findLastOwnEditableMessage } from "@/lib/edit-last-message";
import { useTranslation } from "@/lib/i18n";
import type { MentionCandidate } from "@/lib/mention-autocomplete";
import { cn, formatDayLabel } from "@/lib/utils";

/**
 * The thread's own conversation: a side panel on desktop, the whole viewport
 * on mobile. Everything inside is the ordinary message machinery pointed at
 * the thread's channel id — the `controller` prop is a second
 * `createChatController` running on the WS `thread-join` slot, so this panel
 * and the parent channel both stay live at once.
 *
 * Docked as a sibling of the chat column on desktop (the same slot the
 * member list uses), full viewport on mobile. Overlaying it on the parent
 * while the roster stayed open is what left a long QG thread unreadable.
 */

interface ThreadPanelProps {
  thread: ThreadSummary;
  /** The origin message, when it is on hand — the parent view usually has it. */
  origin: ChatMessage | null;
  /** The thread's own chat controller (THREAD_CHANNEL_FRAMES). */
  controller: ChatController;
  currentUser: {
    id: string;
    displayName: string;
    username: string | null;
    tag: string | null;
    avatarUrl: string | null;
  } | null;
  serverId: string | null;
  /** The text channel this thread hangs off, for the breadcrumb and back bar. */
  parentChannelName: string | null;
  /** Swap the right column to the roster, keeping this thread one tap away. */
  onShowMembers?: (() => void) | null;
  /** Roster size for the switch label. */
  memberCount?: number;
  canModerate: boolean;
  blockedAuthorIds: ReadonlySet<string>;
  mentionCandidates: MentionCandidate[];
  isLoading: boolean;
  showLinkEmbeds: boolean;
  onClose: () => void;
  onReportMessage?: (message: ChatMessage) => void;
  authors?: ReadonlyMap<string, MessageAuthorInfo>;
  roles?: readonly MessageRoleColor[];
  unreadHeld?: boolean;
  unreadSince?: string | null;
  onForward?: (message: ChatMessage) => void;
  onMarkUnread?: (message: ChatMessage) => void;
  onMarkRead?: () => void;
  onSent?: () => void;
  slashContext?: Omit<
    ComposerSlashContext,
    "sendChance" | "sendPoll" | "canPurgeMessages" | "openPurgeDialog"
  >;
}

export function ThreadPanel({
  thread,
  origin,
  controller,
  currentUser,
  serverId,
  parentChannelName,
  onShowMembers = null,
  memberCount = 0,
  canModerate,
  blockedAuthorIds,
  mentionCandidates,
  isLoading,
  showLinkEmbeds,
  onClose,
  onReportMessage,
  authors,
  roles,
  unreadHeld,
  unreadSince = null,
  onForward,
  onMarkUnread,
  onMarkRead,
  onSent,
  slashContext,
}: ThreadPanelProps) {
  const { t } = useTranslation();
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [editMessageId, setEditMessageId] = useState<string | null>(null);

  /* Swipe right to close, the gesture the full-viewport mobile layout implies.
     Deliberately crude: one touch, mostly horizontal, far enough to be meant.
     There is no shared gesture helper in the app to reach for. */
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  /**
   * What the quote above the thread says. A message with no text is not a
   * blank quote: a poll is its question, an upload is its file. The thread's
   * own name is never used here — it is already the header's title.
   */
  const originText = origin
    ? origin.body.trim().length > 0
      ? origin.body
      : origin.poll
        ? origin.poll.question
        : origin.attachments.length > 0
          ? t("thread.originAttachment", { count: origin.attachments.length })
          : null
    : thread.rootMessageId === null
      ? t("thread.originDeleted")
      : null;
  // A thread born from a message is NAMED after that message, so a quote
  // saying the same words as the title one row above it is the repetition
  // this panel exists to stop having.
  const originLine = originText === thread.name ? null : originText;

  return (
    <aside
      aria-label={`${t("thread.title")}: ${thread.name}`}
      onTouchStart={(event) => {
        const touch = event.touches[0];
        touchStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
      }}
      onTouchEnd={(event) => {
        const start = touchStart.current;
        const touch = event.changedTouches[0];
        touchStart.current = null;
        if (!start || !touch) {
          return;
        }
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        if (dx > 80 && Math.abs(dy) < 60) {
          onClose();
        }
      }}
      className="flex h-full min-h-0 w-full shrink-0 flex-col border-border/60 bg-surface-0 max-md:fixed max-md:inset-0 max-md:z-30 max-md:shadow-[var(--shadow-2)] md:w-[26rem] md:border-l"
    >
      {/* The header's job is orientation: which channel this hangs off, and a
          way back to it. The name is second, not first, because a thread born
          from a message carries that message AS its name — printing it loudest
          is what made one sentence appear four times on one screen. */}
      <header className="shrink-0 border-b border-border/60">
        {/* Mobile: the panel is the whole viewport, so the way out is a back
            bar naming what you left, not a ✕ in a corner. */}
        <button
          type="button"
          onClick={onClose}
          className="flex min-h-11 w-full items-center gap-1 px-2 text-sm font-semibold text-accent hover:bg-surface-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring md:hidden"
        >
          <ChevronLeft className="h-5 w-5 shrink-0" aria-hidden />
          <span className="truncate">
            {parentChannelName ? `#${parentChannelName}` : t("thread.back")}
          </span>
        </button>

        {onShowMembers && (
          <div className="px-3 pt-2 max-md:hidden">
            <RightColumnTabs
              active="thread"
              membersLabel={t("memberList.sectionHeading", {
                label: t("memberList.title"),
                count: memberCount,
              })}
              threadLabel={t("thread.title")}
              onSelectMembers={onShowMembers}
              onSelectThread={() => {}}
            />
          </div>
        )}

        <div className="px-3 pb-2 pt-2 max-md:pt-0">
          <div className="flex items-center gap-1.5 max-md:hidden">
            {thread.archived ? (
              <Archive
                className="h-3.5 w-3.5 shrink-0 text-text-tertiary"
                aria-hidden
              />
            ) : (
              <MessageSquareText
                className="h-3.5 w-3.5 shrink-0 text-accent"
                aria-hidden
              />
            )}
            <p className="min-w-0 truncate text-[11px] text-text-tertiary">
              {parentChannelName
                ? t("thread.inChannel", { channel: parentChannelName })
                : t("thread.title")}
            </p>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("thread.close")}
              className="ml-auto shrink-0 rounded-[var(--radius-control)] p-1 text-text-tertiary hover:bg-surface-2 hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="truncate font-display text-sm font-bold text-text">
            {thread.name}
          </p>
          <p className="truncate text-[11px] text-text-tertiary">
            {[
              threadChipLabel(t, thread.replyCount),
              // Who started it rides the quote below, attached to the message
              // it names — unless there is no quote, because the quote would
              // have repeated this header's title. Then it belongs here, so
              // the panel never fails to say whose message this grew out of.
              origin && originLine === null ? origin.authorName : null,
              origin ? formatDayLabel(origin.createdAt) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            {thread.archived &&
              ` · ${t("thread.archived")} — ${t("thread.archivedHint", {
                days: THREAD_AUTO_ARCHIVE_DAYS,
              })}`}
          </p>
        </div>
      </header>

      {/* The message the thread grew out of — context, not part of the
          thread's own history, so it is a quote and not a second message.
          Deleted origins say so instead of vanishing.

          Nothing at all when the origin is simply not on hand: the panel can
          be opened from the sidebar without the parent channel's page having
          been read, and the old fallback printed the thread's NAME here,
          which is the header's line repeated one row below it. */}
      {originLine !== null && (
        <div className="shrink-0 border-b border-border/60 px-3 py-2">
          <p
            className={cn(
              "text-xs text-text-tertiary",
              origin ? "border-l-2 border-border-strong pl-2" : "italic",
            )}
          >
            {/* Named, like every other quoted message in the app: a quote
                with no author is the one thing a reply quote never is. */}
            {origin && (
              <span className="font-medium text-accent">
                {origin.authorName}
              </span>
            )}{" "}
            <span className="line-clamp-3 whitespace-pre-wrap break-words">
              {originLine}
            </span>
          </p>
        </div>
      )}

      <MessageList
        messages={controller.getMessages()}
        currentUserId={currentUser?.id ?? null}
        currentUsername={currentUser?.username ?? null}
        serverId={serverId}
        channelId={thread.channelId}
        isLoading={isLoading}
        hasMore={controller.hasMoreHistory()}
        hasNewer={controller.hasNewerHistory()}
        isLoadingOlder={controller.isLoadingOlder()}
        isLoadingNewer={controller.isLoadingNewer()}
        typingUsers={controller.getTypingUsers()}
        canModerate={canModerate}
        blockedAuthorIds={blockedAuthorIds}
        onReplyTo={setReplyTarget}
        onToggleReaction={(messageId, emoji) =>
          controller.toggleReaction(messageId, emoji)
        }
        onVotePoll={(messageId, optionId) =>
          controller.votePoll(messageId, optionId)
        }
        onClosePoll={(messageId) => controller.closePoll(messageId)}
        onLoadOlder={() => controller.loadOlder()}
        onLoadNewer={() => controller.loadNewer()}
        onJumpToPresent={() => controller.resetToTail()}
        onEditMessage={(messageId, body) =>
          controller.editMessage(messageId, body)
        }
        onDeleteMessage={(messageId) => controller.deleteMessage(messageId)}
        onPinMessage={(messageId) => controller.pinMessage(messageId)}
        onUnpinMessage={(messageId) => controller.unpinMessage(messageId)}
        onReportMessage={onReportMessage}
        onRetryMessage={(nonce) => controller.retryMessage(nonce)}
        onDiscardMessage={(nonce) => controller.discardMessage(nonce)}
        showLinkEmbeds={showLinkEmbeds}
        authors={authors}
        roles={roles}
        unreadHeld={unreadHeld}
        unreadSince={unreadSince}
        editMessageId={editMessageId}
        onEditMessageHandled={() => setEditMessageId(null)}
        onForward={onForward}
        onMarkUnread={onMarkUnread}
        onMarkRead={onMarkRead}
      />

      <MessageComposer
        // Remount per thread, same reason the main composer keys by channel.
        key={thread.channelId}
        onSend={(body, attachments) => {
          controller.sendMessage(body, replyTarget, attachments);
          setReplyTarget(null);
          onSent?.();
        }}
        onTyping={() => controller.notifyTyping()}
        channelId={thread.channelId}
        replyTarget={replyTarget}
        onCancelReply={() => setReplyTarget(null)}
        mentionCandidates={mentionCandidates}
        onEditLastOwn={() => {
          const last = findLastOwnEditableMessage(
            controller.getMessages(),
            currentUser?.id ?? null,
          );
          if (!last) {
            return false;
          }
          setEditMessageId(last.id);
          return true;
        }}
        disabled={isLoading}
        slowModeUntil={controller.getSlowModeHeldUntil() || null}
        placeholder={t("thread.placeholder")}
        slashContext={
          slashContext
            ? {
                ...slashContext,
                sendChance: (request) => controller.sendChance(request),
                sendPoll: (request) => controller.sendPoll(request),
                // Purging is a channel-wide moderation action with its own
                // confirm dialog on the channel list; there is no "purge this
                // thread" concept, so /clear stays off in here rather than
                // quietly acting on the parent channel.
                canPurgeMessages: false,
                openPurgeDialog: () => {},
              }
            : undefined
        }
      />
    </aside>
  );
}

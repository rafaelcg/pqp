import {
  THREAD_AUTO_ARCHIVE_DAYS,
  type ThreadSummary,
} from "@pqp/shared";
import { Archive, MessageSquareText, X } from "lucide-react";
import { useState } from "react";
import { MessageComposer } from "@/components/chat/message-composer";
import { MessageList } from "@/components/chat/message-list";
import { threadChipLabel } from "@/components/chat/thread-chip";
import type { ChatController, ChatMessage } from "@/hooks/use-chat";
import { useTranslation } from "@/lib/i18n";
import type { MentionCandidate } from "@/lib/mention-autocomplete";

/**
 * The thread's own conversation: a side panel on desktop, the whole viewport
 * on mobile. Everything inside is the ordinary message machinery pointed at
 * the thread's channel id — the `controller` prop is a second
 * `createChatController` running on the WS `thread-join` slot, so this panel
 * and the parent channel both stay live at once.
 *
 * Overlaid on the chat pane (absolute, right-anchored) rather than splitting
 * it: the parent stays visible on wide screens, and on a phone the panel is
 * simply the screen, which is the "full view on mobile" behaviour for free.
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
  canModerate: boolean;
  blockedAuthorIds: ReadonlySet<string>;
  mentionCandidates: MentionCandidate[];
  isLoading: boolean;
  showLinkEmbeds: boolean;
  onClose: () => void;
  onReportMessage?: (message: ChatMessage) => void;
}

export function ThreadPanel({
  thread,
  origin,
  controller,
  currentUser,
  serverId,
  canModerate,
  blockedAuthorIds,
  mentionCandidates,
  isLoading,
  showLinkEmbeds,
  onClose,
  onReportMessage,
}: ThreadPanelProps) {
  const { t } = useTranslation();
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);

  return (
    <aside
      aria-label={`${t("thread.title")}: ${thread.name}`}
      className="absolute inset-0 z-20 flex flex-col border-ink-4/60 bg-ink shadow-xl md:left-auto md:w-[26rem] md:border-l"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-ink-4/60 px-3">
        {thread.archived ? (
          <Archive className="h-4 w-4 shrink-0 text-paper-muted" aria-hidden />
        ) : (
          <MessageSquareText
            className="h-4 w-4 shrink-0 text-signal"
            aria-hidden
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-sm font-bold text-paper">
            {thread.name}
          </p>
          <p className="truncate text-[11px] text-paper-muted">
            {threadChipLabel(t, thread.replyCount)}
            {thread.archived &&
              ` · ${t("thread.archived")} — ${t("thread.archivedHint", {
                days: THREAD_AUTO_ARCHIVE_DAYS,
              })}`}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("thread.close")}
          className="rounded-md p-1.5 text-paper-muted hover:bg-ink-3 hover:text-paper"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {/* The message the thread grew out of — context, not part of the
          thread's own history. Deleted origins say so instead of vanishing. */}
      <div className="shrink-0 border-b border-ink-4/60 px-3 py-2">
        {origin ? (
          <p className="text-xs text-paper-muted">
            <span className="font-semibold text-paper">
              {origin.authorName}
            </span>{" "}
            <span className="whitespace-pre-wrap break-words">
              {origin.body}
            </span>
          </p>
        ) : (
          <p className="text-xs italic text-paper-muted">
            {thread.rootMessageId === null
              ? t("thread.originDeleted")
              : thread.name}
          </p>
        )}
      </div>

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
        // Deliberately no onStartThread / onOpenThread: threads do not nest.
      />

      <MessageComposer
        // Remount per thread, same reason the main composer keys by channel.
        key={thread.channelId}
        onSend={(body, attachments) => {
          controller.sendMessage(body, replyTarget, attachments);
          setReplyTarget(null);
        }}
        onTyping={() => controller.notifyTyping()}
        channelId={thread.channelId}
        replyTarget={replyTarget}
        onCancelReply={() => setReplyTarget(null)}
        mentionCandidates={mentionCandidates}
        disabled={isLoading}
        placeholder={t("thread.placeholder")}
      />
    </aside>
  );
}

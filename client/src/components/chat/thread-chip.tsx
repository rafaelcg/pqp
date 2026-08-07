import { THREAD_AUTO_ARCHIVE_DAYS, type ThreadSummary } from "@pqp/shared";
import { Archive, MessageSquareText } from "lucide-react";
import { useTranslation, type Translator } from "@/lib/i18n";
import { cn, formatTime, isSameDay } from "@/lib/utils";

/**
 * The affordance on an origin message: reply count, freshness, archived
 * state, and one click to open the panel. Content-free by design — the chip
 * is fed by `thread-update` frames and history hydration, neither of which
 * ever carries a thread message body into the parent channel.
 */

/** The chip's one-line label, exported for tests. */
export function threadChipLabel(t: Translator["t"], replyCount: number): string {
  if (replyCount === 0) {
    return t("thread.noReplies");
  }
  return t(replyCount === 1 ? "thread.replies.one" : "thread.replies.many", {
    count: replyCount,
  });
}

interface ThreadChipProps {
  thread: ThreadSummary;
  /** The thread has activity this reader has not opened yet. */
  unread: boolean;
  /** This thread is the one the panel is currently showing. */
  isOpen: boolean;
  onOpen: () => void;
  /** -1 outside the active row — see `controlTabIndex` in MessageRow. */
  tabIndex: number;
}

export function ThreadChip({
  thread,
  unread,
  isOpen,
  onOpen,
  tabIndex,
}: ThreadChipProps) {
  const { t } = useTranslation();
  const replies = threadChipLabel(t, thread.replyCount);
  const lastActivity = new Date(thread.lastActivityAt);

  return (
    <button
      type="button"
      tabIndex={tabIndex}
      onClick={onOpen}
      aria-label={t("thread.chip.aria", { name: thread.name, replies })}
      aria-expanded={isOpen}
      className={cn(
        "mt-1.5 flex w-fit max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
        isOpen
          ? "border-signal/50 bg-signal/10 text-signal"
          : "border-ink-4 bg-ink-3/60 text-paper-muted hover:border-signal/40 hover:text-paper",
      )}
    >
      {thread.archived ? (
        <Archive className="h-3.5 w-3.5 shrink-0" aria-hidden />
      ) : (
        <MessageSquareText className="h-3.5 w-3.5 shrink-0" aria-hidden />
      )}
      <span className="min-w-0 truncate font-medium text-signal">
        {thread.name}
      </span>
      <span className="shrink-0 tabular-nums">{replies}</span>
      {thread.archived ? (
        <span
          className="shrink-0 rounded bg-ink-4 px-1 py-px text-[10px] uppercase tracking-wide"
          title={t("thread.archivedHint", { days: THREAD_AUTO_ARCHIVE_DAYS })}
        >
          {t("thread.archived")}
        </span>
      ) : (
        thread.replyCount > 0 && (
          <time
            className="shrink-0 text-[10px] text-paper-muted"
            dateTime={thread.lastActivityAt}
          >
            {isSameDay(thread.lastActivityAt, new Date().toISOString())
              ? formatTime(thread.lastActivityAt)
              : lastActivity.toLocaleDateString()}
          </time>
        )
      )}
      {unread && !isOpen && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal"
          aria-hidden
        />
      )}
    </button>
  );
}

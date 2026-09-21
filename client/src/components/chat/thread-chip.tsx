import {
  deriveThreadName,
  THREAD_AUTO_ARCHIVE_DAYS,
  type ThreadSummary,
} from "@pqp/shared";
import { Archive, MessageSquareText } from "lucide-react";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation, type Translator } from "@/lib/i18n";
import { cn, formatFullTimestamp, formatRelativeShort } from "@/lib/utils";

/**
 * The affordance on an origin message: reply count, freshness, archived
 * state, and one click to open the panel. Content-free by design — the chip
 * is fed by `thread-update` frames and history hydration, neither of which
 * ever carries a thread message body into the parent channel.
 *
 * It draws the thread's NAME only when somebody chose that name. A thread
 * born from a message takes its name from that message (`deriveThreadName`),
 * so printing it here reprints the sentence sitting one line above, which is
 * how the same words ended up on screen four times.
 */

/** The chip's one-line label, exported for tests. */
export function threadChipLabel(t: Translator["t"], replyCount: number): string {
  if (replyCount === 0) {
    return t("thread.noReplies");
  }
  return t("thread.replies", { count: replyCount });
}

/** True when the name is still the one derived from the origin message. */
export function threadNameIsDerived(
  thread: ThreadSummary,
  originBody: string | null,
): boolean {
  if (originBody === null) {
    return false;
  }
  return thread.name === deriveThreadName(originBody);
}

interface ThreadChipProps {
  thread: ThreadSummary;
  /** The origin message's body, to tell a derived name from a chosen one. */
  originBody: string | null;
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
  originBody,
  unread,
  isOpen,
  onOpen,
  tabIndex,
}: ThreadChipProps) {
  const { t } = useTranslation();
  const replies = threadChipLabel(t, thread.replyCount);
  const showName = !threadNameIsDerived(thread, originBody);

  return (
    <button
      type="button"
      tabIndex={tabIndex}
      onClick={onOpen}
      aria-label={t("thread.chip.aria", { name: thread.name, replies })}
      aria-expanded={isOpen}
      className={cn(
        // A left rule rather than a bordered pill: the thread hangs off the
        // message above it and should not read as a second card.
        "mt-1 flex w-fit max-w-full items-center gap-2 border-l-2 py-0.5 pl-2.5 pr-2 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
        isOpen
          ? "border-accent bg-surface-2 text-text"
          : "border-accent/60 text-text-tertiary hover:bg-surface-1 hover:text-text",
      )}
    >
      {thread.archived ? (
        <Archive className="h-3.5 w-3.5 shrink-0" aria-hidden />
      ) : thread.participants.length > 0 ? (
        // Who is in there is the thing that makes a side conversation worth
        // opening, and the chip used to say nothing about it.
        <span className="flex shrink-0" aria-hidden>
          {thread.participants.map((person, index) => (
            <UserAvatar
              key={person.id}
              name={person.displayName}
              avatarUrl={person.avatarUrl}
              rounded="full"
              className={cn(
                "h-4 w-4 ring-2 ring-surface-0",
                index > 0 && "-ml-1.5",
              )}
              fallbackClassName="bg-surface-3 text-[8px] text-text-secondary"
            />
          ))}
        </span>
      ) : (
        <MessageSquareText
          className="h-3.5 w-3.5 shrink-0 text-accent"
          aria-hidden
        />
      )}
      {showName && (
        <span className="min-w-0 truncate font-medium text-accent">
          {thread.name}
        </span>
      )}
      <span className="shrink-0 font-medium tabular-nums text-accent">
        {replies}
      </span>
      {thread.archived ? (
        <span
          className="shrink-0 text-text-tertiary"
          title={t("thread.archivedHint", { days: THREAD_AUTO_ARCHIVE_DAYS })}
        >
          · {t("thread.archived")}
        </span>
      ) : (
        thread.replyCount > 0 && (
          <time
            className="shrink-0 text-text-tertiary"
            dateTime={thread.lastActivityAt}
            title={formatFullTimestamp(thread.lastActivityAt)}
          >
            · {formatRelativeShort(thread.lastActivityAt)}
          </time>
        )
      )}
      {unread && !isOpen && !thread.archived && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
          aria-hidden
        />
      )}
    </button>
  );
}

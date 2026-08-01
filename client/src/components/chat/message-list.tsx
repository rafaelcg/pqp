import type { MessageReaction } from "@pqp/shared";
import {
  AlertCircle,
  ArrowDown,
  CornerUpLeft,
  ImagePlay,
  Loader2,
  Pencil,
  Play,
  Reply,
  SmilePlus,
  Trash2,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { EmojiPickerPanel } from "@/components/chat/emoji-picker";
import {
  ContextMenu,
  type ContextMenuItemDef,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import type { ChatMessage, TypingUser } from "@/hooks/use-chat";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { messageRoutePath } from "@/lib/app-route";
import { QUICK_REACTIONS } from "@/lib/emoji-shortcodes";
import { gifMessageMedia, type GifMedia } from "@/lib/gif-media";
import { remarkMentions } from "@/lib/remark-mentions";
import {
  cn,
  formatDayLabel,
  formatFullTimestamp,
  formatTime,
  isSameDay,
} from "@/lib/utils";
import { MessageListSkeleton } from "@/components/ui/skeleton";

/** Consecutive messages from one author within this window render as one block. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;
/** How close to the bottom still counts as "following the conversation". */
const STICKY_THRESHOLD_PX = 120;
/** Distance from the top that triggers loading older history. */
const LOAD_MORE_THRESHOLD_PX = 240;
/** How long a jumped-to message stays lit. */
const HIGHLIGHT_MS = 2_000;
/** How long the "not loaded" answer to a jump stays on screen. */
const JUMP_NOTICE_MS = 3_000;

interface MessageListProps {
  messages: ChatMessage[];
  currentUserId: string | null;
  currentUsername?: string | null;
  serverId?: string | null;
  channelId?: string | null;
  isLoading?: boolean;
  hasMore?: boolean;
  isLoadingOlder?: boolean;
  typingUsers?: TypingUser[];
  canModerate?: boolean;
  /** Scrolled into view and flashed once it renders. */
  highlightMessageId?: string | null;
  onHighlightHandled?: () => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onLoadOlder?: () => Promise<number>;
  onEditMessage?: (messageId: string, body: string) => Promise<void>;
  onDeleteMessage?: (messageId: string) => Promise<void>;
  onRetryMessage?: (nonce: string) => void;
  onDiscardMessage?: (nonce: string) => void;
  onReplyTo?: (message: ChatMessage) => void;
}

interface Row {
  message: ChatMessage;
  startsGroup: boolean;
  dayLabel: string | null;
}

function buildRows(messages: ChatMessage[]): Row[] {
  return messages.map((message, index) => {
    const previous = index > 0 ? messages[index - 1] : undefined;
    const newDay =
      !previous || !isSameDay(previous.createdAt, message.createdAt);
    const withinWindow =
      previous !== undefined &&
      previous.authorId === message.authorId &&
      new Date(message.createdAt).getTime() -
        new Date(previous.createdAt).getTime() <
        GROUP_WINDOW_MS;

    return {
      message,
      // A reply always opens a block: its quote header needs the author line
      // above it to read as an answer rather than a stray fragment.
      startsGroup: newDay || !withinWindow || Boolean(message.replyTo),
      dayLabel: newDay ? formatDayLabel(message.createdAt) : null,
    };
  });
}

export function MessageList({
  messages,
  currentUserId,
  currentUsername = null,
  serverId = null,
  channelId = null,
  isLoading = false,
  hasMore = false,
  isLoadingOlder = false,
  typingUsers = [],
  canModerate = false,
  highlightMessageId = null,
  onHighlightHandled,
  onToggleReaction,
  onLoadOlder,
  onEditMessage,
  onDeleteMessage,
  onRetryMessage,
  onDiscardMessage,
  onReplyTo,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [pickerMessageId, setPickerMessageId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isPinned, setIsPinned] = useState(true);
  const [missedCount, setMissedCount] = useState(0);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [jumpNotice, setJumpNotice] = useState(false);

  const isPinnedRef = useRef(true);
  isPinnedRef.current = isPinned;
  /** Row elements by message id, so a jump can find its target. */
  const rowNodes = useRef(new Map<string, HTMLElement>());
  const flashTimer = useRef<number | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const highlightRef = useRef<string | null>(highlightMessageId);
  highlightRef.current = highlightMessageId;
  const lastCountRef = useRef(messages.length);
  /** Scroll height captured before prepending history, to keep the view still. */
  const restoreRef = useRef<{ height: number; top: number } | null>(null);
  /**
   * How many of the newly added messages came from loading history rather than
   * arriving live. React flushes layout effects before passive ones, so the
   * "new messages" effect cannot infer this from restoreRef — it has already
   * been cleared by then.
   */
  const prependedRef = useRef(0);

  const rows = useMemo(() => buildRows(messages), [messages]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    bottomRef.current?.scrollIntoView({ behavior, block: "end" });
    setMissedCount(0);
  }, []);

  const registerRow = useCallback((messageId: string, node: HTMLElement | null) => {
    if (node) {
      rowNodes.current.set(messageId, node);
    } else {
      rowNodes.current.delete(messageId);
    }
  }, []);

  /**
   * Scroll a loaded message into view and light it up. Returns false when the
   * message is not in the loaded page — history around an arbitrary message is
   * not fetchable yet, so the honest answer is to say so rather than to guess.
   */
  const jumpToMessage = useCallback((messageId: string): boolean => {
    const node = rowNodes.current.get(messageId);
    if (!node) {
      setJumpNotice(true);
      if (noticeTimer.current) {
        window.clearTimeout(noticeTimer.current);
      }
      noticeTimer.current = window.setTimeout(
        () => setJumpNotice(false),
        JUMP_NOTICE_MS,
      );
      return false;
    }
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashId(messageId);
    if (flashTimer.current) {
      window.clearTimeout(flashTimer.current);
    }
    flashTimer.current = window.setTimeout(() => setFlashId(null), HIGHLIGHT_MS);
    return true;
  }, []);

  useEffect(
    () => () => {
      if (flashTimer.current) {
        window.clearTimeout(flashTimer.current);
      }
      if (noticeTimer.current) {
        window.clearTimeout(noticeTimer.current);
      }
    },
    [],
  );

  // A permalink target only exists once its page has rendered, so this waits a
  // frame rather than reading the ref map during the commit that requested it.
  useEffect(() => {
    if (!highlightMessageId) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      jumpToMessage(highlightMessageId);
      onHighlightHandled?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [highlightMessageId, jumpToMessage, onHighlightHandled]);

  // New content: follow it only when the reader is already at the bottom.
  // Yanking someone away from history they are reading is the classic chat bug.
  useEffect(() => {
    const added = messages.length - lastCountRef.current;
    lastCountRef.current = messages.length;

    const prepended = prependedRef.current;
    prependedRef.current = 0;
    const arrived = added - prepended;
    if (arrived <= 0) {
      return;
    }
    if (isPinnedRef.current) {
      scrollToBottom(messages.length > 60 ? "auto" : "smooth");
    } else {
      setMissedCount((count) => count + arrived);
    }
  }, [messages.length, scrollToBottom]);

  // Restore the scroll offset after older messages are prepended.
  useLayoutEffect(() => {
    const container = scrollRef.current;
    const saved = restoreRef.current;
    if (!container || !saved) {
      return;
    }
    restoreRef.current = null;
    container.scrollTop = container.scrollHeight - saved.height + saved.top;
  }, [messages.length]);

  // Channel switch: jump straight to the newest message.
  useEffect(() => {
    setIsPinned(true);
    setMissedCount(0);
    setFlashId(null);
    setJumpNotice(false);
    rowNodes.current.clear();
    lastCountRef.current = messages.length;
    requestAnimationFrame(() => {
      // A permalink opened this channel to look at one specific message —
      // slamming the view to the newest one would undo exactly that.
      if (highlightRef.current) {
        return;
      }
      scrollToBottom("auto");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  const loadOlder = useCallback(() => {
    const container = scrollRef.current;
    if (!container || !onLoadOlder || !hasMore || isLoadingOlder) {
      return;
    }
    // Captured before the request so the layout effect can pin the viewport to
    // the message the reader was looking at.
    restoreRef.current = {
      height: container.scrollHeight,
      top: container.scrollTop,
    };
    void onLoadOlder()
      .then((added) => {
        prependedRef.current += added;
        if (added === 0) {
          restoreRef.current = null;
        }
      })
      .catch(() => {
        // Leaving restoreRef set would make the layout effect fight every later
        // scroll, which reads as auto-scroll being permanently broken.
        restoreRef.current = null;
      });
  }, [hasMore, isLoadingOlder, onLoadOlder]);

  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const pinned = distanceFromBottom <= STICKY_THRESHOLD_PX;
    setIsPinned(pinned);
    if (pinned) {
      setMissedCount(0);
    }

    if (container.scrollTop <= LOAD_MORE_THRESHOLD_PX) {
      loadOlder();
    }
  }, [loadOlder]);

  if (isLoading) {
    return <MessageListSkeleton />;
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-4 sm:px-5"
      >
        {hasMore && (
          <div className="flex justify-center pb-3">
            {isLoadingOlder ? (
              <span className="flex items-center gap-2 text-xs text-paper-muted">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading older messages…
              </span>
            ) : (
              <button
                type="button"
                onClick={loadOlder}
                className="rounded-full border border-ink-4 px-3 py-1 text-xs text-paper-muted hover:text-paper"
              >
                Load older messages
              </button>
            )}
          </div>
        )}

        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          rows.map((row) => (
            <MessageRow
              key={row.message.id}
              row={row}
              currentUserId={currentUserId}
              currentUsername={currentUsername}
              serverId={serverId}
              channelId={channelId}
              canModerate={canModerate}
              isFlashing={flashId === row.message.id}
              registerRow={registerRow}
              onJumpToMessage={jumpToMessage}
              onReply={onReplyTo ? () => onReplyTo(row.message) : undefined}
              isPickerOpen={pickerMessageId === row.message.id}
              isEditing={editingId === row.message.id}
              onOpenPicker={() => setPickerMessageId(row.message.id)}
              onClosePicker={() => setPickerMessageId(null)}
              onStartEdit={() => setEditingId(row.message.id)}
              onCancelEdit={() => setEditingId(null)}
              onSubmitEdit={async (body) => {
                await onEditMessage?.(row.message.id, body);
                setEditingId(null);
              }}
              onDelete={
                onDeleteMessage
                  ? () => void onDeleteMessage(row.message.id)
                  : undefined
              }
              onToggleReaction={onToggleReaction}
              onRetry={() =>
                row.message.nonce && onRetryMessage?.(row.message.nonce)
              }
              onDiscard={() =>
                row.message.nonce && onDiscardMessage?.(row.message.nonce)
              }
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <TypingIndicator users={typingUsers} />

      {jumpNotice && (
        <p
          role="status"
          className="animate-rise absolute bottom-16 right-4 z-10 max-w-[16rem] rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-text-muted shadow-lg"
        >
          That message is older than the history loaded here — scroll up to load
          more.
        </p>
      )}

      {!isPinned && (
        <button
          type="button"
          onClick={() => scrollToBottom()}
          className="absolute bottom-4 right-4 z-10 flex items-center gap-1.5 rounded-full border border-ink-4 bg-ink-2/95 px-3 py-1.5 text-xs font-medium text-paper shadow-lg backdrop-blur transition-colors hover:border-signal/60 hover:text-signal"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          {missedCount > 0
            ? `${missedCount} new message${missedCount === 1 ? "" : "s"}`
            : "Jump to present"}
        </button>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <p className="font-display text-xl font-bold text-paper">
        Start the thread
      </p>
      <p className="max-w-xs text-sm text-paper-muted">
        Messages persist. Use <code>**bold**</code>, <code>*italic*</code>,{" "}
        <code>`code`</code>, and links. Shift+Enter adds a line.
      </p>
    </div>
  );
}

function TypingIndicator({ users }: { users: TypingUser[] }) {
  if (users.length === 0) {
    return null;
  }
  const names = users.map((user) => user.displayName);
  const label =
    names.length === 1
      ? `${names[0]} is typing`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are typing`
        : `${names.length} people are typing`;

  return (
    <p
      className="shrink-0 px-4 pb-1 text-xs text-paper-muted"
      aria-live="polite"
    >
      <span className="inline-flex items-center gap-1.5">
        <span className="flex gap-0.5">
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className="h-1 w-1 animate-bounce rounded-full bg-paper-muted"
              style={{ animationDelay: `${index * 120}ms` }}
            />
          ))}
        </span>
        {label}…
      </span>
    </p>
  );
}

/** Message body: markdown, with `@username` highlighted inside it. */
function MessageBody({
  body,
  currentUsername,
}: {
  body: string;
  currentUsername: string | null;
}) {
  const plugins = useMemo(
    // remark-breaks turns a single newline into a <br>, which is what a chat
    // message means by it — plain markdown would fold it into a space.
    () => [remarkGfm, remarkBreaks, remarkMentions(currentUsername)],
    [currentUsername],
  );

  return (
    <ReactMarkdown
      remarkPlugins={plugins}
      allowedElements={MARKDOWN_ELEMENTS}
      unwrapDisallowed
      components={MARKDOWN_COMPONENTS}
    >
      {body}
    </ReactMarkdown>
  );
}

const MARKDOWN_ELEMENTS = [
  "p",
  "span",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "a",
  "br",
  "ul",
  "ol",
  "li",
  "blockquote",
];

const MARKDOWN_COMPONENTS = {
  // Links in user content are untrusted: never hand the opener a window
  // reference, and never leak the app URL as a referrer.
  a: ({ children, href }: { children?: ReactNode; href?: string }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow ugc">
      {children}
    </a>
  ),
};

interface MessageRowProps {
  row: Row;
  currentUserId: string | null;
  currentUsername: string | null;
  serverId: string | null;
  channelId: string | null;
  canModerate: boolean;
  isFlashing: boolean;
  registerRow: (messageId: string, node: HTMLElement | null) => void;
  onJumpToMessage: (messageId: string) => boolean;
  onReply?: () => void;
  isPickerOpen: boolean;
  isEditing: boolean;
  onOpenPicker: () => void;
  onClosePicker: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (body: string) => Promise<void>;
  onDelete?: () => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onRetry: () => void;
  onDiscard: () => void;
}

const MessageRow = memo(function MessageRow({
  row,
  currentUserId,
  currentUsername,
  serverId,
  channelId,
  canModerate,
  isFlashing,
  registerRow,
  onJumpToMessage,
  onReply,
  isPickerOpen,
  isEditing,
  onOpenPicker,
  onClosePicker,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onDelete,
  onToggleReaction,
  onRetry,
  onDiscard,
}: MessageRowProps) {
  const { message, startsGroup, dayLabel } = row;
  // A body that is nothing but a GIF link is media, not prose — the URL is the
  // message, so it renders instead of the text rather than beside it.
  const gifMedia = useMemo(() => gifMessageMedia(message.body), [message.body]);
  const isMine = message.authorId === currentUserId;
  const isReal = !message.pending && !message.failed;
  const canDelete = isReal && !!onDelete && (isMine || canModerate);
  const canReply = isReal && !!onReply;

  function confirmDelete() {
    if (window.confirm("Delete this message?")) {
      onDelete?.();
    }
  }

  const items: ContextMenuItemDef[] = [
    ...(canReply
      ? [
          { id: "reply", label: "Reply", onSelect: onReply },
          { id: "sep-reply", label: "", separator: true },
        ]
      : []),
    {
      id: "copy-text",
      label: "Copy text",
      onSelect: () => void navigator.clipboard.writeText(message.body),
    },
    {
      id: "copy-id",
      label: "Copy message ID",
      onSelect: () => void navigator.clipboard.writeText(message.id),
    },
    ...(serverId && isReal
      ? [
          {
            id: "copy-link",
            label: "Copy message link",
            onSelect: () => {
              const link = `${window.location.origin}${messageRoutePath(
                serverId,
                channelId ?? message.channelId,
                message.id,
              )}`;
              void navigator.clipboard.writeText(link);
            },
          },
        ]
      : []),
    ...(isMine && isReal
      ? [
          { id: "sep-edit", label: "", separator: true },
          { id: "edit", label: "Edit message", onSelect: onStartEdit },
        ]
      : []),
    ...(canDelete
      ? [
          {
            id: "delete",
            label: "Delete message",
            danger: true,
            onSelect: confirmDelete,
          },
        ]
      : []),
    { id: "sep-quick", label: "", separator: true },
    {
      id: "add-reaction",
      label: "Add reaction",
      onSelect: onOpenPicker,
    },
    ...QUICK_REACTIONS.map((emoji) => ({
      id: `react-${emoji}`,
      label: emoji,
      onSelect: () => onToggleReaction(message.id, emoji),
    })),
  ];

  return (
    <>
      {dayLabel && (
        <div className="my-4 flex items-center gap-3" role="separator">
          <span className="h-px flex-1 bg-ink-4/60" />
          <span className="text-[11px] font-medium uppercase tracking-wider text-paper-muted">
            {dayLabel}
          </span>
          <span className="h-px flex-1 bg-ink-4/60" />
        </div>
      )}

      <ContextMenu items={items}>
        <article
          ref={(node) => {
            registerRow(message.id, node);
          }}
          className={cn(
            "group relative flex gap-3 rounded-md px-1 transition-colors hover:bg-ink-3/40",
            startsGroup ? "mt-3 py-0.5" : "py-px",
            message.pending && "opacity-60",
            isFlashing && "bg-accent/15 ring-1 ring-accent/50",
          )}
        >
          {startsGroup ? (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-ink-3 text-sm font-semibold">
              {message.authorAvatarUrl ? (
                <img
                  src={message.authorAvatarUrl}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                />
              ) : (
                message.authorName.slice(0, 1).toUpperCase()
              )}
            </div>
          ) : (
            <time
              className="w-9 shrink-0 pt-0.5 text-right text-[10px] leading-5 text-paper-muted opacity-0 group-hover:opacity-100"
              dateTime={message.createdAt}
            >
              {formatTime(message.createdAt)}
            </time>
          )}

          <div className="min-w-0 flex-1">
            {message.replyTo && (
              <ReplyQuote
                replyTo={message.replyTo}
                onJump={onJumpToMessage}
              />
            )}
            {startsGroup && (
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span
                  className={cn(
                    "font-semibold",
                    isMine ? "text-signal" : "text-paper",
                  )}
                >
                  {message.authorName}
                </span>
                {message.authorTag && (
                  <span className="font-mono text-[11px] text-paper-muted">
                    {message.authorTag}
                  </span>
                )}
                <time
                  className="text-[11px] text-paper-muted"
                  dateTime={message.createdAt}
                  title={formatFullTimestamp(message.createdAt)}
                >
                  {formatTime(message.createdAt)}
                </time>
              </div>
            )}

            {isEditing ? (
              <EditComposer
                initialValue={message.body}
                onCancel={onCancelEdit}
                onSubmit={onSubmitEdit}
              />
            ) : gifMedia ? (
              <div>
                <GifAttachment media={gifMedia} />
                <EditedMarker editedAt={message.editedAt} />
              </div>
            ) : (
              <div className="markdown-body text-[15px] leading-relaxed text-paper/90">
                <MessageBody
                  body={message.body}
                  currentUsername={currentUsername}
                />
                <EditedMarker editedAt={message.editedAt} />
              </div>
            )}

            {message.failed && (
              <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-danger">
                <AlertCircle className="h-3.5 w-3.5" />
                Message failed to send.
                <button
                  type="button"
                  onClick={onRetry}
                  className="underline underline-offset-2 hover:text-paper"
                >
                  Retry
                </button>
                <button
                  type="button"
                  onClick={onDiscard}
                  className="underline underline-offset-2 hover:text-paper"
                >
                  Discard
                </button>
              </p>
            )}

            {isReal && (
              <ReactionBar
                reactions={message.reactions ?? []}
                isPickerOpen={isPickerOpen}
                onToggle={(emoji) => onToggleReaction(message.id, emoji)}
                onOpenPicker={onOpenPicker}
                onClosePicker={onClosePicker}
              />
            )}
          </div>

          {/* Right-click is not available on touch, so surface the same actions
              as a visible toolbar on hover / focus. */}
          {isReal && !isEditing && (
            <div className="absolute -top-3 right-2 hidden items-center gap-0.5 rounded-md border border-ink-4 bg-ink-2 p-0.5 shadow-sm group-hover:flex group-focus-within:flex">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Add reaction"
                className="h-6 w-6"
                onClick={onOpenPicker}
              >
                <SmilePlus className="h-3.5 w-3.5" />
              </Button>
              {canReply && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Reply"
                  className="h-6 w-6"
                  onClick={onReply}
                >
                  <Reply className="h-3.5 w-3.5" />
                </Button>
              )}
              {isMine && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Edit message"
                  className="h-6 w-6"
                  onClick={onStartEdit}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              )}
              {canDelete && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Delete message"
                  className="h-6 w-6 text-danger hover:text-danger"
                  onClick={confirmDelete}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          )}
        </article>
      </ContextMenu>
    </>
  );
});

function EditedMarker({ editedAt }: { editedAt: string | null | undefined }) {
  if (!editedAt) {
    return null;
  }
  return (
    <span
      className="ml-1 align-baseline text-[10px] text-paper-muted"
      title={formatFullTimestamp(editedAt)}
    >
      (edited)
    </span>
  );
}

/** Tall enough to read, short enough that one GIF is not the whole viewport. */
const GIF_MAX_HEIGHT_PX = 280;

/**
 * Inline media for a message whose body is a single allowlisted GIF URL.
 *
 * `referrerPolicy` matters more here than on an avatar: the CDN is a third
 * party that would otherwise be told which pqp deployment — and on a
 * self-hosted install, which private hostname — its users are reading.
 */
function GifAttachment({ media }: { media: GifMedia }) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [isPlaying, setIsPlaying] = useState(false);
  const style = { maxHeight: `${GIF_MAX_HEIGHT_PX}px` };

  if (!prefersReducedMotion || isPlaying) {
    return (
      <img
        src={media.url}
        alt={media.alt}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        style={style}
        className="mt-1 w-auto max-w-full rounded-md border border-border"
      />
    );
  }

  // Reduced motion: an <img> of an animated GIF cannot be paused, so the
  // animation must not be fetched at all until it is asked for.
  return (
    <button
      type="button"
      onClick={() => setIsPlaying(true)}
      aria-label={`Play ${media.alt}`}
      className="group/gif relative mt-1 block w-fit max-w-full overflow-hidden rounded-md border border-border text-left hover:border-border-strong"
    >
      {media.stillUrl ? (
        <img
          src={media.stillUrl}
          alt={media.alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          style={style}
          className="w-auto max-w-full"
        />
      ) : (
        <span className="flex items-center gap-2 bg-surface-2 px-3 py-6 text-sm text-text-muted">
          <ImagePlay className="h-4 w-4 shrink-0" />
          {media.alt}
        </span>
      )}
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-1/90 text-text opacity-85 transition-opacity group-hover/gif:opacity-100">
          <Play className="h-4 w-4" />
        </span>
      </span>
    </button>
  );
}

/**
 * One-line header naming the message this one answers. Clicking it jumps to the
 * parent when it is loaded; a parent that is gone renders inert rather than
 * offering a jump that cannot land anywhere.
 */
function ReplyQuote({
  replyTo,
  onJump,
}: {
  replyTo: NonNullable<ChatMessage["replyTo"]>;
  onJump: (messageId: string) => boolean;
}) {
  if (replyTo.deleted) {
    return (
      <p className="mb-0.5 flex items-center gap-1.5 text-xs text-text-muted">
        <CornerUpLeft className="h-3 w-3 shrink-0" />
        <span className="italic">Original message was deleted</span>
      </p>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onJump(replyTo.id)}
      className="mb-0.5 flex w-full min-w-0 items-center gap-1.5 text-left text-xs text-text-muted hover:text-text"
    >
      <CornerUpLeft className="h-3 w-3 shrink-0" />
      <span className="shrink-0 font-medium text-accent">
        {replyTo.authorName}
      </span>
      <span className="min-w-0 flex-1 truncate">{replyTo.excerpt}</span>
    </button>
  );
}

function EditComposer({
  initialValue,
  onCancel,
  onSubmit,
}: {
  initialValue: string;
  onCancel: () => void;
  onSubmit: (body: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (node) {
      node.focus();
      node.setSelectionRange(node.value.length, node.value.length);
    }
  }, []);

  async function submit() {
    const trimmed = value.trim();
    if (!trimmed || busy) {
      return;
    }
    if (trimmed === initialValue) {
      onCancel();
      return;
    }
    setBusy(true);
    try {
      await onSubmit(trimmed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1">
      <textarea
        ref={ref}
        value={value}
        rows={Math.min(8, value.split("\n").length + 1)}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        className="w-full resize-none rounded-md border border-ink-4 bg-ink-3 px-2.5 py-1.5 text-[15px] text-paper outline-none focus:border-signal/60"
      />
      <p className="mt-1 text-[11px] text-paper-muted">
        Enter to save · Escape to cancel
      </p>
    </div>
  );
}

interface ReactionBarProps {
  reactions: MessageReaction[];
  isPickerOpen: boolean;
  onToggle: (emoji: string) => void;
  onOpenPicker: () => void;
  onClosePicker: () => void;
}

function ReactionBar({
  reactions,
  isPickerOpen,
  onToggle,
  onOpenPicker,
  onClosePicker,
}: ReactionBarProps) {
  const hasReactions = reactions.length > 0;

  if (!hasReactions && !isPickerOpen) {
    return null;
  }

  return (
    <div className="relative mt-1.5 flex w-fit max-w-full flex-wrap items-center gap-1">
      {reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          onClick={() => onToggle(reaction.emoji)}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
            reaction.me
              ? "border-signal/50 bg-signal/15 text-signal"
              : "border-ink-4 bg-ink-3/80 text-paper-muted hover:border-ink-4 hover:text-paper",
          )}
        >
          <span className="text-sm leading-none">{reaction.emoji}</span>
          <span className="font-medium tabular-nums">{reaction.count}</span>
        </button>
      ))}
      <button
        type="button"
        aria-label="Add reaction"
        onClick={onOpenPicker}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-dashed border-ink-4 text-paper-muted hover:border-signal/50 hover:text-signal"
      >
        <SmilePlus className="h-3 w-3" />
      </button>
      {isPickerOpen && (
        <EmojiPickerPanel
          className="absolute bottom-full left-0 mb-2"
          onSelect={(emoji) => {
            onToggle(emoji);
            onClosePicker();
          }}
          onClose={onClosePicker}
        />
      )}
    </div>
  );
}

import type { Embed, MessageReaction, WebhookEmbed } from "@pqp/shared";
import {
  AlertCircle,
  ArrowDown,
  CornerUpLeft,
  ImagePlay,
  Loader2,
  Pencil,
  Pin,
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
import { AttachmentGrid } from "@/components/chat/attachment-grid";
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
  getApiBaseUrl,
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

/** Shared identity, so the default prop does not remount every row each render. */
const EMPTY_BLOCKED: ReadonlySet<string> = new Set<string>();

interface MessageListProps {
  messages: ChatMessage[];
  currentUserId: string | null;
  currentUsername?: string | null;
  serverId?: string | null;
  channelId?: string | null;
  isLoading?: boolean;
  hasMore?: boolean;
  /** True while the loaded window stops short of the newest message. */
  hasNewer?: boolean;
  isLoadingOlder?: boolean;
  isLoadingNewer?: boolean;
  typingUsers?: TypingUser[];
  canModerate?: boolean;
  /**
   * Authors this reader has blocked. Their messages are collapsed here rather
   * than filtered out on the server: dropping rows from a keyset-paginated
   * channel would corrupt the page counts the history cursor depends on, and
   * a gap in a shared conversation is harder to read than a curtain over it.
   */
  blockedAuthorIds?: ReadonlySet<string>;
  /** Scrolled into view and flashed once it renders. */
  highlightMessageId?: string | null;
  onHighlightHandled?: () => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onLoadOlder?: () => Promise<number>;
  onLoadNewer?: () => Promise<number>;
  /** Fetch history around a message that is not in the loaded window. */
  onJumpToMessage?: (messageId: string) => Promise<boolean>;
  /** Drop the history window and reload the newest page. */
  onJumpToPresent?: () => Promise<boolean>;
  onEditMessage?: (messageId: string, body: string) => Promise<void>;
  onDeleteMessage?: (messageId: string) => Promise<void>;
  onRetryMessage?: (nonce: string) => void;
  onDiscardMessage?: (nonce: string) => void;
  onReplyTo?: (message: ChatMessage) => void;
  onPinMessage?: (messageId: string) => Promise<void>;
  onUnpinMessage?: (messageId: string) => Promise<void>;
  /** Client-render-only: the server unfurls and caches regardless, so turning
   * this off only stops this reader's own client from drawing the card. */
  showLinkEmbeds?: boolean;
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
  hasNewer = false,
  isLoadingOlder = false,
  isLoadingNewer = false,
  typingUsers = [],
  canModerate = false,
  blockedAuthorIds = EMPTY_BLOCKED,
  highlightMessageId = null,
  onHighlightHandled,
  onToggleReaction,
  onLoadOlder,
  onLoadNewer,
  onJumpToMessage,
  onJumpToPresent,
  onEditMessage,
  onDeleteMessage,
  onRetryMessage,
  onDiscardMessage,
  onReplyTo,
  onPinMessage,
  onUnpinMessage,
  showLinkEmbeds = true,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [pickerMessageId, setPickerMessageId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isPinned, setIsPinned] = useState(true);
  const [missedCount, setMissedCount] = useState(0);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [jumpNotice, setJumpNotice] = useState(false);
  /** A jump whose page has been fetched but not yet rendered. */
  const [pendingJumpId, setPendingJumpId] = useState<string | null>(null);
  /**
   * Blocked messages the reader has chosen to look at. Per message and not
   * per author: revealing one is answering "what did they say there", not
   * taking the block off.
   */
  const [revealedIds, setRevealedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const isPinnedRef = useRef(true);
  isPinnedRef.current = isPinned;
  const hasNewerRef = useRef(hasNewer);
  hasNewerRef.current = hasNewer;
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
  /** The same, for a page appended below the viewport. */
  const appendedRef = useRef(0);
  /** Set while a jump back to the live end is in flight. */
  const pendingTailRef = useRef(false);

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

  const showJumpNotice = useCallback(() => {
    setJumpNotice(true);
    if (noticeTimer.current) {
      window.clearTimeout(noticeTimer.current);
    }
    noticeTimer.current = window.setTimeout(
      () => setJumpNotice(false),
      JUMP_NOTICE_MS,
    );
  }, []);

  /**
   * Scroll a rendered message into view and light it up. False when the message
   * is not in the loaded window.
   */
  const focusRow = useCallback((messageId: string): boolean => {
    const node = rowNodes.current.get(messageId);
    if (!node) {
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

  /**
   * Go to a message wherever it lives: a rendered row is scrolled to directly,
   * anything older than the window is fetched around first.
   */
  const jumpToMessage = useCallback(
    (messageId: string) => {
      if (focusRow(messageId)) {
        return;
      }
      if (!onJumpToMessage) {
        showJumpNotice();
        return;
      }
      void onJumpToMessage(messageId)
        .then((reachable) => {
          if (reachable) {
            setPendingJumpId(messageId);
          } else {
            showJumpNotice();
          }
        })
        .catch(showJumpNotice);
    },
    [focusRow, onJumpToMessage, showJumpNotice],
  );

  // The fetched window is only in the DOM once the parent has re-rendered with
  // it, so the scroll waits a frame rather than reading the row map inline.
  useEffect(() => {
    if (!pendingJumpId) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      setPendingJumpId(null);
      if (!focusRow(pendingJumpId)) {
        showJumpNotice();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingJumpId, focusRow, showJumpNotice]);

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
    const appended = appendedRef.current;
    appendedRef.current = 0;
    const arrived = added - prepended - appended;
    if (arrived <= 0) {
      return;
    }
    // A jump parks the reader mid-history: the last row on screen is not the
    // newest in the channel, so following the bottom would scroll to a place
    // nobody asked for and undo the jump itself.
    if (hasNewerRef.current) {
      return;
    }
    if (isPinnedRef.current) {
      scrollToBottom(messages.length > 60 ? "auto" : "smooth");
    } else {
      setMissedCount((count) => count + arrived);
    }
  }, [messages.length, scrollToBottom]);

  // Media loads after the row is already on screen, and growing it pushes the
  // bottom away from a reader who was sitting on it. The pin effect above only
  // runs on a change in message count, which has long since fired by then — so
  // sending a GIF scrolled to the bottom of a row that was still zero pixels
  // tall and left you above the message you just sent.
  //
  // Watching the container's height covers every late-sizing thing at once
  // (GIFs, images without intrinsic dimensions, embeds) instead of threading an
  // onLoad through each one. Guarded on the same two conditions as the pin
  // effect: never fight a reader who has scrolled up, and never undo a jump.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (isPinnedRef.current && !hasNewerRef.current) {
        // "auto": the growth already happened, so animating to it reads as a
        // second, unexplained scroll.
        scrollToBottom("auto");
      }
    });
    observer.observe(container, { box: "border-box" });
    for (const child of Array.from(container.children)) {
      observer.observe(child);
    }
    return () => observer.disconnect();
  }, [scrollToBottom, messages.length]);

  // Land at the bottom after a jump back to the present.
  //
  // A tail reset swaps the entire window rather than adding to it, so a scroll
  // scheduled when the fetch resolves runs against the outgoing layout — and
  // replacing a scroll container's contents drops it back to the top, which is
  // exactly the place the reader just asked to leave. Waiting for the commit is
  // what makes the button land where it says it will.
  useLayoutEffect(() => {
    if (!pendingTailRef.current) {
      return;
    }
    pendingTailRef.current = false;
    lastCountRef.current = messages.length;
    setIsPinned(true);
    setMissedCount(0);
    scrollToBottom("auto");
  }, [messages, scrollToBottom]);

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
    setPendingJumpId(null);
    // A reveal belongs to the conversation it was made in. Carrying it across
    // would re-open a blocked message in the next channel by message id alone.
    setRevealedIds(new Set());
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

  const loadNewer = useCallback(() => {
    if (!onLoadNewer || !hasNewer || isLoadingNewer) {
      return;
    }
    // Content added below the viewport does not move the scroll offset, so this
    // needs no anchor — only a count, so the arrival effect does not mistake
    // fetched history for live traffic.
    void onLoadNewer()
      .then((added) => {
        appendedRef.current += added;
      })
      .catch(() => {
        // The controller already stops offering the direction it failed in.
      });
  }, [hasNewer, isLoadingNewer, onLoadNewer]);

  /** The button under the reader: back to the live end of the channel. */
  const jumpToPresent = useCallback(() => {
    if (!hasNewer || !onJumpToPresent) {
      scrollToBottom();
      return;
    }
    // Flagged before the fetch, not after: the effect below owns the scroll
    // because it is the only thing that runs after React has committed the new
    // window. See the comment there.
    pendingTailRef.current = true;
    void onJumpToPresent().then((loaded) => {
      if (!loaded) {
        pendingTailRef.current = false;
      }
    });
  }, [hasNewer, onJumpToPresent, scrollToBottom]);

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
    if (distanceFromBottom <= LOAD_MORE_THRESHOLD_PX) {
      loadNewer();
    }
  }, [loadNewer, loadOlder]);

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
              // Your own message is never curtained: blocking someone who once
              // shared your account's id is not a thing, and a reader hiding
              // their own words reads as data loss.
              isBlocked={
                row.message.authorId !== currentUserId &&
                blockedAuthorIds.has(row.message.authorId) &&
                !revealedIds.has(row.message.id)
              }
              onReveal={() =>
                setRevealedIds((current) =>
                  new Set(current).add(row.message.id),
                )
              }
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
              onPin={
                onPinMessage
                  ? () => void onPinMessage(row.message.id)
                  : undefined
              }
              onUnpin={
                onUnpinMessage
                  ? () => void onUnpinMessage(row.message.id)
                  : undefined
              }
              onToggleReaction={onToggleReaction}
              onRetry={() =>
                row.message.nonce && onRetryMessage?.(row.message.nonce)
              }
              onDiscard={() =>
                row.message.nonce && onDiscardMessage?.(row.message.nonce)
              }
              showLinkEmbeds={showLinkEmbeds}
            />
          ))
        )}

        {hasNewer && (
          <div className="flex justify-center pt-3">
            {isLoadingNewer ? (
              <span className="flex items-center gap-2 text-xs text-paper-muted">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading newer messages…
              </span>
            ) : (
              <button
                type="button"
                onClick={loadNewer}
                className="rounded-full border border-ink-4 px-3 py-1 text-xs text-paper-muted hover:text-paper"
              >
                Load newer messages
              </button>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <TypingIndicator users={typingUsers} />

      {jumpNotice && (
        <p
          role="status"
          className="animate-rise absolute bottom-16 right-4 z-10 max-w-[16rem] rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-text-muted shadow-lg"
        >
          That message is no longer available — it may have been deleted.
        </p>
      )}

      {(!isPinned || hasNewer) && (
        <button
          type="button"
          onClick={jumpToPresent}
          className="absolute bottom-4 right-4 z-10 flex items-center gap-1.5 rounded-full border border-ink-4 bg-ink-2/95 px-3 py-1.5 text-xs font-medium text-paper shadow-lg backdrop-blur transition-colors hover:border-signal/60 hover:text-signal"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          {missedCount > 0 && !hasNewer
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

/**
 * Note the absence of `img`: attachments render from the structured array on
 * the message, never from markdown a sender typed. Allowing it here would let
 * any message embed any URL, which is a per-reader tracking pixel and a way to
 * put arbitrary remote content inside our own origin.
 */
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
  /** True while this message is behind the blocked curtain. */
  isBlocked: boolean;
  onReveal: () => void;
  isFlashing: boolean;
  registerRow: (messageId: string, node: HTMLElement | null) => void;
  onJumpToMessage: (messageId: string) => void;
  onReply?: () => void;
  isPickerOpen: boolean;
  isEditing: boolean;
  onOpenPicker: () => void;
  onClosePicker: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (body: string) => Promise<void>;
  onDelete?: () => void;
  onPin?: () => void;
  onUnpin?: () => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onRetry: () => void;
  onDiscard: () => void;
  showLinkEmbeds: boolean;
}

const MessageRow = memo(function MessageRow({
  row,
  currentUserId,
  currentUsername,
  serverId,
  channelId,
  canModerate,
  isBlocked,
  onReveal,
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
  onPin,
  onUnpin,
  onToggleReaction,
  onRetry,
  onDiscard,
  showLinkEmbeds,
}: MessageRowProps) {
  const { message, startsGroup, dayLabel } = row;
  // A body that is nothing but a GIF link is media, not prose — the URL is the
  // message, so it renders instead of the text rather than beside it.
  const gifMedia = useMemo(() => gifMessageMedia(message.body), [message.body]);
  const attachments = message.attachments ?? [];
  const isMine = message.authorId === currentUserId;
  const isReal = !message.pending && !message.failed;
  const canDelete = isReal && !!onDelete && (isMine || canModerate);
  const canReply = isReal && !!onReply;
  const isMessagePinned = Boolean(message.pinnedAt);
  // Mirrors the server's own gate: a conversation has no moderators, so
  // `serverId` being null means anyone already in it — proven just by being
  // able to see this row — may pin or unpin. A server channel needs the same
  // permission as every other moderation action, matching Discord's "Manage
  // Messages" rather than letting an author pin their own post unilaterally.
  const canPin =
    isReal && (serverId ? canModerate : true) && (onPin || onUnpin);

  function confirmDelete() {
    if (window.confirm("Delete this message?")) {
      onDelete?.();
    }
  }

  if (isBlocked) {
    return (
      <>
        {dayLabel && <DaySeparator label={dayLabel} />}
        {/* Still a registered row, so a permalink or a reply pointing at it
            lands somewhere instead of reporting the message as gone. Nothing of
            its content is rendered until asked for — not the body, not the
            attachments, not the author's avatar. */}
        <article
          ref={(node) => {
            registerRow(message.id, node);
          }}
          className="group mt-1 flex items-center gap-2 rounded-md px-1 py-1 text-xs text-paper-muted"
        >
          <span className="italic">Blocked message</span>
          <button
            type="button"
            onClick={onReveal}
            className="underline underline-offset-2 hover:text-paper"
          >
            Show
          </button>
        </article>
      </>
    );
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
    ...(canPin
      ? [
          {
            id: "pin",
            label: isMessagePinned ? "Unpin message" : "Pin message",
            onSelect: isMessagePinned ? onUnpin : onPin,
          },
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
      {dayLabel && <DaySeparator label={dayLabel} />}

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
                {message.isWebhook && (
                  <span
                    className="rounded bg-ink-4 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-paper-muted"
                    title="Posted by a webhook, not a member"
                  >
                    Webhook
                  </span>
                )}
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
                {isMessagePinned && (
                  <span
                    className="inline-flex items-center gap-0.5 text-[11px] text-signal"
                    title={
                      message.pinnedBy
                        ? `Pinned by ${message.pinnedBy.displayName}`
                        : "Pinned"
                    }
                  >
                    <Pin className="h-3 w-3" aria-hidden />
                    <span className="sr-only">Pinned</span>
                  </span>
                )}
              </div>
            )}

            {isEditing ? (
              <EditComposer
                initialValue={message.body}
                allowEmpty={attachments.length > 0}
                onCancel={onCancelEdit}
                onSubmit={onSubmitEdit}
              />
            ) : gifMedia ? (
              <div>
                <GifAttachment media={gifMedia} />
                <EditedMarker editedAt={message.editedAt} />
              </div>
            ) : (
              <>
                {/* A message carrying attachments is allowed to say nothing, so
                    an empty body renders as nothing rather than an empty line. */}
                {message.body && (
                  <div className="markdown-body text-[15px] leading-relaxed text-paper/90">
                    <MessageBody
                      body={message.body}
                      currentUsername={currentUsername}
                    />
                    {attachments.length === 0 && (
                      <EditedMarker editedAt={message.editedAt} />
                    )}
                  </div>
                )}
                {attachments.length > 0 && (
                  <div>
                    <AttachmentGrid attachments={attachments} />
                    <EditedMarker editedAt={message.editedAt} />
                  </div>
                )}
                {/* Says nothing and carries nothing. The server refuses to
                    create that for an ordinary send, so reaching it means the
                    attachments were withheld on read — which is what a
                    deployment whose storage config went missing serves for an
                    attachment-only message. A webhook message is the one other
                    way to get here honestly: Discord's own webhooks allow an
                    embed with no `content` at all, which is why this also
                    checks for one before naming it a problem. */}
                {!message.body &&
                  attachments.length === 0 &&
                  message.webhookEmbeds.length === 0 && (
                    <p className="text-[15px] italic leading-relaxed text-paper-muted">
                      Attachment unavailable.
                    </p>
                  )}
                {showLinkEmbeds && message.embeds?.[0] && (
                  <EmbedCard embed={message.embeds[0]} />
                )}
                {message.webhookEmbeds.map((embed, index) => (
                  <WebhookEmbedCard key={index} embed={embed} />
                ))}
              </>
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

/** The date rule between two days of messages. */
function DaySeparator({ label }: { label: string }) {
  return (
    <div className="my-4 flex items-center gap-3" role="separator">
      <span className="h-px flex-1 bg-ink-4/60" />
      <span className="text-[11px] font-medium uppercase tracking-wider text-paper-muted">
        {label}
      </span>
      <span className="h-px flex-1 bg-ink-4/60" />
    </div>
  );
}

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
 * A link preview: title, description, site name, and an optional thumbnail
 * pulled from the page's Open Graph tags. `embed.imageUrl` is always this
 * server's own proxy path (see `GET /api/embeds/:urlHash/image`), never the
 * origin site's own URL, and is prefixed with the API's own origin here
 * because the SPA and the API are routinely deployed on two different
 * origins (Cloudflare Pages + Railway) — a bare relative path would resolve
 * against the wrong one in production.
 *
 * An `image` embed (the link itself pointed straight at an image, not a
 * page) has no title or description to show — it renders as the picture
 * itself, the same way a GIF attachment does.
 */
function EmbedCard({ embed }: { embed: Embed }) {
  const imageUrl = embed.imageUrl ? `${getApiBaseUrl()}${embed.imageUrl}` : null;

  if (embed.kind === "image") {
    if (!imageUrl) {
      return null;
    }
    return (
      <a
        href={embed.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1.5 block w-fit max-w-full overflow-hidden rounded-md border border-border"
      >
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          style={{ maxHeight: `${GIF_MAX_HEIGHT_PX}px` }}
          className="w-auto max-w-full"
        />
      </a>
    );
  }

  // A page with no OG tags at all is cached as a non-failed row with every
  // field null (see embeds.ts) so it is not endlessly re-fetched — nothing
  // here means nothing to show, not an error.
  if (!embed.title && !embed.description && !imageUrl) {
    return null;
  }

  return (
    <a
      href={embed.url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1.5 flex max-w-md gap-3 overflow-hidden rounded-md border border-border border-l-[3px] border-l-signal bg-surface-2/60 p-2.5 transition-colors hover:bg-surface-2"
    >
      <div className="min-w-0 flex-1">
        {embed.siteName && (
          <p className="truncate text-[11px] uppercase tracking-wide text-paper-muted">
            {embed.siteName}
          </p>
        )}
        {embed.title && (
          <p className="mt-0.5 line-clamp-2 text-sm font-medium text-signal">
            {embed.title}
          </p>
        )}
        {embed.description && (
          <p className="mt-1 line-clamp-3 text-xs text-paper-muted">
            {embed.description}
          </p>
        )}
      </div>
      {imageUrl && (
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-16 w-16 shrink-0 rounded object-cover"
        />
      )}
    </a>
  );
}

/** A packed 24-bit integer to a CSS color — the same encoding Discord's own
 * embeds use, so a payload built for a real Discord webhook renders here
 * with no conversion on the sender's side. */
function colorFromInt(value: number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return `#${value.toString(16).padStart(6, "0")}`;
}

/**
 * A webhook's own rich embed — a deliberate subset of Discord's embed object
 * (title/description/url/color/fields/footer). Structurally similar to
 * `EmbedCard` but a distinct component rather than a shared one: this data
 * came from whoever holds the webhook token, not from this server's own
 * automatic link unfurl, and the two are never interchangeable even where
 * the rendering happens to rhyme.
 */
function WebhookEmbedCard({ embed }: { embed: WebhookEmbed }) {
  const accent = colorFromInt(embed.color);
  const Wrapper = embed.url ? "a" : "div";

  return (
    <Wrapper
      {...(embed.url
        ? { href: embed.url, target: "_blank", rel: "noopener noreferrer" }
        : {})}
      className="mt-1.5 block max-w-md space-y-1.5 rounded-md border border-border bg-surface-2/60 p-2.5"
      style={{ borderLeftWidth: "3px", borderLeftColor: accent ?? "var(--color-signal)" }}
    >
      {embed.title && (
        <p
          className={cn(
            "text-sm font-medium",
            embed.url ? "text-signal" : "text-paper",
          )}
        >
          {embed.title}
        </p>
      )}
      {embed.description && (
        <p className="whitespace-pre-wrap text-xs text-paper-muted">
          {embed.description}
        </p>
      )}
      {embed.fields && embed.fields.length > 0 && (
        <div className="grid grid-cols-2 gap-2 pt-1">
          {embed.fields.map((field, index) => (
            <div
              key={index}
              className={field.inline ? "" : "col-span-2"}
            >
              <p className="text-[11px] font-semibold uppercase tracking-wide text-paper-muted">
                {field.name}
              </p>
              <p className="text-xs text-paper">{field.value}</p>
            </div>
          ))}
        </div>
      )}
      {embed.footer?.text && (
        <p className="pt-1 text-[11px] text-paper-muted">{embed.footer.text}</p>
      )}
    </Wrapper>
  );
}

/**
 * One-line header naming the message this one answers. Clicking it jumps to the
 * parent, loading history around it when needed; a parent that is gone renders
 * inert rather than offering a jump that cannot land anywhere.
 */
function ReplyQuote({
  replyTo,
  onJump,
}: {
  replyTo: NonNullable<ChatMessage["replyTo"]>;
  onJump: (messageId: string) => void;
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
  allowEmpty = false,
  onCancel,
  onSubmit,
}: {
  initialValue: string;
  /**
   * Set for a message that carries attachments, which is the only shape the
   * server will store an empty body for. Clearing a caption is an edit and not
   * a delete — the image stays — so refusing to submit here would leave the
   * caption on screen with no way to remove it short of deleting the message.
   */
  allowEmpty?: boolean;
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
    if (busy || (!trimmed && !allowEmpty)) {
      return;
    }
    // An already-empty body cleared again is not a change, so this still keeps
    // the empty case from sending a PATCH that would do nothing.
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

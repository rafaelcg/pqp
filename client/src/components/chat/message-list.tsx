import type {
  Embed,
  MessageReaction,
  ThreadSummary,
  WebhookEmbed,
} from "@pqp/shared";
import {
  AlertCircle,
  ArrowDown,
  CornerUpLeft,
  ImagePlay,
  Loader2,
  MoreHorizontal,
  Pencil,
  Pin,
  Play,
  Reply,
  SmilePlus,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { UserAvatar } from "@/components/user/user-avatar";
import { RankMarks } from "@/components/user/rank-marks";
import { StatusDot } from "@/components/user/status-dot";
import { AttachmentGrid } from "@/components/chat/attachment-grid";
import { MessageBody } from "@/components/chat/message-body";
import { ChanceCard } from "@/components/chat/chance-card";
import { PollCard } from "@/components/chat/poll-card";
import { EmojiPickerPanel } from "@/components/chat/emoji-picker";
import { ThreadChip } from "@/components/chat/thread-chip";
import {
  ContextMenu,
  type ContextMenuItemDef,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useProfilePopover } from "@/components/user/user-profile-popover";
import type { ProfileSubject } from "@/components/user/profile-relations";
import {
  failedSendKey,
  messageRetryReady,
  type ChatMessage,
  type TypingUser,
} from "@/hooks/use-chat";
import type { MemberRole, UserStatus } from "@pqp/shared";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { messageRoutePath } from "@/lib/app-route";
import { QUICK_REACTIONS } from "@/lib/emoji-shortcodes";
import { messageMentionsYou } from "@/lib/message-mentions-you";
import { findFirstUnreadMessageId } from "@/lib/unread-divider";
import { highestRoleColor, identityMarks, rankBadges, usernameFromTag } from "@/lib/author-display";
import { gifMessageMedia, type GifMedia } from "@/lib/gif-media";
import {
  ANCHORED_PANEL_PAD,
  placeAnchoredPanel,
} from "@/lib/anchored-panel";
import { formatReactionWho } from "@/lib/reaction-who";
import { translateMessage, useTranslation } from "@/lib/i18n";
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

/** First three of `QUICK_REACTIONS`, shown on the hover bar. */
const HOVER_QUICK_REACTIONS = QUICK_REACTIONS.slice(0, 3);

/** Hover toolbar sits on top of the row; a right-click still belongs to it. */
function forwardRowContextMenu(event: ReactMouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  const article = event.currentTarget.closest("article");
  if (!(article instanceof HTMLElement)) {
    return;
  }
  article.dispatchEvent(
    new window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: event.clientX,
      clientY: event.clientY,
      button: 2,
    }),
  );
}

/** Roster facts the transcript uses to colour a name and draw a presence pip. */
export interface MessageAuthorInfo {
  rank?: MemberRole | null;
  roleIds?: string[];
  status?: UserStatus | null;
  username?: string | null;
  isCharacter?: boolean;
}

export interface MessageRoleColor {
  id: string;
  color: string | null;
  position: number;
  systemKey?: string | null;
  showBadge?: boolean;
}

/** Shared identity, so the default prop does not remount every row each render. */
const EMPTY_BLOCKED: ReadonlySet<string> = new Set<string>();
const EMPTY_AUTHORS: ReadonlyMap<string, MessageAuthorInfo> = new Map();
const EMPTY_ROLES: readonly MessageRoleColor[] = [];

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
  onVotePoll?: (messageId: string, optionId: string) => void;
  onClosePoll?: (messageId: string) => void;
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
  /**
   * Opens the report dialog for this message. Offered on anyone else's message
   * in any channel, conversations included — where a report goes is the
   * server's decision, not this component's, so nothing here tries to work out
   * whether the channel has moderators.
   */
  onReportMessage?: (message: ChatMessage) => void;
  /** Client-render-only: the server unfurls and caches regardless, so turning
   * this off only stops this reader's own client from drawing the card. */
  showLinkEmbeds?: boolean;
  // --- threads ---
  /**
   * Start a thread from a message that has none. Absent inside the thread
   * panel itself (threads do not nest) and in conversations (a DM already is
   * the scoped side-conversation a thread would create).
   */
  onStartThread?: (message: ChatMessage) => void;
  /** Open the panel for a message's existing thread. */
  onOpenThread?: (thread: ThreadSummary, message: ChatMessage) => void;
  /** Thread channel ids with unread activity — drawn as a dot on the chip,
   * never on the parent channel's own badge. */
  unreadThreadIds?: ReadonlySet<string>;
  /** The thread the panel is currently showing, so its chip reads as open. */
  activeThreadId?: string | null;
  /** Roster lookup for name colour, rank glyph, and presence. */
  authors?: ReadonlyMap<string, MessageAuthorInfo>;
  /** Painted roles, for the highest-position colour on a name. */
  roles?: readonly MessageRoleColor[];
  /** True while Mark unread is holding this channel's read cursor. */
  unreadHeld?: boolean;
  onForward?: (message: ChatMessage) => void;
  onMarkUnread?: (message: ChatMessage) => void;
  onMarkRead?: () => void;
  /**
   * Last-read cursor from *before* this visit marked the channel read. The NEW
   * rule sits on the first message after it and stays until the channel changes.
   */
  unreadSince?: string | null;
  /** Composer ArrowUp: start editing this id, then call `onEditMessageHandled`. */
  editMessageId?: string | null;
  onEditMessageHandled?: () => void;
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

/** Consecutive pings in a group share one wash, not a stack of rounded cards. */
function mentionJoins(
  rows: Row[],
  mentions: readonly boolean[],
  index: number,
  firstUnreadId: string | null,
): { joinTop: boolean; joinBottom: boolean } {
  if (!mentions[index]) {
    return { joinTop: false, joinBottom: false };
  }
  const row = rows[index]!;
  const next = rows[index + 1];
  const joinTop = Boolean(
    mentions[index - 1] &&
      !row.startsGroup &&
      !row.dayLabel &&
      row.message.id !== firstUnreadId,
  );
  const joinBottom = Boolean(
    next &&
      mentions[index + 1] &&
      !next.startsGroup &&
      !next.dayLabel &&
      next.message.id !== firstUnreadId,
  );
  return { joinTop, joinBottom };
}

function mentionRowRadius(joinTop: boolean, joinBottom: boolean): string {
  if (joinTop && joinBottom) {
    return "rounded-none";
  }
  if (joinTop) {
    return "rounded-b-md";
  }
  if (joinBottom) {
    return "rounded-t-md";
  }
  return "rounded-md";
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
  onVotePoll,
  onClosePoll,
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
  onReportMessage,
  showLinkEmbeds = true,
  onStartThread,
  onOpenThread,
  unreadThreadIds = EMPTY_BLOCKED,
  activeThreadId = null,
  authors = EMPTY_AUTHORS,
  roles = EMPTY_ROLES,
  unreadHeld = false,
  onForward,
  onMarkUnread,
  onMarkRead,
  unreadSince = null,
  editMessageId = null,
  onEditMessageHandled,
}: MessageListProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
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
  /** For the arrival announcement below — read without adding `messages`
   * itself to that effect's deps, which would rerun it on every in-place
   * edit/reaction update and not just on an actual new arrival. */
  const latestMessageRef = useRef(messages[messages.length - 1]);
  latestMessageRef.current = messages[messages.length - 1];
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
  const prefersReducedMotion = usePrefersReducedMotion();

  /**
   * The one row in the roving-tabindex group that is actually reachable by
   * Tab. Everything else on the row (reaction pills, the reply-jump button,
   * retry/discard) drops out of tab order the same way, so tabbing past a
   * long history costs one stop instead of one per message — the same reason
   * a toolbar or a listbox gets exactly one tab stop.
   *
   * Null means "no explicit choice yet"; the render below falls back to the
   * newest message so Tab has somewhere to land on first entry.
   */
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  /**
   * The row whose context menu is currently open via keyboard, so Escape can
   * put focus back on it. `ContextMenu`'s own `onCloseAutoFocus` is
   * suppressed (see context-menu.tsx) to fix its positioning, which also
   * disabled its default "return focus to the trigger" behaviour — this
   * ref plus the two effects below rebuild just that part from outside the
   * file this component does not own.
   */
  const openMenuRowIdRef = useRef<string | null>(null);
  /** A short, one-line heads-up for new arrivals — never the message itself. */
  const [liveAnnouncement, setLiveAnnouncement] = useState("");

  const rows = useMemo(() => buildRows(messages), [messages]);
  const mentionMask = useMemo(
    () =>
      rows.map((row) =>
        messageMentionsYou(row.message, currentUsername, currentUserId),
      ),
    [rows, currentUsername, currentUserId],
  );
  const rowIds = useMemo(() => rows.map((row) => row.message.id), [rows]);
  const firstUnreadId = useMemo(
    () => findFirstUnreadMessageId(messages, unreadSince),
    [messages, unreadSince],
  );
  const unreadDividerRef = useRef<HTMLDivElement>(null);
  /** `${channelId}::${unreadSince}` once this visit has been scrolled into place. */
  const unreadLandedRef = useRef<string | null>(null);
  const activeIndex = activeMessageId ? rowIds.indexOf(activeMessageId) : -1;
  const effectiveActiveId =
    activeIndex >= 0 ? activeMessageId : (rowIds[rowIds.length - 1] ?? null);

  const markMenuRow = useCallback((id: string | null) => {
    openMenuRowIdRef.current = id;
  }, []);

  // Escape closes the menu (Radix handles that already); this only decides
  // where focus goes next. Capture phase on `window` runs before Radix's own
  // document-level dismiss handling, so it always gets the last word over the
  // `onCloseAutoFocus` that was intentionally disabled.
  useEffect(() => {
    function handleEscapeCapture(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      const rowId = openMenuRowIdRef.current;
      if (!rowId) {
        return;
      }
      openMenuRowIdRef.current = null;
      requestAnimationFrame(() => {
        rowNodes.current.get(rowId)?.focus();
      });
    }
    window.addEventListener("keydown", handleEscapeCapture, true);
    return () =>
      window.removeEventListener("keydown", handleEscapeCapture, true);
  }, []);

  // If a keyboard-opened menu is dismissed some other way — clicking outside
  // it, clicking a different row — focus moves on its own and the tracked row
  // above goes stale. Left alone, a later, unrelated Escape (cancelling a
  // reply in the composer, say) would yank focus back to a menu that is long
  // closed. Clearing on any focus that lands outside both the row and the
  // menu keeps that Escape-refocus scoped to "the menu really is still open".
  useEffect(() => {
    function handleFocusIn(event: FocusEvent) {
      const rowId = openMenuRowIdRef.current;
      if (!rowId) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      const rowNode = rowNodes.current.get(rowId);
      if (rowNode?.contains(target)) {
        return;
      }
      if (target instanceof Element && target.closest('[role="menu"]')) {
        return;
      }
      openMenuRowIdRef.current = null;
    }
    window.addEventListener("focusin", handleFocusIn, true);
    return () => window.removeEventListener("focusin", handleFocusIn, true);
  }, []);

  /** Arrow/Home/End move the roving tab stop; every other key passes through. */
  const handleRowNavigate = useCallback(
    (event: React.KeyboardEvent<HTMLElement>, messageId: string) => {
      // Only when the row itself is focused — a nested control (the edit
      // textarea, a reaction pill) owns its own arrow-key behaviour.
      if (event.target !== event.currentTarget) {
        return;
      }
      const index = rowIds.indexOf(messageId);
      if (index === -1) {
        return;
      }
      let nextIndex: number;
      switch (event.key) {
        case "ArrowDown":
          nextIndex = Math.min(index + 1, rowIds.length - 1);
          break;
        case "ArrowUp":
          nextIndex = Math.max(index - 1, 0);
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = rowIds.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      const nextId = rowIds[nextIndex];
      if (nextId === messageId) {
        return;
      }
      setActiveMessageId(nextId);
      const node = rowNodes.current.get(nextId);
      node?.focus();
      node?.scrollIntoView({
        behavior: prefersReducedMotion ? "auto" : "smooth",
        block: "nearest",
      });
    },
    [rowIds, prefersReducedMotion],
  );

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    // The scrollport, not a sentinel. `scrollIntoView({ block: "end" })` on a
    // bottom marker lined that marker up with the padding edge and left the
    // container's `py-4` still below it, so a send sat almost-at-bottom and a
    // refresh sometimes landed a row short. `scrollHeight` is the real end.
    const top = container.scrollHeight;
    if (behavior === "smooth" && !prefersReducedMotion) {
      container.scrollTo({ top, behavior: "smooth" });
    } else {
      container.scrollTop = top;
    }
    setMissedCount(0);
  }, [prefersReducedMotion]);

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
    const previousCount = lastCountRef.current;
    const added = messages.length - previousCount;
    lastCountRef.current = messages.length;

    const prepended = prependedRef.current;
    prependedRef.current = 0;
    const appended = appendedRef.current;
    appendedRef.current = 0;
    // The first page of a visit is not an "arrival". The landing effect below
    // puts the viewport on the NEW rule (or the tail) without treating the
    // whole history as missed messages.
    if (previousCount === 0 && added > 0 && !highlightRef.current) {
      return;
    }
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

    // A screen reader gets a one-line heads-up either way — not the message
    // itself, which on a busy channel would mean a wall of speech nobody
    // could interrupt. Reading the actual row is one arrow-key press away
    // once this points them at it.
    const newest = latestMessageRef.current;
    setLiveAnnouncement(
      arrived === 1 && newest
        ? translateMessage("chat.live.from", { name: newest.authorName })
        : translateMessage("chat.live.many", { count: arrived }),
    );
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
  useLayoutEffect(() => {
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
  }, [scrollToBottom, messages.length, isLoading]);

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

  // Channel switch: reset visit-scoped UI. Where the viewport lands is the
  // layout effect below (NEW rule, permalink, or tail).
  useEffect(() => {
    setIsPinned(true);
    setMissedCount(0);
    setFlashId(null);
    setJumpNotice(false);
    setPendingJumpId(null);
    // A reveal belongs to the conversation it was made in. Carrying it across
    // would re-open a blocked message in the next channel by message id alone.
    setRevealedIds(new Set());
    // The roving tab stop and any open-menu tracking are scoped to a
    // specific message id, which means nothing once the channel underneath
    // it has changed.
    setActiveMessageId(null);
    openMenuRowIdRef.current = null;
    setLiveAnnouncement("");
    rowNodes.current.clear();
    lastCountRef.current = messages.length;
    unreadLandedRef.current = null;
    setEditingId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  // Open a channel: sit on the NEW rule when this visit has unread, otherwise
  // the tail. Skipped for a permalink, which already owns the scroll.
  //
  // Do not mark the visit as landed while `isLoading` is still showing the
  // skeleton: that tree has no scrollport, so `scrollToBottom` is a no-op, and
  // a later commit with the same message count would skip the real list and
  // leave it at scrollTop 0. That is the refresh-not-at-the-bottom bug.
  useLayoutEffect(() => {
    if (highlightRef.current) {
      return;
    }
    if (pendingTailRef.current) {
      return;
    }
    if (isLoading || messages.length === 0) {
      return;
    }
    if (!scrollRef.current) {
      return;
    }
    const key = `${channelId ?? ""}::${unreadSince ?? "none"}`;
    if (unreadLandedRef.current === key) {
      return;
    }
    const unreadId = firstUnreadId;
    if (unreadSince && unreadId) {
      const node =
        unreadDividerRef.current ?? rowNodes.current.get(unreadId) ?? null;
      if (!node) {
        const frame = requestAnimationFrame(() => {
          if (unreadLandedRef.current === key) {
            return;
          }
          const later =
            unreadDividerRef.current ?? rowNodes.current.get(unreadId) ?? null;
          if (!later) {
            return;
          }
          unreadLandedRef.current = key;
          setIsPinned(false);
          later.scrollIntoView({ block: "center", behavior: "auto" });
        });
        return () => cancelAnimationFrame(frame);
      }
      unreadLandedRef.current = key;
      setIsPinned(false);
      node.scrollIntoView({ block: "center", behavior: "auto" });
      return;
    }
    unreadLandedRef.current = key;
    setIsPinned(true);
    scrollToBottom("auto");
    // One more frame: the first layout can still be short if the composer or
    // a cached image settles after this commit.
    const frame = requestAnimationFrame(() => {
      if (isPinnedRef.current && !hasNewerRef.current) {
        scrollToBottom("auto");
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    channelId,
    unreadSince,
    firstUnreadId,
    messages.length,
    scrollToBottom,
    isLoading,
  ]);

  useEffect(() => {
    if (!editMessageId) {
      return;
    }
    if (!messages.some((message) => message.id === editMessageId)) {
      onEditMessageHandled?.();
      return;
    }
    setEditingId(editMessageId);
    setActiveMessageId(editMessageId);
    requestAnimationFrame(() => {
      rowNodes.current.get(editMessageId)?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    });
    onEditMessageHandled?.();
  }, [editMessageId, messages, onEditMessageHandled]);

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
        role="log"
        aria-label={t("chat.messagesAria")}
        // The container itself never auto-announces: a busy channel mutates
        // constantly (reactions, edits, pagination), and role="log" implies
        // aria-live="polite" by default — enough to bury a screen-reader user
        // in half-finished sentences. The single sr-only status region below
        // is the only thing that speaks, and only for genuine new arrivals.
        aria-live="off"
        className="flex-1 overflow-y-auto [overflow-anchor:none] py-4"
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
          rows.map((row, index) => {
            const { joinTop, joinBottom } = mentionJoins(
              rows,
              mentionMask,
              index,
              firstUnreadId,
            );
            return (
            <MessageRow
              key={row.message.id}
              row={row}
              mentionJoinTop={joinTop}
              mentionJoinBottom={joinBottom}
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
              onClosePicker={() => {
                setPickerMessageId(null);
                // The picker unmounts on close; without this, the focus it
                // held goes to <body> and the keyboard user is adrift.
                requestAnimationFrame(() => {
                  rowNodes.current.get(row.message.id)?.focus();
                });
              }}
              onStartEdit={() => {
                setEditingId(row.message.id);
                setActiveMessageId(row.message.id);
              }}
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
              onReport={
                onReportMessage
                  ? () => onReportMessage(row.message)
                  : undefined
              }
              onToggleReaction={onToggleReaction}
              onVotePoll={onVotePoll}
              onClosePoll={onClosePoll}
              onRetry={() =>
                row.message.nonce && onRetryMessage?.(row.message.nonce)
              }
              onDiscard={() =>
                row.message.nonce && onDiscardMessage?.(row.message.nonce)
              }
              onStartThread={
                onStartThread ? () => onStartThread(row.message) : undefined
              }
              onOpenThread={
                onOpenThread && row.message.thread
                  ? () => onOpenThread(row.message.thread!, row.message)
                  : undefined
              }
              isThreadOpen={
                row.message.thread?.channelId != null &&
                row.message.thread.channelId === activeThreadId
              }
              threadUnread={
                row.message.thread
                  ? unreadThreadIds.has(row.message.thread.channelId)
                  : false
              }
              showLinkEmbeds={showLinkEmbeds}
              isActive={row.message.id === effectiveActiveId}
              onFocusRow={() => setActiveMessageId(row.message.id)}
              onNavigate={handleRowNavigate}
              onMenuOpenRow={() => markMenuRow(row.message.id)}
              onMenuClose={(refocus) => {
                markMenuRow(null);
                if (refocus) {
                  requestAnimationFrame(() => {
                    rowNodes.current.get(row.message.id)?.focus();
                  });
                }
              }}
              authors={authors}
              roles={roles}
              unreadHeld={unreadHeld}
              onForward={onForward ? () => onForward(row.message) : undefined}
              onMarkUnread={
                onMarkUnread ? () => onMarkUnread(row.message) : undefined
              }
              onMarkRead={onMarkRead}
              showUnreadDivider={row.message.id === firstUnreadId}
              unreadDividerRef={
                row.message.id === firstUnreadId ? unreadDividerRef : undefined
              }
            />
            );
          })
        )}

        {hasNewer && (
          <div className="flex justify-center pt-3">
            {isLoadingNewer ? (
              <span className="flex items-center gap-2 text-xs text-paper-muted">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t("chat.loadingNewer")}
              </span>
            ) : (
              <button
                type="button"
                onClick={loadNewer}
                className="rounded-full border border-ink-4 px-3 py-1 text-xs text-paper-muted hover:text-paper"
              >
                {t("chat.loadNewer")}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Always mounted, text-only, and separate from the log itself — an
          aria-live region only announces changes to content already present,
          and a screen-reader user gets one short sentence per arrival instead
          of the message log announcing its own churn. */}
      <p role="status" aria-live="polite" className="sr-only">
        {liveAnnouncement}
      </p>

      <TypingIndicator users={typingUsers} />

      {jumpNotice && (
        <p
          role="status"
          className="animate-rise absolute bottom-16 right-4 z-10 max-w-[16rem] rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-text-muted shadow-lg"
        >
          {t("chat.jump.gone")}
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
            ? t("chat.jump.missed", { count: missedCount })
            : t("chat.jump.present")}
        </button>
      )}
    </div>
  );
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <p className="font-display text-xl font-bold text-paper">
        {t("chat.empty.title")}
      </p>
      <p className="max-w-xs text-sm text-paper-muted">
        {t("chat.empty.body")}
      </p>
    </div>
  );
}

function TypingIndicator({ users }: { users: TypingUser[] }) {
  const { t } = useTranslation();
  if (users.length === 0) {
    return null;
  }
  const names = users.map((user) => user.displayName);
  const label =
    names.length === 1
      ? t("chat.typing_one", { name: names[0]! })
      : names.length === 2
        ? t("chat.typing_two", { name: names[0]!, other: names[1]! })
        : t("chat.typing_other", { count: names.length });

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

/**
 * What a screen reader gets for one message, as a single accessible name on
 * its row: who, when, whether it answers something else, the content itself,
 * and anything else a sighted reader would pick up from the layout around it
 * — attachments, edited, pinned, reactions and whether the reader already
 * left one. One label read as one sentence, rather than the wall of
 * undifferentiated text a screen reader gets from walking five sibling
 * elements with no relationship declared between them.
 *
 * The body text is included even though it is also present as ordinary DOM
 * text: `aria-label` on the row is what gets read the moment the roving tab
 * stop lands here, and forcing a switch to browse-mode just to hear what the
 * message says would defeat the point of making it a single tab stop.
 */
function buildMessageAriaLabel(
  message: ChatMessage,
  isMine: boolean,
  gifMedia: GifMedia | null,
  currentUserId: string | null,
  mentionsYou: boolean,
): string {
  const parts: string[] = [];
  const who = isMine ? translateMessage("chat.you") : message.authorName;
  parts.push(
    `${who}${message.isWebhook ? translateMessage("chat.viaWebhook") : ""}, ${formatFullTimestamp(message.createdAt)}`,
  );

  if (message.replyTo) {
    parts.push(
      message.replyTo.deleted
        ? translateMessage("chat.replyDeleted")
        : translateMessage("chat.replyTo", {
            name: message.replyTo.authorName ?? "",
            excerpt: message.replyTo.excerpt ?? "",
          }),
    );
  }

  if (message.pending) {
    parts.push(translateMessage("chat.sending"));
  } else if (message.failed) {
    parts.push(translateMessage(failedSendKey(message.rejectReason)));
  }

  const attachmentCount = message.attachments?.length ?? 0;
  if (gifMedia) {
    parts.push(translateMessage("chat.gifAlt", { alt: gifMedia.alt }));
  } else if (message.body) {
    parts.push(message.body);
  } else if (
    attachmentCount === 0 &&
    message.webhookEmbeds.length === 0
  ) {
    parts.push(translateMessage("chat.attachmentUnavailable"));
  }

  if (attachmentCount > 0) {
    parts.push(
      translateMessage("chat.attachments", { count: attachmentCount }),
    );
  }

  if (mentionsYou) {
    parts.push(translateMessage("chat.mentionsYou"));
  }

  if (message.editedAt) {
    parts.push(translateMessage("chat.edited"));
  }
  if (message.pinnedAt) {
    parts.push(translateMessage("chat.pinned"));
  }
  if (message.thread) {
    parts.push(
      translateMessage("chat.hasThread", {
        name: message.thread.name,
        count: message.thread.replyCount,
      }),
    );
  }

  const reactions = message.reactions ?? [];
  if (reactions.length > 0) {
    const summary = reactions
      .map((r) => {
        const who =
          formatReactionWho(
            r.users,
            r.count,
            currentUserId,
            translateMessage,
          ) ||
          `${r.count}${r.me ? translateMessage("chat.youReacted") : ""}`;
        return `${r.emoji} ${who}`;
      })
      .join("; ");
    parts.push(translateMessage("chat.reactionsSummary", { summary }));
  }

  return parts.join(". ");
}

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
  onReport?: () => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onVotePoll?: (messageId: string, optionId: string) => void;
  onClosePoll?: (messageId: string) => void;
  onRetry: () => void;
  onDiscard: () => void;
  // --- threads ---
  /** Undefined when threads make no sense here (thread panel, conversations). */
  onStartThread?: () => void;
  /** Undefined until the message actually has a thread. */
  onOpenThread?: () => void;
  isThreadOpen: boolean;
  threadUnread: boolean;
  showLinkEmbeds: boolean;
  /** Whether this row is the one roving tab stop for the whole log. */
  isActive: boolean;
  /** Claims the roving tab stop — on click, or on receiving focus any other way. */
  onFocusRow: () => void;
  /** Arrow/Home/End at the log level; a no-op for keys it does not own. */
  onNavigate: (event: React.KeyboardEvent<HTMLElement>, messageId: string) => void;
  /** The native `contextmenu` event fired — by right-click, long-press, or the
   * keyboard Menu key / Shift+F10 once the row is focusable. */
  onMenuOpenRow: () => void;
  /** The menu closed. `refocus` is false for actions that already send focus
   * somewhere more useful (reply, edit, add-reaction all move it themselves). */
  onMenuClose: (refocus: boolean) => void;
  authors: ReadonlyMap<string, MessageAuthorInfo>;
  roles: readonly MessageRoleColor[];
  unreadHeld: boolean;
  onForward?: () => void;
  onMarkUnread?: () => void;
  onMarkRead?: () => void;
  showUnreadDivider?: boolean;
  unreadDividerRef?: Ref<HTMLDivElement>;
  /** This ping sits against the previous row's wash. */
  mentionJoinTop?: boolean;
  /** This ping sits against the next row's wash. */
  mentionJoinBottom?: boolean;
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
  onReport,
  onToggleReaction,
  onVotePoll,
  onClosePoll,
  onRetry,
  onDiscard,
  onStartThread,
  onOpenThread,
  isThreadOpen,
  threadUnread,
  showLinkEmbeds,
  isActive,
  onFocusRow,
  onNavigate,
  onMenuOpenRow,
  onMenuClose,
  authors,
  roles,
  unreadHeld,
  onForward,
  onMarkUnread,
  onMarkRead,
  showUnreadDivider = false,
  unreadDividerRef,
  mentionJoinTop = false,
  mentionJoinBottom = false,
}: MessageRowProps) {
  const { t } = useTranslation();
  const openProfile = useProfilePopover();
  const { message, startsGroup, dayLabel } = row;
  const authorInfo = authors.get(message.authorId);
  const mentionsYou = messageMentionsYou(
    message,
    currentUsername,
    currentUserId,
  );
  const moreRef = useRef<HTMLDivElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    if (!moreOpen) {
      return;
    }
    function onPointerDown(event: PointerEvent) {
      if (moreRef.current?.contains(event.target as Node)) {
        return;
      }
      setMoreOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMoreOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);
  // A body that is nothing but a GIF link is media, not prose — the URL is the
  // message, so it renders instead of the text rather than beside it.
  const gifMedia = useMemo(() => gifMessageMedia(message.body), [message.body]);
  const attachments = message.attachments ?? [];
  const isMine = message.authorId === currentUserId;
  const isReal = !message.pending && !message.failed;
  const canDelete = isReal && !!onDelete && (isMine || canModerate);
  const canReply = isReal && !!onReply;
  const isMessagePinned = Boolean(message.pinnedAt);
  // -1 outside the active row so Tab costs one stop per log, not one per
  // control on every message — see `isActive` on MessageRowProps.
  const controlTabIndex = isActive ? 0 : -1;
  const ariaLabel = useMemo(
    () =>
      buildMessageAriaLabel(
        message,
        isMine,
        gifMedia,
        currentUserId,
        mentionsYou,
      ),
    [message, isMine, gifMedia, currentUserId, mentionsYou],
  );
  // Mirrors the server's own gate: a conversation has no moderators, so
  // `serverId` being null means anyone already in it — proven just by being
  // able to see this row — may pin or unpin. A server channel needs the same
  // permission as every other moderation action, matching Discord's "Manage
  // Messages" rather than letting an author pin their own post unilaterally.
  const canPin =
    isReal && (serverId ? canModerate : true) && (onPin || onUnpin);
  const canReport = isReal && !isMine && !!onReport;
  const roleColor = message.isWebhook
    ? null
    : highestRoleColor(authorInfo?.roleIds, roles);

  function confirmDelete() {
    if (window.confirm(t("chat.deleteConfirm"))) {
      onDelete?.();
    }
  }

  /**
   * Wraps a menu item's action so the row also learns the menu just closed.
   * `refocus` is only for actions with nowhere else for focus to go —
   * reply, edit, and add-reaction each already move it themselves (into the
   * composer, the edit textarea, and the emoji panel respectively), so
   * sending focus back to the row right after would just fight them.
   */
  function selectAndClose(action: (() => void) | undefined, refocus: boolean) {
    return () => {
      action?.();
      onMenuClose(refocus);
    };
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
          tabIndex={isActive ? 0 : -1}
          aria-label={t("chat.blocked")}
          onFocus={onFocusRow}
          onKeyDown={(event) => onNavigate(event, message.id)}
          className="group mt-1 flex items-center gap-2 rounded-md px-5 py-1 text-xs text-paper-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
        >
          <span className="italic">{t("chat.blocked")}</span>
          <button
            type="button"
            tabIndex={controlTabIndex}
            onClick={onReveal}
            className="underline underline-offset-2 hover:text-paper"
          >
            {t("chat.showBlocked")}
          </button>
        </article>
      </>
    );
  }

  const reactions = message.reactions ?? [];

  // --- threads --- one item, whichever half applies: a message with a thread
  // opens it, a message without one starts it. Neither is offered where the
  // handlers were not passed (the thread panel itself, conversations).
  const threadAction =
    isReal && message.thread && onOpenThread
      ? { id: "open-thread", label: t("thread.open"), onSelect: onOpenThread }
      : isReal && !message.thread && onStartThread
        ? { id: "start-thread", label: t("thread.start"), onSelect: onStartThread }
        : null;

  const items: ContextMenuItemDef[] = [
    ...(canReply
      ? [
          { id: "reply", label: t("chat.reply"), onSelect: selectAndClose(onReply, false) },
        ]
      : []),
    ...(threadAction
      ? [
          {
            id: threadAction.id,
            label: threadAction.label,
            // Focus moves into the panel the action opens, so no refocus.
            onSelect: selectAndClose(threadAction.onSelect, false),
          },
        ]
      : []),
    ...(canReply || threadAction
      ? [{ id: "sep-reply", label: "", separator: true }]
      : []),
    {
      id: "copy-text",
      label: t("chat.copyText"),
      onSelect: selectAndClose(
        () => void navigator.clipboard.writeText(message.body),
        true,
      ),
    },
    {
      id: "copy-id",
      label: t("chat.copyId"),
      onSelect: selectAndClose(
        () => void navigator.clipboard.writeText(message.id),
        true,
      ),
    },
    ...(serverId && isReal
      ? [
          {
            id: "copy-link",
            label: t("chat.copyLink"),
            onSelect: selectAndClose(() => {
              const link = `${window.location.origin}${messageRoutePath(
                serverId,
                channelId ?? message.channelId,
                message.id,
              )}`;
              void navigator.clipboard.writeText(link);
            }, true),
          },
        ]
      : []),
    ...(isReal && onForward
      ? [
          {
            id: "forward",
            label: t("chat.forward"),
            onSelect: selectAndClose(onForward, false),
          },
        ]
      : []),
    ...(isReal && (unreadHeld ? onMarkRead : onMarkUnread)
      ? [
          {
            id: unreadHeld ? "mark-read" : "mark-unread",
            label: unreadHeld ? t("chat.markRead") : t("chat.markUnread"),
            onSelect: selectAndClose(
              unreadHeld ? onMarkRead : onMarkUnread,
              true,
            ),
          },
        ]
      : []),
    ...(isMine && isReal
      ? [
          { id: "sep-edit", label: "", separator: true },
          {
            id: "edit",
            label: t("chat.edit"),
            onSelect: selectAndClose(onStartEdit, false),
          },
        ]
      : []),
    ...(canPin
      ? [
          {
            id: "pin",
            label: isMessagePinned ? t("chat.unpin") : t("chat.pin"),
            onSelect: selectAndClose(
              isMessagePinned ? onUnpin : onPin,
              true,
            ),
          },
        ]
      : []),
    ...(canDelete
      ? [
          {
            id: "delete",
            label: t("chat.delete"),
            danger: true,
            onSelect: selectAndClose(confirmDelete, true),
          },
        ]
      : []),
    // Reporting your own message is meaningless, and a message that has not
    // been accepted by the server yet has no id to report.
    ...(canReport
      ? [
          {
            id: "report",
            label: t("chat.report"),
            danger: true,
            onSelect: selectAndClose(onReport, false),
          },
        ]
      : []),
  ];

  /**
   * The quick reactions, as a STRIP rather than as menu items.
   *
   * They used to be appended to `items` above, one `ContextMenuItemDef` per
   * emoji — and a menu item is a full-width row, so eight of them rendered as a
   * tall column of single emoji under an "Add reaction" heading. They are not
   * commands in a list; they are one control with eight cells, which is why
   * they now go through the menu's own `reactions` prop and get laid out in a
   * row at the top (see `ui/context-menu.tsx`).
   *
   * `label` still carries reaction state: a screen reader has no other way to
   * learn "you already reacted with this one" short of leaving the menu and
   * cross-referencing the reaction bar.
   */
  const quickReactions = isReal
    ? QUICK_REACTIONS.map((emoji) => {
        const mine = reactions.some((r) => r.emoji === emoji && r.me);
        return {
          emoji,
          label: mine ? t("chat.removeReaction", { emoji }) : undefined,
          active: mine,
          onSelect: selectAndClose(
            () => onToggleReaction(message.id, emoji),
            true,
          ),
        };
      })
    : undefined;

  return (
    <>
      {dayLabel && <DaySeparator label={dayLabel} />}
      {showUnreadDivider && (
        <UnreadSeparator
          dividerRef={unreadDividerRef}
          label={t("chat.unread.new")}
        />
      )}

      <ContextMenu
        items={items}
        reactions={quickReactions}
        reactionsLabel={t("reactions.quick")}
        onMoreReactions={
          isReal ? selectAndClose(onOpenPicker, false) : undefined
        }
        moreReactionsLabel={t("reactions.more")}
      >
        <article
          ref={(node) => {
            registerRow(message.id, node);
          }}
          tabIndex={isActive ? 0 : -1}
          aria-label={ariaLabel}
          onFocus={onFocusRow}
          onKeyDown={(event) => onNavigate(event, message.id)}
          // Merges with the handler Radix's Trigger already attaches (see
          // context-menu.tsx): this only records which row a keyboard-opened
          // menu belongs to, for the Escape-refocus effects above. It does
          // not open or block anything Radix already does on right-click,
          // long-press, or the native contextmenu event a focused element
          // gets from the keyboard Menu key / Shift+F10.
          onContextMenu={onMenuOpenRow}
          className={cn(
            "group relative flex items-start gap-0 px-5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
            startsGroup ? "mt-2 pt-1" : "pt-px",
            mentionJoinTop ? "pt-0" : null,
            mentionJoinBottom ? "pb-0" : startsGroup ? "pb-1" : "pb-px",
            mentionsYou && !isFlashing
              ? mentionRowRadius(mentionJoinTop, mentionJoinBottom)
              : null,
            message.pending && "opacity-60",
            isFlashing && "bg-accent/15 ring-1 ring-accent/50",
            mentionsYou && !isFlashing && "pqp-message-mention",
            !mentionsYou && !isFlashing && "hover:bg-ink-3/40",
          )}
        >
          {startsGroup ? (
            <div className="flex w-14 shrink-0 items-start justify-end pr-2">
              <div className="relative h-9 w-9 shrink-0">
                <AuthorButton
                  message={message}
                  author={authorInfo}
                  tabIndex={controlTabIndex}
                  onOpenProfile={openProfile}
                  className="block h-9 w-9 shrink-0 overflow-hidden rounded-lg leading-none hover:no-underline"
                >
                  <UserAvatar
                    name={message.authorName}
                    avatarUrl={message.authorAvatarUrl}
                    rounded="lg"
                    className="h-9 w-9"
                    fallbackClassName="bg-ink-3 text-sm"
                  />
                </AuthorButton>
                {!message.isWebhook && authorInfo?.status && (
                  <StatusDot
                    status={authorInfo.status}
                    className="absolute -bottom-0.5 -right-0.5"
                    ringClassName="rounded-full bg-channel ring-2 ring-channel"
                  />
                )}
              </div>
            </div>
          ) : (
            <time
              className="w-14 shrink-0 pr-2 text-right text-[12px] leading-[22px] whitespace-nowrap tabular-nums text-paper-muted opacity-0 group-hover:opacity-100"
              dateTime={message.createdAt}
              title={formatFullTimestamp(message.createdAt)}
            >
              {formatTime(message.createdAt)}
            </time>
          )}

          <div className="min-w-0 flex-1">
            {message.replyTo && (
              <ReplyQuote
                replyTo={message.replyTo}
                onJump={onJumpToMessage}
                tabIndex={controlTabIndex}
              />
            )}
            {startsGroup && (
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="inline-flex items-baseline gap-1">
                  <AuthorButton
                    message={message}
                    author={authorInfo}
                    tabIndex={controlTabIndex}
                    onOpenProfile={openProfile}
                    className={cn(
                      "rounded text-[15px] font-bold leading-[22px]",
                      !roleColor && (isMine ? "text-signal" : "text-paper"),
                    )}
                    style={roleColor ? { color: roleColor } : undefined}
                  >
                    {message.authorName}
                  </AuthorButton>
                  {/* The name#1234 tag is a lookup key, not reading material:
                      it lives on the profile card. Rank is a quiet glyph;
                      the role-coloured name is the primary signal. */}
                  <RankMarks
                    marks={identityMarks({
                      rank: authorInfo?.rank,
                      isWebhook: message.isWebhook,
                      isCharacter: authorInfo?.isCharacter,
                      ...rankBadges(authorInfo?.roleIds, roles),
                    })}
                  />
                </span>
                {message.isWebhook && (
                  <span
                    className="rounded bg-ink-4 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-paper-muted"
                    title={t("chat.webhookPosted")}
                  >
                    Webhook
                  </span>
                )}
                <time
                  className="whitespace-nowrap text-[12px] leading-[22px] text-paper-muted"
                  dateTime={message.createdAt}
                  title={formatFullTimestamp(message.createdAt)}
                >
                  {formatTime(message.createdAt)}
                </time>
                {isMessagePinned && (
                  <span
                    className="inline-flex items-center gap-0.5 text-[12px] leading-[22px] text-signal"
                    title={
                      message.pinnedBy
                        ? t("chat.pinnedBy", {
                            name: message.pinnedBy.displayName,
                          })
                        : t("chat.pinned")
                    }
                  >
                    <Pin className="h-3 w-3" aria-hidden />
                    <span className="sr-only">{t("chat.pinned")}</span>
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
                {message.chance ? (
                  <ChanceCard result={message.chance} />
                ) : message.poll ? (
                  <PollCard
                    poll={message.poll}
                    canManage={canModerate}
                    onVote={(optionId) => onVotePoll?.(message.id, optionId)}
                    onClose={() => onClosePoll?.(message.id)}
                  />
                ) : message.body ? (
                  <div className="markdown-body text-[15px] leading-[22px] text-paper/90">
                    <MessageBody
                      body={message.body}
                      currentUsername={currentUsername}
                    />
                    {attachments.length === 0 && (
                      <EditedMarker editedAt={message.editedAt} />
                    )}
                  </div>
                ) : null}
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
                      {t("chat.attachmentUnavailable")}
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
                {t(failedSendKey(message.rejectReason))}
                {messageRetryReady(message) && (
                  <button
                    type="button"
                    tabIndex={controlTabIndex}
                    onClick={onRetry}
                    className="underline underline-offset-2 hover:text-paper"
                  >
                    {t("chat.retry")}
                  </button>
                )}
                <button
                  type="button"
                  tabIndex={controlTabIndex}
                  onClick={onDiscard}
                  className="underline underline-offset-2 hover:text-paper"
                >
                  {t("chat.discard")}
                </button>
              </p>
            )}

            {isReal && (
              <ReactionBar
                reactions={reactions}
                currentUserId={currentUserId}
                isPickerOpen={isPickerOpen}
                onToggle={(emoji) => onToggleReaction(message.id, emoji)}
                onOpenPicker={onOpenPicker}
                onClosePicker={onClosePicker}
                tabIndex={controlTabIndex}
              />
            )}

            {/* --- threads --- the chip under the origin message. */}
            {isReal && message.thread && onOpenThread && (
              <ThreadChip
                thread={message.thread}
                unread={threadUnread}
                isOpen={isThreadOpen}
                onOpen={onOpenThread}
                tabIndex={controlTabIndex}
              />
            )}
          </div>

          {/* Right-click and long-press aren't available on every input, so
              this repeats the same actions as a visible toolbar on hover.
              Deliberately out of tab order (tabIndex={-1} throughout): every
              one of these is also in the context menu the row itself opens,
              so keyboard reach goes through that single, already-tested
              path rather than duplicating it four buttons at a time on
              every row's tab stop. */}
          {isReal && !isEditing && (
            <div
              className={cn(
                "absolute -top-3 right-2 z-10 items-center gap-0.5 rounded-md border border-ink-4 bg-ink-2 p-0.5 shadow-sm",
                moreOpen
                  ? "flex"
                  : "hidden group-hover:flex group-focus-within:flex",
              )}
              onContextMenu={forwardRowContextMenu}
            >
              {/* Hover-only by construction: this whole bar is out of tab
                  order (see above), so its tooltips are too. Nothing is lost —
                  the keyboard and screen-reader path to every one of these
                  actions is the row's context menu, which names them in a
                  list. */}
              {HOVER_QUICK_REACTIONS.map((emoji) => {
                const mine = reactions.some((r) => r.emoji === emoji && r.me);
                return (
                  <Tooltip
                    key={emoji}
                    label={
                      mine
                        ? t("chat.removeReaction", { emoji })
                        : t("chat.reactWith", { emoji })
                    }
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      tabIndex={-1}
                      className={cn("h-6 w-6 text-sm", mine && "bg-ink-3")}
                      onClick={() => onToggleReaction(message.id, emoji)}
                    >
                      {emoji}
                    </Button>
                  </Tooltip>
                );
              })}
              <Tooltip label={t("chat.addReaction")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  tabIndex={-1}
                  className="h-6 w-6"
                  onClick={onOpenPicker}
                >
                  <SmilePlus className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
              {canReply && (
                <Tooltip label={t("chat.reply")}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    tabIndex={-1}
                    className="h-6 w-6"
                    onClick={onReply}
                  >
                    <Reply className="h-3.5 w-3.5" />
                  </Button>
                </Tooltip>
              )}
              {isMine && (
                <Tooltip label={t("chat.edit")}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    tabIndex={-1}
                    className="h-6 w-6"
                    onClick={onStartEdit}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </Tooltip>
              )}
              <div ref={moreRef} className="relative">
                <Tooltip label={t("chat.more")}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    tabIndex={-1}
                    aria-haspopup="menu"
                    aria-expanded={moreOpen}
                    className="h-6 w-6"
                    onClick={() => setMoreOpen((open) => !open)}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </Tooltip>
                {moreOpen && (
                  <div
                    role="menu"
                    aria-label={t("chat.more")}
                    className="absolute right-0 top-full z-20 mt-0.5 max-h-[18rem] w-48 overflow-y-auto rounded-md border border-ink-4 bg-ink-2 p-1 shadow-[var(--shadow-popover)]"
                  >
                    {canPin && (
                      <MoreMenuItem
                        onSelect={() => {
                          (isMessagePinned ? onUnpin : onPin)?.();
                          setMoreOpen(false);
                        }}
                      >
                        {isMessagePinned ? t("chat.unpin") : t("chat.pin")}
                      </MoreMenuItem>
                    )}
                    <MoreMenuItem
                      onSelect={() => {
                        const link = `${window.location.origin}${messageRoutePath(
                          serverId,
                          channelId ?? message.channelId,
                          message.id,
                        )}`;
                        void navigator.clipboard.writeText(link);
                        setMoreOpen(false);
                      }}
                    >
                      {t("chat.copyLink")}
                    </MoreMenuItem>
                    {onForward && (
                      <MoreMenuItem
                        onSelect={() => {
                          onForward();
                          setMoreOpen(false);
                        }}
                      >
                        {t("chat.forward")}
                      </MoreMenuItem>
                    )}
                    {(unreadHeld ? onMarkRead : onMarkUnread) && (
                      <MoreMenuItem
                        onSelect={() => {
                          (unreadHeld ? onMarkRead : onMarkUnread)?.();
                          setMoreOpen(false);
                        }}
                      >
                        {unreadHeld ? t("chat.markRead") : t("chat.markUnread")}
                      </MoreMenuItem>
                    )}
                    {canReport && (
                      <MoreMenuItem
                        danger
                        onSelect={() => {
                          onReport?.();
                          setMoreOpen(false);
                        }}
                      >
                        {t("chat.report")}
                      </MoreMenuItem>
                    )}
                    {onStartThread && !message.thread && (
                      <MoreMenuItem
                        onSelect={() => {
                          onStartThread();
                          setMoreOpen(false);
                        }}
                      >
                        {t("thread.start")}
                      </MoreMenuItem>
                    )}
                    {canDelete && (
                      <MoreMenuItem
                        danger
                        onSelect={() => {
                          setMoreOpen(false);
                          confirmDelete();
                        }}
                      >
                        {t("chat.delete")}
                      </MoreMenuItem>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </article>
      </ContextMenu>
    </>
  );
});

/**
 * The author's avatar, or their name — whichever was clicked, it opens their
 * profile card.
 *
 * LEFT-click. Until this existed the only affordance on an author was the
 * row's right-click menu, which is not an affordance at all on a trackpad you
 * have never right-clicked, and there was no route to "add friend" from a
 * conversation. It stays a `<span>` for the two authors a profile makes no
 * sense for — a webhook is not an account, and a message the server has not
 * accepted yet has nothing to look up.
 */
function AuthorButton({
  message,
  author,
  className,
  style,
  tabIndex,
  onOpenProfile,
  children,
}: {
  message: ChatMessage;
  author?: MessageAuthorInfo;
  className?: string;
  style?: CSSProperties;
  tabIndex: number;
  onOpenProfile: (subject: ProfileSubject, anchor: HTMLElement) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const isReal = !message.pending && !message.failed;
  if (message.isWebhook || !isReal) {
    return (
      <span className={className} style={style}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      tabIndex={tabIndex}
      title={t("profile.open", { name: message.authorName })}
      data-author-trigger={message.authorId}
      style={style}
      className={cn(
        "text-left hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
        className,
      )}
      onClick={(event) => {
        // The row itself has a click handler for focus; the profile is the
        // more specific intent, so it does not also select the row.
        event.stopPropagation();
        onOpenProfile(
          {
            id: message.authorId,
            displayName: message.authorName,
            tag: message.authorTag ?? null,
            avatarUrl: message.authorAvatarUrl ?? null,
            status: author?.status ?? null,
            username:
              author?.username ?? usernameFromTag(message.authorTag),
            roleIds: author?.roleIds,
            rank: author?.rank,
            isCharacter: author?.isCharacter,
          },
          event.currentTarget,
        );
      }}
    >
      {children}
    </button>
  );
}

/** The date rule between two days of messages. */
function DaySeparator({ label }: { label: string }) {
  return (
    <div className="my-4 flex items-center gap-3 px-5" role="separator">
      <span className="h-px flex-1 bg-ink-4/60" />
      <span className="text-[11px] font-medium uppercase tracking-wider text-paper-muted">
        {label}
      </span>
      <span className="h-px flex-1 bg-ink-4/60" />
    </div>
  );
}

/** The NEW rule: first unread message of this visit. */
function UnreadSeparator({
  label,
  dividerRef,
}: {
  label: string;
  dividerRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={dividerRef}
      className="my-2 flex items-center gap-3 px-5"
      role="separator"
      aria-label={label}
    >
      <span className="h-px flex-1 bg-danger" />
      <span className="text-[11px] font-semibold uppercase tracking-wider text-danger">
        {label}
      </span>
    </div>
  );
}

function MoreMenuItem({
  children,
  onSelect,
  danger = false,
}: {
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cn(
        "flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm outline-none hover:bg-ink-3 focus-visible:bg-ink-3",
        danger ? "text-danger" : "text-paper",
      )}
      onClick={onSelect}
    >
      {children}
    </button>
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
      ({translateMessage("chat.edited")})
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
export function GifAttachment({ media }: { media: GifMedia }) {
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
      aria-label={translateMessage("chat.playMedia", { name: media.alt })}
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
  tabIndex,
}: {
  replyTo: NonNullable<ChatMessage["replyTo"]>;
  onJump: (messageId: string) => void;
  /** -1 outside the active row — see `controlTabIndex` in MessageRow. */
  tabIndex: number;
}) {
  const { t } = useTranslation();
  if (replyTo.deleted) {
    return (
      <p className="mb-0.5 flex items-center gap-1.5 text-xs text-text-muted">
        <CornerUpLeft className="h-3 w-3 shrink-0" />
        <span className="italic">{t("chat.originalDeleted")}</span>
      </p>
    );
  }

  return (
    <button
      type="button"
      tabIndex={tabIndex}
      onClick={() => onJump(replyTo.id)}
      aria-label={t("chat.jumpToReply", {
        name: replyTo.authorName ?? "",
        excerpt: replyTo.excerpt ?? "",
      })}
      className="mb-0.5 flex w-full min-w-0 items-center gap-1.5 text-left text-xs text-text-muted hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
    >
      <CornerUpLeft className="h-3 w-3 shrink-0" aria-hidden />
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
  const { t } = useTranslation();
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
        aria-label={t("chat.edit")}
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
  currentUserId: string | null;
  isPickerOpen: boolean;
  onToggle: (emoji: string) => void;
  onOpenPicker: () => void;
  onClosePicker: () => void;
  /** -1 outside the active row — see `controlTabIndex` in MessageRow. */
  tabIndex: number;
}

function ReactionWhoTip({
  anchor,
  children,
}: {
  anchor: DOMRect;
  children: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    if (!ref.current) {
      return;
    }
    const box = ref.current.getBoundingClientRect();
    setSize({ width: box.width, height: box.height });
  }, [children]);

  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const placed = size
    ? placeAnchoredPanel(anchor, size, viewport, "above")
    : null;
  const left = size
    ? Math.min(
        Math.max(
          ANCHORED_PANEL_PAD,
          anchor.left + (anchor.right - anchor.left) / 2 - size.width / 2,
        ),
        Math.max(ANCHORED_PANEL_PAD, viewport.width - size.width - ANCHORED_PANEL_PAD),
      )
    : 0;

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      style={{
        position: "fixed",
        top: placed?.top ?? 0,
        left,
        visibility: placed ? "visible" : "hidden",
      }}
      className="z-[130] max-w-64 rounded-md border border-ink-4 bg-ink-2 px-2 py-1 text-xs text-paper shadow-[var(--shadow-popover)]"
    >
      {children}
    </div>,
    document.body,
  );
}

function ReactionChip({
  reaction,
  currentUserId,
  onToggle,
  tabIndex,
}: {
  reaction: MessageReaction;
  currentUserId: string | null;
  onToggle: (emoji: string) => void;
  tabIndex: number;
}) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const named = formatReactionWho(
    reaction.users,
    reaction.count,
    currentUserId,
    t,
  );
  const who = named || t("chat.reaction.people", { count: reaction.count });
  const tooltip = t("chat.reaction.tooltip", {
    names: who,
    emoji: reaction.emoji,
    count: reaction.count,
  });
  const ariaLabel = named
    ? t(reaction.me ? "chat.reaction.ariaWhoMine" : "chat.reaction.ariaWho", {
        emoji: reaction.emoji,
        names: named,
      })
    : t(reaction.me ? "chat.reaction.ariaMine" : "chat.reaction.aria", {
        emoji: reaction.emoji,
        people: who,
      });

  return (
    <>
      <button
        type="button"
        tabIndex={tabIndex}
        onClick={() => onToggle(reaction.emoji)}
        onPointerEnter={(event) =>
          setAnchor(event.currentTarget.getBoundingClientRect())
        }
        onPointerLeave={() => setAnchor(null)}
        onFocus={(event) =>
          setAnchor(event.currentTarget.getBoundingClientRect())
        }
        onBlur={() => setAnchor(null)}
        aria-pressed={reaction.me}
        aria-label={ariaLabel}
        className={cn(
          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
          reaction.me
            ? "border-signal/50 bg-signal/15 text-signal"
            : "border-ink-4 bg-ink-3/80 text-paper-muted hover:border-ink-4 hover:text-paper",
        )}
      >
        <span className="text-sm leading-none" aria-hidden>
          {reaction.emoji}
        </span>
        <span className="font-medium tabular-nums">{reaction.count}</span>
      </button>
      {anchor && <ReactionWhoTip anchor={anchor}>{tooltip}</ReactionWhoTip>}
    </>
  );
}

function ReactionBar({
  reactions,
  currentUserId,
  isPickerOpen,
  onToggle,
  onOpenPicker,
  onClosePicker,
  tabIndex,
}: ReactionBarProps) {
  const { t } = useTranslation();
  const hasReactions = reactions.length > 0;

  if (!hasReactions && !isPickerOpen) {
    return null;
  }

  return (
    <div className="relative mt-1.5 flex w-fit max-w-full flex-wrap items-center gap-1">
      {reactions.map((reaction) => (
        <ReactionChip
          key={reaction.emoji}
          reaction={reaction}
          currentUserId={currentUserId}
          onToggle={onToggle}
          tabIndex={tabIndex}
        />
      ))}
      <button
        type="button"
        tabIndex={tabIndex}
        aria-label={t("chat.addReaction")}
        onClick={onOpenPicker}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-dashed border-ink-4 text-paper-muted hover:border-signal/50 hover:text-signal focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
      >
        <SmilePlus className="h-3 w-3" />
      </button>
      {isPickerOpen && (
        <EmojiPickerPanel
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

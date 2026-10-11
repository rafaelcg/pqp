import type { DmSummary, PublicUser, UnreadCounts, UserStatus } from "@pqp/shared";
import { BellOff, Phone, Pin, Search, SquarePen, Users, X } from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { DraftMark, formatBadgeCount } from "@/components/layout/channel-list";
import { useConversationRowMenu } from "@/components/conversations/use-conversation-row-menu";
import { SidebarResizeHandle } from "@/components/layout/sidebar-resize-handle";
import { useFriends } from "@/components/friends/use-friends";
import { ContextMenu } from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { RadioGroup } from "@/components/ui/radio-group";
import { ChannelListSkeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { StatusDot } from "@/components/user/status-dot";
import { UserAvatar } from "@/components/user/user-avatar";
import { useChannelSidebarWidth } from "@/hooks/use-channel-sidebar-width";
import { useFlipList } from "@/hooks/use-flip-list";
import { useNotificationState } from "@/hooks/use-notifications";
import { CONVERSATION_SIDEBAR_SLOT } from "@/lib/channel-sidebar-width";
import {
  conversationsWithUnread,
  filterConversations,
  splitPinned,
  type ConversationFilter,
} from "@/lib/conversation-list";
import { useListTyping } from "@/lib/conversation-typing";
import { formatMessagePreview } from "@/lib/conversations";
import { useHasDraft } from "@/lib/composer-drafts";
import { useTranslation } from "@/lib/i18n";
import { resolveNotificationLevel } from "@/lib/notifications";
import { cn, formatFullTimestamp, formatRecency } from "@/lib/utils";

const EMPTY_UNREAD: UnreadCounts = { count: 0, mentions: 0 };

export interface ConversationHomeListProps {
  conversations: DmSummary[];
  selectedChannelId: string | null;
  unread: Record<string, UnreadCounts>;
  isLoading?: boolean;
  blockedUserIds: ReadonlySet<string>;
  viewerId: string | null;
  onSelectConversation: (channelId: string) => void;
  onStartConversation: () => void;
  friendsSelected?: boolean;
  onOpenFriends?: () => void;
  friendRequestCount?: number;
  onHideConversation: (channelId: string) => void;
  /** Pinned conversation ids, in pin order: the rail's order, and the Fixadas order. */
  pinnedIds?: readonly string[];
  onTogglePin?: (channelId: string) => void;
  onBlockUser: (user: PublicUser) => void;
  onUnblockUser: (userId: string) => void;
  onStartCall?: (channelId: string) => void;
  activeCallChannelIds?: ReadonlySet<string>;
  /** Drawn in the main pane's place when there is nothing to list (W6). */
  footer?: ReactNode;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  /**
   * The phone shell draws the list full screen as a tab, not as a drawer
   * beside the rail. Set by the bottom-bar layout only.
   */
  fullScreen?: boolean;
}

/**
 * CONVERSAS: the conversation list as a place of its own, not a drawer of the
 * Friends page. Behind `conversations_home` (`lib/conversations-config.ts`);
 * with it off, `DmList` draws exactly what it always drew.
 *
 * WhatsApp's anatomy, because that is what people already know how to read:
 * a face with presence (friends only, from the presence the client already
 * polls, so nobody who merely wrote to you learns whether you are around),
 * name, the last line, the time in the accent while unread, the count,
 * "digitando…" in place of the preview, pin and mute glyphs. Search and the
 * Tudo / Não lidas / Grupos chips work on the list already in memory.
 *
 * STABLE HOOKS FOR THEMES. Every part a theme might reskin carries a
 * `data-conversations-*` attribute and only token classes, so a look (the
 * "Modo 2005" skin, for one) can restyle the column from CSS without forking
 * this component.
 */
export function ConversationHomeList({
  conversations,
  selectedChannelId,
  unread,
  isLoading = false,
  blockedUserIds,
  viewerId,
  onSelectConversation,
  onStartConversation,
  friendsSelected = false,
  onOpenFriends,
  friendRequestCount = 0,
  onHideConversation,
  pinnedIds = [],
  onTogglePin,
  onBlockUser,
  onUnblockUser,
  onStartCall,
  activeCallChannelIds,
  footer,
  mobileOpen = false,
  onMobileClose,
  fullScreen = false,
}: ConversationHomeListProps) {
  const { t } = useTranslation();
  const {
    width: sidebarWidth,
    maxWidth: sidebarMaxWidth,
    setWidth: setSidebarWidth,
    commitWidth: commitSidebarWidth,
  } = useChannelSidebarWidth(CONVERSATION_SIDEBAR_SLOT);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ConversationFilter>("all");
  const friends = useFriends();
  const notifications = useNotificationState();
  const typing = useListTyping();

  const statusById = useMemo(() => {
    const map = new Map<string, UserStatus>();
    for (const friend of friends.data.friends) {
      map.set(friend.id, friend.status);
    }
    return map;
  }, [friends.data.friends]);

  const isMuted = (channelId: string) =>
    resolveNotificationLevel(notifications, null, channelId) === "none";
  const unreadConversations = conversationsWithUnread(conversations, unread, {
    openChannelId: selectedChannelId,
    isMuted,
  }).length;

  const visible = filterConversations(conversations, {
    query,
    filter,
    unread,
    openChannelId: selectedChannelId,
  });
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const { pinned, recent } = splitPinned(visible, pinnedIds);
  // A conversation that just got a line moves to the top of Recentes: glide
  // it there rather than teleport it (reduced motion: no animation at all).
  const rowsRef = useRef<HTMLDivElement>(null);
  useFlipList(
    rowsRef,
    [...pinned, ...recent].map((one) => one.channelId).join(","),
  );

  const open = (channelId: string) => {
    onSelectConversation(channelId);
    onMobileClose?.();
  };

  const renderRow = (conversation: DmSummary) => (
    <ConversationHomeRow
      key={conversation.channelId}
      conversation={conversation}
      selected={selectedChannelId === conversation.channelId}
      unread={unread[conversation.channelId] ?? EMPTY_UNREAD}
      blockedUserIds={blockedUserIds}
      viewerId={viewerId}
      status={
        conversation.participants.length === 1
          ? (statusById.get(conversation.participants[0]!.id) ?? null)
          : null
      }
      typingNames={typing.get(conversation.channelId) ?? null}
      onSelect={() => open(conversation.channelId)}
      onHide={() => onHideConversation(conversation.channelId)}
      pinned={pinnedSet.has(conversation.channelId)}
      onTogglePin={onTogglePin ? () => onTogglePin(conversation.channelId) : undefined}
      onBlock={onBlockUser}
      onUnblock={onUnblockUser}
      hasActiveCall={activeCallChannelIds?.has(conversation.channelId) ?? false}
      onStartCall={
        onStartCall
          ? () => {
              onStartCall(conversation.channelId);
              onMobileClose?.();
            }
          : undefined
      }
    />
  );

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
    } else if (event.key === "Enter") {
      const first = pinned[0] ?? recent[0];
      if (first) {
        event.preventDefault();
        open(first.channelId);
      }
    }
  };

  const iconButton =
    "relative flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] text-text-tertiary hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

  return (
    <aside
      data-immersive-hide=""
      data-conversations=""
      aria-label={t("conversations.title")}
      style={{ "--channel-sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      className={cn(
        "flex flex-col border-r border-border bg-surface-1",
        fullScreen
          ? "min-h-0 w-full flex-1"
          : [
              // The same drawer-below-md shell as `DmList`; see the comment
              // there for why both `md:relative` and `md:left-auto` matter.
              "fixed inset-y-0 left-[72px] z-30 w-[min(100%-72px,20rem)] transition-transform duration-[var(--duration-slow)] ease-[var(--ease-emphasized)] md:relative md:left-auto md:z-auto md:w-[var(--channel-sidebar-width)] md:translate-x-0",
              mobileOpen ? "translate-x-0" : "-translate-x-[calc(100%+72px)] md:translate-x-0",
            ],
      )}
    >
      {!fullScreen && (
        <SidebarResizeHandle
          width={sidebarWidth}
          maxWidth={sidebarMaxWidth}
          onWidthChange={setSidebarWidth}
          onCommit={commitSidebarWidth}
        />
      )}
      <div
        data-conversations-header=""
        className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border pl-4 pr-2"
      >
        <h2 className="truncate font-display text-lg font-semibold text-text">
          {t("conversations.title")}
        </h2>
        <div className="flex items-center gap-0.5">
          {onOpenFriends && (
            <Tooltip label={t("conversations.friends")}>
              <button
                type="button"
                data-conversations-friends=""
                aria-current={friendsSelected ? "page" : undefined}
                className={cn(iconButton, friendsSelected && "bg-surface-2 text-text")}
                onClick={() => {
                  onOpenFriends();
                  onMobileClose?.();
                }}
              >
                <Users className="h-[18px] w-[18px]" aria-hidden="true" />
                {friendRequestCount > 0 && (
                  <>
                    <span
                      aria-hidden="true"
                      data-friend-requests={friendRequestCount}
                      className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold leading-none tabular-nums text-on-accent ring-2 ring-surface-1"
                    >
                      {formatBadgeCount(friendRequestCount)}
                    </span>
                    <span className="sr-only">
                      {t("friends.pendingBadge", { count: friendRequestCount })}
                    </span>
                  </>
                )}
              </button>
            </Tooltip>
          )}
          <Tooltip label={t("conversations.new")}>
            <button
              type="button"
              data-conversations-new=""
              className={iconButton}
              onClick={onStartConversation}
            >
              <SquarePen className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>
          </Tooltip>
          {onMobileClose && !fullScreen && (
            <button
              type="button"
              className={cn(iconButton, "md:hidden")}
              aria-label={t("dm.closeList")}
              onClick={onMobileClose}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {conversations.length > 0 && (
        <div data-conversations-tools="" className="shrink-0 space-y-2.5 px-3 pb-1 pt-3">
          <label className="block">
            <span className="sr-only">{t("conversations.search.label")}</span>
            <Input
              type="search"
              data-conversations-search=""
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder={t("conversations.search.placeholder")}
              prefix={<Search className="mr-2 block h-4 w-4" aria-hidden="true" />}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div data-conversations-filters="">
            <RadioGroup
              variant="chips"
              size="sm"
              label={t("conversations.filter.label")}
              value={filter}
              onValueChange={setFilter}
              options={[
                { value: "all", label: t("conversations.filter.all") },
                {
                  value: "unread",
                  label: t("conversations.filter.unread"),
                  trailing:
                    unreadConversations > 0 ? (
                      <span
                        data-conversations-unread-count={unreadConversations}
                        className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold leading-none tabular-nums text-on-danger"
                      >
                        {formatBadgeCount(unreadConversations)}
                      </span>
                    ) : undefined,
                },
                { value: "groups", label: t("conversations.filter.groups") },
              ]}
            />
          </div>
        </div>
      )}

      <div ref={rowsRef} data-conversations-rows="" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-1">
        {isLoading ? (
          <ChannelListSkeleton />
        ) : conversations.length === 0 ? (
          <p
            data-conversations-empty=""
            className="px-2 py-4 text-sm leading-relaxed text-text-tertiary"
          >
            {t("conversations.empty.list")}
          </p>
        ) : visible.length === 0 ? (
          <div data-conversations-empty="" className="px-2 py-4 text-sm text-text-tertiary">
            <p>
              {query.trim()
                ? t("conversations.noMatch", { query: query.trim() })
                : filter === "unread"
                  ? t("conversations.empty.unread")
                  : t("conversations.empty.groups")}
            </p>
            {query.trim() && (
              <button
                type="button"
                className="mt-2 text-sm font-medium text-accent underline-offset-2 hover:underline"
                onClick={onStartConversation}
              >
                {t("conversations.noMatch.cta")}
              </button>
            )}
          </div>
        ) : (
          <>
            {pinned.length > 0 && (
              <section data-conversations-section="pinned">
                <SectionLabel icon>{t("conversations.section.pinned")}</SectionLabel>
                {pinned.map(renderRow)}
              </section>
            )}
            {recent.length > 0 && (
              <section data-conversations-section="recent">
                {pinned.length > 0 && (
                  <SectionLabel>{t("conversations.section.recent")}</SectionLabel>
                )}
                {recent.map(renderRow)}
              </section>
            )}
          </>
        )}
      </div>

      {footer}
    </aside>
  );
}

function SectionLabel({ children, icon = false }: { children: ReactNode; icon?: boolean }) {
  return (
    <h3
      data-conversations-section-label=""
      className="flex items-center gap-1.5 px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary"
    >
      {icon && <Pin className="h-3 w-3" aria-hidden="true" />}
      {children}
    </h3>
  );
}

function ConversationHomeRow({
  conversation,
  selected,
  unread,
  blockedUserIds,
  viewerId,
  status,
  typingNames,
  onSelect,
  onHide,
  pinned,
  onTogglePin,
  onBlock,
  onUnblock,
  hasActiveCall,
  onStartCall,
}: {
  conversation: DmSummary;
  selected: boolean;
  unread: UnreadCounts;
  blockedUserIds: ReadonlySet<string>;
  viewerId: string | null;
  /** A friend's presence, for a 1:1 with a friend; null otherwise. */
  status: UserStatus | null;
  typingNames: readonly string[] | null;
  onSelect: () => void;
  onHide: () => void;
  pinned: boolean;
  onTogglePin?: () => void;
  onBlock: (user: PublicUser) => void;
  onUnblock: (userId: string) => void;
  hasActiveCall: boolean;
  onStartCall?: () => void;
}) {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLDivElement>(null);
  const { items, notifications, title, blocked } = useConversationRowMenu({
    conversation,
    blockedUserIds,
    rowRef,
    onHide,
    pinned,
    onTogglePin,
    onBlock,
    onUnblock,
  });
  const muted = notifications.level === "none";
  const isGroup = conversation.kind === "group";
  const hasUnread = !selected && unread.count > 0;
  const loud = hasUnread && !muted;
  const hasDraft = useHasDraft(conversation.channelId) && !selected;
  const mentions = selected || muted ? 0 : unread.mentions;
  const badge = mentions > 0 ? mentions : muted || selected ? 0 : unread.count;
  // The open conversation already says who is typing under its messages.
  const typist = !selected && typingNames && typingNames.length > 0 ? typingNames : null;

  const secondLine = typist ? (
    <span data-conversations-typing="" className="italic text-accent">
      {isGroup
        ? t("conversations.typingNamed", {
            name: typist[0]!.split(" ")[0] || typist[0]!,
          })
        : t("conversations.typing")}
    </span>
  ) : hasActiveCall ? (
    <span className="font-medium text-success">{t("conversations.inCall")}</span>
  ) : conversation.lastMessage ? (
    formatMessagePreview(conversation.lastMessage, { viewerId, isGroup })
  ) : null;

  return (
    <ContextMenu items={items}>
      <div
        ref={rowRef}
        data-conversation-row=""
        data-flip-key={conversation.channelId}
        data-kind={conversation.kind}
        data-selected={selected ? "" : undefined}
        data-unread={loud ? "" : undefined}
        data-muted={muted ? "" : undefined}
        data-pinned={pinned ? "" : undefined}
        data-typing={typist ? "" : undefined}
        className={cn(
          "group relative mb-0.5 flex items-center rounded-[var(--radius-card)]",
          selected ? "bg-surface-2" : "hover:bg-surface-2/60",
        )}
      >
        {loud && (
          <span
            aria-hidden="true"
            className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-text"
          />
        )}
        <button
          type="button"
          onClick={onSelect}
          aria-current={selected ? "page" : undefined}
          className="flex min-h-[60px] min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-card)] px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
        >
          <ConversationFace
            participants={conversation.participants}
            status={status}
            dimmed={muted && !selected}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span
                data-conversations-name=""
                className={cn(
                  "truncate text-sm",
                  loud ? "font-semibold text-text" : muted ? "text-text-tertiary" : "font-medium text-text",
                )}
              >
                {title}
              </span>
              {isGroup && (
                <span className="shrink-0 rounded-[var(--radius-tick)] bg-surface-3/60 px-1 text-[10px] font-semibold tabular-nums text-text-tertiary">
                  {conversation.participants.length + 1}
                </span>
              )}
              {hasDraft && <DraftMark />}
              {blocked && <span className="sr-only">{t("chrome.blockedSr")}</span>}
              {loud && <span className="sr-only">{t("chrome.unreadSr")}</span>}
              {muted && <span className="sr-only">{t("chrome.mutedSr")}</span>}
              {pinned && <span className="sr-only">{t("conversations.pinnedSr")}</span>}
              {conversation.lastMessageAt && (
                <time
                  dateTime={conversation.lastMessageAt}
                  title={formatFullTimestamp(conversation.lastMessageAt)}
                  data-dm-recency=""
                  className={cn(
                    "ml-auto shrink-0 pl-2 text-[11px] tabular-nums transition-opacity duration-[var(--duration-fast)]",
                    onStartCall && !blocked && "group-hover:opacity-0 group-focus-within:opacity-0",
                    loud ? "font-semibold text-accent" : "text-text-tertiary",
                  )}
                >
                  {formatRecency(conversation.lastMessageAt)}
                </time>
              )}
            </span>
            <span className="mt-0.5 flex items-center gap-2">
              <span
                data-conversations-preview=""
                className={cn(
                  "min-w-0 flex-1 truncate text-[13px]",
                  loud ? "text-text-secondary" : "text-text-tertiary",
                )}
              >
                {secondLine}
              </span>
              {badge > 0 ? (
                <span
                  key={badge}
                  data-dm-unread=""
                  className="inline-flex h-[18px] min-w-[18px] shrink-0 animate-badge-pop items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold leading-none tabular-nums text-on-danger"
                  aria-label={
                    mentions > 0
                      ? t("chrome.unreadMentions", { count: mentions })
                      : t("notify.messages", { count: badge })
                  }
                >
                  {formatBadgeCount(badge)}
                </span>
              ) : muted ? (
                <BellOff className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
              ) : pinned ? (
                <Pin className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
              ) : null}
            </span>
          </span>
        </button>
        {/* The call door, where the time sits, on hover or focus; always on
            while a call is live here. Hidden for a blocked 1:1, as before. */}
        {onStartCall && !blocked && (
          <Tooltip
            label={t(hasActiveCall ? "call.panel.join" : "call.startVoice")}
            name={`${t(hasActiveCall ? "call.panel.join" : "call.startVoice")}: ${title}`}
          >
            <button
              type="button"
              data-conversations-call=""
              className={cn(
                "absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] hover:bg-surface-3 focus-visible:opacity-100",
                hasActiveCall
                  ? "text-success opacity-0 group-hover:opacity-100"
                  : "text-text-tertiary opacity-0 hover:text-text group-focus-within:opacity-100 group-hover:opacity-100",
              )}
              onClick={onStartCall}
            >
              <Phone className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </div>
    </ContextMenu>
  );
}

/** A face with presence for a 1:1; two overlapped faces for a group. */
function ConversationFace({
  participants,
  status,
  dimmed,
}: {
  participants: readonly PublicUser[];
  status: UserStatus | null;
  dimmed: boolean;
}) {
  if (participants.length === 0) {
    return (
      <span
        aria-hidden="true"
        className="h-10 w-10 shrink-0 rounded-full bg-surface-2"
      />
    );
  }
  if (participants.length === 1) {
    const person = participants[0]!;
    return (
      <span data-conversations-face="" className="relative shrink-0">
        <UserAvatar
          name={person.displayName}
          avatarUrl={person.avatarUrl}
          className="h-10 w-10"
          fallbackClassName="bg-surface-3 text-sm font-semibold text-text"
          rounded="full"
          dimmed={dimmed}
        />
        {status && (
          <StatusDot
            status={status}
            size="md"
            ringClassName="rounded-full ring-[3px] ring-surface-1 group-hover:ring-surface-2 group-data-[selected]:ring-surface-2"
            className="absolute -bottom-0.5 -right-0.5 bg-surface-1"
          />
        )}
      </span>
    );
  }
  const [first, second] = participants;
  return (
    <span data-conversations-face="" aria-hidden="true" className="relative h-10 w-10 shrink-0">
      <UserAvatar
        name={first!.displayName}
        avatarUrl={first!.avatarUrl}
        className="absolute left-0 top-0 h-7 w-7"
        fallbackClassName="bg-surface-3 text-[11px] font-semibold text-text"
        rounded="full"
        dimmed={dimmed}
      />
      <span className="absolute bottom-0 right-0 rounded-full ring-2 ring-surface-1">
        <UserAvatar
          name={second!.displayName}
          avatarUrl={second!.avatarUrl}
          className="h-7 w-7"
          fallbackClassName="bg-surface-3 text-[11px] font-semibold text-text"
          rounded="full"
          dimmed={dimmed}
        />
      </span>
    </span>
  );
}

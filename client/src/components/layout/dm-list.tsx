import type { DmSummary, PublicUser } from "@pqp/shared";
import { BellOff, Phone, Plus, Users, X } from "lucide-react";
import { useRef, type CSSProperties, type ReactNode } from "react";
import { ConversationHomeList } from "@/components/conversations/conversation-home-list";
import { useConversationRowMenu } from "@/components/conversations/use-conversation-row-menu";
import { useHasDraft } from "@/lib/composer-drafts";
import { DraftMark } from "@/components/layout/channel-list";
import {
  formatBadgeCount,
  type UnreadState,
} from "@/components/layout/channel-list";
import { ContextMenu } from "@/components/ui/context-menu";
import { ChannelListSkeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";
import { SidebarResizeHandle } from "@/components/layout/sidebar-resize-handle";
import { useChannelSidebarWidth } from "@/hooks/use-channel-sidebar-width";
import { formatMessagePreview } from "@/lib/conversations";
import { cn, formatFullTimestamp, formatRecency } from "@/lib/utils";

const EMPTY_UNREAD: UnreadState = { count: 0, mentions: 0 };

/** Past this the faces stop being recognisable and start being texture. */
const MAX_STACKED_AVATARS = 3;

interface DmListProps {
  conversations: DmSummary[];
  /**
   * The friends' stories strip, at the top of the list. Draws nothing while
   * the friends audience is off or nobody has a story up.
   */
  storiesSlot?: ReactNode;
  selectedChannelId: string | null;
  unread: Record<string, UnreadState>;
  isLoading?: boolean;
  /** So a 1:1 with somebody blocked offers "Unblock" instead of "Block". */
  blockedUserIds: ReadonlySet<string>;
  /** For the "you:" preview prefix — never anyone else's line. */
  viewerId: string | null;
  onSelectConversation: (channelId: string) => void;
  onStartConversation: () => void;
  /** The Friends nav entry at the top — highlighted when the view is showing. */
  friendsSelected?: boolean;
  onOpenFriends?: () => void;
  /**
   * Friend requests waiting on this account. A prop rather than a `useFriends()`
   * call so this list keeps its "renders from what it is handed" shape, and so
   * the number cannot disagree with the one on the server rail.
   */
  friendRequestCount?: number;
  /** Whether this account has any accepted friends — picks the empty-state copy. */
  hasFriends?: boolean;
  onHideConversation: (channelId: string) => void;
  /** Channel ids currently pinned to the rail, so the row can offer unpin. */
  pinnedChannelIds?: ReadonlySet<string>;
  onTogglePin?: (channelId: string) => void;
  onBlockUser: (user: PublicUser) => void;
  onUnblockUser: (userId: string) => void;
  // --- conversation calls ---
  /** Start (or join) a voice call in this conversation. */
  onStartCall?: (channelId: string) => void;
  /** Conversations with a live call — their rows show it and offer "join". */
  activeCallChannelIds?: ReadonlySet<string>;
  footer?: ReactNode;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  /**
   * Conversas (`conversations_home`): draw `ConversationHomeList` instead.
   * Off, this component is exactly what it was.
   */
  home?: boolean;
  /** Pinned ids in pin order, for the Conversas list's Fixadas section. */
  pinnedIds?: readonly string[];
  /** Conversas on a phone: the list is the Conversas tab (see `ConversationHomeList`). */
  phoneShell?: boolean;
}

/**
 * The conversation sidebar. With `home` on it is the Conversas list; off, the
 * classic one below. One entry point so the shell passes one set of props.
 */
export function DmList({ home = false, pinnedIds, phoneShell = false, ...props }: DmListProps) {
  if (home) {
    return (
      <ConversationHomeList
        {...props}
        phoneShell={phoneShell}
        pinnedIds={pinnedIds ?? [...(props.pinnedChannelIds ?? [])]}
      />
    );
  }
  return <ClassicDmList {...props} />;
}

/**
 * The conversation sidebar: what stands in for the channel list when no server
 * is selected.
 *
 * A separate component rather than a mode of `ChannelList`, because almost
 * nothing is shared below the shell — there are no sections, no types, no
 * create-channel affordances, and above all no names. Every row's label is
 * derived from who is in it, which is the one thing a channel row never has to
 * do.
 */
function ClassicDmList({
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
  hasFriends = true,
  onHideConversation,
  pinnedChannelIds,
  onTogglePin,
  onBlockUser,
  onUnblockUser,
  onStartCall,
  activeCallChannelIds,
  footer,
  mobileOpen = false,
  onMobileClose,
  storiesSlot = null,
}: Omit<DmListProps, "home" | "pinnedIds" | "phoneShell">) {
  const { t } = useTranslation();
  const {
    width: sidebarWidth,
    maxWidth: sidebarMaxWidth,
    setWidth: setSidebarWidth,
    commitWidth: commitSidebarWidth,
  } = useChannelSidebarWidth();
  return (
    <aside
      data-immersive-hide=""
      // `md:relative md:left-auto`, and both halves matter. The handle is
      // absolutely positioned and needs a positioned ancestor, which `static`
      // is not. But turning this relative also switches ON the `left-[72px]`
      // that the drawer layout sets and `static` was ignoring, and as a
      // relative OFFSET that slid the whole column 72px to the right, over the
      // composer. `left-auto` puts it back.
      //
      // `--channel-sidebar-width` rather than an inline `width`: below `md`
      // this is a drawer pinned to `min(100%-72px,16rem)` and an inline width
      // would win there too. The variable is only consumed by the `md:` class,
      // so the drawer keeps the width it has always had.
      style={
        { "--channel-sidebar-width": `${sidebarWidth}px` } as CSSProperties
      }
      className={`fixed inset-y-0 left-[72px] z-30 flex w-[min(100%-72px,16rem)] flex-col border-r border-border bg-surface-1 transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] md:relative md:left-auto md:z-auto md:w-[var(--channel-sidebar-width)] md:translate-x-0 ${
        mobileOpen
          ? "translate-x-0"
          : "-translate-x-[calc(100%+72px)] md:translate-x-0"
      }`}
    >
      <SidebarResizeHandle
        width={sidebarWidth}
        maxWidth={sidebarMaxWidth}
        onWidthChange={setSidebarWidth}
        onCommit={commitSidebarWidth}
      />
      <div className="flex h-14 items-center justify-between gap-2 border-b border-border px-4">
        <p className="truncate font-display text-base font-semibold text-text">
          {t("dm.title")}
        </p>
        <div className="flex items-center gap-1">
          <Tooltip label={t("dm.new")}>
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] text-text-tertiary hover:bg-surface-2 hover:text-text"
              onClick={onStartConversation}
            >
              <Plus className="h-4 w-4" />
            </button>
          </Tooltip>
          {onMobileClose && (
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] text-text-tertiary hover:bg-surface-2 hover:text-text md:hidden"
              aria-label={t("dm.closeList")}
              onClick={onMobileClose}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {storiesSlot}
        {/* The home view's one nav entry, above the conversations — the
            Friends view is where "home with nothing selected" lands, and this
            is the way back to it once a conversation is open. */}
        {onOpenFriends && (
          <>
            <button
              type="button"
              className={cn(
                "flex h-10 w-full items-center gap-2 rounded-[var(--radius-control)] px-2 text-sm font-medium",
                friendsSelected
                  ? "bg-surface-2 text-text"
                  : "text-text-tertiary hover:bg-surface-2/70 hover:text-text",
              )}
              aria-current={friendsSelected ? "page" : undefined}
              onClick={() => {
                onOpenFriends();
                onMobileClose?.();
              }}
            >
              <Users aria-hidden="true" className="h-4 w-4 shrink-0" />
              <span className="truncate">{t("friends.title")}</span>
              {/* Requests waiting on YOU, counted where the way in is. Before
                  this the number existed only on the Pending tab *inside* the
                  view, which is a badge you have to already be looking at the
                  thing to see. Outgoing requests are excluded for the reason
                  `pendingActionCount` gives: a badge is a call to action, and
                  there is nothing to do about one you sent.

                  Accent, not danger: the same fact reads accent everywhere —
                  the rail's top-corner badge for requests is accent too. Red
                  is reserved for unread messages, one colour per meaning. */}
              {friendRequestCount > 0 && (
                <span
                  data-friend-requests={friendRequestCount}
                  className="ml-auto min-w-[1.15rem] shrink-0 rounded-full bg-accent px-1 py-0.5 text-center text-[10px] font-bold leading-none text-on-accent"
                >
                  {friendRequestCount}
                </span>
              )}
              {friendRequestCount > 0 && (
                <span className="sr-only">
                  {t("friends.pendingBadge", { count: friendRequestCount })}
                </span>
              )}
            </button>
            <div className="my-2 h-px bg-border" />
          </>
        )}
        {isLoading ? (
          <ChannelListSkeleton />
        ) : conversations.length === 0 ? (
          <div className="px-2 py-6">
            <p className="text-sm font-semibold text-text">{t("dm.empty")}</p>
            <p className="mt-1 text-sm text-text-tertiary">
              {hasFriends ? t("dm.empty.body") : t("dm.empty.noFriends")}
            </p>
            <button
              type="button"
              className="mt-2 text-sm text-accent underline underline-offset-2"
              onClick={hasFriends ? onStartConversation : onOpenFriends}
            >
              {t("dm.messageSomeone")}
            </button>
          </div>
        ) : (
          <>
            {/* The eyebrow is what stops the Amigos row above from reading as
                conversation zero — it is only drawn once there is at least
                one real conversation under it. */}
            <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
              {t("dm.sectionLabel")}
            </p>
            {conversations.map((conversation) => (
              <ConversationRow
                key={conversation.channelId}
                conversation={conversation}
                selected={selectedChannelId === conversation.channelId}
                unread={unread[conversation.channelId] ?? EMPTY_UNREAD}
                blockedUserIds={blockedUserIds}
                viewerId={viewerId}
                onSelect={() => {
                  onSelectConversation(conversation.channelId);
                  onMobileClose?.();
                }}
                onHide={() => onHideConversation(conversation.channelId)}
                pinned={pinnedChannelIds?.has(conversation.channelId) ?? false}
                onTogglePin={
                  onTogglePin
                    ? () => onTogglePin(conversation.channelId)
                    : undefined
                }
                onBlock={onBlockUser}
                onUnblock={onUnblockUser}
                hasActiveCall={
                  activeCallChannelIds?.has(conversation.channelId) ?? false
                }
                onStartCall={
                  onStartCall
                    ? () => {
                        onStartCall(conversation.channelId);
                        onMobileClose?.();
                      }
                    : undefined
                }
              />
            ))}
          </>
        )}
      </div>

      {footer}
    </aside>
  );
}

function ConversationRow({
  conversation,
  selected,
  unread,
  blockedUserIds,
  viewerId,
  onSelect,
  onHide,
  pinned,
  onTogglePin,
  onBlock,
  onUnblock,
  hasActiveCall = false,
  onStartCall,
}: {
  conversation: DmSummary;
  selected: boolean;
  unread: UnreadState;
  blockedUserIds: ReadonlySet<string>;
  viewerId: string | null;
  onSelect: () => void;
  onHide: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  onBlock: (user: PublicUser) => void;
  onUnblock: (userId: string) => void;
  hasActiveCall?: boolean;
  onStartCall?: () => void;
}) {
  const { t } = useTranslation();
  /** What the profile card hangs off, since the trigger is a menu item. */
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
  const hasUnread = !selected && unread.count > 0;
  const hasDraft = useHasDraft(conversation.channelId) && !selected;
  const mentions = selected || muted ? 0 : unread.mentions;
  // A DM is addressed to you, so every unread one earns a count, not just the
  // mentions a server channel would badge. The mention count wins when both
  // exist, since it is the more specific claim.
  const badge = mentions > 0 ? mentions : muted || selected ? 0 : unread.count;

  const previewLine = hasActiveCall
    ? t("dm.inCall")
    : conversation.lastMessage
      ? formatMessagePreview(conversation.lastMessage, {
          viewerId,
          isGroup: conversation.kind === "group",
        })
      : null;

  return (
    <ContextMenu items={items}>
      <div
        ref={rowRef}
        className={cn(
          "group relative mb-0.5 flex items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5",
          selected
            ? "bg-surface-2"
            : "hover:bg-surface-2/70",
          muted && !selected && "opacity-60",
        )}
      >
        {hasUnread && !muted && (
          <span
            aria-hidden="true"
            className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-text"
          />
        )}
        <button
          type="button"
          onClick={onSelect}
          className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <AvatarStack participants={conversation.participants} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1">
              <span
                className={cn(
                  "truncate text-sm",
                  selected
                    ? "text-text"
                    : hasUnread && !muted
                      ? "font-semibold text-text"
                      : muted
                        ? "text-text-tertiary"
                        : "text-text-secondary",
                )}
              >
                {title}
              </span>
              {hasDraft && <DraftMark />}
              {conversation.kind === "group" && (
                <span className="rounded bg-surface-2 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-text-tertiary">
                  {conversation.participants.length + 1}
                </span>
              )}
              {blocked && <span className="sr-only">{t("chrome.blockedSr")}</span>}
              {hasUnread && !muted && <span className="sr-only">{t("chrome.unreadSr")}</span>}
              {muted && <span className="sr-only">{t("chrome.mutedSr")}</span>}
            </span>
            {previewLine && (
              <span
                className={cn(
                  "block truncate text-xs",
                  hasActiveCall
                    ? "text-success"
                    : muted
                      ? "text-text-tertiary"
                      : hasUnread
                        ? "text-text-secondary"
                        : "text-text-tertiary",
                )}
              >
                {previewLine}
              </span>
            )}
          </span>
          <span className="ml-auto flex shrink-0 flex-col items-end gap-1">
            {/* When the last message landed: a time only if that was today,
                otherwise the day, so an old thread never passes for a fresh
                one. Steps aside for the hover actions. */}
            {conversation.lastMessageAt && (
              <time
                dateTime={conversation.lastMessageAt}
                title={formatFullTimestamp(conversation.lastMessageAt)}
                className={cn(
                  "text-[11px] tabular-nums transition-opacity group-hover:opacity-0 group-focus-within:opacity-0",
                  hasUnread && !muted ? "text-text" : "text-text-tertiary",
                )}
                data-dm-recency
              >
                {formatRecency(conversation.lastMessageAt)}
              </time>
            )}
            {badge > 0 ? (
              <span
                key={badge}
                className="inline-flex h-[18px] min-w-[18px] animate-badge-pop items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold leading-none tabular-nums text-on-danger"
                aria-label={
                  mentions > 0
                    ? t("chrome.unreadMentions", { count: mentions })
                    : t("notify.messages", { count: badge })
                }
                data-dm-unread
              >
                {formatBadgeCount(badge)}
              </span>
            ) : muted ? (
              <BellOff className="h-3 w-3 text-text-tertiary" aria-hidden="true" />
            ) : null}
          </span>
        </button>
        {/* The call entry point. Always visible while a call is live in this
            conversation (green, meaning "join"); otherwise revealed on
            hover/focus like every quiet row action. Hidden entirely for a
            blocked 1:1 — the server would refuse the join anyway, and showing
            a phone that cannot ring is worse than no phone. */}
        {onStartCall && !blocked && (
          /* The row you are pointing at is named right next to the pointer,
             so the bubble says only the verb; the reader, stepping down a
             list of identical phones, gets the conversation in the name. */
          <Tooltip
            label={t(hasActiveCall ? "call.panel.join" : "call.startVoice")}
            name={
              t(hasActiveCall ? "call.panel.join" : "call.startVoice") +
              `: ${title}`
            }
          >
            <button
              type="button"
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)]",
                hasActiveCall
                  ? "text-success"
                  : "text-text-tertiary opacity-0 hover:bg-surface-2 hover:text-text focus-visible:opacity-100 group-hover:opacity-100",
              )}
              onClick={onStartCall}
            >
              <Phone className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        )}
      </div>
    </ContextMenu>
  );
}

/** One face for a 1:1, an overlapped few for a group. */
function AvatarStack({
  participants,
}: {
  participants: readonly PublicUser[];
}) {
  const shown = participants.slice(0, MAX_STACKED_AVATARS);
  if (shown.length === 0) {
    return (
      <span
        className="h-8 w-8 shrink-0 rounded-full bg-surface-2"
        aria-hidden="true"
      />
    );
  }
  return (
    <span className="flex shrink-0 -space-x-2" aria-hidden="true">
      {shown.map((person) => (
        <UserAvatar
          key={person.id}
          name={person.displayName}
          avatarUrl={person.avatarUrl}
          className="h-8 w-8 ring-2 ring-surface-1"
          fallbackClassName="bg-surface-2 text-[10px] text-text"
          rounded="full"
        />
      ))}
    </span>
  );
}

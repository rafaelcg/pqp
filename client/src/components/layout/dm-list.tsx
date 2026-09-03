import type { DmSummary, PublicUser } from "@pqp/shared";
import { Phone, Plus, Users, X } from "lucide-react";
import { useRef, type ReactNode } from "react";
import {
  formatBadgeCount,
  type UnreadState,
} from "@/components/layout/channel-list";
import {
  ContextMenu,
  type ContextMenuItemDef,
} from "@/components/ui/context-menu";
import { ChannelListSkeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { useProfilePopover } from "@/components/user/user-profile-popover";
import { UserAvatar } from "@/components/user/user-avatar";
import {
  notificationLevelItems,
  useChannelNotificationLevel,
} from "@/hooks/use-notifications";
import { useTranslation } from "@/lib/i18n";
import { conversationTitle } from "@/lib/conversations";
import { cn, formatFullTimestamp, formatRecency } from "@/lib/utils";

const EMPTY_UNREAD: UnreadState = { count: 0, mentions: 0 };

/** Past this the faces stop being recognisable and start being texture. */
const MAX_STACKED_AVATARS = 3;

interface DmListProps {
  conversations: DmSummary[];
  selectedChannelId: string | null;
  unread: Record<string, UnreadState>;
  isLoading?: boolean;
  /** So a 1:1 with somebody blocked offers "Unblock" instead of "Block". */
  blockedUserIds: ReadonlySet<string>;
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
  onHideConversation: (channelId: string) => void;
  /** Channel ids currently pinned to the rail, so the row can offer unpin. */
  pinnedChannelIds?: ReadonlySet<string>;
  onTogglePin?: (channelId: string) => void;
  /** False when the rail is already at the pin cap and this row is not pinned. */
  canPinMore?: boolean;
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
export function DmList({
  conversations,
  selectedChannelId,
  unread,
  isLoading = false,
  blockedUserIds,
  onSelectConversation,
  onStartConversation,
  friendsSelected = false,
  onOpenFriends,
  friendRequestCount = 0,
  onHideConversation,
  pinnedChannelIds,
  onTogglePin,
  canPinMore = true,
  onBlockUser,
  onUnblockUser,
  onStartCall,
  activeCallChannelIds,
  footer,
  mobileOpen = false,
  onMobileClose,
}: DmListProps) {
  const { t } = useTranslation();
  return (
    <aside
      className={`fixed inset-y-0 left-[72px] z-30 flex w-[min(100%-72px,16rem)] flex-col border-r border-ink-4/60 bg-channel transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] md:static md:z-auto md:w-64 md:translate-x-0 ${
        mobileOpen
          ? "translate-x-0"
          : "-translate-x-[calc(100%+72px)] md:translate-x-0"
      }`}
    >
      <div className="flex h-14 items-center justify-between gap-2 border-b border-ink-4/60 px-4">
        <p className="truncate font-display text-base font-bold">{t("dm.title")}</p>
        <div className="flex items-center gap-1">
          <Tooltip label={t("dm.new")}>
            <button
              type="button"
              className="rounded-md p-1.5 text-paper-muted hover:bg-ink-3 hover:text-paper"
              onClick={onStartConversation}
            >
              <Plus className="h-4 w-4" />
            </button>
          </Tooltip>
          {onMobileClose && (
            <button
              type="button"
              className="rounded p-1 hover:bg-ink-3 md:hidden"
              aria-label={t("dm.closeList")}
              onClick={onMobileClose}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {/* The home view's one nav entry, above the conversations — the
            Friends view is where "home with nothing selected" lands, and this
            is the way back to it once a conversation is open. */}
        {onOpenFriends && (
          <button
            type="button"
            className={cn(
              "mb-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm",
              friendsSelected
                ? "bg-ink-3 text-paper"
                : "text-paper-muted hover:bg-ink-3/70 hover:text-paper",
            )}
            aria-current={friendsSelected ? "page" : undefined}
            onClick={() => {
              onOpenFriends();
              onMobileClose?.();
            }}
          >
            <Users aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span className="truncate font-medium">{t("friends.title")}</span>
            {/* Requests waiting on YOU, counted where the way in is. Before
                this the number existed only on the Pending tab *inside* the
                view, which is a badge you have to already be looking at the
                thing to see. Outgoing requests are excluded for the reason
                `pendingActionCount` gives: a badge is a call to action, and
                there is nothing to do about one you sent. */}
            {friendRequestCount > 0 && (
              <span
                data-friend-requests={friendRequestCount}
                className="ml-auto min-w-[1.15rem] shrink-0 rounded-full bg-danger px-1 py-0.5 text-center text-[10px] font-bold leading-none text-paper"
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
        )}
        {isLoading ? (
          <ChannelListSkeleton />
        ) : conversations.length === 0 ? (
          <div className="px-2 py-6">
            <p className="text-sm text-paper-muted">
              {t("dm.empty")}
            </p>
            <button
              type="button"
              className="mt-2 text-sm text-signal underline underline-offset-2"
              onClick={onStartConversation}
            >
              {t("dm.messageSomeone")}
            </button>
          </div>
        ) : (
          conversations.map((conversation) => (
            <ConversationRow
              key={conversation.channelId}
              conversation={conversation}
              selected={selectedChannelId === conversation.channelId}
              unread={unread[conversation.channelId] ?? EMPTY_UNREAD}
              blockedUserIds={blockedUserIds}
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
              canPin={
                (pinnedChannelIds?.has(conversation.channelId) ?? false) ||
                canPinMore
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
          ))
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
  onSelect,
  onHide,
  pinned,
  onTogglePin,
  canPin,
  onBlock,
  onUnblock,
  hasActiveCall = false,
  onStartCall,
}: {
  conversation: DmSummary;
  selected: boolean;
  unread: UnreadState;
  blockedUserIds: ReadonlySet<string>;
  onSelect: () => void;
  onHide: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  canPin?: boolean;
  onBlock: (user: PublicUser) => void;
  onUnblock: (userId: string) => void;
  hasActiveCall?: boolean;
  onStartCall?: () => void;
}) {
  const { t } = useTranslation();
  const openProfile = useProfilePopover();
  /** What the profile card hangs off, since the trigger is a menu item. */
  const rowRef = useRef<HTMLDivElement>(null);
  // The same per-channel levels a server channel gets. Muting a conversation is
  // the same act as muting #general, and giving it its own store would be a
  // second place for "leave me alone" to be recorded and forgotten.
  const notifications = useChannelNotificationLevel({
    id: conversation.channelId,
    serverId: null,
  });
  const title = conversationTitle(conversation.participants);
  // Blocking is between two people. In a group there is no single "them" to
  // block, and blocking one member would leave you in a room reading around a
  // hole — so the row only offers it for a 1:1.
  const solo =
    conversation.participants.length === 1 ? conversation.participants[0]! : null;
  const blocked = solo ? blockedUserIds.has(solo.id) : false;

  const items: ContextMenuItemDef[] = [
    // The profile card is a menu item here rather than a click on the avatar,
    // which is the one place it does NOT drop in cleanly: a conversation row
    // is one big button whose entire job is opening the conversation, and
    // stealing part of it for a popover would break the row's own purpose.
    // A group row offers nothing — there is no single "them" to profile.
    ...(solo
      ? [
          {
            id: "profile",
            label: t("profile.viewProfile"),
            onSelect: () => {
              const anchor = rowRef.current;
              if (anchor) {
                openProfile(
                  {
                    id: solo.id,
                    displayName: solo.displayName,
                    tag: solo.tag ?? null,
                    avatarUrl: solo.avatarUrl ?? null,
                  },
                  anchor,
                );
              }
            },
          },
        ]
      : []),
    ...(onTogglePin && (pinned || canPin)
      ? [
          {
            id: "pin",
            label: pinned
              ? t("chrome.unpinConversation")
              : t("chrome.pinConversation"),
            onSelect: onTogglePin,
          },
        ]
      : []),
    {
      id: "copy-id",
      label: t("dm.copyId"),
      onSelect: () => void navigator.clipboard.writeText(conversation.channelId),
    },
    ...notificationLevelItems("notify", notifications, "account"),
    { id: "sep", label: "", separator: true },
    {
      id: "hide",
      label: t("dm.close"),
      onSelect: onHide,
    },
  ];
  if (solo) {
    items.push(
      blocked
        ? {
            id: "unblock",
            label: t("profile.unblock"),
            onSelect: () => onUnblock(solo.id),
          }
        : {
            id: "block",
            label: t("profile.block"),
            danger: true,
            onSelect: () => onBlock(solo),
          },
    );
  }

  const muted = notifications.level === "none";
  const hasUnread = !selected && unread.count > 0;
  const mentions = selected || muted ? 0 : unread.mentions;
  // A DM is addressed to you, so every unread one earns a count, not just the
  // mentions a server channel would badge. The mention count wins when both
  // exist, since it is the more specific claim.
  const badge = mentions > 0 ? mentions : muted || selected ? 0 : unread.count;

  return (
    <ContextMenu items={items}>
      <div
        ref={rowRef}
        className={cn(
          "group relative mb-0.5 flex items-center gap-1 rounded-md px-2 py-1.5 text-sm",
          selected
            ? "bg-ink-3 text-paper"
            : "text-paper-muted hover:bg-ink-3/70 hover:text-paper",
          hasUnread && !muted && !selected && "text-paper",
          muted && !selected && "opacity-50",
        )}
      >
        {hasUnread && !muted && (
          <span
            aria-hidden="true"
            className="absolute -left-1 top-1/2 h-4 w-1 -translate-y-1/2 rounded-r-full bg-paper"
          />
        )}
        <button
          type="button"
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <AvatarStack participants={conversation.participants} />
          <span
            className={cn("truncate", hasUnread && !muted && "font-semibold")}
          >
            {title}
          </span>
          {blocked && <span className="sr-only">{t("chrome.blockedSr")}</span>}
          {hasUnread && !muted && <span className="sr-only">{t("chrome.unreadSr")}</span>}
          {muted && <span className="sr-only">{t("chrome.mutedSr")}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {conversation.kind === "group" && (
              <span className="rounded bg-ink-4 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-paper-muted">
                {conversation.participants.length + 1}
              </span>
            )}
            {/* When the last message landed: a time only if that was today,
                otherwise the day, so an old thread never passes for a fresh
                one. Steps aside for the hover actions. */}
            {conversation.lastMessageAt && (
              <time
                dateTime={conversation.lastMessageAt}
                title={formatFullTimestamp(conversation.lastMessageAt)}
                className={cn(
                  "text-[11px] tabular-nums transition-opacity group-hover:opacity-0 group-focus-within:opacity-0",
                  hasUnread && !muted ? "text-paper" : "text-paper-muted",
                )}
                data-dm-recency
              >
                {formatRecency(conversation.lastMessageAt)}
              </time>
            )}
            {badge > 0 && (
              <span
                key={badge}
                className="min-w-4 animate-badge-pop rounded-full bg-danger px-1 py-0.5 text-center text-[10px] font-bold leading-none text-paper"
                aria-label={
                  mentions > 0
                    ? t("chrome.unreadMentions", { count: mentions })
                    : t("notify.messages", { count: badge })
                }
                data-dm-unread
              >
                {formatBadgeCount(badge)}
              </span>
            )}
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
                "shrink-0 rounded-md p-1.5",
                hasActiveCall
                  ? "text-success"
                  : "text-paper-muted opacity-0 hover:bg-ink-3 hover:text-paper focus-visible:opacity-100 group-hover:opacity-100",
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
      <span className="h-6 w-6 shrink-0 rounded-full bg-ink-4" aria-hidden="true" />
    );
  }
  return (
    <span className="flex shrink-0 -space-x-2" aria-hidden="true">
      {shown.map((person) => (
        <UserAvatar
          key={person.id}
          name={person.displayName}
          avatarUrl={person.avatarUrl}
          className="h-6 w-6 ring-2 ring-channel"
          fallbackClassName="bg-ink-4 text-[10px] text-paper"
          rounded="full"
        />
      ))}
    </span>
  );
}

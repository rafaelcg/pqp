import type { DmSummary, Friend, UserStatus } from "@pqp/shared";
import { Plus, Search, Users, X } from "lucide-react";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { UnreadState } from "@/components/layout/channel-list";
import { SidebarResizeHandle } from "@/components/layout/sidebar-resize-handle";
import { useFriends } from "@/components/friends/use-friends";
import { ChannelListSkeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { StatusDot } from "@/components/user/status-dot";
import { UserAvatar } from "@/components/user/user-avatar";
import { useChannelSidebarWidth } from "@/hooks/use-channel-sidebar-width";
import { createConversation } from "@/lib/api";
import { conversationTitle } from "@/lib/conversations";
import { useTranslation } from "@/lib/i18n";
import { retroStatusKey } from "@/lib/retro-look";
import {
  contactGroups,
  isMusicRecado,
  readCollapsedGroups,
  storeCollapsedGroups,
  type ContactGroupId,
} from "@/components/retro/retro-model";

export interface RetroContactsProps {
  conversations: DmSummary[];
  selectedChannelId: string | null;
  unread: Record<string, UnreadState>;
  isLoading?: boolean;
  onSelectConversation: (channelId: string) => void;
  /** A friend with no conversation yet: the new one, to open. */
  onOpenConversation: (conversation: DmSummary) => void;
  onStartConversation: () => void;
  onOpenFriends?: () => void;
  friendsSelected?: boolean;
  friendRequestCount?: number;
  footer?: ReactNode;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  me: {
    displayName: string;
    avatarUrl: string | null;
    status: UserStatus;
    customStatus: string | null;
  } | null;
}

const EMPTY_UNREAD: UnreadState = { count: 0, mentions: 0 };

/**
 * Modo 2005's DM column: a contact list grouped by status, the way the old
 * chat clients drew it. A presentational layer over the same data the regular
 * conversation list renders (the conversations, and the friends list the app
 * already polls), swapped in by the app shell only while the look is on. It
 * owns no state of its own beyond which groups are folded.
 *
 * Mounting it registers as somebody drawing presence, so the friends poll
 * runs every 15 s while it is on screen, which is also what feeds "acabou de
 * entrar".
 */
export default function RetroContacts({
  conversations,
  selectedChannelId,
  unread,
  isLoading = false,
  onSelectConversation,
  onOpenConversation,
  onStartConversation,
  onOpenFriends,
  friendsSelected = false,
  friendRequestCount = 0,
  footer,
  mobileOpen = false,
  onMobileClose,
  me,
}: RetroContactsProps) {
  const { t } = useTranslation();
  const friendsStore = useFriends();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<ContactGroupId>>(
    () => readCollapsedGroups(),
  );
  const {
    width: sidebarWidth,
    maxWidth: sidebarMaxWidth,
    setWidth: setSidebarWidth,
    commitWidth: commitSidebarWidth,
  } = useChannelSidebarWidth();

  const { groups, others } = useMemo(
    () => contactGroups(friendsStore.data.friends, conversations, query),
    [friendsStore.data.friends, conversations, query],
  );

  function toggle(group: ContactGroupId) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      storeCollapsedGroups(next);
      return next;
    });
  }

  async function openFriend(friend: Friend, conversation: DmSummary | null) {
    onMobileClose?.();
    if (conversation) {
      onSelectConversation(conversation.channelId);
      return;
    }
    try {
      const { conversation: created } = await createConversation([friend.id]);
      onOpenConversation(created);
    } catch {
      // The Friends view says why a conversation cannot open; send them there.
      onOpenFriends?.();
    }
  }

  const noFriends = friendsStore.data.friends.length === 0 && !friendsStore.loading;
  const searching = query.trim().length > 0;

  return (
    <aside
      data-immersive-hide=""
      data-retro-contacts=""
      // Same shell as the regular list (`dm-list.tsx`): a drawer below `md`,
      // a resizable column above it.
      style={{ "--channel-sidebar-width": `${sidebarWidth}px` } as CSSProperties}
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
      <div className="retro-titlebar">
        <span className="retro-titlebar-text">{t("retro.contacts")}</span>
        {onOpenFriends && (
          <Tooltip label={t("friends.title")}>
            <button
              type="button"
              className="relative flex h-6 w-6 items-center justify-center rounded-[var(--radius-control)] hover:bg-surface-1/20"
              aria-current={friendsSelected ? "page" : undefined}
              onClick={() => {
                onOpenFriends();
                onMobileClose?.();
              }}
            >
              <Users className="h-4 w-4" aria-hidden />
              {friendRequestCount > 0 && (
                <span
                  data-friend-requests={friendRequestCount}
                  className="retro-unread absolute -right-1.5 -top-1"
                >
                  {friendRequestCount}
                </span>
              )}
            </button>
          </Tooltip>
        )}
        <Tooltip label={t("dm.new")}>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-control)] hover:bg-surface-1/20"
            onClick={onStartConversation}
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
        </Tooltip>
        {onMobileClose && (
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-control)] hover:bg-surface-1/20 md:hidden"
            aria-label={t("dm.closeList")}
            onClick={onMobileClose}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>

      <div className="retro-contacts-body flex min-h-0 flex-1 flex-col">
        {me && <OwnTile me={me} />}
        <label className="retro-search">
          <Search className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden />
          <input
            type="search"
            value={query}
            placeholder={t("retro.search")}
            aria-label={t("retro.search")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {isLoading && friendsStore.loading ? (
            <div className="p-2">
              <ChannelListSkeleton />
            </div>
          ) : (
            <>
              {noFriends && !searching && (
                <p className="px-3 py-2 text-xs text-text-secondary">
                  {t("retro.noFriends")}
                </p>
              )}
              {groups.map((group) =>
                group.entries.length === 0 && (searching || group.id !== "online") ? null : (
                  <section key={group.id} data-retro-group={group.id}>
                    <button
                      type="button"
                      className="retro-group"
                      aria-expanded={searching || !collapsed.has(group.id)}
                      onClick={() => toggle(group.id)}
                    >
                      <span className="retro-twisty" aria-hidden />
                      {t("retro.group", {
                        label: t(retroStatusKey(group.id)),
                        count: group.entries.length,
                      })}
                    </button>
                    {(searching || !collapsed.has(group.id)) &&
                      group.entries.map(({ friend, conversation }) => (
                        <button
                          key={friend.id}
                          type="button"
                          className="retro-contact"
                          data-offline={group.id === "offline" ? "" : undefined}
                          aria-current={
                            conversation &&
                            conversation.channelId === selectedChannelId
                              ? "page"
                              : undefined
                          }
                          onClick={() => void openFriend(friend, conversation)}
                        >
                          <StatusDot status={friend.status} />
                          <span className="retro-contact-name">
                            {friend.displayName}
                          </span>
                          {friend.customStatus && (
                            <span
                              className="retro-contact-recado"
                              data-music={
                                isMusicRecado(friend.customStatus) ? "" : undefined
                              }
                            >
                              {" - "}
                              {friend.customStatus}
                            </span>
                          )}
                          <UnreadPill
                            unread={
                              conversation
                                ? (unread[conversation.channelId] ?? EMPTY_UNREAD)
                                : EMPTY_UNREAD
                            }
                          />
                        </button>
                      ))}
                  </section>
                ),
              )}
              {others.length > 0 && (
                <section data-retro-group="others">
                  <button
                    type="button"
                    className="retro-group"
                    aria-expanded={searching || !collapsed.has("others")}
                    onClick={() => toggle("others")}
                  >
                    <span className="retro-twisty" aria-hidden />
                    {t("retro.group", {
                      label: t("retro.group.others"),
                      count: others.length,
                    })}
                  </button>
                  {(searching || !collapsed.has("others")) &&
                    others.map((conversation) => (
                      <button
                        key={conversation.channelId}
                        type="button"
                        className="retro-contact"
                        aria-current={
                          conversation.channelId === selectedChannelId
                            ? "page"
                            : undefined
                        }
                        onClick={() => {
                          onSelectConversation(conversation.channelId);
                          onMobileClose?.();
                        }}
                      >
                        <span aria-hidden className="w-2.5 shrink-0 text-center">
                          {conversation.kind === "group" ? "👥" : "💬"}
                        </span>
                        <span className="retro-contact-name">
                          {conversationTitle(conversation.participants)}
                        </span>
                        <UnreadPill
                          unread={unread[conversation.channelId] ?? EMPTY_UNREAD}
                        />
                      </button>
                    ))}
                </section>
              )}
              {searching &&
                groups.every((group) => group.entries.length === 0) &&
                others.length === 0 && (
                  <p className="px-3 py-2 text-xs text-text-secondary">
                    {t("retro.searchEmpty")}
                  </p>
                )}
            </>
          )}
        </div>
      </div>

      {footer}
    </aside>
  );
}

function UnreadPill({ unread }: { unread: UnreadState }) {
  if (unread.count <= 0) {
    return null;
  }
  return (
    <span className="retro-unread">{unread.count > 99 ? "99+" : unread.count}</span>
  );
}

function OwnTile({
  me,
}: {
  me: NonNullable<RetroContactsProps["me"]>;
}) {
  const { t } = useTranslation();
  return (
    <div className="retro-me" data-retro-me="">
      <span className="retro-frame" data-status={me.status}>
        <UserAvatar
          name={me.displayName}
          avatarUrl={me.avatarUrl}
          className="h-12 w-12"
          rounded="md"
          fallbackClassName="retro-avatar-fallback"
        />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold text-text">{me.displayName}</p>
        <p className="flex items-center gap-1 text-xs text-text-secondary">
          <StatusDot status={me.status} label="" />
          <span className="text-accent">({t(retroStatusKey(me.status))})</span>
        </p>
        {me.customStatus && (
          <p
            className="retro-recado"
            data-music={isMusicRecado(me.customStatus) ? "" : undefined}
          >
            {me.customStatus}
          </p>
        )}
      </div>
    </div>
  );
}

import {
  ArrowDown,
  ArrowUp,
  Archive,
  ChevronRight,
  Copy,
  FolderInput,
  FolderMinus,
  FolderPlus,
  HeadphoneOff,
  Lock,
  MicOff,
  Pencil,
  Phone,
  Plus,
  ScreenShare,
  Search,
  Settings,
  Star,
  StarOff,
  Trash2,
  UserPlus,
  Users,
  Video,
  X,
} from "lucide-react";
import { useEffect, useState, type DragEvent, type ReactNode } from "react";
import type { Channel, Server, VoiceParticipant } from "@pqp/shared";
import { SearchDialog } from "@/components/search/search-dialog";
import { ChannelIcon } from "@/components/layout/channel-icon";
import { ServerBanner, ServerIcon } from "@/components/layout/server-identity";
import {
  ContextMenu,
  type ContextMenuItemDef,
} from "@/components/ui/context-menu";
import { ChannelListSkeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { VoiceOccupantRow } from "@/components/layout/voice-occupant-row";
import { useProfilePopover } from "@/components/user/user-profile-popover";
import {
  canDragVoiceOccupant,
  dropReasonMessageKey,
  resolveVoiceOccupantDrop,
  shouldHighlightVoiceDrop,
  voiceOccupantMenuActions,
  type VoiceOccupantDrag,
} from "@/lib/voice-occupant-dnd";
import {
  addFavorite,
  favoritesCollapseKey,
  moveFavorite,
  removeFavorite,
  visibleFavoriteChannels,
} from "@/lib/channel-favorites";
import {
  loadCollapsedCategories,
  toggleCollapsedCategory,
} from "@/lib/collapsed-categories";
import {
  notificationLevelItems,
  useChannelNotificationLevel,
} from "@/hooks/use-notifications";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface UnreadState {
  count: number;
  mentions: number;
}

const EMPTY_UNREAD: UnreadState = { count: 0, mentions: 0 };

/** Drop-target ids that are not channels: the Favorites / TEXT / VOICE headers. */
const FAVORITES_ZONE = "__favorites__";
const TEXT_ZONE = "__text__";
const VOICE_ZONE = "__voice__";

/** Apple keyboards label the same chord differently, and the hint is the point. */
const SEARCH_SHORTCUT_HINT =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.userAgent)
    ? "⌘K"
    : "Ctrl K";

/** Equal-width action tiles on a channel row (star, settings). */
const CHANNEL_ACTION_TILE =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-ink-3";

export function formatBadgeCount(value: number): string {
  return value > 99 ? "99+" : String(value);
}

export { VoiceOccupantBadges } from "./voice-occupant-badges";

/** A channel or category, positioned within the one sibling group it belongs
 * to — see the comment on `moveChannel` (server/src/services/servers.ts) for
 * what "sibling group" means: top-level text, top-level voice, and each
 * category's own children are each scoped separately. */
function sortByPosition(list: Channel[]): Channel[] {
  return [...list].sort((a, b) => a.position - b.position);
}

interface ChannelListProps {
  server: Server | null;
  channels: Channel[];
  selectedChannelId: string | null;
  canManage: boolean;
  canManageRoles?: boolean;
  isLoading?: boolean;
  voiceOccupancy?: Record<string, VoiceParticipant[]>;
  speakingPeerIds?: string[];
  activeVoiceChannelId: string | null;
  unread: Record<string, UnreadState>;
  onSelectChannel: (channelId: string) => void;
  /**
   * Voice channels only. Double-click joins the call so you do not have to
   * open the channel and then hit Join. Single click still just selects.
   */
  onJoinVoice?: (channelId: string) => void;
  /** The signed-in account, for self-drag and "mute for me". */
  currentUserId?: string | null;
  peerVolumes?: Record<string, number>;
  canMoveIn?: (channelId: string) => boolean;
  canConnectIn?: (channelId: string) => boolean;
  canMuteIn?: (channelId: string) => boolean;
  canKickUser?: (userId: string) => boolean;
  onMoveVoiceOccupant?: (userId: string, channelId: string) => void;
  onDisconnectVoiceOccupant?: (userId: string) => void;
  onServerMuteOccupant?: (userId: string, muted: boolean) => void;
  onKickOccupant?: (userId: string, name: string) => void;
  onSetPeerVolume?: (userId: string, volume: number) => void;
  onCreateChannel: (
    type: "text" | "voice" | "category",
    isPrivate: boolean,
  ) => void;
  onRenameChannel: (channel: Channel) => void;
  onOpenChannelSettings: (
    channel: Channel,
    section: "overview" | "permissions" | "webhooks",
    options?: { forceAdvanced?: boolean },
  ) => void;
  onDeleteChannel: (channelId: string) => void;
  onMoveChannel: (
    channelId: string,
    parentId: string | null,
    index: number,
  ) => void;
  /**
   * This person's favourite channel ids for the open server, in display order.
   * A change writes the whole preference map (see `writeFavoritesForServer`).
   */
  favoriteChannelIds?: string[];
  onFavoriteChannelIdsChange?: (ids: string[]) => void;
  onInvite: () => void;
  onOpenMembers: () => void;
  onOpenServerSettings: () => void;
  footer?: ReactNode;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  /**
   * Baú (Community Home), on when `GET /api/community-home/config` says so.
   * Pins a Baú row above TEXT on every server. Not a real channel type and
   * not `COMMUNITIES_ENABLED`.
   */
  communityHomeEnabled?: boolean;
  /** "NEW" chip until the row is opened once on this server. */
  communityHomeShowNew?: boolean;
  /** Unread published posts. Outranks the "New" chip: a number says more. */
  communityHomeUnread?: number;
  communityHomeSelected?: boolean;
  onSelectCommunityHome?: () => void;
}

export function ChannelList({
  server,
  channels,
  selectedChannelId,
  canManage,
  canManageRoles = false,
  isLoading = false,
  voiceOccupancy = {},
  speakingPeerIds = [],
  activeVoiceChannelId,
  unread,
  onSelectChannel,
  onJoinVoice,
  currentUserId = null,
  peerVolumes = {},
  canMoveIn = () => false,
  canConnectIn = () => true,
  canMuteIn = () => false,
  canKickUser = () => false,
  onMoveVoiceOccupant,
  onDisconnectVoiceOccupant,
  onServerMuteOccupant,
  onKickOccupant,
  onSetPeerVolume,
  onCreateChannel,
  onRenameChannel,
  onOpenChannelSettings,
  onDeleteChannel,
  onMoveChannel,
  favoriteChannelIds = [],
  onFavoriteChannelIdsChange,
  onInvite,
  onOpenMembers,
  onOpenServerSettings,
  footer,
  mobileOpen = false,
  onMobileClose,
  communityHomeEnabled = false,
  communityHomeShowNew = false,
  communityHomeUnread = 0,
  communityHomeSelected = false,
  onSelectCommunityHome,
}: ChannelListProps) {
  const { t } = useTranslation();
  const visibleFavs = visibleFavoriteChannels(channels, favoriteChannelIds);
  const favoriteIdSet = new Set(visibleFavs.map((c) => c.id));
  const topLevelText = sortByPosition(
    channels.filter(
      (c) => c.type === "text" && !c.parentId && !favoriteIdSet.has(c.id),
    ),
  );
  const topLevelVoice = sortByPosition(
    channels.filter(
      (c) => c.type === "voice" && !c.parentId && !favoriteIdSet.has(c.id),
    ),
  );
  const categories = sortByPosition(
    channels.filter((c) => c.type === "category"),
  );
  const categoryOptions = categories.map((c) => ({ id: c.id, name: c.name }));
  const childrenByCategory = new Map<string, Channel[]>();
  for (const category of categories) {
    childrenByCategory.set(
      category.id,
      sortByPosition(
        channels.filter(
          (c) => c.parentId === category.id && !favoriteIdSet.has(c.id),
        ),
      ),
    );
  }

  const speaking = new Set(speakingPeerIds);
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    loadCollapsedCategories(),
  );
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [draggedOccupant, setDraggedOccupant] =
    useState<VoiceOccupantDrag | null>(null);
  const [dropHint, setDropHint] = useState<string | null>(null);
  const openProfile = useProfilePopover();
  const occupantCaps = {
    canMoveIn,
    canConnectIn,
  };

  const hasServer = !!server;
  useEffect(() => {
    if (!hasServer) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasServer]);

  function toggleCollapsed(categoryId: string) {
    setCollapsed(toggleCollapsedCategory(categoryId));
  }

  function clearDrag() {
    setDraggedId(null);
    setDragOverId(null);
    setDraggedOccupant(null);
  }

  function showDropHint(reason: Parameters<typeof dropReasonMessageKey>[0]) {
    setDropHint(t(dropReasonMessageKey(reason)));
    window.setTimeout(() => setDropHint(null), 2500);
  }

  function occupantDropAllowed(channel: Channel): boolean {
    if (!draggedOccupant) {
      return false;
    }
    return shouldHighlightVoiceDrop(
      draggedOccupant,
      { id: channel.id, type: channel.type },
      occupantCaps,
    );
  }

  function commitOccupantDrop(channel: Channel) {
    if (!draggedOccupant) {
      return;
    }
    const drag = draggedOccupant;
    clearDrag();
    const result = resolveVoiceOccupantDrop(
      drag,
      { id: channel.id, type: channel.type },
      occupantCaps,
    );
    if (!result.ok) {
      showDropHint(result.reason);
      return;
    }
    if (result.action === "join") {
      onJoinVoice?.(channel.id);
      return;
    }
    onMoveVoiceOccupant?.(drag.userId, channel.id);
  }

  function handleRowDrop(channel: Channel) {
    if (draggedOccupant) {
      commitOccupantDrop(channel);
      return;
    }
    handleDrop(channel);
  }

  function handleRowDragOver(event: DragEvent, channel: Channel) {
    if (draggedOccupant) {
      event.preventDefault();
      if (occupantDropAllowed(channel)) {
        event.dataTransfer.dropEffect = "move";
        setDragOverId(channel.id);
      } else {
        event.dataTransfer.dropEffect = "none";
        if (dragOverId === channel.id) {
          setDragOverId(null);
        }
      }
      return;
    }
    if (draggedId) {
      event.preventDefault();
      setDragOverId(channel.id);
    }
  }

  function menuForOccupant(
    person: VoiceParticipant,
    channel: Channel,
  ): ContextMenuItemDef[] {
    const isSelf = Boolean(currentUserId && person.userId === currentUserId);
    const inSameCall = activeVoiceChannelId === channel.id;
    const mutedForMe = (peerVolumes[person.userId] ?? 1) === 0;
    const actions = voiceOccupantMenuActions({
      isSelf,
      inSameCall,
      mutedForMe,
      canServerMute: canMuteIn(channel.id),
      serverMuted: person.serverMuted,
      canDisconnect: canMoveIn(channel.id),
      canKick: canKickUser(person.userId),
    });
    const profile: ContextMenuItemDef[] = [];
    const personal: ContextMenuItemDef[] = [];
    const mod: ContextMenuItemDef[] = [];
    const copy: ContextMenuItemDef[] = [];
    for (const action of actions) {
      if (action === "profile") {
        profile.push({
          id: "profile",
          label: t("voice.occupant.profile"),
          onSelect: () => {
            const anchor = document.querySelector(
              `[data-voice-occupant="${person.userId}"]`,
            );
            if (anchor instanceof HTMLElement) {
              openProfile(
                {
                  id: person.userId,
                  displayName: person.displayName,
                  tag: null,
                  avatarUrl: person.avatarUrl,
                },
                anchor,
              );
            }
          },
        });
      } else if (action === "muteForMe") {
        personal.push({
          id: "mute-for-me",
          label: t("voice.occupant.muteForMe"),
          onSelect: () => onSetPeerVolume?.(person.userId, 0),
        });
      } else if (action === "unmuteForMe") {
        personal.push({
          id: "unmute-for-me",
          label: t("voice.occupant.unmuteForMe"),
          onSelect: () => onSetPeerVolume?.(person.userId, 1),
        });
      } else if (action === "serverMute") {
        personal.push({
          id: "server-mute",
          label: t("voice.occupant.serverMute"),
          onSelect: () => onServerMuteOccupant?.(person.userId, true),
        });
      } else if (action === "serverUnmute") {
        personal.push({
          id: "server-unmute",
          label: t("voice.occupant.serverUnmute"),
          onSelect: () => onServerMuteOccupant?.(person.userId, false),
        });
      } else if (action === "disconnect") {
        mod.push({
          id: "disconnect",
          label: t("voice.occupant.disconnect"),
          danger: true,
          onSelect: () => onDisconnectVoiceOccupant?.(person.userId),
        });
      } else if (action === "kick") {
        mod.push({
          id: "kick",
          label: t("voice.occupant.kick"),
          danger: true,
          onSelect: () => onKickOccupant?.(person.userId, person.displayName),
        });
      } else if (action === "copyName") {
        copy.push({
          id: "copy-name",
          label: t("voice.occupant.copyName"),
          onSelect: () => void navigator.clipboard.writeText(person.displayName),
        });
      }
    }
    const items: ContextMenuItemDef[] = [];
    const groups = [profile, personal, mod, copy].filter(
      (group) => group.length > 0,
    );
    for (const [index, group] of groups.entries()) {
      if (index > 0) {
        items.push({ id: `sep-${index}`, label: "", separator: true });
      }
      items.push(...group);
    }
    return items;
  }

  function draggedChannel(): Channel | undefined {
    return draggedId ? channels.find((c) => c.id === draggedId) : undefined;
  }

  function commitFavorites(ids: string[]) {
    onFavoriteChannelIdsChange?.(ids);
  }

  /**
   * Drop onto the Favorites header (append) or a favourite row (insert before).
   * Categories cannot be favourited.
   */
  function handleDropOnFavorites(insertBeforeId?: string) {
    const dragged = draggedChannel();
    clearDrag();
    if (!dragged || dragged.type === "category" || !onFavoriteChannelIdsChange) {
      return;
    }
    commitFavorites(addFavorite(favoriteChannelIds, dragged, insertBeforeId));
  }

  function handleUnfavoriteDragged() {
    const dragged = draggedChannel();
    clearDrag();
    if (
      !dragged ||
      !favoriteIdSet.has(dragged.id) ||
      !onFavoriteChannelIdsChange
    ) {
      return;
    }
    commitFavorites(removeFavorite(favoriteChannelIds, dragged.id));
  }

  /**
   * Dropping onto a favourite row reorders (or stars) the personal list.
   * Dropping a favourite onto anything else unstars it; it reappears under
   * its real parent. Shared layout (`moveChannel`) only runs for a
   * non-favourite dropped by a manager, same as before.
   */
  function handleDrop(target: Channel) {
    if (!draggedId || draggedId === target.id) {
      clearDrag();
      return;
    }
    const dragged = draggedChannel();
    if (!dragged) {
      clearDrag();
      return;
    }
    if (favoriteIdSet.has(target.id)) {
      handleDropOnFavorites(target.id);
      return;
    }
    if (favoriteIdSet.has(dragged.id)) {
      handleUnfavoriteDragged();
      return;
    }
    if (!canManage) {
      clearDrag();
      return;
    }
    clearDrag();
    if (target.type === "category" && dragged.type !== "category") {
      const kids = childrenByCategory.get(target.id) ?? [];
      onMoveChannel(dragged.id, target.id, kids.length);
      return;
    }
    onMoveChannel(dragged.id, target.parentId, target.position);
  }

  /** "Move up"/"Move down" swap a channel with its immediate neighbour within
   * its own sibling group — the keyboard- and touch-reachable equivalent of
   * dragging one slot, and the only way to reorder at all without a mouse. */
  function moveWithinGroup(
    group: Channel[],
    channel: Channel,
    direction: -1 | 1,
  ) {
    const index = group.findIndex((c) => c.id === channel.id);
    const targetIndex = index + direction;
    if (index === -1 || targetIndex < 0 || targetIndex >= group.length) {
      return;
    }
    onMoveChannel(channel.id, channel.parentId, targetIndex);
  }

  const visibleFavoriteIds = visibleFavs.map((c) => c.id);

  function renderRow(channel: Channel, group: Channel[], inFavorites = false) {
    const index = group.findIndex((c) => c.id === channel.id);
    const occupants =
      channel.type === "voice" ? (voiceOccupancy[channel.id] ?? []) : [];
    const isFavorite = inFavorites || favoriteIdSet.has(channel.id);
    const occupantDropOk = occupantDropAllowed(channel);
    return (
      <div
        key={channel.id}
        className="mb-0.5"
        data-channel-id={channel.id}
        data-channel-type={channel.type}
        onDragOver={(event) => handleRowDragOver(event, channel)}
        onDrop={(event) => {
          if (!draggedOccupant) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          handleRowDrop(channel);
        }}
      >
        <ChannelRow
          channel={channel}
          selected={selectedChannelId === channel.id}
          announceCurrent={
            selectedChannelId === channel.id && !communityHomeSelected
          }
          unread={unread[channel.id] ?? EMPTY_UNREAD}
          connected={activeVoiceChannelId === channel.id}
          canManage={canManage}
          canManageRoles={canManageRoles}
          icon={<ChannelIcon channel={channel} />}
          isDragging={draggedId === channel.id}
          isDragOver={dragOverId === channel.id}
          occupantDragActive={Boolean(draggedOccupant)}
          occupantDropAllowed={occupantDropOk}
          isFavorite={isFavorite}
          onToggleFavorite={
            channel.type !== "category" && onFavoriteChannelIdsChange
              ? () =>
                  commitFavorites(
                    isFavorite
                      ? removeFavorite(favoriteChannelIds, channel.id)
                      : addFavorite(favoriteChannelIds, channel),
                  )
              : undefined
          }
          onSelect={() => {
            onSelectChannel(channel.id);
            onMobileClose?.();
          }}
          onJoinVoice={
            channel.type === "voice" && onJoinVoice
              ? () => {
                  onJoinVoice(channel.id);
                  // Same as a select: on a phone the drawer must get out of
                  // the way of the call it just started.
                  onMobileClose?.();
                }
              : undefined
          }
          onOpenSettings={(section, options) =>
            onOpenChannelSettings(channel, section, options)
          }
          onDelete={() => onDeleteChannel(channel.id)}
          categories={categoryOptions}
          onMoveToCategory={(categoryId) =>
            onMoveChannel(
              channel.id,
              categoryId,
              categoryId
                ? (childrenByCategory.get(categoryId)?.length ?? 0)
                : (channel.type === "voice"
                    ? topLevelVoice.length
                    : topLevelText.length),
            )
          }
          onMoveUp={
            inFavorites
              ? index > 0
                ? () =>
                    commitFavorites(
                      moveFavorite(
                        favoriteChannelIds,
                        channel.id,
                        -1,
                        visibleFavoriteIds,
                      ),
                    )
                : undefined
              : index > 0
                ? () => moveWithinGroup(group, channel, -1)
                : undefined
          }
          onMoveDown={
            inFavorites
              ? index < group.length - 1
                ? () =>
                    commitFavorites(
                      moveFavorite(
                        favoriteChannelIds,
                        channel.id,
                        1,
                        visibleFavoriteIds,
                      ),
                    )
                : undefined
              : index < group.length - 1
                ? () => moveWithinGroup(group, channel, 1)
                : undefined
          }
          onDragStart={() => {
            if (draggedOccupant) {
              return;
            }
            setDraggedId(channel.id);
          }}
          onDragEnd={() => {
            setDraggedId(null);
            setDragOverId(null);
          }}
          onDragOverRow={(event) => handleRowDragOver(event, channel)}
          onDrop={() => handleRowDrop(channel)}
        />
        {occupants.length > 0 && (
          <ul className="ml-2 space-y-0.5 border-l border-ink-4/70 py-0.5 pl-2">
            {occupants.map((person) => {
              const isSelf = Boolean(
                currentUserId && person.userId === currentUserId,
              );
              const canDrag = canDragVoiceOccupant(
                isSelf,
                channel.id,
                canMoveIn,
              );
              return (
                <VoiceOccupantRow
                  key={person.peerId}
                  person={person}
                  channelId={channel.id}
                  isSpeaking={speaking.has(person.peerId)}
                  canDrag={canDrag}
                  isDragging={draggedOccupant?.userId === person.userId}
                  items={menuForOccupant(person, channel)}
                  onDragStart={(next, fromChannelId) => {
                    setDraggedId(null);
                    setDraggedOccupant({
                      userId: next.userId,
                      fromChannelId,
                      isSelf: Boolean(
                        currentUserId && next.userId === currentUserId,
                      ),
                    });
                  }}
                  onDragEnd={() => {
                    setDraggedOccupant(null);
                    setDragOverId(null);
                  }}
                />
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  const headerItems: ContextMenuItemDef[] = server
    ? [
        {
          id: "invite",
          label: t("chrome.invitePeople"),
          icon: UserPlus,
          onSelect: onInvite,
        },
        {
          id: "members",
          label: t("chrome.members"),
          icon: Users,
          onSelect: onOpenMembers,
        },
        ...(canManage
          ? [
              { id: "sep", label: "", separator: true },
              {
                id: "settings",
                label: t("chrome.communitySettings"),
                icon: Settings,
                onSelect: onOpenServerSettings,
              },
            ]
          : []),
      ]
    : [];

  return (
    <aside
      data-immersive-hide=""
      className={`fixed inset-y-0 left-[72px] z-30 flex w-[min(100%-72px,16rem)] flex-col border-r border-ink-4/60 bg-channel transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] md:static md:z-auto md:w-64 md:translate-x-0 ${
        mobileOpen
          ? "translate-x-0"
          : "-translate-x-[calc(100%+72px)] md:translate-x-0"
      }`}
    >
      {/* Above the header, and only when there is one. See `ServerBanner`: a
          server without a banner keeps exactly the column it has always had. */}
      {server && <ServerBanner name={server.name} bannerUrl={server.bannerUrl} />}

      <ContextMenu items={headerItems}>
        {/* `min-h-16` rather than a fixed `h-14`: the row now has to hold a
            36px icon beside two lines of text without either crowding the
            other, and a header that can grow by a few pixels for a long name
            is better than one that truncates the role away. */}
        <div className="flex min-h-16 items-center justify-between gap-2 border-b border-ink-4/60 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {/* Desktop only. The drawer is the same 256px wide at 390px but
                carries one more control — the button that closes it — and the
                icon is what tips the row into truncating the server's name to
                a single letter. The rail's icon is still on screen there. */}
            {server && (
              <span className="hidden h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-ink-3 font-display text-xs font-bold text-paper md:flex">
                <ServerIcon name={server.name} iconUrl={server.iconUrl} />
              </span>
            )}
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate font-display text-base font-bold leading-tight">
                  {server?.name ?? (isLoading ? t("common.loading") : t("chrome.noServer"))}
                </p>
                {/* Says "community" only about a listed community; the Baú
                    flag being on is not a fact about this server. */}
                {communityHomeEnabled && server?.isCommunity && (
                  <span className="shrink-0 rounded bg-signal/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-signal">
                    {t("communityHome.communityBadge")}
                  </span>
                )}
              </div>
              {server?.role && (
                <p className="mt-0.5 text-[11px] uppercase tracking-wider text-paper-muted">
                  {server.role}
                </p>
              )}
            </div>
          </div>
          {/* `shrink-0`: these are all fixed-width controls, so letting flex
              compress them only squeezes their tap targets while the name is
              already truncating anyway. */}
          <div className="flex shrink-0 items-center gap-1">
            {server && (
              <>
                {canManage && (
                  <Tooltip label={t("chrome.communitySettings")}>
                    <button
                      type="button"
                      className="rounded-md p-1.5 text-paper-muted hover:bg-ink-3 hover:text-paper"
                      onClick={onOpenServerSettings}
                    >
                      <Settings className="h-4 w-4" />
                    </button>
                  </Tooltip>
                )}
                <Tooltip label={t("chrome.members")}>
                  <button
                    type="button"
                    className="rounded-md p-1.5 text-paper-muted hover:bg-ink-3 hover:text-paper"
                    onClick={onOpenMembers}
                  >
                    <Users className="h-4 w-4" />
                  </button>
                </Tooltip>
                {/* An icon, not the word.
                    The column is a fixed 256px and this row also carries a
                    36px server icon, two icon buttons and the name. Spelled
                    out, "Convidar" took about 66 of those pixels and left the
                    name roughly 48 — which is why "QG do pqp" rendered as
                    "QG...". The label is the one thing here that could give
                    the pixels back, and losing it costs least: invite is also
                    in this header's context menu and in the rail's, both of
                    them spelled out, and the signal colour keeps it reading as
                    the action of the row rather than a third grey icon. */}
                <Tooltip label={t("chrome.invitePeople")}>
                  <button
                    type="button"
                    className="rounded-md p-1.5 text-signal hover:bg-ink-3"
                    onClick={onInvite}
                  >
                    <UserPlus className="h-4 w-4" />
                  </button>
                </Tooltip>
              </>
            )}
            {onMobileClose && (
              <button
                type="button"
                className="rounded p-1 hover:bg-ink-3 md:hidden"
                aria-label={t("chrome.closeChannelList")}
                onClick={onMobileClose}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </ContextMenu>

      {server && (
        <div className="px-3 pt-3">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-0/60 px-2.5 py-2 text-xs text-text-muted transition-colors hover:border-border-strong hover:text-text"
            onClick={() => setSearchOpen(true)}
          >
            <Search className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t("chrome.searchMessages")}</span>
            <kbd className="ml-auto hidden shrink-0 rounded border border-border px-1 py-px text-[10px] font-sans md:inline">
              {SEARCH_SHORTCUT_HINT}
            </kbd>
          </button>
          <SearchDialog
            open={searchOpen}
            serverId={server.id}
            serverName={server.name}
            onClose={() => setSearchOpen(false)}
            onNavigate={onMobileClose}
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 pb-3 pt-2">
        {isLoading ? (
          <ChannelListSkeleton />
        ) : (
          <>
            {visibleFavs.length > 0 && server && (
              <FavoritesSection
                collapsed={collapsed.has(favoritesCollapseKey(server.id))}
                onToggle={() =>
                  toggleCollapsed(favoritesCollapseKey(server.id))
                }
                isDragOver={dragOverId === FAVORITES_ZONE && !draggedOccupant}
                onDragOver={() =>
                  !draggedOccupant && draggedId && setDragOverId(FAVORITES_ZONE)
                }
                onDrop={() => {
                  if (draggedOccupant) {
                    showDropHint("text");
                    clearDrag();
                    return;
                  }
                  handleDropOnFavorites();
                }}
              >
                {visibleFavs.map((channel) =>
                  renderRow(channel, visibleFavs, true),
                )}
              </FavoritesSection>
            )}

            {communityHomeEnabled && server && onSelectCommunityHome && (
              <div className="mb-3 px-1">
                <button
                  type="button"
                  data-community-home-row
                  aria-current={communityHomeSelected ? "page" : undefined}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                    communityHomeSelected
                      ? "bg-ink-4 text-paper"
                      : "text-paper-muted hover:bg-ink-4/70 hover:text-paper",
                  )}
                  onClick={() => {
                    onSelectCommunityHome();
                    onMobileClose?.();
                  }}
                >
                  <Archive
                    className={cn(
                      "mt-0.5 h-4 w-4 shrink-0",
                      communityHomeSelected ? "text-signal" : "text-paper-muted",
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-paper">
                        {t("communityHome.channelName")}
                      </span>
                      {communityHomeUnread > 0 ? (
                        <span
                          className="ml-auto min-w-4 shrink-0 rounded-full bg-danger px-1 py-0.5 text-center text-[10px] font-bold leading-none text-paper"
                          aria-label={t("communityHome.badge.unread", {
                            count: communityHomeUnread,
                          })}
                          data-community-home-unread
                        >
                          {formatBadgeCount(communityHomeUnread)}
                        </span>
                      ) : (
                        communityHomeShowNew && (
                          <span className="shrink-0 rounded bg-signal/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-signal">
                            {t("communityHome.badge.new")}
                          </span>
                        )
                      )}
                    </span>
                    <span className="block truncate text-[10px] text-paper-muted">
                      {t("communityHome.channelHint")}
                    </span>
                  </span>
                </button>
              </div>
            )}

            <ChannelSection
              label={t("chrome.text")}
              canManage={canManage}
              onAdd={() => onCreateChannel("text", false)}
              onAddPrivate={() => onCreateChannel("text", true)}
              isDragOver={dragOverId === TEXT_ZONE && !draggedOccupant}
              onDragOver={(event) => {
                if (draggedOccupant) {
                  event.dataTransfer.dropEffect = "none";
                  return;
                }
                if (draggedId) {
                  setDragOverId(TEXT_ZONE);
                }
              }}
              onDrop={() => {
                if (draggedOccupant) {
                  showDropHint("text");
                  clearDrag();
                  return;
                }
                const dragged = draggedChannel();
                if (dragged && favoriteIdSet.has(dragged.id)) {
                  handleUnfavoriteDragged();
                } else {
                  clearDrag();
                }
              }}
            >
              {topLevelText.map((channel) => renderRow(channel, topLevelText))}
            </ChannelSection>

            <ChannelSection
              label={t("chrome.voice")}
              canManage={canManage}
              onAdd={() => onCreateChannel("voice", false)}
              onAddPrivate={() => onCreateChannel("voice", true)}
              isDragOver={dragOverId === VOICE_ZONE && !draggedOccupant}
              onDragOver={(event) => {
                if (draggedOccupant) {
                  event.dataTransfer.dropEffect = "none";
                  return;
                }
                if (draggedId) {
                  setDragOverId(VOICE_ZONE);
                }
              }}
              onDrop={() => {
                if (draggedOccupant) {
                  clearDrag();
                  return;
                }
                const dragged = draggedChannel();
                if (dragged && favoriteIdSet.has(dragged.id)) {
                  handleUnfavoriteDragged();
                } else {
                  clearDrag();
                }
              }}
            >
              {topLevelVoice.map((channel) =>
                renderRow(channel, topLevelVoice),
              )}
            </ChannelSection>

            {(categories.length > 0 || canManage) && (
              <div className="mb-4">
                <div className="mb-1 flex items-center justify-between px-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-paper-muted">
                    {t("chrome.categories")}
                  </span>
                  {canManage && (
                    /* Also gains an accessible name it never had: the old
                       `title` is not one, so this button was unnamed to a
                       screen reader. */
                    <Tooltip label={t("chrome.newCategory")}>
                      <button
                        type="button"
                        className="rounded p-0.5 text-paper-muted hover:bg-ink-3 hover:text-paper"
                        onClick={() => onCreateChannel("category", false)}
                      >
                        <FolderPlus className="h-3.5 w-3.5" />
                      </button>
                    </Tooltip>
                  )}
                </div>
                {categories.map((category) => {
                  const kids = childrenByCategory.get(category.id) ?? [];
                  const isCollapsed = collapsed.has(category.id);
                  return (
                    <div key={category.id} className="mb-1">
                      <CategoryHeader
                        category={category}
                        collapsed={isCollapsed}
                        onToggle={() => toggleCollapsed(category.id)}
                        canManage={canManage}
                        onRename={() => onRenameChannel(category)}
                        onDelete={() => onDeleteChannel(category.id)}
                        isDragOver={dragOverId === category.id && !draggedOccupant}
                        onDragStart={() => setDraggedId(category.id)}
                        onDragEnd={() => {
                          setDraggedId(null);
                          setDragOverId(null);
                        }}
                        onDragOverRow={() =>
                          !draggedOccupant &&
                          draggedId &&
                          setDragOverId(category.id)
                        }
                        onDrop={() => {
                          if (draggedOccupant) {
                            showDropHint("category");
                            clearDrag();
                            return;
                          }
                          handleDrop(category);
                        }}
                      />
                      {!isCollapsed && (
                        <div className="ml-2 border-l border-ink-4/70 pl-2">
                          {kids.length === 0 ? (
                            <p className="px-2 py-1 text-xs italic text-paper-muted">
                              {t("chrome.emptyCategory")}
                            </p>
                          ) : (
                            kids.map((channel) => renderRow(channel, kids))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {dropHint && (
        <p
          role="status"
          className="border-t border-ink-4/60 px-3 py-2 text-xs text-paper"
        >
          {dropHint}
        </p>
      )}

      {footer}
    </aside>
  );
}

function FavoritesSection({
  collapsed,
  onToggle,
  isDragOver,
  onDragOver,
  onDrop,
  children,
}: {
  collapsed: boolean;
  onToggle: () => void;
  isDragOver: boolean;
  onDragOver: () => void;
  onDrop: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="mb-4">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          onDragOver();
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDrop();
        }}
        className={cn(
          "mb-1 flex items-center justify-between px-2",
          isDragOver && "rounded-md ring-1 ring-inset ring-signal/60",
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-paper-muted hover:text-paper"
          aria-expanded={!collapsed}
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 transition-transform",
              !collapsed && "rotate-90",
            )}
          />
          <span className="truncate">{t("chrome.favorites")}</span>
        </button>
      </div>
      {!collapsed && children}
    </div>
  );
}

function ChannelSection({
  label,
  canManage,
  onAdd,
  onAddPrivate,
  children,
  isDragOver = false,
  onDragOver,
  onDrop,
}: {
  label: string;
  canManage: boolean;
  onAdd: () => void;
  onAddPrivate: () => void;
  children: ReactNode;
  isDragOver?: boolean;
  onDragOver?: (event: DragEvent) => void;
  onDrop?: () => void;
}) {
  const { t } = useTranslation();
  const typeName = label.toLowerCase();
  return (
    <div className="mb-4">
      <div
        className={cn(
          "mb-1 flex items-center justify-between px-2",
          isDragOver && "rounded-md ring-1 ring-inset ring-signal/60",
        )}
        onDragOver={
          onDragOver
            ? (event) => {
                event.preventDefault();
                onDragOver(event);
              }
            : undefined
        }
        onDrop={
          onDrop
            ? (event) => {
                event.preventDefault();
                onDrop();
              }
            : undefined
        }
      >
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-paper-muted">
          {label}
        </span>
        {canManage && (
          <div className="flex gap-0.5">
            <Tooltip label={t("chrome.newChannel", { name: typeName })}>
              <button
                type="button"
                className="rounded p-0.5 text-paper-muted hover:bg-ink-3 hover:text-paper"
                onClick={onAdd}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
            <Tooltip label={t("chrome.newPrivateChannel", { name: typeName })}>
              <button
                type="button"
                className="rounded p-0.5 text-paper-muted hover:bg-ink-3 hover:text-paper"
                onClick={onAddPrivate}
              >
                <Lock className="h-3 w-3" />
              </button>
            </Tooltip>
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

function CategoryHeader({
  category,
  collapsed,
  onToggle,
  canManage,
  onRename,
  onDelete,
  isDragOver,
  onDragStart,
  onDragEnd,
  onDragOverRow,
  onDrop,
}: {
  category: Channel;
  collapsed: boolean;
  onToggle: () => void;
  canManage: boolean;
  onRename: () => void;
  onDelete: () => void;
  isDragOver: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverRow: () => void;
  onDrop: () => void;
}) {
  const { t } = useTranslation();
  const items: ContextMenuItemDef[] = canManage
    ? [
        {
          id: "rename",
          label: t("chrome.renameCategory"),
          icon: Pencil,
          onSelect: onRename,
        },
        { id: "sep", label: "", separator: true },
        {
          id: "delete",
          label: t("chrome.deleteCategory"),
          icon: Trash2,
          danger: true,
          onSelect: onDelete,
        },
      ]
    : [];

  return (
    <ContextMenu items={items}>
      <div
        draggable={canManage}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={(event) => {
          event.preventDefault();
          onDragOverRow();
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDrop();
        }}
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold uppercase tracking-wide text-paper-muted hover:bg-ink-3/70",
          isDragOver && "ring-1 ring-inset ring-signal/60",
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1"
          aria-expanded={!collapsed}
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 transition-transform",
              !collapsed && "rotate-90",
            )}
          />
          <span className="truncate">{category.name}</span>
        </button>
      </div>
    </ContextMenu>
  );
}

function ChannelRow({
  channel,
  selected,
  announceCurrent = selected,
  unread,
  connected = false,
  canManage,
  canManageRoles = false,
  icon,
  isDragging,
  isDragOver,
  occupantDragActive = false,
  occupantDropAllowed = false,
  isFavorite = false,
  onToggleFavorite,
  onSelect,
  onJoinVoice,
  onOpenSettings,
  onDelete,
  categories,
  onMoveToCategory,
  onMoveUp,
  onMoveDown,
  onDragStart,
  onDragEnd,
  onDragOverRow,
  onDrop,
}: {
  channel: Channel;
  selected: boolean;
  /** False when Baú is the open page so two rows do not both claim current. */
  announceCurrent?: boolean;
  unread: UnreadState;
  connected?: boolean;
  canManage: boolean;
  canManageRoles?: boolean;
  icon: ReactNode;
  isDragging: boolean;
  isDragOver: boolean;
  occupantDragActive?: boolean;
  occupantDropAllowed?: boolean;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  onSelect: () => void;
  onJoinVoice?: () => void;
  onOpenSettings: (
    section: "overview" | "permissions" | "webhooks",
    options?: { forceAdvanced?: boolean },
  ) => void;
  onDelete: () => void;
  categories: Array<{ id: string; name: string }>;
  onMoveToCategory: (categoryId: string | null) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverRow: (event: DragEvent) => void;
  onDrop: () => void;
}) {
  const { t } = useTranslation();
  const notifications = useChannelNotificationLevel(channel);
  const canOpenSettings = canManage || canManageRoles;
  const openSettings = () =>
    onOpenSettings(canManage ? "overview" : "permissions");
  const items: ContextMenuItemDef[] = [];

  if (onToggleFavorite) {
    items.push({
      id: "favorite",
      label: isFavorite
        ? t("chrome.unfavoriteChannel")
        : t("chrome.favoriteChannel"),
      icon: isFavorite ? StarOff : Star,
      onSelect: onToggleFavorite,
    });
  }

  if (onJoinVoice && !connected) {
    items.push({
      id: "join",
      label: t("voice.join"),
      icon: Phone,
      onSelect: onJoinVoice,
    });
  }

  if (canOpenSettings) {
    if (items.length > 0) {
      items.push({ id: "sep-fav", label: "", separator: true });
    }
    items.push({
      id: "settings",
      label: t("chrome.channelSettings"),
      icon: Settings,
      onSelect: openSettings,
    });
  }

  if (canManage) {
    const moveItems: ContextMenuItemDef[] = [];
    if (onMoveUp) {
      moveItems.push({
        id: "move-up",
        label: t("chrome.moveUp"),
        icon: ArrowUp,
        onSelect: onMoveUp,
      });
    }
    if (onMoveDown) {
      moveItems.push({
        id: "move-down",
        label: t("chrome.moveDown"),
        icon: ArrowDown,
        onSelect: onMoveDown,
      });
    }
    if (channel.parentId) {
      moveItems.push({
        id: "uncategorize",
        label: t("chrome.removeFromCategory"),
        icon: FolderMinus,
        onSelect: () => onMoveToCategory(null),
      });
    }
    for (const category of categories) {
      if (category.id === channel.parentId) {
        continue;
      }
      moveItems.push({
        id: `move-to-${category.id}`,
        label: t("chrome.moveToCategory", { name: category.name }),
        icon: FolderInput,
        onSelect: () => onMoveToCategory(category.id),
      });
    }
    if (moveItems.length > 0) {
      items.push({ id: "sep-1", label: "", separator: true }, ...moveItems);
    }
    items.push(
      { id: "sep-2", label: "", separator: true },
      {
        id: "delete",
        label: t("chrome.deleteChannel"),
        icon: Trash2,
        danger: true,
        onSelect: onDelete,
      },
    );
  }

  if (!canManage && isFavorite && (onMoveUp || onMoveDown)) {
    if (items.length > 0) {
      items.push({ id: "sep-fav-move", label: "", separator: true });
    }
    if (onMoveUp) {
      items.push({
        id: "move-up",
        label: t("chrome.moveUp"),
        icon: ArrowUp,
        onSelect: onMoveUp,
      });
    }
    if (onMoveDown) {
      items.push({
        id: "move-down",
        label: t("chrome.moveDown"),
        icon: ArrowDown,
        onSelect: onMoveDown,
      });
    }
  }

  items.push(
    ...(items.length > 0
      ? [{ id: "sep-3", label: "", separator: true } as ContextMenuItemDef]
      : []),
    {
      id: "copy-id",
      label: t("chrome.copyChannelId"),
      icon: Copy,
      onSelect: () => void navigator.clipboard.writeText(channel.id),
    },
    ...notificationLevelItems("notify", notifications, "server"),
  );

  const muted = notifications.level === "none";
  const hasUnread = !selected && unread.count > 0;
  // A muted channel keeps counting for the read cursor, but nothing about it
  // should pull the eye — that is the whole point of muting it.
  const mentions = selected || muted ? 0 : unread.mentions;

  return (
    <ContextMenu items={items}>
      <div
        draggable={channel.type === "category" ? canManage : true}
        onDragStart={(event) => {
          if (
            (event.target as HTMLElement).closest(
              "[data-channel-favorite], [data-channel-join], [data-channel-settings]",
            )
          ) {
            event.preventDefault();
            return;
          }
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        onDragOver={(event) => {
          if (occupantDragActive) {
            event.preventDefault();
            event.dataTransfer.dropEffect = occupantDropAllowed
              ? "move"
              : "none";
            onDragOverRow(event);
            return;
          }
          event.preventDefault();
          onDragOverRow(event);
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDrop();
        }}
        className={cn(
          "group relative flex items-center gap-1 rounded-md px-2 py-1.5 text-sm",
          selected
            ? "bg-ink-3 text-paper"
            : "text-paper-muted hover:bg-ink-3/70 hover:text-paper",
          connected && "bg-signal/10 text-signal ring-1 ring-inset ring-signal/30",
          hasUnread && !muted && !selected && !connected && "text-paper",
          muted && !selected && !connected && "opacity-50",
          isDragging && "opacity-40",
          isDragOver &&
            (occupantDragActive
              ? "bg-signal/15 ring-2 ring-inset ring-signal/70"
              : "ring-1 ring-inset ring-signal/60"),
        )}
      >
        {hasUnread && !muted && (
          <span
            aria-hidden="true"
            className="absolute -left-1 top-1/2 h-4 w-1 -translate-y-1/2 rounded-r-full bg-paper"
          />
        )}
        {/* A voice row is the call: one click joins it, the way a text row
            opens its channel. The old phone tile and double-click were two
            more ways to do the same thing, and the tile read as a state
            ("someone is calling") rather than an action. Connected rows
            fall back to plain selection, so clicking the room you are in
            just shows it. */}
        <button
          type="button"
          onClick={onJoinVoice && !connected ? onJoinVoice : onSelect}
          aria-current={announceCurrent ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {icon}
          <span className={cn("truncate", hasUnread && !muted && "font-semibold")}>
            {channel.name}
          </span>
          {hasUnread && !muted && <span className="sr-only">{t("chrome.unreadSr")}</span>}
          {muted && <span className="sr-only">{t("chrome.mutedSr")}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {connected && (
              <>
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full bg-signal"
                />
                <span className="sr-only">{t("chrome.connected")}</span>
              </>
            )}
            {channel.isPrivate && (
              <span className="rounded bg-warning/10 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-warning">
                {t("chrome.private")}
              </span>
            )}
            {mentions > 0 && (
              <span
                className="min-w-4 rounded-full bg-danger px-1 py-0.5 text-center text-[10px] font-bold leading-none text-paper"
                aria-label={t("chrome.unreadMentions", { count: mentions })}
              >
                {formatBadgeCount(mentions)}
              </span>
            )}
          </span>
        </button>
        {onToggleFavorite && (
          <Tooltip
            label={
              isFavorite
                ? t("chrome.unfavoriteChannel")
                : t("chrome.favoriteChannel")
            }
          >
            <button
              type="button"
              data-channel-favorite=""
              draggable={false}
              className={cn(
                CHANNEL_ACTION_TILE,
                // The star slides in from the right edge on hover and stays
                // put once the channel is a favourite.
                "transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
                isFavorite
                  ? "text-warning"
                  : "translate-x-2 text-paper-muted opacity-0 group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:translate-x-0 group-focus-within:opacity-100",
              )}
              aria-label={
                isFavorite
                  ? t("chrome.unfavoriteChannel")
                  : t("chrome.favoriteChannel")
              }
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggleFavorite();
              }}
            >
              <Star
                className={cn("h-3.5 w-3.5", isFavorite && "fill-current")}
              />
            </button>
          </Tooltip>
        )}
        {canOpenSettings && (
          <Tooltip label={t("chrome.channelSettings")}>
            <button
              type="button"
              data-channel-settings=""
              draggable={false}
              className={cn(
                CHANNEL_ACTION_TILE,
                "text-paper-muted transition-opacity duration-150 ease-out motion-reduce:transition-none",
                selected
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
              )}
              aria-label={t("chrome.channelSettings")}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openSettings();
              }}
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        )}
      </div>
    </ContextMenu>
  );
}

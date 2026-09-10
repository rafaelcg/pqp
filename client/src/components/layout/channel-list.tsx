import {
  ArrowDown,
  ArrowUp,
  Archive,
  ChevronRight,
  Copy,
  Eraser,
  ExternalLink,
  FolderInput,
  FolderMinus,
  FolderPlus,
  Hand,
  Lock,
  Mic,
  MicOff,
  PanelLeftOpen,
  Pencil,
  Phone,
  PhoneOff,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2,
  UserMinus,
  UserPlus,
  UserRound,
  Users,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  FAVORITE_CHANNELS_PER_SERVER_MAX,
  isVoiceRoomChannelType,
  isWatchPartyChannelType,
  liveStateFromRoster,
  liveStateFromStream,
  type WatchParty,
  type Channel,
  type ChannelLiveState,
  type ChannelType,
  type Server,
  type VoiceParticipant,
} from "@pqp/shared";
import type { ChannelLive } from "@/hooks/use-voice";
import { LivePartyBlock } from "@/components/watch-party/live-party-block";
import { SearchDialog } from "@/components/search/search-dialog";
import {
  ChannelIcon,
  channelIconIsPrivateLock,
} from "@/components/layout/channel-icon";
import { SidebarResizeHandle } from "@/components/layout/sidebar-resize-handle";
import { useChannelSidebarWidth } from "@/hooks/use-channel-sidebar-width";
import {
  resolveVoiceRowClick,
  resolveVoiceRowDoubleClick,
  resolveVoiceRowKey,
} from "@/lib/voice-row-interaction";
import { ServerBanner, ServerIcon } from "@/components/layout/server-identity";
import {
  ContextMenu,
  type ContextMenuItemDef,
} from "@/components/ui/context-menu";
import { ChannelListSkeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { VoiceOccupantRow } from "@/components/layout/voice-occupant-row";
import { useProfilePopover } from "@/components/user/user-profile-popover";
import { publicProfileHref } from "@/components/user/profile-relations";
import type { ServerMember } from "@/lib/api";
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
import { FeatureHint, useFeatureHintEnabled } from "@/components/layout/feature-hint";
import { ChannelSessionHint } from "@/components/layout/channel-session-hint";
import { formatSessionRelativeTime } from "@/lib/channel-session-schedule";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { isWatchPartyChannelsEnabled } from "@/lib/watch-party-channels";

export interface UnreadState {
  count: number;
  mentions: number;
}

const EMPTY_UNREAD: UnreadState = { count: 0, mentions: 0 };

/** Drop-target ids that are not channels: the Pinados / TEXT / VOICE headers. */
const PINNED_ZONE = "__pinned__";
const TEXT_ZONE = "__text__";
const VOICE_ZONE = "__voice__";

/** Apple keyboards label the same chord differently, and the hint is the point. */
const SEARCH_SHORTCUT_HINT =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.userAgent)
    ? "⌘K"
    : "Ctrl K";

/** Equal-width action tiles on a channel row (pin, settings). */
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
  /** channelId -> upcoming/live session start time, for the sidebar's "próxima: sex 21h" hint. Behind VITE_WATCH_PARTY_SCHEDULE upstream. */
  upcomingSessionStartsAtByChannel?: Record<string, string>;
  channels: Channel[];
  selectedChannelId: string | null;
  canManage: boolean;
  canManageRoles?: boolean;
  /**
   * MANAGE_MESSAGES, server-wide. Gates the "clear recent messages" entry on a
   * text channel's menu. Separate from `canManage` (MANAGE_CHANNELS) because
   * the two cargos genuinely differ: a moderator clears a raid, a manager
   * renames and deletes channels, and neither implies the other.
   */
  canManageMessages?: boolean;
  isLoading?: boolean;
  voiceOccupancy?: Record<string, VoiceParticipant[]>;
  /**
   * channelId -> the server's `channel-live` for it: the HLS stream (or
   * null) and how many people watch it without a seat. Preferred over the
   * roster for the live row, because the roster only reaches this client
   * for rooms it is in or has been told about, and never counts watchers.
   */
  channelLive?: Record<string, ChannelLive>;
  speakingPeerIds?: string[];
  activeVoiceChannelId: string | null;
  unread: Record<string, UnreadState>;
  onSelectChannel: (channelId: string) => void;
  /**
   * Voice channels only. Double-click joins the call so you do not have to
   * open the channel and then hit Join. Single click still just selects.
   */
  onJoinVoice?: (channelId: string) => void;
  /**
   * Live watch parties in this server, for the block above the categories.
   * Empty (or absent) draws nothing at all. See
   * `components/watch-party/live-party-block.tsx`.
   */
  liveParties?: readonly WatchParty[];
  /** One click: select the channel, which is what starts watching. */
  onWatchLiveParty?: (channelId: string) => void;
  /**
   * Whether this person holds `START_WATCH_PARTY` anywhere in this server.
   * Server-level rather than per channel, because the control creates the
   * channel it will run in, so there is no channel to ask about yet.
   */
  canStartWatchParty?: boolean;
  /** Opens the setup flow. Absent for anyone who may not start one. */
  onCreateWatchParty?: () => void;
  /** The signed-in account, for self-drag and "mute for me". */
  currentUserId?: string | null;
  /** Seats with a move in flight: no second drag. */
  pendingMoveUserIds?: string[];
  peerVolumes?: Record<string, number>;
  /** Screen-share playback volumes, keyed on userId like `peerVolumes`. */
  screenVolumes?: Record<string, number>;
  /**
   * Whose share is currently carrying sound. Only these get the second slider:
   * a share-volume knob on a silent share moves nothing.
   */
  screenAudioUserIds?: string[];
  canMoveIn?: (channelId: string) => boolean;
  canConnectIn?: (channelId: string) => boolean;
  canMuteIn?: (channelId: string) => boolean;
  canKickUser?: (userId: string) => boolean;
  onMoveVoiceOccupant?: (userId: string, channelId: string) => void;
  onDisconnectVoiceOccupant?: (userId: string) => void;
  onServerMuteOccupant?: (userId: string, muted: boolean) => void;
  /** Lower one person's raised hand: "you're up". Same bit as the mute. */
  onLowerOccupantHand?: (userId: string) => void;
  onKickOccupant?: (userId: string, name: string) => void;
  onSetPeerVolume?: (userId: string, volume: number) => void;
  onSetScreenVolume?: (userId: string, volume: number) => void;
  /**
   * `watch_party` is only ever asked for while `isWatchPartyChannelsEnabled()`
   * is true; with the flag off the sidebar has no button that sends it.
   */
  onCreateChannel: (type: ChannelType, isPrivate: boolean) => void;
  onRenameChannel: (channel: Channel) => void;
  onOpenChannelSettings: (
    channel: Channel,
    section: "overview" | "permissions" | "webhooks",
    options?: { forceAdvanced?: boolean },
  ) => void;
  onDeleteChannel: (channelId: string) => void;
  /** Open the "clear recent messages" dialog for a text channel. */
  onPurgeChannel?: (channel: Channel) => void;
  onMoveChannel: (
    channelId: string,
    parentId: string | null,
    index: number,
  ) => void;
  /**
   * This person's pinned channel ids for the open server, in display order.
   * Stored as `favoriteChannels` in user prefs. A change writes the whole
   * preference map (see `writeFavoritesForServer`).
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
  /**
   * Current server roster, so a seated person with a claimed handle can get
   * Ver perfil / pqp.gg/@handle on right-click. Absent handle: no link.
   */
  members?: readonly ServerMember[];
  /**
   * Draw the list as a strip of icons instead of a 16rem column, giving the
   * width back to whatever is on the right — in practice a screen share.
   * `lib/channel-sidebar-preference.ts` owns the rule; this only draws it, and
   * only above `md`, where the list is a column rather than a drawer.
   */
  iconsOnly?: boolean;
  /**
   * Puts the labels back. Without it there is no way out of the strip, so
   * without it the strip is not drawn at all: `iconsOnly` alone cannot strand
   * anybody in a sidebar they cannot reopen.
   */
  onExpand?: () => void;
}

/**
 * The row's live state, merged from both sources. A `channel-live` answer,
 * even `stream: null`, outranks the roster: it is the server's word on the
 * egress, while a `sharingScreen` flag is only the WebRTC share.
 */
export function liveStateForChannel(
  live: ChannelLive | undefined,
  participants: readonly VoiceParticipant[] | undefined,
): ChannelLiveState {
  return live
    ? liveStateFromStream(live.stream, participants, live.watching)
    : liveStateFromRoster(participants);
}

export function ChannelList({
  server,
  channels,
  selectedChannelId,
  canManage,
  canManageRoles = false,
  canManageMessages = false,
  isLoading = false,
  voiceOccupancy = {},
  channelLive = {},
  speakingPeerIds = [],
  activeVoiceChannelId,
  unread,
  onSelectChannel,
  onJoinVoice,
  liveParties,
  onWatchLiveParty,
  canStartWatchParty,
  onCreateWatchParty,
  currentUserId = null,
  pendingMoveUserIds = [],
  peerVolumes = {},
  screenVolumes = {},
  screenAudioUserIds = [],
  canMoveIn = () => false,
  canConnectIn = () => true,
  canMuteIn = () => false,
  canKickUser = () => false,
  onMoveVoiceOccupant,
  onDisconnectVoiceOccupant,
  onServerMuteOccupant,
  onLowerOccupantHand,
  onKickOccupant,
  onSetPeerVolume,
  onSetScreenVolume,
  onCreateChannel,
  onRenameChannel,
  onOpenChannelSettings,
  onDeleteChannel,
  onPurgeChannel,
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
  members = [],
  iconsOnly = false,
  onExpand,
  upcomingSessionStartsAtByChannel = {},
}: ChannelListProps) {
  const { t } = useTranslation();
  const {
    width: sidebarWidth,
    maxWidth: sidebarMaxWidth,
    setWidth: setSidebarWidth,
    commitWidth: commitSidebarWidth,
  } = useChannelSidebarWidth();
  const channelPinHintEnabled = useFeatureHintEnabled("channelPin");
  const watchPartyOn = isWatchPartyChannelsEnabled();
  /**
   * A WATCH PARTY IS NOT A CHANNEL IN THE LIST, AND THIS IS WHERE THAT IS
   * ENFORCED.
   *
   * The first version gave watch parties a section of their own under Voice,
   * which is exactly the treatment they were supposed to escape: a live party
   * then appeared twice, once as the block at the top and again as a row with
   * its own occupant list, so one event had two representations and the second
   * one made it look like a voice channel with a badge.
   *
   * The channel still exists. It is the party's voice room, the key the HLS
   * egress and `channel_sessions` are hung on, and the home of the chat during
   * the show. It is simply never listed: filtering `channels` once, here,
   * keeps it out of the top-level groups, the categories, the pinned row and
   * the icons-only rail without four separate filters that could disagree.
   *
   * With the flag off nothing is hidden and a `watch_party` channel is still
   * an ordinary voice row, so a production build that has not flipped the flag
   * behaves exactly as it did before any of this.
   */
  const listed = watchPartyOn
    ? channels.filter((c) => !isWatchPartyChannelType(c.type))
    : channels;
  const visibleFavs = visibleFavoriteChannels(listed, favoriteChannelIds);
  const favoriteIdSet = new Set(visibleFavs.map((c) => c.id));
  const topLevelText = sortByPosition(
    listed.filter(
      (c) => c.type === "text" && !c.parentId && !favoriteIdSet.has(c.id),
    ),
  );
  const topLevelVoice = sortByPosition(
    listed.filter(
      (c) =>
        isVoiceRoomChannelType(c.type) &&
        !c.parentId &&
        !favoriteIdSet.has(c.id),
    ),
  );
  /**
   * Live state per watch party room: the server's `channel-live` when it has
   * said anything about the channel, the roster otherwise (see @pqp/shared).
   */
  function liveStateFor(channel: Channel): ChannelLiveState | undefined {
    if (!watchPartyOn || !isWatchPartyChannelType(channel.type)) {
      return undefined;
    }
    return liveStateForChannel(
      channelLive[channel.id],
      voiceOccupancy[channel.id],
    );
  }
  const categories = sortByPosition(
    listed.filter((c) => c.type === "category"),
  );
  const categoryOptions = categories.map((c) => ({ id: c.id, name: c.name }));
  const childrenByCategory = new Map<string, Channel[]>();
  for (const category of categories) {
    childrenByCategory.set(
      category.id,
      sortByPosition(
        listed.filter(
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
  const memberById = useMemo(() => {
    const map = new Map<string, ServerMember>();
    for (const member of members) {
      map.set(member.id, member);
    }
    return map;
  }, [members]);
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

  // --- icons only ---------------------------------------------------------
  // Below every hook, so the strip and the column are the same component with
  // the same state: expanding puts you back on the category you had collapsed
  // and the search you had open, because neither was ever unmounted.
  //
  // The drawer is never drawn as a strip (`mobileOpen`): under `md` the list
  // is already fully hidden, so collapsing it saves nothing and costs the
  // names. `App.tsx` will not ask for it there either; this is the belt.
  if (iconsOnly && !mobileOpen && onExpand) {
    const railGroups = channelRailGroups({
      favorites: visibleFavs,
      text: topLevelText,
      voice: topLevelVoice,
      categories,
      childrenByCategory,
    });

    return (
      <aside
        data-immersive-hide=""
        data-channel-rail=""
        className="hidden w-[72px] shrink-0 flex-col border-r border-ink-4/60 bg-channel md:flex"
      >
        <div className="flex flex-col items-center gap-1 border-b border-ink-4/60 px-2 py-2">
          <Tooltip label={t("chrome.expandChannelList")} side="right">
            <button
              type="button"
              data-channel-rail-expand=""
              className="flex h-9 w-9 items-center justify-center rounded-lg text-paper-muted hover:bg-ink-3 hover:text-paper"
              onClick={onExpand}
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          </Tooltip>
          {server && (
            <Tooltip label={t("chrome.searchMessages")} side="right">
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-paper-muted hover:bg-ink-3 hover:text-paper"
                onClick={() => setSearchOpen(true)}
              >
                <Search className="h-4 w-4" />
              </button>
            </Tooltip>
          )}
        </div>
        {server && (
          <SearchDialog
            open={searchOpen}
            serverId={server.id}
            serverName={server.name}
            onClose={() => setSearchOpen(false)}
            onNavigate={onMobileClose}
          />
        )}
        <div className="flex flex-1 flex-col items-center gap-1 overflow-y-auto px-2 py-2">
          {communityHomeEnabled && server && onSelectCommunityHome && (
            <Tooltip label={t("communityHome.channelName")} side="right">
              <button
                type="button"
                data-community-home-row
                aria-current={communityHomeSelected ? "page" : undefined}
                className={cn(
                  "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors",
                  communityHomeSelected
                    ? "bg-ink-4 text-signal"
                    : "text-paper-muted hover:bg-ink-4/70 hover:text-paper",
                )}
                onClick={onSelectCommunityHome}
              >
                <Archive className="h-4 w-4" aria-hidden />
                {communityHomeUnread > 0 && (
                  <span
                    data-community-home-unread
                    className="absolute -right-1 -top-1 min-w-4 rounded-full bg-danger px-1 py-0.5 text-center text-[10px] font-bold leading-none text-paper"
                    aria-label={t("communityHome.badge.unread", {
                      count: communityHomeUnread,
                    })}
                  >
                    {formatBadgeCount(communityHomeUnread)}
                  </span>
                )}
              </button>
            </Tooltip>
          )}
          {railGroups.map((group, index) => (
            <div
              key={group.key}
              className={cn(
                "flex w-full flex-col items-center gap-1",
                index > 0 && "mt-1 border-t border-ink-4/50 pt-2",
              )}
            >
              {group.channels.map((channel) => (
                <ChannelRailItem
                  key={channel.id}
                  channel={channel}
                  selected={selectedChannelId === channel.id}
                  connected={activeVoiceChannelId === channel.id}
                  unread={unread[channel.id] ?? EMPTY_UNREAD}
                  occupants={
                    isVoiceRoomChannelType(channel.type)
                      ? (voiceOccupancy[channel.id]?.length ?? 0)
                      : 0
                  }
                  liveState={liveStateFor(channel)}
                  onSelect={() => onSelectChannel(channel.id)}
                  onJoinVoice={
                    isVoiceRoomChannelType(channel.type) && onJoinVoice
                      ? () => onJoinVoice(channel.id)
                      : undefined
                  }
                />
              ))}
            </div>
          ))}
        </div>
        {footer}
      </aside>
    );
  }

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
    if (!draggedOccupant || pendingMoveUserIds.includes(draggedOccupant.userId)) {
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

  /**
   * The two sliders a left-click on this row opens, or nothing.
   *
   * Nothing for ourselves and for a channel we are not in: playback volume is
   * a knob on audio this machine is receiving, and offering one where no audio
   * arrives is the same lie the old empty `role="button"` was telling.
   */
  function audioForOccupant(person: VoiceParticipant, channel: Channel) {
    const isSelf = Boolean(currentUserId && person.userId === currentUserId);
    if (isSelf || activeVoiceChannelId !== channel.id || !onSetPeerVolume) {
      return undefined;
    }
    const share =
      onSetScreenVolume && screenAudioUserIds.includes(person.userId)
        ? {
            volume: screenVolumes[person.userId] ?? 1,
            onSetVolume: (volume: number) =>
              onSetScreenVolume(person.userId, volume),
          }
        : undefined;
    return {
      voice: {
        volume: peerVolumes[person.userId] ?? 1,
        onSetVolume: (volume: number) =>
          onSetPeerVolume(person.userId, volume),
      },
      share,
    };
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
      handRaised: person.handRaisedAt != null,
      canDisconnect: canMoveIn(channel.id),
      canKick: canKickUser(person.userId),
    });
    const profile: ContextMenuItemDef[] = [];
    const personal: ContextMenuItemDef[] = [];
    const mod: ContextMenuItemDef[] = [];
    const copy: ContextMenuItemDef[] = [];
    const member = memberById.get(person.userId);
    const publicHref = publicProfileHref(member?.handle);
    for (const action of actions) {
      if (action === "profile") {
        profile.push({
          id: "profile",
          label: t("voice.occupant.profile"),
          icon: UserRound,
          onSelect: () => {
            const anchor = document.querySelector(
              `[data-voice-occupant="${person.userId}"]`,
            );
            if (anchor instanceof HTMLElement) {
              openProfile(
                {
                  id: person.userId,
                  displayName: person.displayName,
                  tag: member?.tag ?? null,
                  avatarUrl: person.avatarUrl,
                  username: member?.username ?? null,
                  roleIds: member?.roleIds,
                  rank: member?.role,
                  isCharacter: member?.isCharacter,
                  handle: member?.handle ?? null,
                },
                anchor,
              );
            }
          },
        });
        if (publicHref && member?.handle) {
          profile.push({
            id: "public-profile",
            label: t("profile.publicUrl", { handle: member.handle }),
            icon: ExternalLink,
            onSelect: () => {
              window.open(publicHref, "_blank", "noopener,noreferrer");
            },
          });
        }
      } else if (action === "muteForMe") {
        personal.push({
          id: "mute-for-me",
          label: t("voice.occupant.muteForMe"),
          icon: VolumeX,
          onSelect: () => onSetPeerVolume?.(person.userId, 0),
        });
      } else if (action === "unmuteForMe") {
        personal.push({
          id: "unmute-for-me",
          label: t("voice.occupant.unmuteForMe"),
          icon: Volume2,
          onSelect: () => onSetPeerVolume?.(person.userId, 1),
        });
      } else if (action === "lowerHand") {
        personal.push({
          id: "lower-hand",
          label: t("voice.occupant.lowerHand"),
          icon: Hand,
          onSelect: () => onLowerOccupantHand?.(person.userId),
        });
      } else if (action === "serverMute") {
        personal.push({
          id: "server-mute",
          label: t("voice.occupant.serverMute"),
          icon: MicOff,
          onSelect: () => onServerMuteOccupant?.(person.userId, true),
        });
      } else if (action === "serverUnmute") {
        personal.push({
          id: "server-unmute",
          label: t("voice.occupant.serverUnmute"),
          icon: Mic,
          onSelect: () => onServerMuteOccupant?.(person.userId, false),
        });
      } else if (action === "disconnect") {
        mod.push({
          id: "disconnect",
          label: t("voice.occupant.disconnect"),
          icon: PhoneOff,
          danger: true,
          onSelect: () => onDisconnectVoiceOccupant?.(person.userId),
        });
      } else if (action === "kick") {
        mod.push({
          id: "kick",
          label: t("voice.occupant.kick"),
          icon: UserMinus,
          danger: true,
          onSelect: () => onKickOccupant?.(person.userId, person.displayName),
        });
      } else if (action === "copyName") {
        copy.push({
          id: "copy-name",
          label: t("voice.occupant.copyName"),
          icon: Copy,
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
   * Pin, or no-op with a hint when the per-server cap is full. Already-pinned
   * ids still move (reorder), even at the cap.
   */
  function commitPin(channel: Pick<Channel, "id" | "type">, insertBeforeId?: string) {
    const next = addFavorite(favoriteChannelIds, channel, insertBeforeId);
    const isNew = !favoriteIdSet.has(channel.id);
    if (isNew && next.length === favoriteChannelIds.length) {
      setDropHint(
        t("chrome.pinChannelFull", { count: FAVORITE_CHANNELS_PER_SERVER_MAX }),
      );
      window.setTimeout(() => setDropHint(null), 2500);
      return;
    }
    commitFavorites(next);
  }

  /**
   * Drop onto the Pinados header (append) or a pinned row (insert before).
   * Categories cannot be pinned.
   */
  function handleDropOnFavorites(insertBeforeId?: string) {
    const dragged = draggedChannel();
    clearDrag();
    if (!dragged || dragged.type === "category" || !onFavoriteChannelIdsChange) {
      return;
    }
    commitPin(dragged, insertBeforeId);
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
   * Dropping onto a pinned row reorders (or pins) the personal list.
   * Dropping a pin onto anything else unpins it; it reappears under its real
   * parent. Shared layout (`moveChannel`) only runs for an unpinned channel
   * dropped by a manager, same as before.
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
    const occupants = isVoiceRoomChannelType(channel.type)
      ? (voiceOccupancy[channel.id] ?? [])
      : [];
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
          sessionHint={upcomingSessionStartsAtByChannel[channel.id]}
          liveState={liveStateFor(channel)}
          isDragging={draggedId === channel.id}
          isDragOver={dragOverId === channel.id}
          occupantDragActive={Boolean(draggedOccupant)}
          occupantDropAllowed={occupantDropOk}
          isFavorite={isFavorite}
          onToggleFavorite={
            channel.type !== "category" && onFavoriteChannelIdsChange
              ? () =>
                  isFavorite
                    ? commitFavorites(
                        removeFavorite(favoriteChannelIds, channel.id),
                      )
                    : commitPin(channel)
              : undefined
          }
          onSelect={() => {
            onSelectChannel(channel.id);
            onMobileClose?.();
          }}
          onJoinVoice={
            isVoiceRoomChannelType(channel.type) && onJoinVoice
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
          onPurge={
            channel.type === "text" && canManageMessages && onPurgeChannel
              ? () => onPurgeChannel(channel)
              : undefined
          }
          categories={categoryOptions}
          onMoveToCategory={(categoryId) =>
            onMoveChannel(
              channel.id,
              categoryId,
              categoryId
                ? (childrenByCategory.get(categoryId)?.length ?? 0)
                : isVoiceRoomChannelType(channel.type)
                  ? topLevelVoice.length
                  : topLevelText.length,
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
              const canDrag =
                !pendingMoveUserIds.includes(person.userId) &&
                canDragVoiceOccupant(isSelf, channel.id, canMoveIn);
              return (
                <VoiceOccupantRow
                  key={person.peerId}
                  person={person}
                  channelId={channel.id}
                  isSpeaking={
                    speaking.has(person.peerId) &&
                    !person.muted &&
                    !person.deafened
                  }
                  canDrag={canDrag}
                  isDragging={draggedOccupant?.userId === person.userId}
                  items={menuForOccupant(person, channel)}
                  audio={audioForOccupant(person, channel)}
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
        ...(canManage || canManageMessages
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
      className={`fixed inset-y-0 left-[72px] z-30 flex w-[min(100%-72px,16rem)] flex-col border-r border-ink-4/60 bg-channel transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] md:relative md:left-auto md:z-auto md:w-[var(--channel-sidebar-width)] md:translate-x-0 ${
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
              {/* `truncate`: without it the rank sits outside its own column
                  and runs under the three buttons to its right, which is what
                  a narrowed sidebar shows first. */}
              {server?.role && (
                <p className="mt-0.5 truncate text-[11px] uppercase tracking-wider text-paper-muted">
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
                {/* Manage Messages too: that rank has Moderação and a
                    read-only AutoMod in the dialog, which decides the rail. */}
                {(canManage || canManageMessages) && (
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
            {channelPinHintEnabled && server && (
              <div className="mb-2">
                <FeatureHint
                  id="channelPin"
                  enabled
                  body={t("featureHint.channelPin.body")}
                />
              </div>
            )}
            {server &&
              (visibleFavs.length > 0 ||
                Boolean(
                  draggedId &&
                    !draggedOccupant &&
                    draggedChannel()?.type !== "category",
                )) && (
              <PinnedChannelsSection
                collapsed={collapsed.has(favoritesCollapseKey(server.id))}
                onToggle={() =>
                  toggleCollapsed(favoritesCollapseKey(server.id))
                }
                isDragOver={dragOverId === PINNED_ZONE && !draggedOccupant}
                onDragOver={() =>
                  !draggedOccupant && draggedId && setDragOverId(PINNED_ZONE)
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
              </PinnedChannelsSection>
            )}

            {/* THE ONLY PLACE A WATCH PARTY APPEARS IN THIS LIST.
                Above the categories, above the pins, above everything: a live
                party is an event and it goes at the top of the room. When
                none is running this is the button that starts one, for the
                people who may, and nothing at all for everybody else. There
                is no section, no row and no empty state. */}
            {watchPartyOn && onWatchLiveParty && (
              <LivePartyBlock
                parties={liveParties ?? []}
                selectedChannelId={selectedChannelId}
                audience={Object.fromEntries(
                  (liveParties ?? []).map((party) => [
                    party.channelId,
                    liveStateForChannel(
                      channelLive[party.channelId],
                      voiceOccupancy[party.channelId],
                    ).viewerCount,
                  ]),
                )}
                canStart={canStartWatchParty === true}
                onWatch={(channelId) => {
                  onWatchLiveParty(channelId);
                  onMobileClose?.();
                }}
                onCreate={
                  onCreateWatchParty
                    ? () => {
                        onCreateWatchParty();
                        onMobileClose?.();
                      }
                    : undefined
                }
              />
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

function PinnedChannelsSection({
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
    <div className="mb-4" data-pinned-channels="">
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
          <span className="truncate">{t("chrome.pinnedChannels")}</span>
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

/**
 * What the icons-only strip shows, in order, as thin dividers between groups.
 *
 * The category headers themselves go: a category is a label, and a label is
 * the one thing a 72px strip has no room for. Its channels keep their place in
 * the order and gain a hairline above them, so the shape of the server is
 * still legible without a word. Empty groups are dropped rather than drawn as
 * a stray divider.
 */
export function channelRailGroups(input: {
  favorites: Channel[];
  text: Channel[];
  voice: Channel[];
  /** Top-level watch party rooms; empty (or absent) while the flag is off. */
  watchParty?: Channel[];
  categories: Channel[];
  childrenByCategory: Map<string, Channel[]>;
}): { key: string; channels: Channel[] }[] {
  return [
    { key: "favorites", channels: input.favorites },
    { key: "text", channels: input.text },
    { key: "voice", channels: input.voice },
    { key: "watch_party", channels: input.watchParty ?? [] },
    ...input.categories.map((category) => ({
      key: category.id,
      channels: input.childrenByCategory.get(category.id) ?? [],
    })),
  ].filter((group) => group.channels.length > 0);
}

/**
 * One channel on the icons-only strip.
 *
 * Everything the wide row says with words this says with position: the glyph
 * is the channel, the tooltip on hover and the `aria-label` are its name, the
 * pip on the left edge is unread, the red number is a mention, the small
 * number under a speaker is how many people are in that call, and the signal
 * ring is the call you are in. A muted channel keeps its glyph and loses the
 * pip, exactly as the wide row does.
 *
 * A component of its own rather than a loop body because of the hook: the
 * notification level is per channel, and "muted" has to mean the same thing in
 * both layouts or the strip would shout about a channel you silenced.
 */
export function ChannelRailItem({
  channel,
  selected,
  connected,
  unread,
  occupants,
  liveState,
  onSelect,
  onJoinVoice,
}: {
  channel: Channel;
  selected: boolean;
  connected: boolean;
  unread: UnreadState;
  occupants: number;
  /** Set for a watch party room while the flag is on; see `ChannelRow`. */
  liveState?: ChannelLiveState;
  onSelect: () => void;
  onJoinVoice?: () => void;
}) {
  const { t } = useTranslation();
  const notifications = useChannelNotificationLevel(channel);
  const muted = notifications.level === "none";
  const hasUnread = !selected && unread.count > 0 && !muted;
  const mentions = selected || muted ? 0 : unread.mentions;
  const live = liveState?.live === true;
  const joinable = onJoinVoice && !connected;
  return (
    <Tooltip
      label={
        live
          ? `${channel.name} ${t("chrome.watchPartyLive")}`
          : joinable
            ? `${channel.name}: ${t("voice.doubleClickToJoin")}`
            : channel.name
      }
      // The strip has no room to write it, and the padlock glyph is the only
      // thing distinguishing a private channel there.
      detail={channel.isPrivate ? t("chrome.privateChannel") : undefined}
      side="right"
    >
      <button
        type="button"
        data-channel-id={channel.id}
        data-channel-type={channel.type}
        aria-current={selected ? "page" : undefined}
        className={cn(
          // `touch-manipulation` for the same reason the wide row has it: the
          // double tap is the only pointer gesture that joins.
          "relative flex h-10 w-10 shrink-0 touch-manipulation items-center justify-center rounded-lg transition-colors",
          selected
            ? "bg-ink-3 text-paper"
            : "text-paper-muted hover:bg-ink-3/70 hover:text-paper",
          connected &&
            "bg-signal/10 text-signal ring-1 ring-inset ring-signal/30",
          hasUnread && !selected && !connected && "text-paper",
          muted && !selected && !connected && "opacity-50",
        )}
        onClick={() => {
          // Always a select. Joining a call is never one press, on any
          // input: the double click below is the pointer path, and the
          // channel header's call button is the one a phone reaches for.
          const action = resolveVoiceRowClick({ selected, joinable: !!joinable });
          if (action === "join") {
            onJoinVoice?.();
          } else {
            onSelect();
          }
        }}
        onDoubleClick={() => {
          if (resolveVoiceRowDoubleClick({ joinable: !!joinable }) === "join") {
            onJoinVoice?.();
          }
        }}
        onKeyDown={(event) => {
          const action = resolveVoiceRowKey(event.key, {
            joinable: !!joinable,
          });
          if (action === null) {
            return;
          }
          event.preventDefault();
          if (action === "join") {
            onJoinVoice?.();
          } else {
            onSelect();
          }
        }}
      >
        <ChannelIcon channel={channel} className="h-4 w-4" />
        {live && (
          /* The strip has no room for words: a red dot in the corner is the
             pill. The viewer count below it is the ordinary occupancy badge. */
          <span
            data-watch-party-live=""
            aria-hidden="true"
            className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full bg-danger ring-2 ring-channel motion-safe:animate-pulse"
          />
        )}
        {hasUnread && (
          <>
            <span
              aria-hidden="true"
              className="absolute -left-2 top-1/2 h-4 w-1 -translate-y-1/2 rounded-r-full bg-paper"
            />
            <span className="sr-only">{t("chrome.unreadSr")}</span>
          </>
        )}
        {muted && <span className="sr-only">{t("chrome.mutedSr")}</span>}
        {mentions > 0 && (
          <span
            className="absolute -right-1 -top-1 min-w-4 rounded-full bg-danger px-1 py-0.5 text-center text-[10px] font-bold leading-none text-paper"
            aria-label={t("chrome.unreadMentions", { count: mentions })}
          >
            {formatBadgeCount(mentions)}
          </span>
        )}
        {occupants > 0 && (
          <span
            className="absolute -bottom-1 -right-1 min-w-4 rounded-full bg-ink-4 px-1 py-0.5 text-center text-[10px] font-bold leading-none text-paper"
            aria-label={t("chrome.inCall", { count: occupants })}
          >
            {formatBadgeCount(occupants)}
          </span>
        )}
      </button>
    </Tooltip>
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
  liveState,
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
  onPurge,
  categories,
  onMoveToCategory,
  onMoveUp,
  onMoveDown,
  onDragStart,
  onDragEnd,
  onDragOverRow,
  onDrop,
  sessionHint,
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
  /**
   * Present only for a watch party room while the flag is on. Turns the row
   * into the watch party shape: topic under the name, the AO VIVO pill and
   * viewer count while someone is on the stage, an Entrar button for the
   * rest. Absent (flag off, or any other type) the row is the plain one.
   */
  liveState?: ChannelLiveState;
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
  /** MANAGE_MESSAGES on a text channel. Absent everywhere else. */
  onPurge?: () => void;
  categories: Array<{ id: string; name: string }>;
  onMoveToCategory: (categoryId: string | null) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverRow: (event: DragEvent) => void;
  onDrop: () => void;
  /** Upcoming/live session start time for a voice channel's sidebar hint (VITE_WATCH_PARTY_SCHEDULE only). */
  sessionHint?: string;
}) {
  const { t } = useTranslation();
  const notifications = useChannelNotificationLevel(channel);
  const canOpenSettings = canManage || canManageRoles;
  const openSettings = () =>
    onOpenSettings(canManage ? "overview" : "permissions");
  const items: ContextMenuItemDef[] = [];

  if (onToggleFavorite) {
    items.push({
      id: "pin",
      label: isFavorite
        ? t("chrome.unpinChannel")
        : t("chrome.pinChannel"),
      icon: isFavorite ? PinOff : Pin,
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

  // Above the channel-management block on purpose: clearing messages is the
  // moderation action, deleting the channel is the management one, and a
  // moderator who holds only the first should not have to read past the second.
  if (onPurge) {
    if (items.length > 0) {
      items.push({ id: "sep-purge", label: "", separator: true });
    }
    items.push({
      id: "purge",
      label: t("chrome.purgeChannel"),
      icon: Eraser,
      danger: true,
      onSelect: onPurge,
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
  const watchParty = liveState !== undefined;
  /* The double-click shortcut is a tooltip, not inline text: the sidebar is
     narrow and a label rendered in the row ate the channel name on a real
     rail. It is the shared `Tooltip` rather than a native `title` so it
     opens in a quarter second instead of one, and on keyboard focus too. */
  const joinHint =
    !watchParty && onJoinVoice && !connected
      ? t("voice.doubleClickToJoin")
      : null;
  /* `Tooltip` names its trigger with `aria-label`, which would hide the
     `sr-only` hints inside the row. Say them here instead. */
  const rowName = [
    channel.name,
    joinHint,
    channel.isPrivate ? t("chrome.privateChannel") : null,
    mentions > 0
      ? t("chrome.unreadMentions", { count: mentions })
      : hasUnread && !muted
        ? t("chrome.unreadSr")
        : null,
    muted ? t("chrome.mutedSr") : null,
    sessionHint
      ? t("watchPartySchedule.sidebarHint", {
          when: formatSessionRelativeTime(sessionHint, new Date(), "pt-BR"),
        })
      : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(". ");
  const live = liveState?.live === true;
  const topic = watchParty ? channel.topic?.trim() || null : null;

  const rowButton = (
    <button
      type="button"
      onClick={() => {
        const action = resolveVoiceRowClick({
          selected,
          joinable: !!onJoinVoice && !connected,
        });
        if (action === "join") {
          onJoinVoice?.();
        } else {
          onSelect();
        }
      }}
      onDoubleClick={() => {
        if (
          resolveVoiceRowDoubleClick({
            joinable: !!onJoinVoice && !connected,
          }) === "join"
        ) {
          onJoinVoice?.();
        }
      }}
      onKeyDown={(event) => {
        const action = resolveVoiceRowKey(event.key, {
          joinable: !!onJoinVoice && !connected,
        });
        if (action === null) {
          return;
        }
        event.preventDefault();
        if (action === "join") {
          onJoinVoice?.();
        } else {
          onSelect();
        }
      }}
      aria-current={announceCurrent ? "page" : undefined}
      className="flex min-w-0 flex-1 touch-manipulation items-center gap-1.5 text-left"
    >
      {/* Private is the glyph, not a word. The pill that used to sit at
          the end of this row was about 50px of a 256px column, which is
          what pushed "broder-do-role" down to "broder…" while the pill
          itself had room to spare, and on a row whose icon was already
          the padlock it said the same thing twice. The padlock stays, the
          tooltip and the screen reader say it in words, and the name gets
          the pixels back. */}
      {channel.isPrivate ? (
        <Tooltip label={t("chrome.privateChannel")}>
          {/* `aria-hidden` because the words are already in the row, in
              the `sr-only` below. Without it the tooltip's own
              `aria-label` on this wrapper is a second announcement of the
              same fact, which is the bug the pill had. */}
          <span
            aria-hidden="true"
            className="flex shrink-0 items-center gap-1"
          >
            {icon}
            {/* Only when the channel carries its own picture or emoji, in
                which case `ChannelIcon` drew that instead of the padlock
                and nothing else in the row would say private. */}
            {!channelIconIsPrivateLock(channel) && (
              <Lock
                aria-hidden="true"
                className="h-3 w-3 shrink-0 text-warning"
              />
            )}
          </span>
        </Tooltip>
      ) : (
        icon
      )}
      {watchParty ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn(
              "truncate",
              hasUnread && !muted && "font-semibold",
            )}
          >
            {channel.name}
          </span>
          {live ? (
            <span
              data-watch-party-viewers=""
              className="truncate text-[10px] text-paper-muted"
            >
              {t("chrome.watchPartyViewers", {
                count: liveState.viewerCount,
              })}
            </span>
          ) : sessionHint ? (
            <ChannelSessionHint startsAt={sessionHint} now={new Date()} />
          ) : (
            topic && (
              <span className="truncate text-[10px] text-paper-muted">
                {topic}
              </span>
            )
          )}
        </span>
      ) : (
        <span className={cn("truncate", hasUnread && !muted && "font-semibold")}>
          {channel.name}
        </span>
      )}
      {!watchParty && sessionHint && (
        <ChannelSessionHint startsAt={sessionHint} now={new Date()} />
      )}
      {channel.isPrivate && (
        <span className="sr-only">{t("chrome.privateChannel")}</span>
      )}
      {hasUnread && !muted && <span className="sr-only">{t("chrome.unreadSr")}</span>}
      {muted && <span className="sr-only">{t("chrome.mutedSr")}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {/* The shortcut is announced through the row's `title` and its
            accessible name (see the label built above), never as inline
            text: the sidebar is narrow, and a `shrink-0` label here ate
            the channel name on a real 320px rail. */}
        {live && (
          /* The pulse is on the dot, never on the text, and only under
             `motion-safe`: with reduced motion the pill just sits there
             red, which still reads as live. */
          <span
            data-watch-party-live=""
            className="flex items-center gap-1 rounded-full bg-danger/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-danger"
          >
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-danger motion-safe:animate-pulse"
            />
            {t("chrome.watchPartyLive")}
          </span>
        )}
        {connected && (
          <>
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-signal"
            />
            <span className="sr-only">{t("chrome.connected")}</span>
          </>
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
  );

  return (
    <ContextMenu items={items}>
      <div
        draggable={channel.type === "category" ? canManage : true}
        onDragStart={(event) => {
          if (
            (event.target as HTMLElement).closest(
              "[data-channel-pin], [data-channel-join], [data-channel-settings]",
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
        {/* A voice row opens its view the way a text row opens its channel:
            a click selects it and shows the chat and the stage, without
            joining, and it does that however many times it lands. Only a
            double click joins. The "second tap on the selected row joins"
            fallback PR 360 shipped is gone: in practice it meant one click plus
            one more click entered a call by accident, which is the one thing
            this row must not do.
            `touch-manipulation` is what makes the double tap work on a phone:
            without it mobile Safari and Chrome hold the second tap back for
            double-tap-to-zoom and never synthesize `dblclick`. The header's
            call button is the other phone path, and it is the one iOS and
            Android use.
            Connected rows never call `onJoinVoice` at all (see `joinable`
            below), so clicking the room you are in just keeps the view. */}
        {/* Always the same element. Rendering a bare button when there is
            no hint would swap the element type the moment `connected`
            flips, and React would drop keyboard focus on the way. */}
        <Tooltip label={joinHint ?? channel.name} name={rowName} side="right">
          {rowButton}
        </Tooltip>
        {watchParty && onJoinVoice && !connected && (
          /* The same join the row itself does, spelled out: a watch party is
             joined by people who have never been in a voice channel here and
             would not guess that the name is the door. Nobody gets a "start"
             here; the presenter starts from the Watch party button in the
             call, which the welcome grant gates. */
          <button
            type="button"
            data-channel-join=""
            data-channel-watch={live ? "" : undefined}
            draggable={false}
            className={cn(
              "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold",
              live
                ? "bg-danger/15 text-danger hover:bg-danger/25"
                : "bg-ink-4/70 text-paper-muted hover:bg-ink-4 hover:text-paper",
            )}
            title={live ? t("watchParty.live.watchHint") : undefined}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (live) {
                onSelect();
                return;
              }
              onJoinVoice?.();
            }}
          >
            {live ? t("watchParty.live.watch") : t("chrome.watchPartyJoin")}
          </button>
        )}
        {onToggleFavorite && (
          <Tooltip
            label={
              isFavorite ? t("chrome.unpinChannel") : t("chrome.pinChannel")
            }
          >
            <button
              type="button"
              data-channel-pin=""
              draggable={false}
              className={cn(
                CHANNEL_ACTION_TILE,
                // The pin slides in from the right edge on hover and stays
                // put once the channel is pinned.
                "transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
                isFavorite
                  ? "text-paper"
                  : "translate-x-2 text-paper-muted opacity-0 group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:translate-x-0 group-focus-within:opacity-100",
              )}
              aria-label={
                isFavorite ? t("chrome.unpinChannel") : t("chrome.pinChannel")
              }
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggleFavorite();
              }}
            >
              <Pin
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

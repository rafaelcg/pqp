import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Archive,
  CheckCheck,
  ChevronDown,
  CirclePlus,
  Gamepad2,
  Copy,
  Eraser,
  ExternalLink,
  FolderInput,
  FolderMinus,
  FolderPlus,
  Hand,
  Hash,
  History,
  Lock,
  LogOut,
  MessageSquareText,
  MessagesSquare,
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
  PanelLeftClose,
} from "lucide-react";
import {
  CaretDown,
  ChatText,
  FolderSimplePlus,
  GearSix,
  PencilSimple,
  PushPin,
  Lock as LockFill,
  MagnifyingGlass,
  Plus as PlusBold,
  SidebarSimple,
  Users as UsersFill,
  X as XBold,
} from "@phosphor-icons/react";
import { formatBadgeCount } from "@/lib/badge-count";
import {
  forwardRef,
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  FAVORITE_CHANNELS_PER_SERVER_MAX,
  buildSidebarLayout,
  locateInLayout,
  moveInLayout,
  stepInLayout,
  type LayoutTarget,
  type SidebarCategory,
  type SidebarLayout,
  isVoiceRoomChannelType,
  isWatchPartyChannelType,
  liveStateFromRoster,
  liveStateFromStream,
  type WatchParty,
  type Channel,
  type ChannelLiveState,
  type ChannelType,
  type Server,
  type ThreadSummary,
  type VoiceParticipant,
} from "@pqp/shared";
import type { ChannelLive } from "@/hooks/use-voice";
import type { ChannelMusicTrack } from "@pqp/shared";
import { raisedHandPositions } from "@/components/voice/hand-position-badge";
import { ChannelMusicCard } from "@/components/voice/channel-music-card";
import { LivePartyBlock } from "@/components/watch-party/live-party-block";
import { SearchDialog } from "@/components/search/search-dialog";
import { useConversationsHome } from "@/lib/conversations-config";
import {
  CommunityHomePreview,
  type CommunityHomePreviewProps,
} from "@/components/community-home/community-home-preview";
import {
  ChannelIcon,
  channelIconIsPrivateLock,
} from "@/components/layout/channel-icon";
import { SidebarResizeHandle } from "@/components/layout/sidebar-resize-handle";
import { useChannelSidebarWidth } from "@/hooks/use-channel-sidebar-width";
import { useVoiceConfig } from "@/hooks/use-voice-config";
import {
  isVoiceRowJoinable,
  resolveVoiceRowClick,
  resolveVoiceRowDoubleClick,
  resolveVoiceRowKey,
} from "@/lib/voice-row-interaction";
import {
  ServerBannerStrip,
  ServerIcon,
} from "@/components/layout/server-identity";
import {
  ContextMenu,
  type ContextMenuItemDef,
} from "@/components/ui/context-menu";
import { PublicBadge } from "@/components/communities/public-badge";
import { isServerPublic } from "@/lib/community-access";
import { Menu } from "@/components/ui/menu";
import { BetaTag } from "@/components/ui/beta-tag";
import { ChannelListSkeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { CountBadge } from "@/components/ui/count-badge";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { MENU_SEPARATOR } from "@/components/ui/menu-items";
import { useIsTruncated } from "@/lib/use-is-truncated";
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
import { useHasDraft } from "@/lib/composer-drafts";
import {
  foldSection,
  loadCollapsedCategories,
  sectionCollapseKey,
  toggleCollapsedCategory,
} from "@/lib/collapsed-categories";
import {
  CATEGORY_ACTION_REDESIGN,
  CATEGORY_LABEL_REDESIGN,
  ChannelSectionHeader,
  SECTION_FOCUS_RING,
  SectionActionGlyph,
} from "@/components/layout/channel-section-header";
import {
  notificationLevelItems,
  useChannelNotificationLevel,
  useNotificationState,
} from "@/hooks/use-notifications";
import { resolveNotificationLevel } from "@/lib/notifications";
import { FeatureHint, useFeatureHintEnabled } from "@/components/layout/feature-hint";
import { ChannelSessionHint } from "@/components/layout/channel-session-hint";
import { formatSessionRelativeTime } from "@/lib/channel-session-schedule";
import { heroHue, heroTintStyle, initialsFor } from "@/lib/hero-tint";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { isWatchPartyChannelsEnabled } from "@/lib/watch-party-channels";
import {
  CreateCategoryRow,
  DragStatus,
  DropLine,
  EmptyCategoryDrop,
  MixedCategoryHeader,
  PinDropBar,
  OrganizeChannels,
  stepAvailability,
  type DropEdge,
} from "@/components/layout/channel-list-mixed";
import { PANE_SIDE_REDESIGN } from "@/components/ui/pane";

const EMPTY_THREAD_IDS: ReadonlySet<string> = new Set();

export interface UnreadState {
  count: number;
  mentions: number;
}

const EMPTY_UNREAD: UnreadState = { count: 0, mentions: 0 };

/** Where a drag in the mixed list would land, as the pointer says now. */
type MixedDrop =
  | { kind: "row"; id: string; edge: DropEdge }
  | { kind: "into"; categoryId: string }
  | { kind: "category"; id: string; edge: DropEdge }
  /** The top edge of a header: the end of the group above it (loose, for the first). */
  | { kind: "beforeCategory"; categoryId: string }
  | { kind: "afterLastCategory" };

/** The top this much of a category header means "above this category". */
const HEADER_BEFORE_FRACTION = 0.3;

/** A folded category held under the pointer this long opens. */
const FOLDED_CATEGORY_OPEN_MS = 600;

/** What a reorder came back as (`App.handleApplyLayout`). */
export type ApplyLayoutResult = "ok" | "stale" | "failed";

function layoutKey(layout: SidebarLayout): string {
  return JSON.stringify([
    layout.loose.map((channel) => channel.id),
    layout.categories.map((entry) => [
      entry.category.id,
      entry.children.map((channel) => channel.id),
    ]),
  ]);
}

function edgeOf(event: DragEvent, host: Element): DropEdge {
  const rect = host.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

/** Drop-target ids that are not channels: the Pinados / TEXT / VOICE headers. */
const PINNED_ZONE = "__pinned__";
const TEXT_ZONE = "__text__";
const VOICE_ZONE = "__voice__";

/** Apple keyboards label the same chord differently, and the hint is the point. */
const IS_APPLE_KEYBOARD =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.userAgent);

/**
 * Message search's chord. Conversas (`conversations_home`) gives Ctrl/Cmd+K
 * to the "ir pra" switcher and moves search to F; off, it is K as it was.
 */
function searchShortcutKey(conversationsHome: boolean): "f" | "k" {
  return conversationsHome ? "f" : "k";
}

function searchShortcutHint(conversationsHome: boolean): string {
  const key = searchShortcutKey(conversationsHome).toUpperCase();
  return IS_APPLE_KEYBOARD ? `⌘${key}` : `Ctrl ${key}`;
}

/** The switcher's "Buscar nas mensagens" row asks for message search with its words. */
export const SEARCH_MESSAGES_EVENT = "pqp:search-messages";

/** Equal-width action tiles on a channel row (pin, settings). */
const CHANNEL_ACTION_TILE =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-ink-3";

/*
 * A channel row under the redesign: `ui/list-row.tsx`'s `sm` row on its
 * tokens (a 36px pill, the row roles), with the end pip as the one unread
 * mark instead of the bar on the left edge. The row keeps its own markup
 * (the tooltip on the button, the pin and settings beside it, the drag).
 */
const CHANNEL_ROW_REDESIGN =
  "redesign:min-h-[var(--list-row-h-sm)] redesign:gap-0.5 redesign:rounded-[var(--list-row-radius)] redesign:py-0.5 redesign:pl-[var(--list-row-px)] redesign:pr-[var(--list-row-action-pr,0.25rem)]";

/**
 * A channel row's icon: 14px with the toggle off; under the redesign 16px in
 * the list row's icon colour (the selected text on the open row). A private
 * channel's padlock keeps its warning colour.
 */
export function channelRowIconClass(channel: Channel, selected: boolean): string {
  return cn(
    "h-3.5 w-3.5 redesign:h-4 redesign:w-4",
    !channelIconIsPrivateLock(channel) &&
      (selected
        ? "redesign:text-[color:var(--list-row-selected-text)]"
        : "redesign:text-[color:var(--list-row-icon)]"),
  );
}

/** A watch party room's second line (its viewers, its topic). */
const CHANNEL_DETAIL_REDESIGN =
  "redesign:text-xs redesign:text-[color:var(--list-row-detail)]";

/** The pin and settings tiles: round, a tint of the text on hover so it shows on a selected row too. */
const CHANNEL_ACTION_REDESIGN =
  "redesign:rounded-full redesign:text-[color:var(--list-row-icon)] redesign:hover:bg-[color:var(--card-row-hover)] redesign:hover:text-text redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-accent";

export { formatBadgeCount };

export { VoiceOccupantBadges } from "./voice-occupant-badges";

/** A channel or category, positioned within the one sibling group it belongs
 * to — see the comment on `moveChannel` (server/src/services/servers.ts) for
 * what "sibling group" means: top-level text, top-level voice, and each
 * category's own children are each scoped separately. */
function sortByPosition(list: Channel[]): Channel[] {
  return [...list].sort((a, b) => a.position - b.position);
}

/**
 * Whether the server header menu offers the settings entry. Each cargo that
 * has a pane in server settings to land on must be here, or its holder has no
 * way in (a Manage Soundboard cargo has the Soundboard tab and nothing else).
 */
export function showsServerSettingsEntry(access: {
  canManage: boolean;
  canManageMessages: boolean;
  canManageSoundboard: boolean;
  /** Manage Emoji has the Emoji pane and nothing else, like the soundboard. */
  canManageEmoji?: boolean;
  /** MANAGE_SERVER: the Overview pane (the Baú switches live there). */
  canManageServer?: boolean;
}): boolean {
  return (
    access.canManage ||
    access.canManageServer === true ||
    access.canManageMessages ||
    access.canManageSoundboard ||
    access.canManageEmoji === true
  );
}

interface ChannelListProps {
  server: Server | null;
  /**
   * --- threads --- channelId -> the active threads under it, newest first,
   * already capped by the server. A thread was only ever reachable by
   * scrolling its parent channel to the message it grew out of, so nothing in
   * the sidebar said a server had threads at all.
   */
  threadsByChannel?: Record<string, ThreadSummary[]>;
  /** Thread channel ids with activity this reader has not opened. */
  unreadThreadIds?: ReadonlySet<string>;
  /** Selects the parent channel and opens the panel, like the chip does. */
  onOpenThread?: (thread: ThreadSummary) => void;
  /** Takes the thread out of this reader's sidebar until they reply in it. */
  onLeaveThread?: (thread: ThreadSummary) => void;
  onMarkThreadRead?: (thread: ThreadSummary) => void;
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
  /**
   * MANAGE_SOUNDBOARD with the soundboard on for this server. Opens the
   * server's settings from the header menu for a cargo that holds nothing else
   * settings can show, since the Soundboard tab is theirs.
   */
  canManageSoundboard?: boolean;
  /** MANAGE_EMOJI: reaches the settings dialog for its Emoji pane alone. */
  canManageEmoji?: boolean;
  /** MANAGE_SERVER: reaches the settings dialog for its Overview (the Baú switches). */
  canManageServer?: boolean;
  isLoading?: boolean;
  voiceOccupancy?: Record<string, VoiceParticipant[]>;
  /**
   * channelId -> the server's `channel-live` for it: the HLS stream (or
   * null) and how many people watch it without a seat. Preferred over the
   * roster for the live row, because the roster only reaches this client
   * for rooms it is in or has been told about, and never counts watchers.
   */
  channelLive?: Record<string, ChannelLive>;
  /** channelId -> what the room is playing (`channel-music`), for the row under the occupants. */
  channelMusic?: Record<string, ChannelMusicTrack | null>;
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
  /**
   * The `watch_party` channel whose live block should read "reconnecting"
   * instead of "AO VIVO": the one where THIS viewer is the presenter and their
   * own screen publish has dropped. Null for everyone else. See
   * `LivePartyBlock.recoveringChannelId`.
   */
  recoveringChannelId?: string | null;
  /** See `LivePartyBlock.pending`. */
  pendingParty?: WatchParty | null;
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
  /**
   * The waitlist teaser, only for a server where watch parties are off
   * (`shouldOfferWatchPartyTeaser` in `App.tsx`). See `LivePartyBlock.teaser`.
   */
  watchPartyTeaser?: { onList: boolean; onOpen: () => void } | null;
  /**
   * `watch_party` channels on this server that this person may see the
   * history of AND that have a broadcast to show (`watchPartyHistoryCandidates`
   * + `useWatchPartyHistoryAvailability` in `App.tsx`) -- START_WATCH_PARTY
   * or MANAGE_CHANNELS, same rule the server enforces.
   *
   * An idle `watch_party` channel is filtered out of `listed` below and
   * never gets a row, so this is threaded to two places that do NOT depend
   * on the channel being selected: the server header's own context menu,
   * and a secondary link beside `LivePartyBlock`'s create/pending card. Both
   * are absent whenever this is empty -- nothing to show, nothing to click.
   */
  watchPartyHistoryChannels?: readonly { id: string; name: string }[];
  /** Opens `WatchPartyHistoryDialog` on the given channel. */
  onOpenWatchPartyHistory?: (channelId: string) => void;
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
  /**
   * Audience mode is on in the call we are in and we run its stage: the
   * people a host let in (null otherwise). Offers "Liberar o microfone" /
   * "Silenciar" on that call's rows (`docs/plans/AUDIENCE_MODE.md`).
   */
  audienceSpeakerUserIds?: string[] | null;
  onAudienceSpeaker?: (userId: string, allowed: boolean) => void;
  onKickOccupant?: (userId: string, name: string) => void;
  onSetPeerVolume?: (userId: string, volume: number) => void;
  onSetScreenVolume?: (userId: string, volume: number) => void;
  /**
   * `watch_party` is only ever asked for while `isWatchPartyChannelsEnabled()`
   * is true; with the flag off the sidebar has no button that sends it.
   */
  onCreateChannel: (
    type: ChannelType,
    isPrivate: boolean,
    /** The category to create it in (the mixed list's per-category "+"). */
    parentId?: string | null,
  ) => void;
  /**
   * Draw the mixed list: categories are the only headers and every type
   * mixes in one order (`mixed_channel_list` on for the server and its data
   * migrated, `GET /api/servers/:id/channel-layout`). Null or absent draws the
   * old TEXTO / VOZ / CATEGORIAS list, untouched. `version` is what a reorder
   * is sent against; null while it has not been read yet, which holds every
   * reorder back.
   */
  mixedLayout?: { version: number | null } | null;
  /**
   * Commit a reorder of the mixed list (one full-order PUT). Applied
   * optimistically by the caller, which reverts on a failure and adopts the
   * server's list on a stale one.
   */
  onApplyLayout?: (
    layout: SidebarLayout<Channel>,
    baseVersion: number,
  ) => Promise<ApplyLayoutResult>;
  /**
   * The runtime flag `forum_channels` is on for this server (`useForumConfig`).
   * Turns the Texto section's "+" into a menu offering a text channel or a
   * Fórum. Off, the "+" is the plain one-click text channel it always was.
   */
  forumCreateEnabled?: boolean;
  onRenameChannel: (channel: Channel) => void;
  onOpenChannelSettings: (
    channel: Channel,
    section: "overview" | "tags" | "permissions" | "webhooks",
    options?: { forceAdvanced?: boolean },
  ) => void;
  onDeleteChannel: (channelId: string) => void;
  /**
   * Open the "clear recent messages" dialog for a text or watch_party
   * channel. `Pick` rather than the full `Channel` because the live party
   * card only ever has the party's id and name on hand, not a channel row.
   */
  onPurgeChannel?: (channel: Pick<Channel, "id" | "name">) => void;
  onMoveChannel: (
    channelId: string,
    parentId: string | null,
    index: number,
    /** A drop on this row: the server takes its slot exactly. */
    targetId?: string,
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
  /**
   * Fold this list to a strip of icons. Lives in THIS header, beside the
   * other controls about this server, rather than in the channel header: a
   * control that hides the column belongs on the column.
   */
  channelSidebarToggle?: { iconsOnly: boolean; onToggle: () => void };
  footer?: ReactNode;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  /**
   * Baú (Community Home), on when `GET /api/community-home/config` says so.
   * Pins a Baú row above TEXT on every server. Not a real channel type and
   * not `COMMUNITIES_ENABLED`.
   */
  communityHomeEnabled?: boolean;
  /**
   * The instance has the public communities feature on (the answer the rail
   * and the settings already follow). A server with a public address wears the
   * "Public" mark in its header only while this is true: with it off the
   * address answers 404 and the mark would be a lie.
   */
  communitiesEnabled?: boolean;
  /** "NEW" chip until the row is opened once on this server. */
  communityHomeShowNew?: boolean;
  /** Unread published posts. Outranks the "New" chip: a number says more. */
  communityHomeUnread?: number;
  /**
   * The newest unread post is under 24 h old: the row wears a pulsing "New"
   * chip beside the lime count. Unknown age is false, never true.
   */
  communityHomeUnreadFresh?: boolean;
  communityHomeSelected?: boolean;
  onSelectCommunityHome?: () => void;
  /**
   * The Baú preview (`GET …/home/latest`): a card while something is new, a
   * slim row with the last post once seen. Null or absent (the server has the
   * preview off, or the read has not landed) keeps the plain row.
   */
  communityHomePreview?: CommunityHomePreviewProps | null;
  /**
   * The stories strip (`components/stories/story-strip.tsx`), drawn at the
   * top of the list, above Baú. It draws nothing unless the server has
   * stories on and something is live. Never in the icons-only rail.
   */
  storiesSlot?: ReactNode;
  /** "Postar story" in the server menu, for someone who may post here. */
  onPostStory?: () => void;
  /**
   * "Locadora" in the server menu (the emulator, see docs/EMULATOR_ROOM.md), passed only while the
   * `emulator_room` flag is on for this server. Absent: no entry.
   */
  onOpenEmulator?: () => void;
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

export const ChannelList = memo(function ChannelList({
  server,
  threadsByChannel = {},
  unreadThreadIds = EMPTY_THREAD_IDS,
  onOpenThread,
  onLeaveThread,
  onMarkThreadRead,
  channels,
  selectedChannelId,
  canManage,
  canManageRoles = false,
  canManageMessages = false,
  canManageSoundboard = false,
  canManageEmoji = false,
  canManageServer = false,
  isLoading = false,
  voiceOccupancy = {},
  channelLive = {},
  channelMusic = {},
  speakingPeerIds = [],
  activeVoiceChannelId,
  unread,
  onSelectChannel,
  onJoinVoice,
  liveParties,
  recoveringChannelId = null,
  pendingParty,
  onWatchLiveParty,
  canStartWatchParty,
  onCreateWatchParty,
  watchPartyTeaser = null,
  watchPartyHistoryChannels = [],
  onOpenWatchPartyHistory,
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
  audienceSpeakerUserIds = null,
  onAudienceSpeaker,
  onKickOccupant,
  onSetPeerVolume,
  onSetScreenVolume,
  onCreateChannel,
  forumCreateEnabled = false,
  onRenameChannel,
  onOpenChannelSettings,
  onDeleteChannel,
  onPurgeChannel,
  onMoveChannel,
  mixedLayout = null,
  onApplyLayout,
  favoriteChannelIds = [],
  onFavoriteChannelIdsChange,
  onInvite,
  onOpenMembers,
  channelSidebarToggle,
  onOpenServerSettings,
  footer,
  mobileOpen = false,
  onMobileClose,
  communityHomeEnabled = false,
  communitiesEnabled = false,
  communityHomeShowNew = false,
  communityHomeUnread = 0,
  communityHomeUnreadFresh = false,
  communityHomePreview = null,
  communityHomeSelected = false,
  onSelectCommunityHome,
  storiesSlot = null,
  onPostStory,
  onOpenEmulator,
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
  // A forum is listed with the text channels: it is a place to write, the
  // server groups its positions with `text`, and a separate Fórum section
  // would be a header over one row in nearly every server.
  const topLevelText = sortByPosition(
    listed.filter(
      (c) => isTextGroupChannelType(c.type) && !c.parentId && !favoriteIdSet.has(c.id),
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

  // What the mixed list draws and every reorder is computed on: what this
  // person sees in its place (pins live in Pinados, a watch party room is the
  // block at the top). A channel left out of the write keeps its place on
  // the server, so the view is the whole truth the write needs.
  const viewLayout = buildSidebarLayout(
    listed.filter((c) => !favoriteIdSet.has(c.id)),
    { mixed: true },
  );
  // One pass for every row's Mover para cima / para baixo, not a candidate
  // layout per row per render.
  const viewSteps = stepAvailability(viewLayout);

  const speaking = new Set(speakingPeerIds);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchSeed, setSearchSeed] = useState("");
  const conversationsHome = useConversationsHome();
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    loadCollapsedCategories(),
  );
  // Read here, above the icons-only early return, for the folded headers'
  // dot: a muted row shows no unread, so its section must not either.
  const notificationState = useNotificationState();
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [draggedOccupant, setDraggedOccupant] =
    useState<VoiceOccupantDrag | null>(null);
  const [dropHint, setDropHint] = useState<string | null>(null);
  // --- the mixed list ---
  const mixed = mixedLayout != null;
  const [mixedDrop, setMixedDropState] = useState<MixedDrop | null>(null);
  const mixedDropRef = useRef<MixedDrop | null>(null);
  /** The row picked up, drawn as a dashed gap (set a tick after dragstart). */
  const [liftedId, setLiftedId] = useState<string | null>(null);
  const liftRef = useRef<string | null>(null);
  const [organizing, setOrganizing] = useState<{
    layout: SidebarLayout<Channel>;
    baseVersion: number;
  } | null>(null);
  const [organizeBusy, setOrganizeBusy] = useState(false);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  const focusAfterRef = useRef<string | null>(null);
  const openTimerRef = useRef<{ id: string; timer: number } | null>(null);
  useEffect(() => {
    const id = focusAfterRef.current;
    if (!id) {
      return;
    }
    focusAfterRef.current = null;
    // After the menu that asked for the move has closed and handed focus
    // back: the moved row keeps it, wherever it went.
    window.setTimeout(() => {
      const target = document.querySelector<HTMLElement>(
        `[data-channel-id="${id}"] button, [data-category-id="${id}"] button`,
      );
      target?.focus();
    }, 0);
  }, [channels]);
  useEffect(
    () => () => {
      if (statusTimerRef.current !== null) {
        window.clearTimeout(statusTimerRef.current);
      }
      if (openTimerRef.current) {
        window.clearTimeout(openTimerRef.current.timer);
      }
    },
    [],
  );
  // Only a pinned channel being dragged needs the empty headers back (they
  // are the drop that unpins it). It is dragged out of Pinados, which sits
  // above them, so the row in the hand never moves when they appear.
  const draggingPinned = draggedId != null && favoriteIdSet.has(draggedId);
  const hideEmptyTopLevel =
    !canManage && categories.length > 0 && !draggingPinned;
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
  // The soundboard switch in a person's audio menu exists only where a board
  // does: this server's runtime flag, the same answer the call bar reads.
  const soundboardOn = useVoiceConfig(server?.id).soundboard === true;
  useEffect(() => {
    if (!hasServer) {
      return;
    }
    const key = searchShortcutKey(conversationsHome);
    function onKeyDown(event: KeyboardEvent) {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === key
      ) {
        event.preventDefault();
        setSearchSeed("");
        setSearchOpen(true);
      }
    }
    function onSearchRequest(event: Event) {
      const query = (event as CustomEvent<{ query?: string }>).detail?.query ?? "";
      setSearchSeed(query);
      setSearchOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(SEARCH_MESSAGES_EVENT, onSearchRequest);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(SEARCH_MESSAGES_EVENT, onSearchRequest);
    };
  }, [hasServer, conversationsHome]);

  // --- icons only ---------------------------------------------------------
  // Below every hook, so the strip and the column are the same component with
  // the same state: expanding puts you back on the category you had collapsed
  // and the search you had open, because neither was ever unmounted.
  //
  // The drawer is never drawn as a strip (`mobileOpen`): under `md` the list
  // is already fully hidden, so collapsing it saves nothing and costs the
  // names. `App.tsx` will not ask for it there either; this is the belt.
  if (iconsOnly && !mobileOpen && onExpand) {
    const railGroups = mixed
      ? channelRailGroups({
          favorites: visibleFavs,
          text: viewLayout.loose,
          voice: [],
          categories: viewLayout.categories.map((entry) => entry.category),
          childrenByCategory: new Map(
            viewLayout.categories.map((entry) => [entry.category.id, entry.children]),
          ),
        })
      : channelRailGroups({
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
        className={cn("hidden w-[72px] shrink-0 flex-col border-r border-ink-4/60 bg-channel md:flex", PANE_SIDE_REDESIGN)}
      >
        <div className="flex flex-col items-center gap-1 border-b border-ink-4/60 px-2 py-2">
          <Tooltip label={t("chrome.expandChannelList")} side="right">
            {/* The same control as the header's fold button, in its other
                state: one identity per boundary, pressed while folded. */}
            <button
              type="button"
              data-channel-rail-expand=""
              data-channel-sidebar-toggle=""
              aria-pressed="true"
              aria-label={t("chrome.expandChannelList")}
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
            onClose={() => {
              setSearchOpen(false);
              // The switcher's words were for that one search, not the next.
              setSearchSeed("");
            }}
            onNavigate={onMobileClose}
            initialQuery={searchSeed}
          />
        )}
        <div className="flex flex-1 flex-col items-center gap-1 overflow-y-auto px-2 py-2">
          {(communityHomeEnabled || server?.isCommunity) &&
            server &&
            onSelectCommunityHome && (
            <CommunityHomeNavButton
              server={server}
              selected={communityHomeSelected}
              unread={communityHomeUnread}
              fresh={communityHomeUnreadFresh}
              showNew={communityHomeShowNew}
              compact
              onSelect={onSelectCommunityHome}
            />
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
                    isVoiceRoomChannelType(channel.type) &&
                    !isWatchPartyChannelType(channel.type) &&
                    onJoinVoice
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

  function foldFor(channels: Channel[], key: string) {
    const isCollapsed = collapsed.has(key);
    return {
      collapsed: isCollapsed,
      onToggle: () => toggleCollapsed(key),
      childCount: channels.length,
      ...foldSection(channels, {
        collapsed: isCollapsed,
        selectedChannelId,
        activeVoiceChannelId,
        // The row's own rule: a forum can carry mentions with no count, and
        // a muted channel shows nothing at all.
        isUnread: (channel) => {
          const row = unread[channel.id];
          return (
            row !== undefined &&
            (row.count > 0 || row.mentions > 0) &&
            resolveNotificationLevel(
              notificationState,
              channel.serverId,
              channel.id,
            ) !== "none"
          );
        },
      }),
    };
  }

  const textFold = foldFor(
    topLevelText,
    sectionCollapseKey(server?.id ?? "", "text"),
  );
  const voiceFold = foldFor(
    topLevelVoice,
    sectionCollapseKey(server?.id ?? "", "voice"),
  );
  const pinnedFold = foldFor(
    visibleFavs,
    favoritesCollapseKey(server?.id ?? ""),
  );

  function clearDrag() {
    setDraggedId(null);
    setDragOverId(null);
    setDraggedOccupant(null);
    setMixedDrop(null);
    liftRef.current = null;
    setLiftedId(null);
    cancelFoldedOpen();
  }

  // --- mixed list: drag, drop, keyboard, organize -------------------------

  function setMixedDrop(next: MixedDrop | null) {
    // Mirrored in a ref: a drop in the same frame as the last dragover reads
    // the target the pointer is on, not the one the last render saw.
    mixedDropRef.current = next;
    setMixedDropState((current) =>
      JSON.stringify(current) === JSON.stringify(next) ? current : next,
    );
  }

  function cancelFoldedOpen() {
    if (openTimerRef.current) {
      window.clearTimeout(openTimerRef.current.timer);
      openTimerRef.current = null;
    }
  }

  /** Hovering a folded category while dragging opens it after a beat. */
  function scheduleFoldedOpen(categoryId: string) {
    if (openTimerRef.current?.id === categoryId) {
      return;
    }
    cancelFoldedOpen();
    const timer = window.setTimeout(() => {
      openTimerRef.current = null;
      if (loadCollapsedCategories().has(categoryId)) {
        setCollapsed(toggleCollapsedCategory(categoryId));
      }
    }, FOLDED_CATEGORY_OPEN_MS);
    openTimerRef.current = { id: categoryId, timer };
  }

  function showStatus(text: string) {
    setStatusLine(text);
    if (statusTimerRef.current !== null) {
      window.clearTimeout(statusTimerRef.current);
    }
    statusTimerRef.current = window.setTimeout(() => {
      statusTimerRef.current = null;
      setStatusLine(null);
    }, 4000);
  }

  function describeMove(layout: SidebarLayout<Channel>, id: string): string | null {
    const place = locateInLayout(layout, id);
    const row = channels.find((c) => c.id === id);
    if (!place || !row) {
      return null;
    }
    const n = place.index + 1;
    if (place.isCategory) {
      return t("chrome.movedCategory", { category: row.name, n, total: place.total });
    }
    if (place.parentId === null) {
      return t("chrome.movedToLoose", { channel: row.name, n, total: place.total });
    }
    const category = layout.categories.find((entry) => entry.category.id === place.parentId);
    return t("chrome.movedTo", {
      channel: row.name,
      category: category?.category.name ?? "",
      n,
      total: place.total,
    });
  }

  async function commitLayout(
    next: SidebarLayout<Channel>,
    movedId: string | null,
    baseVersion: number | null = mixedLayout?.version ?? null,
  ): Promise<ApplyLayoutResult> {
    if (!onApplyLayout || baseVersion === null) {
      showStatus(t("chrome.reorderFailed"));
      return "failed";
    }
    if (movedId) {
      focusAfterRef.current = movedId;
    }
    const result = await onApplyLayout(next, baseVersion);
    if (result === "ok") {
      const said = movedId ? describeMove(next, movedId) : null;
      if (said) {
        showStatus(said);
      }
    } else {
      showStatus(t(result === "stale" ? "chrome.reorderStale" : "chrome.reorderFailed"));
    }
    return result;
  }

  function applyMove(id: string, target: LayoutTarget) {
    const next = moveInLayout(viewLayout, id, target);
    if (!next || layoutKey(next) === layoutKey(viewLayout)) {
      return;
    }
    void commitLayout(next, id);
  }

  function stepMove(id: string, direction: -1 | 1) {
    const stepped = stepInLayout(viewLayout, id, direction);
    if (stepped) {
      void commitLayout(stepped.layout, id);
    }
  }

  /** The slot a drop on a row (above or below its middle) lands in. */
  function rowDropTarget(draggedRowId: string, rowId: string, edge: DropEdge): LayoutTarget | null {
    const at = locateInLayout(viewLayout, rowId);
    if (!at) {
      return null;
    }
    let index = at.index + (edge === "after" ? 1 : 0);
    const from = locateInLayout(viewLayout, draggedRowId);
    // The index is read with the dragged row already taken out.
    if (from && from.isCategory === at.isCategory && from.parentId === at.parentId && from.index < index) {
      index -= 1;
    }
    return { parentId: at.isCategory ? null : at.parentId, index };
  }

  function finishMixedDrop() {
    const dragged = draggedChannel();
    const drop = mixedDropRef.current;
    clearDrag();
    if (!dragged || !drop || !canManage || favoriteIdSet.has(dragged.id)) {
      return;
    }
    const end = Number.MAX_SAFE_INTEGER;
    const isCategory = dragged.type === "category";
    switch (drop.kind) {
      case "row": {
        const target = isCategory ? null : rowDropTarget(dragged.id, drop.id, drop.edge);
        if (target) {
          applyMove(dragged.id, target);
        }
        return;
      }
      case "into":
        if (!isCategory) {
          applyMove(dragged.id, { parentId: drop.categoryId, index: end });
        }
        return;
      case "beforeCategory": {
        if (isCategory) {
          return;
        }
        const at = viewLayout.categories.findIndex(
          (entry) => entry.category.id === drop.categoryId,
        );
        const above = at > 0 ? viewLayout.categories[at - 1]!.category.id : null;
        applyMove(dragged.id, { parentId: above, index: end });
        return;
      }
      case "category": {
        const target = isCategory ? rowDropTarget(dragged.id, drop.id, drop.edge) : null;
        if (target) {
          applyMove(dragged.id, target);
        }
        return;
      }
      case "afterLastCategory":
        if (isCategory) {
          applyMove(dragged.id, { parentId: null, index: end });
        }
        return;
    }
  }

  /** A dragged channel a manager may place (not a pin, not a category, not a person). */
  function draggingPlaceableChannel(): Channel | null {
    if (!mixed || !canManage || draggedOccupant || !draggedId) {
      return null;
    }
    const dragged = draggedChannel();
    if (!dragged || dragged.type === "category" || favoriteIdSet.has(dragged.id)) {
      return null;
    }
    return dragged;
  }

  /** Nothing pinned yet and a channel in the air: offer the bar to pin it. */
  function pinBarOpen(): boolean {
    if (!draggedId || draggedOccupant || visibleFavs.length > 0 || !onFavoriteChannelIdsChange) {
      return false;
    }
    const dragged = draggedChannel();
    return Boolean(dragged && dragged.type !== "category");
  }

  function draggingCategory(): Channel | null {
    if (!mixed || !canManage || draggedOccupant || !draggedId) {
      return null;
    }
    const dragged = draggedChannel();
    return dragged?.type === "category" ? dragged : null;
  }

  function startOrganizing() {
    if (mixedLayout?.version == null) {
      showStatus(t("chrome.reorderFailed"));
      return;
    }
    setOrganizing({ layout: viewLayout, baseVersion: mixedLayout.version });
  }

  async function finishOrganizing() {
    if (!organizing) {
      return;
    }
    if (layoutKey(organizing.layout) === layoutKey(viewLayout)) {
      setOrganizing(null);
      return;
    }
    setOrganizeBusy(true);
    let result: ApplyLayoutResult = "failed";
    try {
      result = await commitLayout(organizing.layout, null, organizing.baseVersion);
    } catch {
      showStatus(t("chrome.reorderFailed"));
    } finally {
      setOrganizeBusy(false);
      // A stale list was swapped for the fresh one: start over from it
      // rather than keep arranging something that no longer exists.
      setOrganizing(null);
    }
    if (result === "ok") {
      showStatus(t("chrome.organizeSaved"));
    }
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
      const placeable = draggingPlaceableChannel();
      if (placeable && !favoriteIdSet.has(channel.id)) {
        // Above or below the middle of the row (its occupants and threads
        // count as the row): a line says where it lands.
        if (placeable.id === channel.id) {
          setMixedDrop(null);
        } else {
          const host =
            (event.currentTarget as HTMLElement).closest("[data-channel-id]") ??
            (event.currentTarget as HTMLElement);
          setMixedDrop({ kind: "row", id: channel.id, edge: edgeOf(event, host) });
        }
        setDragOverId(null);
        return;
      }
      if (draggingCategory()) {
        // A category only lands between categories.
        event.dataTransfer.dropEffect = "none";
        setMixedDrop(null);
        return;
      }
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
      soundboard: soundboardOn,
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
      audience:
        inSameCall && audienceSpeakerUserIds
          ? audienceSpeakerUserIds.includes(person.userId)
            ? "silence"
            : person.canSpeak === false
              ? "allow"
              : null
          : null,
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
      } else if (action === "audienceAllow") {
        personal.push({
          id: "audience-allow",
          label: t("voice.audience.allow"),
          icon: Mic,
          onSelect: () => onAudienceSpeaker?.(person.userId, true),
        });
      } else if (action === "audienceSilence") {
        personal.push({
          id: "audience-silence",
          label: t("voice.audience.silence"),
          icon: MicOff,
          onSelect: () => onAudienceSpeaker?.(person.userId, false),
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
    if (mixed) {
      finishMixedDrop();
      return;
    }
    clearDrag();
    if (target.type === "category" && dragged.type !== "category") {
      const kids = childrenByCategory.get(target.id) ?? [];
      onMoveChannel(dragged.id, target.id, kids.length);
      return;
    }
    onMoveChannel(dragged.id, target.parentId, legacyDropIndex(target), target.id);
  }

  /**
   * The index `PATCH /move` reads for a drop on a row. Inside a category it
   * is the row's position. In the loose area the server keeps one sequence
   * for every type now and reads the index per type (its legacy-move rule),
   * so this is the row's slot among the loose channels of its own type group,
   * which is what `position` used to be when each type was numbered apart.
   */
  function legacyDropIndex(target: Channel): number {
    if (target.parentId) {
      return target.position;
    }
    const sameGroup = (type: string) =>
      isTextGroupChannelType(target.type)
        ? isTextGroupChannelType(type as Channel["type"])
        : type === target.type;
    const group = sortByPosition(
      channels.filter((c) => !c.parentId && c.type !== "category" && sameGroup(c.type)),
    );
    const index = group.findIndex((c) => c.id === target.id);
    return index === -1 ? target.position : index;
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
    const handPositions = raisedHandPositions(occupants);
    const isFavorite = inFavorites || favoriteIdSet.has(channel.id);
    const occupantDropOk = occupantDropAllowed(channel);
    const mixedRow = mixed && !inFavorites;
    const rowDrop =
      mixedRow && mixedDrop?.kind === "row" && mixedDrop.id === channel.id
        ? mixedDrop.edge
        : null;
    // The dragged row's slot stays as a dashed gap, so nothing jumps.
    const isOrigin =
      mixedRow && liftedId === channel.id && draggedId === channel.id && Boolean(draggingPlaceableChannel());
    const canStepUp = mixedRow && canManage && (viewSteps.get(channel.id)?.up ?? false);
    const canStepDown = mixedRow && canManage && (viewSteps.get(channel.id)?.down ?? false);
    return (
      <div
        key={channel.id}
        className={cn(
          "relative mb-0.5 min-w-0",
          isOrigin &&
            "rounded-[var(--radius-control)] outline-dashed outline-1 outline-border [&>*]:invisible",
        )}
        data-channel-id={channel.id}
        data-drop={rowDrop ?? undefined}
        data-channel-type={channel.type}
        onDragOver={(event) => handleRowDragOver(event, channel)}
        onDrop={(event) => {
          // A channel let go over this room's occupants or threads: they
          // count as the row (the line said so), so the drop is the row's.
          const channelOnRow =
            mixedRow && mixedDropRef.current?.kind === "row" && mixedDropRef.current.id === channel.id;
          if (!draggedOccupant && !channelOnRow) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          handleRowDrop(channel);
        }}
      >
        {rowDrop && <DropLine edge={rowDrop} />}
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
          icon={
            <ChannelIcon
              channel={channel}
              className={channelRowIconClass(
                channel,
                selectedChannelId === channel.id,
              )}
            />
          }
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
            isVoiceRoomChannelType(channel.type) &&
            !isWatchPartyChannelType(channel.type) &&
            onJoinVoice
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
            (channel.type === "text" ||
              isWatchPartyChannelType(channel.type)) &&
            canManageMessages &&
            onPurgeChannel
              ? () => onPurgeChannel(channel)
              : undefined
          }
          categories={categoryOptions}
          onMoveToCategory={(categoryId) =>
            mixedRow
              ? applyMove(channel.id, {
                  parentId: categoryId,
                  index: Number.MAX_SAFE_INTEGER,
                })
              : onMoveChannel(
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
            mixedRow
              ? canStepUp
                ? () => stepMove(channel.id, -1)
                : undefined
              : inFavorites
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
            mixedRow
              ? canStepDown
                ? () => stepMove(channel.id, 1)
                : undefined
              : inFavorites
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
            // A tick later, never inside dragstart: the drag zones that open
            // (Pinados, the loose drop) move rows, and the origin turns into
            // a gap, and Chromium cancels a drag whose source moves or hides
            // before it has taken the image. Guarded, because a cancelled
            // drag can end before the tick.
            liftRef.current = channel.id;
            window.setTimeout(() => {
              if (liftRef.current === channel.id) {
                setDraggedId(channel.id);
                if (mixedRow) {
                  setLiftedId(channel.id);
                }
              }
            }, 0);
          }}
          onDragEnd={() => {
            // Esc, or a drop outside any target: nothing moves.
            setDraggedId(null);
            setDragOverId(null);
            setMixedDrop(null);
            liftRef.current = null;
            setLiftedId(null);
            cancelFoldedOpen();
          }}
          onDragOverRow={(event) => handleRowDragOver(event, channel)}
          onDrop={() => handleRowDrop(channel)}
        />
        {/* --- threads --- nested under the channel they hang off, the same
            shape the voice occupants below use. */}
        {(threadsByChannel[channel.id]?.length ?? 0) > 0 && onOpenThread && (
          <ul className="ml-2 space-y-0.5 border-l border-border/70 py-0.5 pl-2 redesign:ml-5 redesign:border-[color:var(--card-border)] redesign:pl-1.5">
            {threadsByChannel[channel.id]!.map((thread) => (
              <SidebarThreadRow
                key={thread.channelId}
                thread={thread}
                unread={unreadThreadIds.has(thread.channelId)}
                onOpen={() => {
                  onOpenThread(thread);
                  onMobileClose?.();
                }}
                onLeave={onLeaveThread ? () => onLeaveThread(thread) : undefined}
                onMarkRead={
                  onMarkThreadRead ? () => onMarkThreadRead(thread) : undefined
                }
              />
            ))}
          </ul>
        )}
        {channelMusic[channel.id] && (
          <ChannelMusicCard
            channelId={channel.id}
            track={channelMusic[channel.id]!}
            inCall={activeVoiceChannelId === channel.id}
            onJoin={onJoinVoice ? () => onJoinVoice(channel.id) : undefined}
          />
        )}
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
                  handPosition={handPositions.get(person.userId) ?? null}
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

  function categoryAddItems(categoryId: string): ContextMenuItemDef[] {
    if (!canManage) {
      return [];
    }
    return [
      {
        id: "create-text",
        label: t("chrome.addTextChannel"),
        icon: Hash,
        onSelect: () => onCreateChannel("text", false, categoryId),
      },
      {
        id: "create-voice",
        label: t("chrome.addVoiceChannel"),
        icon: Volume2,
        onSelect: () => onCreateChannel("voice", false, categoryId),
      },
      ...(forumCreateEnabled
        ? [
            {
              id: "create-forum",
              label: t("chrome.addForum"),
              icon: MessagesSquare,
              trailing: <BetaTag />,
              onSelect: () => onCreateChannel("forum", false, categoryId),
            },
          ]
        : []),
      { id: "sep-private", label: "", separator: true },
      {
        id: "create-private",
        label: t("chrome.privateChannel"),
        icon: Lock,
        onSelect: () => onCreateChannel("text", true, categoryId),
      },
    ];
  }

  function renderMixedCategory(entry: SidebarCategory<Channel>) {
    const category = entry.category;
    const kids = entry.children;
    const isCollapsed = collapsed.has(category.id);
    // Folding never hides where you are: the open channel and the call you
    // are in stay under a folded header.
    const shown = isCollapsed
      ? kids.filter((c) => c.id === selectedChannelId || c.id === activeVoiceChannelId)
      : kids;
    const hasUnread = kids.some(
      (c) => c.id !== selectedChannelId && (unread[c.id]?.count ?? 0) > 0,
    );
    const up = canManage && (viewSteps.get(category.id)?.up ?? false);
    const down = canManage && (viewSteps.get(category.id)?.down ?? false);
    const menuItems: ContextMenuItemDef[] = canManage
      ? [
          ...(up
            ? [{ id: "move-up", label: t("chrome.moveUp"), icon: ArrowUp, onSelect: () => stepMove(category.id, -1) }]
            : []),
          ...(down
            ? [{ id: "move-down", label: t("chrome.moveDown"), icon: ArrowDown, onSelect: () => stepMove(category.id, 1) }]
            : []),
          ...(up || down ? [{ id: "sep-move", label: "", separator: true }] : []),
          {
            id: "rename",
            label: t("chrome.renameCategory"),
            icon: Pencil,
            onSelect: () => onRenameChannel(category),
          },
          { id: "sep", label: "", separator: true },
          {
            id: "delete",
            label: t("chrome.deleteCategory"),
            icon: Trash2,
            danger: true,
            onSelect: () => onDeleteChannel(category.id),
          },
        ]
      : [];
    const headerDrop =
      mixedDrop?.kind === "into" && mixedDrop.categoryId === category.id
        ? ("into" as const)
        : mixedDrop?.kind === "category" && mixedDrop.id === category.id
          ? mixedDrop.edge
          : mixedDrop?.kind === "beforeCategory" && mixedDrop.categoryId === category.id
            ? ("before" as const)
            : null;
    return (
      <div key={category.id} data-category-group={category.id}>
        <MixedCategoryHeader
          category={category}
          collapsed={isCollapsed}
          onToggle={() => toggleCollapsed(category.id)}
          childCount={kids.length}
          hasUnread={hasUnread}
          addItems={categoryAddItems(category.id)}
          menuItems={menuItems}
          drag={{
            draggable: canManage,
            dragging: draggedId === category.id,
            drop: headerDrop,
            onDragStart: (event) => {
              if (!canManage || draggedOccupant) {
                event.preventDefault();
                return;
              }
              event.dataTransfer.setData("application/x-pqp-channel", category.id);
              event.dataTransfer.effectAllowed = "move";
              // A tick later, like a row (see there).
              liftRef.current = category.id;
              window.setTimeout(() => {
                if (liftRef.current === category.id) {
                  setDraggedId(category.id);
                }
              }, 0);
            },
            onDragEnd: () => {
              liftRef.current = null;
              setDraggedId(null);
              setDragOverId(null);
              setMixedDrop(null);
              cancelFoldedOpen();
            },
            onDragOver: (event) => {
              if (draggedOccupant) {
                event.dataTransfer.dropEffect = "none";
                return;
              }
              const dragged = draggedChannel();
              if (!dragged) {
                return;
              }
              event.preventDefault();
              if (favoriteIdSet.has(dragged.id)) {
                // A pin dropped on a header goes back where it lives.
                setDragOverId(category.id);
                return;
              }
              if (draggingCategory()) {
                setMixedDrop(
                  dragged.id === category.id
                    ? null
                    : { kind: "category", id: category.id, edge: edgeOf(event, event.currentTarget) },
                );
                return;
              }
              if (draggingPlaceableChannel()) {
                const rect = event.currentTarget.getBoundingClientRect();
                if (event.clientY < rect.top + rect.height * HEADER_BEFORE_FRACTION) {
                  setMixedDrop({ kind: "beforeCategory", categoryId: category.id });
                  return;
                }
                setMixedDrop({ kind: "into", categoryId: category.id });
                if (isCollapsed) {
                  scheduleFoldedOpen(category.id);
                }
              }
            },
            onDragLeave: (event) => {
              const next = event.relatedTarget as Node | null;
              if (!next || !event.currentTarget.contains(next)) {
                if (openTimerRef.current?.id === category.id) {
                  cancelFoldedOpen();
                }
              }
            },
            onDrop: (event) => {
              event.preventDefault();
              event.stopPropagation();
              if (draggedOccupant) {
                showDropHint("category");
                clearDrag();
                return;
              }
              handleDrop(category);
            },
          }}
        />
        {!isCollapsed && kids.length === 0 ? (
          canManage ? (
            <EmptyCategoryDrop
              active={mixedDrop?.kind === "into" && mixedDrop.categoryId === category.id}
              onDragOver={(event) => {
                if (!draggingPlaceableChannel()) {
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setMixedDrop({ kind: "into", categoryId: category.id });
              }}
              onDragLeave={() => undefined}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (draggedOccupant) {
                  showDropHint("category");
                  clearDrag();
                  return;
                }
                handleDrop(category);
              }}
            />
          ) : null
        ) : (
          shown.map((channel) => renderRow(channel, kids))
        )}
      </div>
    );
  }

  /**
   * THE MIXED LIST: channels in no category on top with no header, then every
   * category (an empty one only for managers, who can fill it), then
   * "Criar categoria". Pinados, the watch party block and Baú stay above it,
   * drawn by the caller exactly as before.
   */
  function renderMixedList() {
    const lastCategoryId = viewLayout.categories.at(-1)?.category.id ?? null;
    return (
      <div data-channel-list-mixed="">
        {viewLayout.loose.length > 0 && (
          <div data-loose-channels="" className="mb-1">
            {viewLayout.loose.map((channel) => renderRow(channel, viewLayout.loose))}
          </div>
        )}
        {viewLayout.categories
          .filter((entry) => canManage || entry.children.length > 0)
          .map((entry) => renderMixedCategory(entry))}
        {canManage && (
          <CreateCategoryRow
            onCreate={() => onCreateChannel("category", false)}
            dropAfterLast={mixedDrop?.kind === "afterLastCategory"}
            onDragOver={(event) => {
              if (!draggingCategory() || !lastCategoryId) {
                return;
              }
              event.preventDefault();
              setMixedDrop({ kind: "afterLastCategory" });
            }}
            onDragLeave={() => undefined}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              finishMixedDrop();
            }}
          />
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
        ...(onPostStory
          ? [
              {
                id: "post-story",
                label: t("stories.strip.post"),
                icon: CirclePlus,
                onSelect: onPostStory,
              },
            ]
          : []),
        ...(onOpenEmulator
          ? [
              {
                id: "emulator-room",
                label: t("emulator.menu"),
                icon: Gamepad2,
                onSelect: onOpenEmulator,
              },
            ]
          : []),
        ...(mixed && canManage && onApplyLayout
          ? [
              {
                id: "organize-channels",
                label: t("chrome.organizeChannels"),
                icon: ArrowUpDown,
                onSelect: startOrganizing,
              },
            ]
          : []),
        ...(showsServerSettingsEntry({
          canManage,
          canManageMessages,
          canManageSoundboard,
          canManageEmoji,
          canManageServer,
        })
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
        /**
         * "Transmissões anteriores", reachable from the server itself rather
         * than from a channel row -- the whole reason it lives here. See
         * `watchPartyHistoryChannels` above: never shown for a server with
         * no watch_party channel this viewer may manage, or with no past
         * broadcast to find.
         */
        ...(onOpenWatchPartyHistory && watchPartyHistoryChannels.length > 0
          ? [
              { id: "sep-history", label: "", separator: true },
              ...watchPartyHistoryChannels.map((channel) => ({
                id: `watch-party-history-${channel.id}`,
                label:
                  watchPartyHistoryChannels.length > 1
                    ? t("chrome.watchPartyHistoryNamed", {
                        name: channel.name,
                      })
                    : t("chrome.watchPartyHistory"),
                icon: History,
                onSelect: () => onOpenWatchPartyHistory(channel.id),
              })),
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
      className={`fixed inset-y-0 left-[72px] z-30 flex w-[min(100%-72px,16rem)] flex-col border-r border-ink-4/60 bg-channel ${PANE_SIDE_REDESIGN} transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] md:relative md:left-auto md:z-auto md:w-[var(--channel-sidebar-width)] md:translate-x-0 ${
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
      {/* Outside the ContextMenu on purpose: a right-click on the picture
          does nothing. Absent entirely without a banner — see
          `ServerBannerStrip`. */}
      {server && <ServerBannerStrip bannerUrl={server.bannerUrl} />}

      <ContextMenu items={headerItems}>
        <div
          data-server-header=""
          // `py-1.5`, not the `py-2` a first pass had: `border-b` (1px) is
          // part of the border-box `min-h-12` constrains, and content (the
          // 32px icon) plus `py-2` plus that border comes to 49px — over the
          // floor, so the floor stops applying and 49 wins. `py-1.5` keeps
          // content-plus-padding-plus-border under 48px so `min-h-12` is
          // what actually decides the row's height, exactly, at every width
          // and with every name. Caught by a live Playwright render
          // (`e2e/server-header.spec.ts`), not by `channel-list-header.test.tsx`
          // — jsdom has no layout engine, so a static-markup test cannot see
          // a box model computation like this one.
          className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 redesign:min-h-14 redesign:border-b-0 redesign:px-3 redesign:pt-2 redesign:pb-1"
        >
          {server ? (
            <Menu
              items={headerItems}
              align="start"
              side="bottom"
              topContent={
                server.isCommunity ? (
                  <>
                    <div
                      data-server-menu-public=""
                      className="px-2.5 py-1.5 text-sm text-text-tertiary"
                    >
                      {t("chrome.publicCommunity")}
                    </div>
                    <div className={MENU_SEPARATOR} />
                  </>
                ) : undefined
              }
            >
              <ServerHeaderMenuTrigger
                server={server}
                isPublic={isServerPublic(server, communitiesEnabled)}
              />
            </Menu>
          ) : (
            <p className="min-w-0 flex-1 truncate text-sm text-text-tertiary">
              {isLoading ? t("common.loading") : t("chrome.noServer")}
            </p>
          )}
          {/* `shrink-0`: these are all fixed-width controls, so letting flex
              compress them only squeezes their tap targets while the name is
              already truncating anyway. */}
          <div
            data-server-header-actions=""
            className="flex shrink-0 items-center gap-0.5"
          >
            {server && (
              <>
                {/* `touch={false}` and the old sizes: with the toggle off these
                    draw the 32px (28px from `md`) buttons they always were. */}
                <IconButton
                  label={t("chrome.members")}
                  touch={false}
                  // On a phone the chat header has its own members button, so
                  // under the redesign the drawer gives the name that room.
                  className={cn(HEADER_ICON_BUTTON, "max-sm:redesign:hidden")}
                  onClick={onOpenMembers}
                >
                  <Users className="h-4 w-4 redesign:hidden" aria-hidden="true" />
                  <Icon icon={UsersFill} size="sm" className="hidden redesign:block" />
                </IconButton>
                {channelSidebarToggle && (
                  <IconButton
                    label={
                      channelSidebarToggle.iconsOnly
                        ? t("chrome.expandChannelList")
                        : t("chrome.collapseChannelList")
                    }
                    detail={t("chrome.collapseChannelListHint")}
                    data-channel-sidebar-toggle=""
                    pressed={channelSidebarToggle.iconsOnly}
                    touch={false}
                    className={cn(HEADER_ICON_BUTTON, "hidden md:grid")}
                    onClick={channelSidebarToggle.onToggle}
                  >
                    <PanelLeftClose className="h-4 w-4 redesign:hidden" aria-hidden="true" />
                    <Icon icon={SidebarSimple} size="sm" className="hidden redesign:block" />
                  </IconButton>
                )}
              </>
            )}
            {onMobileClose && (
              <IconButton
                label={t("chrome.closeChannelList")}
                touch={false}
                className={cn(HEADER_ICON_BUTTON, "md:hidden")}
                onClick={onMobileClose}
              >
                <X className="h-4 w-4 redesign:hidden" aria-hidden="true" />
                <Icon icon={XBold} kind="symbol" size="sm" className="hidden redesign:block" />
              </IconButton>
            )}
          </div>
        </div>
      </ContextMenu>

      {server && (
        <div className="px-3 pt-3 redesign:pt-1">
          <button
            type="button"
            className={cn(
              "flex w-full items-center gap-2 rounded-md border border-border bg-surface-0/60 px-2.5 py-2 text-xs text-text-muted transition-colors hover:border-border-strong hover:text-text",
              // Under the redesign a pill a step off the pane, like the
              // mockup's "Buscar": the field's look without a field's edge.
              "redesign:h-[var(--sidebar-search-h)] redesign:rounded-full redesign:border-[color:var(--sidebar-search-border)] redesign:bg-[color:var(--sidebar-search-bg)] redesign:px-3.5 redesign:py-0 redesign:text-sm redesign:text-text-tertiary redesign:hover:border-[color:var(--sidebar-search-border)] redesign:hover:bg-[color:var(--sidebar-search-hover)] redesign:hover:text-text-secondary redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-accent",
            )}
            onClick={() => setSearchOpen(true)}
          >
            <Search className="h-3.5 w-3.5 shrink-0 redesign:hidden" />
            <Icon icon={MagnifyingGlass} kind="symbol" size="sm" className="hidden redesign:block" />
            <span className="truncate">{t("chrome.searchMessages")}</span>
            <kbd className="ml-auto hidden shrink-0 rounded border border-border px-1 py-px text-[10px] font-sans md:inline redesign:rounded-md redesign:border-0 redesign:bg-surface-3 redesign:px-1.5 redesign:py-0.5 redesign:text-[11px] redesign:text-text-secondary">
              {searchShortcutHint(conversationsHome)}
            </kbd>
          </button>
          <SearchDialog
            open={searchOpen}
            serverId={server.id}
            serverName={server.name}
            onClose={() => {
              setSearchOpen(false);
              // The switcher's words were for that one search, not the next.
              setSearchSeed("");
            }}
            onNavigate={onMobileClose}
            initialQuery={searchSeed}
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 pb-3 pt-2">
        {isLoading ? (
          <ChannelListSkeleton />
        ) : mixed && organizing ? (
          <OrganizeChannels
            layout={organizing.layout}
            onChange={(next) =>
              setOrganizing((current) => (current ? { ...current, layout: next } : current))
            }
            onCancel={() => setOrganizing(null)}
            onDone={() => void finishOrganizing()}
            busy={organizeBusy}
            iconFor={(channel) => <ChannelIcon channel={channel} />}
          />
        ) : (
          <>
            {server && storiesSlot}
            {server &&
              (visibleFavs.length > 0 ||
                (!mixed &&
                  Boolean(
                    draggedId &&
                      !draggedOccupant &&
                      draggedChannel()?.type !== "category",
                  ))) && (
              <PinnedChannelsSection
                {...pinnedFold}
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
                {pinnedFold.shown.map((channel) =>
                  renderRow(channel, visibleFavs, true),
                )}
              </PinnedChannelsSection>
            )}

            {/* THE ONLY PLACE A WATCH PARTY APPEARS IN THIS LIST.
                Above the categories, above the pins, above everything: a live
                party is an event and it goes at the top of the room. When
                none is running this is the button that starts one, for the
                people who may, and nothing at all for everybody else. There
                is no section, no row and no empty state -- except a small
                "Transmissões anteriores" link beside the create/pending card,
                which IS the empty state's one job: the idle channel this
                block replaces is the only place a moderator could otherwise
                never reach the show that already happened. See
                `historyChannels` on `LivePartyBlock`. */}
            {watchPartyOn && onWatchLiveParty && (
              <LivePartyBlock
                parties={liveParties ?? []}
                pending={pendingParty ?? null}
                selectedChannelId={selectedChannelId}
                recoveringChannelId={recoveringChannelId}
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
                canPurge={canManageMessages}
                onPurge={
                  onPurgeChannel
                    ? (channelId, name) => onPurgeChannel({ id: channelId, name })
                    : undefined
                }
                historyChannels={watchPartyHistoryChannels}
                onOpenHistory={onOpenWatchPartyHistory}
                teaser={
                  watchPartyTeaser
                    ? {
                        onList: watchPartyTeaser.onList,
                        onOpen: () => {
                          watchPartyTeaser.onOpen();
                          onMobileClose?.();
                        },
                      }
                    : null
                }
              />
            )}

            {(communityHomeEnabled || server?.isCommunity) &&
            server &&
            onSelectCommunityHome && (
              <div className="mb-3 px-1">
                {communityHomePreview ? (
                  <CommunityHomePreview
                    latest={communityHomePreview.latest}
                    canPost={communityHomePreview.canPost}
                    serverName={server.name}
                    serverHueSeed={server.communitySlug ?? server.name}
                    selected={communityHomeSelected}
                    face={<CommunityHomeFace server={server} />}
                    onOpen={() => {
                      onSelectCommunityHome();
                      onMobileClose?.();
                    }}
                    onOpenPost={(postId) => {
                      communityHomePreview.onOpenPost(postId);
                      onMobileClose?.();
                    }}
                    onCompose={() => {
                      communityHomePreview.onCompose();
                      onMobileClose?.();
                    }}
                  />
                ) : (
                  <CommunityHomeNavButton
                    server={server}
                    selected={communityHomeSelected}
                    unread={communityHomeUnread}
                    fresh={communityHomeUnreadFresh}
                    showNew={communityHomeShowNew}
                    onSelect={() => {
                      onSelectCommunityHome();
                      onMobileClose?.();
                    }}
                  />
                )}
              </div>
            )}

            {mixed ? (
              renderMixedList()
            ) : (
            <>
            {/* An empty "Texto" or "Voz" header is noise for a member when
                every channel sits in a category, which is what a Discord
                import produces. Managers keep both: their + buttons are the
                only way to create a channel. Dragging a pinned channel shows
                them again, because the header is also the drop zone that
                unpins it. */}
            {(topLevelText.length > 0 || !hideEmptyTopLevel) && (
            <ChannelSection
              label={t("chrome.text")}
              fold={textFold}
              canManage={canManage}
              onAdd={() => onCreateChannel("text", false)}
              onAddPrivate={() => onCreateChannel("text", true)}
              addMenu={
                forumCreateEnabled
                  ? textSectionAddMenu({
                      textLabel: t("chrome.createTextChannel"),
                      forumLabel: t("chrome.createForum"),
                      onText: () => onCreateChannel("text", false),
                      onForum: () => onCreateChannel("forum", false),
                    })
                  : undefined
              }
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
              {textFold.shown.map((channel) => renderRow(channel, topLevelText))}
            </ChannelSection>
            )}

            {(topLevelVoice.length > 0 || !hideEmptyTopLevel) && (
            <ChannelSection
              label={t("chrome.voice")}
              fold={voiceFold}
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
              {voiceFold.shown.map((channel) =>
                renderRow(channel, topLevelVoice),
              )}
            </ChannelSection>
            )}

            {(categories.length > 0 || canManage) && (
              <div className="mb-4">
                <div className="mb-1 flex min-h-6 items-center justify-between px-2 redesign:min-h-8">
                  {/* Indented past the chevron the folding headers carry, so
                      every section label starts on one line. */}
                  <span
                    className={cn(
                      "pl-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary",
                      CATEGORY_LABEL_REDESIGN,
                      "redesign:pl-[1.125rem] redesign:text-text-secondary",
                    )}
                  >
                    {t("chrome.categories")}
                  </span>
                  {canManage && (
                    /* Also gains an accessible name it never had: the old
                       `title` is not one, so this button was unnamed to a
                       screen reader. */
                    <Tooltip label={t("chrome.newCategory")}>
                      <button
                        type="button"
                        className={cn(
                          "rounded-sm p-0.5 text-text-tertiary hover:bg-surface-2 hover:text-text",
                          SECTION_FOCUS_RING,
                          CATEGORY_ACTION_REDESIGN,
                        )}
                        onClick={() => onCreateChannel("category", false)}
                      >
                        <SectionActionGlyph off={FolderPlus} on={FolderSimplePlus} kind="symbol" onClassName="h-4 w-4" />
                      </button>
                    </Tooltip>
                  )}
                </div>
                {categories.map((category) => {
                  const kids = childrenByCategory.get(category.id) ?? [];
                  const categoryFold = foldFor(kids, category.id);
                  const bodyId = `category-body-${category.id}`;
                  return (
                    <div key={category.id} className="mb-1">
                      <CategoryHeader
                        category={category}
                        collapsed={categoryFold.collapsed}
                        onToggle={categoryFold.onToggle}
                        childCount={categoryFold.childCount}
                        hasUnread={categoryFold.hasUnread}
                        controlsId={bodyId}
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
                      <div id={bodyId} className="ml-2 border-l border-border/70 pl-2">
                          {categoryFold.collapsed ? (
                            categoryFold.shown.map((channel) => renderRow(channel, kids))
                          ) : kids.length === 0 ? (
                            // The empty-category placeholder is itself a drop
                            // target. Without these handlers a channel dragged
                            // onto the "drag a channel here" hint fell through
                            // to nothing: only the CategoryHeader accepted the
                            // drop, so the one spot the copy points at was inert.
                            <p
                              data-testid="empty-category-drop"
                              className={cn(
                                "rounded px-2 py-1 text-xs italic text-paper-muted",
                                dragOverId === category.id &&
                                  !draggedOccupant &&
                                  "bg-ink-3/60 text-paper",
                              )}
                              onDragOver={(event) => {
                                if (draggedOccupant || !draggedId) {
                                  return;
                                }
                                event.preventDefault();
                                event.dataTransfer.dropEffect = "move";
                                setDragOverId(category.id);
                              }}
                              onDragLeave={() => {
                                if (dragOverId === category.id) {
                                  setDragOverId(null);
                                }
                              }}
                              onDrop={() => {
                                if (draggedOccupant) {
                                  showDropHint("category");
                                  clearDrag();
                                  return;
                                }
                                handleDrop(category);
                              }}
                            >
                              {t("chrome.emptyCategory")}
                            </p>
                          ) : (
                            kids.map((channel) => renderRow(channel, kids))
                          )}
                        </div>
                    </div>
                  );
                })}
              </div>
            )}
            </>
            )}
            {/* UNDER THE LAST CHANNEL, AND OUT OF THE FLOW.
                At the top of the list it pushed every channel down, which
                is what a coachmark must never do, and it covered the
                Pinados block the moment somebody did what it asks, which
                reads as the feature not working. Here it points at the
                list it names: `h-0` takes no room, and the wrapper passes
                pointer events through so the right-click the copy asks
                for still reaches the channel under it. */}
            {channelPinHintEnabled && server && (
              <div className="pointer-events-none relative z-30 h-0 [&>*]:pointer-events-auto">
                <div className="absolute inset-x-0 top-2">
                  <FeatureHint
                    id="channelPin"
                    enabled
                    body={t("featureHint.channelPin.body")}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {mixed && pinBarOpen() && (
        <PinDropBar
          active={dragOverId === PINNED_ZONE}
          onDragOver={(event) => {
            event.preventDefault();
            setMixedDrop(null);
            setDragOverId(PINNED_ZONE);
          }}
          onDragLeave={() => {
            if (dragOverId === PINNED_ZONE) {
              setDragOverId(null);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            handleDropOnFavorites();
          }}
        />
      )}
      {mixed && (draggingPlaceableChannel() || draggingCategory()) ? (
        <DragStatus />
      ) : statusLine && !dropHint ? (
        <p
          role="status"
          data-channel-list-status=""
          className="border-t border-border px-3 py-2 text-xs text-text-secondary"
        >
          {statusLine}
        </p>
      ) : (
        dropHint && (
          <p
            role="status"
            className="border-t border-ink-4/60 px-3 py-2 text-xs text-paper"
          >
            {dropHint}
          </p>
        )
      )}

      {footer}
    </aside>
  );
});

/**
 * Icon, name and chevron: the one control that opens the server menu.
 *
 * `forwardRef`, and every unrecognised prop spread onto the `<button>`,
 * because `Menu` renders this as `DropdownMenuPrimitive.Trigger`'s `asChild`
 * child — Radix clones it to attach `ref`, `onClick`, `onPointerDown`,
 * `onKeyDown`, `data-state`, `aria-expanded`, `aria-haspopup` and `id`. A
 * plain function component that ignores its extra props and forwards no ref
 * drops all of that on the floor: Radix cannot find the trigger's DOM node,
 * and the button never opens on a click, Enter, Space or ArrowDown. (A real
 * click in a browser is what caught this — every DOM assertion here still
 * passes against the closed markup, because closed is exactly what it looks
 * like when nothing is wired up at all.)
 *
 * The name gets a `Tooltip` only when `truncate` is actually cutting it —
 * see `useIsTruncated` — so a short name does not sprout a bubble that
 * repeats what is already on screen. `aria-label` on the button names its
 * job ("Server menu") rather than the server, which is correct — the
 * control opens a menu, it is not the name — but an explicit `aria-label`
 * also suppresses the accessible name a browser would otherwise compute
 * from the button's own content, so the server's name would be announced
 * nowhere at all without `aria-describedby` pointing at `[data-server-name]`
 * explicitly. That id is stable and always present (the tooltip wrapping
 * the name when it overflows changes nothing about the `<p>` itself), so a
 * screen reader always gets both: "Server menu" as the control's name and
 * the full server name as its description, sighted or not, truncated or
 * not.
 */
/**
 * The header's icon buttons with the toggle off: 32px, 28px from `md`, the
 * ring offset they always had. Under the redesign IconButton's own round
 * ghost draws them: 32px from `md` like the chat header's, 44px on a phone
 * so a thumb lands on it.
 */
const HEADER_ICON_BUTTON =
  "md:h-7 md:w-7 focus-visible:ring-offset-2 max-sm:redesign:h-11 max-sm:redesign:w-11 md:redesign:h-8 md:redesign:w-8";

const ServerHeaderMenuTrigger = forwardRef<
  HTMLButtonElement,
  { server: Server; isPublic?: boolean } & ComponentPropsWithoutRef<"button">
>(function ServerHeaderMenuTrigger(
  { server, isPublic = false, ...triggerProps },
  ref,
) {
  const { t } = useTranslation();
  const nameRef = useRef<HTMLParagraphElement | null>(null);
  const truncated = useIsTruncated(nameRef, server.name);
  const nameId = useId();
  const publicId = useId();

  const nameNode = (
    <p
      ref={nameRef}
      id={nameId}
      data-server-name=""
      className="min-w-0 flex-1 redesign:flex-initial truncate font-display text-sm font-bold tracking-tight leading-tight text-text redesign:font-[family-name:var(--type-title-font)]! redesign:text-[length:var(--sidebar-header-title-size)] redesign:font-bold redesign:tracking-[-0.012em]!"
    >
      {server.name}
    </p>
  );

  const nameBlock = truncated ? (
    <Tooltip label={server.name} side="bottom">
      {nameNode}
    </Tooltip>
  ) : (
    nameNode
  );

  return (
    <button
      ref={ref}
      type="button"
      data-server-menu-trigger=""
      aria-label={t("chrome.serverMenu")}
      aria-describedby={isPublic ? `${nameId} ${publicId}` : nameId}
      // `px-1`, no `py-*`: the row's own `py-2` (§6.2) plus the 32px icon
      // already total 48px (`min-h-12`) exactly. A vertical pad here on top
      // of that pushed a live-browser render to 56px — jsdom-only static
      // markup cannot see this (no layout engine), which is why it took a
      // real Playwright run to catch. `items-center` on the row still
      // centers everything; only the click/hover rectangle's own height
      // changed, not the icon's position. Under the redesign there is no
      // icon: the trigger is a 44px pill (`min-h-11`) and the name and caret
      // sit together at its start.
      className="group flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-control)] px-1 text-left transition-colors duration-[var(--duration-fast)] hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 data-[state=open]:bg-surface-2 redesign:min-h-11 redesign:gap-1.5 redesign:rounded-[var(--radius-row)] redesign:px-2 redesign:hover:bg-[color:var(--sidebar-trigger-hover)] redesign:data-[state=open]:bg-[color:var(--sidebar-trigger-open)] redesign:focus-visible:ring-accent redesign:focus-visible:ring-offset-0"
      {...triggerProps}
    >
      {/* Under the redesign the open server's tile sits right beside this
          header on the rail, picture and all, so the header gives the name
          that room instead of drawing the icon twice. */}
      <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-control)] bg-surface-2 font-display text-[11px] font-bold text-text redesign:hidden">
        <ServerIcon name={server.name} iconUrl={server.iconUrl} />
      </span>
      {isPublic ? (
        // The name keeps its full width and the mark goes UNDER it: beside it,
        // a 256px column left a name like "Sandbox" two letters. A public room
        // is never invisible from the inside, and a mark that eats the name is
        // one people learn to resent. 16px tall so the row stays under its
        // 48px floor (name line plus mark come to about 34px).
        <span className="flex min-w-0 flex-1 flex-col items-start redesign:flex-initial">
          {nameBlock}
          <PublicBadge id={publicId} className="h-4" />
        </span>
      ) : (
        nameBlock
      )}
      <ChevronDown
        aria-hidden="true"
        className="h-4 w-4 shrink-0 text-text-tertiary transition-transform duration-[var(--duration-fast)] group-data-[state=open]:rotate-180 redesign:hidden"
      />
      <Icon
        icon={CaretDown}
        kind="symbol"
        size="sm"
        className="hidden text-text-tertiary transition-transform duration-[var(--duration-fast)] group-data-[state=open]:rotate-180 motion-reduce:transition-none redesign:block"
      />
    </button>
  );
});

function PinnedChannelsSection({
  collapsed,
  onToggle,
  childCount,
  hasUnread,
  isDragOver,
  onDragOver,
  onDrop,
  children,
}: {
  collapsed: boolean;
  onToggle: () => void;
  childCount: number;
  hasUnread: boolean;
  isDragOver: boolean;
  onDragOver: () => void;
  onDrop: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const bodyId = useId();
  return (
    <div className="mb-4" data-pinned-channels="">
      <ChannelSectionHeader
        label={t("chrome.pinnedChannels")}
        collapsed={collapsed}
        onToggle={onToggle}
        controlsId={bodyId}
        childCount={childCount}
        hasUnread={hasUnread}
        isDragOver={isDragOver}
        className="mb-1"
        onDragOver={(event) => {
          event.preventDefault();
          onDragOver();
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDrop();
        }}
      />
      <div id={bodyId}>{children}</div>
    </div>
  );
}

/**
 * The channel types the Texto section lists. A forum is written in, not
 * talked in, so it sits with the text channels (and the server groups its
 * positions with `text` for the same reason).
 */
export function isTextGroupChannelType(type: string): boolean {
  return type === "text" || type === "forum";
}

/**
 * The Texto section's "+" while forums are on for this server: a text channel
 * first (still the common case, and what the plain "+" always did), then the
 * Fórum with its beta pill. Exported for the test.
 */
export function textSectionAddMenu({
  textLabel,
  forumLabel,
  onText,
  onForum,
}: {
  textLabel: string;
  forumLabel: string;
  onText: () => void;
  onForum: () => void;
}): ContextMenuItemDef[] {
  return [
    { id: "create-text", label: textLabel, icon: Hash, onSelect: onText },
    {
      id: "create-forum",
      label: forumLabel,
      icon: MessagesSquare,
      trailing: <BetaTag />,
      onSelect: onForum,
    },
  ];
}

interface SectionFold {
  collapsed: boolean;
  onToggle: () => void;
  childCount: number;
  hasUnread: boolean;
}

export function ChannelSection({
  label,
  fold,
  canManage,
  onAdd,
  onAddPrivate,
  addMenu,
  children,
  isDragOver = false,
  onDragOver,
  onDrop,
}: {
  label: string;
  fold: SectionFold;
  canManage: boolean;
  onAdd: () => void;
  onAddPrivate: () => void;
  /**
   * When set, the "+" opens this menu instead of creating straight away: the
   * section can make more than one kind of channel (Texto: a text channel or
   * a Fórum). Absent, the "+" is one click, as it always was.
   */
  addMenu?: ContextMenuItemDef[];
  children: ReactNode;
  isDragOver?: boolean;
  onDragOver?: (event: DragEvent) => void;
  onDrop?: () => void;
}) {
  const { t } = useTranslation();
  const bodyId = useId();
  const typeName = label.toLowerCase();
  const addButtonClass = cn(
    "rounded-sm p-0.5 text-text-tertiary hover:bg-surface-2 hover:text-text data-[state=open]:bg-surface-2 data-[state=open]:text-text",
    SECTION_FOCUS_RING,
    CATEGORY_ACTION_REDESIGN,
  );
  return (
    <div className="mb-4">
      <ChannelSectionHeader
        label={label}
        collapsed={fold.collapsed}
        onToggle={fold.onToggle}
        controlsId={bodyId}
        childCount={fold.childCount}
        hasUnread={fold.hasUnread}
        isDragOver={isDragOver}
        className="mb-1"
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
        actions={
          canManage && (
            <div className="flex shrink-0 gap-0.5 tracking-normal redesign:gap-0">
              {addMenu && addMenu.length > 0 ? (
                // The tooltip wraps the menu's trigger, not the other way
                // round: Radix's trigger is `asChild`, and a Tooltip inside it
                // would swallow the click that opens the menu.
                <Menu items={addMenu} align="end">
                  <button
                    type="button"
                    data-channel-section-add=""
                    aria-label={t("chrome.newInSection", { name: typeName })}
                    className={addButtonClass}
                  >
                    <SectionActionGlyph off={Plus} on={PlusBold} kind="symbol" />
                  </button>
                </Menu>
              ) : (
                <Tooltip label={t("chrome.newChannel", { name: typeName })}>
                  <button
                    type="button"
                    data-channel-section-add=""
                    className={addButtonClass}
                    onClick={onAdd}
                  >
                    <SectionActionGlyph off={Plus} on={PlusBold} kind="symbol" />
                  </button>
                </Tooltip>
              )}
              <Tooltip label={t("chrome.newPrivateChannel", { name: typeName })}>
                <button
                  type="button"
                  className={addButtonClass}
                  onClick={onAddPrivate}
                >
                  <SectionActionGlyph off={Lock} on={LockFill} kind="symbol" offClassName="h-3 w-3" />
                </button>
              </Tooltip>
            </div>
          )
        }
      />
      <div id={bodyId}>{children}</div>
    </div>
  );
}

export function CategoryHeader({
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
  childCount,
  hasUnread,
  controlsId,
}: {
  category: Channel;
  collapsed: boolean;
  onToggle: () => void;
  childCount: number;
  hasUnread: boolean;
  controlsId: string;
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
          "rounded-[var(--radius-control)] hover:bg-surface-2/70",
          isDragOver && "ring-1 ring-inset ring-accent/60",
          // Under the redesign a category reads like any other header: the
          // text brightens, no fill.
          "redesign:rounded-full redesign:hover:bg-transparent",
          isDragOver && "redesign:ring-0",
        )}
      >
        <ChannelSectionHeader
          label={category.name}
          dropFill={isDragOver}
          uppercase={false}
          collapsed={collapsed}
          onToggle={onToggle}
          controlsId={controlsId}
          childCount={childCount}
          hasUnread={hasUnread}
          className="py-1 text-xs"
        />
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
  const joinable = isVoiceRowJoinable({
    hasJoinHandler: !!onJoinVoice,
    connected,
    liveWatchParty: live,
  });
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

/**
 * The pencil beside a channel you left something typed in. Not on the
 * selected row: the draft is right there in the composer.
 */
export function DraftMark() {
  const { t } = useTranslation();
  return (
    <>
      <Pencil
        className="h-3 w-3 shrink-0 text-paper-muted redesign:hidden"
        aria-hidden
        data-draft-mark=""
      />
      <Icon icon={PencilSimple} className="hidden h-3 w-3 text-[color:var(--list-row-detail)] redesign:block" />
      <span className="sr-only">{t("chrome.draftSr")}</span>
    </>
  );
}

function CommunityHomeFace({
  server,
  compact,
}: {
  server: Pick<Server, "name" | "iconUrl" | "isCommunity" | "communitySlug">;
  compact?: boolean;
}) {
  const tile = compact ? "h-9 w-9 rounded-[10px]" : "h-8 w-8 rounded-lg";
  const type = compact ? "text-[11px]" : "text-[10px]";
  const poster = server.isCommunity || Boolean(server.iconUrl);
  if (!poster) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center bg-ink-4 text-paper-muted",
          tile,
        )}
        data-community-home-face="chest"
      >
        <Archive className="h-4 w-4" aria-hidden />
      </span>
    );
  }
  const hue = heroHue(server.communitySlug ?? server.name);
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden font-display font-bold text-paper",
        tile,
        type,
      )}
      style={heroTintStyle(hue, 60)}
      data-community-home-face="poster"
    >
      <ServerIcon
        name={server.name}
        iconUrl={server.iconUrl}
        className="h-full w-full object-cover"
        textClassName={cn("font-display font-bold text-paper", type)}
        fallback={initialsFor(server.name)}
      />
    </span>
  );
}

function CommunityHomeUnreadBadge({
  count,
  compact,
  pushRight = true,
}: {
  count: number;
  compact?: boolean;
  /** Takes the row's free space; false when a chip before it already did. */
  pushRight?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <span
      data-community-home-unread
      className={cn(
        // Lime, the brand signal: a new Baú post is news, not a mention, so
        // it never borrows the red the mention counts use.
        "min-w-4 rounded-full bg-signal px-1 py-0.5 text-center text-[10px] font-bold leading-none text-ink",
        compact && "absolute -right-1 -top-1",
        !compact && "shrink-0",
        !compact && pushRight && "ml-auto",
      )}
      aria-label={t("communityHome.badge.unread", { count })}
    >
      {formatBadgeCount(count)}
    </span>
  );
}

/**
 * Baú in the channel list: a page, not a #channel. Community servers show
 * the same face as the poster. Private halls keep the chest. No teaching
 * subtitle. The intro card already says what this is.
 */
function CommunityHomeNavButton({
  server,
  selected,
  unread,
  fresh = false,
  showNew,
  compact = false,
  onSelect,
}: {
  server: Pick<Server, "name" | "iconUrl" | "isCommunity" | "communitySlug">;
  selected: boolean;
  unread: number;
  /** The newest unread post is under 24 h old. */
  fresh?: boolean;
  showNew: boolean;
  compact?: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const button = (
    <button
      type="button"
      data-community-home-row
      aria-current={selected ? "page" : undefined}
      aria-label={compact ? t("communityHome.channelName") : undefined}
      className={cn(
        "transition-colors",
        compact
          ? "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
          : "flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left",
        selected
          ? compact
            ? "bg-ink-4 text-signal"
            : "bg-ink-4 text-paper"
          : "text-paper-muted hover:bg-ink-4/70 hover:text-paper",
      )}
      onClick={onSelect}
    >
      <CommunityHomeFace server={server} compact={compact} />
      {!compact && (
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-paper">
          {t("communityHome.channelName")}
        </span>
      )}
      {unread > 0 ? (
        <>
          {/* A different chip from the discovery one below: that says "you
              have never opened this", this says "something just landed".
              The pulse is motion-safe, so reduced motion gets a still chip. */}
          {!compact && fresh && (
            <span
              data-community-home-fresh
              className="ml-auto shrink-0 rounded bg-signal/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-signal motion-safe:animate-pulse"
            >
              {t("communityHome.badge.new")}
            </span>
          )}
          <CommunityHomeUnreadBadge
            count={unread}
            compact={compact}
            pushRight={!fresh}
          />
        </>
      ) : (
        !compact &&
        showNew && (
          <span className="shrink-0 rounded bg-signal/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-signal">
            {t("communityHome.badge.new")}
          </span>
        )
      )}
    </button>
  );
  if (compact) {
    return (
      <Tooltip label={t("communityHome.channelName")} side="right">
        {button}
      </Tooltip>
    );
  }
  return button;
}

export function ChannelRow({
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
   * viewer count while someone is on the stage, a Watch chip while live.
   * Absent (flag off, or any other type) the row is the plain one. A
   * watch_party row never full-joins voice from this list.
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
  const { t, locale } = useTranslation();
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
  const hasDraft = useHasDraft(channel.id) && !selected;
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
          when: formatSessionRelativeTime(sessionHint, new Date(), locale),
        })
      : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(". ");
  const live = liveState?.live === true;
  const topic = watchParty ? channel.topic?.trim() || null : null;
  const joinable = isVoiceRowJoinable({
    hasJoinHandler: !!onJoinVoice,
    connected,
    liveWatchParty: live,
  });

  const rowButton = (
    <button
      type="button"
      onClick={() => {
        const action = resolveVoiceRowClick({
          selected,
          joinable,
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
            joinable,
          }) === "join"
        ) {
          onJoinVoice?.();
        }
      }}
      onKeyDown={(event) => {
        const action = resolveVoiceRowKey(event.key, {
          joinable,
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
      className="flex min-w-0 flex-1 touch-manipulation items-center gap-1.5 text-left redesign:gap-[var(--list-row-gap-sm)] redesign:self-stretch redesign:rounded-[inherit] redesign:focus-visible:outline-none"
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
              className={cn(
                "truncate text-[10px] text-paper-muted",
                CHANNEL_DETAIL_REDESIGN,
                selected && "redesign:text-[color:var(--list-row-selected-text)]",
              )}
            >
              {/* Under the redesign the live mark is this dot, not the
                  AO VIVO pill: the Assistir chip already says live, and the
                  two together left the name three letters. */}
              <span
                aria-hidden="true"
                className="mr-1 hidden h-1.5 w-1.5 rounded-full bg-danger align-middle motion-safe:animate-pulse redesign:inline-block"
              />
              {t("chrome.watchPartyViewers", {
                count: liveState.viewerCount,
              })}
            </span>
          ) : sessionHint ? (
            <ChannelSessionHint startsAt={sessionHint} now={new Date()} />
          ) : (
            topic && (
              <span
                className={cn(
                  "truncate text-[10px] text-paper-muted",
                  CHANNEL_DETAIL_REDESIGN,
                  selected && "redesign:text-[color:var(--list-row-selected-text)]",
                )}
              >
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
      {hasDraft && <DraftMark />}
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
            className={cn(
              "flex items-center gap-1 rounded-full bg-danger/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-danger",
              // Under the redesign the dot on the viewer line says live
              // (the words stay for a screen reader).
              "redesign:sr-only",
            )}
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
        {/* Forums are new and still per server (`forum_channels`), so the
            row says so with the same pill the wordmark wears. It steps aside
            on hover, where the pin and settings tiles need the room, and
            when a mention count is there to be read instead. */}
        {channel.type === "forum" && mentions === 0 && (
          <BetaTag className="group-hover:hidden group-focus-within:hidden" />
        )}
        {mentions > 0 && (
          <CountBadge
            count={mentions}
            size="sm"
            aria-label={t("chrome.unreadMentions", { count: mentions })}
            className={cn(
              // The pill it always was with the toggle off.
              "h-auto py-0.5 text-center text-paper normal-nums",
              "redesign:h-[var(--count-badge-h)] redesign:min-w-[var(--count-badge-h)] redesign:py-0 redesign:text-[length:var(--count-badge-text)] redesign:tabular-nums redesign:text-on-danger",
            )}
          />
        )}
        {/* Under the redesign the unread mark is the list row's end pip;
            a mention count says it instead. */}
        {hasUnread && !muted && mentions === 0 && (
          <span
            aria-hidden="true"
            data-channel-unread-pip=""
            className={cn(
              "hidden h-[var(--list-row-pip)] w-[var(--list-row-pip)] shrink-0 rounded-full bg-indicator redesign:block",
              // The tiles take its place on hover (a count stays).
              (onToggleFavorite || canOpenSettings) &&
                "redesign:group-hover:hidden redesign:group-focus-within:hidden",
            )}
          />
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
          // Something on the drag, or Firefox (and an automated Chromium)
          // ends it before it begins. A private type, so dropping a row on
          // the composer does not type its name.
          event.dataTransfer?.setData("application/x-pqp-channel", channel.id);
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
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
          CHANNEL_ROW_REDESIGN,
          selected
            ? "redesign:bg-[color:var(--list-row-selected)] redesign:font-medium redesign:text-[color:var(--list-row-selected-text)]"
            : "redesign:text-[color:var(--list-row-text)] redesign:hover:bg-[color:var(--list-row-hover)] redesign:hover:text-text",
          hasUnread && !muted && !selected && !connected && "redesign:text-text",
          muted && !selected && !connected && "redesign:opacity-[var(--list-row-muted-opacity)]",
          isDragOver && !occupantDragActive && "redesign:ring-accent",
        )}
      >
        {hasUnread && !muted && (
          <span
            aria-hidden="true"
            className="absolute -left-1 top-1/2 h-4 w-1 -translate-y-1/2 rounded-r-full bg-paper redesign:hidden"
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
            Connected rows and live watch parties never call `onJoinVoice`
            from a double-click or Enter (see `joinable` below), so clicking
            the room you are in, or a live party you are watching, just
            keeps the view. */}
        {/* Always the same element. Rendering a bare button when there is
            no hint would swap the element type the moment `connected`
            flips, and React would drop keyboard focus on the way. */}
        <Tooltip label={joinHint ?? channel.name} name={rowName} side="right">
          {rowButton}
        </Tooltip>
        {watchParty && live && !connected && (
          /* Watching is select, never a full voice join. The chip is only
             here while the party is live so a draft room is opened by
             clicking the row, the way setup and Encerrar expect. */
          <button
            type="button"
            data-channel-join=""
            data-channel-watch=""
            draggable={false}
            className="shrink-0 rounded-md bg-danger/15 px-1.5 py-0.5 text-[10px] font-semibold text-danger hover:bg-danger/25 redesign:rounded-full redesign:bg-danger-soft redesign:px-2.5 redesign:py-1 redesign:text-xs redesign:text-on-danger-soft redesign:hover:bg-[color:color-mix(in_oklab,var(--color-danger-soft)_85%,var(--color-text))] redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-accent"
            title={t("watchParty.live.watchHint")}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onSelect();
            }}
          >
            {t("watchParty.live.watch")}
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
                // put once the channel is pinned. A touch screen never hovers,
                // so there an unpinned channel draws no pin: an invisible one
                // still took the tap. Fixar is in the long-press menu.
                "transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
                isFavorite
                  ? "text-paper"
                  : "translate-x-2 text-paper-muted opacity-0 group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:translate-x-0 group-focus-within:opacity-100 [@media(hover:none)]:hidden",
                CHANNEL_ACTION_REDESIGN,
                // Under the redesign a hidden tile takes no room, so the pip
                // ends the row; it comes in on hover or focus.
                isFavorite
                  ? "redesign:text-current"
                  : "redesign:hidden redesign:group-hover:flex redesign:group-focus-within:flex",
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
                className={cn("h-3.5 w-3.5", isFavorite && "fill-current", "redesign:hidden")}
              />
              <Icon
                icon={PushPin}
                className="hidden h-3.5 w-3.5 redesign:block"
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
                CHANNEL_ACTION_REDESIGN,
                selected
                  ? "redesign:text-[color:var(--list-row-selected-text)]"
                  : "redesign:hidden redesign:group-hover:flex redesign:group-focus-within:flex",
                // Same as the pin: not drawn on a touch screen unless the
                // channel is selected. Settings is in the long-press menu.
                selected
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:hidden",
              )}
              aria-label={t("chrome.channelSettings")}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openSettings();
              }}
            >
              <Settings className="h-3.5 w-3.5 redesign:hidden" />
              <Icon icon={GearSix} className="hidden h-3.5 w-3.5 redesign:block" />
            </button>
          </Tooltip>
        )}
      </div>
    </ContextMenu>
  );
}

/**
 * --- threads --- one row under a channel: open it, or leave it.
 *
 * Two sibling buttons rather than an X inside the row's button, which would be
 * a button inside a button. The X takes the unread dot's slot on hover and
 * focus, and is always there on a touch screen, where there is no hover.
 * Leaving is not destructive (the thread, its messages and its chip are all
 * still there, and replying rejoins it), so it asks for no confirmation.
 */
export function SidebarThreadRow({
  thread,
  unread,
  onOpen,
  onLeave,
  onMarkRead,
}: {
  thread: ThreadSummary;
  unread: boolean;
  onOpen: () => void;
  onLeave?: () => void;
  onMarkRead?: () => void;
}) {
  const { t } = useTranslation();
  const items: ContextMenuItemDef[] = [];
  if (unread && onMarkRead) {
    items.push({
      id: "mark-read",
      label: t("chat.markRead"),
      icon: CheckCheck,
      onSelect: onMarkRead,
    });
  }
  if (onLeave) {
    items.push({
      id: "leave",
      label: t("thread.leave"),
      icon: LogOut,
      onSelect: onLeave,
    });
  }
  return (
    <li>
      <ContextMenu items={items} disabled={items.length === 0}>
        <div className="group/thread relative flex items-center rounded-md hover:bg-surface-2/60 redesign:rounded-[var(--list-row-radius)] redesign:hover:bg-[color:var(--list-row-hover)]">
          <button
            type="button"
            onClick={onOpen}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs",
              onLeave && "pr-7 [@media(hover:none)]:pr-9",
              unread
                ? "font-semibold text-text"
                : "text-text-tertiary hover:text-text",
              // Under the redesign a thread is a smaller list row: a 32px
              // pill, the row's text roles, the end pip for unread.
              "redesign:min-h-8 redesign:gap-[var(--list-row-gap-sm)] redesign:rounded-[inherit] redesign:px-[var(--list-row-px)] redesign:text-[13px] redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-inset redesign:focus-visible:ring-accent",
              !unread && "redesign:text-[color:var(--list-row-text)]",
            )}
          >
            <MessageSquareText
              className="h-3 w-3 shrink-0 text-accent redesign:hidden"
              aria-hidden
            />
            <Icon icon={ChatText} className="hidden h-3.5 w-3.5 text-[color:var(--list-row-icon)] redesign:block" />
            <span className="min-w-0 truncate">{thread.name}</span>
            {unread && (
              <span
                className={cn(
                  "ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent",
                  "redesign:h-[var(--list-row-pip)] redesign:w-[var(--list-row-pip)] redesign:bg-indicator",
                  // Makes way for the X on hover. On touch the X is always
                  // there beside it, in the room `pr-7` keeps, so both stay.
                  onLeave &&
                    "[@media(hover:hover)]:group-hover/thread:opacity-0 [@media(hover:hover)]:group-focus-within/thread:opacity-0",
                )}
                aria-hidden
              />
            )}
          </button>
          {onLeave && (
            <Tooltip label={t("thread.leave")}>
              <button
                type="button"
                data-thread-leave=""
                aria-label={t("thread.leaveNamed", { name: thread.name })}
                onClick={onLeave}
                className="absolute right-1 flex h-5 w-5 items-center justify-center rounded text-text-tertiary opacity-0 [@media(hover:none)]:right-0 [@media(hover:none)]:h-8 [@media(hover:none)]:w-8 hover:bg-surface-3 hover:text-text focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-focus-ring group-hover/thread:opacity-100 group-focus-within/thread:opacity-100 [@media(hover:none)]:opacity-100 redesign:h-6 redesign:w-6 redesign:rounded-full redesign:hover:bg-[color:var(--card-row-hover)] redesign:focus-visible:ring-accent"
              >
                <X className="h-3 w-3 redesign:hidden" aria-hidden />
                <Icon icon={XBold} kind="symbol" className="hidden h-3 w-3 redesign:block" />
              </button>
            </Tooltip>
          )}
        </div>
      </ContextMenu>
    </li>
  );
}

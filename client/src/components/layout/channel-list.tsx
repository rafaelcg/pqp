import {
  ChevronRight,
  FolderPlus,
  HeadphoneOff,
  Home,
  Lock,
  MicOff,
  Phone,
  Plus,
  ScreenShare,
  Search,
  Settings,
  Star,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
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
import { VoiceAvatar } from "@/components/voice/voice-avatar";
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

/** Equal-width action tiles on a channel row (Join, star). */
const CHANNEL_ACTION_TILE =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-ink-3";

export function formatBadgeCount(value: number): string {
  return value > 99 ? "99+" : String(value);
}

/**
 * The per-occupant voice-state badges: mic-off, deafened, sharing screen.
 *
 * Rendered from the roster (`VoiceParticipant`), which the server updates on
 * every `set-voice-state` — so someone *outside* the call sees who is muted
 * before joining, which is the whole point. Deafened implies muted (the
 * controller enforces that), so only the deafen icon is shown then: two red
 * icons would say the same thing twice in a 16px row.
 *
 * There is deliberately no speaking badge here beyond the ring the in-call
 * viewer already gets: speaking is not carried on the roster (see the fan-out
 * note on `voiceParticipantSchema`), and this row must not pretend otherwise.
 */
export function VoiceOccupantBadges({
  person,
}: {
  person: VoiceParticipant;
}) {
  const { t } = useTranslation();
  if (!person.muted && !person.deafened && !person.sharingScreen) {
    return null;
  }
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      {person.sharingScreen && (
        <ScreenShare
          aria-label={t("chrome.sharingScreen")}
          role="img"
          className="h-3 w-3 text-signal"
        />
      )}
      {person.deafened ? (
        <HeadphoneOff
          aria-label={t("chrome.deafened")}
          role="img"
          className="h-3 w-3 text-danger"
        />
      ) : (
        person.muted && (
          <MicOff aria-label={t("chrome.muted")} role="img" className="h-3 w-3 text-danger" />
        )
      )}
    </span>
  );
}

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
  onCreateChannel: (
    type: "text" | "voice" | "category",
    isPrivate: boolean,
  ) => void;
  onRenameChannel: (channel: Channel) => void;
  onEditChannelMeta?: (channel: Channel) => void;
  onDeleteChannel: (channelId: string) => void;
  onTogglePrivate: (channel: Channel) => void;
  onManageChannelMembers: (channel: Channel) => void;
  onManageWebhooks: (channel: Channel) => void;
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
   * Community Home rollout. The parent combines the client feature flag with
   * this server's persisted opt-in before asking this list to show the row.
   */
  communityHomeEnabled?: boolean;
  communityHomeShowNew?: boolean;
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
  onCreateChannel,
  onRenameChannel,
  onEditChannelMeta,
  onDeleteChannel,
  onTogglePrivate,
  onManageChannelMembers,
  onManageWebhooks,
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
    return (
      <div key={channel.id} className="mb-0.5">
        <ChannelRow
          channel={channel}
          selected={selectedChannelId === channel.id}
          unread={unread[channel.id] ?? EMPTY_UNREAD}
          connected={activeVoiceChannelId === channel.id}
          canManage={canManage}
          canManageRoles={canManageRoles}
          icon={<ChannelIcon channel={channel} />}
          isDragging={draggedId === channel.id}
          isDragOver={dragOverId === channel.id}
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
              ? () => onJoinVoice(channel.id)
              : undefined
          }
          onRename={() => onRenameChannel(channel)}
          onEditMeta={
            onEditChannelMeta ? () => onEditChannelMeta(channel) : undefined
          }
          onDelete={() => onDeleteChannel(channel.id)}
          onTogglePrivate={() => onTogglePrivate(channel)}
          onManageMembers={() => onManageChannelMembers(channel)}
          onManageWebhooks={
            channel.type === "text" ? () => onManageWebhooks(channel) : undefined
          }
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
          onDragStart={() => setDraggedId(channel.id)}
          onDragEnd={() => {
            setDraggedId(null);
            setDragOverId(null);
          }}
          onDragOverRow={() => draggedId && setDragOverId(channel.id)}
          onDrop={() => handleDrop(channel)}
        />
        {occupants.length > 0 && (
          <ul className="ml-2 space-y-0.5 border-l border-ink-4/70 py-0.5 pl-2">
            {occupants.map((person) => (
              <li
                key={person.peerId}
                className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-paper-muted"
              >
                <VoiceAvatar
                  name={person.displayName}
                  avatarUrl={person.avatarUrl}
                  isSpeaking={speaking.has(person.peerId)}
                  muted={person.muted || person.deafened}
                  size="sm"
                />
                <span className="truncate">{person.displayName}</span>
                <VoiceOccupantBadges person={person} />
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const headerItems: ContextMenuItemDef[] = server
    ? [
        { id: "invite", label: t("chrome.invitePeople"), onSelect: onInvite },
        { id: "members", label: t("chrome.members"), onSelect: onOpenMembers },
        ...(canManage
          ? [
              { id: "sep", label: "", separator: true },
              {
                id: "settings",
                label: t("chrome.communitySettings"),
                onSelect: onOpenServerSettings,
              },
            ]
          : []),
      ]
    : [];

  return (
    <aside
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
                {communityHomeEnabled && (
                  <span className="shrink-0 rounded bg-accent/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-accent">
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
                isDragOver={dragOverId === FAVORITES_ZONE}
                onDragOver={() => draggedId && setDragOverId(FAVORITES_ZONE)}
                onDrop={() => handleDropOnFavorites()}
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
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                    communityHomeSelected
                      ? "bg-surface-3 text-text"
                      : "text-text-muted hover:bg-surface-3/70 hover:text-text",
                  )}
                  onClick={() => {
                    onSelectCommunityHome();
                    onMobileClose?.();
                  }}
                >
                  <Home
                    className={cn(
                      "mt-0.5 h-4 w-4 shrink-0",
                      communityHomeSelected ? "text-accent" : "text-text-muted",
                    )}
                    aria-hidden
                  />
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate text-sm font-semibold text-text">
                      {t("communityHome.channelName")}
                    </span>
                    {communityHomeShowNew && (
                      <span className="shrink-0 rounded bg-accent/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-accent">
                        {t("communityHome.badge.new")}
                      </span>
                    )}
                  </span>
                </button>
              </div>
            )}

            <ChannelSection
              label={t("chrome.text")}
              canManage={canManage}
              onAdd={() => onCreateChannel("text", false)}
              onAddPrivate={() => onCreateChannel("text", true)}
              isDragOver={dragOverId === TEXT_ZONE}
              onDragOver={() => draggedId && setDragOverId(TEXT_ZONE)}
              onDrop={() => {
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
              isDragOver={dragOverId === VOICE_ZONE}
              onDragOver={() => draggedId && setDragOverId(VOICE_ZONE)}
              onDrop={() => {
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
                        isDragOver={dragOverId === category.id}
                        onDragStart={() => setDraggedId(category.id)}
                        onDragEnd={() => {
                          setDraggedId(null);
                          setDragOverId(null);
                        }}
                        onDragOverRow={() =>
                          draggedId && setDragOverId(category.id)
                        }
                        onDrop={() => handleDrop(category)}
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
  onDragOver?: () => void;
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
                onDragOver();
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
        { id: "rename", label: t("chrome.renameCategory"), onSelect: onRename },
        { id: "sep", label: "", separator: true },
        {
          id: "delete",
          label: t("chrome.deleteCategory"),
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
  unread,
  connected = false,
  canManage,
  canManageRoles = false,
  icon,
  isDragging,
  isDragOver,
  isFavorite = false,
  onToggleFavorite,
  onSelect,
  onJoinVoice,
  onRename,
  onEditMeta,
  onDelete,
  onTogglePrivate,
  onManageMembers,
  onManageWebhooks,
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
  unread: UnreadState;
  connected?: boolean;
  canManage: boolean;
  canManageRoles?: boolean;
  icon: ReactNode;
  isDragging: boolean;
  isDragOver: boolean;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  onSelect: () => void;
  onJoinVoice?: () => void;
  onRename: () => void;
  onEditMeta?: () => void;
  onDelete: () => void;
  onTogglePrivate: () => void;
  onManageMembers: () => void;
  onManageWebhooks?: () => void;
  categories: Array<{ id: string; name: string }>;
  onMoveToCategory: (categoryId: string | null) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverRow: () => void;
  onDrop: () => void;
}) {
  const { t } = useTranslation();
  const notifications = useChannelNotificationLevel(channel);
  const items: ContextMenuItemDef[] = [];

  if (onToggleFavorite) {
    items.push({
      id: "favorite",
      label: isFavorite
        ? t("chrome.unfavoriteChannel")
        : t("chrome.favoriteChannel"),
      onSelect: onToggleFavorite,
    });
  }

  if (onJoinVoice && !connected) {
    items.push({
      id: "join",
      label: t("voice.join"),
      onSelect: onJoinVoice,
    });
  }

  if (canManage) {
    if (onToggleFavorite) {
      items.push({ id: "sep-fav", label: "", separator: true });
    }
    items.push({ id: "rename", label: t("chrome.renameChannel"), onSelect: onRename });
    if (onEditMeta) {
      items.push({
        id: "meta",
        label: t("chrome.editTopicIcon"),
        onSelect: onEditMeta,
      });
    }
    items.push({
      id: "private",
      label: channel.isPrivate ? t("chrome.makePublic") : t("chrome.makePrivate"),
      onSelect: onTogglePrivate,
    });
    if (channel.isPrivate || canManageRoles) {
      items.push({
        id: "invite-private",
        label: channel.isPrivate
          ? t("chrome.manageAccess")
          : t("channelPerms.title"),
        onSelect: onManageMembers,
      });
    }
    if (onManageWebhooks) {
      items.push({
        id: "webhooks",
        label: t("chrome.manageWebhooks"),
        onSelect: onManageWebhooks,
      });
    }
    items.push({ id: "sep-1", label: "", separator: true });
    if (onMoveUp) {
      items.push({ id: "move-up", label: t("chrome.moveUp"), onSelect: onMoveUp });
    }
    if (onMoveDown) {
      items.push({
        id: "move-down",
        label: t("chrome.moveDown"),
        onSelect: onMoveDown,
      });
    }
    if (channel.parentId) {
      items.push({
        id: "uncategorize",
        label: t("chrome.removeFromCategory"),
        onSelect: () => onMoveToCategory(null),
      });
    }
    for (const category of categories) {
      if (category.id === channel.parentId) {
        continue;
      }
      items.push({
        id: `move-to-${category.id}`,
        label: t("chrome.moveToCategory", { name: category.name }),
        onSelect: () => onMoveToCategory(category.id),
      });
    }
    items.push(
      { id: "sep-2", label: "", separator: true },
      {
        id: "delete",
        label: t("chrome.deleteChannel"),
        danger: true,
        onSelect: onDelete,
      },
    );
  }

  if (!canManage && isFavorite && (onMoveUp || onMoveDown)) {
    if (onToggleFavorite) {
      items.push({ id: "sep-fav-move", label: "", separator: true });
    }
    if (onMoveUp) {
      items.push({ id: "move-up", label: t("chrome.moveUp"), onSelect: onMoveUp });
    }
    if (onMoveDown) {
      items.push({
        id: "move-down",
        label: t("chrome.moveDown"),
        onSelect: onMoveDown,
      });
    }
  }

  if (!canManage && canManageRoles) {
    items.push({
      id: "invite-private",
      label: channel.isPrivate
        ? t("chrome.manageAccess")
        : t("channelPerms.title"),
      onSelect: onManageMembers,
    });
  }

  items.push(
    ...(items.length > 0
      ? [{ id: "sep-3", label: "", separator: true } as ContextMenuItemDef]
      : []),
    {
      id: "copy-id",
      label: t("chrome.copyChannelId"),
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
              "[data-channel-favorite], [data-channel-join]",
            )
          ) {
            event.preventDefault();
            return;
          }
          onDragStart();
        }}
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
          "group relative flex items-center gap-1 rounded-md px-2 py-1.5 text-sm",
          selected
            ? "bg-ink-3 text-paper"
            : "text-paper-muted hover:bg-ink-3/70 hover:text-paper",
          connected && "bg-signal/10 text-signal ring-1 ring-inset ring-signal/30",
          hasUnread && !muted && !selected && !connected && "text-paper",
          muted && !selected && !connected && "opacity-50",
          isDragging && "opacity-40",
          isDragOver && "ring-1 ring-inset ring-signal/60",
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
          onDoubleClick={
            onJoinVoice && !connected
              ? (event) => {
                  event.preventDefault();
                  onJoinVoice();
                }
              : undefined
          }
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
        {onJoinVoice && !connected && (
          <Tooltip label={t("voice.joinNamed", { name: channel.name })}>
            <button
              type="button"
              data-channel-join=""
              draggable={false}
              className={cn(CHANNEL_ACTION_TILE, "text-paper-muted")}
              aria-label={t("voice.joinNamed", { name: channel.name })}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onJoinVoice();
              }}
            >
              <Phone className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        )}
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
                isFavorite
                  ? "text-warning"
                  : "text-paper-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
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
      </div>
    </ContextMenu>
  );
}

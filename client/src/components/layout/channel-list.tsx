import {
  ChevronRight,
  FolderPlus,
  Lock,
  Plus,
  Search,
  Settings,
  Users,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { Channel, Server, VoiceParticipant } from "@pqp/shared";
import { SearchDialog } from "@/components/search/search-dialog";
import { ChannelIcon } from "@/components/layout/channel-icon";
import {
  ContextMenu,
  type ContextMenuItemDef,
} from "@/components/ui/context-menu";
import { ChannelListSkeleton } from "@/components/ui/skeleton";
import { VoiceAvatar } from "@/components/voice/voice-avatar";
import {
  loadCollapsedCategories,
  toggleCollapsedCategory,
} from "@/lib/collapsed-categories";
import {
  notificationLevelItems,
  useChannelNotificationLevel,
} from "@/hooks/use-notifications";
import { cn } from "@/lib/utils";

export interface UnreadState {
  count: number;
  mentions: number;
}

const EMPTY_UNREAD: UnreadState = { count: 0, mentions: 0 };

/** Apple keyboards label the same chord differently, and the hint is the point. */
const SEARCH_SHORTCUT_HINT =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.userAgent)
    ? "⌘K"
    : "Ctrl K";

export function formatBadgeCount(value: number): string {
  return value > 99 ? "99+" : String(value);
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
  isLoading?: boolean;
  voiceOccupancy?: Record<string, VoiceParticipant[]>;
  speakingPeerIds?: string[];
  activeVoiceChannelId: string | null;
  unread: Record<string, UnreadState>;
  onSelectChannel: (channelId: string) => void;
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
  onInvite: () => void;
  onOpenMembers: () => void;
  onOpenServerSettings: () => void;
  footer?: ReactNode;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export function ChannelList({
  server,
  channels,
  selectedChannelId,
  canManage,
  isLoading = false,
  voiceOccupancy = {},
  speakingPeerIds = [],
  activeVoiceChannelId,
  unread,
  onSelectChannel,
  onCreateChannel,
  onRenameChannel,
  onEditChannelMeta,
  onDeleteChannel,
  onTogglePrivate,
  onManageChannelMembers,
  onManageWebhooks,
  onMoveChannel,
  onInvite,
  onOpenMembers,
  onOpenServerSettings,
  footer,
  mobileOpen = false,
  onMobileClose,
}: ChannelListProps) {
  const topLevelText = sortByPosition(
    channels.filter((c) => c.type === "text" && !c.parentId),
  );
  const topLevelVoice = sortByPosition(
    channels.filter((c) => c.type === "voice" && !c.parentId),
  );
  const categories = sortByPosition(
    channels.filter((c) => c.type === "category"),
  );
  const categoryOptions = categories.map((c) => ({ id: c.id, name: c.name }));
  const childrenByCategory = new Map<string, Channel[]>();
  for (const category of categories) {
    childrenByCategory.set(
      category.id,
      sortByPosition(channels.filter((c) => c.parentId === category.id)),
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

  /**
   * Dropping onto a category header files the dragged channel inside it, at
   * the end. Dropping onto anything else takes that row's own slot within
   * its own sibling group — pushing it and everything after it down by one,
   * the ordinary "insert before" drag semantic. `position` is trusted as a
   * dense 0..n-1 index directly: the server always renumbers a sibling group
   * contiguously after every move, so there are never gaps to account for.
   */
  function handleDrop(target: Channel) {
    if (!draggedId || draggedId === target.id) {
      setDraggedId(null);
      setDragOverId(null);
      return;
    }
    const dragged = channels.find((c) => c.id === draggedId);
    setDraggedId(null);
    setDragOverId(null);
    if (!dragged) {
      return;
    }
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

  function renderRow(channel: Channel, group: Channel[]) {
    const index = group.findIndex((c) => c.id === channel.id);
    const occupants =
      channel.type === "voice" ? (voiceOccupancy[channel.id] ?? []) : [];
    return (
      <div key={channel.id} className="mb-0.5">
        <ChannelRow
          channel={channel}
          selected={selectedChannelId === channel.id}
          unread={unread[channel.id] ?? EMPTY_UNREAD}
          connected={activeVoiceChannelId === channel.id}
          canManage={canManage}
          icon={<ChannelIcon channel={channel} />}
          isDragging={draggedId === channel.id}
          isDragOver={dragOverId === channel.id}
          onSelect={() => {
            onSelectChannel(channel.id);
            onMobileClose?.();
          }}
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
            index > 0 ? () => moveWithinGroup(group, channel, -1) : undefined
          }
          onMoveDown={
            index < group.length - 1
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
                  size="sm"
                />
                <span className="truncate">{person.displayName}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const headerItems: ContextMenuItemDef[] = server
    ? [
        { id: "invite", label: "Invite people", onSelect: onInvite },
        { id: "members", label: "Members", onSelect: onOpenMembers },
        ...(canManage
          ? [
              { id: "sep", label: "", separator: true },
              {
                id: "settings",
                label: "Server settings",
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
      <ContextMenu items={headerItems}>
        <div className="flex h-14 items-center justify-between gap-2 border-b border-ink-4/60 px-4">
          <div className="min-w-0">
            <p className="truncate font-display text-base font-bold">
              {server?.name ?? (isLoading ? "Loading…" : "No server")}
            </p>
            {server?.role && (
              <p className="text-[11px] uppercase tracking-wider text-paper-muted">
                {server.role}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1">
            {server && (
              <>
                {canManage && (
                  <button
                    type="button"
                    className="rounded-md p-1.5 text-paper-muted hover:bg-ink-3 hover:text-paper"
                    title="Server settings"
                    aria-label="Server settings"
                    onClick={onOpenServerSettings}
                  >
                    <Settings className="h-4 w-4" />
                  </button>
                )}
                <button
                  type="button"
                  className="rounded-md p-1.5 text-paper-muted hover:bg-ink-3 hover:text-paper"
                  title="Members"
                  aria-label="Members"
                  onClick={onOpenMembers}
                >
                  <Users className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-xs text-signal hover:bg-ink-3"
                  onClick={onInvite}
                >
                  Invite
                </button>
              </>
            )}
            {onMobileClose && (
              <button
                type="button"
                className="rounded p-1 hover:bg-ink-3 md:hidden"
                aria-label="Close channel list"
                onClick={onMobileClose}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </ContextMenu>

      {server && (
        <div className="px-2 pt-2">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-0/60 px-2 py-1.5 text-xs text-text-muted transition-colors hover:border-border-strong hover:text-text"
            onClick={() => setSearchOpen(true)}
          >
            <Search className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Search messages</span>
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

      <div className="flex-1 overflow-y-auto p-2">
        {isLoading ? (
          <ChannelListSkeleton />
        ) : (
          <>
            <ChannelSection
              label="Text"
              canManage={canManage}
              onAdd={() => onCreateChannel("text", false)}
              onAddPrivate={() => onCreateChannel("text", true)}
            >
              {topLevelText.map((channel) => renderRow(channel, topLevelText))}
            </ChannelSection>

            <ChannelSection
              label="Voice"
              canManage={canManage}
              onAdd={() => onCreateChannel("voice", false)}
              onAddPrivate={() => onCreateChannel("voice", true)}
            >
              {topLevelVoice.map((channel) =>
                renderRow(channel, topLevelVoice),
              )}
            </ChannelSection>

            {(categories.length > 0 || canManage) && (
              <div className="mb-4">
                <div className="mb-1 flex items-center justify-between px-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-paper-muted">
                    Categories
                  </span>
                  {canManage && (
                    <button
                      type="button"
                      title="New category"
                      className="rounded p-0.5 text-paper-muted hover:bg-ink-3 hover:text-paper"
                      onClick={() => onCreateChannel("category", false)}
                    >
                      <FolderPlus className="h-3.5 w-3.5" />
                    </button>
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
                              Empty — drag a channel here.
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

function ChannelSection({
  label,
  canManage,
  onAdd,
  onAddPrivate,
  children,
}: {
  label: string;
  canManage: boolean;
  onAdd: () => void;
  onAddPrivate: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mb-4">
      <div className="mb-1 flex items-center justify-between px-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-paper-muted">
          {label}
        </span>
        {canManage && (
          <div className="flex gap-0.5">
            <button
              type="button"
              title={`New ${label.toLowerCase()} channel`}
              className="rounded p-0.5 text-paper-muted hover:bg-ink-3 hover:text-paper"
              onClick={onAdd}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title={`New private ${label.toLowerCase()} channel`}
              className="rounded p-0.5 text-paper-muted hover:bg-ink-3 hover:text-paper"
              onClick={onAddPrivate}
            >
              <Lock className="h-3 w-3" />
            </button>
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
  const items: ContextMenuItemDef[] = canManage
    ? [
        { id: "rename", label: "Rename category", onSelect: onRename },
        { id: "sep", label: "", separator: true },
        {
          id: "delete",
          label: "Delete category",
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
  icon,
  isDragging,
  isDragOver,
  onSelect,
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
  icon: ReactNode;
  isDragging: boolean;
  isDragOver: boolean;
  onSelect: () => void;
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
  const notifications = useChannelNotificationLevel(channel);
  const items: ContextMenuItemDef[] = [];

  if (canManage) {
    items.push({ id: "rename", label: "Rename channel", onSelect: onRename });
    if (onEditMeta) {
      items.push({
        id: "meta",
        label: "Edit topic & icon",
        onSelect: onEditMeta,
      });
    }
    items.push({
      id: "private",
      label: channel.isPrivate ? "Make public" : "Make private",
      onSelect: onTogglePrivate,
    });
    if (channel.isPrivate) {
      items.push({
        id: "invite-private",
        label: "Manage private access",
        onSelect: onManageMembers,
      });
    }
    if (onManageWebhooks) {
      items.push({
        id: "webhooks",
        label: "Manage webhooks",
        onSelect: onManageWebhooks,
      });
    }
    items.push({ id: "sep-1", label: "", separator: true });
    if (onMoveUp) {
      items.push({ id: "move-up", label: "Move up", onSelect: onMoveUp });
    }
    if (onMoveDown) {
      items.push({
        id: "move-down",
        label: "Move down",
        onSelect: onMoveDown,
      });
    }
    if (channel.parentId) {
      items.push({
        id: "uncategorize",
        label: "Remove from category",
        onSelect: () => onMoveToCategory(null),
      });
    }
    for (const category of categories) {
      if (category.id === channel.parentId) {
        continue;
      }
      items.push({
        id: `move-to-${category.id}`,
        label: `Move to “${category.name}”`,
        onSelect: () => onMoveToCategory(category.id),
      });
    }
    items.push(
      { id: "sep-2", label: "", separator: true },
      {
        id: "delete",
        label: "Delete channel",
        danger: true,
        onSelect: onDelete,
      },
    );
  }

  items.push(
    ...(items.length > 0 && canManage
      ? [{ id: "sep-3", label: "", separator: true } as ContextMenuItemDef]
      : []),
    {
      id: "copy-id",
      label: "Copy channel ID",
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
        draggable={canManage}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={(event) => {
          event.preventDefault();
          onDragOverRow();
        }}
        onDrop={(event) => {
          event.preventDefault();
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
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {icon}
          <span className={cn("truncate", hasUnread && !muted && "font-semibold")}>
            {channel.name}
          </span>
          {hasUnread && !muted && <span className="sr-only">(unread)</span>}
          {muted && <span className="sr-only">(muted)</span>}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {connected && (
              <>
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full bg-signal"
                />
                <span className="sr-only">Connected</span>
              </>
            )}
            {channel.isPrivate && (
              <span className="rounded bg-warning/10 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-warning">
                Private
              </span>
            )}
            {mentions > 0 && (
              <span
                className="min-w-4 rounded-full bg-danger px-1 py-0.5 text-center text-[10px] font-bold leading-none text-paper"
                aria-label={`${mentions} unread mentions`}
              >
                {formatBadgeCount(mentions)}
              </span>
            )}
          </span>
        </button>
      </div>
    </ContextMenu>
  );
}

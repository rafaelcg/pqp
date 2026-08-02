import { MessageCircle, Plus, UserPlus } from "lucide-react";
import type { Channel, Server } from "@pqp/shared";
import {
  formatBadgeCount,
  type UnreadState,
} from "@/components/layout/channel-list";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  type ContextMenuItemDef,
} from "@/components/ui/context-menu";
import {
  notificationLevelItems,
  serverNotificationControls,
  useNotificationState,
} from "@/hooks/use-notifications";
import { cn } from "@/lib/utils";

interface ServerRailProps {
  servers: Server[];
  selectedServerId: string | null;
  unread: Record<string, UnreadState>;
  channels: Channel[];
  /** True while the conversation view is what the sidebar is showing. */
  homeSelected: boolean;
  /** Unread across every conversation, which has no server icon to land on. */
  homeUnread: UnreadState;
  onSelectHome: () => void;
  onSelectServer: (serverId: string) => void;
  onCreateServer: () => void;
  onJoinServer: () => void;
  onInvite: (serverId: string) => void;
  onOpenMembers: (serverId: string) => void;
  onOpenSettings: (serverId: string) => void;
  onLeaveServer: (serverId: string) => void;
}

export function ServerRail({
  servers,
  selectedServerId,
  unread,
  channels,
  homeSelected,
  homeUnread,
  onSelectHome,
  onSelectServer,
  onCreateServer,
  onJoinServer,
  onInvite,
  onOpenMembers,
  onOpenSettings,
  onLeaveServer,
}: ServerRailProps) {
  // Subscribed once for the whole rail: hook rules forbid reading the store
  // inside the map below, and every icon needs the same snapshot anyway.
  const notifications = useNotificationState();

  // Channels are only known for the selected server, so every other icon stays
  // indicator-free rather than guessing.
  const selectedTotals = channels.reduce(
    (totals, channel) => {
      const state = unread[channel.id];
      if (!state) {
        return totals;
      }
      return {
        count: totals.count + state.count,
        mentions: totals.mentions + state.mentions,
      };
    },
    { count: 0, mentions: 0 },
  );

  return (
    <nav className="flex h-full w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-ink-4/40 bg-rail py-3">
      {/* Above the servers, and separated from them: conversations belong to no
          server, so putting Home in the list would read as one more of them. */}
      <button
        type="button"
        onClick={onSelectHome}
        title="Direct messages"
        aria-label="Direct messages"
        aria-current={homeSelected ? "page" : undefined}
        className={cn(
          "relative flex h-12 w-12 items-center justify-center rounded-2xl transition-all duration-200 hover:rounded-xl",
          homeSelected
            ? "rounded-xl bg-signal text-ink"
            : "bg-ink-3 text-paper hover:bg-signal hover:text-ink",
        )}
      >
        {homeSelected && (
          <span className="absolute -left-3 h-8 w-1 rounded-r bg-signal" />
        )}
        <MessageCircle className="h-5 w-5" />
        {homeUnread.count > 0 && homeUnread.mentions === 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-paper ring-2 ring-rail"
          />
        )}
        {homeUnread.mentions > 0 && (
          <span className="absolute -bottom-0.5 -right-0.5 min-w-[1.15rem] rounded-full bg-danger px-1 py-0.5 text-[10px] font-bold leading-none text-paper ring-2 ring-rail">
            {formatBadgeCount(homeUnread.mentions)}
          </span>
        )}
        {homeUnread.count > 0 && (
          <span className="sr-only">
            {homeUnread.mentions > 0
              ? `${homeUnread.mentions} unread mentions`
              : "unread messages"}
          </span>
        )}
      </button>
      <span
        aria-hidden="true"
        className="h-px w-8 shrink-0 rounded-full bg-ink-4/70"
      />

      {servers.map((server) => {
        const selected = selectedServerId === server.id;
        const totals = selected ? selectedTotals : null;
        const levels = serverNotificationControls(server.id, notifications);
        const muted = levels.level === "none";
        const mentions = muted ? 0 : (totals?.mentions ?? 0);
        const hasUnread =
          !muted && !!totals && (totals.count > 0 || mentions > 0);

        const items: ContextMenuItemDef[] = [
          {
            id: "invite",
            label: "Invite people",
            onSelect: () => onInvite(server.id),
          },
          {
            id: "members",
            label: "Members",
            onSelect: () => onOpenMembers(server.id),
          },
          {
            id: "settings",
            label: "Server settings",
            onSelect: () => onOpenSettings(server.id),
          },
        ];
        items.push(
          ...notificationLevelItems("notify", levels, "account"),
        );
        if (server.role !== "owner") {
          items.push(
            { id: "sep", label: "", separator: true },
            {
              id: "leave",
              label: "Leave server",
              danger: true,
              onSelect: () => onLeaveServer(server.id),
            },
          );
        }

        return (
          <ContextMenu key={server.id} items={items}>
            <button
              type="button"
              onClick={() => onSelectServer(server.id)}
              title={server.name}
              className={cn(
                "relative flex h-12 w-12 items-center justify-center rounded-2xl font-display text-sm font-bold transition-all duration-200 hover:rounded-xl",
                selected
                  ? "rounded-xl bg-signal text-ink"
                  : "bg-ink-3 text-paper hover:bg-signal hover:text-ink",
                muted && !selected && "opacity-50",
              )}
            >
              {selected && (
                <span className="absolute -left-3 h-8 w-1 rounded-r bg-signal" />
              )}
              {server.name.slice(0, 2).toUpperCase()}
              {hasUnread && mentions === 0 && (
                <span
                  aria-hidden="true"
                  className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-paper ring-2 ring-rail"
                />
              )}
              {mentions > 0 && (
                <span className="absolute -bottom-0.5 -right-0.5 min-w-[1.15rem] rounded-full bg-danger px-1 py-0.5 text-[10px] font-bold leading-none text-paper ring-2 ring-rail">
                  {formatBadgeCount(mentions)}
                </span>
              )}
              {hasUnread && (
                <span className="sr-only">
                  {mentions > 0
                    ? `${mentions} unread mentions`
                    : "unread messages"}
                </span>
              )}
            </button>
          </ContextMenu>
        );
      })}
      <Button
        variant="secondary"
        size="icon"
        className="h-12 w-12 rounded-2xl hover:rounded-xl"
        onClick={onCreateServer}
        title="Create server"
        aria-label="Create server"
      >
        <Plus className="h-5 w-5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-12 w-12 rounded-2xl hover:rounded-xl"
        onClick={onJoinServer}
        title="Join with invite"
        aria-label="Join with invite"
      >
        <UserPlus className="h-5 w-5" />
      </Button>
    </nav>
  );
}

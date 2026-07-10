import { Plus, UserPlus } from "lucide-react";
import type { Server } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  type ContextMenuItemDef,
} from "@/components/ui/context-menu";

interface ServerRailProps {
  servers: Server[];
  selectedServerId: string | null;
  onSelectServer: (serverId: string) => void;
  onCreateServer: () => void;
  onJoinServer: () => void;
  onInvite: (serverId: string) => void;
  onOpenMembers: (serverId: string) => void;
  onLeaveServer: (serverId: string) => void;
}

export function ServerRail({
  servers,
  selectedServerId,
  onSelectServer,
  onCreateServer,
  onJoinServer,
  onInvite,
  onOpenMembers,
  onLeaveServer,
}: ServerRailProps) {
  return (
    <nav className="flex h-full w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-ink-4/40 bg-rail py-3">
      {servers.map((server) => {
        const items: ContextMenuItemDef[] = [
          {
            id: "invite",
            label: "Invite people",
            onSelect: () => onInvite(server.id),
          },
          {
            id: "members",
            label: "Server settings",
            onSelect: () => onOpenMembers(server.id),
          },
        ];
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
              className={`relative flex h-12 w-12 items-center justify-center rounded-2xl font-display text-sm font-bold transition-all duration-200 hover:rounded-xl ${
                selectedServerId === server.id
                  ? "rounded-xl bg-signal text-ink"
                  : "bg-ink-3 text-paper hover:bg-signal hover:text-ink"
              }`}
            >
              {selectedServerId === server.id && (
                <span className="absolute -left-3 h-8 w-1 rounded-r bg-signal" />
              )}
              {server.name.slice(0, 2).toUpperCase()}
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
      >
        <Plus className="h-5 w-5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-12 w-12 rounded-2xl hover:rounded-xl"
        onClick={onJoinServer}
        title="Join with invite"
      >
        <UserPlus className="h-5 w-5" />
      </Button>
    </nav>
  );
}

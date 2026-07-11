import { Hash, Lock, Mic, Plus, Users, X } from "lucide-react";
import type { ReactNode } from "react";
import type { Channel, Server, VoiceParticipant } from "@pqp/shared";
import {
  ContextMenu,
  type ContextMenuItemDef,
} from "@/components/ui/context-menu";
import { ChannelListSkeleton } from "@/components/ui/skeleton";
import { VoiceAvatar } from "@/components/voice/voice-avatar";

interface ChannelListProps {
  server: Server | null;
  channels: Channel[];
  selectedChannelId: string | null;
  canManage: boolean;
  isLoading?: boolean;
  voiceOccupancy?: Record<string, VoiceParticipant[]>;
  speakingPeerIds?: string[];
  onSelectChannel: (channelId: string) => void;
  onCreateChannel: (type: "text" | "voice", isPrivate: boolean) => void;
  onRenameChannel: (channel: Channel) => void;
  onEditChannelMeta?: (channel: Channel) => void;
  onDeleteChannel: (channelId: string) => void;
  onTogglePrivate: (channel: Channel) => void;
  onManageChannelMembers: (channel: Channel) => void;
  onInvite: () => void;
  onOpenMembers: () => void;
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
  onSelectChannel,
  onCreateChannel,
  onRenameChannel,
  onEditChannelMeta,
  onDeleteChannel,
  onTogglePrivate,
  onManageChannelMembers,
  onInvite,
  onOpenMembers,
  footer,
  mobileOpen = false,
  onMobileClose,
}: ChannelListProps) {
  const textChannels = channels.filter((c) => c.type === "text");
  const voiceChannels = channels.filter((c) => c.type === "voice");
  const speaking = new Set(speakingPeerIds);

  return (
    <aside
      className={`fixed inset-y-0 left-[72px] z-30 flex w-[min(100%-72px,16rem)] flex-col border-r border-ink-4/60 bg-channel transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] md:static md:z-auto md:w-64 md:translate-x-0 ${
        mobileOpen
          ? "translate-x-0"
          : "-translate-x-[calc(100%+72px)] md:translate-x-0"
      }`}
    >
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
              <button
                type="button"
                className="rounded-md p-1.5 text-paper-muted hover:bg-ink-3 hover:text-paper"
                title="Members"
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
              onClick={onMobileClose}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

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
              {textChannels.map((channel) => (
                <ChannelRow
                  key={channel.id}
                  channel={channel}
                  selected={selectedChannelId === channel.id}
                  canManage={canManage}
                  icon={<ChannelIcon channel={channel} />}
                  onSelect={() => {
                    onSelectChannel(channel.id);
                    onMobileClose?.();
                  }}
                  onRename={() => onRenameChannel(channel)}
                  onEditMeta={
                    onEditChannelMeta
                      ? () => onEditChannelMeta(channel)
                      : undefined
                  }
                  onDelete={() => onDeleteChannel(channel.id)}
                  onTogglePrivate={() => onTogglePrivate(channel)}
                  onManageMembers={() => onManageChannelMembers(channel)}
                />
              ))}
            </ChannelSection>

            <ChannelSection
              label="Voice"
              canManage={canManage}
              onAdd={() => onCreateChannel("voice", false)}
              onAddPrivate={() => onCreateChannel("voice", true)}
            >
              {voiceChannels.map((channel) => {
                const occupants = voiceOccupancy[channel.id] ?? [];
                return (
                  <div key={channel.id} className="mb-0.5">
                    <ChannelRow
                      channel={channel}
                      selected={selectedChannelId === channel.id}
                      canManage={canManage}
                      icon={<ChannelIcon channel={channel} />}
                      onSelect={() => {
                        onSelectChannel(channel.id);
                        onMobileClose?.();
                      }}
                      onRename={() => onRenameChannel(channel)}
                      onEditMeta={
                        onEditChannelMeta
                          ? () => onEditChannelMeta(channel)
                          : undefined
                      }
                      onDelete={() => onDeleteChannel(channel.id)}
                      onTogglePrivate={() => onTogglePrivate(channel)}
                      onManageMembers={() => onManageChannelMembers(channel)}
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
              })}
            </ChannelSection>
          </>
        )}
      </div>

      {footer}
    </aside>
  );
}

function ChannelIcon({ channel }: { channel: Channel }) {
  if (channel.imageUrl) {
    if (channel.imageUrl.startsWith("http") || channel.imageUrl.startsWith("/")) {
      return (
        <img
          src={channel.imageUrl}
          alt=""
          className="h-3.5 w-3.5 shrink-0 rounded-sm object-cover"
        />
      );
    }
    return (
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[11px] leading-none">
        {channel.imageUrl}
      </span>
    );
  }
  if (channel.isPrivate) {
    return <Lock className="h-3.5 w-3.5 shrink-0 text-warning" />;
  }
  if (channel.type === "voice") {
    return <Mic className="h-3.5 w-3.5 shrink-0" />;
  }
  return <Hash className="h-3.5 w-3.5 shrink-0" />;
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

function ChannelRow({
  channel,
  selected,
  canManage,
  icon,
  onSelect,
  onRename,
  onEditMeta,
  onDelete,
  onTogglePrivate,
  onManageMembers,
}: {
  channel: Channel;
  selected: boolean;
  canManage: boolean;
  icon: ReactNode;
  onSelect: () => void;
  onRename: () => void;
  onEditMeta?: () => void;
  onDelete: () => void;
  onTogglePrivate: () => void;
  onManageMembers: () => void;
}) {
  const items: ContextMenuItemDef[] = [];

  if (canManage) {
    items.push(
      { id: "rename", label: "Rename channel", onSelect: onRename },
    );
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
    items.push(
      { id: "sep-1", label: "", separator: true },
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
      ? [{ id: "sep-2", label: "", separator: true } as ContextMenuItemDef]
      : []),
    {
      id: "copy-id",
      label: "Copy channel ID",
      onSelect: () => void navigator.clipboard.writeText(channel.id),
    },
  );

  return (
    <ContextMenu items={items}>
      <div
        className={`group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm ${
          selected
            ? "bg-ink-3 text-paper"
            : "text-paper-muted hover:bg-ink-3/70 hover:text-paper"
        }`}
      >
        <button
          type="button"
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {icon}
          <span className="truncate">{channel.name}</span>
          {channel.isPrivate && (
            <span className="ml-auto shrink-0 rounded bg-warning/10 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-warning">
              Private
            </span>
          )}
        </button>
      </div>
    </ContextMenu>
  );
}

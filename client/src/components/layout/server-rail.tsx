import { Compass, MessageCircle, Plus, UserPlus } from "lucide-react";
import type { Server } from "@pqp/shared";
import {
  formatBadgeCount,
  type UnreadState,
} from "@/components/layout/channel-list";
import { ServerIcon } from "@/components/layout/server-identity";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import {
  ContextMenu,
  type ContextMenuItemDef,
} from "@/components/ui/context-menu";
import { offersProfileVisibility } from "@/components/depoimentos/depoimentos-model";
import {
  notificationLevelItems,
  serverNotificationControls,
  useNotificationState,
} from "@/hooks/use-notifications";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface ServerRailProps {
  servers: Server[];
  selectedServerId: string | null;
  /**
   * Unread totalled per server, for every server — not only the selected one.
   *
   * This used to be `unread` (by channel) plus `channels` (the selected
   * server's list), and summing those could only ever light the icon already
   * selected: no other server's channel list is fetched, so its channel ids
   * meant nothing here. A desktop notification about any other server therefore
   * had no counterpart anywhere on screen, which is what "I get notifications
   * when nothing happened" turns out to mean. The caller resolves the totals
   * from the activity frames' own server ids.
   */
  serverUnread: Record<string, UnreadState>;
  /** True while the conversation view is what the sidebar is showing. */
  homeSelected: boolean;
  /** Unread across every conversation, which has no server icon to land on. */
  homeUnread: UnreadState;
  /**
   * Friend requests waiting on this account.
   *
   * Kept SEPARATE from `homeUnread` rather than added into its mention count,
   * even though both mean "something is waiting on you behind this icon". They
   * are different errands with different answers — one is read, one is answered
   * — and folding them together would make the number lie in the direction that
   * matters: "3" that turns out to be two messages and one request sends you
   * looking for a third message that does not exist.
   */
  friendRequestCount?: number;
  /** True while the directory is covering the app. */
  communitiesSelected?: boolean;
  /**
   * Opens the Communities directory.
   *
   * ABSENT ENTIRELY on a deployment where `/api/communities/config` answered
   * `enabled: false`, which is what makes the compass not exist rather than
   * exist-and-refuse.
   */
  onOpenCommunities?: () => void;
  onSelectHome: () => void;
  onSelectServer: (serverId: string) => void;
  onCreateServer: () => void;
  onJoinServer: () => void;
  onInvite: (serverId: string) => void;
  onOpenMembers: (serverId: string) => void;
  onOpenSettings: (serverId: string) => void;
  onLeaveServer: (serverId: string) => void;
  /**
   * "Show this on my profile" — the member's own badge opt-out, offered only on
   * a listed community because that is the only kind of server whose chip can
   * ever appear on anybody's card. See `offersProfileVisibility`.
   */
  onToggleProfileVisibility?: (serverId: string, showOnProfile: boolean) => void;
}

export function ServerRail({
  servers,
  selectedServerId,
  serverUnread,
  homeSelected,
  homeUnread,
  friendRequestCount = 0,
  communitiesSelected = false,
  onOpenCommunities,
  onSelectHome,
  onSelectServer,
  onCreateServer,
  onJoinServer,
  onInvite,
  onOpenMembers,
  onOpenSettings,
  onLeaveServer,
  onToggleProfileVisibility,
}: ServerRailProps) {
  const { t } = useTranslation();
  // Subscribed once for the whole rail: hook rules forbid reading the store
  // inside the map below, and every icon needs the same snapshot anyway.
  const notifications = useNotificationState();

  return (
    <nav className="flex h-full w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-ink-4/40 bg-rail py-3">
      {/* Above the servers, and separated from them: conversations belong to no
          server, so putting Home in the list would read as one more of them. */}
      {/* Every bubble on this rail points right. The rail is 72px against the
          left edge of the window, so a bubble above or below a tile would sit
          on the tile next to it, and one on the left would be off-screen. */}
      <Tooltip label={t("chrome.directMessages")} side="right" tone="rail">
      <button
        type="button"
        onClick={onSelectHome}
        aria-current={homeSelected ? "page" : undefined}
        className={cn(
          "group relative flex h-12 w-12 items-center justify-center rounded-2xl transition-all duration-200 hover:rounded-xl",
          homeSelected
            ? "rounded-xl bg-signal text-ink"
            : "bg-ink-3 text-paper hover:bg-signal hover:text-ink",
        )}
      >
        <RailPill kind={homeSelected ? "selected" : homeUnread.count > 0 ? "unread" : "none"} />
        <MessageCircle className="h-5 w-5" />
        {/* Friend requests stay lime and take the top-right corner. Unread
            DMs use the red bubble Discord puts on Home — that is how a
            waiting conversation shows up on this rail at all. Both can
            land at once: requests above, DMs below. */}
        {friendRequestCount > 0 ? (
          <RailCountBadge
            count={friendRequestCount}
            tone="signal"
            dataFriendRequests
          />
        ) : homeUnread.count > 0 ? (
          <RailCountBadge count={homeUnread.count} tone="danger" />
        ) : null}
        {friendRequestCount > 0 && homeUnread.count > 0 && (
          <RailCountBadge
            count={homeUnread.count}
            tone="danger"
            corner="bottom"
          />
        )}
        {friendRequestCount > 0 && (
          <span className="sr-only">
            {t("friends.pendingBadge", { count: friendRequestCount })}
          </span>
        )}
        {homeUnread.count > 0 && (
          <span className="sr-only">
            {homeUnread.mentions > 0
              ? t("chrome.unreadMentions", { count: homeUnread.mentions })
              : t("chrome.unreadMessagesSr")}
          </span>
        )}
      </button>
      </Tooltip>
      <span
        aria-hidden="true"
        className="h-px w-8 shrink-0 rounded-full bg-ink-4/70"
      />

      {servers.map((server) => {
        const selected = selectedServerId === server.id;
        const totals = serverUnread[server.id] ?? null;
        const levels = serverNotificationControls(server.id, notifications);
        const muted = levels.level === "none";
        const mentions = muted ? 0 : (totals?.mentions ?? 0);
        const hasUnread =
          !muted && !!totals && (totals.count > 0 || mentions > 0);

        const items: ContextMenuItemDef[] = [
          {
            id: "invite",
            label: t("chrome.invitePeople"),
            onSelect: () => onInvite(server.id),
          },
          {
            id: "members",
            label: t("chrome.members"),
            onSelect: () => onOpenMembers(server.id),
          },
          {
            id: "settings",
            label: t("chrome.communitySettings"),
            onSelect: () => onOpenSettings(server.id),
          },
        ];
        // Only for a listed community: a private server is never chipped onto
        // anybody's profile, so the switch would be a no-op there — and worse,
        // it would imply that private servers ARE advertised by default.
        if (offersProfileVisibility(server) && onToggleProfileVisibility) {
          items.push({
            id: "profile-visibility",
            label: server.showOnProfile
              ? t("communities.hideFromProfile")
              : t("communities.showOnProfile"),
            onSelect: () =>
              onToggleProfileVisibility(server.id, !server.showOnProfile),
          });
        }
        items.push(
          ...notificationLevelItems("notify", levels, "account"),
        );
        if (server.role !== "owner") {
          items.push(
            { id: "sep", label: "", separator: true },
            {
              id: "leave",
              label: t("chrome.leaveCommunity"),
              danger: true,
              onSelect: () => onLeaveServer(server.id),
            },
          );
        }

        return (
          // Tooltip wraps a span so the context-menu trigger can still be the
          // button. Both primitives want `asChild` on the same node, and
          // neither forwards through the other.
          <Tooltip key={server.id} label={server.name} side="right" tone="rail">
            <span className="relative inline-flex">
          <ContextMenu items={items}>
            <button
              type="button"
              onClick={() => onSelectServer(server.id)}
              aria-label={server.name}
              className={cn(
                "group relative flex h-12 w-12 items-center justify-center rounded-xl font-display text-sm font-bold transition-colors",
                selected
                  ? "bg-signal text-ink"
                  : "bg-ink-3 text-paper hover:bg-signal hover:text-ink",
                muted && !selected && "opacity-50",
              )}
            >
              <RailPill
                kind={selected ? "selected" : hasUnread ? "unread" : "none"}
              />
              {/* The clip lives on this span rather than on the button so the
                  selection pip, which is drawn outside the button's own box,
                  survives. `rounded-[inherit]` keeps the photo in the same
                  rounded square the empty monogram uses. */}
              <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-[inherit]">
                <ServerIcon name={server.name} iconUrl={server.iconUrl} />
              </span>
              {mentions > 0 && (
                <RailCountBadge count={mentions} tone="danger" />
              )}
              {hasUnread && (
                <span className="sr-only">
                  {mentions > 0
                    ? t("chrome.unreadMentions", { count: mentions })
                    : t("chrome.unreadMessagesSr")}
                </span>
              )}
            </button>
          </ContextMenu>
            </span>
          </Tooltip>
        );
      })}
      <Tooltip label={t("empty.createServer")} side="right" tone="rail">
        <Button
          variant="secondary"
          size="icon"
          className="h-12 w-12 rounded-2xl hover:rounded-xl"
          onClick={onCreateServer}
        >
          <Plus className="h-5 w-5" />
        </Button>
      </Tooltip>
      <Tooltip label={t("chrome.joinInvite")} side="right" tone="rail">
        <Button
          variant="ghost"
          size="icon"
          className="h-12 w-12 rounded-2xl hover:rounded-xl"
          onClick={onJoinServer}
        >
          <UserPlus className="h-5 w-5" />
        </Button>
      </Tooltip>

      {/* Communities, at the FOOT of the rail and separated from everything
          above it.
          The position is the point. Above this line the rail is the rooms you
          are already in, in the order you put them; the compass is the only
          thing here that leads somewhere you have not been, so it sits apart
          and it sits still — `mt-auto` pins it to the bottom edge no matter how
          many servers are stacked over it, which is what makes it findable
          without being read. It is the same placement Discord gives discovery,
          for the same reason.
          NO BADGE, EVER. Every other icon on this rail earns its corner marks
          by having something waiting for you; a directory has nothing waiting
          for anybody, and a count here would be an invention. */}
      {onOpenCommunities && (
        <>
          <span
            aria-hidden="true"
            className="mt-auto h-px w-8 shrink-0 rounded-full bg-ink-4/70"
          />
          <Tooltip label={t("communities.title")} side="right" tone="rail">
            <button
              type="button"
              data-communities-rail
              onClick={onOpenCommunities}
              aria-current={communitiesSelected ? "page" : undefined}
              className={cn(
                "group relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl transition-all duration-200 hover:rounded-xl",
                communitiesSelected
                  ? "rounded-xl bg-signal text-ink"
                  : "bg-ink-3 text-paper hover:bg-signal hover:text-ink",
              )}
            >
              <RailPill kind={communitiesSelected ? "selected" : "none"} />
              <Compass className="h-5 w-5" />
            </button>
          </Tooltip>
        </>
      )}
    </nav>
  );
}

function RailPill({ kind }: { kind: "selected" | "unread" | "none" }) {
  if (kind === "none") {
    return null;
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute -left-3 w-1 rounded-r-full transition-[height] duration-200",
        kind === "selected"
          ? "h-8 bg-signal"
          : "h-2 bg-paper group-hover:h-5",
      )}
    />
  );
}

function RailCountBadge({
  count,
  tone,
  corner = "top",
  dataFriendRequests = false,
}: {
  count: number;
  tone: "danger" | "signal";
  corner?: "top" | "bottom";
  dataFriendRequests?: boolean;
}) {
  if (count <= 0) {
    return null;
  }
  return (
    <span
      aria-hidden="true"
      {...(dataFriendRequests ? { "data-friend-requests": count } : {})}
      className={cn(
        "absolute right-[-5px] flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[11px] font-bold leading-none ring-[3px] ring-rail",
        corner === "top" ? "top-[-5px]" : "bottom-[-5px]",
        tone === "danger" ? "bg-danger text-paper" : "bg-signal text-ink",
      )}
    >
      {formatBadgeCount(count)}
    </span>
  );
}

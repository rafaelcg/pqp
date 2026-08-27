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
      <Tooltip label={t("chrome.directMessages")} side="right">
      <button
        type="button"
        onClick={onSelectHome}
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
        {/* Friend requests, in `signal` rather than `danger`, at the top corner
            where the plain-unread dot would sit.
            IT TAKES PRECEDENCE over that dot rather than sitting beside it:
            72px of rail has room for one thing per corner, and a count is
            strictly more informative than a dot. The mention badge keeps its own
            bottom corner, so a request and a mention are both visible at once
            and remain the two different colours they are. */}
        {friendRequestCount > 0 ? (
          <span
            aria-hidden="true"
            data-friend-requests={friendRequestCount}
            className="absolute -right-1 -top-1 min-w-[1.15rem] rounded-full bg-signal px-1 py-0.5 text-center text-[10px] font-bold leading-none text-ink ring-2 ring-rail"
          >
            {formatBadgeCount(friendRequestCount)}
          </span>
        ) : (
          homeUnread.count > 0 &&
          homeUnread.mentions === 0 && (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-paper ring-2 ring-rail"
            />
          )
        )}
        {friendRequestCount > 0 && (
          <span className="sr-only">
            {t("friends.pendingBadge", { count: friendRequestCount })}
          </span>
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
          // The one tile on this rail that keeps a native `title`. Radix's
          // context-menu trigger and its tooltip trigger both want to BE this
          // button, and neither forwards props through the other, so pairing
          // them means composing both primitives onto one element by hand.
          // Not worth it here: a server tile shows its own picture, its name is
          // the first thing in the header the moment you click it, and the
          // right-click menu is the interaction this tile is really for.
          <ContextMenu key={server.id} items={items}>
            <button
              type="button"
              onClick={() => onSelectServer(server.id)}
              title={server.name}
              className={cn(
                "relative flex h-12 w-12 items-center justify-center rounded-xl font-display text-sm font-bold transition-colors",
                selected
                  ? "bg-signal text-ink"
                  : "bg-ink-3 text-paper hover:bg-signal hover:text-ink",
                muted && !selected && "opacity-50",
              )}
            >
              {selected && (
                <span className="absolute -left-3 h-8 w-1 rounded-r bg-signal" />
              )}
              {/* The clip lives on this span rather than on the button so the
                  selection pip, which is drawn outside the button's own box,
                  survives. `rounded-[inherit]` keeps the photo in the same
                  rounded square the empty monogram uses. */}
              <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-[inherit]">
                <ServerIcon name={server.name} iconUrl={server.iconUrl} />
              </span>
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
      <Tooltip label={t("empty.createServer")} side="right">
        <Button
          variant="secondary"
          size="icon"
          className="h-12 w-12 rounded-2xl hover:rounded-xl"
          onClick={onCreateServer}
        >
          <Plus className="h-5 w-5" />
        </Button>
      </Tooltip>
      <Tooltip label={t("chrome.joinInvite")} side="right">
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
          <Tooltip label={t("communities.title")} side="right">
            <button
              type="button"
              data-communities-rail
              onClick={onOpenCommunities}
              aria-current={communitiesSelected ? "page" : undefined}
              className={cn(
                "relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl transition-all duration-200 hover:rounded-xl",
                communitiesSelected
                  ? "rounded-xl bg-signal text-ink"
                  : "bg-ink-3 text-paper hover:bg-signal hover:text-ink",
              )}
            >
              {communitiesSelected && (
                <span className="absolute -left-3 h-8 w-1 rounded-r bg-signal" />
              )}
              <Compass className="h-5 w-5" />
            </button>
          </Tooltip>
        </>
      )}
    </nav>
  );
}

import {
  ArrowDown,
  ArrowUp,
  Compass,
  Eye,
  EyeOff,
  Globe,
  MessageCircle,
  PinOff,
  Plus,
  Palette,
  Settings,
  UserPlus,
  Users,
} from "lucide-react";
import {
  ChatCircle,
  Compass as CompassFill,
  GlobeSimple,
  Palette as PaletteFill,
  Plus as PlusBold,
  UserPlus as UserPlusFill,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import type { LucideIcon } from "lucide-react";
import type { DmSummary, PublicUser, Server } from "@pqp/shared";
import { useId, useMemo } from "react";
import type { UnreadState } from "@/components/layout/channel-list";
import { ServerIcon } from "@/components/layout/server-identity";
import {
  leaveCommunityMenuItems,
  serverNotificationMenuItems,
} from "@/components/layout/server-menu-items";
import { Button } from "@/components/ui/button";
import { CountBadge } from "@/components/ui/count-badge";
import { Icon, type IconKind } from "@/components/ui/icon";
import { Tooltip } from "@/components/ui/tooltip";
import {
  ContextMenu,
  type ContextMenuItemDef,
} from "@/components/ui/context-menu";
import { offersProfileVisibility } from "@/components/depoimentos/depoimentos-model";
import {
  serverNotificationControls,
  useChannelNotificationLevel,
  useNotificationState,
} from "@/hooks/use-notifications";
import {
  formatBauBadge,
  railServerIndicator,
} from "@/lib/community-home/rail-unread";
import { useTranslation } from "@/lib/i18n";
import { isServerPublic } from "@/lib/community-access";
import {
  resolveNotificationLevel,
} from "@/lib/notifications";
import { conversationsWithUnread } from "@/lib/conversation-list";
import { conversationTitle } from "@/lib/conversations";
import { UserAvatar } from "@/components/user/user-avatar";
import { useServerRailReorder } from "@/hooks/use-server-rail-reorder";
import { UpdateIndicator } from "@/components/layout/update-indicator";
import { setRedesignChoice, useRedesign } from "@/lib/redesign";
import { cn } from "@/lib/utils";
import { RAIL_REDESIGN } from "@/components/ui/pane";

interface ServerRailProps {
  servers: Server[];
  /**
   * The instance has public communities on. A server with a public address
   * says so on its rail icon (tooltip, accessible name and a small globe), but
   * only while this is true: with it off the address answers 404.
   */
  communitiesEnabled?: boolean;
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
  /**
   * Unread Baú posts per server (`GET /api/community-home/unread`), servers
   * with none absent. Lights the white pip like any unread channel and adds
   * the Baú's own cue: a lime count at the corner, or a lime ring when the
   * red mention count already holds the corner (`railServerIndicator`).
   */
  serverBauUnread?: Record<string, number>;
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
  /** The in-app release notes, from the update popover's "see all" link. */
  onOpenWhatsNew?: () => void;
  /**
   * Conversations this person pinned to the rail, already filtered to ones
   * still in the list, in pin order. Empty means the Home bubble is the only
   * DM door, which is the usual case.
   */
  pinnedConversations?: DmSummary[];
  /** Live unread for those conversations, same map the Home badge reads. */
  pinnedUnread?: Record<string, UnreadState>;
  /** The pinned conversation currently open, or null. */
  selectedPinnedId?: string | null;
  onSelectPinned?: (channelId: string) => void;
  onUnpinConversation?: (channelId: string) => void;
  /** Servers with a watch party on air right now: a red dot on the bubble. */
  liveServerIds?: ReadonlySet<string>;
  /**
   * PUT AWAY ON A PHONE (`party_newcomer_experience`): under `md` the 72px rail
   * leaves the flow, which is 18% of a 390px screen a live party's viewer
   * wants for the room. It is not gone: while the nav drawer is open
   * (`mobileNavOpen`, the hamburger in the party bar) it is drawn over the
   * page at the left edge, exactly where the drawer's own `left-[72px]`
   * expects it. From `md` up nothing changes.
   */
  phoneHidden?: boolean;
  mobileNavOpen?: boolean;
  onSelectHome: () => void;
  onSelectServer: (serverId: string) => void;
  /**
   * Save a new order for the servers on this rail (drag, Alt+arrows, or the
   * menu). Absent means the rail is not reorderable (a build or a test that
   * does not own the list). The caller applies it optimistically and rolls
   * back on failure; `servers` is what the rail draws, so the new order must
   * come back through that prop.
   */
  onReorderServers?: (serverIds: string[]) => void;
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
  /**
   * `stream_start_notifications` per server, as far as the menus have asked
   * (`useStreamAlertSettings`). The switch is offered only where `flag` is on.
   */
  streamAlertInfo?: Record<string, { flag: boolean; default: boolean }>;
  /** A server's menu opened: ask whether it has the switch. */
  onServerMenuOpen?: (serverId: string) => void;
  /**
   * CONVERSAS (`conversations_home`). On, the DM door is labelled
   * "Conversas", its badge counts CONVERSATIONS waiting rather than
   * messages, and the people with an unread conversation surface under it as
   * faces, one click from anywhere. Off, the rail is what it was.
   */
  conversationsHome?: boolean;
  /** Every conversation, for the faces under the door. */
  conversations?: DmSummary[];
  /** The conversation on screen: never surfaced, never counted. */
  openConversationId?: string | null;
}

/** Faces under the door before the rest fold into a "+N". */
export const RAIL_UNREAD_FACES = 3;

/**
 * Under the redesign every tile on the rail is one shape: a 44px circle in the
 * side pane's colour (`--rail-tile-*`), the label in secondary text. A hover
 * lifts the fill and rounds it toward the selected square; it never turns
 * lime, so lime only ever means "you are here". Appended after each tile's own
 * classes, so the toggle off draws what it always drew.
 */
const RAIL_TILE_REDESIGN =
  "redesign:h-[var(--rail-tile)] redesign:w-[var(--rail-tile)] redesign:rounded-full redesign:bg-[color:var(--rail-tile-bg)] redesign:text-text-secondary redesign:font-sans! redesign:tracking-normal! redesign:text-[13px] redesign:font-semibold redesign:hover:rounded-[var(--rail-tile-radius-selected)] redesign:hover:bg-[color:var(--rail-tile-hover)] redesign:hover:text-text redesign:transition-[border-radius,background-color,color] redesign:duration-[var(--duration-fast)] redesign:motion-reduce:transition-none redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-text redesign:focus-visible:ring-offset-2 redesign:focus-visible:ring-offset-canvas";

/** The place on screen: the accent's rounded square, lifted. */
const RAIL_TILE_SELECTED_REDESIGN =
  "redesign:rounded-[var(--rail-tile-radius-selected)] redesign:bg-accent redesign:text-on-accent redesign:shadow-[var(--rail-tile-shadow)] redesign:hover:bg-accent redesign:hover:text-on-accent";

/** A rule between the rail's groups. */
const RAIL_DIVIDER_REDESIGN = "redesign:bg-[color:var(--rail-divider)]";

/**
 * A rail glyph: the Lucide outline with the toggle off, the redesign's
 * Phosphor glyph (filled object, bold symbol) under it.
 */
function RailGlyph({
  off: Off,
  on,
  kind = "object",
}: {
  off: LucideIcon;
  on: PhosphorIcon;
  kind?: IconKind;
}) {
  return (
    <>
      <Off className="h-5 w-5 redesign:hidden" aria-hidden="true" />
      <Icon icon={on} kind={kind} className="hidden redesign:block" />
    </>
  );
}

export function ServerRail({
  communitiesEnabled = false,
  liveServerIds,
  servers,
  selectedServerId,
  serverUnread,
  serverBauUnread,
  homeSelected,
  homeUnread,
  friendRequestCount = 0,
  communitiesSelected = false,
  onOpenCommunities,
  onOpenWhatsNew,
  pinnedConversations = [],
  pinnedUnread = {},
  selectedPinnedId = null,
  onSelectPinned,
  onUnpinConversation,
  onSelectHome,
  onSelectServer,
  onReorderServers,
  onCreateServer,
  onJoinServer,
  onInvite,
  onOpenMembers,
  onOpenSettings,
  onLeaveServer,
  onToggleProfileVisibility,
  streamAlertInfo,
  onServerMenuOpen,
  phoneHidden = false,
  mobileNavOpen = false,
  conversationsHome = false,
  conversations = [],
  openConversationId = null,
}: ServerRailProps) {
  const { t } = useTranslation();
  const redesign = useRedesign();
  // Subscribed once for the whole rail: hook rules forbid reading the store
  // inside the map below, and every icon needs the same snapshot anyway.
  const notifications = useNotificationState();
  // Conversas: who is waiting, muted ones and the open one left out. The
  // badge is how many of them (three people writing forty lines is 3); the
  // faces are the first few, except the ones already pinned below, which
  // carry their own badge in their own slot.
  const waiting = conversationsHome
    ? conversationsWithUnread(conversations, pinnedUnread, {
        openChannelId: openConversationId,
        isMuted: (channelId) =>
          resolveNotificationLevel(notifications, null, channelId) === "none",
      })
    : [];
  const pinnedIds = new Set(pinnedConversations.map((one) => one.channelId));
  const waitingFaces = waiting.filter((one) => !pinnedIds.has(one.channelId));
  const shownFaces = waitingFaces.slice(0, RAIL_UNREAD_FACES);
  const foldedFaces = waitingFaces.length - shownFaces.length;
  const doorCount = conversationsHome ? waiting.length : homeUnread.count;

  // Dragging a server, Alt+arrows and the menu all end in the same call. Chats
  // (the door above), the divider and the add / discover buttons below are not
  // in this list, so none of them can be moved or displaced.
  const serverIds = useMemo(() => servers.map((server) => server.id), [servers]);
  const reorderHintId = useId();
  const reorder = useServerRailReorder({
    ids: serverIds,
    enabled: !!onReorderServers,
    onReorder: (next) => onReorderServers?.(next),
    announce: (id, position, total) =>
      t("chrome.railMoved", {
        name: servers.find((server) => server.id === id)?.name ?? "",
        n: position,
        total,
      }),
  });

  return (
    <nav
      ref={reorder.navRef}
      data-rail-dragging={reorder.drag ? "" : undefined}
      data-immersive-hide=""
      data-rail-phone-hidden={phoneHidden ? "" : undefined}
      className={cn(
        "relative flex h-full w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-ink-4/40 bg-rail py-3",
        RAIL_REDESIGN,
        reorder.drag && "cursor-grabbing",
        phoneHidden &&
          (mobileNavOpen
            ? "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:h-auto"
            : "max-md:hidden"),
      )}
    >
      {/* Above the servers, and separated from them: conversations belong to no
          server, so putting Home in the list would read as one more of them. */}
      {/* Every bubble on this rail points right. The rail is 72px against the
          left edge of the window, so a bubble above or below a tile would sit
          on the tile next to it, and one on the left would be off-screen. */}
      <span
        data-rail-conversations={conversationsHome ? "" : undefined}
        className="flex shrink-0 flex-col items-center gap-1"
      >
      <Tooltip
        label={
          conversationsHome
            ? t("conversations.rail.tooltip", { count: waiting.length })
            : t("chrome.directMessages")
        }
        side="right"
        tone="rail"
        mark
      >
      <button
        type="button"
        onClick={onSelectHome}
        aria-current={homeSelected ? "page" : undefined}
        className={cn(
          "group relative flex h-12 w-12 items-center justify-center rounded-2xl transition-all duration-200 hover:rounded-xl",
          homeSelected
            ? "rounded-xl bg-signal text-ink"
            : "bg-ink-3 text-paper hover:bg-signal hover:text-ink",
          RAIL_TILE_REDESIGN,
          homeSelected && RAIL_TILE_SELECTED_REDESIGN,
        )}
      >
        <RailPill kind={homeSelected ? "selected" : doorCount > 0 ? "unread" : "none"} />
        <RailGlyph off={MessageCircle} on={ChatCircle} />
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
        ) : doorCount > 0 ? (
          <RailCountBadge count={doorCount} tone="danger" dataConversations={conversationsHome} />
        ) : null}
        {friendRequestCount > 0 && doorCount > 0 && (
          <RailCountBadge
            count={doorCount}
            tone="danger"
            corner="bottom"
            dataConversations={conversationsHome}
          />
        )}
        {friendRequestCount > 0 && (
          <span className="sr-only">
            {t("friends.pendingBadge", { count: friendRequestCount })}
          </span>
        )}
        {conversationsHome ? (
          waiting.length > 0 && (
            <span className="sr-only">
              {t("conversations.rail.waitingSr", { count: waiting.length })}
            </span>
          )
        ) : (
          homeUnread.count > 0 && (
            <span className="sr-only">
              {homeUnread.mentions > 0
                ? t("chrome.unreadMentions", { count: homeUnread.mentions })
                : t("chrome.unreadMessagesSr")}
            </span>
          )
        )}
      </button>
      </Tooltip>
      {/* The one labelled door on the rail: a name is what makes it read as
          a place rather than one more icon. */}
      {conversationsHome && (
        <span
          aria-hidden="true"
          data-rail-conversations-label=""
          className={cn(
            "max-w-[68px] truncate text-[10px] font-semibold leading-none redesign:mt-1 redesign:text-[11px]",
            homeSelected ? "text-text" : "text-text-secondary",
          )}
        >
          {t("conversations.rail.label")}
        </span>
      )}
      </span>
      {shownFaces.map((conversation) => (
        <PinnedConversationButton
          key={conversation.channelId}
          conversation={conversation}
          unread={pinnedUnread[conversation.channelId] ?? { count: 0, mentions: 0 }}
          selected={false}
          surfaced
          onSelect={() => onSelectPinned?.(conversation.channelId)}
        />
      ))}
      {foldedFaces > 0 && (
        <Tooltip
          label={t("conversations.rail.more", { count: foldedFaces })}
          side="right"
          tone="rail"
          mark
        >
          <button
            type="button"
            data-rail-conversations-more={foldedFaces}
            onClick={onSelectHome}
            className={cn(
              "flex h-12 w-12 shrink-0 animate-pop-in items-center justify-center rounded-full bg-ink-3 font-display text-sm font-bold text-paper transition-colors hover:bg-signal hover:text-ink",
              RAIL_TILE_REDESIGN,
            )}
          >
            +{foldedFaces}
          </button>
        </Tooltip>
      )}
      {pinnedConversations.map((conversation) => (
        <PinnedConversationButton
          key={conversation.channelId}
          conversation={conversation}
          unread={pinnedUnread[conversation.channelId] ?? { count: 0, mentions: 0 }}
          selected={selectedPinnedId === conversation.channelId}
          onSelect={() => onSelectPinned?.(conversation.channelId)}
          onUnpin={
            onUnpinConversation
              ? () => onUnpinConversation(conversation.channelId)
              : undefined
          }
        />
      ))}
      <span
        aria-hidden="true"
        className={cn("h-px w-8 shrink-0 rounded-full bg-ink-4/70", RAIL_DIVIDER_REDESIGN)}
      />

      {/* The reorderable part: only servers live in here. While one is dragged
          the others slide apart to open the gap where it will land; there is no
          line, because the gap is the indicator. */}
      <div
        ref={reorder.listRef}
        data-rail-list=""
        className="relative flex shrink-0 flex-col items-center gap-2"
      >
      {servers.map((server, index) => {
        const selected = selectedServerId === server.id;
        const lifted = reorder.drag?.id === server.id ? reorder.drag : null;
        const totals = serverUnread[server.id] ?? null;
        const levels = serverNotificationControls(server.id, notifications);
        const muted = levels.level === "none";
        const isPublic = isServerPublic(server, communitiesEnabled);
        const publicName = t("chrome.railPublicName", { name: server.name });
        // The name stays the server's own (people and tests find the button by
        // it); "Public" is its description, which a screen reader reads after.
        const publicDescId = `${reorderHintId}-public-${server.id}`;
        const { mentions, hasUnread, bauOnly, bauCue, bauCount } =
          railServerIndicator({
          totals,
          bauUnread: serverBauUnread?.[server.id] ?? 0,
          muted,
        });

        const items: ContextMenuItemDef[] = [
          {
            id: "invite",
            label: t("chrome.invitePeople"),
            icon: UserPlus,
            onSelect: () => onInvite(server.id),
          },
          {
            id: "members",
            label: t("chrome.members"),
            icon: Users,
            onSelect: () => onOpenMembers(server.id),
          },
          {
            id: "settings",
            label: t("chrome.communitySettings"),
            icon: Settings,
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
            icon: server.showOnProfile ? EyeOff : Eye,
            onSelect: () =>
              onToggleProfileVisibility(server.id, !server.showOnProfile),
          });
        }
        items.push(
          ...serverNotificationMenuItems(
            server.id,
            notifications,
            streamAlertInfo?.[server.id],
            t,
          ),
        );
        if (onReorderServers && servers.length > 1) {
          // The same move as Alt+arrows, for the mouse, the phone and anybody
          // who would not find a keyboard chord.
          items.push(
            { id: "sep-order", label: "", separator: true },
            {
              id: "move-up",
              label: t("chrome.moveUp"),
              icon: ArrowUp,
              disabled: index === 0,
              onSelect: () => reorder.moveTo(server.id, index - 1),
            },
            {
              id: "move-down",
              label: t("chrome.moveDown"),
              icon: ArrowDown,
              disabled: index === servers.length - 1,
              onSelect: () => reorder.moveTo(server.id, index + 1),
            },
          );
        }
        items.push(
          ...leaveCommunityMenuItems(
            server.role === "owner",
            () => onLeaveServer(server.id),
            t,
          ),
        );

        return (
          // Tooltip wraps a span so the context-menu trigger can still be the
          // button. Both primitives want `asChild` on the same node, and
          // neither forwards through the other.
          <Tooltip
            key={server.id}
            label={isPublic ? publicName : server.name}
            side="right"
            tone="rail"
            mark
          >
            <span
              ref={reorder.itemRef(server.id)}
              data-rail-item={server.id}
              data-rail-reorderable={
                onReorderServers && servers.length > 1 ? "" : undefined
              }
              data-rail-lifted={lifted ? "" : undefined}
              {...(onReorderServers ? reorder.itemProps(server.id) : {})}
              // Its transform is set by the hook, frame by frame, outside React.
              style={lifted ? { zIndex: 20 } : undefined}
              className={cn(
                "relative inline-flex select-none [-webkit-touch-callout:none]",
                lifted && "rounded-xl shadow-xl shadow-black/30",
              )}
            >
          <ContextMenu
            items={items}
            onOpenChange={
              onServerMenuOpen
                ? (open) => {
                    if (open) {
                      onServerMenuOpen(server.id);
                    }
                  }
                : undefined
            }
          >
            <button
              type="button"
              onClick={() => onSelectServer(server.id)}
              aria-label={server.name}
              aria-describedby={
                [
                  onReorderServers ? reorderHintId : null,
                  isPublic ? publicDescId : null,
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              aria-keyshortcuts={
                onReorderServers ? "Alt+ArrowUp Alt+ArrowDown" : undefined
              }
              className={cn(
                "group relative flex h-12 w-12 items-center justify-center rounded-xl font-display text-sm font-bold transition-colors",
                selected
                  ? "bg-signal text-ink"
                  : "bg-ink-3 text-paper hover:bg-signal hover:text-ink",
                muted && !selected && "opacity-50",
                RAIL_TILE_REDESIGN,
                selected && RAIL_TILE_SELECTED_REDESIGN,
                // The Baú's ring: only when a red mention count holds the
                // corner. The glow is the same signal token, so it follows
                // the theme's accent. Under the redesign it hugs the disc with
                // no gap, the way a story ring does; a ring with a gap is
                // keyboard focus.
                bauCue === "ring" &&
                  "ring-2 ring-signal ring-offset-2 ring-offset-rail shadow-[0_0_12px_1px_color-mix(in_oklab,var(--color-signal)_55%,transparent)] redesign:ring-accent redesign:ring-offset-0",
              )}
              data-bau-cue={bauCue === "none" ? undefined : bauCue}
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
              {/* THE BAÚ'S OWN COUNT, in lime, where the mention count would
                  be. A mention wins the corner (it is addressed to you); the
                  Baú then falls back to the ring on the button. */}
              {bauCue === "count" && (
                <RailCountBadge
                  count={bauCount}
                  tone="signal"
                  label={formatBauBadge(bauCount)}
                  dataBau
                />
              )}
              {/* A SHOW IS ON IN HERE. The one thing a rail bubble did not
                  say: a member sitting in another server had no way to
                  know a watch party had started. A red dot, bottom right,
                  in the live vocabulary the sidebar block uses, and the
                  pulse only under motion-safe. A mention count wins the
                  corner: a number is more specific than a dot. */}
              {/* A PUBLIC ROOM SAYS SO. Bottom left, where nothing else sits (the
                  count is top right, the live dot bottom right), so the mark
                  never competes for a corner. The word lives in the tooltip
                  and the accessible description; this is its icon. */}
              {isPublic && (
                <>
                  <span
                    data-server-public=""
                    aria-hidden="true"
                    className="absolute -bottom-0.5 -left-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-rail text-signal redesign:-bottom-1 redesign:-left-1 redesign:h-[18px] redesign:w-[18px] redesign:bg-canvas redesign:text-text-secondary"
                  >
                    <Globe className="h-3 w-3 redesign:hidden" />
                    <Icon icon={GlobeSimple} size="sm" className="hidden h-3.5 w-3.5 redesign:block" />
                  </span>
                  <span id={publicDescId} className="sr-only">
                    {t("chrome.publicCommunity")}
                  </span>
                </>
              )}
              {liveServerIds?.has(server.id) && mentions === 0 && (
                <span
                  data-server-live=""
                  className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-rail redesign:-bottom-1 redesign:-right-1 redesign:h-[18px] redesign:w-[18px] redesign:bg-canvas"
                >
                  {/* Solid under the redesign: a pulsing 10px dot spent half its
                      time maroon on the dark canvas. */}
                  <span className="h-2.5 w-2.5 rounded-full bg-danger motion-safe:animate-pulse redesign:h-3 redesign:w-3 redesign:motion-safe:animate-none" />
                  <span className="sr-only">{t("chrome.livePartySr")}</span>
                </span>
              )}
              {hasUnread && (
                <span className="sr-only">
                  {mentions > 0
                    ? t("chrome.unreadMentions", { count: mentions })
                    : bauCue === "count"
                      ? t("chrome.unreadBauCountSr", { count: bauCount })
                      : bauOnly
                        ? t("chrome.unreadBauSr")
                        : t("chrome.unreadMessagesSr")}
                </span>
              )}
            </button>
          </ContextMenu>
            </span>
          </Tooltip>
        );
      })}
      </div>
      {onReorderServers && (
        <>
          <span id={reorderHintId} className="sr-only">
            {t("chrome.railReorderHint")}
          </span>
          <span role="status" aria-live="polite" className="sr-only">
            {reorder.message}
          </span>
        </>
      )}
      <Tooltip label={t("empty.createServer")} side="right" tone="rail">
        <Button
          variant="secondary"
          size="icon"
          className={cn("h-12 w-12 rounded-2xl hover:rounded-xl", RAIL_TILE_REDESIGN, "redesign:border-0")}
          onClick={onCreateServer}
        >
          <RailGlyph off={Plus} on={PlusBold} kind="symbol" />
        </Button>
      </Tooltip>
      <Tooltip label={t("chrome.joinInvite")} side="right" tone="rail">
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-12 w-12 rounded-2xl hover:rounded-xl",
            RAIL_TILE_REDESIGN,
          )}
          onClick={onJoinServer}
        >
          <RailGlyph off={UserPlus} on={UserPlusFill} />
        </Button>
      </Tooltip>

      {/* Product chrome, at the FOOT of the rail and separated from the halls,
          the same place Discord puts things that are not servers: discovery
          (the compass), then the two switches that are about the app itself,
          the look and the update. None of them is a hall.

          The sparkle that opened the release notes used to sit here. Baú
          carries the news now, and the notes are still one click away from
          the update popover's "see all".

          The update button is ALWAYS here, like T3 Code's: up to date, an
          update to download, downloading, ready to restart or reload, or a
          failure to retry. See `components/layout/update-indicator.tsx`. */}
      <span
        aria-hidden="true"
        className={cn("mt-auto h-px w-8 shrink-0 rounded-full bg-ink-4/70", RAIL_DIVIDER_REDESIGN)}
      />
      {onOpenCommunities && (
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
              RAIL_TILE_REDESIGN,
              communitiesSelected && RAIL_TILE_SELECTED_REDESIGN,
            )}
          >
            <RailPill kind={communitiesSelected ? "selected" : "none"} />
            <RailGlyph off={Compass} on={CompassFill} />
          </button>
        </Tooltip>
      )}
      {/* Novo visual, the same switch as Configurações > Beta, here while the
          redesign is being tried so nobody has to dig for the way back. */}
      <Tooltip
        label={redesign ? t("rail.newLook.on") : t("rail.newLook.off")}
        side="right"
        tone="rail"
      >
        <button
          type="button"
          data-new-look-rail=""
          aria-pressed={redesign}
          aria-label={t("rail.newLook.label")}
          onClick={() => setRedesignChoice(!redesign)}
          className={cn(
            "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text-secondary transition-colors duration-[var(--duration-fast)] hover:bg-border hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
            "redesign:h-[var(--rail-tile)] redesign:w-[var(--rail-tile)] redesign:bg-[color:var(--rail-tile-bg)] redesign:text-text-secondary redesign:hover:bg-[color:var(--rail-tile-hover)] redesign:hover:text-text redesign:focus-visible:ring-text redesign:focus-visible:ring-offset-2 redesign:focus-visible:ring-offset-canvas",
          )}
        >
          <Palette className="h-4 w-4 redesign:hidden" aria-hidden="true" />
          <Icon icon={PaletteFill} kind="symbol" size="sm" className="hidden redesign:block" />
        </button>
      </Tooltip>
      <div className="flex shrink-0 justify-center pt-0.5">
        <UpdateIndicator variant="rail" always onOpenWhatsNew={onOpenWhatsNew} />
      </div>
    </nav>
  );
}

const MAX_PINNED_AVATARS = 3;

function PinnedConversationButton({
  conversation,
  unread,
  selected,
  onSelect,
  onUnpin,
  surfaced = false,
}: {
  conversation: DmSummary;
  unread: UnreadState;
  selected: boolean;
  onSelect: () => void;
  onUnpin?: () => void;
  /**
   * Conversas: on the rail because it is waiting, not because it was pinned.
   * It pops in, and it leaves on its own once read.
   */
  surfaced?: boolean;
}) {
  const { t } = useTranslation();
  const notifications = useChannelNotificationLevel({
    id: conversation.channelId,
    serverId: null,
  });
  const title = conversationTitle(conversation.participants);
  const muted = notifications.level === "none";
  const mentions = selected || muted ? 0 : unread.mentions;
  const badge = mentions > 0 ? mentions : muted || selected ? 0 : unread.count;
  const hasUnread = !selected && !muted && unread.count > 0;

  const items: ContextMenuItemDef[] = onUnpin
    ? [
        {
          id: "unpin",
          label: t("chrome.unpinConversation"),
          icon: PinOff,
          onSelect: onUnpin,
        },
      ]
    : [];

  const button = (
    <button
      type="button"
      onClick={onSelect}
      aria-label={title}
      aria-current={selected ? "page" : undefined}
      data-rail-conversation={surfaced ? "waiting" : "pinned"}
      className={cn(
        "group relative flex h-12 w-12 items-center justify-center rounded-full transition-colors",
        surfaced && "animate-pop-in",
        selected
          ? "bg-signal text-ink"
          : "bg-ink-3 text-paper hover:bg-signal hover:text-ink",
        muted && !selected && "opacity-50",
        RAIL_TILE_REDESIGN,
        // A face stays round: the photo fills the tile, so "here" is an
        // accent ring outside it rather than a fill behind it.
        "redesign:hover:rounded-full",
        selected &&
          "redesign:ring-2 redesign:ring-accent redesign:ring-offset-2 redesign:ring-offset-canvas",
      )}
    >
      <RailPill kind={selected ? "selected" : hasUnread ? "unread" : "none"} />
      <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full">
        <PinnedAvatarStack participants={conversation.participants} />
      </span>
      {badge > 0 && <RailCountBadge count={badge} tone="danger" />}
      {hasUnread && (
        <span className="sr-only">
          {mentions > 0
            ? t("chrome.unreadMentions", { count: mentions })
            : t("chrome.unreadMessagesSr")}
        </span>
      )}
    </button>
  );

  return (
    <Tooltip label={title} side="right" tone="rail" mark>
      <span className="relative inline-flex">
        {items.length > 0 ? (
          <ContextMenu items={items}>{button}</ContextMenu>
        ) : (
          button
        )}
      </span>
    </Tooltip>
  );
}

function PinnedAvatarStack({
  participants,
}: {
  participants: readonly PublicUser[];
}) {
  const shown = participants.slice(0, MAX_PINNED_AVATARS);
  if (shown.length === 0) {
    return (
      <span className="h-full w-full rounded-full bg-ink-4 redesign:bg-surface-3" aria-hidden="true" />
    );
  }
  if (shown.length === 1) {
    const person = shown[0]!;
    return (
      <UserAvatar
        name={person.displayName}
        avatarUrl={person.avatarUrl}
        className="h-full w-full"
        fallbackClassName="bg-ink-4 text-sm text-paper redesign:bg-surface-3 redesign:text-[13px] redesign:font-semibold redesign:text-text"
        rounded="full"
      />
    );
  }
  return (
    <span className="flex h-full w-full flex-wrap items-center justify-center gap-0 p-0.5" aria-hidden="true">
      {shown.map((person) => (
        <UserAvatar
          key={person.id}
          name={person.displayName}
          avatarUrl={person.avatarUrl}
          className="h-5 w-5"
          fallbackClassName="bg-ink-4 text-[8px] text-paper redesign:bg-surface-3 redesign:text-text"
          rounded="full"
        />
      ))}
    </span>
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
        // In text colour under the redesign: the tile is already lime.
        "redesign:bg-text redesign:-left-[14px] redesign:motion-reduce:transition-none",
      )}
    />
  );
}

function RailCountBadge({
  count,
  tone,
  corner = "top",
  dataFriendRequests = false,
  label,
  dataBau = false,
  dataConversations = false,
}: {
  count: number;
  tone: "danger" | "signal";
  corner?: "top" | "bottom";
  dataFriendRequests?: boolean;
  /** Conversas: this count is conversations waiting, not messages. */
  dataConversations?: boolean;
  /** Shown instead of the 99+ capped count (the Baú caps at 9+). */
  label?: string;
  dataBau?: boolean;
}) {
  return (
    // The shared count pill; the rail adds its corner and a ring cut out of
    // the canvas. With the toggle off the classes below are what this badge
    // always drew (11px bold on `signal` or `danger`, ringed in the rail).
    <CountBadge
      count={count}
      tone={tone === "signal" ? "accent" : "danger"}
      pop
      label={label}
      aria-hidden="true"
      {...(dataFriendRequests ? { "data-friend-requests": count } : {})}
      {...(dataBau ? { "data-bau-count": count } : {})}
      {...(dataConversations ? { "data-conversations-waiting": count } : {})}
      className={cn(
        // `normal-nums`: the old pill had proportional figures.
        "absolute right-[-5px] flex text-[11px] font-bold normal-nums ring-[3px] ring-rail",
        corner === "top" ? "top-[-5px]" : "bottom-[-5px]",
        tone === "danger" ? "bg-danger text-paper" : "bg-signal text-ink",
        "redesign:ring-canvas redesign:tabular-nums",
        tone === "danger"
          ? "redesign:bg-danger redesign:text-on-danger"
          : "redesign:bg-accent redesign:text-on-accent",
        corner === "top"
          ? "redesign:top-[-4px] redesign:right-[-4px]"
          : "redesign:bottom-[-4px] redesign:right-[-4px]",
      )}
    />
  );
}

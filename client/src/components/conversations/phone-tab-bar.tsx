import type { DmSummary, UnreadCounts } from "@pqp/shared";
import { LayoutGrid, MessageCircle } from "lucide-react";
import { ChatCircle as ChatCircleFill, SquaresFour as SquaresFourFill } from "@phosphor-icons/react";
import { IconSwap } from "@/components/ui/icon";
import type { ReactNode } from "react";
import { UserAvatar } from "@/components/user/user-avatar";
import { useNotificationState } from "@/hooks/use-notifications";
import { conversationsWithUnread } from "@/lib/conversation-list";
import { resolveNotificationLevel } from "@/lib/notifications";
import { useTranslation } from "@/lib/i18n";
import type { PhoneTab } from "@/lib/phone-tabs";
import { useUpdateOffered } from "@/lib/update-prompt-state";
import { cn } from "@/lib/utils";
import { CountBadge } from "@/components/ui/count-badge";

interface PhoneTabBarProps {
  tab: PhoneTab;
  onSelect: (tab: PhoneTab) => void;
  /** For the Conversas badge: conversations waiting, the rail door's number. */
  conversations: readonly DmSummary[];
  unread: Readonly<Record<string, UnreadCounts>>;
  openConversationId: string | null;
  /** Servers with a mention waiting: what deserves a number on that tab. */
  serversWaiting: number;
  me: { displayName: string; avatarUrl: string | null };
}

/*
 * THE REDESIGN (docs/redesign/LOG.md, `m-shell`): the bar sits on the side
 * pane's colour under the pane rule, its glyphs are Phosphor fill and the
 * counts are the channel row's. Every `redesign:` class goes after what the
 * bar always drew, so the toggle off changes nothing.
 */
/** The counts and the pip on the bar: cut by the bar's own colour. */
const TAB_CUT_REDESIGN = "redesign:ring-pane-side";

/**
 * CONVERSAS ON A PHONE: Conversas / Servidores / Tu, at the thumb. Drawn only
 * by the phone shell (`conversations_home_phone_tabs`, below `md`). A real
 * `tablist`; the active tab wears a pill that slides between the three
 * (transform only, nothing under reduced motion).
 */
export function PhoneTabBar({
  tab,
  onSelect,
  conversations,
  unread,
  openConversationId,
  serversWaiting,
  me,
}: PhoneTabBarProps) {
  const { t } = useTranslation();
  const notifications = useNotificationState();
  // A dot on "tu", where the update indicator lives on a phone. Not a count:
  // an update is not a message.
  const updateOffered = useUpdateOffered();
  const conversationsWaiting = conversationsWithUnread(conversations, unread, {
    openChannelId: openConversationId,
    isMuted: (channelId) =>
      resolveNotificationLevel(notifications, null, channelId) === "none",
  }).length;
  const index = tab === "conversas" ? 0 : tab === "servidores" ? 1 : 2;
  return (
    <nav
      data-phone-tab-bar=""
      aria-label={t("phoneTabs.label")}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface-1 pb-[env(safe-area-inset-bottom)] md:hidden redesign:border-[color:var(--pane-header-rule)] redesign:bg-pane-side"
    >
      <div role="tablist" aria-label={t("phoneTabs.label")} className="relative grid h-16 grid-cols-3">
        {/* The sliding pill behind the active icon. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-2 flex h-8 w-1/3 justify-center transition-transform duration-[var(--duration-base)] ease-[var(--ease-emphasized)] motion-reduce:transition-none"
          style={{ transform: `translateX(${index * 100}%)` }}
        >
          <span className="h-8 w-14 rounded-full bg-accent-soft" />
        </span>
        <TabButton
          id="conversas"
          active={tab === "conversas"}
          label={t("phoneTabs.conversas")}
          badge={conversationsWaiting}
          onSelect={onSelect}
        >
          <IconSwap off={MessageCircle} on={ChatCircleFill} size="lg" offClassName="h-5 w-5" />
        </TabButton>
        <TabButton
          id="servidores"
          active={tab === "servidores"}
          label={t("phoneTabs.servidores")}
          badge={serversWaiting}
          onSelect={onSelect}
        >
          <IconSwap off={LayoutGrid} on={SquaresFourFill} size="lg" offClassName="h-5 w-5" />
        </TabButton>
        <TabButton
          id="tu"
          active={tab === "tu"}
          label={t("phoneTabs.tu")}
          badge={0}
          pip={updateOffered}
          onSelect={onSelect}
        >
          <UserAvatar
            name={me.displayName}
            avatarUrl={me.avatarUrl}
            className="h-6 w-6"
            fallbackClassName="bg-surface-3 text-[10px] font-semibold text-text"
            rounded="full"
          />
        </TabButton>
      </div>
    </nav>
  );
}

function TabButton({
  id,
  active,
  label,
  badge,
  pip = false,
  onSelect,
  children,
}: {
  id: PhoneTab;
  active: boolean;
  label: string;
  badge: number;
  pip?: boolean;
  onSelect: (tab: PhoneTab) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-phone-tab={id}
      onClick={() => onSelect(id)}
      className={cn(
        "relative flex flex-col items-center justify-start gap-1 pt-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring",
        active ? "text-on-accent-soft" : "text-text-tertiary",
        "redesign:gap-1.5 redesign:focus-visible:ring-[color:var(--list-row-ring)]",
        !active && "redesign:text-[color:var(--list-row-icon)]",
      )}
    >
      <span className="relative flex h-6 items-center justify-center">
        {children}
        {pip && badge === 0 && (
          <span
            data-phone-tab-pip=""
            aria-hidden="true"
            className={cn("absolute -right-1.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-accent ring-2 ring-surface-1", TAB_CUT_REDESIGN)}
          />
        )}
        {badge > 0 && (
          <CountBadge
            count={badge}
            pop
            data-phone-tab-badge={badge}
            className={cn(
              "absolute -right-3 -top-1.5 ring-2 ring-surface-1",
              TAB_CUT_REDESIGN,
              // Off the glyph's corner, so the icon keeps its shape.
              "redesign:-right-4 redesign:-top-2",
              "redesign:h-[var(--count-badge-h)] redesign:min-w-[var(--count-badge-h)] redesign:py-0 redesign:text-[length:var(--count-badge-text)] redesign:tabular-nums",
            )}
          />
        )}
      </span>
      <span className={cn("text-[11px] leading-none", active ? "font-semibold text-text" : "font-medium", "redesign:text-xs", !active && "redesign:text-text-secondary")}>
        {label}
      </span>
      {badge > 0 && <span className="sr-only">{t("phoneTabs.waitingSr", { count: badge })}</span>}
    </button>
  );
}

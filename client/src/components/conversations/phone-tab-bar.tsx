import type { DmSummary, UnreadCounts } from "@pqp/shared";
import { LayoutGrid, MessageCircle } from "lucide-react";
import type { ReactNode } from "react";
import { formatBadgeCount } from "@/components/layout/channel-list";
import { UserAvatar } from "@/components/user/user-avatar";
import { useNotificationState } from "@/hooks/use-notifications";
import { conversationsWithUnread } from "@/lib/conversation-list";
import { resolveNotificationLevel } from "@/lib/notifications";
import { useTranslation } from "@/lib/i18n";
import type { PhoneTab } from "@/lib/phone-tabs";
import { cn } from "@/lib/utils";

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
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface-1 pb-[env(safe-area-inset-bottom)] md:hidden"
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
          <MessageCircle className="h-5 w-5" aria-hidden="true" />
        </TabButton>
        <TabButton
          id="servidores"
          active={tab === "servidores"}
          label={t("phoneTabs.servidores")}
          badge={serversWaiting}
          onSelect={onSelect}
        >
          <LayoutGrid className="h-5 w-5" aria-hidden="true" />
        </TabButton>
        <TabButton id="tu" active={tab === "tu"} label={t("phoneTabs.tu")} badge={0} onSelect={onSelect}>
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
  onSelect,
  children,
}: {
  id: PhoneTab;
  active: boolean;
  label: string;
  badge: number;
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
      )}
    >
      <span className="relative flex h-6 items-center justify-center">
        {children}
        {badge > 0 && (
          <span
            key={badge}
            data-phone-tab-badge={badge}
            className="absolute -right-3 -top-1.5 inline-flex h-[18px] min-w-[18px] animate-badge-pop items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold leading-none tabular-nums text-on-danger ring-2 ring-surface-1"
          >
            {formatBadgeCount(badge)}
          </span>
        )}
      </span>
      <span className={cn("text-[11px] leading-none", active ? "font-semibold text-text" : "font-medium")}>
        {label}
      </span>
      {badge > 0 && <span className="sr-only">{t("phoneTabs.waitingSr", { count: badge })}</span>}
    </button>
  );
}

import type { Server } from "@pqp/shared";
import {
  ChevronRight,
  CircleHelp,
  Compass,
  Plus,
  Settings,
  Sparkles,
  UserPen,
} from "lucide-react";
import type { ReactNode } from "react";
import { formatBadgeCount, type UnreadState } from "@/components/layout/channel-list";
import { ServerIcon } from "@/components/layout/server-identity";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The phone shell's two full screens beside Conversas (the list itself is
 * `ConversationHomeList` full width). Both sit above the bottom bar and below
 * every dialog, and both are plain rows: on a phone a list of servers with
 * names reads better than a strip of 48px squares.
 */

const SCREEN =
  "fixed inset-x-0 top-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 flex flex-col bg-surface-1 animate-fade-in md:hidden";

function ScreenHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border pl-4 pr-2 pt-[env(safe-area-inset-top)]">
      <h2 className="truncate font-display text-lg font-semibold text-text">{title}</h2>
      <div className="flex items-center gap-0.5">{actions}</div>
    </div>
  );
}

const ICON_BUTTON =
  "flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] text-text-tertiary hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

export function PhoneServersScreen({
  servers,
  serverUnread,
  liveServerIds,
  onSelectServer,
  onCreateServer,
  onJoinServer,
  onOpenCommunities,
  footer,
}: {
  servers: readonly Server[];
  serverUnread: Record<string, UnreadState>;
  liveServerIds?: ReadonlySet<string>;
  onSelectServer: (serverId: string) => void;
  onCreateServer: () => void;
  onJoinServer: () => void;
  onOpenCommunities?: () => void;
  /** The call bar and the music player, so a call stays in reach on this tab. */
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section data-phone-screen="servidores" aria-label={t("phoneTabs.servidores")} className={SCREEN}>
      <ScreenHeader
        title={t("phoneTabs.servidores")}
        actions={
          <>
            {onOpenCommunities && (
              <button
                type="button"
                className={ICON_BUTTON}
                aria-label={t("communities.title")}
                onClick={onOpenCommunities}
              >
                <Compass className="h-5 w-5" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label={t("empty.createServer")}
              onClick={onCreateServer}
            >
              <Plus className="h-5 w-5" aria-hidden="true" />
            </button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {servers.map((server) => {
          const unread = serverUnread[server.id];
          const mentions = unread?.mentions ?? 0;
          const live = liveServerIds?.has(server.id) ?? false;
          return (
            <button
              key={server.id}
              type="button"
              data-phone-server={server.id}
              onClick={() => onSelectServer(server.id)}
              className="flex min-h-16 w-full items-center gap-3 rounded-[var(--radius-card)] px-2 py-2 text-left hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-3 font-display text-sm font-bold text-text">
                <ServerIcon name={server.name} iconUrl={server.iconUrl} />
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate text-[15px]",
                    (unread?.count ?? 0) > 0 ? "font-semibold text-text" : "font-medium text-text",
                  )}
                >
                  {server.name}
                </span>
                {live && (
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs font-medium text-danger">
                    <span className="h-2 w-2 rounded-full bg-danger motion-safe:animate-pulse" aria-hidden="true" />
                    {t("phoneTabs.live")}
                  </span>
                )}
              </span>
              {mentions > 0 ? (
                <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold leading-none tabular-nums text-on-danger">
                  {formatBadgeCount(mentions)}
                </span>
              ) : (unread?.count ?? 0) > 0 ? (
                <span className="h-2 w-2 rounded-full bg-text" aria-label={t("chrome.unreadMessagesSr")} />
              ) : null}
            </button>
          );
        })}
        <button
          type="button"
          onClick={onJoinServer}
          className="mt-1 flex min-h-16 w-full items-center gap-3 rounded-[var(--radius-card)] px-2 py-2 text-left hover:bg-surface-2/60"
        >
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-dashed border-border-strong text-text-tertiary">
            <Plus className="h-5 w-5" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-medium text-text">{t("phoneTabs.createOrJoin")}</span>
            <span className="block text-xs text-text-tertiary">{t("phoneTabs.createOrJoinBody")}</span>
          </span>
        </button>
      </div>
      {footer && <div className="shrink-0">{footer}</div>}
    </section>
  );
}

export function PhoneYouScreen({
  me,
  whatsNewUnread,
  onOpenProfile,
  onOpenSettings,
  onOpenWhatsNew,
  onOpenHelp,
  footer,
}: {
  me: { displayName: string; avatarUrl: string | null; tag: string | null; handle: string | null };
  whatsNewUnread: boolean;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
  onOpenWhatsNew?: () => void;
  onOpenHelp: () => void;
  /** The user bar (status, mute, deafen) and the call bar, as on desktop. */
  footer: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section data-phone-screen="tu" aria-label={t("phoneTabs.tu")} className={SCREEN}>
      <ScreenHeader title={t("phoneTabs.tu")} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <button
          type="button"
          onClick={onOpenProfile}
          className="flex w-full items-center gap-4 rounded-[var(--radius-card)] text-left"
        >
          <UserAvatar
            name={me.displayName}
            avatarUrl={me.avatarUrl}
            className="h-16 w-16"
            fallbackClassName="bg-accent text-xl text-on-accent"
            rounded="full"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-display text-xl font-semibold text-text">
              {me.displayName}
            </span>
            <span className="block truncate text-sm text-text-tertiary">
              {me.handle ? `@${me.handle}` : (me.tag ?? "")}
            </span>
          </span>
        </button>
        <div className="mt-6 overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface-card">
          <YouRow icon={<UserPen className="h-5 w-5" aria-hidden="true" />} label={t("phoneTabs.editProfile")} onClick={onOpenProfile} />
          <YouRow icon={<Settings className="h-5 w-5" aria-hidden="true" />} label={t("phoneTabs.settings")} onClick={onOpenSettings} />
          {onOpenWhatsNew && (
            <YouRow
              icon={<Sparkles className="h-5 w-5" aria-hidden="true" />}
              label={t("phoneTabs.whatsNew")}
              pip={whatsNewUnread}
              onClick={onOpenWhatsNew}
            />
          )}
          <YouRow icon={<CircleHelp className="h-5 w-5" aria-hidden="true" />} label={t("phoneTabs.help")} onClick={onOpenHelp} />
        </div>
      </div>
      <div className="shrink-0">{footer}</div>
    </section>
  );
}

function YouRow({
  icon,
  label,
  onClick,
  pip = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  pip?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-12 w-full items-center gap-3 border-b border-border px-4 text-left last:border-b-0 hover:bg-surface-2/60"
    >
      <span className="text-text-tertiary">{icon}</span>
      <span className="min-w-0 flex-1 text-[15px] text-text">{label}</span>
      {pip && <span className="h-2 w-2 rounded-full bg-accent" aria-hidden="true" />}
      <ChevronRight className="h-4 w-4 text-text-tertiary" aria-hidden="true" />
    </button>
  );
}

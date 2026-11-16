import { Breu } from "@/components/breu/breu";
import type { Server } from "@pqp/shared";
import { CARD_LIST, CARD_ROW_HOVER, CARD_SURFACE } from "@/components/ui/card";
import {
  ChevronRight,
  CircleHelp,
  Compass,
  Plus,
  Settings,
  UserPen,
} from "lucide-react";
import {
  CaretRight as CaretRightBold,
  Compass as CompassFill,
  GearSix as GearFill,
  PencilSimpleLine as PencilFill,
  Plus as PlusBold,
  Question as QuestionFill,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { IconSwap } from "@/components/ui/icon";
import { PANE_HEADER_ACTION_REDESIGN } from "@/components/ui/pane-header";
import { type UnreadState } from "@/components/layout/channel-list";
import { ServerIcon } from "@/components/layout/server-identity";
import { UpdateIndicator } from "@/components/layout/update-indicator";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { CountBadge } from "@/components/ui/count-badge";

/**
 * The phone shell's two full screens beside Conversas (the list itself is
 * `ConversationHomeList` full width). Both sit above the bottom bar and below
 * every dialog, and both are plain rows: on a phone a list of servers with
 * names reads better than a strip of 48px squares.
 */

const SCREEN =
  "fixed inset-x-0 top-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 flex flex-col bg-surface-1 animate-fade-in md:hidden redesign:bg-pane-side";

function ScreenHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border pl-4 pr-2 pt-[env(safe-area-inset-top)] redesign:border-b-0 redesign:pl-[calc(var(--list-row-px)+0.75rem)] redesign:pr-3">
      {/* The Conversas tab's title, so the three tabs read as one bar. */}
      <h2 className="truncate font-display text-lg font-semibold text-text redesign:text-[length:var(--pane-bar-title-size)] redesign:tracking-[-0.012em] redesign:max-sm:text-xl">{title}</h2>
      <div className="flex items-center gap-0.5">{actions}</div>
    </div>
  );
}

const ICON_BUTTON = cn(
  "flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] text-text-tertiary hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
  PANE_HEADER_ACTION_REDESIGN,
  "redesign:focus-visible:ring-offset-pane-side",
);

/*
 * THE REDESIGN (docs/redesign/LOG.md, `m-shell`): the screens sit on the
 * side pane, their headers lose the rule, a server is a list-row pill with
 * the rail's round tile, and the glyphs are Phosphor. Redesign-only classes
 * after the old ones, so the toggle off changes nothing.
 */
const SERVER_ROW_REDESIGN =
  "redesign:min-h-14 redesign:rounded-[var(--list-row-radius)] redesign:py-1.5 redesign:pl-2 redesign:pr-[var(--list-row-px)] redesign:hover:bg-[color:var(--list-row-hover)] redesign:focus-visible:ring-[color:var(--list-row-ring)]";
/** The rail's server tile: round, on the tile tint. */
const SERVER_TILE_REDESIGN =
  "redesign:h-11 redesign:w-11 redesign:rounded-full redesign:bg-[color:var(--phone-server-tile)] redesign:group-hover:bg-[color:var(--phone-server-tile-hover)]";

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
            <UpdateIndicator variant="row" className="mr-1" />
            {onOpenCommunities && (
              <button
                type="button"
                className={ICON_BUTTON}
                aria-label={t("communities.title")}
                onClick={onOpenCommunities}
              >
                <IconSwap off={Compass} on={CompassFill} kind="symbol" size="md" offClassName="h-5 w-5" />
              </button>
            )}
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label={t("empty.createServer")}
              onClick={onCreateServer}
            >
              <IconSwap off={Plus} on={PlusBold} kind="symbol" size="md" offClassName="h-5 w-5" />
            </button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-2 redesign:px-3 redesign:pt-1">
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
              className={cn("group flex min-h-16 w-full items-center gap-3 rounded-[var(--radius-card)] px-2 py-2 text-left hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring", SERVER_ROW_REDESIGN, "redesign:mb-0.5")}
            >
              <span className={cn("flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-3 font-display text-sm font-bold text-text", SERVER_TILE_REDESIGN)}>
                <ServerIcon name={server.name} iconUrl={server.iconUrl} />
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate text-[15px]",
                    (unread?.count ?? 0) > 0 ? "font-semibold text-text" : "font-medium text-text",
                    (unread?.count ?? 0) === 0 && "redesign:text-[color:var(--list-row-text)]",
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
                <CountBadge
                  count={mentions}
                  className="redesign:h-[var(--count-badge-h)] redesign:min-w-[var(--count-badge-h)] redesign:py-0 redesign:text-[length:var(--count-badge-text)] redesign:tabular-nums"
                />
              ) : (unread?.count ?? 0) > 0 ? (
                // Under the redesign, the channel row's end pip.
                <span className="h-2 w-2 rounded-full bg-text redesign:h-[var(--list-row-pip)] redesign:w-[var(--list-row-pip)] redesign:bg-indicator" aria-label={t("chrome.unreadMessagesSr")} />
              ) : null}
            </button>
          );
        })}
        {servers.length === 0 && (
          // No servers yet: Breu over the one row that does something about it.
          <div className="flex flex-col items-center px-4 pb-2 pt-8 text-center" data-phone-no-servers="">
            <Breu mood="hello" size="md" />
          </div>
        )}
        <button
          type="button"
          onClick={onJoinServer}
          className={cn("mt-1 flex min-h-16 w-full items-center gap-3 rounded-[var(--radius-card)] px-2 py-2 text-left hover:bg-surface-2/60", SERVER_ROW_REDESIGN, "redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-inset")}
        >
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-dashed border-border-strong text-text-tertiary redesign:h-11 redesign:w-11 redesign:rounded-full redesign:border-[color:var(--sidebar-invite-border)] redesign:text-text-secondary">
            <IconSwap off={Plus} on={PlusBold} kind="symbol" size="md" offClassName="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-medium text-text">{t("phoneTabs.createOrJoin")}</span>
            <span className="block text-xs text-text-tertiary redesign:text-[13px] redesign:text-text-secondary">{t("phoneTabs.createOrJoinBody")}</span>
          </span>
        </button>
      </div>
      {footer && <div className="shrink-0">{footer}</div>}
    </section>
  );
}

export function PhoneYouScreen({
  me,
  onOpenProfile,
  onOpenSettings,
  onOpenWhatsNew,
  onOpenHelp,
  footer,
}: {
  me: { displayName: string; avatarUrl: string | null; tag: string | null; handle: string | null };
  onOpenProfile: () => void;
  onOpenSettings: () => void;
  /** The release notes, from the update popover's "see all" link. */
  onOpenWhatsNew?: () => void;
  onOpenHelp: () => void;
  /** The user bar (status, mute, deafen) and the call bar, as on desktop. */
  footer: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section data-phone-screen="tu" aria-label={t("phoneTabs.tu")} className={SCREEN}>
      <ScreenHeader
        title={t("phoneTabs.tu")}
        actions={<UpdateIndicator variant="row" onOpenWhatsNew={onOpenWhatsNew} className="mr-1" />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 redesign:px-3">
        <button
          type="button"
          onClick={onOpenProfile}
          className="flex w-full items-center gap-4 rounded-[var(--radius-card)] text-left redesign:rounded-full redesign:pl-2 redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-offset-4 redesign:focus-visible:ring-offset-pane-side redesign:focus-visible:ring-[color:var(--list-row-ring)]"
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
            <span className="block truncate text-sm text-text-tertiary redesign:text-text-secondary">
              {me.handle ? `@${me.handle}` : (me.tag ?? "")}
            </span>
          </span>
        </button>
        <div className={cn(CARD_SURFACE, CARD_LIST, "mt-6")}>
          <YouRow icon={<IconSwap off={UserPen} on={PencilFill} size="md" offClassName="h-5 w-5" />} label={t("phoneTabs.editProfile")} onClick={onOpenProfile} />
          <YouRow icon={<IconSwap off={Settings} on={GearFill} size="md" offClassName="h-5 w-5" />} label={t("phoneTabs.settings")} onClick={onOpenSettings} />
          <YouRow icon={<IconSwap off={CircleHelp} on={QuestionFill} size="md" offClassName="h-5 w-5" />} label={t("phoneTabs.help")} onClick={onOpenHelp} />
        </div>
      </div>
      <div className="shrink-0 redesign:px-1 redesign:pb-1.5">{footer}</div>
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
      className={cn("flex min-h-12 w-full items-center gap-3 px-4 text-left hover:bg-surface-2/60", CARD_ROW_HOVER, "redesign:min-h-[3.25rem] redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-inset redesign:focus-visible:ring-[color:var(--list-row-ring)]")}
    >
      <span className="text-text-tertiary redesign:text-[color:var(--list-row-icon)]">{icon}</span>
      <span className="min-w-0 flex-1 text-[15px] text-text">{label}</span>
      {pip && <span className="h-2 w-2 rounded-full bg-accent redesign:h-[var(--list-row-pip)] redesign:w-[var(--list-row-pip)]" aria-hidden="true" />}
      <IconSwap off={ChevronRight} on={CaretRightBold} kind="symbol" offClassName="h-4 w-4 text-text-tertiary" className="text-text-tertiary" />
    </button>
  );
}

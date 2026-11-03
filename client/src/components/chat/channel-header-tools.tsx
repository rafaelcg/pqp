import type { ReactNode } from "react";
import { At, Bell, BellSlash, PushPin } from "@phosphor-icons/react";
import type { Channel } from "@pqp/shared";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { Menu } from "@/components/ui/menu";
import {
  notificationLevelItems,
  useChannelNotificationLevel,
} from "@/hooks/use-notifications";
import { pinSignatureOf, usePinnedCount } from "@/hooks/use-pinned-count";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/*
 * Two of the channel header's tools under the redesign (the text channels
 * canvas, "Canal de texto"): "Fixadas N" in words when the channel has pins,
 * and the channel bell. Both render only with the toggle on; App keeps the
 * plain pin tile for the toggle off and for a channel with no pins.
 */

/**
 * "Fixadas" with its count, or `fallback` (the plain tile) while the count
 * is unknown or zero.
 */
export function ChannelPinsButton({
  channelId,
  messages,
  onOpen,
  fallback,
}: {
  channelId: string;
  messages: readonly { id: string; pinnedAt?: string | null; pinnedBy?: unknown }[];
  onOpen: () => void;
  fallback: ReactNode;
}) {
  const { t } = useTranslation();
  const count = usePinnedCount(channelId, pinSignatureOf(messages));
  if (!count) {
    return <>{fallback}</>;
  }
  return (
    <>
    {/* A phone keeps the plain tile: the words take the width the name needs. */}
    <span className="contents sm:hidden">{fallback}</span>
    <button
      type="button"
      data-channel-header-pins=""
      onClick={onOpen}
      aria-label={t("chrome.pinsCount", { count })}
      className="flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-[color:var(--list-row-icon)] hover:bg-[color:var(--list-row-hover)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-pane-main max-sm:hidden"
    >
      <Icon icon={PushPin} size="sm" className="h-[1.125rem] w-[1.125rem]" />
      {t("chrome.pins")}
      <span aria-hidden="true" className="h-[18px] min-w-[18px] rounded-full bg-[color:var(--color-surface-3)] px-[5px] text-center text-[11px] font-bold leading-[18px] tabular-nums text-text">
        {count}
      </span>
    </button>
    </>
  );
}

/** The channel bell: a menu over the existing all, mentions, none levels. */
export function ChannelBellButton({
  channel,
  inherits,
  className,
}: {
  channel: Pick<Channel, "id" | "serverId">;
  /** What "Usar o padrão de …" names: the server. */
  inherits: string | null;
  className: string;
}) {
  const { t } = useTranslation();
  const controls = useChannelNotificationLevel(channel);
  const items: ContextMenuItemDef[] = notificationLevelItems(
    "channel-bell",
    controls,
    inherits,
  )
    .filter((item) => !item.separator || item.id !== "channel-bell-sep")
    .map((item) =>
      item.id === "channel-bell-heading" ? { ...item, heading: true, disabled: undefined } : item,
    );
  const glyph = controls.level === "none" ? BellSlash : controls.level === "mentions" ? At : Bell;
  const label = t("chrome.channelNotifications");
  return (
    // `Tooltip` and `Menu` both want the trigger's ref (see
    // `music-captions-button.tsx`), so the hint is the title.
    <Menu items={items} align="end">
      <button
        type="button"
        aria-label={label}
        title={label}
        data-channel-header-bell={controls.level}
        className={cn(className, controls.overridden && "text-text")}
      >
        <Icon icon={glyph} size="sm" className="h-[1.125rem] w-[1.125rem]" />
      </button>
    </Menu>
  );
}

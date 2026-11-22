import type { ReactNode } from "react";
import {
  At,
  Bell,
  BellSlash,
  DotsThree,
  PushPin,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Pin, type LucideIcon } from "lucide-react";
import type { Channel } from "@pqp/shared";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import { Icon, type IconKind } from "@/components/ui/icon";
import { Menu } from "@/components/ui/menu";
import {
  notificationLevelItems,
  useChannelNotificationLevel,
} from "@/hooks/use-notifications";
import { pinSignatureOf, useKnownPinnedCount, usePinnedCount } from "@/hooks/use-pinned-count";
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
      className="flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-[color:var(--list-row-icon)] hover:bg-[color:var(--list-row-hover)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-pane-main max-sm:hidden"
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

/** One of the folded tools in `ChannelMoreButton`'s menu. */
export interface ChannelMoreAction {
  id: string;
  label: string;
  icon: LucideIcon;
  /** The redesign's twin of `icon` (`ContextMenuItemDef.glyph`). */
  glyph?: PhosphorIcon;
  glyphKind?: IconKind;
  onSelect: () => void;
}

/**
 * The header's tools on a phone-width window, folded into one tile. Beside
 * the title there is room for three tiles (search, this one, the member
 * list); with the pins, the bell and channel settings as tiles of their own
 * the row ran off the right edge and the last two could not be reached.
 * Holds the pins (with their count), the notification levels and whatever
 * else the caller folds (`actions`: channel settings, past broadcasts).
 */
export function ChannelMoreButton({
  channel,
  inherits,
  onOpenPins,
  actions,
  className,
}: {
  channel: Pick<Channel, "id" | "serverId">;
  inherits: string | null;
  onOpenPins: () => void;
  actions: readonly ChannelMoreAction[];
  className: string;
}) {
  const { t } = useTranslation();
  const controls = useChannelNotificationLevel(channel);
  // `ChannelPinsButton` is mounted beside this tile and does the reading.
  const count = useKnownPinnedCount(channel.id);
  const items: ContextMenuItemDef[] = [
    {
      id: "channel-more-pins",
      label: count ? t("chrome.pinsCount", { count }) : t("chrome.pins"),
      icon: Pin,
      glyph: PushPin,
      onSelect: onOpenPins,
    },
    ...actions,
    ...notificationLevelItems("channel-more", controls, inherits).map((item) =>
      item.id === "channel-more-heading" ? { ...item, heading: true, disabled: undefined } : item,
    ),
  ];
  const label = t("chrome.moreActions");
  return (
    <Menu items={items} align="end">
      <button
        type="button"
        aria-label={label}
        title={label}
        data-channel-header-more=""
        className={className}
      >
        <Icon icon={DotsThree} size="sm" kind="symbol" className="h-[1.125rem] w-[1.125rem]" />
      </button>
    </Menu>
  );
}

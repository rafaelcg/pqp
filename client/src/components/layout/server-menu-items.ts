import { LogOut, Radio } from "lucide-react";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import {
  notificationLevelItems,
  serverNotificationControls,
} from "@/hooks/use-notifications";
import type { Translator } from "@/lib/i18n";
import {
  setServerStreamAlerts,
  type NotificationState,
} from "@/lib/notifications";

/**
 * The per-server items the rail's context menu and the channel list's server
 * header menu both carry, so the two cannot drift: a person who joined a
 * community must find "Sair da comunidade" and the notification levels in
 * either place.
 */

/** `flag` is the operator's switch, `default` what this server gives a member. */
export type StreamAlertInfo = { flag: boolean; default: boolean };

/** Notification levels, then the stream-alerts tick where an operator turned it on. */
export function serverNotificationMenuItems(
  serverId: string,
  notifications: NotificationState,
  streamAlerts: StreamAlertInfo | undefined,
  t: Translator["t"],
): ContextMenuItemDef[] {
  const items = notificationLevelItems(
    "notify",
    serverNotificationControls(serverId, notifications),
    "account",
  );
  if (streamAlerts?.flag) {
    // Only where an operator turned `stream_start_notifications` on. The
    // tick is what this person gets: their own choice, else the server's
    // default (on for a small server, off for a large one).
    const alertsOn = notifications.streamAlerts[serverId] ?? streamAlerts.default;
    items.push({
      id: "stream-alerts",
      label: t("notify.menu.streamAlerts"),
      icon: Radio,
      checked: alertsOn,
      onSelect: () => setServerStreamAlerts(serverId, !alertsOn),
    });
  }
  return items;
}

/** The danger item, last. An owner cannot leave their own community. */
export function leaveCommunityMenuItems(
  isOwner: boolean,
  onLeave: (() => void) | undefined,
  t: Translator["t"],
): ContextMenuItemDef[] {
  if (isOwner || !onLeave) {
    return [];
  }
  return [
    { id: "sep", label: "", separator: true },
    {
      id: "leave",
      label: t("chrome.leaveCommunity"),
      icon: LogOut,
      danger: true,
      onSelect: onLeave,
    },
  ];
}

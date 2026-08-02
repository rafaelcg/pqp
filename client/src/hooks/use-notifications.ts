import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import type { Channel } from "@pqp/shared";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import { getDesktop } from "@/lib/desktop";
import {
  getNotificationState,
  hasNotificationOverride,
  lookupChannel,
  notificationPermission,
  rememberChannels,
  requestNotificationPermission,
  resetNotificationBursts,
  resolveNotificationLevel,
  setChannelNotificationLevel,
  setDefaultNotificationLevel,
  setDesktopNotificationsEnabled,
  setNotificationNavigator,
  setServerNotificationLevel,
  setUnreadBadge,
  subscribeNotifications,
  type NotificationLevel,
  type NotificationPermissionState,
  type NotificationState,
} from "@/lib/notifications";

/** Structural on purpose, so this hook does not depend on the channel list. */
interface UnreadCounts {
  count: number;
  mentions: number;
}

export function useNotificationState(): NotificationState {
  return useSyncExternalStore(
    subscribeNotifications,
    getNotificationState,
    getNotificationState,
  );
}

export interface NotificationLevelControls {
  level: NotificationLevel;
  /** True when this id names its own level rather than inheriting one. */
  overridden: boolean;
  setLevel: (level: NotificationLevel | null) => void;
}

/**
 * Levels for one server icon. A plain function taking the already-subscribed
 * state, because the rail resolves them inside a `map` over its servers.
 */
export function serverNotificationControls(
  serverId: string,
  state: NotificationState,
): NotificationLevelControls {
  return {
    level: resolveNotificationLevel(state, serverId, null),
    overridden: hasNotificationOverride(state, "server", serverId),
    setLevel: (level) => setServerNotificationLevel(serverId, level),
  };
}

/** Levels for one channel row, which inherits from the server it belongs to. */
export function useChannelNotificationLevel(
  channel: Pick<Channel, "id" | "serverId">,
): NotificationLevelControls {
  const state = useNotificationState();
  return {
    level: resolveNotificationLevel(state, channel.serverId, channel.id),
    overridden: hasNotificationOverride(state, "channel", channel.id),
    setLevel: (level) => setChannelNotificationLevel(channel.id, level),
  };
}

const LEVEL_LABELS: { level: NotificationLevel; label: string }[] = [
  { level: "all", label: "All messages" },
  { level: "mentions", label: "Only @mentions" },
  { level: "none", label: "Nothing" },
];

/**
 * The notification block shared by the channel and server context menus.
 *
 * The menu primitive has no checked state, so the active level is marked in the
 * label. `inherits` names what "Reset" would fall back to, which is the only
 * way to tell a channel explicitly set to "All" from one that merely follows a
 * server that is.
 */
export function notificationLevelItems(
  prefix: string,
  { level, overridden, setLevel }: NotificationLevelControls,
  inherits: string | null,
): ContextMenuItemDef[] {
  const items: ContextMenuItemDef[] = [
    { id: `${prefix}-sep`, label: "", separator: true },
    { id: `${prefix}-heading`, label: "Notifications", disabled: true },
    ...LEVEL_LABELS.map(({ level: value, label }) => ({
      id: `${prefix}-${value}`,
      label: value === level ? `${label} ✓` : label,
      onSelect: () => setLevel(value),
    })),
  ];
  if (overridden && inherits) {
    items.push({
      id: `${prefix}-reset`,
      label: `Use ${inherits} default`,
      onSelect: () => setLevel(null),
    });
  }
  return items;
}

export interface NotificationSettings {
  state: NotificationState;
  permission: NotificationPermissionState;
  /** Requests the browser permission — only ever call this from a click. */
  enable: () => Promise<void>;
  disable: () => void;
  setDefaultLevel: (level: NotificationLevel) => void;
}

/**
 * The settings-panel view: the account-wide default plus the opt-in that has to
 * originate from a user gesture.
 */
export function useNotificationSettings(): NotificationSettings {
  const state = useNotificationState();
  const [permission, setPermission] = useState<NotificationPermissionState>(() =>
    notificationPermission(),
  );

  const enable = useCallback(async () => {
    const result = await requestNotificationPermission();
    setPermission(result);
    // A denial is final from the page's side, so recording an opt-in the
    // browser will never honour would only produce a settings screen that
    // claims notifications are on while none arrive.
    setDesktopNotificationsEnabled(result === "granted");
  }, []);

  const disable = useCallback(() => {
    setDesktopNotificationsEnabled(false);
  }, []);

  return {
    state,
    permission,
    enable,
    disable,
    setDefaultLevel: setDefaultNotificationLevel,
  };
}

export interface ChannelNotificationsInput {
  /**
   * Everything with a channel id worth naming — the open server's channels and
   * every conversation. Structural rather than `Channel[]` so a conversation,
   * whose label is derived from its participants rather than stored, can be
   * described without first being dressed up as a channel row.
   */
  channels: readonly {
    id: string;
    serverId: string | null;
    name: string;
    kind?: Channel["kind"];
  }[];
  unread: Readonly<Record<string, UnreadCounts>>;
}

/**
 * Keeps the notification directory current, routes notification clicks, and
 * drives the dock badge off the unread map.
 *
 * Lives in the app shell rather than in a sidebar. It used to be called from
 * the channel list, which unmounts whenever that list is replaced — by the
 * conversation view, for instance — taking the badge and the click handler with
 * it. Anything mounted for the whole session works; anything else is a badge
 * that disappears when you change what you are looking at.
 *
 * Deliberately *not* where notifications fire. Diffing the unread map looks
 * equivalent and is not: the map also fills in bulk from `loadUnread` the first
 * time a server is opened, so every channel with a backlog would read as a
 * positive delta and buzz. Firing happens on the live `channel-activity` frame
 * in `App.tsx`, which is unambiguously one new message.
 */
export function useChannelNotifications({
  channels,
  unread,
}: ChannelNotificationsInput): void {
  const navigate = useNavigate();
  const state = useNotificationState();

  useEffect(() => {
    rememberChannels(channels);
  }, [channels]);

  useEffect(() => {
    const release = setNotificationNavigator(navigate);
    // In the desktop shell the click is handled by the main process, which
    // raises the window first and then tells the renderer where to go.
    const unsubscribe = getDesktop()?.onNotificationClick?.((appPath) => {
      navigate(appPath);
    });
    return () => {
      release();
      unsubscribe?.();
    };
  }, [navigate]);

  useEffect(() => resetNotificationBursts, []);

  useEffect(() => {
    let total = 0;
    for (const [channelId, counts] of Object.entries(unread)) {
      const known = lookupChannel(channelId);
      // A muted channel is muted everywhere, including the dock.
      if (resolveNotificationLevel(state, known?.serverId ?? null, channelId) === "none") {
        continue;
      }
      total += counts.mentions;
    }
    setUnreadBadge(total);
  }, [state, unread]);

  useEffect(() => () => setUnreadBadge(0), []);
}

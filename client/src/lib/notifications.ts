/**
 * Desktop notifications, the levels that gate them, and the unread badge.
 *
 * A module-level store rather than React state, for the same reason the theme
 * is one: the channel list, the server rail and the settings modal all read
 * these levels, and turning a channel down in one has to reach the others in
 * the same render.
 *
 * Levels ride in `user_preferences`, so muting #general follows the user to
 * their next device instead of being relearned per browser. localStorage stays
 * the fast path — the first activity frame can arrive before `/api/me` does.
 */

import type {
  ChannelKind,
  NotificationLevel,
  NotificationPreferences,
} from "@pqp/shared";
import { channelRoutePath, conversationRoutePath } from "@/lib/app-route";
import { getDesktop, isDesktopApp } from "@/lib/desktop";
import { shouldShowArrivalToast } from "@/lib/dm-toast-queue";
import {
  isDesktopNotifyDefaultOnEnabled,
  onNotifyDefaultsChange,
} from "@/lib/notify-defaults-config";
import { translateMessage } from "@/lib/i18n";
import { queuePreferenceSync } from "@/lib/preferences";
import { getSoundState, playActivitySound, playCue } from "@/lib/sounds";

export type { NotificationLevel };

export const NOTIFICATION_STORAGE_KEY = "pqp-notifications";

/**
 * Long enough that a fast conversation in one channel is one interruption
 * rather than twenty, short enough that a reply half a minute later still
 * reaches someone who walked away.
 */
const RENOTIFY_QUIET_MS = 10_000;

/** Past this the exact number stops being information and starts being noise. */
const BADGE_CAP = 99;

const LEVELS: readonly NotificationLevel[] = ["all", "mentions", "none"];

export interface NotificationState {
  /**
   * The user's own opt-in, tracked apart from the browser permission: a
   * permission can be revoked in site settings without an event, and it can
   * only be asked for again from a real click.
   */
  desktop: boolean;
  /**
   * The person has touched the banner switch at least once. `desktop` alone
   * cannot say: every save writes every field, so `desktop: false` is mostly
   * "never asked". With `desktop_notify_default_on` the desktop app reads the
   * switch as ON until this is true (`desktopBannersEnabled`).
   */
  desktopChosen: boolean;
  /**
   * Applies wherever neither the channel nor its server says otherwise. Kept
   * for every client that predates the split below, and it keeps meaning both
   * until a person sets either of the two that follow.
   */
  default: NotificationLevel;
  /** DMs and group conversations. Null: follow `default`. */
  dmDefault: NotificationLevel | null;
  /**
   * Server channels. Null: follow `default` when it was a choice, else
   * "mentions" (with `desktop_notify_default_on`; see `resolveNotificationLevel`).
   */
  serverDefault: NotificationLevel | null;
  servers: Record<string, NotificationLevel>;
  channels: Record<string, NotificationLevel>;
  /** The MSN-style arrival card for a conversation message. Default true. */
  arrivalToast: boolean;
  /**
   * Whether the sidebar preview line and the toast's second line may show
   * message content. Default true. Off, both fall back to a count.
   */
  previewInApp: boolean;
  /**
   * Per server: tell me when somebody starts a stream there. Absent means the
   * server's default (on for a small server, off for a large one or a
   * community), which only the server can say, so this map holds explicit
   * choices only. Honoured only while `stream_start_notifications` is on for
   * the server. `docs/plans/WATCH_NOW.md` section 3.
   */
  streamAlerts: Record<string, boolean>;
}

export type NotificationPermissionState =
  | "unsupported"
  | "default"
  | "granted"
  | "denied";

const DEFAULT_STATE: NotificationState = {
  desktop: false,
  desktopChosen: false,
  default: "all",
  dmDefault: null,
  serverDefault: null,
  servers: {},
  channels: {},
  arrivalToast: true,
  previewInApp: true,
  streamAlerts: {},
};

function isLevel(value: unknown): value is NotificationLevel {
  return LEVELS.includes(value as NotificationLevel);
}

function readLevelMap(value: unknown): Record<string, NotificationLevel> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const map: Record<string, NotificationLevel> = {};
  for (const [key, level] of Object.entries(value)) {
    if (isLevel(level)) {
      map[key] = level;
    }
  }
  return map;
}

function readBooleanMap(value: unknown): Record<string, boolean> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const map: Record<string, boolean> = {};
  for (const [key, choice] of Object.entries(value)) {
    if (typeof choice === "boolean") {
      map[key] = choice;
    }
  }
  return map;
}

function fromPreferences(
  preferences: NotificationPreferences,
  base: NotificationState,
): NotificationState {
  return {
    desktop: preferences.desktop ?? base.desktop,
    desktopChosen: preferences.desktopChosen ?? base.desktopChosen,
    default: preferences.default ?? base.default,
    dmDefault: preferences.dmDefault ?? base.dmDefault,
    serverDefault: preferences.serverDefault ?? base.serverDefault,
    servers: readLevelMap(preferences.servers),
    channels: readLevelMap(preferences.channels),
    arrivalToast: preferences.arrivalToast ?? base.arrivalToast,
    previewInApp: preferences.previewInApp ?? base.previewInApp,
    streamAlerts: preferences.streamAlerts
      ? readBooleanMap(preferences.streamAlerts)
      : base.streamAlerts,
  };
}

/**
 * Every field, every time. The preference store merges one level deep, so a
 * partial `notifications` object would replace the stored one and take the
 * levels it omitted with it.
 */
function toPreferences(current: NotificationState): NotificationPreferences {
  return {
    desktop: current.desktop,
    desktopChosen: current.desktopChosen,
    default: current.default,
    // Only a choice is written: an absent key is how the server (and every
    // other device) tells "never set" from "set to all".
    ...(current.dmDefault ? { dmDefault: current.dmDefault } : {}),
    ...(current.serverDefault ? { serverDefault: current.serverDefault } : {}),
    servers: current.servers,
    channels: current.channels,
    arrivalToast: current.arrivalToast,
    previewInApp: current.previewInApp,
    streamAlerts: current.streamAlerts,
  };
}

function readStored(): NotificationState {
  try {
    const raw = localStorage.getItem(NOTIFICATION_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_STATE;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return DEFAULT_STATE;
    }
    const record = parsed as Record<string, unknown>;
    return {
      desktop: record.desktop === true,
      desktopChosen: record.desktopChosen === true,
      default: isLevel(record.default) ? record.default : DEFAULT_STATE.default,
      dmDefault: isLevel(record.dmDefault) ? record.dmDefault : null,
      serverDefault: isLevel(record.serverDefault) ? record.serverDefault : null,
      servers: readLevelMap(record.servers),
      channels: readLevelMap(record.channels),
      arrivalToast: record.arrivalToast !== false,
      previewInApp: record.previewInApp !== false,
      streamAlerts: readBooleanMap(record.streamAlerts),
    };
  } catch {
    // Safari private mode throws on storage access; treat it as "no choices yet".
    return DEFAULT_STATE;
  }
}

function store(state: NotificationState): void {
  try {
    localStorage.setItem(NOTIFICATION_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Persistence is a convenience — this session still behaves correctly.
  }
}

const listeners = new Set<() => void>();
let state: NotificationState =
  typeof localStorage === "undefined" ? DEFAULT_STATE : readStored();

export function getNotificationState(): NotificationState {
  return state;
}

export function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(next: NotificationState, { sync }: { sync: boolean }): void {
  state = next;
  store(next);
  if (sync) {
    // Discrete choices, not a drag: waiting out the debounce means a reload a
    // moment later reads the previous server value and silently undoes them.
    queuePreferenceSync({ notifications: toPreferences(next) }, { immediate: true });
  }
  for (const listener of listeners) {
    listener();
  }
}

// A flip of `desktop_notify_default_on` changes what every level resolves to
// without changing a byte of the stored state, so the readers (rail, channel
// menus, settings) would keep drawing the old answer. A new identity and a
// notification of the listeners is what makes them read it again.
onNotifyDefaultsChange(() => {
  state = { ...state };
  for (const listener of listeners) {
    listener();
  }
});

/** Set or, with `null`, fall back to whatever this server would have inherited. */
function withLevel(
  map: Record<string, NotificationLevel>,
  id: string,
  level: NotificationLevel | null,
): Record<string, NotificationLevel> {
  const next = { ...map };
  if (level === null) {
    delete next[id];
  } else {
    next[id] = level;
  }
  return next;
}

export function setDefaultNotificationLevel(level: NotificationLevel): void {
  commit({ ...state, default: level }, { sync: true });
}

/** Direct messages and group conversations. */
export function setDmDefaultNotificationLevel(level: NotificationLevel): void {
  commit({ ...state, dmDefault: level }, { sync: true });
}

/** Server channels. */
export function setServerDefaultNotificationLevel(level: NotificationLevel): void {
  commit({ ...state, serverDefault: level }, { sync: true });
}

export function setServerNotificationLevel(
  serverId: string,
  level: NotificationLevel | null,
): void {
  commit({ ...state, servers: withLevel(state.servers, serverId, level) }, { sync: true });
}

export function setChannelNotificationLevel(
  channelId: string,
  level: NotificationLevel | null,
): void {
  commit({ ...state, channels: withLevel(state.channels, channelId, level) }, { sync: true });
}

export function setDesktopNotificationsEnabled(enabled: boolean): void {
  // Any press on the switch is a choice, including the one that turns it off:
  // that is what stops the desktop app's "on until you say" from coming back.
  commit({ ...state, desktop: enabled, desktopChosen: true }, { sync: true });
}

export function setArrivalToastEnabled(enabled: boolean): void {
  commit({ ...state, arrivalToast: enabled }, { sync: true });
}

export function setPreviewInAppEnabled(enabled: boolean): void {
  commit({ ...state, previewInApp: enabled }, { sync: true });
}

/** Set one server's choice, or with `null` fall back to the server's default. */
export function setServerStreamAlerts(
  serverId: string,
  enabled: boolean | null,
): void {
  const next = { ...state.streamAlerts };
  if (enabled === null) {
    delete next[serverId];
  } else {
    next[serverId] = enabled;
  }
  commit({ ...state, streamAlerts: next }, { sync: true });
}

/**
 * Take the levels the account already carries, as returned by `/api/me`.
 *
 * Deliberately does not sync back: the values came from the server, so writing
 * them again would at best be a no-op and at worst let a tab open since
 * yesterday overwrite a channel muted on another device since.
 */
export function adoptNotificationPreferences(
  preferences: NotificationPreferences | undefined,
): void {
  if (!preferences) {
    return;
  }
  commit(fromPreferences(preferences, state), { sync: false });
}

/**
 * The level that actually applies. Most specific wins: the channel names it,
 * else the server it belongs to, else the account default.
 *
 * With `desktop_notify_default_on` the account default is two: one for
 * conversations and one for servers. The migration is on read, nothing is
 * rewritten:
 *
 * - a conversation: `dmDefault`, else `default` (which is "all" until chosen);
 * - a server channel: `serverDefault`, else `default` WHEN IT WAS A CHOICE,
 *   else "mentions". A stored `default: "all"` does not count as one: every
 *   save writes every field, so it cannot be told from the initial value, and
 *   treating it as a choice would turn every message in every server into a
 *   banner the day the desktop app starts showing them.
 *
 * Flag off, it is `default` for both, exactly as before.
 */
export function resolveNotificationLevel(
  current: NotificationState,
  serverId: string | null,
  channelId: string | null,
): NotificationLevel {
  return resolveLevel(current, serverId, channelId, "mentions");
}

function resolveLevel(
  current: NotificationState,
  serverId: string | null,
  channelId: string | null,
  /** What a server channel reads when nobody chose anything. */
  impliedServerLevel: NotificationLevel,
): NotificationLevel {
  if (channelId) {
    const channel = current.channels[channelId];
    if (channel) {
      return channel;
    }
  }
  if (serverId) {
    const server = current.servers[serverId];
    if (server) {
      return server;
    }
  }
  if (!isDesktopNotifyDefaultOnEnabled()) {
    return current.default;
  }
  if (isConversationChannel(serverId, channelId)) {
    return dmDefaultLevel(current);
  }
  return serverDefaultLevel(current, impliedServerLevel);
}

/** The account-wide level for conversations, as the settings screen shows it. */
export function dmDefaultLevel(current: NotificationState): NotificationLevel {
  return current.dmDefault ?? current.default;
}

/** The account-wide level for server channels, as the settings screen shows it. */
export function serverDefaultLevel(
  current: NotificationState,
  implied: NotificationLevel = "mentions",
): NotificationLevel {
  return (
    current.serverDefault ??
    (current.default === "all" ? null : current.default) ??
    implied
  );
}

/** A conversation belongs to no server; the directory says which kind it is. */
function isConversationChannel(
  serverId: string | null,
  channelId: string | null,
): boolean {
  if (serverId !== null || channelId === null) {
    return false;
  }
  return (directory.get(channelId)?.kind ?? "server") !== "server";
}

/** Whether an id carries a level of its own, i.e. shows "Reset" in its menu. */
export function hasNotificationOverride(
  current: NotificationState,
  scope: "server" | "channel",
  id: string,
): boolean {
  return (scope === "server" ? current.servers : current.channels)[id] !== undefined;
}

// ------------------------------------------------------------- channel names

/**
 * Channel id → where it lives, so a notification for a server the user is not
 * currently looking at can still be titled and levelled. `channels` in app
 * state only ever holds the selected server's, and the activity frame carries
 * ids rather than names.
 *
 * Conversations go in the same directory rather than a second one. They are
 * channels, they raise the same activity frames, and the whole notification
 * path — levels, bursts, the dock badge — is keyed by channel id already; a
 * parallel directory would be a second place for a mute to be forgotten.
 */
export interface ChannelDirectoryEntry {
  /** Null for a conversation, which belongs to no server. */
  serverId: string | null;
  /**
   * For a conversation this is the derived participant label, not a stored
   * name — the caller resolves it, because a conversation has none.
   *
   * Null for a channel placed by `rememberActivityChannel`: an activity frame
   * carries ids and no names, so where it came from is known before what it is
   * called is.
   */
  name: string | null;
  kind: ChannelKind;
}

const directory = new Map<string, ChannelDirectoryEntry>();

export function rememberChannels(
  channels: readonly {
    id: string;
    serverId: string | null;
    name: string;
    kind?: ChannelKind;
  }[],
): void {
  for (const channel of channels) {
    directory.set(channel.id, {
      serverId: channel.serverId,
      name: channel.name,
      // An API that predates conversations sends no kind, and everything it can
      // send is a server channel.
      kind: channel.kind ?? "server",
    });
  }
}

/**
 * Place a channel from the activity frame itself.
 *
 * `rememberChannels` is fed the SELECTED server's channel list and nothing
 * else, so on its own the directory can only ever place channels of the one
 * server on screen. Every frame from any other server, and every frame from a
 * thread — which appears in no channel list at all — arrived at a directory
 * that had never heard of it, and `describeActivity` degraded the whole record
 * to nulls: no server id, so `resolveNotificationLevel` skipped that server's
 * own level and fell through to the account default; no server name, so the
 * banner read "New activity" with nothing to say where it came from; no route,
 * so clicking it landed on /app. A muted server kept interrupting, and every
 * interruption was unattributable.
 *
 * The frame has been carrying `serverId` and `kind` the whole time. This is
 * where they stop being discarded.
 *
 * Never overwrites an entry that already has a name: a real channel list is a
 * better answer than a frame, and the frame adds nothing the list did not
 * already say.
 */
export function rememberActivityChannel(
  channelId: string,
  serverId: string | null,
  kind: ChannelKind = "server",
): void {
  const known = directory.get(channelId);
  if (known?.name != null) {
    return;
  }
  directory.set(channelId, { serverId, name: known?.name ?? null, kind });
}

/**
 * Unread totals per server, for the rail.
 *
 * Built from the directory rather than from a channel list, because the rail's
 * problem is precisely the servers whose channel lists have not been fetched:
 * summing `channels` could only ever light the icon already selected, which
 * left a banner about any other server with no counterpart on screen. A channel
 * the directory cannot place is skipped rather than guessed at, and a
 * conversation (`serverId: null`) belongs to no icon at all.
 *
 * `placedBy` wins over the directory where it answers. The directory is filled
 * from an effect, so on the first render after the selected server changes it
 * is one render behind the `channels` array the caller already holds; passing
 * that array's own answer in means the badge never has to flicker through a
 * render where the app knew perfectly well which server the channel was in.
 */
export function unreadByServer(
  unread: Readonly<Record<string, { count: number; mentions: number }>>,
  placedBy?: ReadonlyMap<string, string | null>,
): Record<string, { count: number; mentions: number }> {
  const totals: Record<string, { count: number; mentions: number }> = {};
  for (const [channelId, counts] of Object.entries(unread)) {
    const serverId = placedBy?.has(channelId)
      ? placedBy.get(channelId)
      : directory.get(channelId)?.serverId;
    if (!serverId) {
      continue;
    }
    const running = totals[serverId] ?? { count: 0, mentions: 0 };
    totals[serverId] = {
      count: running.count + counts.count,
      mentions: running.mentions + counts.mentions,
    };
  }
  return totals;
}

export function lookupChannel(
  channelId: string,
): ChannelDirectoryEntry | undefined {
  return directory.get(channelId);
}

/**
 * Where clicking a notification should land.
 *
 * Reads the kind from the directory rather than from the activity record: which
 * URL shape a channel has is a fact about the channel, and inferring it from a
 * missing server id would send every not-yet-known channel to the conversation
 * list — a place it is definitely not.
 */
export function activityRoutePath(
  channelId: string,
  serverId: string | null,
): string {
  const known = directory.get(channelId);
  if (known && known.kind !== "server") {
    return conversationRoutePath(channelId);
  }
  return serverId ? channelRoutePath(serverId, channelId) : "/app";
}

/**
 * Server names, so a notification from a server the user is not currently
 * looking at can still say which one it came from — which is most of what makes
 * it actionable when three servers are busy at once.
 */
const serverDirectory = new Map<string, string>();

export function rememberServers(
  servers: readonly { id: string; name: string }[],
): void {
  for (const server of servers) {
    serverDirectory.set(server.id, server.name);
  }
}

/**
 * Build the activity record for one live frame. Naming lives here rather than
 * at the call site because the frame carries only ids, and both directories are
 * already in this module.
 */
export function describeActivity(
  channelId: string,
  counts: { count: number; mentions: number },
  /** The live frame's own redacted preview, when it carried one. */
  preview?: { preview?: string; authorName?: string; authorId?: string },
): ChannelActivity {
  const known = directory.get(channelId);
  return {
    channelId,
    serverId: known?.serverId ?? null,
    channelName: known?.name ?? null,
    // A conversation has no server, so nothing to name it after — the title
    // falls back to the participants, which is all a conversation ever has.
    serverName: known?.serverId
      ? (serverDirectory.get(known.serverId) ?? null)
      : null,
    count: counts.count,
    mentions: counts.mentions,
    kind: known?.kind ?? "server",
    preview: preview?.preview,
    authorName: preview?.authorName,
    authorId: preview?.authorId,
  };
}

// --------------------------------------------------------------- permissions

/**
 * Whether OS banners are on for this device.
 *
 * The person's own switch (`desktop`), except in the desktop app with
 * `desktop_notify_default_on`, where it reads ON until they have touched it:
 * the shell already grants the permission (`electron/main.js`), so a switch
 * that starts off there only hides a feature that works. A banner still needs
 * a granted permission and every level, mute and Do Not Disturb rule on top.
 */
export function desktopBannersEnabled(
  current: NotificationState = state,
): boolean {
  if (current.desktop) {
    return true;
  }
  return (
    isDesktopNotifyDefaultOnEnabled() &&
    !current.desktopChosen &&
    isDesktopApp()
  );
}

export function notificationPermission(): NotificationPermissionState {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

/**
 * Ask the browser. Call this only from a click: an unprompted request is what
 * Chrome's abusive-permission heuristics punish, and a denial is permanent
 * from the page's side.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (notificationPermission() === "unsupported") {
    return "unsupported";
  }
  try {
    // Older WebKit resolves nothing and reports through the callback form, so
    // the live value is the answer rather than what this returned.
    await Notification.requestPermission();
  } catch {
    // Treated as "still undecided" — `Notification.permission` says which.
  }
  return notificationPermission();
}

// -------------------------------------------------------------- notification

export interface ChannelActivity {
  channelId: string;
  /** Null for a channel this session has never had in view. */
  serverId: string | null;
  channelName: string | null;
  serverName: string | null;
  /** Messages that arrived since this channel was last counted. */
  count: number;
  /** How many of them named the reader. */
  mentions: number;
  /** Server channel, 1:1 or group conversation. Absent means server. */
  kind?: ChannelKind;
  /**
   * The redacted message preview, conversation-only. Absent for a server
   * channel, an attachment/GIF-only message, or previews turned off — see
   * `channelActivitySchema` in `packages/shared/src/chat.ts`.
   */
  preview?: string;
  authorName?: string;
  authorId?: string;
}

/**
 * An in-app card for a conversation message that arrived while this tab was
 * visible but looking elsewhere. Server channels never toast: their badge is
 * the signal, and a busy hall would bury the screen. Conversations are
 * addressed to you, which is the difference.
 */
export interface ActivityToast {
  channelId: string;
  kind: ChannelKind;
  count: number;
  mentions: number;
  preview?: string;
  authorName?: string;
}

const toastListeners = new Set<(toast: ActivityToast) => void>();

export function onActivityToast(
  listener: (toast: ActivityToast) => void,
): () => void {
  toastListeners.add(listener);
  return () => {
    toastListeners.delete(listener);
  };
}

// ---------------------------------------------------------------- the offer

/**
 * "Ativar notificações", the browser's one-time card.
 *
 * Banners are opt-in behind a switch in Settings that almost nobody finds
 * (19 of 7,012 accounts), and a browser may not ask for the permission
 * unprompted. The moment it is worth asking is the one where it would have
 * mattered: a DM or a mention arrived while the tab was hidden and nothing told
 * the person. This only records that moment; `NotifyOfferHint` draws the card
 * when they come back, and the click on it is the gesture the permission needs.
 */
export interface NotifyOfferInput {
  flagOn: boolean;
  /** The desktop app already has banners and a granted permission. */
  inDesktopApp: boolean;
  bannersOn: boolean;
  permission: NotificationPermissionState;
  documentVisible: boolean;
  kind: ChannelKind;
  mentions: number;
}

/** Pure so the rule can be read, and tested, on its own. */
export function shouldQueueNotifyOffer(input: NotifyOfferInput): boolean {
  if (!input.flagOn || input.inDesktopApp || input.bannersOn) {
    return false;
  }
  // "default" only: granted without the switch is a Settings state to fix there,
  // and denied is final from the page's side, so a card would be a dead button.
  if (input.permission !== "default") {
    return false;
  }
  if (input.documentVisible) {
    return false;
  }
  const addressedToYou = input.kind !== "server" || input.mentions > 0;
  return addressedToYou;
}

let notifyOfferPending = false;

export function getNotifyOfferPending(): boolean {
  return notifyOfferPending;
}

export function dismissNotifyOffer(): void {
  if (!notifyOfferPending) {
    return;
  }
  notifyOfferPending = false;
  for (const listener of listeners) {
    listener();
  }
}

function noteNotifyOffer(activity: ChannelActivity, documentVisible: boolean): void {
  if (notifyOfferPending) {
    return;
  }
  if (
    !shouldQueueNotifyOffer({
      flagOn: isDesktopNotifyDefaultOnEnabled(),
      inDesktopApp: isDesktopApp(),
      bannersOn: desktopBannersEnabled(),
      permission: notificationPermission(),
      documentVisible,
      kind: activity.kind ?? "server",
      mentions: activity.mentions,
    })
  ) {
    return;
  }
  notifyOfferPending = true;
  for (const listener of listeners) {
    listener();
  }
}

export interface NotificationDecision {
  level: NotificationLevel;
  mention: boolean;
  channelId: string;
  selectedChannelId: string | null;
  documentVisible: boolean;
  /**
   * `document.hasFocus()`. Optional and defaults to `true`, which keeps every
   * caller that predates this field on its old behaviour (visible + selected
   * was already enough to suppress).
   */
  windowFocused?: boolean;
}

/**
 * Whether an interruption is warranted, independent of permissions and rate
 * limiting so it can be reasoned about — and tested — on its own.
 */
export function shouldNotify({
  level,
  mention,
  channelId,
  selectedChannelId,
  documentVisible,
  windowFocused = true,
}: NotificationDecision): boolean {
  // Genuinely on screen in front of them: visible AND focused AND selected.
  // A visible-but-blurred window on the very conversation still gets a
  // notification (an OS banner, never a toast — see `shouldShowArrivalToast`)
  // because "the tab is not minimised" is not "somebody is looking at it".
  if (documentVisible && windowFocused && selectedChannelId === channelId) {
    return false;
  }
  if (level === "none") {
    return false;
  }
  return level !== "mentions" || mention;
}

interface Burst {
  count: number;
  mentions: number;
  lastFiredAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  activity: ChannelActivity;
  /**
   * Whether the in-app toast showed for any message folded into this burst.
   * `documentVisible && windowFocused` is the toast's exclusive territory
   * (§3.6/§4.2 of the spec) — when it fired, the OS banner must not also.
   */
  toastShownForBurst: boolean;
}

const bursts = new Map<string, Burst>();

let routeTo: ((path: string) => void) | null = null;

/**
 * Hand the store the app's router. Clicking a notification has to land on the
 * channel without reloading the SPA, and this module exists long before any
 * component that knows how to navigate.
 */
export function setNotificationNavigator(
  navigate: (path: string) => void,
): () => void {
  routeTo = navigate;
  return () => {
    if (routeTo === navigate) {
      routeTo = null;
    }
  };
}

export function openNotificationTarget(path: string): void {
  routeTo?.(path);
}

/**
 * What the desktop shell is told about the banner's own sound.
 *
 * `true` while the app's sounds are on: the app plays its cue (or deliberately
 * none), and an OS sound on top would double it. `false` when the person turned
 * app sounds off, so the OS banner makes its own noise instead of arriving
 * silent; the OS keeps its Do Not Disturb and its volume. A shell that predates
 * the field ignores it and stays silent, as before.
 */
export function appPlaysSounds(): boolean {
  return getSoundState().enabled;
}

function describe(burst: Burst): { title: string; body: string } {
  const { activity } = burst;
  // `#` says "a channel in a server". A conversation's label is a person's
  // name, and hashing it turns a message from Ana into one from #Ana.
  const isConversation =
    (directory.get(activity.channelId)?.kind ?? "server") !== "server";
  const channel = activity.channelName
    ? isConversation
      ? activity.channelName
      : `#${activity.channelName}`
    : translateMessage("notify.activity");
  const title = activity.serverName ? `${channel} — ${activity.serverName}` : channel;
  if (burst.mentions > 0) {
    return {
      title,
      body: translateMessage("notify.mentions", { count: burst.mentions }),
    };
  }
  return {
    title,
    body: translateMessage("notify.messages", { count: burst.count }),
  };
}

function deliver(burst: Burst): void {
  const { title, body } = describe(burst);
  const { channelId, serverId } = burst.activity;
  const path = activityRoutePath(channelId, serverId);

  const desktop = getDesktop();
  if (desktop?.notify) {
    // The main process can raise the window on click, which a renderer-side
    // `window.focus()` cannot do from behind another app.
    desktop.notify({ title, body, tag: channelId, path, silent: appPlaysSounds() });
    return;
  }

  try {
    const notification = new Notification(title, {
      body,
      // One live notification per channel: a later burst replaces the earlier
      // one in place instead of stacking a column of them.
      tag: channelId,
      // The OS already has a notification sound and a Do Not Disturb switch,
      // and neither is ours to override.
      silent: true,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
      openNotificationTarget(path);
    };
  } catch {
    // Android Chrome throws on `new Notification()` outright — it only permits
    // notifications raised from a service worker. Now that the PWA registers
    // one, fall through to it rather than silently dropping the notification,
    // which is the whole feature on the platform most likely to be someone's
    // only device.
    void deliverViaServiceWorker(title, body, channelId, path);
  }
}

/**
 * The Android Chrome path. `showNotification` is fire-and-forget — the click is
 * handled by the worker, not here — so `data.path` carries where to go and the
 * default vite-plugin-pwa worker's `notificationclick` focuses the client.
 */
async function deliverViaServiceWorker(
  title: string,
  body: string,
  channelId: string,
  path: string,
): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification(title, {
      body,
      tag: channelId,
      silent: true,
      data: { path },
    });
  } catch {
    // No worker, or notifications refused at the OS level. Nothing else in the
    // app depends on this.
  }
}

/**
 * A DM or group call ringing this device while the window is not in front.
 *
 * `IncomingCallOverlay` and the ringtone (`startSoundLoop("incomingCall")`)
 * already cover a focused window — this exists for the same reason `deliver`
 * does for messages: a backgrounded or minimized desktop app has nothing on
 * screen to see, and only the shell's own IPC can raise it from behind
 * another application when the notification is clicked. That is the desktop
 * equivalent of a phone never ringing for an incoming call.
 *
 * Deliberately not gated by a channel/server level or `arrivalToast`: the
 * overlay and the ringtone already ignore both — a call is not a message,
 * and a muted conversation should not stop it from ringing here too.
 */
export function notifyIncomingCall(
  call: { conversationId: string; kind: "dm" | "group"; callerName: string },
  context: { windowFocused: boolean },
): void {
  if (context.windowFocused || doNotDisturb) {
    return;
  }
  // An incoming call bypasses the desktop-notifications opt-in that ordinary
  // message banners honour: a call is high-signal and time-critical, you always
  // want to know the phone or desktop is ringing even if you never turned
  // message banners on. The real OS permission below cannot be bypassed; if the
  // browser or OS has not granted notifications, there is nothing we can show.
  if (notificationPermission() !== "granted") {
    return;
  }
  const title = call.callerName;
  const body = translateMessage(
    call.kind === "group" ? "call.incoming.groupTitle" : "call.incoming.title",
  );
  const tag = `call:${call.conversationId}`;
  const path = conversationRoutePath(call.conversationId);

  const desktop = getDesktop();
  if (desktop?.notify) {
    desktop.notify({ title, body, tag, path, silent: appPlaysSounds() });
    return;
  }

  try {
    const notification = new Notification(title, { body, tag, silent: true });
    notification.onclick = () => {
      window.focus();
      notification.close();
      openNotificationTarget(path);
    };
  } catch {
    // Android Chrome — see the identical fallback in `deliver`.
    void deliverViaServiceWorker(title, body, tag, path);
  }
}

/**
 * "Alberto começou a transmitir em #filminho · Assistir", when the server says a
 * stream started somewhere this person asked to hear about.
 *
 * THE SERVER DECIDES WHO, THIS DECIDES WHETHER THE OS HEARS ABOUT IT. The
 * frame only reaches a person the server already chose (flag, opt-in, the 200
 * member default, DND, mute, access, not in the room, once per channel per 30
 * minutes). What the server cannot see is this window, so the rest of the rules
 * are here, and every one of them is a way to say nothing:
 *
 * - a window in front, looking at THAT server, already sees the stream (the
 *   strip, and the share on the sidebar's roster), so nothing on top of it. A
 *   window in front on another server, a conversation or the home is not
 *   looking at it: that person is exactly who the notice is for;
 * - Do Not Disturb, and a server or channel the person turned down;
 * - their own switch for this server;
 * - the existing desktop-notification opt-in AND a browser permission that is
 *   ALREADY granted. This never asks: a prompt out of nowhere is what teaches
 *   people to block the site, and a stream is not worth that.
 *
 * Clicking it opens the app on that channel and joins nothing.
 */
export function notifyStreamStarted(
  frame: {
    serverId: string;
    channelId: string;
    channelName: string;
    serverName: string;
    sharerName: string;
    kind: "voice" | "party";
  },
  context: {
    /** The window is visible and has focus. */
    windowFocused: boolean;
    /** The server open in this window, or null on a conversation / the home. */
    openServerId?: string | null;
  },
): boolean {
  if (
    (context.windowFocused && context.openServerId === frame.serverId) ||
    doNotDisturb
  ) {
    return false;
  }
  if (state.streamAlerts[frame.serverId] === false) {
    return false;
  }
  // "All unless the person said otherwise": a server nobody chose a level for
  // reads as "mentions" for ordinary messages (`desktop_notify_default_on`),
  // and that default is about messages, not about a stream starting.
  if (resolveLevel(state, frame.serverId, frame.channelId, "all") !== "all") {
    return false;
  }
  if (!desktopBannersEnabled() || notificationPermission() !== "granted") {
    return false;
  }
  const title =
    frame.kind === "party"
      ? translateMessage("notify.streamStarted.titleParty", {
          name: frame.sharerName,
          party: frame.channelName,
        })
      : translateMessage("notify.streamStarted.title", {
          name: frame.sharerName,
          channel: frame.channelName,
        });
  const body = translateMessage("notify.streamStarted.body", {
    server: frame.serverName,
  });
  const tag = `stream:${frame.channelId}`;
  const path = channelRoutePath(frame.serverId, frame.channelId);

  const desktop = getDesktop();
  if (desktop?.notify) {
    // The shell can refuse (a bridge from an older build, an OS that will not
    // draw it): that is not the notice being over, so the web path is tried
    // after it, and a rejected promise is caught rather than left unhandled.
    try {
      const sent: unknown = desktop.notify({
        title,
        body,
        tag,
        path,
        silent: appPlaysSounds(),
      });
      if (sent && typeof (sent as Promise<unknown>).catch === "function") {
        (sent as Promise<unknown>).catch(() => {
          void showWebStreamNotice(title, body, tag, path);
        });
      }
      return true;
    } catch {
      // Fall through to the web notification below.
    }
  }
  void showWebStreamNotice(title, body, tag, path);
  return true;
}

async function showWebStreamNotice(
  title: string,
  body: string,
  tag: string,
  path: string,
): Promise<void> {
  try {
    const notification = new Notification(title, { body, tag, silent: true });
    notification.onclick = () => {
      window.focus();
      notification.close();
      openNotificationTarget(path);
    };
  } catch {
    // Android Chrome: see the identical fallback in `deliver`.
    await deliverViaServiceWorker(title, body, tag, path);
  }
}

function flush(channelId: string): void {
  const burst = bursts.get(channelId);
  if (!burst) {
    return;
  }
  burst.timer = null;
  if (burst.count === 0 && burst.mentions === 0) {
    return;
  }
  // Sounds are independent of OS banners: Discord still pings when desktop
  // notifications are off. The burst still coalesces so a busy channel is
  // one ping per quiet window, not one per message. Ordinary messages have
  // no cue; only a mention plays.
  if (burst.mentions > 0) {
    playActivitySound(burst.mentions);
  } else if (
    burst.activity.kind === "dm" ||
    burst.activity.kind === "group"
  ) {
    // A conversation message is addressed to you even without an @, so it
    // gets the quiet "message" cue (its own switch in sound settings).
    playCue("message");
  }
  // The dedupe rule from §4.2: the OS carries it only when the window was not
  // focused. A toast already shown for this burst means the window WAS
  // focused and visible when it arrived, which is exactly the condition under
  // which no OS banner belongs on screen either.
  if (
    desktopBannersEnabled() &&
    notificationPermission() === "granted" &&
    !burst.toastShownForBurst
  ) {
    deliver(burst);
  }
  burst.count = 0;
  burst.mentions = 0;
  burst.toastShownForBurst = false;
  burst.lastFiredAt = Date.now();
}

export interface ActivityContext {
  selectedChannelId: string | null;
  documentVisible: boolean;
  /**
   * `document.hasFocus()`. Optional and defaults to `true` for a caller that
   * predates this field, which preserves that caller's old behaviour (toast
   * gated on visibility alone).
   */
  windowFocused?: boolean;
  /** `html[data-immersive-stage]` is set. Defaults to `false`. */
  immersive?: boolean;
}

/**
 * Whether the account is currently on Do Not Disturb.
 *
 * THIS IS WHAT MAKES DND A BEHAVIOUR RATHER THAN A RED DOT. Everything else
 * about status is something other people see; this is the half the person who
 * set it actually feels, and without it "do not disturb" would disturb them
 * exactly as much as before while telling everybody else it did not.
 *
 * A module-level flag rather than a field on `NotificationState`: that state is
 * persisted to localStorage and synced as a preference from `adoptNotificationPreferences`,
 * and DND already has its own home in `user_preferences.status`. Two writers for
 * one value would eventually disagree about which is the truth.
 *
 * It suppresses the *interruption*, not the information: unread badges, mention
 * counts and the title badge are all untouched, so nothing is missed — it is
 * waiting when you come back, which is the difference between "do not disturb"
 * and "mute".
 */
let doNotDisturb = false;

export function setDoNotDisturb(enabled: boolean): void {
  doNotDisturb = enabled;
}

/**
 * Record activity in a channel and interrupt the user if it earns it.
 *
 * The first message in a quiet channel notifies immediately; anything within
 * the next few seconds is folded into one follow-up rather than buzzing per
 * message, which is what makes a busy channel bearable.
 */
export function notifyChannelActivity(
  activity: ChannelActivity,
  context: ActivityContext,
): void {
  if (doNotDisturb) {
    return;
  }

  const level = resolveNotificationLevel(state, activity.serverId, activity.channelId);
  const windowFocused = context.windowFocused ?? true;
  const immersive = context.immersive ?? false;
  if (
    !shouldNotify({
      level,
      mention: activity.mentions > 0,
      channelId: activity.channelId,
      selectedChannelId: context.selectedChannelId,
      documentVisible: context.documentVisible,
      windowFocused,
    })
  ) {
    return;
  }

  // It would have interrupted, so this is the moment worth offering the switch.
  noteNotifyOffer(activity, context.documentVisible);

  const showToast =
    state.arrivalToast &&
    shouldShowArrivalToast({
      kind: activity.kind ?? "server",
      channelId: activity.channelId,
      selectedChannelId: context.selectedChannelId,
      documentVisible: context.documentVisible,
      windowFocused,
      level,
      doNotDisturb,
      immersive,
    });
  if (showToast) {
    for (const listener of toastListeners) {
      listener({
        channelId: activity.channelId,
        kind: activity.kind ?? "server",
        count: activity.count,
        mentions: activity.mentions,
        preview: state.previewInApp ? activity.preview : undefined,
        authorName: activity.authorName,
      });
    }
  }

  const burst = bursts.get(activity.channelId) ?? {
    count: 0,
    mentions: 0,
    lastFiredAt: 0,
    timer: null,
    activity,
    toastShownForBurst: false,
  };
  burst.activity = activity;
  burst.mentions += activity.mentions;
  // At "mentions" the plain messages are precisely what the user asked not to
  // hear about, so they must not inflate the count in the body either.
  burst.count += level === "mentions" ? activity.mentions : activity.count;
  burst.toastShownForBurst = burst.toastShownForBurst || showToast;
  bursts.set(activity.channelId, burst);

  const waited = Date.now() - burst.lastFiredAt;
  if (waited >= RENOTIFY_QUIET_MS) {
    flush(activity.channelId);
    return;
  }
  if (burst.timer === null) {
    burst.timer = setTimeout(() => flush(activity.channelId), RENOTIFY_QUIET_MS - waited);
  }
}

/**
 * A mention that landed in the channel already on screen.
 *
 * `notifyChannelActivity` stays quiet for that channel so OS banners do not
 * announce what the user can already read. Plain messages are silent here
 * too; only a ping that names the reader plays (username, fired @everyone /
 * @here, or a reply). Own messages never ping. DND and a muted channel still
 * silence it.
 */
export function notifyOpenChannelMessage(
  channelId: string,
  mention: boolean,
): void {
  if (!mention || doNotDisturb) {
    return;
  }
  const known = lookupChannel(channelId);
  const level = resolveNotificationLevel(
    state,
    known?.serverId ?? null,
    channelId,
  );
  if (level === "none") {
    return;
  }
  playActivitySound(1);
}

/** Drop pending bursts, e.g. when the app shell unmounts on sign-out. */
export function resetNotificationBursts(): void {
  notifyOfferPending = false;
  for (const burst of bursts.values()) {
    if (burst.timer !== null) {
      clearTimeout(burst.timer);
    }
  }
  bursts.clear();
}

// --------------------------------------------------------------------- badge

const TITLE_BADGE = /^\(\d+\+?\)\s+/;

export function formatBadge(mentions: number): string {
  return mentions > BADGE_CAP ? `${BADGE_CAP}+` : String(mentions);
}

/**
 * Surface the cross-server mention count where it is visible with the app in
 * the background: the OS dock in the desktop shell, the tab title on the web.
 */
/**
 * One promise chain for the whole module, so two `setUnreadBadge` calls in
 * quick succession (a count that changes twice before the first OS call has
 * even resolved) apply to the platform badge in the order they were made
 * rather than whichever `setAppBadge`/`clearAppBadge` round-trip happens to
 * resolve first — which, left to fire-and-forget, can and does reorder.
 */
let badgeChain: Promise<void> = Promise.resolve();

export function setUnreadBadge(mentions: number): void {
  getDesktop()?.setBadgeCount?.(mentions);
  // The installed PWA's own icon badge (Chrome Android / desktop; absent on
  // iOS Safari and on Firefox, which is exactly why this is wrapped — a
  // missing API must not take the tab title down with it).
  badgeChain = badgeChain
    .then(() => {
      const badgeable = navigator as Navigator & {
        setAppBadge?: (count?: number) => Promise<void>;
        clearAppBadge?: () => Promise<void>;
      };
      return mentions > 0
        ? badgeable.setAppBadge?.(mentions)
        : badgeable.clearAppBadge?.();
    })
    .catch(() => {
      // Not available in this browser, or thrown outright by a hostile one.
    });
  if (typeof document === "undefined") {
    return;
  }
  // Re-derived from the live title rather than a remembered base, because the
  // route's own `<Seo>` rewrites it whenever the user changes page.
  const base = document.title.replace(TITLE_BADGE, "");
  document.title = mentions > 0 ? `(${formatBadge(mentions)}) ${base}` : base;
}

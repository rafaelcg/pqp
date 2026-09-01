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
import { getDesktop } from "@/lib/desktop";
import { translateMessage } from "@/lib/i18n";
import { queuePreferenceSync } from "@/lib/preferences";
import { playActivitySound, playCue } from "@/lib/sounds";

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
  /** Applies wherever neither the channel nor its server says otherwise. */
  default: NotificationLevel;
  servers: Record<string, NotificationLevel>;
  channels: Record<string, NotificationLevel>;
}

export type NotificationPermissionState =
  | "unsupported"
  | "default"
  | "granted"
  | "denied";

const DEFAULT_STATE: NotificationState = {
  desktop: false,
  default: "all",
  servers: {},
  channels: {},
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

function fromPreferences(
  preferences: NotificationPreferences,
  base: NotificationState,
): NotificationState {
  return {
    desktop: preferences.desktop ?? base.desktop,
    default: preferences.default ?? base.default,
    servers: readLevelMap(preferences.servers),
    channels: readLevelMap(preferences.channels),
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
    default: current.default,
    servers: current.servers,
    channels: current.channels,
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
      default: isLevel(record.default) ? record.default : DEFAULT_STATE.default,
      servers: readLevelMap(record.servers),
      channels: readLevelMap(record.channels),
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
  commit({ ...state, desktop: enabled }, { sync: true });
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
 */
export function resolveNotificationLevel(
  current: NotificationState,
  serverId: string | null,
  channelId: string | null,
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
  return current.default;
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
  };
}

// --------------------------------------------------------------- permissions

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

/** Pure: whether this activity earns an in-app card. */
export function wantsActivityToast(
  activity: Pick<ChannelActivity, "kind">,
  context: ActivityContext,
): boolean {
  return (
    context.documentVisible &&
    (activity.kind === "dm" || activity.kind === "group")
  );
}

export interface NotificationDecision {
  level: NotificationLevel;
  mention: boolean;
  channelId: string;
  selectedChannelId: string | null;
  documentVisible: boolean;
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
}: NotificationDecision): boolean {
  // Already on screen in front of them. Both halves matter: a background tab
  // still has a channel selected, and a visible window can be on another one.
  if (documentVisible && selectedChannelId === channelId) {
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
    desktop.notify({ title, body, tag: channelId, path });
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
  if (state.desktop && notificationPermission() === "granted") {
    deliver(burst);
  }
  burst.count = 0;
  burst.mentions = 0;
  burst.lastFiredAt = Date.now();
}

export interface ActivityContext {
  selectedChannelId: string | null;
  documentVisible: boolean;
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
  if (
    !shouldNotify({
      level,
      mention: activity.mentions > 0,
      channelId: activity.channelId,
      selectedChannelId: context.selectedChannelId,
      documentVisible: context.documentVisible,
    })
  ) {
    return;
  }

  if (wantsActivityToast(activity, context)) {
    for (const listener of toastListeners) {
      listener({
        channelId: activity.channelId,
        kind: activity.kind ?? "server",
        count: activity.count,
        mentions: activity.mentions,
      });
    }
  }

  const burst = bursts.get(activity.channelId) ?? {
    count: 0,
    mentions: 0,
    lastFiredAt: 0,
    timer: null,
    activity,
  };
  burst.activity = activity;
  burst.mentions += activity.mentions;
  // At "mentions" the plain messages are precisely what the user asked not to
  // hear about, so they must not inflate the count in the body either.
  burst.count += level === "mentions" ? activity.mentions : activity.count;
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
export function setUnreadBadge(mentions: number): void {
  getDesktop()?.setBadgeCount?.(mentions);
  if (typeof document === "undefined") {
    return;
  }
  // Re-derived from the live title rather than a remembered base, because the
  // route's own `<Seo>` rewrites it whenever the user changes page.
  const base = document.title.replace(TITLE_BADGE, "");
  document.title = mentions > 0 ? `(${formatBadge(mentions)}) ${base}` : base;
}

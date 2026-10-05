/**
 * "Watch now": which streams a person should be shown a way into, from what
 * the client already holds. `docs/plans/WATCH_NOW.md`.
 *
 * EVIDENCE. 2026-10-04, Filminho: the owner shared a film into a plain voice
 * channel, 40 people sat in the call and the rest of an 86-member server of
 * brand-new accounts stayed in `#general` asking "cadê o filme?". Everything
 * needed to say "it is over there, one tap" was already on every client: the
 * voice roster carries `sharingScreen`, a watch party is a frame of its own.
 * Only the sidebar drew it, and the sidebar is the first thing a newcomer does
 * not read.
 *
 * PURE ON PURPOSE. No React, no socket, no clock of its own: the inputs are the
 * stores the app already keeps, so the rules (who is excluded and why) can be
 * walked exhaustively by a test, and nothing here can add a server write, a
 * frame or a poll. THE NUMBERS ARE THE ROSTER'S AND `channel-live`'s; a count
 * this file makes up is a count somebody screenshots.
 *
 * NOTHING HERE LEAKS A CHANNEL. The roster of a channel is only ever sent to
 * people who may VIEW it (`getChannelAudience`), so a private voice channel the
 * person cannot see has no entry in what this reads. CONNECT is not part of
 * that audience, so it is checked here (`canConnect`): a button that can only
 * fail is worse than none.
 */

/** What this needs of a roster entry. Structural, so the voice types need not leak in. */
export interface WatchNowPeer {
  userId: string;
  displayName: string;
  sharingScreen: boolean;
}

export interface WatchNowChannel {
  id: string;
  name: string;
  type: string;
}

/** What this needs of a watch party. */
export interface WatchNowParty {
  channelId: string;
  name: string;
  state: string;
  hostUserId: string;
  hostDisplayName: string;
  /** ISO 8601. */
  wentLiveAt: string | null;
}

/** What this needs of a `channel-live` entry. */
export interface WatchNowLive {
  /** Already the server's distinct-accounts `viewers` when it sent one. */
  watching: number;
  stream: { startedAt: number } | null;
}

export type WatchNowKind = "voice" | "party" | "call";

export interface WatchNowStream {
  /** `channelId:sharerUserId`. A different person sharing is a different stream. */
  key: string;
  channelId: string;
  kind: WatchNowKind;
  /** The channel's name (voice) or the party's own name (party); null in a call. */
  place: string | null;
  sharerUserId: string;
  sharerName: string;
  /**
   * When it began, only when that is KNOWN: a party's `wentLiveAt`, a stream's
   * `startedAt`, or a share this tab watched begin (`ShareClock`). Null says
   * nothing about the age, and the banner then says nothing about it either.
   */
  startedAt: number | null;
  /** People watching besides the sharer. Zero is "say nothing". */
  watching: number;
  /** This person has a seat in that room already. */
  inRoom: boolean;
}

export type WatchNowScope =
  | { kind: "server"; channels: readonly WatchNowChannel[] }
  | { kind: "conversation"; channelId: string };

export interface WatchNowInput {
  viewerId: string;
  scope: WatchNowScope;
  occupancy: Readonly<Record<string, readonly WatchNowPeer[] | undefined>>;
  parties: Readonly<Record<string, WatchNowParty | undefined>>;
  channelLive: Readonly<Record<string, WatchNowLive | undefined>>;
  blocked: ReadonlySet<string>;
  /** CONNECT on that channel. Always true for a conversation. */
  canConnect: (channelId: string) => boolean;
  /** The room this person is seated in, or null. */
  seatedChannelId: string | null;
}

function parseMs(iso: string | null): number | null {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Every stream this person could be shown, BEFORE the two filters that depend
 * on what is on screen (`visibleWatchNowStreams`): the clock has to see a
 * stream while it is hidden or open, or "how long" would reset every time the
 * person looked at the channel and back.
 */
export function collectWatchNowStreams(input: WatchNowInput): WatchNowStream[] {
  const found: WatchNowStream[] = [];
  const { viewerId, occupancy, parties, channelLive, blocked } = input;

  const addRoom = (
    channel: { id: string; kind: WatchNowKind; place: string | null },
    party: WatchNowParty | undefined,
  ) => {
    const roster = occupancy[channel.id] ?? [];
    const sharers = roster.filter((peer) => peer.sharingScreen);
    if (sharers.some((peer) => peer.userId === viewerId)) {
      // The presenter's own stream is not news to them.
      return;
    }
    const visible = sharers.filter((peer) => !blocked.has(peer.userId));
    // The person on the stage, in a stable order so the key does not flip
    // between two sharers on every roster frame.
    visible.sort((a, b) => a.userId.localeCompare(b.userId));
    let sharerUserId: string;
    let sharerName: string;
    if (party) {
      if (party.hostUserId === viewerId || blocked.has(party.hostUserId)) {
        return;
      }
      sharerUserId = party.hostUserId;
      sharerName = party.hostDisplayName;
    } else {
      const first = visible[0];
      if (!first) {
        return;
      }
      sharerUserId = first.userId;
      sharerName = first.displayName;
    }
    const live = channelLive[channel.id];
    const presenting = new Set(sharers.map((peer) => peer.userId));
    presenting.add(sharerUserId);
    const seated = roster.filter((peer) => !presenting.has(peer.userId)).length;
    // A party's audience is the room plus everybody on the playlist without a
    // seat (`watching`, which already prefers the server's own count); a plain
    // share's audience is the room.
    const watching = seated + (party ? Math.max(0, live?.watching ?? 0) : 0);
    found.push({
      key: `${channel.id}:${sharerUserId}`,
      channelId: channel.id,
      kind: channel.kind,
      place: channel.place,
      sharerUserId,
      sharerName,
      startedAt: party
        ? (parseMs(party.wentLiveAt) ?? live?.stream?.startedAt ?? null)
        : (live?.stream?.startedAt ?? null),
      watching,
      inRoom: input.seatedChannelId === channel.id,
    });
  };

  if (input.scope.kind === "conversation") {
    addRoom({ id: input.scope.channelId, kind: "call", place: null }, undefined);
    return found;
  }

  for (const channel of input.scope.channels) {
    if (channel.type === "watch_party") {
      const party = parties[channel.id];
      if (party?.state !== "live") {
        // A share during setup is the host rehearsing, not a show.
        continue;
      }
      if (!input.canConnect(channel.id)) {
        continue;
      }
      addRoom({ id: channel.id, kind: "party", place: party.name }, party);
      continue;
    }
    if (channel.type !== "voice") {
      continue;
    }
    if (!input.canConnect(channel.id)) {
      continue;
    }
    addRoom({ id: channel.id, kind: "voice", place: channel.name }, undefined);
  }
  return found;
}

/**
 * Whether the stream's own picture is what the pane is showing already, so a
 * strip pointing at it would point at where the person is:
 *
 * - a watch party: opening its channel IS watching it;
 * - a share in a voice channel: only once they are seated in it. Open but NOT
 *   joined is a lobby with a "join the call" button, which asks for a
 *   microphone; the strip's Assistir is the way in with none;
 * - a conversation's call: the pane is the chat until they join, then the call.
 */
function streamIsOnScreen(
  stream: WatchNowStream,
  openChannelId: string | null,
): boolean {
  if (stream.kind === "call") {
    return stream.inRoom;
  }
  if (stream.channelId !== openChannelId) {
    return false;
  }
  return stream.kind === "party" ? true : stream.inRoom;
}

/**
 * What is actually drawn: not what is on screen already, not what the person
 * said "agora não" to, headline first.
 *
 * Order: the one with most people, then the one that started first (unknown
 * last), then by name, so two clients show the same list.
 */
export function visibleWatchNowStreams(
  streams: readonly WatchNowStream[],
  options: { openChannelId: string | null; dismissed: ReadonlySet<string> },
): WatchNowStream[] {
  return streams
    .filter(
      (stream) =>
        !streamIsOnScreen(stream, options.openChannelId) &&
        !options.dismissed.has(stream.key),
    )
    .sort(
      (a, b) =>
        b.watching - a.watching ||
        (a.startedAt ?? Number.MAX_SAFE_INTEGER) -
          (b.startedAt ?? Number.MAX_SAFE_INTEGER) ||
        (a.place ?? "").localeCompare(b.place ?? "") ||
        a.key.localeCompare(b.key),
    );
}

/**
 * HOW LONG, WITHOUT LYING.
 *
 * A share that was already running when the tab loaded has no start this
 * client can know, and "há 0 min" on a film that is an hour in is worse than
 * saying nothing. So the clock only dates a share it SAW begin: first sighting
 * after a grace window that covers the catch-up burst of rosters every socket
 * receives on connect.
 */
export const SHARE_CLOCK_GRACE_MS = 20_000;

export class ShareClock {
  private seen = new Map<string, number | null>();

  /**
   * Whether the rosters this tab holds are the whole picture yet. Before the
   * grace has passed an empty occupancy means "not told", not "nobody is
   * sharing", so nothing may be forgotten on it (a dismissal in particular).
   */
  settled(now: number): boolean {
    return now - this.bootAt >= this.graceMs;
  }

  /** How long until `settled` is true, in ms (0 once it is). */
  settledInMs(now: number): number {
    return Math.max(0, this.bootAt + this.graceMs - now);
  }

  constructor(
    private readonly bootAt: number,
    private readonly graceMs: number = SHARE_CLOCK_GRACE_MS,
  ) {}

  /** Call with every candidate key on each change. Forgets keys that are gone. */
  observe(keys: readonly string[], now: number): void {
    const next = new Map<string, number | null>();
    for (const key of keys) {
      next.set(
        key,
        this.seen.has(key)
          ? (this.seen.get(key) ?? null)
          : now - this.bootAt >= this.graceMs
            ? now
            : null,
      );
    }
    this.seen = next;
  }

  startedAt(key: string): number | null {
    return this.seen.get(key) ?? null;
  }
}

/**
 * Every share the roster frames describe right now, in EVERY channel this
 * client holds, as `channelId:userId` keys, plus each live party's host. The
 * clock and the dismissal prune look at this and not at the open server's
 * streams: after a switch to another server a share that has been running for
 * an hour would otherwise look like one that just began.
 */
export function watchNowLiveKeys(
  occupancy: WatchNowInput["occupancy"],
  parties: WatchNowInput["parties"],
): string[] {
  const keys: string[] = [];
  for (const [channelId, roster] of Object.entries(occupancy)) {
    for (const peer of roster ?? []) {
      if (peer.sharingScreen) {
        keys.push(`${channelId}:${peer.userId}`);
      }
    }
  }
  for (const party of Object.values(parties)) {
    if (party?.state === "live") {
      keys.push(`${party.channelId}:${party.hostUserId}`);
    }
  }
  return keys;
}

/** Fill in a stream's start from the clock when the data had none. */
export function withObservedStart(
  streams: readonly WatchNowStream[],
  clock: Pick<ShareClock, "startedAt">,
): WatchNowStream[] {
  return streams.map((stream) =>
    stream.startedAt !== null
      ? stream
      : { ...stream, startedAt: clock.startedAt(stream.key) },
  );
}

export type WatchNowAge =
  | { unit: "now" }
  | { unit: "minutes"; value: number }
  | { unit: "hours"; value: number };

/** `null` when the start is unknown or in the future. */
export function watchNowAge(
  startedAt: number | null,
  now: number,
): WatchNowAge | null {
  if (startedAt === null || startedAt > now + 5_000) {
    return null;
  }
  const minutes = Math.floor((now - startedAt) / 60_000);
  if (minutes < 1) {
    return { unit: "now" };
  }
  if (minutes < 90) {
    return { unit: "minutes", value: minutes };
  }
  return { unit: "hours", value: Math.floor(minutes / 60) };
}

// ------------------------------------------------------------- dismissal

/**
 * "Agora não" hides one stream until it ends. A set of keys, remembered for the
 * tab (a reload must not bring back what a person just waved away) and pruned
 * to the streams that still exist, so the next stream of the evening shows.
 */
const DISMISS_STORAGE_KEY = "pqp:watch-now-dismissed";

type DismissStorage = Pick<Storage, "getItem" | "setItem"> | null;

function sessionStore(): DismissStorage {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readDismissed(storage: DismissStorage = sessionStore()): Set<string> {
  if (!storage) {
    return new Set();
  }
  try {
    const raw = storage.getItem(DISMISS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function writeDismissed(keys: ReadonlySet<string>, storage: DismissStorage): void {
  try {
    storage?.setItem(DISMISS_STORAGE_KEY, JSON.stringify([...keys].slice(-50)));
  } catch {
    // Quota or a blocked store: the in-memory set still holds for this load.
  }
}

let dismissed: Set<string> | null = null;
const listeners = new Set<() => void>();

function current(): Set<string> {
  dismissed ??= readDismissed();
  return dismissed;
}

function publish(next: Set<string>): void {
  dismissed = next;
  writeDismissed(next, sessionStore());
  for (const listener of listeners) {
    listener();
  }
}

export function dismissedWatchNow(): ReadonlySet<string> {
  return current();
}

export function subscribeWatchNowDismissed(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function dismissWatchNow(key: string): void {
  const next = new Set(current());
  next.add(key);
  publish(next);
}

/**
 * Forget dismissals whose stream is over. Called with the keys that are live
 * right now; a no-op (and no notification) when nothing changes, so it can run
 * on every roster frame.
 *
 * A key that is not live is only forgotten when that is KNOWN: once the
 * rosters have settled (`settled`), or when this tab watched that very stream
 * be live and then go (`seenLive`). Before that an absent key may only mean
 * "the roster has not arrived yet", and a reload in the middle of a film must
 * not forget "agora não" because the occupancy was still empty.
 */
export function pruneWatchNowDismissed(
  liveKeys: readonly string[],
  options: { settled: boolean; seenLive?: ReadonlySet<string> } = {
    settled: true,
  },
): void {
  const live = new Set(liveKeys);
  const held = current();
  let changed = false;
  const next = new Set<string>();
  for (const key of held) {
    if (live.has(key) || !(options.settled || options.seenLive?.has(key))) {
      next.add(key);
    } else {
      changed = true;
    }
  }
  if (changed) {
    publish(next);
  }
}

/** Test seam: drop the in-memory copy so the next read goes to storage. */
export function resetWatchNowDismissedForTests(): void {
  dismissed = null;
  listeners.clear();
}

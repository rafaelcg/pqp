import { useSyncExternalStore } from "react";
import {
  appEndedSchema,
  appErrorSchema,
  appSessionSchema,
  channelAppSchema,
  type AppEndReason,
  type AppSessionSummary,
} from "@pqp/shared";

/**
 * THE LIVE APPS OF EVERY SERVER THIS TAB KNOWS, ON THIS MACHINE.
 *
 * One source of truth for everything that draws "an app is running here": the
 * timeline card, the session strip, the launcher's "already running" state and
 * the presence line under a name. Fed from two places that must agree:
 *
 *  - `GET /api/servers/:id/app-sessions`, on server open and on socket
 *    reconnect (`applyCatchUp`). The `/ws` welcome carries none of it.
 *  - `channel-app` frames, to every socket whose account can VIEW the channel
 *    (decision D13), and `app-ended` to the people who were seated.
 *
 * A frame that lands while a catch-up is in flight is newer than the read, so
 * `applyCatchUp` leaves any channel a frame touched since it started alone.
 * Without that a slow answer would resurrect a session that ended meanwhile.
 *
 * What it holds is what everyone who can view the channel may know (no state,
 * no seat ids): see `appSessionSummarySchema`. Nothing here is sent anywhere.
 */

/** How long the server holds a seat for a person who dropped (`voice` resume window). */
export const APP_RESUME_WINDOW_MS = 90_000;
/** A join that never answers is a failure, not a spinner for ever (mock 01 uses 8 s too). */
export const APP_JOIN_TIMEOUT_MS = 8_000;
/** Ended sessions remembered for cards that are still on screen. */
const ENDED_MEMORY = 60;

export interface EndedAppSession {
  sessionId: string;
  channelId: string;
  appId: string;
  startedAt: string;
  startedBy: string | null;
  hostUserId: string | null;
  endedAt: number;
  /** Only the people who were seated hear why (`app-ended`); the rest see none. */
  reason: AppEndReason | null;
  /** Same: `null` for a viewer who was not in it. */
  summary: { participants: number; durationSeconds: number } | null;
  /** Who was in it the last time this tab heard. */
  participantIds: readonly string[];
}

export type AppJoinFailure = "connection" | "not-allowed" | "rate-limited" | "unavailable";

export type AppJoinState =
  | { status: "joining"; since: number }
  | { status: "failed"; code: AppJoinFailure; at: number };

export interface AppSessionsSnapshot {
  /** Live session by channel id. */
  live: ReadonlyMap<string, AppSessionSummary>;
  /** Ended sessions by session id, newest last. */
  ended: ReadonlyMap<string, EndedAppSession>;
  /** Servers whose catch-up has landed at least once. */
  loadedServers: ReadonlySet<string>;
  join: ReadonlyMap<string, AppJoinState>;
  /** The person this tab is, so "inside" can be told from "somebody else is". */
  viewerId: string | null;
  /** False from the moment the socket drops until it is back. */
  online: boolean;
  offlineSince: number | null;
  /** Bumped on every reconnect: whoever re-reads on a reconnect depends on it. */
  epoch: number;
}

let snapshot: AppSessionsSnapshot = emptySnapshot();
/** Channel id to the server it belongs to, learned from catch-ups. */
const serverOfChannel = new Map<string, string>();
/** Monotonic stamp of the last frame per channel, against an in-flight catch-up. */
let frameClock = 0;
const frameStampOfChannel = new Map<string, number>();
const joinTimers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function emptySnapshot(): AppSessionsSnapshot {
  return {
    live: new Map(),
    ended: new Map(),
    loadedServers: new Set(),
    join: new Map(),
    viewerId: null,
    online: true,
    offlineSince: null,
    epoch: 0,
  };
}

function commit(next: Partial<AppSessionsSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of [...listeners]) {
    listener();
  }
}

export function getAppSessionsSnapshot(): AppSessionsSnapshot {
  return snapshot;
}

export function subscribeAppSessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe to a slice. The selector must return a stable value for an unchanged slice. */
export function useAppSessions<T>(selector: (state: AppSessionsSnapshot) => T): T {
  return useSyncExternalStore(
    subscribeAppSessions,
    () => selector(snapshot),
    () => selector(snapshot),
  );
}

// ---------------------------------------------------------------------------
// Reading

/** The live session of a channel, or undefined. */
export function liveAppSession(
  state: AppSessionsSnapshot,
  channelId: string | null | undefined,
): AppSessionSummary | undefined {
  return channelId ? state.live.get(channelId) : undefined;
}

/** Whether `userId` is seated (as a player or a spectator) in this session. */
export function isSeated(session: AppSessionSummary, userId: string | null): boolean {
  return userId !== null && session.participants.some((one) => one.userId === userId);
}

/**
 * The server writes a session and its timeline message in one transaction, and
 * both columns default to `NOW()`, so they carry the same instant. That is the
 * link from a message in the log to its session: nothing about the session id
 * travels on the message itself. A second of slack covers a round trip through
 * a clock that stored less precision, never two real sessions: a channel holds
 * one live session and ends one before the next starts.
 */
const TIMELINE_MATCH_MS = 1_000;

export function startedWith(startedAt: string, messageCreatedAt: string): boolean {
  const a = Date.parse(startedAt);
  const b = Date.parse(messageCreatedAt);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= TIMELINE_MATCH_MS;
}

/** The live session whose timeline message is the one created at `createdAt`. */
export function liveSessionOfMessage(
  state: AppSessionsSnapshot,
  channelId: string,
  createdAt: string,
): AppSessionSummary | undefined {
  const live = state.live.get(channelId);
  return live && startedWith(live.startedAt, createdAt) ? live : undefined;
}

/** The ended session whose timeline message is the one created at `createdAt`. */
export function endedSessionOfMessage(
  state: AppSessionsSnapshot,
  channelId: string,
  createdAt: string,
): EndedAppSession | undefined {
  for (const one of state.ended.values()) {
    if (one.channelId === channelId && startedWith(one.startedAt, createdAt)) {
      return one;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Writing

function rememberEnded(
  ended: ReadonlyMap<string, EndedAppSession>,
  entry: EndedAppSession,
): ReadonlyMap<string, EndedAppSession> {
  const next = new Map(ended);
  next.delete(entry.sessionId);
  next.set(entry.sessionId, entry);
  while (next.size > ENDED_MEMORY) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

function endedFrom(
  session: AppSessionSummary,
  channelId: string,
  extra: Pick<EndedAppSession, "reason" | "summary">,
  existing?: EndedAppSession,
): EndedAppSession {
  return {
    sessionId: session.id,
    channelId,
    appId: session.appId,
    startedAt: session.startedAt,
    startedBy: session.startedBy,
    hostUserId: session.hostUserId,
    endedAt: existing?.endedAt ?? Date.now(),
    reason: extra.reason ?? existing?.reason ?? null,
    summary: extra.summary ?? existing?.summary ?? null,
    participantIds: session.participants.map((one) => one.userId),
  };
}

function clearJoin(
  join: ReadonlyMap<string, AppJoinState>,
  sessionId: string,
): ReadonlyMap<string, AppJoinState> {
  const timer = joinTimers.get(sessionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    joinTimers.delete(sessionId);
  }
  if (!join.has(sessionId)) {
    return join;
  }
  const next = new Map(join);
  next.delete(sessionId);
  return next;
}

/**
 * Put `session` (or none) on a channel. A start, an end and a count change all
 * arrive like this. The end of a session that was live here is remembered, so
 * the card in the log can say it ended instead of guessing.
 */
export function applyChannelApp(
  channelId: string,
  session: AppSessionSummary | null,
): void {
  frameClock += 1;
  frameStampOfChannel.set(channelId, frameClock);
  const before = snapshot.live.get(channelId);
  const live = new Map(snapshot.live);
  let ended = snapshot.ended;
  let join = snapshot.join;
  if (session) {
    live.set(channelId, session);
    if (before && before.id !== session.id) {
      ended = rememberEnded(ended, endedFrom(before, channelId, { reason: null, summary: null }, ended.get(before.id)));
      join = clearJoin(join, before.id);
    }
    // Seated: the join, if one was running, has landed.
    if (join.get(session.id)?.status === "joining" && isSeated(session, snapshot.viewerId)) {
      join = clearJoin(join, session.id);
    }
  } else if (before) {
    live.delete(channelId);
    ended = rememberEnded(ended, endedFrom(before, channelId, { reason: null, summary: null }, ended.get(before.id)));
    join = clearJoin(join, before.id);
  } else {
    return;
  }
  commit({ live, ended, join });
}

/** `app-ended`: the session's own account of how it went, to those who were in it. */
export function applyAppEnded(frame: {
  sessionId: string;
  channelId: string;
  reason: AppEndReason;
  summary: { participants: number; durationSeconds: number };
}): void {
  frameClock += 1;
  frameStampOfChannel.set(frame.channelId, frameClock);
  const before = snapshot.live.get(frame.channelId);
  const existing = snapshot.ended.get(frame.sessionId);
  const base: EndedAppSession | undefined =
    before && before.id === frame.sessionId
      ? endedFrom(before, frame.channelId, frame, existing)
      : existing
        ? { ...existing, reason: frame.reason, summary: frame.summary }
        : undefined;
  if (!base) {
    // Not seen live on this tab (a tab opened after it started): the frame is
    // all there is, enough for a card to say how it went but not to find the
    // card, which needs the start time.
    return;
  }
  const live = new Map(snapshot.live);
  if (before && before.id === frame.sessionId) {
    live.delete(frame.channelId);
  }
  commit({
    live,
    ended: rememberEnded(snapshot.ended, base),
    join: clearJoin(snapshot.join, frame.sessionId),
  });
}

/**
 * The answer to `GET /api/servers/:id/app-sessions`. `channelIds` is every
 * channel of the server the tab holds, so a session that is no longer in the
 * answer is dropped (the end was missed while the socket was down). A channel
 * a frame touched after `startedAtClock` is newer than this read and is left.
 */
export function applyCatchUp(
  serverId: string,
  channelIds: readonly string[],
  sessions: ReadonlyArray<{ channelId: string; session: AppSessionSummary }>,
  startedAtClock: number,
): void {
  const answered = new Map(sessions.map((entry) => [entry.channelId, entry.session]));
  for (const channelId of channelIds) {
    serverOfChannel.set(channelId, serverId);
  }
  for (const channelId of answered.keys()) {
    serverOfChannel.set(channelId, serverId);
  }
  const live = new Map(snapshot.live);
  let ended = snapshot.ended;
  let join = snapshot.join;
  const touchedByFrame = (channelId: string) =>
    (frameStampOfChannel.get(channelId) ?? 0) > startedAtClock;
  for (const [channelId, session] of answered) {
    if (touchedByFrame(channelId)) continue;
    live.set(channelId, session);
    if (join.get(session.id)?.status === "joining" && isSeated(session, snapshot.viewerId)) {
      join = clearJoin(join, session.id);
    }
  }
  for (const [channelId, session] of snapshot.live) {
    if (serverOfChannel.get(channelId) !== serverId) continue;
    if (answered.has(channelId) || touchedByFrame(channelId)) continue;
    live.delete(channelId);
    ended = rememberEnded(ended, endedFrom(session, channelId, { reason: null, summary: null }, ended.get(session.id)));
    join = clearJoin(join, session.id);
  }
  const loadedServers = new Set(snapshot.loadedServers);
  loadedServers.add(serverId);
  commit({ live, ended, join, loadedServers });
}

/** The clock a catch-up reads before it asks, to hand back to `applyCatchUp`. */
export function appFrameClock(): number {
  return frameClock;
}

/** Forget a server (its `apps` flag went off): nothing of it should draw. */
export function dropAppSessionsOfServer(serverId: string): void {
  const live = new Map(snapshot.live);
  let changed = false;
  for (const channelId of snapshot.live.keys()) {
    if (serverOfChannel.get(channelId) === serverId) {
      live.delete(channelId);
      changed = true;
    }
  }
  const loadedServers = new Set(snapshot.loadedServers);
  const hadLoaded = loadedServers.delete(serverId);
  if (changed || hadLoaded) {
    commit({ live, loadedServers });
  }
}

export function setAppsViewer(viewerId: string | null): void {
  if (snapshot.viewerId !== viewerId) {
    commit({ viewerId });
  }
}

/** The socket's state, from the transport's status changes. */
export function setAppsOnline(online: boolean, now: number = Date.now()): void {
  if (online === snapshot.online) {
    return;
  }
  commit({ online, offlineSince: online ? null : now });
}

/** A reconnect: whoever holds a per-server read re-asks (jittered by the caller). */
export function noteAppsReconnected(): void {
  commit({ epoch: snapshot.epoch + 1 });
}

// ---------------------------------------------------------------------------
// Joining
//
// The card says Entrar; what happens next is somebody else's. `requestAppJoin`
// asks whoever registered (the join sheet, once it exists: it shows the first
// time per app, then calls `joinAppSession`) and falls back to joining
// directly. The transport is whatever carries `app-join` to the socket.

export interface AppJoinOptions {
  asSpectator?: boolean;
}

export interface AppJoinTransport {
  /** False when the frame could not be sent right now (socket down). */
  sendJoin(sessionId: string, options: AppJoinOptions): boolean;
  sendLeave(sessionId: string): boolean;
}

let transport: AppJoinTransport | null = null;
let joinInterceptor: ((sessionId: string, options: AppJoinOptions) => void) | null = null;
let paneFocuser: ((sessionId: string) => void) | null = null;

export function registerAppJoinTransport(next: AppJoinTransport | null): () => void {
  transport = next;
  return () => {
    if (transport === next) {
      transport = null;
    }
  };
}

/** The join sheet takes over the first join per app per person. */
export function registerAppJoinInterceptor(
  next: ((sessionId: string, options: AppJoinOptions) => void) | null,
): () => void {
  joinInterceptor = next;
  return () => {
    if (joinInterceptor === next) {
      joinInterceptor = null;
    }
  };
}

/** The pane's owner (the session strip) registers how "Voltar pro app" moves focus. */
export function registerAppPaneFocuser(
  next: ((sessionId: string) => void) | null,
): () => void {
  paneFocuser = next;
  return () => {
    if (paneFocuser === next) {
      paneFocuser = null;
    }
  };
}

export function focusAppPane(sessionId: string): void {
  paneFocuser?.(sessionId);
}

function setJoin(sessionId: string, state: AppJoinState | null): void {
  const join = new Map(snapshot.join);
  if (state) {
    join.set(sessionId, state);
  } else {
    join.delete(sessionId);
  }
  commit({ join });
}

function failJoin(sessionId: string, code: AppJoinFailure): void {
  const timer = joinTimers.get(sessionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    joinTimers.delete(sessionId);
  }
  setJoin(sessionId, { status: "failed", code, at: Date.now() });
}

/** What the card's Entrar and Assistir call. */
export function requestAppJoin(sessionId: string, options: AppJoinOptions = {}): void {
  if (joinInterceptor) {
    joinInterceptor(sessionId, options);
    return;
  }
  joinAppSession(sessionId, options);
}

/** Join now, over the socket. The card shows Entrando, then lands or fails. */
export function joinAppSession(sessionId: string, options: AppJoinOptions = {}): void {
  if (snapshot.join.get(sessionId)?.status === "joining") {
    return;
  }
  if (!transport || !snapshot.online || !transport.sendJoin(sessionId, options)) {
    failJoin(sessionId, "connection");
    return;
  }
  setJoin(sessionId, { status: "joining", since: Date.now() });
  const timer = setTimeout(() => {
    joinTimers.delete(sessionId);
    if (snapshot.join.get(sessionId)?.status === "joining") {
      failJoin(sessionId, "connection");
    }
  }, APP_JOIN_TIMEOUT_MS);
  joinTimers.set(sessionId, timer);
}

/** Sair, from the card. The summary that follows says whether it landed. */
export function leaveAppSession(sessionId: string): boolean {
  return transport?.sendLeave(sessionId) ?? false;
}

/** Dismiss a failed join (the card went back to idle by itself on a retry). */
export function clearAppJoin(sessionId: string): void {
  if (snapshot.join.has(sessionId)) {
    commit({ join: clearJoin(snapshot.join, sessionId) });
  }
}

function joinFailureOf(code: string): AppJoinFailure | null {
  switch (code) {
    case "not-allowed":
      return "not-allowed";
    case "rate-limited":
      return "rate-limited";
    case "unavailable":
      return "unavailable";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Frames

/**
 * Feed every server frame here; it takes the ones about apps and ignores the
 * rest. Returns whether the frame was an apps frame (so a caller can stop it
 * reaching the voice controller).
 */
export function handleAppsFrame<T extends { type: string }>(frame: T): boolean {
  switch (frame.type) {
    case "channel-app": {
      const parsed = channelAppSchema.safeParse(frame);
      if (parsed.success) {
        applyChannelApp(parsed.data.channelId, parsed.data.session);
      }
      return true;
    }
    case "app-ended": {
      const parsed = appEndedSchema.safeParse(frame);
      if (parsed.success) {
        applyAppEnded(parsed.data);
      }
      return true;
    }
    case "app-session": {
      // The snapshot a participant gets once seated: the join landed.
      const parsed = appSessionSchema.safeParse(frame);
      if (parsed.success) {
        commit({ join: clearJoin(snapshot.join, parsed.data.sessionId) });
      }
      return true;
    }
    case "app-error": {
      const parsed = appErrorSchema.safeParse(frame);
      if (parsed.success && parsed.data.op === "join") {
        const code = parsed.data.code;
        const failure = joinFailureOf(code);
        if (failure) {
          failJoin(parsed.data.sessionId, failure);
        } else {
          // `full` and `ended` are not failures of the person: the summary
          // already says the room filled or the session is over.
          commit({ join: clearJoin(snapshot.join, parsed.data.sessionId) });
        }
      }
      return true;
    }
    default:
      return false;
  }
}

/** Test seam. */
export function resetAppSessionsForTests(): void {
  for (const timer of joinTimers.values()) {
    clearTimeout(timer);
  }
  joinTimers.clear();
  serverOfChannel.clear();
  frameStampOfChannel.clear();
  frameClock = 0;
  transport = null;
  joinInterceptor = null;
  paneFocuser = null;
  snapshot = emptySnapshot();
  for (const listener of [...listeners]) {
    listener();
  }
}

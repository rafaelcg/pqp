import type { WebSocket } from "ws";
import { z } from "zod";
import { retryAfterCommit } from "../apps/post-commit-retry.js";
import {
  appEndedSchema,
  appEventSchema,
  hasPermission,
  Permission,
  type AppClientFrame,
  type AppEnded,
  type AppError,
  type AppEvent,
  type AppManifest,
  type AppRole,
  type AppSession,
  type JsonValue,
} from "@pqp/shared";
import type { DbUser } from "../db.js";
import { getPool } from "../db.js";
import { appShareAllowed } from "../apps/availability.js";
import { loadPinnedManifest } from "../apps/manifests.js";
import {
  recordAppEvent,
  recordAppFrameDropped,
  recordAppJoin,
  recordAppJoinRefused,
  recordAppStateCoalesced,
  recordAppStateWrite,
} from "../apps/metrics.js";
import {
  joinSession,
  leaveSeat,
  orphanSeat,
  reclaimLiveSeat,
  readSessionSnapshotRows,
  sweepOwnParticipants,
  type SessionSnapshotRows,
} from "../apps/participants.js";
import {
  createStateWriter,
  type StatePatchItem,
  type StateWriter,
} from "../apps/state.js";
import { readLiveSummary } from "../apps/summary.js";
import {
  INSTANCE_ID,
  isBusEnabled,
  publishToCluster,
  subscribeToCluster,
} from "../lib/bus.js";
import { isEnabled } from "../lib/flags.js";
import { logEvent } from "../lib/log.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { computeMemberPermissions } from "../services/permissions.js";
import { getChannelAudience } from "../services/servers.js";
import { findTimeoutForChannel } from "../services/sanctions.js";
import { canAccessChannel } from "../services/users.js";
import {
  createCoalescer,
  encodeFrame,
  sendEncoded,
  sendEncodedDroppable,
} from "./fanout.js";
import { forEachAuthenticatedSocket, hasAuthenticatedSockets } from "./sockets.js";

/**
 * THE APPS FRAMES ON THE SOCKET, and how they cross machines.
 *
 * ROW FIRST, BUS HINT SECOND. A session lives in `app_sessions` and its
 * participants in `app_session_participants`; every instance can answer for
 * any session by reading them. So the bus carries only a HINT ("this channel's
 * summary changed", "the roster changed", "the state is at revision N", "this
 * session ended") and the instance that hears it reads the rows and tells ITS
 * OWN sockets. A hint that is lost costs the other instance's audience a moment
 * of staleness until the next change or until the client's own reconnect
 * refetch (`GET /api/servers/:id/app-sessions`), never a wrong state
 * (pitfalls 12, 13 and 19). The one frame that is NOT a hint is `app-event`: it
 * is ephemeral and stored nowhere, so the frame itself crosses (at most 1 KB,
 * inside one NOTIFY).
 *
 * Frames:
 *  - `channel-app`: the summary, to every socket whose account can VIEW the
 *    channel (D13), which is wider than the sockets looking at it, so it is not
 *    a channel-presence fan-out and is absent from `CHAT_SERVER_MESSAGE_TYPES`.
 *  - `app-session`: a snapshot (seat, state, roster) to the socket that joined,
 *    and again to every seated socket when the roster changes.
 *  - `app-state`, `app-event`, `app-ended`: to the sockets seated in a session.
 *  - `app-error`: to the one socket whose frame was refused.
 *
 * Nothing here is part of the `/ws` welcome catch-up: a client asks the HTTP
 * list on server open and on reconnect (pitfall 22).
 */

const CHANNEL_APP_TOPIC = "apps.channel";
const SESSION_ENDED_TOPIC = "apps.ended";
const ROSTER_TOPIC = "apps.roster";
const STATE_TOPIC = "apps.state";
const EVENT_TOPIC = "apps.event";

/** Joins and leaves change a count; one summary per window is plenty. */
export const APP_SUMMARY_COALESCE_MS = 250;
/** A roster change reaches the seated sockets once per window. */
export const APP_ROSTER_COALESCE_MS = 250;
/** How often a process looks over the participant rows it owns. */
export const APP_PARTICIPANT_SWEEP_MS = 15_000;

const channelHintSchema = z.object({
  channelId: z.string().uuid(),
  immediate: z.boolean().optional(),
});
const endedHintSchema = z.object({ frame: appEndedSchema });
const sessionHintSchema = z.object({ sessionId: z.string().uuid() });
const eventHintSchema = z.object({ frame: appEventSchema });

// ---------------------------------------------------------------- channel-app

const chains = new Map<string, Promise<void>>();

/** Read the summary and send it to this process's audience, once. */
async function deliverChannelAppNow(channelId: string, droppable: boolean): Promise<void> {
  // The worker holds no sockets: its part is the hint, and reading the rows to
  // tell nobody would be two queries per change for nothing.
  if (!hasAuthenticatedSockets()) {
    return;
  }
  const audience = await getChannelAudience(channelId);
  if (!audience) {
    return;
  }
  const session = await readLiveSummary(channelId);
  const payload = encodeFrame({ type: "channel-app", channelId, session });
  const send = droppable ? sendEncodedDroppable : sendEncoded;
  forEachAuthenticatedSocket((socket, user) => {
    if (audience.has(user.id)) {
      send(socket, payload);
    }
  });
}

/**
 * One delivery at a time per channel on this process, however it was asked for.
 * Each reads the rows at ITS turn, so the last frame a socket gets is always the
 * newest state: an older read can never be written after a newer one, which a
 * start or an end racing a pending coalesced window would otherwise allow.
 */
function deliverChannelApp(channelId: string, droppable: boolean): Promise<void> {
  const previous = chains.get(channelId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => deliverChannelAppNow(channelId, droppable))
    .catch((error: unknown) => {
      logEvent("apps.channelAppFailed", { channelId, error: String(error) });
    })
    .finally(() => {
      if (chains.get(channelId) === next) {
        chains.delete(channelId);
      }
    });
  chains.set(channelId, next);
  return next;
}

const summaryWindows = createCoalescer<string>(APP_SUMMARY_COALESCE_MS, (channelId) =>
  deliverChannelApp(channelId, true),
);

/**
 * Tell everyone who can view `channelId` what its live app is now (or that
 * there is none): on this process and, through a hint, on every other.
 *
 * `immediate` is for a start and an end, which people are waiting to see and
 * which must never be dropped for a slow socket. Everything else (a join, a
 * leave, a host change) is coalesced to one summary per 250 ms per channel and
 * may be dropped for a socket that is already far behind, because the next one
 * supersedes it. Safe from the worker: it has no sockets, so only the hint goes.
 */
export function announceChannelApp(
  channelId: string,
  options: { immediate?: boolean } = {},
): Promise<void> {
  const immediate = options.immediate === true;
  const local = immediate
    ? deliverChannelApp(channelId, false)
    : summaryWindows.request(channelId);
  if (isBusEnabled()) {
    publishToCluster(CHANNEL_APP_TOPIC, { channelId, ...(immediate ? { immediate } : {}) });
  }
  return local;
}

subscribeToCluster(CHANNEL_APP_TOPIC, (data) => {
  const hint = channelHintSchema.safeParse(data);
  if (!hint.success) {
    return;
  }
  // Never re-published from here: the origin guard in `bus.ts` is the other half.
  if (hint.data.immediate) {
    void deliverChannelApp(hint.data.channelId, false);
  } else {
    void summaryWindows.request(hint.data.channelId);
  }
});

// -------------------------------------------------------- the session's sockets

/** Who a socket is inside a session: the seat the app sees, never the user id. */
export interface SeatInfo {
  userId: string;
  seatId: string;
  role: AppRole;
  /** When this seat's person was last checked against the server's timeouts (ms). */
  timeoutCheckedAt?: number;
  timedOut?: boolean;
}

/** A timeout binds a seat within this long of being issued: one indexed read per seat per window. */
export const APP_TIMEOUT_RECHECK_MS = 10_000;

const UNSEATED: SeatInfo = { userId: "", seatId: "", role: "player" };

/** What the hot paths need about a session without asking the database. */
interface SessionMeta {
  serverId: string;
  channelId: string;
  appId: string;
  appVersion: string;
  manifest: AppManifest;
}

/**
 * The sockets of THIS process that are seated in a session, as the join handler
 * keeps them. An `app-ended` reaches exactly these, and every other instance's
 * own set through the hint.
 */
const sessionSockets = new Map<string, Map<WebSocket, SeatInfo>>();
const sessionMeta = new Map<string, SessionMeta>();
/** The reverse index, so a closing socket finds its sessions without a scan. */
const socketSessions = new Map<WebSocket, Set<string>>();
/** `sessionId:userId` for a join whose row is written and whose socket is not registered yet. */
const joining = new Set<string>();
/**
 * Sockets whose close handler has run. The close handler is not on the socket's
 * frame chain (`ws/index.ts` runs it from the `close` event), so a join that
 * awaits its way through a dozen reads can finish AFTER the close handler found
 * nothing to release. A socket in this set, or one no longer OPEN, must never be
 * registered as a seat's live socket: `hasLocalSocketFor` would stay true for a
 * socket that will never close again, and the ghost sweep (which judges by that
 * map, pitfall 13) would never hold the row. Weak, so it never keeps a socket alive.
 */
const closedSockets = new WeakSet<WebSocket>();

const SOCKET_OPEN = 1;

/** True once the socket has closed, or is closing, or its close handler ran. */
function socketGone(socket: WebSocket): boolean {
  return closedSockets.has(socket) || socket.readyState !== SOCKET_OPEN;
}

export function addSessionSocket(
  sessionId: string,
  socket: WebSocket,
  seat: SeatInfo = UNSEATED,
): void {
  let sockets = sessionSockets.get(sessionId);
  if (!sockets) {
    sockets = new Map();
    sessionSockets.set(sessionId, sockets);
  }
  sockets.set(socket, seat === UNSEATED ? { ...UNSEATED } : seat);
  let sessions = socketSessions.get(socket);
  if (!sessions) {
    sessions = new Set();
    socketSessions.set(socket, sessions);
  }
  sessions.add(sessionId);
}

export function removeSessionSocket(sessionId: string, socket: WebSocket): void {
  const sockets = sessionSockets.get(sessionId);
  sockets?.delete(socket);
  if (sockets && sockets.size === 0) {
    sessionSockets.delete(sessionId);
    sessionMeta.delete(sessionId);
  }
  const sessions = socketSessions.get(socket);
  sessions?.delete(sessionId);
  if (sessions && sessions.size === 0) {
    socketSessions.delete(socket);
  }
}

export function sessionSocketsOf(sessionId: string): ReadonlySet<WebSocket> {
  return new Set(sessionSockets.get(sessionId)?.keys() ?? []);
}

/** The seat a socket holds in a session on this process, if any. */
export function seatOf(sessionId: string, socket: WebSocket): SeatInfo | undefined {
  return sessionSockets.get(sessionId)?.get(socket);
}

/** Whether this process holds a socket for that person in that session. */
export function hasLocalSocketFor(sessionId: string, userId: string): boolean {
  for (const seat of sessionSockets.get(sessionId)?.values() ?? []) {
    if (seat.userId === userId) {
      return true;
    }
  }
  return false;
}

/** Forget a session's sockets and everything this process kept for it once it is over. */
export function dropSessionSockets(sessionId: string): void {
  for (const socket of sessionSockets.get(sessionId)?.keys() ?? []) {
    const sessions = socketSessions.get(socket);
    sessions?.delete(sessionId);
    if (sessions && sessions.size === 0) {
      socketSessions.delete(socket);
    }
  }
  sessionSockets.delete(sessionId);
  sessionMeta.delete(sessionId);
  lastSentRev.delete(sessionId);
  stateWriters.get(sessionId)?.dispose();
  stateWriters.delete(sessionId);
}

/**
 * `app-ended` on this process: the sockets seated in the session first, at once,
 * then every other socket whose account can VIEW the channel (D13: the card on
 * everybody's timeline turns into the quiet record, with the reason and the
 * summary, whether they were in the session or not).
 */
async function deliverEndedLocally(frame: AppEnded): Promise<void> {
  const payload = encodeFrame(frame);
  const seated = sessionSocketsOf(frame.sessionId);
  for (const socket of seated) {
    sendEncoded(socket, payload);
  }
  dropSessionSockets(frame.sessionId);
  if (!hasAuthenticatedSockets()) {
    return;
  }
  // Seated sockets already have the frame. The rest of the channel's viewers
  // need the audience, and a lookup that fails must not leave every viewer's
  // card live: it is tried once here and, when that fails (a pool blip, or the
  // database gone for a while), kept trying in the background by
  // `retryAfterCommit`, past an open breaker, instead of being read as an
  // empty audience.
  const fanOut = async () => {
    // a failed read throws and is retried; null means the channel no longer exists,
    // so there is nobody left to tell
    const audience = await getChannelAudience(frame.channelId);
    if (!audience) {
      return;
    }
    forEachAuthenticatedSocket((socket, user) => {
      if (!seated.has(socket) && audience.has(user.id)) {
        sendEncoded(socket, payload);
      }
    });
  };
  try {
    await fanOut();
  } catch (error) {
    logEvent("apps.endedAudienceFailed", { sessionId: frame.sessionId, attempt: 0, error: String(error) });
    void retryAfterCommit(fanOut, {
      event: "apps.endedAudienceFailed",
      key: `ended:${frame.sessionId}`,
      fields: { sessionId: frame.sessionId },
    });
  }
}

/** `app-ended` to the participants of the session and to the channel's viewers, on every instance. */
export async function announceAppEnded(frame: AppEnded): Promise<void> {
  const local = deliverEndedLocally(frame).catch((error: unknown) => {
    logEvent("apps.endedFailed", { sessionId: frame.sessionId, error: String(error) });
  });
  if (isBusEnabled()) {
    publishToCluster(SESSION_ENDED_TOPIC, { frame });
  }
  await local;
}

subscribeToCluster(SESSION_ENDED_TOPIC, (data) => {
  const hint = endedHintSchema.safeParse(data);
  if (hint.success) {
    void deliverEndedLocally(hint.data.frame).catch((error: unknown) => {
      logEvent("apps.endedFailed", { error: String(error) });
    });
  }
});

// ------------------------------------------------------------- the roster

function toSnapshot(
  rows: SessionSnapshotRows,
  seat: { seatId: string; role: AppRole; userId: string },
  liveUsers: ReadonlySet<string>,
): AppSession {
  return {
    type: "app-session",
    sessionId: "",
    seatId: seat.seatId,
    role: seat.role,
    isHost: rows.hostUserId === seat.userId,
    state: { rev: rows.stateRev, value: rows.state as JsonValue },
    participants: rows.participants.map((p) => ({
      seatId: p.seatId,
      userId: p.userId,
      role: p.role,
      isHost: rows.hostUserId === p.userId,
      connection:
        p.orphanedAt === null || liveUsers.has(p.userId)
          ? ("present" as const)
          : ("reconnecting" as const),
    })),
  };
}

/** Send one socket the session's snapshot, for the seat it holds. */
function sendSnapshot(
  socket: WebSocket,
  sessionId: string,
  rows: SessionSnapshotRows,
  seat: SeatInfo,
  liveUsers: ReadonlySet<string>,
  droppable = false,
): void {
  const mine = rows.participants.find((p) => p.userId === seat.userId);
  if (!mine) {
    return;
  }
  const frame = toSnapshot(
    rows,
    { seatId: mine.seatId, role: mine.role, userId: seat.userId },
    liveUsers,
  );
  frame.sessionId = sessionId;
  (droppable ? sendEncodedDroppable : sendEncoded)(socket, encodeFrame(frame));
}

/**
 * Bring the sockets of this process that are seated in `sessionId` up to what
 * the rows say. Also where a seat is reconciled against the sockets: a socket
 * whose person no longer has a seat (they left from a tab on the other machine)
 * is dropped, and a person this process holds a live socket for whose seat was
 * stamped as held (a tab on the other machine closed) takes the seat back.
 */
async function deliverRosterNow(sessionId: string): Promise<void> {
  const sockets = sessionSockets.get(sessionId);
  if (!sockets || sockets.size === 0) {
    return;
  }
  const rows = await readSessionSnapshotRows(sessionId);
  if (!rows) {
    return;
  }
  const byUser = new Map(rows.participants.map((p) => [p.userId, p]));
  const liveUsers = new Set<string>();
  for (const [socket, seat] of [...sockets]) {
    // A socket that is already gone is evidence of nothing: it is released the
    // way its close would have, and never counted as live or allowed to take a
    // held seat back.
    if (socketGone(socket)) {
      await handleAppSocketClose(socket);
      continue;
    }
    const row = byUser.get(seat.userId);
    if (!row) {
      removeSessionSocket(sessionId, socket);
      continue;
    }
    liveUsers.add(seat.userId);
    if (row.orphanedAt !== null) {
      await reclaimLiveSeat(sessionId, seat.userId, INSTANCE_ID).catch(() => false);
      // The socket may have closed while the write was in flight: its close
      // found the seat already held (nothing to stamp) and the reclaim then
      // cleared the hold. Hold it again, unless the person has another socket.
      if (socketGone(socket)) {
        liveUsers.delete(seat.userId);
        await handleAppSocketClose(socket);
      }
    }
  }
  for (const [socket, seat] of sessionSockets.get(sessionId) ?? []) {
    sendSnapshot(socket, sessionId, rows, seat, liveUsers, true);
  }
}

const rosterChains = new Map<string, Promise<void>>();

function deliverRoster(sessionId: string): Promise<void> {
  const previous = rosterChains.get(sessionId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => deliverRosterNow(sessionId))
    .catch((error: unknown) => {
      logEvent("apps.rosterFailed", { sessionId, error: String(error) });
    })
    .finally(() => {
      if (rosterChains.get(sessionId) === next) {
        rosterChains.delete(sessionId);
      }
    });
  rosterChains.set(sessionId, next);
  return next;
}

const rosterWindows = createCoalescer<string>(APP_ROSTER_COALESCE_MS, (sessionId) =>
  deliverRoster(sessionId),
);

/**
 * The roster of a session changed (somebody joined, left, was held or came
 * back): every seated socket, on every instance, gets the snapshot again, and
 * the channel's viewers a fresh summary. Both coalesced.
 */
export function announceRoster(sessionId: string, channelId: string): void {
  void rosterWindows.request(sessionId);
  void announceChannelApp(channelId);
  if (isBusEnabled()) {
    publishToCluster(ROSTER_TOPIC, { sessionId });
  }
}

subscribeToCluster(ROSTER_TOPIC, (data) => {
  const hint = sessionHintSchema.safeParse(data);
  if (hint.success) {
    void rosterWindows.request(hint.data.sessionId);
  }
});

// ------------------------------------------------------------------- the state

/** The newest revision this process has sent for a session, so an older read never follows a newer. */
const lastSentRev = new Map<string, number>();
const stateWriters = new Map<string, StateWriter>();

function sendStateLocally(sessionId: string, rev: number, value: JsonValue): void {
  const last = lastSentRev.get(sessionId);
  if (last !== undefined && rev <= last) {
    return;
  }
  lastSentRev.set(sessionId, rev);
  const sockets = sessionSockets.get(sessionId);
  if (!sockets || sockets.size === 0) {
    return;
  }
  const payload = encodeFrame({ type: "app-state", sessionId, rev, value });
  for (const socket of sockets.keys()) {
    sendEncoded(socket, payload);
  }
}

const stateChains = new Map<string, Promise<void>>();

/** A write committed elsewhere: read the row and bring this process's sockets to it. */
function deliverStateFromRow(sessionId: string): Promise<void> {
  const previous = stateChains.get(sessionId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      if (!sessionSockets.get(sessionId)?.size) {
        return;
      }
      const result = await getPool().query<{ state: JsonValue; state_rev: string }>(
        `SELECT state, state_rev FROM app_sessions WHERE id = $1 AND status = 'live'`,
        [sessionId],
      );
      const row = result.rows[0];
      if (row) {
        sendStateLocally(sessionId, Number(row.state_rev), row.state);
      }
    })
    .catch((error: unknown) => {
      logEvent("apps.stateReadFailed", { sessionId, error: String(error) });
    })
    .finally(() => {
      if (stateChains.get(sessionId) === next) {
        stateChains.delete(sessionId);
      }
    });
  stateChains.set(sessionId, next);
  return next;
}

subscribeToCluster(STATE_TOPIC, (data) => {
  const hint = sessionHintSchema.safeParse(data);
  if (hint.success) {
    void deliverStateFromRow(hint.data.sessionId);
  }
});

function sendError(
  socket: WebSocket,
  sessionId: string,
  op: AppError["op"],
  code: AppError["code"],
): void {
  const frame: AppError = { type: "app-error", sessionId, op, code };
  sendEncoded(socket, encodeFrame(frame));
}

function writerFor(sessionId: string, meta: SessionMeta): StateWriter {
  let writer = stateWriters.get(sessionId);
  if (!writer) {
    writer = createStateWriter({
      manifest: meta.manifest,
      sessionId,
      now: Date.now,
      schedule: (run, delayMs) => {
        const handle = setTimeout(run, delayMs);
        handle.unref?.();
        return handle;
      },
      cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
      committed: (id, rev, value) => {
        recordAppStateWrite();
        sendStateLocally(id, rev, value);
        if (isBusEnabled()) {
          publishToCluster(STATE_TOPIC, { sessionId: id });
        }
      },
      refused: (item, code) => {
        recordAppFrameDropped(code === "rate-limited" ? "state-rate" : `state-${code}`);
        sendError(item.socket as WebSocket, sessionId, "state", code);
      },
      onCoalesced: recordAppStateCoalesced,
    });
    stateWriters.set(sessionId, writer);
  }
  return writer;
}

// ------------------------------------------------------------------- the events

const eventLimiters = new Map<string, ReturnType<typeof createRateLimiter>>();
/** One refusal notice per seat per second, so a flooder is not answered at flood rate. */
const eventErrorLimiter = createRateLimiter({ capacity: 1, refillPerSecond: 1 });

function eventLimiterFor(meta: SessionMeta) {
  const key = `${meta.appId}\u0000${meta.appVersion}`;
  let limiter = eventLimiters.get(key);
  if (!limiter) {
    const perSecond = Math.max(1, meta.manifest.events.maxPerSecond);
    limiter = createRateLimiter({ capacity: perSecond, refillPerSecond: perSecond });
    eventLimiters.set(key, limiter);
  }
  return limiter;
}

function deliverEventLocally(frame: AppEvent): void {
  const sockets = sessionSockets.get(frame.sessionId);
  if (!sockets || sockets.size === 0) {
    return;
  }
  const payload = encodeFrame(frame);
  for (const [socket, seat] of sockets) {
    // The other seats: an app is not told about its own seat's events.
    if (seat.seatId !== frame.fromSeatId) {
      sendEncodedDroppable(socket, payload);
    }
  }
}

subscribeToCluster(EVENT_TOPIC, (data) => {
  const hint = eventHintSchema.safeParse(data);
  if (hint.success) {
    deliverEventLocally(hint.data.frame);
  }
});

// -------------------------------------------------------------- client frames

const joinLimiter = createRateLimiter({ capacity: 10, refillPerSecond: 1 });

interface JoinContext {
  serverId: string;
  channelId: string;
  channelType: string;
  appId: string;
  appVersion: string;
  status: string;
}

async function readJoinContext(sessionId: string): Promise<JoinContext | null> {
  const result = await getPool().query<{
    server_id: string;
    channel_id: string;
    channel_type: string;
    app_id: string;
    app_version: string;
    status: string;
  }>(
    `SELECT s.server_id, s.channel_id, c.type AS channel_type, s.app_id, s.app_version, s.status
       FROM app_sessions s JOIN channels c ON c.id = s.channel_id
      WHERE s.id = $1`,
    [sessionId],
  );
  const row = result.rows[0];
  return row
    ? {
        serverId: row.server_id,
        channelId: row.channel_id,
        channelType: row.channel_type,
        appId: row.app_id,
        appVersion: row.app_version,
        status: row.status,
      }
    : null;
}

function refuseJoin(socket: WebSocket, sessionId: string, code: AppError["code"]): void {
  recordAppJoinRefused(code);
  sendError(socket, sessionId, "join", code);
}

async function handleJoin(
  socket: WebSocket,
  user: DbUser,
  frame: Extract<AppClientFrame, { type: "app-join" }>,
): Promise<void> {
  const { sessionId } = frame;
  // Before any database read: an excess join, for a session that exists or not,
  // costs nothing but the counter. It is dropped without an answer, because
  // answering would tell a flag-off server's caller that something is there.
  if (!joinLimiter.take(user.id)) {
    recordAppFrameDropped("join-rate");
    return;
  }
  const ctx = await readJoinContext(sessionId);
  // A session that does not exist, or whose server has the platform off, is
  // answered with nothing at all: with the flag off no frame is sent.
  if (!ctx || !isEnabled("apps", { serverId: ctx.serverId })) {
    return;
  }
  // D13: joining needs VIEW_CHANNEL, plus CONNECT in a voice channel (an app is
  // taken part in like a share is watched, from a seat in the call). A manifest
  // may raise that floor and never lower it.
  if (!(await canAccessChannel(ctx.channelId, user.id))) {
    refuseJoin(socket, sessionId, "not-allowed");
    return;
  }
  if (ctx.status !== "live") {
    refuseJoin(socket, sessionId, "ended");
    return;
  }
  const manifest = await loadPinnedManifest(ctx.appId, ctx.appVersion);
  if (!manifest) {
    refuseJoin(socket, sessionId, "not-allowed");
    return;
  }
  const permissions = await computeMemberPermissions(ctx.serverId, user.id, ctx.channelId);
  const needsConnect = ctx.channelType === "voice" || manifest.requires.join === "CONNECT";
  if (needsConnect && !hasPermission(permissions, Permission.CONNECT)) {
    refuseJoin(socket, sessionId, "not-allowed");
    return;
  }
  // A person under a timeout may watch and may not act: they are seated as a
  // spectator, who can neither write state nor send events.
  const timedOut = (await findTimeoutForChannel(user.id, ctx.channelId)) !== null;

  // The socket may have closed during the reads above (a reload right after
  // `app-join`, a deploy drain): write no seat for a socket that is gone.
  if (socketGone(socket)) {
    recordAppFrameDropped("join-socket-gone");
    return;
  }
  const joinKey = `${sessionId}:${user.id}`;
  joining.add(joinKey);
  let outcome;
  let socketLeft = false;
  try {
    outcome = await joinSession({
      sessionId,
      userId: user.id,
      instanceId: INSTANCE_ID,
      manifest,
      asSpectator: frame.asSpectator === true || timedOut,
      forceSpectator: timedOut,
      // D14: an emulator app admits spectators only where `locadora_share` is on.
      spectatorsAllowed: appShareAllowed(ctx.serverId, manifest),
    });
    // Checked AFTER the row write, the last await, and acted on with no await
    // between the check and the registration: the close handler runs outside
    // this socket's frame chain, so a close during `joinSession` has already
    // looked for this socket in the map, found nothing and returned.
    if (outcome.ok && socketGone(socket)) {
      socketLeft = true;
    } else if (outcome.ok) {
      sessionMeta.set(sessionId, {
        serverId: ctx.serverId,
        channelId: ctx.channelId,
        appId: ctx.appId,
        appVersion: ctx.appVersion,
        manifest,
      });
      addSessionSocket(sessionId, socket, {
        userId: user.id,
        seatId: outcome.seatId,
        role: outcome.role,
      });
    }
  } finally {
    joining.delete(joinKey);
  }
  if (outcome.ok && socketLeft) {
    // The row says seated and no socket will ever hold it: hold it for the
    // resume window exactly as the close would have, unless the person has
    // another socket seated here (then that one is the seat's evidence).
    recordAppFrameDropped("join-socket-gone");
    if (!hasLocalSocketFor(sessionId, user.id)) {
      try {
        if (await orphanSeat(sessionId, user.id, INSTANCE_ID)) {
          announceRoster(sessionId, ctx.channelId);
        }
      } catch (error) {
        logEvent("apps.orphanFailed", { sessionId, error: String(error) });
      }
    }
    return;
  }
  if (!outcome.ok) {
    refuseJoin(socket, sessionId, outcome.code);
    return;
  }
  recordAppJoin();

  // The snapshot goes to the joiner at once; everybody else hears of it in the
  // coalesced roster, and the channel's viewers in the coalesced summary.
  // The seat is committed and the socket registered: a read that fails now must
  // not report the join as failed. The roster below reaches this socket too.
  try {
    const rows = await readSessionSnapshotRows(sessionId);
    const seat = seatOf(sessionId, socket);
    if (rows && seat) {
      seat.timeoutCheckedAt = Date.now();
      seat.timedOut = timedOut;
      sendSnapshot(socket, sessionId, rows, seat, new Set([user.id]));
    }
  } catch (error) {
    logEvent("apps.joinSnapshotUnread", { sessionId, error: String(error) });
  }
  announceRoster(sessionId, ctx.channelId);
}

async function handleLeave(
  user: DbUser,
  frame: Extract<AppClientFrame, { type: "app-leave" }>,
): Promise<void> {
  const { sessionId } = frame;
  const meta = sessionMeta.get(sessionId);
  const ctx = meta ?? (await readJoinContext(sessionId));
  if (!ctx || !isEnabled("apps", { serverId: ctx.serverId })) {
    return;
  }
  // The row first: if it cannot be written the person is still seated here and
  // is told so. Then the person leaves, not one tab: every socket of theirs on
  // this process stops being seated, and the other machine's drop out at the
  // next roster.
  const released = await leaveSeat(sessionId, user.id);
  for (const [other, seat] of [...(sessionSockets.get(sessionId) ?? [])]) {
    if (seat.userId === user.id) {
      removeSessionSocket(sessionId, other);
    }
  }
  if (released) {
    announceRoster(sessionId, ctx.channelId);
  }
}

/**
 * Whether a seat's person is under a timeout now. A timeout can be issued after
 * the person joined, so the answer is re-asked: at most once per window per
 * seat, from memory in between (a frame at the event cap costs no read).
 */
async function seatTimedOut(seat: SeatInfo, channelId: string): Promise<boolean> {
  const now = Date.now();
  if (seat.timeoutCheckedAt !== undefined && now - seat.timeoutCheckedAt < APP_TIMEOUT_RECHECK_MS) {
    return seat.timedOut === true;
  }
  seat.timeoutCheckedAt = now;
  seat.timedOut = (await findTimeoutForChannel(seat.userId, channelId)) !== null;
  return seat.timedOut;
}

async function handleStatePatch(
  socket: WebSocket,
  frame: Extract<AppClientFrame, { type: "app-state-patch" }>,
): Promise<void> {
  const { sessionId } = frame;
  const seat = seatOf(sessionId, socket);
  const meta = sessionMeta.get(sessionId);
  // Silent, like `app-event-send`: an unseated socket has no session on this
  // process to read the flag from, so answering would tell a flag-off server's
  // caller (or anyone guessing a session id) that something is there.
  if (!seat || !meta) {
    recordAppFrameDropped("state-unseated");
    return;
  }
  if (!isEnabled("apps", { serverId: meta.serverId })) {
    return;
  }
  if (await seatTimedOut(seat, meta.channelId)) {
    recordAppFrameDropped("state-timed-out");
    sendError(socket, sessionId, "state", "not-allowed");
    return;
  }
  writerFor(sessionId, meta).submit({
    userId: seat.userId,
    role: seat.role,
    baseRev: frame.baseRev,
    patch: frame.patch,
    socket,
  } satisfies StatePatchItem);
}

async function handleEventSend(
  socket: WebSocket,
  frame: Extract<AppClientFrame, { type: "app-event-send" }>,
): Promise<void> {
  const { sessionId } = frame;
  const seat = seatOf(sessionId, socket);
  const meta = sessionMeta.get(sessionId);
  if (!seat || !meta || !isEnabled("apps", { serverId: meta.serverId })) {
    recordAppFrameDropped("event-unseated");
    return;
  }
  const caps = meta.manifest.events;
  // A spectator watches: they send nothing. An app that declares no events takes none.
  if (seat.role !== "player" || caps.maxPerSecond === 0) {
    recordAppFrameDropped("event-not-allowed");
    sendError(socket, sessionId, "event", "not-allowed");
    return;
  }
  if (await seatTimedOut(seat, meta.channelId)) {
    recordAppFrameDropped("event-timed-out");
    if (eventErrorLimiter.take(`${sessionId}:${seat.seatId}`)) {
      sendError(socket, sessionId, "event", "not-allowed");
    }
    return;
  }
  if (Buffer.byteLength(JSON.stringify(frame.data), "utf8") > caps.maxBytes) {
    recordAppFrameDropped("event-size");
    sendError(socket, sessionId, "event", "too-large");
    return;
  }
  if (!eventLimiterFor(meta).take(`${sessionId}:${seat.seatId}`)) {
    recordAppFrameDropped("event-rate");
    if (eventErrorLimiter.take(`${sessionId}:${seat.seatId}`)) {
      sendError(socket, sessionId, "event", "rate-limited");
    }
    return;
  }
  recordAppEvent();
  // Relayed, never stored and never logged: only the counters above know it happened.
  const out: AppEvent = {
    type: "app-event",
    sessionId,
    fromSeatId: seat.seatId,
    name: frame.name,
    data: frame.data,
  };
  deliverEventLocally(out);
  if (isBusEnabled()) {
    publishToCluster(EVENT_TOPIC, { frame: out });
  }
}

/** The apps frames a client may send, as `handleChatMessage` routes them. */
export function isAppClientFrame(frame: { type: string }): frame is AppClientFrame {
  return (
    frame.type === "app-join" ||
    frame.type === "app-leave" ||
    frame.type === "app-state-patch" ||
    frame.type === "app-event-send"
  );
}

export async function handleAppFrame(
  socket: WebSocket,
  user: DbUser,
  frame: AppClientFrame,
): Promise<void> {
  try {
    switch (frame.type) {
      case "app-join":
        await handleJoin(socket, user, frame);
        return;
      case "app-leave":
        await handleLeave(user, frame);
        return;
      case "app-state-patch":
        await handleStatePatch(socket, frame);
        return;
      case "app-event-send":
        await handleEventSend(socket, frame);
        return;
    }
  } catch (error) {
    // The database (or the breaker) failed under a frame: say so to its sender
    // rather than leave it waiting, and never throw into the socket loop.
    logEvent("apps.frameFailed", { type: frame.type, error: String(error) });
    sendError(
      socket,
      frame.sessionId,
      frame.type === "app-join" ? "join" : frame.type === "app-leave" ? "leave" : frame.type === "app-state-patch" ? "state" : "event",
      "unavailable",
    );
  }
}

/**
 * A socket closed. For each session it was seated in: if the person has no other
 * socket seated here, the seat is HELD for the resume window (a reload comes back
 * to it) and everybody hears the person is reconnecting.
 */
export async function handleAppSocketClose(socket: WebSocket): Promise<void> {
  // First and synchronous, before any await: a join still in flight on this
  // socket reads it at its own check and releases what it wrote.
  closedSockets.add(socket);
  const sessions = socketSessions.get(socket);
  if (!sessions) {
    return;
  }
  for (const sessionId of [...sessions]) {
    const seat = seatOf(sessionId, socket);
    const channelId = sessionMeta.get(sessionId)?.channelId;
    removeSessionSocket(sessionId, socket);
    if (!seat || hasLocalSocketFor(sessionId, seat.userId)) {
      continue;
    }
    try {
      if (await orphanSeat(sessionId, seat.userId, INSTANCE_ID)) {
        if (channelId) {
          announceRoster(sessionId, channelId);
        }
      }
    } catch (error) {
      logEvent("apps.orphanFailed", { sessionId, error: String(error) });
    }
  }
}

// ----------------------------------------------------------------------- sweep

/**
 * One pass over the participant rows THIS process owns (pitfall 13): ghosts held
 * for the window, held seats past it released. Exported for the tests.
 */
export async function sweepOwnAppParticipants(
  options: { now?: Date; holdMs?: number } = {},
): Promise<{ orphaned: number; released: number }> {
  const result = await sweepOwnParticipants({
    instanceId: INSTANCE_ID,
    ...(options.now ? { now: options.now } : {}),
    ...(options.holdMs !== undefined ? { holdMs: options.holdMs } : {}),
    isLive: hasLocalSocketFor,
    isJoining: (sessionId, userId) => joining.has(`${sessionId}:${userId}`),
  });
  const channels = new Map<string, string>();
  for (const entry of [...result.orphaned, ...result.released]) {
    channels.set(entry.sessionId, entry.channelId);
  }
  for (const [sessionId, channelId] of channels) {
    announceRoster(sessionId, channelId);
  }
  return { orphaned: result.orphaned.length, released: result.released.length };
}

/** The 15 s sweep of this process's own participant rows. API process only. */
export function startAppParticipantSweep(): () => void {
  const timer = setInterval(() => {
    void sweepOwnAppParticipants().catch((error: unknown) => {
      logEvent("apps.sweepFailed", { error: String(error) });
    });
  }, APP_PARTICIPANT_SWEEP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Tests: forget every pending window and socket. */
export function resetAppsWsForTests(): void {
  summaryWindows.reset();
  rosterWindows.reset();
  chains.clear();
  rosterChains.clear();
  stateChains.clear();
  sessionSockets.clear();
  sessionMeta.clear();
  socketSessions.clear();
  joining.clear();
  lastSentRev.clear();
  for (const writer of stateWriters.values()) {
    writer.dispose();
  }
  stateWriters.clear();
  eventLimiters.clear();
  eventErrorLimiter.reset();
  joinLimiter.reset();
}

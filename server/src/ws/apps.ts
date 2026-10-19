import type { WebSocket } from "ws";
import { z } from "zod";
import { appEndedSchema, type AppEnded } from "@pqp/shared";
import { retryAfterCommit } from "../apps/post-commit-retry.js";
import { readLiveSummary } from "../apps/summary.js";
import { isBusEnabled, publishToCluster, subscribeToCluster } from "../lib/bus.js";
import { logEvent } from "../lib/log.js";
import { getChannelAudience } from "../services/servers.js";
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
 * summary changed", "this session ended") and the instance that hears it reads
 * the rows and tells ITS OWN sockets. A hint that is lost costs the other
 * instance's audience a moment of staleness until the next change or until the
 * client's own reconnect refetch (`GET /api/servers/:id/app-sessions`), never
 * a wrong state (pitfalls 12, 13 and 19).
 *
 * `channel-app`: the summary, to every socket whose account can VIEW the
 * channel (D13), which is wider than the sockets looking at it, so it is not a
 * channel-presence fan-out and is absent from `CHAT_SERVER_MESSAGE_TYPES`.
 * `app-ended`: to the sockets seated in the session on each instance.
 *
 * Nothing here is part of the `/ws` welcome catch-up: a client asks the HTTP
 * list on server open and on reconnect (pitfall 22).
 */

const CHANNEL_APP_TOPIC = "apps.channel";
const SESSION_ENDED_TOPIC = "apps.ended";

/** Joins and leaves change a count; one summary per window is plenty. */
export const APP_SUMMARY_COALESCE_MS = 250;

const channelHintSchema = z.object({
  channelId: z.string().uuid(),
  immediate: z.boolean().optional(),
});
const endedHintSchema = z.object({ frame: appEndedSchema });

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

/**
 * The sockets of THIS process that are seated in a session, as the join handler
 * (P2-C) keeps them. An `app-ended` reaches exactly these, and every other
 * instance's own set through the hint below.
 */
const sessionSockets = new Map<string, Set<WebSocket>>();

export function addSessionSocket(sessionId: string, socket: WebSocket): void {
  let sockets = sessionSockets.get(sessionId);
  if (!sockets) {
    sockets = new Set();
    sessionSockets.set(sessionId, sockets);
  }
  sockets.add(socket);
}

export function removeSessionSocket(sessionId: string, socket: WebSocket): void {
  const sockets = sessionSockets.get(sessionId);
  if (!sockets) {
    return;
  }
  sockets.delete(socket);
  if (sockets.size === 0) {
    sessionSockets.delete(sessionId);
  }
}

export function sessionSocketsOf(sessionId: string): ReadonlySet<WebSocket> {
  return sessionSockets.get(sessionId) ?? new Set();
}

/** Forget a session's sockets once it is over. */
export function dropSessionSockets(sessionId: string): void {
  sessionSockets.delete(sessionId);
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

/** Tests: forget every pending window and socket. */
export function resetAppsWsForTests(): void {
  summaryWindows.reset();
  chains.clear();
  sessionSockets.clear();
}

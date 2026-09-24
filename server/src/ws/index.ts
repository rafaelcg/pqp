import type { WebSocket } from "ws";
import { CHAT_CLIENT_MESSAGE_TYPES } from "@pqp/shared";
import { DEV_AUTH_TOKEN, isDevAuthBypassEnabled, resolveAuthUser } from "../auth/clerk.js";
import { logEvent, nextConnectionId } from "../lib/log.js";
import { createRateLimiter, limitFromEnv } from "../lib/rate-limit.js";
import { handleChatMessage } from "./chat.js";
import { recordUserCountry } from "../voice/region-audience.js";
import { socketCountry } from "../voice/regions.js";
import { createFrameBudget } from "./frame-budget.js";
import {
  deleteAuthenticatedSocket,
  getAuthenticatedSocket,
  getSocketUser,
  setAuthenticatedSocket,
} from "./sockets.js";
import {
  registerStatusSocket,
  unregisterStatusSocket,
} from "./status.js";
import {
  catchUpWatchParties,
  onHostSocketClosed,
  onHostSocketOpened,
} from "./watch-party-events.js";
import {
  handleVoiceMessage,
  isSocketInVoice,
  removeVoicePeerBySocket,
  sendAllVoiceRosters,
} from "./voice.js";

export { forEachAuthenticatedSocket, getSocketUser } from "./sockets.js";
export {
  broadcastMessageDeleted,
  broadcastProfileUpdate,
  broadcastToChannel,
  evictChannelViewers,
  evictUserFromChannels,
  notifyPermissionsUpdate,
  notifyCommunityHomeUpdate,
  applyAutomodEffects,
  postChannelMessage,
  resolveEmbedInBackground,
  startClusterPresenceRefresh,
  takeMessageBudget,
} from "./chat.js";
export {
  applyManualStatus,
  resolveStatus,
  resolveStatuses,
  startClusterStatusRefresh,
} from "./status.js";
export {
  cancelPrivateVoiceResweep,
  evictVoiceChannel,
  evictVoiceUser,
  evictVoiceUsersExcept,
  refreshVoiceIdentity,
} from "./voice.js";

const AUTH_TIMEOUT_MS = 10_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Derived from `chatClientMessageSchema`, never hand-written. A frame type this
 * router does not know about is dropped silently, so a list maintained here
 * separately from the protocol is a list that eventually loses a feature: it
 * lost `thread-join` / `thread-leave`, and then `poll-vote` / `poll-close`,
 * which is why a poll vote looked cast and was gone on the next history read.
 * `set-idle` rides along because it is validated by the same schema.
 */
const CHAT_MESSAGE_TYPES = new Set<string>(CHAT_CLIENT_MESSAGE_TYPES);

const VOICE_MESSAGE_TYPES = new Set<string>([
  "join-voice-room",
  "leave-voice-room",
  "set-sharing-screen",
  "offer",
  "answer",
  "ice-candidate",
  // --- conversation calls ---
  "call-ring",
  "call-decline",
  "set-camera",
  // --- voice state ---
  "set-voice-state",
  // --- raised hands ---
  // Missing from this hand-kept list from the day the feature shipped (#406):
  // `voiceClientMessageSchema` in @pqp/shared accepted the frame, and
  // `handleVoiceMessage`/`voice-raised-hands.test.ts` call straight into the
  // handler and never through this router, so nothing caught that every real
  // `set-raised-hand` frame was dropped right here before reaching it. A
  // browser's hand went up for exactly `HAND_ECHO_MS` (the client's own
  // optimistic guess) and then silently fell back down with no server ever
  // having seen it. See the routing doc comment above.
  "set-raised-hand",
  // --- watch party ---
  // A watch party lives inside a voice room, so its one client frame is routed
  // to the voice handler like every other thing said inside one.
  "set-watch-party",
  // --- music queue ---
  // Same reasoning: the queue is a thing said inside the room.
  "set-music",
  "set-music-listening",
  // --- live reactions ---
  // Same reasoning as the line above: a reaction is something said inside a
  // voice room, over the share that room is watching.
  "live-reaction",
  // --- live HLS watch mode ---
  // A viewer without a seat, counted by the voice handler because that is
  // where the stream and the room live.
  "watch-live",
  // --- LIVE_HLS_VOICE_TRACK ---
  // The presenter's own word for "separada", read alongside their
  // `voice-track` publication by `reconcileCameraEgress`.
  "set-voice-track-mode",
]);

/** Every frame type this router acts on, for the flood log's summary. */
const ROUTED_FRAME_TYPES: ReadonlySet<string> = new Set<string>([
  "auth",
  "ping",
  ...CHAT_MESSAGE_TYPES,
  ...VOICE_MESSAGE_TYPES,
]);

/**
 * Backstop against a hostile socket flooding the parse loop. Keyed by address,
 * which behind a proxy without `TRUST_PROXY` is shared by every client — so it
 * is deliberately coarse. The per-user limits in the chat and voice handlers do
 * the real work.
 *
 * Tunable, defaults unchanged, for the measurement reason spelled out on
 * `anonLimiter` in api/index.ts: every client of a load harness arrives from
 * one address and sends three frames on arrival (`auth`, `join-channel`,
 * `join-voice-room`), so at the default 200/s this bucket caps the *harness* at
 * roughly 66 arrivals a second and closes the rest with 4429. Leaving it there
 * measures this line rather than the join path. See docs/STAGING.md.
 */
const socketLimiter = createRateLimiter({
  capacity: limitFromEnv("RATE_LIMIT_SOCKET_CAPACITY", 600),
  refillPerSecond: limitFromEnv("RATE_LIMIT_SOCKET_REFILL", 200),
});

/** Sockets that have not answered our last ping. */
const alive = new WeakMap<WebSocket, boolean>();

/** Consecutive pings a socket has failed to answer. Reset by any pong. */
const missedPongs = new WeakMap<WebSocket, number>();

/**
 * How many pings in a row may go unanswered before the socket is reaped.
 *
 * ONE WAS TOO FEW, and the night of 2026-09-05 is the evidence. A single
 * missed pong inside one 30s interval terminated the connection, so the
 * tolerance for a phone changing cell, a moment of packet loss, or this
 * process being too busy to read the pong off the socket in time was exactly
 * zero. During the moonkase stream that reaped five distinct users a minute
 * out of ~170, and what those people saw was "caí e não consigo voltar":
 * killed mid-call, peer orphaned, rejoin, killed again.
 *
 * Two strikes buys ~60s, which covers the ordinary blips without meaningfully
 * delaying detection of a genuinely half-open socket — the case this whole
 * mechanism exists for, where no close frame ever arrives. A dead socket is
 * still gone within a minute; a live one on a bad train no longer is.
 */
export const MAX_MISSED_PONGS = 2;

/**
 * Put a socket under the heartbeat: fresh, no strikes, and answering pongs
 * clears both.
 *
 * Exported because the liveness bookkeeping and the reaper are two halves of
 * one mechanism that used to be impossible to test together — the maps are
 * module-private and were only ever populated by `handleWsConnection`, which
 * drags in rate limiters, auth timeouts and real IO. A test that cannot say
 * "this socket answered" cannot test the thing that matters here, which is
 * that an answering socket is never reaped.
 */
export function trackSocketLiveness(socket: WebSocket): void {
  alive.set(socket, true);
  missedPongs.set(socket, 0);
  socket.on("pong", () => {
    alive.set(socket, true);
    missedPongs.set(socket, 0);
  });
}

export function handleWsConnection(socket: WebSocket, remoteKey: string) {
  let authenticated = false;
  let closed = false;
  // The ordering chain `onMessage` is queued onto — see the comment on
  // `socket.on("message", ...)` below for why this exists.
  let messageChain: Promise<void> = Promise.resolve();
  const connId = nextConnectionId();
  logEvent("ws.connect", { connId });

  // Per-connection budget. The address bucket above cannot distinguish clients
  // behind a shared proxy, so the real limit has to live on the socket itself.
  // Two buckets, general and WebRTC relay: see `frame-budget.ts` for why one
  // was hanging up mesh calls.
  const frameBudget = createFrameBudget(ROUTED_FRAME_TYPES);
  // Set once this socket has been closed for flooding. Frames already in
  // flight keep arriving until the close handshake completes (91 of them on
  // one socket in production), and each used to be parsed, refused again and
  // logged again. The verdict is already in; drop them.
  let floodClosed = false;

  trackSocketLiveness(socket);

  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      logEvent("ws.authTimeout", { connId });
      socket.close(4401, "Auth timeout");
    }
  }, AUTH_TIMEOUT_MS);

  async function onMessage(data: unknown) {
    if (floodClosed) {
      return;
    }
    if (!socketLimiter.take(remoteKey)) {
      // Say so rather than dropping the frame on the floor. A silently
      // discarded message leaves the client waiting on a reply that is never
      // coming, and when the frame was `auth` it waits the full auth timeout
      // and is then closed with 4401 — which blames a credential problem for
      // what is actually backpressure. Closing here hands the client something
      // its reconnect-with-backoff already knows how to answer.
      //
      // Worth knowing why this is reachable at all: the bucket is keyed on the
      // client address, so behind a proxy without TRUST_PROXY set it is one
      // bucket shared by *every* client. A launch-day burst of legitimate
      // joins can empty it — measured at roughly 300 simultaneous joiners,
      // since each sends both an `auth` and a `join-channel`. That is an
      // argument for setting TRUST_PROXY, not for failing quietly.
      logEvent("ws.addressLimit", { connId });
      socket.close(4429, "Too many messages");
      return;
    }
    // Parsed BEFORE the per-connection budget, because the budget depends on
    // what the frame is. The address bucket above still runs first, and a
    // socket that overdraws either bucket below is closed, so the parse work a
    // flooder can buy is bounded by one bucket's burst.
    let parsed: unknown;
    let parsedOk = true;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      parsedOk = false;
    }
    const frameType =
      parsedOk && typeof parsed === "object" && parsed !== null
        ? (parsed as { type?: unknown }).type
        : undefined;
    const exhausted = frameBudget.take(
      typeof frameType === "string" ? frameType : undefined,
    );
    if (exhausted) {
      // Sustained flooding from one socket is not a client we want to keep.
      // Say which bucket and what filled it: the old line said neither, and
      // a week of them could not tell a flood from a mesh call joining.
      floodClosed = true;
      logEvent("ws.flood", {
        connId,
        userId: getSocketUser(socket)?.id,
        bucket: exhausted,
        inVoice: isSocketInVoice(socket),
        recent: frameBudget.recentSummary(),
      });
      socket.close(4429, "Too many messages");
      return;
    }
    if (!parsedOk) {
      return;
    }

    if (!authenticated) {
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as { type?: string }).type !== "auth" ||
        typeof (parsed as { token?: string }).token !== "string"
      ) {
        socket.close(4401, "Auth required");
        return;
      }

      const token = (parsed as { token: string }).token;
      // Optional wire features this build understands (`sockets.ts`).
      // Deliberately hand-parsed rather than schema-validated: `auth` has
      // never been through zod, a junk `caps` must not cost the socket its
      // connection, and an entry the server does not recognise is simply not
      // in the set. Bounded so a hostile client cannot make the server hold an
      // arbitrary list per socket.
      const declared = (parsed as { caps?: unknown }).caps;
      const caps = Array.isArray(declared)
        ? declared.filter((cap): cap is string => typeof cap === "string").slice(0, 16)
        : [];
      const authHeader =
        isDevAuthBypassEnabled() && token === DEV_AUTH_TOKEN
          ? `Bearer ${DEV_AUTH_TOKEN}`
          : `Bearer ${token}`;

      const resolved = await resolveAuthUser(authHeader);
      if (!resolved) {
        logEvent("ws.authFail", { connId });
        socket.close(4401, "Unauthorized");
        return;
      }

      // Verification is async; the socket may have closed meanwhile. Registering
      // it now would leave a dead entry in the map forever, because the close
      // handler already ran.
      if (closed || socket.readyState !== 1) {
        return;
      }

      authenticated = true;
      clearTimeout(authTimeout);
      setAuthenticatedSocket(socket, resolved.user, caps);
      // `caps` on the auth line is how an operator can tell, from the logs of
      // a real deploy, whether clients are actually negotiating a new wire
      // feature or whether the server is quietly serving everybody the old
      // frames. Empty for every build that predates the field.
      logEvent("ws.auth", {
        connId,
        userId: resolved.user.id,
        caps: caps.length > 0 ? caps.join(",") : undefined,
      });
      // Deliberately not awaited: it reads one row to find out whether this
      // account asked to be invisible or do-not-disturb, and `ready` must not
      // wait on a preference lookup. Until it resolves the socket is absent from
      // the status registry, which reads as offline — the safe direction, and
      // the reason `registerStatusSocket` resolves the manual status *before* it
      // makes the connection visible rather than after.
      void registerStatusSocket(socket, resolved.user.id).catch((error) => {
        console.error("[ws] status registration failed:", error);
      });
      // A host reconnecting stops the grace clock on their live party, and a
      // client connecting mid-show is told about every party it may see. Both
      // are fire and forget: `ready` must not wait on either, and the worst
      // case is a sidebar block that arrives with the next state change.
      // Where this account was just seen, for picking the SFU region of its
      // servers' voice rooms (`voice/region-audience.ts`). Country only,
      // throttled, never throws, and a no-op without `LIVEKIT_REGIONS`.
      void recordUserCountry(resolved.user.id, socketCountry(socket));
      void onHostSocketOpened(resolved.user.id).catch((error) => {
        console.error("[watch-party] host reconnect failed:", error);
      });
      void catchUpWatchParties(socket, resolved.user.id).catch((error) => {
        console.error("[watch-party] catch-up failed:", error);
      });
      socket.send(JSON.stringify({ type: "ready" }));
      await sendAllVoiceRosters(socket, resolved.user);
      return;
    }

    const type = (parsed as { type?: unknown }).type;
    if (typeof type !== "string") {
      return;
    }

    // Application-level keepalive. Browsers answer protocol pings transparently
    // but expose no event for it, so the client cannot detect a half-open
    // socket without a round trip it can observe.
    if (type === "ping") {
      socket.send(JSON.stringify({ type: "pong" }));
      return;
    }

    const session = getAuthenticatedSocket(socket);
    if (!session) {
      return;
    }

    if (CHAT_MESSAGE_TYPES.has(type)) {
      await handleChatMessage(session, parsed);
      return;
    }
    if (VOICE_MESSAGE_TYPES.has(type)) {
      await handleVoiceMessage(session, parsed);
    }
  }

  socket.on("message", (data) => {
    // FIFO PER SOCKET. Each `message` event used to spawn its own
    // fire-and-forget `onMessage(data)`, with no ordering guarantee between
    // two frames from the SAME connection once either one `await`s: a client
    // that sends `join-voice-room` immediately followed by `set-watch-party`
    // (the real "Ir ao vivo" flow, and every WS test harness that does not
    // wait for `welcome` before its next send) could have the second frame's
    // handler run to completion, read `socketToPeerId.get(socket)` and hit
    // the `!existingPeerId` early return, BEFORE the first frame's own
    // permission/channel-access awaits (`canAccessChannel`, `getChannel`,
    // `resolveMemberChannelPermissions`, ...) had registered the peer. The
    // write was then silently dropped: no error, no `voice.watchPartyStart`,
    // nothing a client or an operator could see. Same shape as pitfall 13 in
    // CLAUDE.md ("a fire-and-forget write is not an ordered write") and the
    // same fix as `dispatchChain` in `lib/bus-postgres.ts`: chain this
    // socket's messages onto one promise so the next frame's handler does not
    // start until the previous one has finished, in the order they arrived.
    // A throwing handler (e.g. transient DB error) must not become an
    // unhandled rejection — that kills the process and drops every client —
    // and must not wedge the chain for every later frame on this socket.
    //
    // EXCEPT THE KEEPALIVE. A `ping` orders against nothing, and queueing it
    // behind a frame whose handler is waiting on Postgres (a `set-voice-state`
    // awaiting its roster read while the pool times out, before the breaker
    // has opened) is how a socket that is perfectly alive misses the pongs
    // the client counts, and hangs itself up in the middle of a database
    // blip. For an authenticated socket `onMessage` reaches the ping branch
    // with no `await`, so running it outside the chain answers at once and
    // still spends the same rate-limit tokens.
    if (authenticated && isPingFrame(data)) {
      void onMessage(data).catch((error) => {
        console.error("[ws] ping handler failed:", error);
      });
      return;
    }
    messageChain = messageChain
      .then(() => onMessage(data))
      .catch((error) => {
        console.error("[ws] message handler failed:", error);
      });
  });

  socket.on("error", (error: Error) => {
    logEvent("ws.error", { connId, message: error.message });
  });

  socket.on("close", (code: number, reason: Buffer) => {
    closed = true;
    clearTimeout(authTimeout);
    const user = getSocketUser(socket);
    logEvent("ws.close", {
      connId,
      userId: user?.id,
      code,
      reason: reason?.toString() || undefined,
      wasInVoice: isSocketInVoice(socket),
    });
    removeVoicePeerBySocket(socket);
    // Before `deleteAuthenticatedSocket`, though it does not depend on it: the
    // status registry keeps its own socket→user index precisely so that closing
    // order can never leave a user stuck online because the identity was
    // forgotten first.
    unregisterStatusSocket(socket);
    deleteAuthenticatedSocket(socket);
    // AFTER the delete, and it has to be: the check is "does this person have
    // any socket left", and the one that just closed must already be out of
    // the map or a host closing their last tab looks like a host with a tab
    // open. Only a live party they host is affected.
    if (user) {
      void onHostSocketClosed(user.id).catch((error) => {
        console.error("[watch-party] host disconnect failed:", error);
      });
    }
  });
}

/**
 * Proxies (Railway, Cloudflare) drop idle WebSocket connections. Pinging keeps
 * them open and detects half-open sockets that never fired `close`.
 *
 * THIS IS THE REAPER THE PROCESS ACTUALLY RUNS, and saying so is not
 * decoration: until 2026-09-08 it was not. `index.ts` carried its own inline
 * copy of this loop with a one-strike rule, and this function, along with
 * `MAX_MISSED_PONGS`, `trackSocketLiveness` and the whole of
 * `heartbeat.test.ts`, was dead code. The two-strike fix written the night of
 * the moonkase stream was tested, merged, and never once executed in
 * production. Anything that changes reaping belongs here, and here only.
 */
export function startHeartbeat(
  clients: Iterable<WebSocket>,
  intervalMs = HEARTBEAT_INTERVAL_MS,
  onTick: () => void = () => {},
): () => void {
  const timer = setInterval(() => {
    // A free ride on a loop that already runs: `index.ts` samples the pool
    // high-water marks here, because on a quiet server nothing else does.
    onTick();
    for (const socket of clients) {
      if (alive.get(socket) === false) {
        const missed = (missedPongs.get(socket) ?? 0) + 1;
        missedPongs.set(socket, missed);
        if (missed >= MAX_MISSED_PONGS) {
          // Log the reap so a mystery "kicked out" can be traced to missed
          // pongs rather than a real close. `missed` is here because the whole
          // point of the change is that one is not enough, and a future
          // argument about the threshold should be able to read the number
          // that actually applied.
          logEvent("ws.heartbeatTerminate", {
            userId: getSocketUser(socket)?.id,
            missed,
          });
          socket.terminate();
          continue;
        }
        // Still inside the grace window: ping again rather than waiting a whole
        // interval in silence, and leave `alive` false so an unanswered second
        // ping is what ends it.
        try {
          socket.ping();
        } catch {
          socket.terminate();
        }
        continue;
      }
      alive.set(socket, false);
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * A cheap test for the application keepalive frame, `{"type":"ping"}`, that
 * never parses anything larger than the frame could possibly be.
 */
export function isPingFrame(data: unknown): boolean {
  const text =
    typeof data === "string"
      ? data
      : Buffer.isBuffer(data) && data.length <= 64
        ? data.toString()
        : null;
  if (text === null || text.length > 64 || !text.includes("ping")) {
    return false;
  }
  try {
    const parsed = JSON.parse(text) as { type?: unknown };
    return typeof parsed === "object" && parsed !== null && parsed.type === "ping";
  } catch {
    return false;
  }
}

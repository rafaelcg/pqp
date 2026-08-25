import type { WebSocket } from "ws";
import { DEV_AUTH_TOKEN, isDevAuthBypassEnabled, resolveAuthUser } from "../auth/clerk.js";
import { logEvent, nextConnectionId } from "../lib/log.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { handleChatMessage } from "./chat.js";
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
  resolveEmbedInBackground,
  startClusterPresenceRefresh,
} from "./chat.js";
export {
  applyManualStatus,
  resolveStatus,
  resolveStatuses,
  startClusterStatusRefresh,
} from "./status.js";
export {
  evictVoiceChannel,
  evictVoiceUser,
  evictVoiceUsersExcept,
} from "./voice.js";

const AUTH_TIMEOUT_MS = 10_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;

const CHAT_MESSAGE_TYPES = new Set([
  "join-channel",
  "leave-channel",
  "message-create",
  "reaction-toggle",
  "typing",
  // Not a chat action, but it is validated by `chatClientMessageSchema` and
  // handled next to channel presence, which is the other thing in that file that
  // describes where a connection is rather than what it said.
  "set-idle",
]);

const VOICE_MESSAGE_TYPES = new Set([
  "join-voice-room",
  "leave-voice-room",
  "set-sharing-screen",
  "offer",
  "answer",
  "ice-candidate",
  // A watcher asking a presenter for a different size. Relayed like the three
  // above and read no more closely than they are: the server checks that both
  // ends are peers of the same mesh room and forwards the frame verbatim.
  //
  // THIS LIST IS THE REASON A NEW FRAME NEEDS THE API REDEPLOYED. Adding the
  // schema to `@pqp/shared` is not enough on its own — a type missing from
  // this set never reaches `handleVoiceMessage` at all, and the frame is
  // dropped in silence, which is indistinguishable from a feature that simply
  // does not work. Measured the hard way: the client sent it, the server said
  // nothing, and the presenter's encoder never moved.
  "screen-quality-request",
  // --- conversation calls ---
  "call-ring",
  "call-decline",
  "set-camera",
  // --- voice state ---
  "set-voice-state",
]);

/**
 * Backstop against a hostile socket flooding the parse loop. Keyed by address,
 * which behind a proxy without `TRUST_PROXY` is shared by every client — so it
 * is deliberately coarse. The per-user limits in the chat and voice handlers do
 * the real work.
 */
const socketLimiter = createRateLimiter({
  capacity: 600,
  refillPerSecond: 200,
});

/** Sockets that have not answered our last ping. */
const alive = new WeakMap<WebSocket, boolean>();

export function handleWsConnection(socket: WebSocket, remoteKey: string) {
  let authenticated = false;
  let closed = false;
  const connId = nextConnectionId();
  logEvent("ws.connect", { connId });

  // Per-connection budget. The address bucket above cannot distinguish clients
  // behind a shared proxy, so the real limit has to live on the socket itself.
  const connectionLimiter = createRateLimiter({
    capacity: 60,
    refillPerSecond: 20,
  });

  alive.set(socket, true);
  socket.on("pong", () => alive.set(socket, true));

  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      logEvent("ws.authTimeout", { connId });
      socket.close(4401, "Auth timeout");
    }
  }, AUTH_TIMEOUT_MS);

  async function onMessage(data: unknown) {
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
    if (!connectionLimiter.take("self")) {
      // Sustained flooding from one socket is not a client we want to keep.
      logEvent("ws.flood", { connId });
      socket.close(4429, "Too many messages");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
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
      setAuthenticatedSocket(socket, resolved.user);
      logEvent("ws.auth", { connId, userId: resolved.user.id });
      // Deliberately not awaited: it reads one row to find out whether this
      // account asked to be invisible or do-not-disturb, and `ready` must not
      // wait on a preference lookup. Until it resolves the socket is absent from
      // the status registry, which reads as offline — the safe direction, and
      // the reason `registerStatusSocket` resolves the manual status *before* it
      // makes the connection visible rather than after.
      void registerStatusSocket(socket, resolved.user.id).catch((error) => {
        console.error("[ws] status registration failed:", error);
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
    // A throwing handler (e.g. transient DB error) must not become an unhandled
    // rejection — that kills the process and drops every client.
    void onMessage(data).catch((error) => {
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
  });
}

/**
 * Proxies (Railway, Cloudflare) drop idle WebSocket connections. Pinging keeps
 * them open and detects half-open sockets that never fired `close`.
 */
export function startHeartbeat(
  clients: Iterable<WebSocket>,
  intervalMs = HEARTBEAT_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    for (const socket of clients) {
      if (alive.get(socket) === false) {
        // Log the reap so a mystery "kicked out" can be traced to a missed pong
        // rather than a real close.
        logEvent("ws.heartbeatTerminate", { userId: getSocketUser(socket)?.id });
        socket.terminate();
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

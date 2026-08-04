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
  handleVoiceMessage,
  isSocketInVoice,
  removeVoicePeerBySocket,
  sendAllVoiceRosters,
} from "./voice.js";

export { forEachAuthenticatedSocket, getSocketUser } from "./sockets.js";
export {
  broadcastMessageDeleted,
  broadcastToChannel,
  evictChannelViewers,
  evictUserFromChannels,
  resolveEmbedInBackground,
} from "./chat.js";
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
]);

const VOICE_MESSAGE_TYPES = new Set([
  "join-voice-room",
  "leave-voice-room",
  "set-sharing-screen",
  "offer",
  "answer",
  "ice-candidate",
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

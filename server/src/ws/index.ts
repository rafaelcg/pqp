import type { WebSocket } from "ws";
import { DEV_AUTH_TOKEN, isDevAuthBypassEnabled, resolveAuthUser } from "../auth/clerk.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { handleChatMessage } from "./chat.js";
import {
  deleteAuthenticatedSocket,
  getAuthenticatedSocket,
  setAuthenticatedSocket,
} from "./sockets.js";
import {
  handleVoiceMessage,
  removeVoicePeerBySocket,
  sendAllVoiceRosters,
} from "./voice.js";

export { forEachAuthenticatedSocket, getSocketUser } from "./sockets.js";
export {
  broadcastToChannel,
  evictChannelViewers,
  evictUserFromChannels,
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
      socket.close(4401, "Auth timeout");
    }
  }, AUTH_TIMEOUT_MS);

  async function onMessage(data: unknown) {
    if (!socketLimiter.take(remoteKey)) {
      return;
    }
    if (!connectionLimiter.take("self")) {
      // Sustained flooding from one socket is not a client we want to keep.
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
      socket.send(JSON.stringify({ type: "ready", userId: resolved.user.id }));
      await sendAllVoiceRosters(socket, resolved.user.id);
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
    // Without this catch, any rejection inside a handler becomes an unhandled
    // promise rejection, which takes down the whole Node process.
    void onMessage(data).catch((error) => {
      console.error("[ws] message handler failed:", error);
    });
  });

  socket.on("error", (error) => {
    console.error("[ws] socket error:", error);
  });

  socket.on("close", () => {
    closed = true;
    clearTimeout(authTimeout);
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

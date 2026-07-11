import type { WebSocket } from "ws";
import { DEV_AUTH_TOKEN, isDevAuthBypassEnabled, resolveAuthUser } from "../auth/clerk.js";
import { logEvent, nextConnectionId } from "../lib/log.js";
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

export function handleWsConnection(socket: WebSocket) {
  let authenticated = false;
  const connId = nextConnectionId();
  logEvent("ws.connect", { connId });

  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      logEvent("ws.authTimeout", { connId });
      socket.close(4401, "Auth timeout");
    }
  }, 10_000);

  socket.on("message", async (data) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
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

      authenticated = true;
      clearTimeout(authTimeout);
      setAuthenticatedSocket(socket, resolved.user);
      logEvent("ws.auth", { connId, userId: resolved.user.id });
      socket.send(JSON.stringify({ type: "ready" }));
      void sendAllVoiceRosters(socket, resolved.user);
      return;
    }

    const session = getAuthenticatedSocket(socket);
    if (!session) {
      return;
    }

    // Client keepalive: lets browsers detect half-open connections and keeps
    // proxy idle timers reset.
    if ((parsed as { type?: string }).type === "ping") {
      socket.send(JSON.stringify({ type: "pong" }));
      return;
    }

    // A throwing handler (e.g. transient DB error) must not become an
    // unhandled rejection — that kills the process and drops every client.
    try {
      await Promise.all([
        handleChatMessage(session, parsed),
        handleVoiceMessage(session, parsed),
      ]);
    } catch (error) {
      console.error("[ws] message handler failed:", error);
    }
  });

  socket.on("close", (code: number, reason: Buffer) => {
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

  socket.on("error", (error: Error) => {
    logEvent("ws.error", { connId, message: error.message });
  });
}

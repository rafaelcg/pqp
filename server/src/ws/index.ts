import type { WebSocket } from "ws";
import { DEV_AUTH_TOKEN, isDevAuthBypassEnabled, resolveAuthUser } from "../auth/clerk.js";
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

export function handleWsConnection(socket: WebSocket) {
  let authenticated = false;

  const authTimeout = setTimeout(() => {
    if (!authenticated) {
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
        socket.close(4401, "Unauthorized");
        return;
      }

      authenticated = true;
      clearTimeout(authTimeout);
      setAuthenticatedSocket(socket, resolved.user);
      socket.send(JSON.stringify({ type: "ready" }));
      sendAllVoiceRosters(socket);
      return;
    }

    const session = getAuthenticatedSocket(socket);
    if (!session) {
      return;
    }

    await Promise.all([
      handleChatMessage(session, parsed),
      handleVoiceMessage(session, parsed),
    ]);
  });

  socket.on("close", () => {
    clearTimeout(authTimeout);
    removeVoicePeerBySocket(socket);
    deleteAuthenticatedSocket(socket);
  });
}

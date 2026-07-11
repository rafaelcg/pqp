import type { WebSocket } from "ws";
import {
  chatClientMessageSchema,
  messageCreateMessageSchema,
  reactionToggleMessageSchema,
  type ChatServerMessage,
} from "@pqp/shared";
import type { DbUser } from "../db.js";
import { createMessage, mapMessage } from "../services/messages.js";
import {
  getMessageChannelId,
  toggleReaction,
} from "../services/reactions.js";
import { isChannelMember } from "../services/users.js";
import { rateLimit } from "../lib/rate-limit.js";

interface ChatConnection {
  socket: WebSocket;
  user: DbUser;
  channelId: string | null;
}

const connections = new Map<WebSocket, ChatConnection>();
const channelPresence = new Map<string, Map<string, DbUser>>();

function broadcastPresence(channelId: string) {
  const users = channelPresence.get(channelId);
  const payload = {
    type: "presence-update" as const,
    channelId,
    users: [...(users?.values() ?? [])].map((u) => ({
      id: u.id,
      name: u.display_name,
      avatarUrl: u.avatar_url,
    })),
  };

  for (const conn of connections.values()) {
    if (conn.channelId === channelId && conn.socket.readyState === 1) {
      conn.socket.send(JSON.stringify(payload));
    }
  }
}

function leaveChannel(conn: ChatConnection) {
  if (!conn.channelId) {
    return;
  }
  const presence = channelPresence.get(conn.channelId);
  presence?.delete(conn.user.id);
  if (presence?.size === 0) {
    channelPresence.delete(conn.channelId);
  }
  broadcastPresence(conn.channelId);
  conn.channelId = null;
}

function ensureConnection(socket: WebSocket, user: DbUser): ChatConnection {
  let conn = connections.get(socket);
  if (!conn) {
    conn = { socket, user, channelId: null };
    connections.set(socket, conn);
    socket.on("close", () => {
      const active = connections.get(socket);
      if (active) {
        leaveChannel(active);
        connections.delete(socket);
      }
    });
  }
  return conn;
}

function sendBroadcast(
  channelId: string,
  broadcast: ChatServerMessage,
  sender: ChatConnection,
) {
  for (const conn of connections.values()) {
    if (conn.socket.readyState !== 1) {
      continue;
    }
    if (conn.channelId === channelId || conn.socket === sender.socket) {
      conn.socket.send(JSON.stringify(broadcast));
    }
  }
}

export async function handleChatMessage(
  session: { socket: WebSocket; user: DbUser },
  raw: unknown,
): Promise<void> {
  const message = chatClientMessageSchema.safeParse(raw);
  if (!message.success) {
    return;
  }

  const conn = ensureConnection(session.socket, session.user);
  const payload = message.data;

  if (payload.type === "join-channel") {
    if (!(await isChannelMember(payload.channelId, conn.user.id))) {
      return;
    }
    leaveChannel(conn);
    conn.channelId = payload.channelId;
    if (!channelPresence.has(payload.channelId)) {
      channelPresence.set(payload.channelId, new Map());
    }
    channelPresence.get(payload.channelId)!.set(conn.user.id, conn.user);
    broadcastPresence(payload.channelId);
    return;
  }

  if (payload.type === "leave-channel") {
    leaveChannel(conn);
    return;
  }

  if (payload.type === "message-create") {
    const createMsg = messageCreateMessageSchema.parse(payload);
    // Throttle sends per user so a single socket can't flood the channel/DB.
    if (!rateLimit(`ws-msg:${conn.user.id}`, 20, 10_000).allowed) {
      return;
    }
    if (!(await isChannelMember(createMsg.channelId, conn.user.id))) {
      return;
    }

    if (!conn.channelId) {
      conn.channelId = createMsg.channelId;
    }

    const dbMessage = await createMessage(
      createMsg.channelId,
      conn.user.id,
      createMsg.body,
    );

    sendBroadcast(
      createMsg.channelId,
      {
        type: "message-broadcast",
        message: mapMessage(dbMessage),
      },
      conn,
    );
    return;
  }

  if (payload.type === "reaction-toggle") {
    const reactionMsg = reactionToggleMessageSchema.parse(payload);
    if (!rateLimit(`ws-react:${conn.user.id}`, 40, 10_000).allowed) {
      return;
    }
    if (!(await isChannelMember(reactionMsg.channelId, conn.user.id))) {
      return;
    }

    const messageChannelId = await getMessageChannelId(reactionMsg.messageId);
    if (!messageChannelId || messageChannelId !== reactionMsg.channelId) {
      return;
    }

    if (!conn.channelId) {
      conn.channelId = reactionMsg.channelId;
    }

    const { added } = await toggleReaction(
      reactionMsg.messageId,
      conn.user.id,
      reactionMsg.emoji,
    );

    sendBroadcast(
      reactionMsg.channelId,
      {
        type: "reaction-broadcast",
        channelId: reactionMsg.channelId,
        messageId: reactionMsg.messageId,
        emoji: reactionMsg.emoji,
        userId: conn.user.id,
        added,
      },
      conn,
    );
  }
}

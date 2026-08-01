import type { WebSocket } from "ws";
import {
  chatClientMessageSchema,
  extractMentionUsernames,
  type ChatServerMessage,
} from "@pqp/shared";
import type { DbUser } from "../db.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import {
  createMessage,
  getReplyParent,
  mapMessage,
} from "../services/messages.js";
import { getMessageChannelId, toggleReaction } from "../services/reactions.js";
import { getChannelAudience } from "../services/servers.js";
import { isChannelMember } from "../services/users.js";
import { forEachAuthenticatedSocket } from "./sockets.js";

interface ChatConnection {
  socket: WebSocket;
  user: DbUser;
  channelId: string | null;
}

const connections = new Map<WebSocket, ChatConnection>();
/**
 * Presence is tracked per *socket*, not per user: two tabs on the same channel
 * are two entries, so closing one no longer removes a user who is still there.
 * The broadcast payload dedupes by user id.
 */
const channelPresence = new Map<string, Set<ChatConnection>>();

/** Enough for fast typing and reaction spam, not enough to hammer the DB. */
const messageLimiter = createRateLimiter({ capacity: 10, refillPerSecond: 2 });
const reactionLimiter = createRateLimiter({ capacity: 20, refillPerSecond: 5 });
const typingLimiter = createRateLimiter({ capacity: 5, refillPerSecond: 1 });

export function resetChatRateLimits(): void {
  messageLimiter.reset();
  reactionLimiter.reset();
  typingLimiter.reset();
}

function encode(message: ChatServerMessage): string {
  return JSON.stringify(message);
}

function broadcastPresence(channelId: string) {
  const present = channelPresence.get(channelId);
  const byUser = new Map<string, DbUser>();
  for (const conn of present ?? []) {
    byUser.set(conn.user.id, conn.user);
  }

  const payload = encode({
    type: "presence-update",
    channelId,
    users: [...byUser.values()].map((u) => ({
      id: u.id,
      name: u.display_name,
      avatarUrl: u.avatar_url,
    })),
  });

  for (const conn of connections.values()) {
    if (conn.channelId === channelId && conn.socket.readyState === 1) {
      conn.socket.send(payload);
    }
  }
}

function leaveChannel(conn: ChatConnection) {
  if (!conn.channelId) {
    return;
  }
  const channelId = conn.channelId;
  const presence = channelPresence.get(channelId);
  presence?.delete(conn);
  if (presence && presence.size === 0) {
    channelPresence.delete(channelId);
  }
  conn.channelId = null;
  broadcastPresence(channelId);
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
  // Keep the cached profile fresh for presence after a rename.
  conn.user = user;
  return conn;
}

/**
 * Fan a message out to everyone currently viewing a channel. Exported so HTTP
 * routes (message edit / delete) can publish without duplicating the socket
 * bookkeeping.
 */
export function broadcastToChannel(
  channelId: string,
  message: ChatServerMessage,
  alsoSocket?: WebSocket,
): void {
  const payload = encode(message);
  for (const conn of connections.values()) {
    if (conn.socket.readyState !== 1) {
      continue;
    }
    if (conn.channelId === channelId || conn.socket === alsoSocket) {
      conn.socket.send(payload);
    }
  }
}

/**
 * Broadcast a message deletion to everyone currently viewing the channel.
 * Called from the HTTP moderation endpoint, so there is no sender socket.
 */
export function broadcastMessageDeleted(channelId: string, messageId: string) {
  broadcastToChannel(channelId, {
    type: "message-deleted",
    channelId,
    messageId,
  });
}

/**
 * Force everyone out of a channel's live view. Called when a channel is deleted
 * or a member loses access, so a revoked user stops receiving broadcasts without
 * having to reconnect.
 */
export function evictChannelViewers(
  channelId: string,
  predicate?: (userId: string) => boolean,
): void {
  for (const conn of connections.values()) {
    if (conn.channelId !== channelId) {
      continue;
    }
    if (predicate && !predicate(conn.user.id)) {
      continue;
    }
    leaveChannel(conn);
  }
}

/** Drop a user out of any channel view belonging to the given channel ids. */
export function evictUserFromChannels(
  userId: string,
  channelIds: Set<string>,
): void {
  for (const conn of connections.values()) {
    if (
      conn.user.id === userId &&
      conn.channelId &&
      channelIds.has(conn.channelId)
    ) {
      leaveChannel(conn);
    }
  }
}

/**
 * Tell everyone who can see this channel — but is not looking at it right now —
 * that something arrived, so their unread badge updates without a refresh. The
 * payload carries no message content.
 */
async function notifyChannelActivity(
  channelId: string,
  authorId: string,
  body: string,
  repliedToUserId?: string | null,
): Promise<void> {
  const audience = await getChannelAudience(channelId);
  if (!audience) {
    return;
  }

  const mentioned = new Set(extractMentionUsernames(body));
  const allowed = new Set(audience.userIds);

  forEachAuthenticatedSocket((socket, user) => {
    if (socket.readyState !== 1 || user.id === authorId) {
      return;
    }
    if (!allowed.has(user.id)) {
      return;
    }
    if (connections.get(socket)?.channelId === channelId) {
      return;
    }
    socket.send(
      encode({
        type: "channel-activity",
        serverId: audience.serverId,
        channelId,
        // Being answered is a mention here for the same reason it is one in
        // `message_mentions`: otherwise the live badge and the badge you get
        // after a refresh disagree about the same message.
        mention:
          user.id === repliedToUserId ||
          Boolean(user.username && mentioned.has(user.username)),
      }),
    );
  });
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
    const present = channelPresence.get(payload.channelId) ?? new Set();
    present.add(conn);
    channelPresence.set(payload.channelId, present);
    broadcastPresence(payload.channelId);
    return;
  }

  if (payload.type === "leave-channel") {
    leaveChannel(conn);
    return;
  }

  if (payload.type === "typing") {
    if (conn.channelId !== payload.channelId) {
      return;
    }
    if (!typingLimiter.take(conn.user.id)) {
      return;
    }
    // Membership was proven at join-channel time and revocation evicts the
    // viewer, so no extra query on this very hot, purely ephemeral path.
    const encoded = encode({
      type: "typing-broadcast",
      channelId: payload.channelId,
      userId: conn.user.id,
      displayName: conn.user.display_name,
    });
    for (const other of connections.values()) {
      if (
        other !== conn &&
        other.channelId === payload.channelId &&
        other.socket.readyState === 1
      ) {
        other.socket.send(encoded);
      }
    }
    return;
  }

  if (payload.type === "message-create") {
    // Throttle sends per user so a single socket can't flood the channel/DB.
    if (!messageLimiter.take(conn.user.id)) {
      return;
    }
    if (!(await isChannelMember(payload.channelId, conn.user.id))) {
      return;
    }

    if (!conn.channelId) {
      conn.channelId = payload.channelId;
    }

    let parent = null;
    if (payload.replyToId) {
      parent = await getReplyParent(payload.replyToId);
      // A parent in another channel can only come from a client that made it
      // up, so drop the whole frame the way every other invalid input is
      // dropped. A parent that is simply gone is an ordinary race — someone
      // deleted it while the reply was being typed — and losing the words
      // somebody actually wrote would be the worse failure, so it posts plain.
      if (parent && parent.channel_id !== payload.channelId) {
        return;
      }
    }

    const dbMessage = await createMessage(
      payload.channelId,
      conn.user,
      payload.body,
      parent?.id ?? null,
    );

    broadcastToChannel(
      payload.channelId,
      {
        type: "message-broadcast",
        message: mapMessage(dbMessage),
        ...(payload.nonce ? { nonce: payload.nonce } : {}),
      },
      conn.socket,
    );

    await notifyChannelActivity(
      payload.channelId,
      conn.user.id,
      payload.body,
      parent?.author_id ?? null,
    );
    return;
  }

  if (payload.type === "reaction-toggle") {
    if (!reactionLimiter.take(conn.user.id)) {
      return;
    }
    if (!(await isChannelMember(payload.channelId, conn.user.id))) {
      return;
    }

    const messageChannelId = await getMessageChannelId(payload.messageId);
    if (!messageChannelId || messageChannelId !== payload.channelId) {
      return;
    }

    if (!conn.channelId) {
      conn.channelId = payload.channelId;
    }

    const { added } = await toggleReaction(
      payload.messageId,
      conn.user.id,
      payload.emoji,
    );

    broadcastToChannel(
      payload.channelId,
      {
        type: "reaction-broadcast",
        channelId: payload.channelId,
        messageId: payload.messageId,
        emoji: payload.emoji,
        userId: conn.user.id,
        added,
      },
      conn.socket,
    );
  }
}

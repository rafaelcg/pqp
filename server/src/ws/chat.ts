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
import { listBlockersOf } from "../services/blocks.js";
import { isDmSendBlocked, restoreDmParticipants } from "../services/dms.js";
import { getChannelAudience } from "../services/servers.js";
import { canAccessChannel } from "../services/users.js";
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
  const [audience, blockers] = await Promise.all([
    getChannelAudience(channelId),
    listBlockersOf(authorId),
  ]);
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
    // Somebody who blocked this author gets no badge from them. The message is
    // still delivered and still readable behind the client's curtain — what a
    // block takes away is the notification, which is the part that reaches you
    // whether you were looking or not.
    if (blockers.has(user.id)) {
      return;
    }
    if (connections.get(socket)?.channelId === channelId) {
      return;
    }
    socket.send(
      encode({
        type: "channel-activity",
        // Null for a conversation. Guessing a server here would file a private
        // conversation's badge into a public sidebar.
        serverId: audience.serverId,
        kind: audience.kind,
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
    if (!(await canAccessChannel(payload.channelId, conn.user.id))) {
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
    // A block closes a 1:1 in both directions, and "X is typing…" is a
    // notification like any other — without this, a blocked person can park an
    // indicator in the blocker's open conversation indefinitely, and the client
    // does not filter it either. Deliberately placed *after* the limiter, which
    // already bounds this to roughly one query per second per user, so the
    // hottest ephemeral path does not become a per-keystroke database read.
    if (await isDmSendBlocked(payload.channelId, conn.user.id)) {
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
    if (!(await canAccessChannel(payload.channelId, conn.user.id))) {
      return;
    }
    // A block closes a 1:1 in both directions. Dropped rather than answered,
    // because a WS frame has no status code — gap #20's message-rejected path
    // is what will eventually let the sender be told.
    if (await isDmSendBlocked(payload.channelId, conn.user.id)) {
      return;
    }

    if (!conn.channelId) {
      conn.channelId = payload.channelId;
    }

    // A 1:1 the recipient had closed comes back when something is said in it.
    // Without this the message lands in a channel they are no longer a member
    // of, so they are not in its audience, get no badge, and never learn it
    // exists — closing a conversation would silently swallow the next one.
    // A no-op for every channel that is not a 1:1.
    //
    // Ordering is load-bearing: this must run *before* `createMessage`, because
    // `recordMentions` resolves a conversation's mentionable set through
    // `channel_members`. Restoring afterwards leaves the recipient missing from
    // that set for their own message, so an @-mention into a conversation they
    // had closed records no row — the live badge says "mention" and the badge
    // after a refresh says none, the exact disagreement the reply-mention
    // comment in `messages.ts` exists to prevent. It runs after the block guard
    // so a blocked sender cannot use it to put the conversation back in the
    // blocker's list.
    await restoreDmParticipants(payload.channelId);

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
      payload.attachmentIds,
    );
    // Nothing survived: an attachment-only message whose every upload failed
    // its verification. The frame said something when it was sent and says
    // nothing now, so it is dropped like any other frame that does not describe
    // a message — broadcasting an empty bubble would be worse than silence.
    if (!dbMessage) {
      return;
    }

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
    if (!(await canAccessChannel(payload.channelId, conn.user.id))) {
      return;
    }
    // A reaction is a persistent, visible poke at somebody else's message, so
    // it is closed by the same block that closes sending — and by the same
    // guard that closes typing. Every path that puts something of the sender's
    // in front of the blocker goes through here.
    if (await isDmSendBlocked(payload.channelId, conn.user.id)) {
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

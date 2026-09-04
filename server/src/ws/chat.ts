import type { WebSocket } from "ws";
import {
  chatClientMessageSchema,
  extractMentions,
  extractMentionUsernames,
  friendActivitySchema,
  hasPermission,
  isChatServerMessage,
  Permission,
  permissionsUpdateSchema,
  profileUpdateSchema,
  type ChatServerMessage,
  type FriendActivity,
  type MessageRejectReason,
  type ProfileUpdate,
} from "@pqp/shared";
import type { DbUser } from "../db.js";
import {
  isBusEnabled,
  publishToCluster,
  subscribeToCluster,
} from "../lib/bus.js";
import { createRateLimiter, limitFromEnv } from "../lib/rate-limit.js";
import {
  extractFirstUrl,
  fetchAndCacheEmbed,
  getEmbedCacheState,
} from "../services/embeds.js";
import {
  createMessage,
  getReplyParent,
  mapMessage,
} from "../services/messages.js";
import { enqueueOutgoingMessageCreated } from "../services/outgoing-webhooks.js";
import { closePoll, votePoll } from "../services/polls.js";
import {
  getMessageChannelId,
  resolveChannelMemberName,
  toggleReaction,
} from "../services/reactions.js";
import { listBlockersOf } from "../services/blocks.js";
import { isDmSendBlocked, restoreDmParticipants } from "../services/dms.js";
import {
  findTimeoutForChannel,
  timeoutMessage,
  type ActiveTimeout,
} from "../services/sanctions.js";
import { pushChannelActivity } from "../services/push.js";
import { getChannel, getChannelAudience } from "../services/servers.js";
import {
  bumpPermissionsVersion,
  computeMemberPermissions,
  listServerMemberIds,
} from "../services/permissions.js";
// --- threads ---
import { getThreadInfo } from "../services/threads.js";
import { canAccessChannel } from "../services/users.js";
import { forEachAuthenticatedSocket } from "./sockets.js";
import { isInvisible, isPresentForHere, setSocketIdle } from "./status.js";

interface ChatConnection {
  socket: WebSocket;
  user: DbUser;
  channelId: string | null;
  // --- threads ---
  /**
   * The one thread this connection is viewing *beside* its primary channel —
   * the side panel. A second slot rather than a set: the UI can only show one
   * panel, and a bounded slot cannot be grown into a subscription list by a
   * misbehaving client. Indexed in `channelPresence` exactly like the primary
   * slot, so every fan-out treats the two identically.
   */
  threadChannelId: string | null;
}

const connections = new Map<WebSocket, ChatConnection>();
/**
 * Presence is tracked per *socket*, not per user: two tabs on the same channel
 * are two entries, so closing one no longer removes a user who is still there.
 * The broadcast payload dedupes by user id.
 */
const channelPresence = new Map<string, Set<ChatConnection>>();

/** Enough for fast typing and reaction spam, not enough to hammer the DB. */
const messageLimiter = createRateLimiter({
  capacity: limitFromEnv("RATE_LIMIT_WS_MESSAGE_CAPACITY", 10),
  refillPerSecond: limitFromEnv("RATE_LIMIT_WS_MESSAGE_REFILL", 2),
});
const reactionLimiter = createRateLimiter({ capacity: 20, refillPerSecond: 5 });
const typingLimiter = createRateLimiter({ capacity: 5, refillPerSecond: 1 });

export function resetChatRateLimits(): void {
  messageLimiter.reset();
  reactionLimiter.reset();
  typingLimiter.reset();
}

/**
 * Cluster topics. Every one of these carries *ephemeral fan-out only* — the
 * messages themselves are already in Postgres before anything is published, so
 * a frame lost to a bus outage costs a live update, never data.
 *
 * Frames must stay backward-compatible: a rolling deploy has old and new
 * instances on the same bus, so fields may be added but never repurposed.
 */
const BROADCAST_TOPIC = "chat.broadcast";
const PRESENCE_TOPIC = "chat.presence";
const TYPING_TOPIC = "chat.typing";
const ACTIVITY_TOPIC = "chat.activity";
const EVICT_TOPIC = "chat.evict";
const PROFILE_TOPIC = "chat.profile";
const FRIEND_TOPIC = "chat.friend";
const PERMISSIONS_TOPIC = "chat.permissions";
const COMMUNITY_HOME_TOPIC = "chat.community-home";

interface PresenceUser {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/**
 * What *other* instances have told us they are showing this channel to:
 * channelId → instance id → its contribution.
 *
 * Each instance only ever publishes its own viewers, and every instance merges.
 * Nobody owns a global roster, which is what makes an instance dying a bounded
 * problem: its contribution simply stops being refreshed and ages out.
 */
const remotePresence = new Map<
  string,
  Map<string, { users: PresenceUser[]; at: number }>
>();

/**
 * An instance re-announces every channel it holds viewers for on this interval,
 * and contributions older than the TTL are dropped. Both are needed: an
 * instance that exits cleanly publishes an empty contribution, but one that is
 * SIGKILLed or partitioned publishes nothing at all, and without expiry its
 * users would sit in everyone's presence list forever.
 *
 * The cost is one frame per *occupied* channel per instance per interval, so it
 * scales with concurrently-viewed channels rather than with users. At 20s, a
 * thousand busy channels is 50 frames a second — noise next to the message
 * traffic. Raise the interval (and the TTL with it) before that stops being
 * true; the only thing it buys is how long a crashed instance's viewers linger.
 */
const PRESENCE_REFRESH_MS = 20_000;
const PRESENCE_TTL_MS = 60_000;

function encode(message: ChatServerMessage): string {
  return JSON.stringify(message);
}

/**
 * INVISIBILITY IS ENFORCED HERE, AT THE SOURCE.
 *
 * Channel presence is the loudest *passive* giveaway in the app: it says where
 * you are, and it says it because you opened a channel, not because you did
 * anything. Somebody hidden who is still listed as "in #general" has not been
 * hidden at all.
 *
 * Filtering where the roster is *built*, rather than at each of the two places
 * it is sent, is what makes it hold across the cluster too: every instance
 * publishes an already-filtered contribution, so the merge in `sendPresence` can
 * never reintroduce somebody another instance chose to hide, and a hidden person
 * costs the remote instances no lookup at all.
 *
 * They still *receive* presence for the channel they are in. Invisibility takes
 * away what others see, never what you can.
 */
function localPresenceUsers(channelId: string): PresenceUser[] {
  const byUser = new Map<string, PresenceUser>();
  for (const conn of channelPresence.get(channelId) ?? []) {
    if (isInvisible(conn.user.id)) {
      continue;
    }
    byUser.set(conn.user.id, {
      id: conn.user.id,
      name: conn.user.display_name,
      avatarUrl: conn.user.avatar_url,
    });
  }
  return [...byUser.values()];
}

/**
 * Send the channel's roster to the people this instance is holding. Local-only
 * on purpose — this is what a frame arriving from the bus calls, and it must
 * never publish, or two instances would answer each other forever.
 */
function sendPresence(channelId: string): void {
  const present = channelPresence.get(channelId);
  if (!present || present.size === 0) {
    return;
  }

  // The same list `publishPresence` hands the other instances, filtered the same
  // way, because it is the same function — so the roster this instance renders
  // and the roster it publishes cannot disagree about who is hidden.
  const byUser = new Map<string, PresenceUser>(
    localPresenceUsers(channelId).map((user) => [user.id, user]),
  );
  if (isBusEnabled()) {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    for (const contribution of remotePresence.get(channelId)?.values() ?? []) {
      if (contribution.at < cutoff) {
        continue;
      }
      for (const user of contribution.users) {
        byUser.set(user.id, user);
      }
    }
  }

  const payload = encode({
    type: "presence-update",
    channelId,
    users: [...byUser.values()],
  });

  // The recipients of a channel's presence are exactly the people present in
  // it, so this walks the same index the payload was built from rather than
  // every socket on the process.
  for (const conn of present) {
    if (conn.socket.readyState === 1) {
      conn.socket.send(payload);
    }
  }
}

/**
 * `refresh` frames are the periodic re-announcement and an answer to somebody
 * else's `update`; `update` frames are a real change. Only an `update` is
 * answered, or every pair of instances would trade presence frames forever.
 */
function publishPresence(channelId: string, kind: "update" | "refresh"): void {
  publishToCluster(PRESENCE_TOPIC, {
    channelId,
    kind,
    users: localPresenceUsers(channelId),
  });
}

function broadcastPresence(channelId: string) {
  sendPresence(channelId);
  if (isBusEnabled()) {
    // Published even when the local roster is now empty: an empty contribution
    // is how the other instances learn to forget this one's viewers.
    publishPresence(channelId, "update");
  }
}

/**
 * The only way a connection may start viewing a channel. `conn.channelId` and
 * the `channelPresence` index have to move together: fan-out reads the index,
 * so a connection whose `channelId` claims a channel it is not indexed under
 * would silently receive nothing said in it. Setting the field alone is the
 * bug this helper exists to make impossible.
 */
function joinChannel(conn: ChatConnection, channelId: string): void {
  const present = channelPresence.get(channelId) ?? new Set<ChatConnection>();
  present.add(conn);
  channelPresence.set(channelId, present);
  conn.channelId = channelId;
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

// --- threads ---
//
// The secondary view slot. Same index, same invariant as `joinChannel` /
// `leaveChannel`: `conn.threadChannelId` and membership in `channelPresence`
// move together or fan-out silently skips a viewer. Kept as separate helpers
// rather than folded into the primary pair so that switching the primary
// channel can never tear down the thread panel's delivery, and vice versa.
//
// One subtlety: primary and thread slot may briefly name the same channel (a
// client that thread-joins what it is already viewing). `channelPresence` is a
// Set of connections, so the double registration is one entry, and
// `leaveThread` only removes the conn from the set when the primary slot does
// not also claim it.
function joinThread(conn: ChatConnection, channelId: string): void {
  const present = channelPresence.get(channelId) ?? new Set<ChatConnection>();
  present.add(conn);
  channelPresence.set(channelId, present);
  conn.threadChannelId = channelId;
}

function leaveThread(conn: ChatConnection): void {
  if (!conn.threadChannelId) {
    return;
  }
  const channelId = conn.threadChannelId;
  conn.threadChannelId = null;
  if (conn.channelId === channelId) {
    // The primary slot still owns the presence entry.
    return;
  }
  const presence = channelPresence.get(channelId);
  presence?.delete(conn);
  if (presence && presence.size === 0) {
    channelPresence.delete(channelId);
  }
  broadcastPresence(channelId);
}

function ensureConnection(socket: WebSocket, user: DbUser): ChatConnection {
  let conn = connections.get(socket);
  if (!conn) {
    conn = { socket, user, channelId: null, threadChannelId: null };
    connections.set(socket, conn);
    socket.on("close", () => {
      const active = connections.get(socket);
      if (active) {
        // --- threads --- before the primary, so the shared-entry guard in
        // leaveThread sees the primary slot still set and skips the double
        // presence broadcast.
        leaveThread(active);
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
 *
 * Fan-out goes through the `channelPresence` index rather than a scan of every
 * connection on the process: a busy channel on a box holding thousands of
 * sockets was costing one iteration per socket per message, when the work owed
 * is one per viewer. `joinChannel` / `leaveChannel` are what keep that index
 * equal to "every connection whose `channelId` is this channel".
 */
export function broadcastToChannel(
  channelId: string,
  message: ChatServerMessage,
  alsoSocket?: WebSocket,
): void {
  deliverToChannel(channelId, message, alsoSocket);
  if (isBusEnabled()) {
    // `alsoSocket` is deliberately not published: it is a socket on *this*
    // process, and the only reason it exists is to serve a sender who is not
    // viewing the channel. No other instance holds it, and every other
    // instance's viewers are covered by the loop above on their side.
    publishToCluster(BROADCAST_TOPIC, { channelId, message });
  }
}

/**
 * The local half of `broadcastToChannel`, and the *only* thing a frame arriving
 * from the bus is allowed to call. Separating them is the loop guard's second
 * line of defence: even a frame that somehow escaped the origin check in
 * `bus.ts` could not be re-published from here.
 */
function deliverToChannel(
  channelId: string,
  message: ChatServerMessage,
  alsoSocket?: WebSocket,
): void {
  const payload = encode(message);
  let sentToAlso = false;
  for (const conn of channelPresence.get(channelId) ?? []) {
    if (conn.socket.readyState !== 1) {
      continue;
    }
    if (conn.socket === alsoSocket) {
      sentToAlso = true;
    }
    conn.socket.send(payload);
  }
  // The sender hears their own message even when they are not viewing the
  // channel — but only once, hence the flag: a sender who *is* viewing it was
  // already served by the loop, and two copies would double-render the bubble.
  if (alsoSocket && !sentToAlso && alsoSocket.readyState === 1) {
    alsoSocket.send(payload);
  }
}

/**
 * A link with nothing cached yet must never delay the message it arrived on —
 * the create/edit response and its first broadcast go out with no embed, and
 * this resolves the fetch in the background, then pushes a `message-update`
 * to everyone watching the channel once it lands. `fetchAndCacheEmbed` itself
 * never throws, but the `.catch` stays anyway: an unhandled rejection here
 * would crash the whole process for every connected client, the exact
 * failure mode pitfall #8 in CLAUDE.md documents.
 *
 * Exported so the HTTP edit route can trigger the same resolution the WS
 * create path does, without either owning a private copy of it.
 */
export function resolveEmbedInBackground(
  channelId: string,
  message: ReturnType<typeof mapMessage>,
  url: string,
): void {
  void fetchAndCacheEmbed(url)
    .then((embed) => {
      if (!embed) {
        return;
      }
      broadcastToChannel(channelId, {
        type: "message-update",
        message: { ...message, embeds: [embed] },
      });
    })
    .catch((error) => {
      console.error(
        `[chat] embed resolution failed for message ${message.id}:`,
        (error as Error).message,
      );
    });
}

/**
 * Tell every connected client that somebody's name or picture changed.
 *
 * NOT ADDRESSED TO A CHANNEL, unlike everything else in this file. An avatar is
 * drawn in the member list of a server nobody is viewing, in a conversation row
 * in the sidebar, in a call roster, and beside every message that person ever
 * sent — none of which is reachable from a channel id. Fanning out to every
 * socket is what makes a change land in all of them at once instead of on the
 * next reload.
 *
 * The cost is O(sockets) per profile edit, which is the right trade: a rename
 * is a once-in-a-while action, and the frame is five short strings. Nothing in
 * it is private — see the note on `profileUpdateSchema`.
 *
 * Called from the HTTP profile and avatar routes, so there is no sender socket
 * and no need for one: the editor's own client is a client like any other and
 * updating it from the same frame is what stops it drifting from everyone else.
 */
export function broadcastProfileUpdate(update: ProfileUpdate): void {
  deliverProfileUpdate(update);
  if (isBusEnabled()) {
    publishToCluster(PROFILE_TOPIC, update);
  }
}

/** The local half, and the only thing a bus frame may call. See above. */
function deliverProfileUpdate(update: ProfileUpdate): void {
  const payload = encode(update);
  forEachAuthenticatedSocket((socket) => {
    if (socket.readyState === 1) {
      socket.send(payload);
    }
  });
}

/**
 * Nudge ONE person: their friendships changed, so the badge and any open list
 * should re-read.
 *
 * The opposite addressing to `broadcastProfileUpdate` directly above, and the
 * same addressing as `sendSanctionNotice` below — every socket this account
 * holds and no others. Which is why the frame can afford to carry nothing: the
 * recipient is, by construction, somebody entitled to `GET /api/friends`, and
 * that read is the payload.
 *
 * Fanned across the bus because a person's sockets are not all on this replica —
 * an open laptop and a phone routinely land on different ones, and the whole
 * complaint this fixes is "the app I am looking at did not update".
 *
 * Fire-and-forget on purpose: a friend request must not fail because a socket
 * write did. The HTTP response is the acknowledgement; this is a nicety on top,
 * and `WHICH SOCKETS ARE OPEN` is not something the route should wait to learn.
 */
export function notifyFriendActivity(
  userId: string,
  kind: FriendActivity["kind"],
): void {
  deliverFriendActivity(userId, kind);
  if (isBusEnabled()) {
    publishToCluster(FRIEND_TOPIC, { userId, kind });
  }
}

/** The local half, and the only thing a bus frame may call. See above. */
function deliverFriendActivity(
  userId: string,
  kind: FriendActivity["kind"],
): void {
  const payload = encode({ type: "friend-activity", kind } as const);
  forEachAuthenticatedSocket((socket, user) => {
    if (socket.readyState === 1 && user.id === userId) {
      socket.send(payload);
    }
  });
}

/**
 * Tell every connected member of a server that their resolved bits may have
 * changed. Bumps `permissions_version` first so the frame is always newer
 * than the snapshot the client already holds; a same-version ping would be
 * dropped. Content-free otherwise: each client refetches
 * `GET /api/servers/:id/permissions`. Same addressing as `friend-activity`
 * (per member, never a channel fan-out), same fire-and-forget.
 */
export async function notifyPermissionsUpdate(
  serverId: string,
): Promise<void> {
  const version = await bumpPermissionsVersion(serverId);
  const memberIds = await listServerMemberIds(serverId);
  deliverPermissionsUpdate(serverId, version, memberIds);
  if (isBusEnabled()) {
    publishToCluster(PERMISSIONS_TOPIC, {
      type: "permissions-update",
      serverId,
      version,
    });
  }
}

/** Test seam and local half. Membership is passed in so unit tests need no DB. */
export function deliverPermissionsUpdate(
  serverId: string,
  version: number,
  memberIds: readonly string[],
): void {
  const allowed = new Set(memberIds);
  const payload = encode({
    type: "permissions-update",
    serverId,
    version,
  } as const);
  forEachAuthenticatedSocket((socket, user) => {
    if (socket.readyState === 1 && allowed.has(user.id)) {
      socket.send(payload);
    }
  });
}

/**
 * Tell every connected member of a server that Baú changed. Content-free:
 * each client refetches `GET /api/servers/:id/home/posts`. Same addressing as
 * permissions-update (per member, never a channel fan-out).
 */
export async function notifyCommunityHomeUpdate(
  serverId: string,
): Promise<void> {
  const memberIds = await listServerMemberIds(serverId);
  deliverCommunityHomeUpdate(serverId, memberIds);
  if (isBusEnabled()) {
    publishToCluster(COMMUNITY_HOME_TOPIC, {
      type: "community-home-update",
      serverId,
    });
  }
}

export function deliverCommunityHomeUpdate(
  serverId: string,
  memberIds: readonly string[],
): void {
  const allowed = new Set(memberIds);
  const payload = encode({
    type: "community-home-update",
    serverId,
  } as const);
  forEachAuthenticatedSocket((socket, user) => {
    if (socket.readyState === 1 && allowed.has(user.id)) {
      socket.send(payload);
    }
  });
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
 * Who an eviction applies to. A plain data description rather than a predicate
 * *because it has to cross the bus*: an eviction that only ran on the instance
 * that handled the HTTP request would leave a kicked, banned or newly excluded
 * user still receiving the channel's messages from every other instance. A
 * closure cannot be published; this can.
 *
 * Exactly one field is set by every caller. Both empty means "everyone".
 */
export interface EvictionScope {
  /** Evict only these users. */
  onlyUserIds?: string[];
  /** Evict everyone except these users. */
  exceptUserIds?: string[];
}

/**
 * Compiled once per eviction rather than tested per connection: the "except"
 * list is every user with access to a channel, and the loop below runs over
 * every connection on the process.
 */
function scopePredicate(scope?: EvictionScope): (userId: string) => boolean {
  if (!scope) {
    return () => true;
  }
  const only = scope.onlyUserIds ? new Set(scope.onlyUserIds) : null;
  const except = scope.exceptUserIds ? new Set(scope.exceptUserIds) : null;
  return (userId) => (!only || only.has(userId)) && !except?.has(userId);
}

/**
 * Force everyone out of a channel's live view. Called when a channel is deleted
 * or a member loses access, so a revoked user stops receiving broadcasts without
 * having to reconnect.
 */
export function evictChannelViewers(
  channelId: string,
  scope?: EvictionScope,
): void {
  evictChannelViewersLocally(channelId, scope);
  if (isBusEnabled()) {
    publishToCluster(EVICT_TOPIC, { kind: "channel", channelId, scope });
  }
}

function evictChannelViewersLocally(
  channelId: string,
  scope?: EvictionScope,
): void {
  const matches = scopePredicate(scope);
  for (const conn of connections.values()) {
    if (!matches(conn.user.id)) {
      continue;
    }
    // --- threads --- the secondary slot is a live view like any other, and a
    // revoked viewer must lose it the same instant they lose the primary one.
    if (conn.threadChannelId === channelId) {
      leaveThread(conn);
    }
    if (conn.channelId === channelId) {
      leaveChannel(conn);
    }
  }
}

/** Drop a user out of any channel view belonging to the given channel ids. */
export function evictUserFromChannels(
  userId: string,
  channelIds: Set<string>,
): void {
  evictUserFromChannelsLocally(userId, channelIds);
  if (isBusEnabled()) {
    publishToCluster(EVICT_TOPIC, {
      kind: "user",
      userId,
      channelIds: [...channelIds],
    });
  }
}

function evictUserFromChannelsLocally(
  userId: string,
  channelIds: Set<string>,
): void {
  for (const conn of connections.values()) {
    if (conn.user.id !== userId) {
      continue;
    }
    // --- threads --- a kick or ban evicts by the server's whole channel-id
    // set, which includes thread rows, so the panel closes with the channel.
    if (conn.threadChannelId && channelIds.has(conn.threadChannelId)) {
      leaveThread(conn);
    }
    if (conn.channelId && channelIds.has(conn.channelId)) {
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
  mentions: string[],
  repliedToUserId?: string | null,
  options?: {
    webPush?: boolean;
    mentionEveryone?: boolean;
    mentionHereUserIds?: readonly string[];
  },
): Promise<void> {
  const [audience, blockers] = await Promise.all([
    getChannelAudience(channelId),
    listBlockersOf(authorId),
  ]);
  if (!audience) {
    return;
  }

  // Mentions arrive already extracted rather than as the message body: the
  // cluster frame for this fan-out carries them, and shipping a 4000-character
  // body over the bus purely to re-run the same regex on the other side would
  // be both larger and slower.
  const mentioned = new Set(mentions);
  const hereIds = new Set(options?.mentionHereUserIds ?? []);

  forEachAuthenticatedSocket((socket, user) => {
    if (socket.readyState !== 1 || user.id === authorId) {
      return;
    }
    // `audience.has`, not a Set built from `audience.userIds`: the audience is
    // cached and shared between messages, so materialising it here would put
    // one allocation per *member of the server* back on the path this cache
    // exists to take it off.
    if (!audience.has(user.id)) {
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
          Boolean(user.username && mentioned.has(user.username)) ||
          options?.mentionEveryone === true ||
          hereIds.has(user.id),
      }),
    );
  });

  // The Web Push leg of the same decision. It is handed this function's
  // conclusions — the audience, the blockers, the mentions — rather than
  // re-deriving any of them, and adds only the narrowing that is push's own:
  // no live socket anywhere in the cluster, not on DND, level allows it.
  // Inert unless VAPID keys are configured; fire-and-forget so the socket
  // fan-out never waits on a push vendor.
  if (options?.webPush !== false) {
    pushChannelActivity({
      channelId,
      audience,
      authorId,
      mentionedUsernames: mentions,
      repliedToUserId: repliedToUserId ?? null,
      blockerIds: blockers,
      mentionEveryone: options?.mentionEveryone === true,
      mentionHereUserIds: options?.mentionHereUserIds ?? [],
    });
  }
}

/**
 * Tell a timed-out sender why their frame went nowhere.
 *
 * A WebSocket frame has no status code, so a refusal that is not answered
 * becomes a red bubble after the client's send timer expires. Timeouts use
 * `sanction-notice`. Ordinary `message-create` refusals use `message-rejected`
 * below. A malformed frame can still drop silently.
 *
 * `sanction-notice` is not a member of `CHAT_SERVER_MESSAGE_TYPES` — see the
 * note on `sanctionNoticeSchema` in shared. It is sent regardless, because a
 * frame a client drops costs nothing and a frame that was never sent can never
 * be rendered.
 */
function sendSanctionNotice(
  socket: WebSocket,
  channelId: string,
  timeout: ActiveTimeout,
): void {
  if (socket.readyState !== 1) {
    return;
  }
  socket.send(
    JSON.stringify({
      type: "sanction-notice",
      sanction: "timeout",
      serverId: timeout.serverId,
      channelId,
      expiresAt: timeout.expiresAt.toISOString(),
      reason: timeout.reason,
      message: timeoutMessage(timeout),
    }),
  );
}

/**
 * Tell the sender a `message-create` will not land.
 *
 * Same addressing as `sendSanctionNotice`: this socket only. The reasons
 * cover the four early returns of `message-create`. A blocked DM uses
 * `undeliverable`, never a block-specific token.
 */
function sendMessageRejected(
  socket: WebSocket,
  channelId: string,
  nonce: string | undefined,
  reason: MessageRejectReason,
  retryAfterMs?: number,
): void {
  if (socket.readyState !== 1) {
    return;
  }
  socket.send(
    encode({
      type: "message-rejected",
      channelId,
      reason,
      ...(nonce ? { nonce } : {}),
      ...(retryAfterMs && retryAfterMs > 0 ? { retryAfterMs } : {}),
    }),
  );
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

  // ------------------------------------------------------ the timeout gate
  //
  // THE WEBSOCKET CHOKEPOINT. One guard, before any frame is handled, for the
  // same reason `handleApi` gates the age check before `router.match`: a
  // per-branch check is a check somebody forgets on the branch where it
  // matters, and this function grows a branch every time the protocol does.
  //
  // Deliberately NOT in `resolveAuthUser`, where the socket half of the age
  // gate lives. A socket authenticates once and then lives for hours, so a
  // connection-time check would leave a timeout issued at 14:00 binding nobody
  // who was already online at 13:59 — which is every person a moderator is
  // actually reacting to. Here it is re-evaluated per frame, so a sanction
  // takes hold on the sender's very next keystroke and, equally, *releases*
  // them the moment it expires with nothing scheduled to make that true.
  //
  // `findTimeoutForChannel` reaches a server only through `channels.server_id`,
  // which is NULL for a conversation — so this guard can be unconditional and
  // still be structurally incapable of silencing somebody's direct messages.
  // That is rule 2 in shared/sanctions.ts, enforced by a join rather than by
  // this comment.
  //
  // `typing` is on the list. It costs one indexed lookup per frame on a path
  // that is already rate-limited, and leaving it off would let a timed-out
  // member park "X is typing…" in the channel they were just told to stop
  // posting in — which is the disruption, minus the words.
  if (
    payload.type === "message-create" ||
    payload.type === "reaction-toggle" ||
    payload.type === "poll-vote" ||
    payload.type === "poll-close" ||
    payload.type === "typing"
  ) {
    const timeout = await findTimeoutForChannel(
      conn.user.id,
      payload.channelId,
    );
    if (timeout) {
      // Not for `typing`: that frame fires per keystroke behind its own
      // limiter, and answering each one would turn a notice into a flood. The
      // notice the sender needs comes from the send they are typing towards.
      if (payload.type !== "typing") {
        sendSanctionNotice(conn.socket, payload.channelId, timeout);
      }
      return;
    }
  }

  if (payload.type === "join-channel") {
    if (!(await canAccessChannel(payload.channelId, conn.user.id))) {
      return;
    }
    leaveChannel(conn);
    joinChannel(conn, payload.channelId);
    broadcastPresence(payload.channelId);
    return;
  }

  if (payload.type === "leave-channel") {
    leaveChannel(conn);
    return;
  }

  // --- threads ---
  //
  // The side-panel slot. Access is the same predicate as join-channel — which,
  // for a thread, is the *parent's* answer by construction — and the target
  // must actually be a thread: without that check this frame would be a way to
  // hold live delivery for two arbitrary channels at once, which no UI asks
  // for and no rate limit prices.
  if (payload.type === "thread-join") {
    if (!(await getThreadInfo(payload.channelId))) {
      return;
    }
    if (!(await canAccessChannel(payload.channelId, conn.user.id))) {
      return;
    }
    leaveThread(conn);
    joinThread(conn, payload.channelId);
    broadcastPresence(payload.channelId);
    return;
  }

  if (payload.type === "thread-leave") {
    leaveThread(conn);
    return;
  }

  // Idle is the one derived status the server cannot work out for itself: an
  // abandoned tab answers heartbeats and holds its socket exactly like an
  // attended one, so "no traffic on this socket" is not evidence of "nobody
  // there". The client watches for real input and reports the transition; this
  // is where that lands.
  //
  // No rate limiter of its own. The frame is only sent on a change of state
  // behind a ten-minute threshold, `setSocketIdle` drops a value that is already
  // set, and the per-socket limiter in ws/index.ts bounds a client that lies
  // about all three. Nothing on this path touches the database.
  if (payload.type === "set-idle") {
    setSocketIdle(conn.socket, payload.idle);
    return;
  }

  if (payload.type === "typing") {
    // --- threads --- typing in the side panel is as legitimate as typing in
    // the primary channel; either slot proves the join-time access check ran.
    if (
      conn.channelId !== payload.channelId &&
      conn.threadChannelId !== payload.channelId
    ) {
      return;
    }
    // The second passive giveaway, and the subtler one. "X is typing…" fires on
    // a keystroke in a box, so it announces somebody who may never send
    // anything — you can be given away by a message you thought better of. A
    // person who asked to be hidden and then surfaces in a live indicator has
    // been un-hidden by the app rather than by a choice they made.
    //
    // What they give up is the courtesy of the indicator, not the ability to
    // talk: sending still works, and the message that arrives carries their
    // name, because saying something is a deliberate act. Checked before the
    // limiter so a hidden client costs a map lookup rather than a token.
    if (isInvisible(conn.user.id)) {
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
    // Same index, same reason as `broadcastToChannel`: this is the app's
    // hottest fan-out and it must not walk every socket once per keystroke.
    for (const other of channelPresence.get(payload.channelId) ?? []) {
      if (other !== conn && other.socket.readyState === 1) {
        other.socket.send(encoded);
      }
    }
    if (isBusEnabled()) {
      // The hottest thing on the bus by a wide margin — one frame per user per
      // second at the limiter's sustained rate. Bounded by `typingLimiter`
      // above, which is why the limiter runs before this and not after.
      publishToCluster(TYPING_TOPIC, {
        channelId: payload.channelId,
        userId: conn.user.id,
        displayName: conn.user.display_name,
      });
    }
    return;
  }

  if (payload.type === "message-create") {
    // Throttle sends per user so a single socket can't flood the channel/DB.
    if (!messageLimiter.take(conn.user.id)) {
      sendMessageRejected(
        conn.socket,
        payload.channelId,
        payload.nonce,
        "rate-limited",
        messageLimiter.retryAfter(conn.user.id) * 1000,
      );
      return;
    }
    if (!(await canAccessChannel(payload.channelId, conn.user.id))) {
      sendMessageRejected(
        conn.socket,
        payload.channelId,
        payload.nonce,
        "no-access",
      );
      return;
    }
    const channel = await getChannel(payload.channelId);
    let canMentionEveryone = false;
    if (channel?.kind === "server" && channel.server_id) {
      const perms = await computeMemberPermissions(
        channel.server_id,
        conn.user.id,
        payload.channelId,
      );
      if (!hasPermission(perms, Permission.SEND_MESSAGES)) {
        sendMessageRejected(
          conn.socket,
          payload.channelId,
          payload.nonce,
          "cannot-send",
        );
        return;
      }
      canMentionEveryone = hasPermission(perms, Permission.MENTION_EVERYONE);
    }
    // A block closes a 1:1 in both directions. The sender is told the
    // create will not land; the reason stays vague so this is not an
    // oracle for "has this person blocked me". The conversation is not
    // restored.
    if (await isDmSendBlocked(payload.channelId, conn.user.id)) {
      sendMessageRejected(
        conn.socket,
        payload.channelId,
        payload.nonce,
        "undeliverable",
      );
      return;
    }

    // A client that posts without ever sending `join-channel` is still viewing
    // the channel as far as every fan-out here is concerned, so it must land in
    // the presence index too — assigning `channelId` alone used to work only
    // because fan-out re-scanned that field, and would now drop every later
    // message in this channel for this socket. No `broadcastPresence` on this
    // path: it stays as quiet as it was, and the next real join or leave
    // publishes the corrected roster.
    if (!conn.channelId) {
      joinChannel(conn, payload.channelId);
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

    const parsedMentions = extractMentions(payload.body);
    let hereUserIds: string[] = [];
    const mentionEveryone =
      channel?.kind === "server" &&
      parsedMentions.everyone &&
      canMentionEveryone;
    const mentionHere =
      channel?.kind === "server" && parsedMentions.here && canMentionEveryone;
    if (mentionHere) {
      const hereAudience = await getChannelAudience(payload.channelId);
      hereUserIds = (hereAudience?.userIds ?? []).filter(
        (id) => id !== conn.user.id && isPresentForHere(id),
      );
    }

    const dbMessage = await createMessage(
      payload.channelId,
      conn.user,
      payload.body,
      parent?.id ?? null,
      payload.attachmentIds,
      {
        mentionEveryone,
        mentionHere,
        extraUserIds: hereUserIds,
        canMentionEveryone,
      },
      payload.chance || payload.poll
        ? { chance: payload.chance, poll: payload.poll }
        : undefined,
    );
    // Nothing survived: an attachment-only message whose every upload failed
    // its verification. The frame said something when it was sent and says
    // nothing now, so it is dropped like any other frame that does not describe
    // a message — broadcasting an empty bubble would be worse than silence.
    if (!dbMessage) {
      return;
    }

    try {
      await enqueueOutgoingMessageCreated({
        channelId: payload.channelId,
        messageId: dbMessage.id,
        authorId: conn.user.id,
        body: dbMessage.body,
        createdAt: dbMessage.created_at,
        replyToId: dbMessage.reply_to_id ?? null,
      });
    } catch (error) {
      console.error("[outgoing-webhooks] enqueue failed:", error);
    }

    const message = mapMessage(dbMessage);
    // A link somebody else already shared resolves instantly from cache and
    // rides the very first broadcast; a link nobody has posted before goes
    // out without one and catches up over `resolveEmbedInBackground` below —
    // either way this never blocks the message itself on a network fetch.
    const url = extractFirstUrl(payload.body);
    let cacheFresh = true;
    if (url) {
      const state = await getEmbedCacheState(url);
      cacheFresh = state.fresh;
      if (state.embed) {
        message.embeds = [state.embed];
      }
    }

    broadcastToChannel(
      payload.channelId,
      {
        type: "message-broadcast",
        message,
        ...(payload.nonce ? { nonce: payload.nonce } : {}),
      },
      conn.socket,
    );

    const mentions = extractMentionUsernames(payload.body);
    if (isBusEnabled()) {
      publishToCluster(ACTIVITY_TOPIC, {
        channelId: payload.channelId,
        authorId: conn.user.id,
        mentions,
        repliedToUserId: parent?.author_id ?? null,
        mentionEveryone,
        mentionHereUserIds: hereUserIds,
      });
    }
    await notifyChannelActivity(
      payload.channelId,
      conn.user.id,
      mentions,
      parent?.author_id ?? null,
      { mentionEveryone, mentionHereUserIds: hereUserIds },
    );

    // --- threads ---
    // A message into a thread owes the PARENT channel's viewers a chip
    // refresh: reply count and freshness on the origin message, with no
    // content attached. One indexed lookup per send answers "is this channel a
    // thread" and, for the overwhelming majority of sends, is the entire cost.
    // Fanned out through `broadcastToChannel`, so the cluster relay carries it
    // to viewers held by other instances — `thread-update` is in
    // CHAT_SERVER_MESSAGE_TYPES for exactly that reason.
    const threadInfo = await getThreadInfo(payload.channelId);
    if (threadInfo?.rootMessageId) {
      broadcastToChannel(threadInfo.parentChannelId, {
        type: "thread-update",
        channelId: threadInfo.parentChannelId,
        messageId: threadInfo.rootMessageId,
        thread: threadInfo,
      });
    }

    // Only a genuine cache miss re-fetches — a fresh `failed` row already
    // covers this url for FAILURE_TTL_MS, and re-trying it on every message
    // that repeats a dead link would defeat that TTL entirely.
    if (url && !cacheFresh) {
      resolveEmbedInBackground(payload.channelId, message, url);
    }
    return;
  }

  if (payload.type === "reaction-toggle") {
    if (!reactionLimiter.take(conn.user.id)) {
      return;
    }
    if (!(await canAccessChannel(payload.channelId, conn.user.id))) {
      return;
    }
    const reactionChannel = await getChannel(payload.channelId);
    if (reactionChannel?.kind === "server" && reactionChannel.server_id) {
      const perms = await computeMemberPermissions(
        reactionChannel.server_id,
        conn.user.id,
        payload.channelId,
      );
      if (!hasPermission(perms, Permission.ADD_REACTIONS)) {
        return;
      }
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

    // Same implicit join as the message path, and index it for the same reason.
    if (!conn.channelId) {
      joinChannel(conn, payload.channelId);
    }

    const { added } = await toggleReaction(
      payload.messageId,
      conn.user.id,
      payload.emoji,
    );
    const displayName = await resolveChannelMemberName(
      payload.channelId,
      conn.user.id,
      conn.user.display_name,
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
        displayName,
      },
      conn.socket,
    );
  }

  if (payload.type === "poll-vote" || payload.type === "poll-close") {
    if (!reactionLimiter.take(conn.user.id)) {
      return;
    }
    if (!(await canAccessChannel(payload.channelId, conn.user.id))) {
      return;
    }
    if (await isDmSendBlocked(payload.channelId, conn.user.id)) {
      return;
    }
    const messageChannelId = await getMessageChannelId(payload.messageId);
    if (!messageChannelId || messageChannelId !== payload.channelId) {
      return;
    }
    if (!conn.channelId) {
      joinChannel(conn, payload.channelId);
    }

    if (payload.type === "poll-vote") {
      const voted = await votePoll(
        payload.messageId,
        conn.user.id,
        payload.optionId,
      );
      if (!voted) {
        return;
      }
      broadcastToChannel(payload.channelId, {
        type: "poll-update",
        channelId: payload.channelId,
        messageId: payload.messageId,
        poll: { ...voted.poll, canClose: false },
        voterId: conn.user.id,
        optionId: payload.optionId,
        added: voted.added,
      });
      return;
    }

    const pollChannel = await getChannel(payload.channelId);
    let canManage = false;
    if (pollChannel?.kind === "server" && pollChannel.server_id) {
      const perms = await computeMemberPermissions(
        pollChannel.server_id,
        conn.user.id,
        payload.channelId,
      );
      canManage = hasPermission(perms, Permission.MANAGE_MESSAGES);
    }
    const closed = await closePoll(payload.messageId, conn.user.id, canManage);
    if (!closed) {
      return;
    }
    broadcastToChannel(payload.channelId, {
      type: "poll-update",
      channelId: payload.channelId,
      messageId: payload.messageId,
      poll: { ...closed, canClose: false },
    });
  }
}

// ------------------------------------------------------------ cluster bus
//
// Everything below is inert unless a transport has been installed
// (`CLUSTER_BUS=postgres`). Subscriptions are registered at import time
// regardless, because the transport is chosen after this module loads and a
// handler that is never called costs nothing.
//
// The one rule these handlers all obey: they call the *local* half of a
// fan-out, never the exported one. `deliverToChannel`, not
// `broadcastToChannel`; `sendPresence`, not `broadcastPresence`;
// `evictChannelViewersLocally`, not `evictChannelViewers`. That, plus the
// origin check in `bus.ts`, is what stops a message from being re-published by
// the instance that received it.

function asRecord(data: unknown): Record<string, unknown> | null {
  return typeof data === "object" && data !== null
    ? (data as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asPresenceUsers(value: unknown): PresenceUser[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const users: PresenceUser[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const id = asString(record?.id);
    const name = asString(record?.name);
    if (!record || !id || name === null) {
      continue;
    }
    users.push({ id, name, avatarUrl: asString(record.avatarUrl) });
  }
  return users;
}

/**
 * Frames are validated even though they come from our own cluster rather than
 * from a client. The threat is not a hostile publisher, it is version skew: a
 * rolling deploy has two builds on one bus, and a frame shaped slightly
 * differently must be ignored rather than fanned out as a malformed WS message
 * to every viewer.
 */
subscribeToCluster(BROADCAST_TOPIC, (data) => {
  const frame = asRecord(data);
  const channelId = asString(frame?.channelId);
  const message = asRecord(frame?.message);
  if (
    !channelId ||
    !message ||
    typeof message.type !== "string" ||
    !isChatServerMessage(message as { type: string })
  ) {
    return;
  }
  deliverToChannel(channelId, message as unknown as ChatServerMessage);
});

subscribeToCluster(PRESENCE_TOPIC, (data, origin) => {
  const frame = asRecord(data);
  const channelId = asString(frame?.channelId);
  const users = asPresenceUsers(frame?.users);
  if (!channelId || !users) {
    return;
  }

  const existing = remotePresence.get(channelId);
  if (users.length === 0) {
    // An instance with nobody left in the channel. Forgetting it here is what
    // makes a clean shutdown or a last viewer leaving take effect immediately
    // instead of waiting out the TTL.
    existing?.delete(origin);
    if (existing && existing.size === 0) {
      remotePresence.delete(channelId);
    }
  } else {
    const byInstance = existing ?? new Map();
    byInstance.set(origin, { users, at: Date.now() });
    remotePresence.set(channelId, byInstance);
  }

  sendPresence(channelId);

  // Answer a real change with our own contribution so a channel converges the
  // moment somebody joins anywhere, rather than at the next refresh tick — the
  // window that would otherwise show a new joiner an incomplete roster for up
  // to PRESENCE_REFRESH_MS. Answers are `refresh`, and a `refresh` is never
  // answered, so this terminates after one round trip.
  if (
    frame?.kind === "update" &&
    (channelPresence.get(channelId)?.size ?? 0) > 0
  ) {
    publishPresence(channelId, "refresh");
  }
});

subscribeToCluster(TYPING_TOPIC, (data) => {
  const frame = asRecord(data);
  const channelId = asString(frame?.channelId);
  const userId = asString(frame?.userId);
  const displayName = asString(frame?.displayName);
  if (!channelId || !userId || displayName === null) {
    return;
  }
  const encoded = encode({
    type: "typing-broadcast",
    channelId,
    userId,
    displayName,
  });
  // No self-exclusion: the typist's own socket is on the publishing instance.
  // A second tab of the same user held here does receive it — which is already
  // what happens with two tabs on one process today, so the behaviour is the
  // same whichever instance the tabs landed on.
  for (const conn of channelPresence.get(channelId) ?? []) {
    if (conn.socket.readyState === 1) {
      conn.socket.send(encoded);
    }
  }
});

subscribeToCluster(ACTIVITY_TOPIC, (data) => {
  const frame = asRecord(data);
  const channelId = asString(frame?.channelId);
  const authorId = asString(frame?.authorId);
  const mentions = asStringArray(frame?.mentions);
  if (!channelId || !authorId || !mentions) {
    return;
  }
  const mentionHereUserIds = asStringArray(frame?.mentionHereUserIds) ?? [];
  void notifyChannelActivity(
    channelId,
    authorId,
    mentions,
    asString(frame?.repliedToUserId),
    {
      webPush: false,
      mentionEveryone: frame?.mentionEveryone === true,
      mentionHereUserIds,
    },
  ).catch((error) => {
    console.error("[chat] cluster activity fan-out failed:", error);
  });
});

subscribeToCluster(EVICT_TOPIC, (data) => {
  const frame = asRecord(data);
  if (frame?.kind === "channel") {
    const channelId = asString(frame.channelId);
    if (!channelId) {
      return;
    }
    const scope = asRecord(frame.scope);
    if (scope) {
      const onlyUserIds = asStringArray(scope.onlyUserIds);
      const exceptUserIds = asStringArray(scope.exceptUserIds);
      // A scope that arrived but parsed to nothing is dropped rather than
      // treated as "no scope": an unrecognised narrowing would otherwise widen
      // into evicting every viewer of the channel.
      if (!onlyUserIds && !exceptUserIds) {
        return;
      }
      evictChannelViewersLocally(channelId, { onlyUserIds, exceptUserIds });
      return;
    }
    evictChannelViewersLocally(channelId);
    return;
  }
  if (frame?.kind === "user") {
    const userId = asString(frame.userId);
    const channelIds = asStringArray(frame.channelIds);
    if (!userId || !channelIds) {
      return;
    }
    evictUserFromChannelsLocally(userId, new Set(channelIds));
  }
});

/**
 * A profile edit on another instance.
 *
 * Parsed with the schema rather than field-picked like the topics above,
 * because this frame goes straight out to every socket on this box: anything
 * that gets through here is something every client is asked to render. The
 * schema is the same one those clients parse with, so a frame this instance
 * would refuse is a frame they would have refused too.
 */
subscribeToCluster(PROFILE_TOPIC, (data) => {
  const parsed = profileUpdateSchema.safeParse(data);
  if (parsed.success) {
    deliverProfileUpdate(parsed.data);
  }
});

/**
 * A friend nudge raised on another instance, for somebody whose socket may be
 * on this one.
 *
 * The bus frame is the wire frame plus the ADDRESSEE, which is the whole
 * routing decision and cannot be recovered from a content-free payload. Both
 * fields must survive validation: without a usable `userId` the only
 * alternatives are guessing and broadcasting, and the second is how a badge
 * shows up on a stranger's screen. `kind` is re-checked against the schema's own
 * enum rather than trusted, so a future instance running a newer build cannot
 * make this one emit a frame its clients would refuse.
 */
subscribeToCluster(FRIEND_TOPIC, (data) => {
  const frame = asRecord(data);
  const userId = asString(frame?.userId);
  const kind = asString(frame?.kind);
  if (!userId || !kind || !isFriendActivityKind(kind)) {
    return;
  }
  deliverFriendActivity(userId, kind);
});

subscribeToCluster(PERMISSIONS_TOPIC, (data) => {
  const parsed = permissionsUpdateSchema.safeParse(data);
  if (!parsed.success) {
    return;
  }
  void listServerMemberIds(parsed.data.serverId)
    .then((memberIds) => {
      deliverPermissionsUpdate(
        parsed.data.serverId,
        parsed.data.version,
        memberIds,
      );
    })
    .catch((error) => {
      console.error("[ws] permissions-update relay failed:", error);
    });
});

subscribeToCluster(COMMUNITY_HOME_TOPIC, (data) => {
  if (
    !data ||
    typeof data !== "object" ||
    (data as { type?: string }).type !== "community-home-update" ||
    typeof (data as { serverId?: string }).serverId !== "string"
  ) {
    return;
  }
  const serverId = (data as { serverId: string }).serverId;
  void listServerMemberIds(serverId)
    .then((memberIds) => {
      deliverCommunityHomeUpdate(serverId, memberIds);
    })
    .catch((error) => {
      console.error("[ws] community-home-update relay failed:", error);
    });
});

/** The enum, asked rather than restated — one list, in shared. */
function isFriendActivityKind(
  value: string,
): value is FriendActivity["kind"] {
  return friendActivitySchema.shape.kind.safeParse(value).success;
}

/**
 * Re-announce this instance's presence contributions, and forget contributions
 * from instances that have stopped announcing theirs.
 *
 * Started only when the bus is on. Without it, presence would still be correct
 * for every *clean* transition — join, leave, shutdown all publish — and
 * permanently wrong after a crash, because the dead instance's viewers would
 * never be withdrawn by anybody.
 */
export function startClusterPresenceRefresh(
  intervalMs = PRESENCE_REFRESH_MS,
): () => void {
  // Announce at once: a starting instance is invisible to its peers until it
  // says something, and its first user should not have to wait a full tick to
  // appear to everyone else.
  for (const channelId of channelPresence.keys()) {
    publishPresence(channelId, "refresh");
  }

  const timer = setInterval(() => {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    for (const [channelId, byInstance] of remotePresence) {
      let expired = false;
      for (const [origin, contribution] of byInstance) {
        if (contribution.at < cutoff) {
          byInstance.delete(origin);
          expired = true;
        }
      }
      if (byInstance.size === 0) {
        remotePresence.delete(channelId);
      }
      if (expired) {
        sendPresence(channelId);
      }
    }
    for (const channelId of channelPresence.keys()) {
      publishPresence(channelId, "refresh");
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

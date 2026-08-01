import type { IncomingMessage, ServerResponse } from "node:http";
import {
  addChannelMemberSchema,
  banMemberSchema,
  createChannelSchema,
  createInviteSchema,
  createServerSchema,
  GIF_PAGE_MAX,
  GIF_PAGE_SIZE,
  GIF_QUERY_MAX_LENGTH,
  MESSAGE_PAGE_MAX,
  MESSAGE_PAGE_SIZE,
  messageSearchQuerySchema,
  removeMemberSchema,
  SEARCH_PAGE_MAX,
  SEARCH_PAGE_SIZE,
  updateChannelSchema,
  updateMemberRoleSchema,
  updateMessageSchema,
  updateProfileSchema,
  updateServerSchema,
  userPreferencesSchema,
  voiceSessionRequestSchema,
  type Gif,
} from "@pqp/shared";
import {
  createLiveKitSession,
  getServerVoiceBackend,
  isLiveKitConfigured,
} from "../voice/backends.js";
import {
  broadcastToChannel,
  evictChannelViewers,
  evictUserFromChannels,
  evictVoiceChannel,
  evictVoiceUser,
  evictVoiceUsersExcept,
} from "../ws/index.js";
import { getVoicePeer } from "../ws/voice.js";
import { invalidateUserCache, resolveAuthUser } from "../auth/clerk.js";
import type { MemberRole } from "../db.js";
import {
  clampLimit,
  handleCors,
  HttpError,
  isUuid,
  readJsonBody,
  sendError,
  sendJson,
} from "../lib/http.js";
import { clientAddress, createRateLimiter } from "../lib/rate-limit.js";
import { createRouter, type RequestContext } from "../lib/router.js";
import {
  createInvite,
  deleteInvite,
  getInviteByCode,
  listInvites,
  mapInvite,
  redeemInvite,
} from "../services/invites.js";
import {
  deleteMessage,
  getMessage,
  listMessages,
  mapMessage,
  UnknownCursorError,
  updateMessageBody,
} from "../services/messages.js";
import {
  banMember,
  kickMember,
  listBans,
  unbanMember,
} from "../services/moderation.js";
import {
  addChannelMember,
  createChannel,
  createServer,
  deleteChannel,
  deleteServer,
  getChannel,
  getChannelAudience,
  listChannelMembers,
  listChannels,
  listServerChannelIds,
  listServersForUser,
  mapChannel,
  mapServer,
  removeChannelMember,
  renameServer,
  transferOwnership,
  updateChannel,
} from "../services/servers.js";
import {
  GifBackendError,
  isGifSearchConfigured,
  searchGifs,
  trendingGifs,
} from "../services/gifs.js";
import { getIceServers } from "../services/ice.js";
import { decodeSearchCursor, searchMessages } from "../services/search.js";
import { mergePreferences } from "../services/preferences.js";
import {
  canManageServer,
  getMemberRole,
  getUserById,
  isChannelMember,
  isServerMember,
  leaveServer,
  listServerMembers,
  listUnread,
  markChannelRead,
  toPublicUser,
  updateMemberRole,
  updateProfile,
} from "../services/users.js";

/** Per-identity request budget. Generous for a UI, hostile to a script. */
/**
 * Tunable because the right ceiling depends on the deployment: a family
 * self-host and a public instance want very different numbers, and an automated
 * suite driving one account needs headroom a human never would.
 */
function limitFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const apiLimiter = createRateLimiter({
  capacity: limitFromEnv("RATE_LIMIT_API_CAPACITY", 120),
  refillPerSecond: limitFromEnv("RATE_LIMIT_API_REFILL", 10),
});
/** Writes are cheaper to abuse and more expensive to serve. */
const writeLimiter = createRateLimiter({
  capacity: limitFromEnv("RATE_LIMIT_WRITE_CAPACITY", 30),
  refillPerSecond: limitFromEnv("RATE_LIMIT_WRITE_REFILL", 2),
});
/**
 * Pre-auth backstop keyed by address. Behind a proxy without `TRUST_PROXY`,
 * every caller looks like the same address — so this bucket is deliberately
 * coarse. The per-user buckets above do the real work; this one only exists to
 * stop an unauthenticated flood from reaching Clerk token verification.
 */
const anonLimiter = createRateLimiter({ capacity: 240, refillPerSecond: 60 });
/**
 * GIF search is a per-keystroke read against someone else's quota, so it gets a
 * tighter budget than the general one: enough for a debounced session of
 * typing, not enough to burn the deployment's key.
 */
const gifLimiter = createRateLimiter({ capacity: 20, refillPerSecond: 1 });
/**
 * Search is also per-keystroke, but the expensive party is our own database
 * rather than a third party's quota: one query ranks every visible message in a
 * server. The burst covers a debounced session of typing plus paging through
 * the results; sustained it is roughly one search per second.
 */
const searchLimiter = createRateLimiter({ capacity: 30, refillPerSecond: 1 });

export function resetApiRateLimits(): void {
  apiLimiter.reset();
  writeLimiter.reset();
  anonLimiter.reset();
  gifLimiter.reset();
  searchLimiter.reset();
}

class Forbidden extends HttpError {
  constructor(message = "Forbidden") {
    super(403, message);
  }
}

/** Wrap a handler result to answer 201 instead of 200. */
class Created {
  constructor(readonly body: unknown) {}
}

function created(body: unknown): Created {
  return new Created(body);
}

class NotFound extends HttpError {
  constructor(message = "Not found") {
    super(404, message);
  }
}

async function requireServerMember(serverId: string, userId: string) {
  const role = await getMemberRole(serverId, userId);
  if (!role) {
    // 404 rather than 403: a non-member should not be able to probe which
    // server ids exist.
    throw new NotFound("Server not found");
  }
  return role;
}

async function requireManager(serverId: string, userId: string) {
  const role = await requireServerMember(serverId, userId);
  if (role !== "owner" && role !== "admin") {
    throw new Forbidden("Only owners and admins can do that");
  }
  return role;
}

async function requireOwner(serverId: string, userId: string) {
  const role = await requireServerMember(serverId, userId);
  if (role !== "owner") {
    throw new Forbidden("Only the owner can do that");
  }
  return role;
}

/**
 * Owners may act on anyone beneath them; admins only on plain members, so an
 * admin can neither depose a peer nor the owner. Returns the target's role, or
 * null when they are not a member at all.
 */
async function requireOutranked(
  serverId: string,
  actorRole: MemberRole,
  targetUserId: string,
  action: "kick" | "ban",
): Promise<MemberRole | null> {
  const targetRole = await getMemberRole(serverId, targetUserId);
  if (targetRole === "owner") {
    throw new Forbidden(`Cannot ${action} the owner`);
  }
  if (targetRole === "admin" && actorRole !== "owner") {
    throw new Forbidden(`Only the owner can ${action} an admin`);
  }
  return targetRole;
}

async function requireChannel(channelId: string) {
  const channel = await getChannel(channelId);
  if (!channel) {
    throw new NotFound("Channel not found");
  }
  return channel;
}

async function requireChannelAccess(channelId: string, userId: string) {
  const channel = await requireChannel(channelId);
  if (!(await isChannelMember(channelId, userId))) {
    throw new NotFound("Channel not found");
  }
  return channel;
}

const router = createRouter();

// ---------------------------------------------------------------- profile

router.get("/api/me", async ({ user }) => toPublicUser(user));

router.patch("/api/me", async ({ req, user }) => {
  const body = updateProfileSchema.parse(await readJsonBody(req));
  const updated = await updateProfile(user.id, {
    displayName: body.displayName,
    username: body.username,
    avatarUrl: body.avatarUrl,
  });
  invalidateUserCache(updated.clerk_id);
  return toPublicUser(updated);
});

/**
 * Patch semantics: the body carries only what changed, and the response is the
 * whole merged object so the caller never has to guess what the server kept.
 * Keys the schema does not know — audio device ids above all — are dropped
 * before anything is stored.
 */
router.patch("/api/me/preferences", async ({ req, user }) => {
  const patch = userPreferencesSchema.parse(await readJsonBody(req));
  return { preferences: await mergePreferences(user.id, patch) };
});

// ------------------------------------------------------------------ voice

router.get("/api/ice-servers", async () => ({
  iceServers: await getIceServers(),
}));

router.get("/api/voice/backend", async () => {
  const backend = getServerVoiceBackend();
  return {
    backend: backend === "livekit" && !isLiveKitConfigured() ? "mesh" : backend,
  };
});

router.post("/api/voice/token", async ({ req, user }) => {
  if (!isLiveKitConfigured()) {
    throw new HttpError(503, "SFU backend not configured");
  }
  const body = voiceSessionRequestSchema.parse(await readJsonBody(req));

  // The peer id must be a live peer owned by this user, in this channel —
  // otherwise a caller could mint a token impersonating someone else.
  const peer = getVoicePeer(body.peerId);
  if (
    !peer ||
    peer.userId !== user.id ||
    peer.voiceChannelId !== body.voiceChannelId
  ) {
    throw new Forbidden("Unknown or mismatched voice peer");
  }

  await requireChannelAccess(body.voiceChannelId, user.id);

  try {
    return await createLiveKitSession(
      body.voiceChannelId,
      body.peerId,
      peer.displayName,
    );
  } catch (error) {
    console.error("[voice] token minting failed:", error);
    throw new HttpError(502, "Voice backend unavailable");
  }
});

// ------------------------------------------------------------------- gifs

/**
 * The button in the composer is hidden entirely on a deployment without a key,
 * so this exists to say so once at bootstrap rather than letting the user open
 * a panel that can only ever show an error.
 */
router.get("/api/gifs/config", async () => ({
  enabled: isGifSearchConfigured(),
}));

function requireGifSearch(ctx: RequestContext): void {
  if (!isGifSearchConfigured()) {
    throw new HttpError(503, "GIF search is not configured on this server");
  }
  const key = `user:${ctx.user.id}`;
  if (!gifLimiter.take(key)) {
    ctx.res.setHeader("Retry-After", String(gifLimiter.retryAfter(key)));
    throw new HttpError(429, "Slow down");
  }
}

async function respondWithGifs(load: () => Promise<Gif[]>) {
  try {
    return { gifs: await load() };
  } catch (error) {
    if (error instanceof GifBackendError) {
      console.error("[gifs] upstream failed:", error.message);
      throw new HttpError(502, "GIF provider unavailable");
    }
    throw error;
  }
}

router.get("/api/gifs/search", async (ctx) => {
  requireGifSearch(ctx);
  const query = (ctx.url.searchParams.get("q") ?? "").trim();
  if (!query) {
    throw new HttpError(400, "Missing search query");
  }
  if (query.length > GIF_QUERY_MAX_LENGTH) {
    throw new HttpError(400, "Search query too long");
  }
  const limit = clampLimit(
    ctx.url.searchParams.get("limit"),
    GIF_PAGE_SIZE,
    GIF_PAGE_MAX,
  );
  return respondWithGifs(() => searchGifs(query, limit));
});

router.get("/api/gifs/trending", async (ctx) => {
  requireGifSearch(ctx);
  const limit = clampLimit(
    ctx.url.searchParams.get("limit"),
    GIF_PAGE_SIZE,
    GIF_PAGE_MAX,
  );
  return respondWithGifs(() => trendingGifs(limit));
});

// ---------------------------------------------------------------- servers

router.get("/api/servers", async ({ user }) => ({
  servers: (await listServersForUser(user.id)).map(mapServer),
}));

router.post("/api/servers", async ({ req, user }) => {
  const body = createServerSchema.parse(await readJsonBody(req));
  const { server, channels } = await createServer(body.name, user.id);
  return created({
    server: { ...mapServer(server), role: "owner" as const },
    channels: channels.map(mapChannel),
  });
});

router.patch("/api/servers/:serverId", async ({ req, user }, { serverId }) => {
  await requireOwner(serverId!, user.id);
  const body = updateServerSchema.parse(await readJsonBody(req));

  if (body.ownerId && body.ownerId !== user.id) {
    try {
      await transferOwnership(serverId!, user.id, body.ownerId);
    } catch (error) {
      throw new HttpError(
        400,
        error instanceof Error ? error.message : "Cannot transfer ownership",
      );
    }
  }
  const server = body.name ? await renameServer(serverId!, body.name) : null;

  return { ok: true, ...(server ? { server: mapServer(server) } : {}) };
});

router.delete("/api/servers/:serverId", async ({ user }, { serverId }) => {
  await requireOwner(serverId!, user.id);
  const channelIds = await listServerChannelIds(serverId!);
  await deleteServer(serverId!);
  for (const channelId of channelIds) {
    evictVoiceChannel(channelId);
    evictChannelViewers(channelId);
  }
  return { ok: true };
});

router.post("/api/servers/:serverId/leave", async ({ user }, { serverId }) => {
  try {
    await leaveServer(serverId!, user.id);
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : "Cannot leave server",
    );
  }
  const channelIds = await listServerChannelIds(serverId!);
  evictUserFromChannels(user.id, channelIds);
  evictVoiceUser(user.id, channelIds);
  return { ok: true };
});

router.get("/api/servers/:serverId/unread", async ({ user }, { serverId }) => {
  await requireServerMember(serverId!, user.id);
  return { unread: await listUnread(serverId!, user.id) };
});

// --------------------------------------------------------------- channels

router.get(
  "/api/servers/:serverId/channels",
  async ({ user }, { serverId }) => {
    await requireServerMember(serverId!, user.id);
    return { channels: (await listChannels(serverId!, user.id)).map(mapChannel) };
  },
);

router.post(
  "/api/servers/:serverId/channels",
  async ({ req, user }, { serverId }) => {
    await requireManager(serverId!, user.id);
    const body = createChannelSchema.parse(await readJsonBody(req));
    const channel = await createChannel(
      serverId!,
      body.name,
      body.type,
      body.isPrivate ?? false,
    );
    if (channel.is_private) {
      await addChannelMember(channel.id, user.id);
    }
    return created({ channel: mapChannel(channel) });
  },
);

router.patch("/api/channels/:channelId", async ({ req, user }, { channelId }) => {
  const channel = await requireChannel(channelId!);
  await requireManager(channel.server_id, user.id);
  const body = updateChannelSchema.parse(await readJsonBody(req));
  const updated = await updateChannel(channelId!, {
    name: body.name,
    isPrivate: body.isPrivate,
    topic: body.topic,
    imageUrl: body.imageUrl,
  });
  if (!updated) {
    throw new NotFound("Channel not found");
  }

  // Turning a channel private must immediately cut off anyone watching or
  // talking in it who is not on the access list. The audience query is the same
  // predicate isChannelMember uses, so owners and admins — who keep access
  // without a channel_members row — are not evicted along with everyone else.
  if (updated.is_private && !channel.is_private) {
    const audience = await getChannelAudience(channelId!);
    const allowed = new Set(audience?.userIds ?? []);
    evictChannelViewers(channelId!, (userId) => !allowed.has(userId));
    evictVoiceUsersExcept(channelId!, allowed);
  }

  return { channel: mapChannel(updated) };
});

router.delete("/api/channels/:channelId", async ({ user }, { channelId }) => {
  const channel = await requireChannel(channelId!);
  await requireManager(channel.server_id, user.id);
  await deleteChannel(channelId!);
  evictVoiceChannel(channelId!);
  evictChannelViewers(channelId!);
  return { ok: true };
});

router.get(
  "/api/channels/:channelId/members",
  async ({ user }, { channelId }) => {
    const channel = await requireChannel(channelId!);
    await requireManager(channel.server_id, user.id);
    return { members: await listChannelMembers(channelId!) };
  },
);

router.post(
  "/api/channels/:channelId/members",
  async ({ req, user }, { channelId }) => {
    const channel = await requireChannel(channelId!);
    await requireManager(channel.server_id, user.id);
    const body = addChannelMemberSchema.parse(await readJsonBody(req));
    if (!(await isServerMember(channel.server_id, body.userId))) {
      throw new HttpError(400, "User must be a server member");
    }
    await addChannelMember(channelId!, body.userId);
    return created({ ok: true });
  },
);

router.delete(
  "/api/channels/:channelId/members/:userId",
  async ({ user }, { channelId, userId }) => {
    const channel = await requireChannel(channelId!);
    await requireManager(channel.server_id, user.id);
    await removeChannelMember(channelId!, userId!);
    if (channel.is_private) {
      evictChannelViewers(channelId!, (viewerId) => viewerId === userId);
      evictVoiceUser(userId!, new Set([channelId!]));
    }
    return { ok: true };
  },
);

router.post("/api/channels/:channelId/read", async ({ user }, { channelId }) => {
  await requireChannelAccess(channelId!, user.id);
  await markChannelRead(channelId!, user.id);
  return { ok: true };
});

// --------------------------------------------------------------- messages

router.get(
  "/api/channels/:channelId/messages",
  async ({ url, user }, { channelId }) => {
    await requireChannelAccess(channelId!, user.id);

    const limit = clampLimit(
      url.searchParams.get("limit"),
      MESSAGE_PAGE_SIZE,
      MESSAGE_PAGE_MAX,
    );
    const before = url.searchParams.get("before") ?? undefined;
    const after = url.searchParams.get("after") ?? undefined;
    const around = url.searchParams.get("around") ?? undefined;
    const cursors = [before, after, around].filter(
      (cursor) => cursor !== undefined,
    );
    if (cursors.some((cursor) => !isUuid(cursor))) {
      throw new HttpError(400, "Invalid cursor");
    }
    // Combining them has no single answer for which end the page hangs off, and
    // silently picking one would page past history the caller thinks it read.
    if (cursors.length > 1) {
      throw new HttpError(400, "Use one cursor at a time");
    }

    try {
      const page = await listMessages(channelId!, {
        limit,
        before,
        after,
        around,
        viewerId: user.id,
      });
      return {
        messages: page.messages.map(mapMessage),
        hasMore: page.hasMore,
        hasNewer: page.hasNewer,
      };
    } catch (error) {
      if (error instanceof UnknownCursorError) {
        throw new HttpError(400, "Unknown cursor");
      }
      throw error;
    }
  },
);

router.patch("/api/messages/:messageId", async ({ req, user }, { messageId }) => {
  const existing = await getMessage(messageId!);
  if (!existing) {
    throw new NotFound("Message not found");
  }
  await requireChannelAccess(existing.channel_id, user.id);
  if (existing.author_id !== user.id) {
    throw new Forbidden("You can only edit your own messages");
  }

  const body = updateMessageSchema.parse(await readJsonBody(req));
  const updated = await updateMessageBody(messageId!, body.body);
  if (!updated) {
    throw new NotFound("Message not found");
  }

  const message = mapMessage(updated);
  broadcastToChannel(existing.channel_id, { type: "message-update", message });
  return { message };
});

router.delete("/api/messages/:messageId", async ({ user }, { messageId }) => {
  const existing = await getMessage(messageId!);
  if (!existing) {
    throw new NotFound("Message not found");
  }
  await requireChannelAccess(existing.channel_id, user.id);

  // Authors delete their own; moderators delete anyone's.
  if (
    existing.author_id !== user.id &&
    !(await canManageServer(existing.server_id, user.id))
  ) {
    throw new Forbidden("You cannot delete this message");
  }

  await deleteMessage(messageId!);
  broadcastToChannel(existing.channel_id, {
    type: "message-delete",
    channelId: existing.channel_id,
    messageId: messageId!,
  });
  return { ok: true };
});

// ----------------------------------------------------------------- search

router.get("/api/servers/:serverId/search", async (ctx, { serverId }) => {
  const { url, user, res } = ctx;
  await requireServerMember(serverId!, user.id);

  const key = `user:${user.id}`;
  if (!searchLimiter.take(key)) {
    res.setHeader("Retry-After", String(searchLimiter.retryAfter(key)));
    throw new HttpError(429, "Slow down");
  }

  const query = messageSearchQuerySchema.safeParse(
    (url.searchParams.get("q") ?? "").trim(),
  );
  if (!query.success) {
    throw new HttpError(400, "Invalid search query");
  }

  const limit = clampLimit(
    url.searchParams.get("limit"),
    SEARCH_PAGE_SIZE,
    SEARCH_PAGE_MAX,
  );

  const rawCursor = url.searchParams.get("before");
  const cursor = rawCursor ? decodeSearchCursor(rawCursor) : null;
  if (rawCursor && !cursor) {
    throw new HttpError(400, "Invalid cursor");
  }

  return await searchMessages(
    serverId!,
    user.id,
    query.data,
    limit,
    cursor ?? undefined,
  );
});

// ---------------------------------------------------------------- members

router.get("/api/servers/:serverId/members", async ({ user }, { serverId }) => {
  await requireServerMember(serverId!, user.id);
  return { members: await listServerMembers(serverId!) };
});

router.patch(
  "/api/servers/:serverId/members/:userId",
  async ({ req, user }, { serverId, userId }) => {
    await requireOwner(serverId!, user.id);
    const body = updateMemberRoleSchema.parse(await readJsonBody(req));
    await updateMemberRole(serverId!, userId!, body.role);
    return { ok: true };
  },
);

router.delete(
  "/api/servers/:serverId/members/:userId",
  async ({ req, user }, { serverId, userId }) => {
    const actorRole = await requireManager(serverId!, user.id);
    const body = removeMemberSchema.parse(await readJsonBody(req));
    if (userId === user.id) {
      throw new HttpError(400, "Use leave to remove yourself");
    }
    const targetRole = await requireOutranked(
      serverId!,
      actorRole,
      userId!,
      "kick",
    );
    if (!targetRole) {
      throw new NotFound("Member not found");
    }

    if (body.ban) {
      await banMember(serverId!, userId!, user.id, null);
    } else {
      await kickMember(serverId!, userId!);
    }

    const channelIds = await listServerChannelIds(serverId!);
    evictUserFromChannels(userId!, channelIds);
    evictVoiceUser(userId!, channelIds);
    return { ok: true };
  },
);

router.get("/api/servers/:serverId/bans", async ({ user }, { serverId }) => {
  await requireManager(serverId!, user.id);
  return { bans: await listBans(serverId!) };
});

router.post(
  "/api/servers/:serverId/bans",
  async ({ req, user }, { serverId }) => {
    const actorRole = await requireManager(serverId!, user.id);
    const body = banMemberSchema.parse(await readJsonBody(req));
    if (body.userId === user.id) {
      throw new HttpError(400, "You cannot ban yourself");
    }
    // server_bans carries an FK to users, so the account has to exist — but it
    // need not be a member: a pre-emptive ban is a valid thing to want.
    if (!(await getUserById(body.userId))) {
      throw new NotFound("User not found");
    }
    await requireOutranked(serverId!, actorRole, body.userId, "ban");

    await banMember(serverId!, body.userId, user.id, body.reason);

    const channelIds = await listServerChannelIds(serverId!);
    evictUserFromChannels(body.userId, channelIds);
    evictVoiceUser(body.userId, channelIds);
    return { ok: true };
  },
);

router.delete(
  "/api/servers/:serverId/bans/:userId",
  async ({ user }, { serverId, userId }) => {
    await requireManager(serverId!, user.id);
    await unbanMember(serverId!, userId!);
    return { ok: true };
  },
);

// ---------------------------------------------------------------- invites

router.get("/api/servers/:serverId/invites", async ({ user }, { serverId }) => {
  await requireManager(serverId!, user.id);
  return { invites: (await listInvites(serverId!)).map(mapInvite) };
});

router.post(
  "/api/servers/:serverId/invites",
  async ({ req, user }, { serverId }) => {
    await requireManager(serverId!, user.id);
    const body = createInviteSchema.parse(await readJsonBody(req));
    const invite = await createInvite(serverId!, user.id, {
      maxUses: body.maxUses,
      expiresInHours: body.expiresInHours,
    });
    return created({ invite: mapInvite(invite) });
  },
);

router.delete(
  "/api/servers/:serverId/invites/:inviteId",
  async ({ user }, { serverId, inviteId }) => {
    await requireManager(serverId!, user.id);
    await deleteInvite(serverId!, inviteId!);
    return { ok: true };
  },
);

router.post("/api/invites/:code/join", async ({ user }, { code }) => {
  try {
    return await redeemInvite(code!, user.id);
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : "Invalid invite",
    );
  }
});

router.get("/api/invites/:code", async ({ user }, { code }) => {
  const invite = await getInviteByCode(code!);
  if (!invite) {
    throw new NotFound("Invite not found");
  }
  // Preview is intentionally readable by any signed-in user — that is the point
  // of an invite link — but it must not leak who else is in the server.
  void user;
  return { invite: mapInvite(invite) };
});

// ---------------------------------------------------------------- dispatch

const WRITE_METHODS = new Set(["POST", "PATCH", "DELETE"]);

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  if (handleCors(req, res)) {
    return;
  }

  const address = clientAddress(req as never);
  if (!anonLimiter.take(`ip:${address}`)) {
    res.setHeader("Retry-After", String(anonLimiter.retryAfter(`ip:${address}`)));
    sendError(res, 429, "Too many requests", req);
    return;
  }

  let resolved: Awaited<ReturnType<typeof resolveAuthUser>> = null;
  try {
    resolved = await resolveAuthUser(req.headers.authorization);
  } catch (error) {
    console.error("[auth] resolve failed:", error);
    sendError(res, 503, "Authentication temporarily unavailable", req);
    return;
  }

  if (!resolved) {
    sendError(res, 401, "Unauthorized", req);
    return;
  }

  const user = resolved.user;
  const method = req.method ?? "GET";

  if (!apiLimiter.take(`user:${user.id}`)) {
    res.setHeader("Retry-After", String(apiLimiter.retryAfter(`user:${user.id}`)));
    sendError(res, 429, "Too many requests", req);
    return;
  }
  if (WRITE_METHODS.has(method) && !writeLimiter.take(`user:${user.id}`)) {
    res.setHeader(
      "Retry-After",
      String(writeLimiter.retryAfter(`user:${user.id}`)),
    );
    sendError(res, 429, "Slow down", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const matched = router.match(method, pathname);
    if (!matched) {
      sendError(res, 404, "Not found", req);
      return;
    }

    const ctx: RequestContext = { req, res, url, user };
    const result = await matched.handler(ctx, matched.params);
    if (result instanceof Created) {
      sendJson(res, 201, result.body, req);
      return;
    }
    sendJson(res, 200, result, req);
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.status, error.message, req);
      return;
    }
    if (error && typeof error === "object" && "name" in error && error.name === "ZodError") {
      sendError(res, 400, "Invalid request", req);
      return;
    }
    console.error(error);
    sendError(res, 500, "Internal server error", req);
  }
}

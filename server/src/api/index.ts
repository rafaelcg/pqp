import type { IncomingMessage, ServerResponse } from "node:http";
import {
  addChannelMemberSchema,
  banMemberSchema,
  createChannelSchema,
  createInviteSchema,
  createServerSchema,
  updateChannelSchema,
  updateMemberRoleSchema,
  updateProfileSchema,
} from "@pqp/shared";
import { resolveAuthUser } from "../auth/clerk.js";
import { handleCors, HttpError, readJsonBody, sendError, sendJson } from "../lib/http.js";
import { rateLimit } from "../lib/rate-limit.js";
import { createInvite, getInviteByCode, listInvites, mapInvite, redeemInvite } from "../services/invites.js";
import {
  deleteMessage,
  getMessageForModeration,
  createMessage,
  listMessages,
  mapMessage,
} from "../services/messages.js";
import {
  banMember,
  kickMember,
  listBans,
  unbanMember,
} from "../services/moderation.js";
import { broadcastMessageDeleted } from "../ws/chat.js";
import {
  addChannelMember,
  createChannel,
  createServer,
  deleteChannel,
  getChannel,
  listChannelMembers,
  listChannels,
  listServersForUser,
  mapChannel,
  mapServer,
  removeChannelMember,
  updateChannel,
} from "../services/servers.js";
import { getIceServers } from "../services/ice.js";
import {
  canManageServer,
  getMemberRole,
  getUserById,
  isChannelMember,
  isServerMember,
  leaveServer,
  listServerMembers,
  toPublicUser,
  updateMemberRole,
  updateProfile,
} from "../services/users.js";

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  const json = (status: number, data: unknown) =>
    sendJson(res, status, data, req);
  const fail = (status: number, message: string) =>
    sendError(res, status, message, req);

  if (handleCors(req, res)) {
    return;
  }

  const resolved = await resolveAuthUser(req.headers.authorization);
  if (!resolved) {
    fail(401, "Unauthorized");
    return;
  }

  const user = resolved.user;

  // Broad per-user throttle across all API traffic; write-heavy routes get a
  // tighter bucket below. Keeps a single account from flooding the DB.
  const globalLimit = rateLimit(`api:${user.id}`, 300, 60_000);
  if (!globalLimit.allowed) {
    fail(429, "Too many requests — slow down");
    return;
  }

  const isWrite = req.method !== "GET" && req.method !== "OPTIONS";
  if (isWrite) {
    const writeLimit = rateLimit(`api-write:${user.id}`, 60, 60_000);
    if (!writeLimit.allowed) {
      fail(429, "Too many requests — slow down");
      return;
    }
  }

  try {
    if (req.method === "GET" && pathname === "/api/me") {
      json(200, toPublicUser(user));
      return;
    }

    if (req.method === "PATCH" && pathname === "/api/me") {
      const body = updateProfileSchema.parse(await readJsonBody(req));
      const updated = await updateProfile(user.id, {
        displayName: body.displayName,
        username: body.username,
        avatarUrl: body.avatarUrl,
      });
      json(200, toPublicUser(updated));
      return;
    }

    if (req.method === "GET" && pathname === "/api/ice-servers") {
      json(200, { iceServers: await getIceServers() });
      return;
    }

    if (req.method === "GET" && pathname === "/api/servers") {
      const servers = await listServersForUser(user.id);
      json(200, { servers: servers.map(mapServer) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/servers") {
      const body = createServerSchema.parse(await readJsonBody(req));
      const { server, channels } = await createServer(body.name, user.id);
      json(201, {
        server: { ...mapServer(server), role: "owner" as const },
        channels: channels.map(mapChannel),
      });
      return;
    }

    const inviteJoinMatch = pathname.match(/^\/api\/invites\/([^/]+)\/join$/);
    if (inviteJoinMatch && req.method === "POST") {
      const code = inviteJoinMatch[1]!;
      try {
        const joined = await redeemInvite(code, user.id);
        json(200, joined);
      } catch (error) {
        sendError(
          res,
          400,
          error instanceof Error ? error.message : "Invalid invite",
        );
      }
      return;
    }

    const invitePreviewMatch = pathname.match(/^\/api\/invites\/([^/]+)$/);
    if (invitePreviewMatch && req.method === "GET") {
      const invite = await getInviteByCode(invitePreviewMatch[1]!);
      if (!invite) {
        fail(404, "Invite not found");
        return;
      }
      json(200, { invite: mapInvite(invite) });
      return;
    }

    const serverChannelsMatch = pathname.match(
      /^\/api\/servers\/([^/]+)\/channels$/,
    );
    if (serverChannelsMatch) {
      const serverId = serverChannelsMatch[1]!;
      if (!(await isServerMember(serverId, user.id))) {
        fail(403, "Forbidden");
        return;
      }

      if (req.method === "GET") {
        const channels = await listChannels(serverId, user.id);
        json(200, { channels: channels.map(mapChannel) });
        return;
      }

      if (req.method === "POST") {
        if (!(await canManageServer(serverId, user.id))) {
          fail(403, "Only owners and admins can create channels");
          return;
        }
        const body = createChannelSchema.parse(await readJsonBody(req));
        const channel = await createChannel(
          serverId,
          body.name,
          body.type,
          body.isPrivate ?? false,
        );
        if (channel.is_private) {
          await addChannelMember(channel.id, user.id);
        }
        json(201, { channel: mapChannel(channel) });
        return;
      }
    }

    const serverInvitesMatch = pathname.match(
      /^\/api\/servers\/([^/]+)\/invites$/,
    );
    if (serverInvitesMatch) {
      const serverId = serverInvitesMatch[1]!;
      if (!(await canManageServer(serverId, user.id))) {
        fail(403, "Forbidden");
        return;
      }

      if (req.method === "GET") {
        const invites = await listInvites(serverId);
        json(200, { invites: invites.map(mapInvite) });
        return;
      }

      if (req.method === "POST") {
        const body = createInviteSchema.parse(await readJsonBody(req));
        const invite = await createInvite(serverId, user.id, {
          maxUses: body.maxUses,
          expiresInHours: body.expiresInHours,
        });
        json(201, { invite: mapInvite(invite) });
        return;
      }
    }

    const serverMembersMatch = pathname.match(
      /^\/api\/servers\/([^/]+)\/members$/,
    );
    if (serverMembersMatch && req.method === "GET") {
      const serverId = serverMembersMatch[1]!;
      if (!(await isServerMember(serverId, user.id))) {
        fail(403, "Forbidden");
        return;
      }
      json(200, { members: await listServerMembers(serverId) });
      return;
    }

    const serverLeaveMatch = pathname.match(/^\/api\/servers\/([^/]+)\/leave$/);
    if (serverLeaveMatch && req.method === "POST") {
      const serverId = serverLeaveMatch[1]!;
      try {
        await leaveServer(serverId, user.id);
        json(200, { ok: true });
      } catch (error) {
        sendError(
          res,
          400,
          error instanceof Error ? error.message : "Cannot leave server",
        );
      }
      return;
    }

    const memberRoleMatch = pathname.match(
      /^\/api\/servers\/([^/]+)\/members\/([^/]+)$/,
    );
    if (memberRoleMatch && req.method === "PATCH") {
      const serverId = memberRoleMatch[1]!;
      const targetUserId = memberRoleMatch[2]!;
      const myRole = await getMemberRole(serverId, user.id);
      if (myRole !== "owner") {
        fail(403, "Only the owner can change roles");
        return;
      }
      const body = updateMemberRoleSchema.parse(await readJsonBody(req));
      await updateMemberRole(serverId, targetUserId, body.role);
      json(200, { ok: true });
      return;
    }

    // Kick a member (owner/admin). Owners can't be kicked; only an owner may
    // kick an admin; nobody kicks themselves here (use /leave).
    if (memberRoleMatch && req.method === "DELETE") {
      const serverId = memberRoleMatch[1]!;
      const targetUserId = memberRoleMatch[2]!;
      const actorRole = await getMemberRole(serverId, user.id);
      const targetRole = await getMemberRole(serverId, targetUserId);
      if (actorRole !== "owner" && actorRole !== "admin") {
        fail(403, "Forbidden");
        return;
      }
      if (targetUserId === user.id) {
        fail(400, "Use leave to remove yourself");
        return;
      }
      if (!targetRole) {
        fail(404, "Member not found");
        return;
      }
      if (targetRole === "owner") {
        fail(403, "Cannot kick the owner");
        return;
      }
      if (targetRole === "admin" && actorRole !== "owner") {
        fail(403, "Only the owner can kick an admin");
        return;
      }
      await kickMember(serverId, targetUserId);
      json(200, { ok: true });
      return;
    }

    const serverBansMatch = pathname.match(/^\/api\/servers\/([^/]+)\/bans$/);
    if (serverBansMatch) {
      const serverId = serverBansMatch[1]!;
      if (!(await canManageServer(serverId, user.id))) {
        fail(403, "Forbidden");
        return;
      }
      if (req.method === "GET") {
        json(200, { bans: await listBans(serverId) });
        return;
      }
      if (req.method === "POST") {
        const body = banMemberSchema.parse(await readJsonBody(req));
        if (body.userId === user.id) {
          fail(400, "You cannot ban yourself");
          return;
        }
        // The user must exist (server_bans has an FK to users), but need NOT be
        // a current member — pre-emptive bans are supported.
        const target = await getUserById(body.userId);
        if (!target) {
          fail(404, "User not found");
          return;
        }
        const actorRole = await getMemberRole(serverId, user.id);
        const targetRole = await getMemberRole(serverId, body.userId);
        if (targetRole === "owner") {
          fail(403, "Cannot ban the owner");
          return;
        }
        if (targetRole === "admin" && actorRole !== "owner") {
          fail(403, "Only the owner can ban an admin");
          return;
        }
        // targetRole may be null here (non-member) — that is a valid ban.
        await banMember(serverId, body.userId, user.id, body.reason);
        json(200, { ok: true });
        return;
      }
    }

    const serverBanMatch = pathname.match(
      /^\/api\/servers\/([^/]+)\/bans\/([^/]+)$/,
    );
    if (serverBanMatch && req.method === "DELETE") {
      const serverId = serverBanMatch[1]!;
      const targetUserId = serverBanMatch[2]!;
      if (!(await canManageServer(serverId, user.id))) {
        fail(403, "Forbidden");
        return;
      }
      await unbanMember(serverId, targetUserId);
      json(200, { ok: true });
      return;
    }

    // Delete a message: the author, or an owner/admin of the server.
    const messageMatch = pathname.match(/^\/api\/messages\/([^/]+)$/);
    if (messageMatch && req.method === "DELETE") {
      const messageId = messageMatch[1]!;
      const message = await getMessageForModeration(messageId);
      if (!message) {
        fail(404, "Message not found");
        return;
      }
      const isAuthor = message.authorId === user.id;
      if (!isAuthor && !(await canManageServer(message.serverId, user.id))) {
        fail(403, "Forbidden");
        return;
      }
      await deleteMessage(messageId);
      broadcastMessageDeleted(message.channelId, messageId);
      json(200, { ok: true });
      return;
    }

    const channelMatch = pathname.match(/^\/api\/channels\/([^/]+)$/);
    if (channelMatch) {
      const channelId = channelMatch[1]!;
      const channel = await getChannel(channelId);
      if (!channel) {
        fail(404, "Channel not found");
        return;
      }

      if (req.method === "PATCH") {
        if (!(await canManageServer(channel.server_id, user.id))) {
          fail(403, "Forbidden");
          return;
        }
        const body = updateChannelSchema.parse(await readJsonBody(req));
        const updated = await updateChannel(channelId, {
          name: body.name,
          isPrivate: body.isPrivate,
          topic: body.topic,
          imageUrl: body.imageUrl,
        });
        json(200, { channel: mapChannel(updated!) });
        return;
      }

      if (req.method === "DELETE") {
        if (!(await canManageServer(channel.server_id, user.id))) {
          fail(403, "Forbidden");
          return;
        }
        await deleteChannel(channelId);
        json(200, { ok: true });
        return;
      }
    }

    const channelMembersMatch = pathname.match(
      /^\/api\/channels\/([^/]+)\/members$/,
    );
    if (channelMembersMatch) {
      const channelId = channelMembersMatch[1]!;
      const channel = await getChannel(channelId);
      if (!channel) {
        fail(404, "Channel not found");
        return;
      }
      if (!(await canManageServer(channel.server_id, user.id))) {
        fail(403, "Forbidden");
        return;
      }

      if (req.method === "GET") {
        json(200, {
          members: await listChannelMembers(channelId),
        });
        return;
      }

      if (req.method === "POST") {
        const body = addChannelMemberSchema.parse(await readJsonBody(req));
        if (!(await isServerMember(channel.server_id, body.userId))) {
          fail(400, "User must be a server member");
          return;
        }
        await addChannelMember(channelId, body.userId);
        json(201, { ok: true });
        return;
      }
    }

    const channelMemberMatch = pathname.match(
      /^\/api\/channels\/([^/]+)\/members\/([^/]+)$/,
    );
    if (channelMemberMatch && req.method === "DELETE") {
      const channelId = channelMemberMatch[1]!;
      const targetUserId = channelMemberMatch[2]!;
      const channel = await getChannel(channelId);
      if (!channel) {
        fail(404, "Channel not found");
        return;
      }
      if (!(await canManageServer(channel.server_id, user.id))) {
        fail(403, "Forbidden");
        return;
      }
      await removeChannelMember(channelId, targetUserId);
      json(200, { ok: true });
      return;
    }

    const messagesMatch = pathname.match(/^\/api\/channels\/([^/]+)\/messages$/);
    if (messagesMatch && req.method === "GET") {
      const channelId = messagesMatch[1]!;
      if (!(await isChannelMember(channelId, user.id))) {
        fail(403, "Forbidden");
        return;
      }

      const url = new URL(req.url ?? "/", "http://localhost");
      const rawLimit = Number(url.searchParams.get("limit") ?? 50);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(100, Math.max(1, Math.floor(rawLimit)))
        : 50;
      const before = url.searchParams.get("before") ?? undefined;
      const messages = await listMessages(channelId, limit, before, user.id);
      json(200, { messages: messages.map(mapMessage) });
      return;
    }

    fail(404, "Not found");
  } catch (error) {
    if (error instanceof HttpError) {
      fail(error.status, error.message);
      return;
    }
    if (error && typeof error === "object" && "name" in error && error.name === "ZodError") {
      fail(400, "Invalid request");
      return;
    }
    console.error(error);
    fail(500, "Internal server error");
  }
}

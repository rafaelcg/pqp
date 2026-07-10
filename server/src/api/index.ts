import type { IncomingMessage, ServerResponse } from "node:http";
import {
  addChannelMemberSchema,
  createChannelSchema,
  createInviteSchema,
  createServerSchema,
  updateChannelSchema,
  updateMemberRoleSchema,
  updateProfileSchema,
} from "@pqp/shared";
import { resolveAuthUser } from "../auth/clerk.js";
import { handleCors, readJsonBody, sendError, sendJson } from "../lib/http.js";
import { createInvite, getInviteByCode, listInvites, mapInvite, redeemInvite } from "../services/invites.js";
import { createMessage, listMessages, mapMessage } from "../services/messages.js";
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
import {
  canManageServer,
  getMemberRole,
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
  if (handleCors(req, res)) {
    return;
  }

  const resolved = await resolveAuthUser(req.headers.authorization);
  if (!resolved) {
    sendError(res, 401, "Unauthorized");
    return;
  }

  const user = resolved.user;

  try {
    if (req.method === "GET" && pathname === "/api/me") {
      sendJson(res, 200, toPublicUser(user));
      return;
    }

    if (req.method === "PATCH" && pathname === "/api/me") {
      const body = updateProfileSchema.parse(await readJsonBody(req));
      const updated = await updateProfile(user.id, {
        displayName: body.displayName,
        username: body.username,
      });
      sendJson(res, 200, toPublicUser(updated));
      return;
    }

    if (req.method === "GET" && pathname === "/api/servers") {
      const servers = await listServersForUser(user.id);
      sendJson(res, 200, { servers: servers.map(mapServer) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/servers") {
      const body = createServerSchema.parse(await readJsonBody(req));
      const { server, channels } = await createServer(body.name, user.id);
      sendJson(res, 201, {
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
        sendJson(res, 200, joined);
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
        sendError(res, 404, "Invite not found");
        return;
      }
      sendJson(res, 200, { invite: mapInvite(invite) });
      return;
    }

    const serverChannelsMatch = pathname.match(
      /^\/api\/servers\/([^/]+)\/channels$/,
    );
    if (serverChannelsMatch) {
      const serverId = serverChannelsMatch[1]!;
      if (!(await isServerMember(serverId, user.id))) {
        sendError(res, 403, "Forbidden");
        return;
      }

      if (req.method === "GET") {
        const channels = await listChannels(serverId, user.id);
        sendJson(res, 200, { channels: channels.map(mapChannel) });
        return;
      }

      if (req.method === "POST") {
        if (!(await canManageServer(serverId, user.id))) {
          sendError(res, 403, "Only owners and admins can create channels");
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
        sendJson(res, 201, { channel: mapChannel(channel) });
        return;
      }
    }

    const serverInvitesMatch = pathname.match(
      /^\/api\/servers\/([^/]+)\/invites$/,
    );
    if (serverInvitesMatch) {
      const serverId = serverInvitesMatch[1]!;
      if (!(await canManageServer(serverId, user.id))) {
        sendError(res, 403, "Forbidden");
        return;
      }

      if (req.method === "GET") {
        const invites = await listInvites(serverId);
        sendJson(res, 200, { invites: invites.map(mapInvite) });
        return;
      }

      if (req.method === "POST") {
        const body = createInviteSchema.parse(await readJsonBody(req));
        const invite = await createInvite(serverId, user.id, {
          maxUses: body.maxUses,
          expiresInHours: body.expiresInHours,
        });
        sendJson(res, 201, { invite: mapInvite(invite) });
        return;
      }
    }

    const serverMembersMatch = pathname.match(
      /^\/api\/servers\/([^/]+)\/members$/,
    );
    if (serverMembersMatch && req.method === "GET") {
      const serverId = serverMembersMatch[1]!;
      if (!(await isServerMember(serverId, user.id))) {
        sendError(res, 403, "Forbidden");
        return;
      }
      sendJson(res, 200, { members: await listServerMembers(serverId) });
      return;
    }

    const serverLeaveMatch = pathname.match(/^\/api\/servers\/([^/]+)\/leave$/);
    if (serverLeaveMatch && req.method === "POST") {
      const serverId = serverLeaveMatch[1]!;
      try {
        await leaveServer(serverId, user.id);
        sendJson(res, 200, { ok: true });
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
        sendError(res, 403, "Only the owner can change roles");
        return;
      }
      const body = updateMemberRoleSchema.parse(await readJsonBody(req));
      await updateMemberRole(serverId, targetUserId, body.role);
      sendJson(res, 200, { ok: true });
      return;
    }

    const channelMatch = pathname.match(/^\/api\/channels\/([^/]+)$/);
    if (channelMatch) {
      const channelId = channelMatch[1]!;
      const channel = await getChannel(channelId);
      if (!channel) {
        sendError(res, 404, "Channel not found");
        return;
      }

      if (req.method === "PATCH") {
        if (!(await canManageServer(channel.server_id, user.id))) {
          sendError(res, 403, "Forbidden");
          return;
        }
        const body = updateChannelSchema.parse(await readJsonBody(req));
        const updated = await updateChannel(channelId, {
          name: body.name,
          isPrivate: body.isPrivate,
        });
        sendJson(res, 200, { channel: mapChannel(updated!) });
        return;
      }

      if (req.method === "DELETE") {
        if (!(await canManageServer(channel.server_id, user.id))) {
          sendError(res, 403, "Forbidden");
          return;
        }
        await deleteChannel(channelId);
        sendJson(res, 200, { ok: true });
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
        sendError(res, 404, "Channel not found");
        return;
      }
      if (!(await canManageServer(channel.server_id, user.id))) {
        sendError(res, 403, "Forbidden");
        return;
      }

      if (req.method === "GET") {
        sendJson(res, 200, {
          members: await listChannelMembers(channelId),
        });
        return;
      }

      if (req.method === "POST") {
        const body = addChannelMemberSchema.parse(await readJsonBody(req));
        if (!(await isServerMember(channel.server_id, body.userId))) {
          sendError(res, 400, "User must be a server member");
          return;
        }
        await addChannelMember(channelId, body.userId);
        sendJson(res, 201, { ok: true });
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
        sendError(res, 404, "Channel not found");
        return;
      }
      if (!(await canManageServer(channel.server_id, user.id))) {
        sendError(res, 403, "Forbidden");
        return;
      }
      await removeChannelMember(channelId, targetUserId);
      sendJson(res, 200, { ok: true });
      return;
    }

    const messagesMatch = pathname.match(/^\/api\/channels\/([^/]+)\/messages$/);
    if (messagesMatch && req.method === "GET") {
      const channelId = messagesMatch[1]!;
      if (!(await isChannelMember(channelId, user.id))) {
        sendError(res, 403, "Forbidden");
        return;
      }

      const url = new URL(req.url ?? "/", "http://localhost");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const before = url.searchParams.get("before") ?? undefined;
      const messages = await listMessages(channelId, limit, before, user.id);
      sendJson(res, 200, { messages: messages.map(mapMessage) });
      return;
    }

    sendError(res, 404, "Not found");
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && error.name === "ZodError") {
      sendError(res, 400, "Invalid request");
      return;
    }
    console.error(error);
    sendError(res, 500, "Internal server error");
  }
}

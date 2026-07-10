import type { Channel, Invite, Message, Server, User } from "@pqp/shared";
import { getApiBaseUrl } from "./utils";

export async function apiFetch<T>(
  path: string,
  token: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Request failed");
  }

  return response.json() as Promise<T>;
}

export function fetchMe(token: string) {
  return apiFetch<User>("/api/me", token);
}

export function updateMe(
  token: string,
  body: { displayName?: string; username?: string },
) {
  return apiFetch<User>("/api/me", token, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function fetchServers(token: string) {
  return apiFetch<{ servers: Server[] }>("/api/servers", token);
}

export function createServer(token: string, name: string) {
  return apiFetch<{ server: Server; channels: Channel[] }>("/api/servers", token, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function fetchChannels(token: string, serverId: string) {
  return apiFetch<{ channels: Channel[] }>(
    `/api/servers/${serverId}/channels`,
    token,
  );
}

export function createChannel(
  token: string,
  serverId: string,
  name: string,
  type: "text" | "voice",
  isPrivate = false,
) {
  return apiFetch<{ channel: Channel }>(
    `/api/servers/${serverId}/channels`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ name, type, isPrivate }),
    },
  );
}

export function updateChannel(
  token: string,
  channelId: string,
  body: { name?: string; isPrivate?: boolean },
) {
  return apiFetch<{ channel: Channel }>(`/api/channels/${channelId}`, token, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteChannel(token: string, channelId: string) {
  return apiFetch<{ ok: boolean }>(`/api/channels/${channelId}`, token, {
    method: "DELETE",
  });
}

export function fetchMessages(token: string, channelId: string) {
  return apiFetch<{ messages: Message[] }>(
    `/api/channels/${channelId}/messages`,
    token,
  );
}

export function createInvite(
  token: string,
  serverId: string,
  body: { maxUses?: number | null; expiresInHours?: number | null } = {},
) {
  return apiFetch<{ invite: Invite }>(
    `/api/servers/${serverId}/invites`,
    token,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

export function listInvites(token: string, serverId: string) {
  return apiFetch<{ invites: Invite[] }>(
    `/api/servers/${serverId}/invites`,
    token,
  );
}

export function joinInvite(token: string, code: string) {
  return apiFetch<{ serverId: string; serverName: string }>(
    `/api/invites/${code}/join`,
    token,
    { method: "POST" },
  );
}

export function previewInvite(token: string, code: string) {
  return apiFetch<{ invite: Invite }>(`/api/invites/${code}`, token);
}

export function fetchMembers(token: string, serverId: string) {
  return apiFetch<{
    members: Array<{
      id: string;
      displayName: string;
      tag: string | null;
      role: "owner" | "admin" | "member";
      avatarUrl: string | null;
    }>;
  }>(`/api/servers/${serverId}/members`, token);
}

export function updateMemberRole(
  token: string,
  serverId: string,
  userId: string,
  role: "admin" | "member",
) {
  return apiFetch<{ ok: boolean }>(
    `/api/servers/${serverId}/members/${userId}`,
    token,
    {
      method: "PATCH",
      body: JSON.stringify({ role }),
    },
  );
}

export function addChannelMember(
  token: string,
  channelId: string,
  userId: string,
) {
  return apiFetch<{ ok: boolean }>(
    `/api/channels/${channelId}/members`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ userId }),
    },
  );
}

export function removeChannelMember(
  token: string,
  channelId: string,
  userId: string,
) {
  return apiFetch<{ ok: boolean }>(
    `/api/channels/${channelId}/members/${userId}`,
    token,
    { method: "DELETE" },
  );
}

export function fetchChannelMembers(token: string, channelId: string) {
  return apiFetch<{
    members: Array<{
      id: string;
      displayName: string;
      username: string | null;
      discriminator: string | null;
      tag: string | null;
    }>;
  }>(`/api/channels/${channelId}/members`, token);
}

export function leaveServer(token: string, serverId: string) {
  return apiFetch<{ ok: boolean }>(`/api/servers/${serverId}/leave`, token, {
    method: "POST",
  });
}

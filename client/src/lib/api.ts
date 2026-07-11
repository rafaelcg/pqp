import type { Channel, Invite, Message, Server, User } from "@pqp/shared";
import { getApiBaseUrl } from "./utils";

const API_TIMEOUT_MS = 12_000;

function apiUnreachableMessage(cause?: string): string {
  const base = getApiBaseUrl();
  if (!base) {
    return (
      cause ??
      "No API backend at this origin. Host the API (e.g. Railway) and set VITE_API_URL / VITE_WS_URL, then rebuild."
    );
  }
  return cause ?? `Cannot reach API at ${base}`;
}

export async function apiFetch<T>(
  path: string,
  token: string,
  options?: RequestInit,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    API_TIMEOUT_MS,
  );

  if (options?.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }

  try {
    const response = await fetch(`${getApiBaseUrl()}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...options?.headers,
      },
    });

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new Error(
        apiUnreachableMessage(
          "API returned a non-JSON response (static host has no /api).",
        ),
      );
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(body.error ?? "Request failed");
    }

    return response.json() as Promise<T>;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(apiUnreachableMessage("API request timed out."));
    }
    if (error instanceof TypeError) {
      throw new Error(apiUnreachableMessage("Network error reaching API."));
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export function fetchMe(token: string) {
  return apiFetch<User>("/api/me", token);
}

export function updateMe(
  token: string,
  body: {
    displayName?: string;
    username?: string;
    avatarUrl?: string | null;
  },
) {
  return apiFetch<User>("/api/me", token, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function fetchIceServers(token: string) {
  return apiFetch<{ iceServers: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }> }>("/api/ice-servers", token);
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
  body: {
    name?: string;
    isPrivate?: boolean;
    topic?: string | null;
    imageUrl?: string | null;
  },
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

export function kickMember(token: string, serverId: string, userId: string) {
  return apiFetch<{ ok: boolean }>(
    `/api/servers/${serverId}/members/${userId}`,
    token,
    { method: "DELETE" },
  );
}

export function banMember(
  token: string,
  serverId: string,
  userId: string,
  reason?: string | null,
) {
  return apiFetch<{ ok: boolean }>(`/api/servers/${serverId}/bans`, token, {
    method: "POST",
    body: JSON.stringify({ userId, reason: reason ?? null }),
  });
}

export function unbanMember(token: string, serverId: string, userId: string) {
  return apiFetch<{ ok: boolean }>(
    `/api/servers/${serverId}/bans/${userId}`,
    token,
    { method: "DELETE" },
  );
}

export function listBans(token: string, serverId: string) {
  return apiFetch<{
    bans: Array<{
      userId: string;
      displayName: string;
      tag: string | null;
      reason: string | null;
      createdAt: string;
    }>;
  }>(`/api/servers/${serverId}/bans`, token);
}

export function deleteMessage(token: string, messageId: string) {
  return apiFetch<{ ok: boolean }>(`/api/messages/${messageId}`, token, {
    method: "DELETE",
  });
}

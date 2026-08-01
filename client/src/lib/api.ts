import type {
  Channel,
  ChannelUnread,
  Invite,
  Message,
  Server,
  User,
  UserPreferences,
  VoiceBackendType,
  VoiceSessionInfo,
} from "@pqp/shared";
import { getApiBaseUrl } from "./utils";

const API_TIMEOUT_MS = 12_000;

/**
 * Clerk session tokens expire after about a minute. The app used to capture one
 * token at bootstrap and reuse it for every later call, so any action taken more
 * than a minute into a session failed with "Unauthorized". Nothing holds a token
 * any more: every request asks the provider, which returns Clerk's cached token
 * and refreshes it when needed.
 */
type TokenProvider = (options?: { forceRefresh?: boolean }) => Promise<
  string | null
>;

let tokenProvider: TokenProvider = async () => null;

export function setAuthTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

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

async function request(
  path: string,
  options: RequestInit,
  token: string | null,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }

  try {
    return await fetch(`${getApiBaseUrl()}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  try {
    let token = await tokenProvider();
    let response = await request(path, options, token);

    // A 401 after a successful start almost always means the token aged out
    // mid-session. Refresh once and retry before surfacing an error.
    if (response.status === 401) {
      token = await tokenProvider({ forceRefresh: true });
      if (token) {
        response = await request(path, options, token);
      }
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new ApiError(
        response.status,
        apiUnreachableMessage(
          "API returned a non-JSON response (static host has no /api).",
        ),
      );
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new ApiError(response.status, body.error ?? "Request failed");
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError(0, apiUnreachableMessage("API request timed out."));
    }
    if (error instanceof TypeError) {
      throw new ApiError(0, apiUnreachableMessage("Network error reaching API."));
    }
    throw error;
  }
}

function post<T>(path: string, body?: unknown) {
  return apiFetch<T>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function patch<T>(path: string, body: unknown) {
  return apiFetch<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

function del<T>(path: string, body?: unknown) {
  return apiFetch<T>(path, {
    method: "DELETE",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// ------------------------------------------------------------------ profile

export const fetchMe = () => apiFetch<User>("/api/me");

export const updateMe = (body: {
  displayName?: string;
  username?: string;
  avatarUrl?: string | null;
}) => patch<User>("/api/me", body);

/** Patch of changed keys in, whole merged object out. */
export const updatePreferences = (body: UserPreferences) =>
  patch<{ preferences: UserPreferences }>("/api/me/preferences", body);

// -------------------------------------------------------------------- voice

export const fetchIceServers = () =>
  apiFetch<{
    iceServers: Array<{
      urls: string | string[];
      username?: string;
      credential?: string;
    }>;
  }>("/api/ice-servers");

/** Which media path the server is configured for (mesh vs SFU). */
export const fetchVoiceBackend = () =>
  apiFetch<{ backend: VoiceBackendType }>("/api/voice/backend");

/** Mint an SFU session for a voice channel the caller has already joined. */
export const createVoiceSession = (voiceChannelId: string, peerId: string) =>
  post<VoiceSessionInfo>("/api/voice/token", { voiceChannelId, peerId });

// ------------------------------------------------------------------ servers

export const fetchServers = () =>
  apiFetch<{ servers: Server[] }>("/api/servers");

export const createServer = (name: string) =>
  post<{ server: Server; channels: Channel[] }>("/api/servers", { name });

export const updateServer = (
  serverId: string,
  body: { name?: string; ownerId?: string },
) => patch<{ ok: boolean; server?: Server }>(`/api/servers/${serverId}`, body);

export const deleteServer = (serverId: string) =>
  del<{ ok: boolean }>(`/api/servers/${serverId}`);

export const leaveServer = (serverId: string) =>
  post<{ ok: boolean }>(`/api/servers/${serverId}/leave`);

export const fetchUnread = (serverId: string) =>
  apiFetch<{ unread: ChannelUnread[] }>(`/api/servers/${serverId}/unread`);

// ----------------------------------------------------------------- channels

export const fetchChannels = (serverId: string) =>
  apiFetch<{ channels: Channel[] }>(`/api/servers/${serverId}/channels`);

export const createChannel = (
  serverId: string,
  name: string,
  type: "text" | "voice",
  isPrivate = false,
) =>
  post<{ channel: Channel }>(`/api/servers/${serverId}/channels`, {
    name,
    type,
    isPrivate,
  });

export const updateChannel = (
  channelId: string,
  body: {
    name?: string;
    isPrivate?: boolean;
    topic?: string | null;
    imageUrl?: string | null;
  },
) => patch<{ channel: Channel }>(`/api/channels/${channelId}`, body);

export const deleteChannel = (channelId: string) =>
  del<{ ok: boolean }>(`/api/channels/${channelId}`);

export const markChannelRead = (channelId: string) =>
  post<{ ok: boolean }>(`/api/channels/${channelId}/read`);

// ----------------------------------------------------------------- messages

export const fetchMessages = (
  channelId: string,
  options: { limit?: number; before?: string } = {},
) => {
  const params = new URLSearchParams();
  if (options.limit) {
    params.set("limit", String(options.limit));
  }
  if (options.before) {
    params.set("before", options.before);
  }
  const query = params.toString();
  return apiFetch<{ messages: Message[]; hasMore: boolean }>(
    `/api/channels/${channelId}/messages${query ? `?${query}` : ""}`,
  );
};

export const editMessage = (messageId: string, body: string) =>
  patch<{ message: Message }>(`/api/messages/${messageId}`, { body });

export const deleteMessage = (messageId: string) =>
  del<{ ok: boolean }>(`/api/messages/${messageId}`);

// ------------------------------------------------------------------ members

export interface ServerMember {
  id: string;
  displayName: string;
  username?: string | null;
  discriminator?: string | null;
  tag: string | null;
  role: "owner" | "admin" | "member";
  avatarUrl: string | null;
}

export const fetchMembers = (serverId: string) =>
  apiFetch<{ members: ServerMember[] }>(`/api/servers/${serverId}/members`);

export const updateMemberRole = (
  serverId: string,
  userId: string,
  role: "admin" | "member",
) =>
  patch<{ ok: boolean }>(`/api/servers/${serverId}/members/${userId}`, { role });

export const kickMember = (serverId: string, userId: string) =>
  del<{ ok: boolean }>(`/api/servers/${serverId}/members/${userId}`);

/** Bans work on non-members too, so an invite can be closed pre-emptively. */
export const banMember = (
  serverId: string,
  userId: string,
  reason?: string | null,
) =>
  post<{ ok: boolean }>(`/api/servers/${serverId}/bans`, {
    userId,
    reason: reason ?? null,
  });

export const unbanMember = (serverId: string, userId: string) =>
  del<{ ok: boolean }>(`/api/servers/${serverId}/bans/${userId}`);

export interface ServerBan {
  userId: string;
  displayName: string;
  tag: string | null;
  reason: string | null;
  createdAt: string;
}

export const listBans = (serverId: string) =>
  apiFetch<{ bans: ServerBan[] }>(`/api/servers/${serverId}/bans`);

export const addChannelMember = (channelId: string, userId: string) =>
  post<{ ok: boolean }>(`/api/channels/${channelId}/members`, { userId });

export const removeChannelMember = (channelId: string, userId: string) =>
  del<{ ok: boolean }>(`/api/channels/${channelId}/members/${userId}`);

export const fetchChannelMembers = (channelId: string) =>
  apiFetch<{
    members: Array<{
      id: string;
      displayName: string;
      username: string | null;
      discriminator: string | null;
      tag: string | null;
    }>;
  }>(`/api/channels/${channelId}/members`);

// ------------------------------------------------------------------ invites

export const createInvite = (
  serverId: string,
  body: { maxUses?: number | null; expiresInHours?: number | null } = {},
) => post<{ invite: Invite }>(`/api/servers/${serverId}/invites`, body);

export const listInvites = (serverId: string) =>
  apiFetch<{ invites: Invite[] }>(`/api/servers/${serverId}/invites`);

export const deleteInvite = (serverId: string, inviteId: string) =>
  del<{ ok: boolean }>(`/api/servers/${serverId}/invites/${inviteId}`);

export const joinInvite = (code: string) =>
  post<{ serverId: string; serverName: string }>(
    `/api/invites/${encodeURIComponent(code)}/join`,
  );

export const previewInvite = (code: string) =>
  apiFetch<{ invite: Invite }>(`/api/invites/${encodeURIComponent(code)}`);

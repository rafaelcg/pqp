import type {
  AgeCheckResponse,
  Attachment,
  AttachmentUrlResponse,
  AuditLogPage,
  BlockListResponse,
  Channel,
  ChannelUnread,
  CreateAttachmentRequest,
  CreateGifAttachmentRequest,
  CreateAttachmentResponse,
  DmListResponse,
  DmPrivacy,
  DmSummary,
  Gif,
  Invite,
  MemberTimeout,
  Message,
  MessageSearchResponse,
  CreateReportRequest,
  PublicUser,
  Report,
  ReportPage,
  ReportStatus,
  ReportSummaryPage,
  ResolveReportRequest,
  Server,
  ThreadSummary,
  User,
  UserPreferences,
  UserSearchResponse,
  UserStatus,
  VoiceBackendType,
  VoiceSessionInfo,
  Webhook,
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
  dmPrivacy?: DmPrivacy;
}) => patch<User>("/api/me", body);

/** Patch of changed keys in, whole merged object out. */
export const updatePreferences = (body: UserPreferences) =>
  patch<{ preferences: UserPreferences }>("/api/me/preferences", body);

/**
 * The 18+ declaration. One per account — a second call answers 409, and the
 * client is not built to recover from that beyond re-reading `/api/me`, which
 * is the correct behaviour: there is nothing to retry.
 *
 * `dateOfBirth` is a bare `YYYY-MM-DD` calendar date. No timezone is sent and
 * none should be: the server decides the boundary, and a date carrying the
 * browser's offset is a date the browser could move.
 */
export const submitAgeCheck = (dateOfBirth: string) =>
  post<AgeCheckResponse>("/api/me/age-check", { dateOfBirth });

// ---------------------------------------------------------- your own data

/**
 * Everything the service holds about you, as a file (LGPD art. 18, II and V).
 *
 * A `Blob` rather than parsed JSON, for the same reason `exportServerData`
 * below is: this is a file the browser is about to save, not data the app
 * reads. It shares that function's auth-and-retry path and skips only the
 * "parse it as JSON" step.
 */
export async function exportMyData(): Promise<Blob> {
  const token = await tokenProvider();
  let response = await request("/api/me/export", {}, token);
  if (response.status === 401) {
    const refreshed = await tokenProvider({ forceRefresh: true });
    if (refreshed) {
      response = await request("/api/me/export", {}, refreshed);
    }
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(response.status, body.error ?? "Export failed");
  }
  return response.blob();
}

/** A server the caller owns that somebody else is still in, so deletion is
 * refused until they transfer it or delete it. */
export interface BlockingOwnedServer {
  id: string;
  name: string;
  otherMemberCount: number;
}

/**
 * The 409 the delete answers when owned servers are in the way. Carries the
 * list so the UI can name them, rather than telling the user to go and find
 * out for themselves which server is the problem.
 */
export class OwnedServersError extends ApiError {
  constructor(
    message: string,
    readonly servers: BlockingOwnedServer[],
  ) {
    super(409, message);
    this.name = "OwnedServersError";
  }
}

/**
 * Delete your own account (LGPD art. 18, IV and VI). Irreversible.
 *
 * `confirm` is the account's own handle, typed by the user — see
 * `deleteConfirmationMatches` in @pqp/shared, which both this caller's button
 * state and the server's refusal are built on, so they cannot disagree about
 * what counts as confirmed.
 *
 * Driven through `request()` rather than `apiFetch` because the one refusal the
 * UI has to *act* on — 409, blocked by owned servers — carries a list of those
 * servers in the body, and `apiFetch` reduces every error to its `error`
 * string. Retrying once on a 401 is copied from there rather than shared,
 * because that is the only part of it this needs.
 */
export async function deleteMyAccount(confirm: string): Promise<void> {
  const body = JSON.stringify({ confirm });
  const token = await tokenProvider();
  let response = await request("/api/me", { method: "DELETE", body }, token);
  if (response.status === 401) {
    const refreshed = await tokenProvider({ forceRefresh: true });
    if (refreshed) {
      response = await request("/api/me", { method: "DELETE", body }, refreshed);
    }
  }
  if (response.ok) {
    return;
  }

  const failure = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    servers?: BlockingOwnedServer[];
  };
  if (response.status === 409 && failure.code === "owned_servers") {
    throw new OwnedServersError(
      failure.error ?? "Servers you own are in the way",
      failure.servers ?? [],
    );
  }
  throw new ApiError(response.status, failure.error ?? "Could not delete account");
}

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

// --------------------------------------------------------------------- gifs

/** Whether this deployment has a provider key, so the button can be hidden. */
export const fetchGifConfig = () =>
  apiFetch<{ enabled: boolean }>("/api/gifs/config");

export const searchGifs = (query: string, signal?: AbortSignal) =>
  apiFetch<{ gifs: Gif[] }>(
    `/api/gifs/search?q=${encodeURIComponent(query)}`,
    signal ? { signal } : {},
  );

export const fetchTrendingGifs = (signal?: AbortSignal) =>
  apiFetch<{ gifs: Gif[] }>("/api/gifs/trending", signal ? { signal } : {});

// -------------------------------------------------------------- attachments

/**
 * Whether this deployment has object storage, so the paperclip can be hidden.
 * `maxBytes` is optional: a server that only reports `enabled` leaves the client
 * on the shared ceiling, which is the value it would have enforced anyway.
 */
export const fetchAttachmentConfig = () =>
  apiFetch<{ enabled: boolean; maxBytes?: number }>("/api/attachments/config");

/**
 * Reserve a row and get a presigned PUT for it. The storage key is chosen by
 * the server — a client-supplied one would let anybody overwrite anybody's
 * object — so nothing about the destination is negotiable here.
 */
export const createAttachment = (
  channelId: string,
  body: CreateAttachmentRequest,
  signal?: AbortSignal,
) =>
  apiFetch<CreateAttachmentResponse>(`/api/channels/${channelId}/attachments`, {
    method: "POST",
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

/**
 * Stage a picked GIF as an attachment. Nothing is uploaded — the bytes stay on
 * the provider — so this is one call rather than the mint-then-PUT dance, and
 * it works on a deployment with no object storage at all.
 */
export const createGifAttachment = (
  channelId: string,
  body: CreateGifAttachmentRequest,
  signal?: AbortSignal,
) =>
  apiFetch<{ attachment: Attachment }>(
    `/api/channels/${channelId}/attachments/gif`,
    {
      method: "POST",
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    },
  );

/**
 * A fresh presigned GET for one attachment. Read URLs are minted per response
 * and expire, so a tab left open overnight is holding dead links — this is how
 * it heals rather than showing a broken image.
 */
export const fetchAttachmentUrl = (attachmentId: string) =>
  apiFetch<AttachmentUrlResponse>(`/api/attachments/${attachmentId}/url`);

// ------------------------------------------------------------------ servers

export const fetchServers = () =>
  apiFetch<{ servers: Server[] }>("/api/servers");

export const createServer = (name: string) =>
  post<{ server: Server; channels: Channel[] }>("/api/servers", { name });

export const updateServer = (
  serverId: string,
  body: {
    name?: string;
    ownerId?: string;
    messageRetentionDays?: number | null;
    ssoEmailDomain?: string | null;
  },
) => patch<{ ok: boolean; server?: Server }>(`/api/servers/${serverId}`, body);

/** Servers a verified email domain lets this user join without an invite. */
export const fetchSsoAvailableServers = () =>
  apiFetch<{ servers: Server[] }>("/api/servers/sso-available");

export const joinServerBySso = (serverId: string) =>
  post<{ ok: boolean; server: Server }>(
    `/api/servers/${serverId}/sso-join`,
    {},
  );

export const deleteServer = (serverId: string) =>
  del<{ ok: boolean }>(`/api/servers/${serverId}`);

/**
 * The one response this file hands back as a `Blob` instead of parsed JSON —
 * it is a file the browser is about to save, not data the app reads. Goes
 * through the same auth/retry path as `apiFetch` (via `request`), just
 * without the "parse it as JSON" step at the end.
 */
export async function exportServerData(serverId: string): Promise<Blob> {
  const token = await tokenProvider();
  let response = await request(`/api/servers/${serverId}/export`, {}, token);
  if (response.status === 401) {
    const refreshed = await tokenProvider({ forceRefresh: true });
    if (refreshed) {
      response = await request(`/api/servers/${serverId}/export`, {}, refreshed);
    }
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(response.status, body.error ?? "Export failed");
  }
  return response.blob();
}

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
  type: "text" | "voice" | "category",
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

/**
 * Move a channel to a 0-based position among the siblings under `parentId`
 * (a category, or null for top-level). Answers with the server's whole fresh
 * channel list — reorders are not broadcast live, matching how create/rename/
 * delete already behave, so the actor's own client is the only one that
 * needs to update from this response.
 */
export const moveChannel = (
  channelId: string,
  parentId: string | null,
  index: number,
) =>
  patch<{ channels: Channel[] }>(`/api/channels/${channelId}/move`, {
    parentId,
    index,
  });

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

/**
 * Full-text search across every channel of one server the caller can see.
 * `before` is the opaque cursor the previous page returned.
 */
export const searchServerMessages = (
  serverId: string,
  options: { q: string; limit?: number; before?: string | null },
  signal?: AbortSignal,
) => {
  const params = new URLSearchParams({ q: options.q });
  if (options.limit) {
    params.set("limit", String(options.limit));
  }
  if (options.before) {
    params.set("before", options.before);
  }
  return apiFetch<MessageSearchResponse>(
    `/api/servers/${serverId}/search?${params.toString()}`,
    signal ? { signal } : {},
  );
};

export const editMessage = (messageId: string, body: string) =>
  patch<{ message: Message }>(`/api/messages/${messageId}`, { body });

export const deleteMessage = (messageId: string) =>
  del<{ ok: boolean }>(`/api/messages/${messageId}`);

export const pinMessage = (messageId: string) =>
  post<{ message: Message }>(`/api/messages/${messageId}/pin`);

export const unpinMessage = (messageId: string) =>
  del<{ message: Message }>(`/api/messages/${messageId}/pin`);

export const fetchPinnedMessages = (channelId: string) =>
  apiFetch<{ messages: Message[] }>(`/api/channels/${channelId}/pins`);

// ------------------------------------------------------------------ threads

/** Start a thread from a message — or get back the one it already has
 * (idempotent server-side; two taps race to one row). */
export const createThread = (messageId: string) =>
  post<{ thread: ThreadSummary }>(`/api/messages/${messageId}/threads`);

// ------------------------------------------------------------------ members

export interface ServerMember {
  id: string;
  displayName: string;
  username?: string | null;
  discriminator?: string | null;
  tag: string | null;
  role: "owner" | "admin" | "member";
  avatarUrl: string | null;
  /**
   * Resolved live by the server from its connection registry — never stored, and
   * never `invisible`: somebody hidden resolves to `offline` here exactly like
   * somebody who is genuinely away.
   *
   * Optional so a client built against this shape still parses a response from
   * an API that predates status, and read as `offline` when absent rather than
   * as online, so the older-server case degrades to "nobody is shown as here"
   * instead of "everybody is".
   */
  status?: UserStatus;
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

/**
 * Timeouts — the temporary sanction between deleting a message and banning the
 * account. `listTimeouts` returns only the ones still running: expiry is
 * evaluated by the server on every read, so there is no "expired" state for a
 * client to filter out or, worse, to get wrong.
 */
export const listTimeouts = (serverId: string) =>
  apiFetch<{ timeouts: MemberTimeout[] }>(
    `/api/servers/${serverId}/timeouts`,
  );

export const timeoutMember = (
  serverId: string,
  userId: string,
  minutes: number,
  reason?: string | null,
) =>
  post<{ timeout: { expiresAt: string }; message: string }>(
    `/api/servers/${serverId}/timeouts`,
    { userId, minutes, reason: reason ?? null },
  );

export const liftTimeout = (serverId: string, userId: string) =>
  del<{ ok: boolean }>(`/api/servers/${serverId}/timeouts/${userId}`);

// --- voice moderation ---
//
// Voice-specific moderator tools. Same rank rules as kick server-side; all
// three are audit-logged there and the target is notified over their socket.

export const disconnectMemberVoice = (serverId: string, userId: string) =>
  post<{ ok: boolean }>(
    `/api/servers/${serverId}/members/${userId}/voice-disconnect`,
  );

export const moveMemberVoice = (
  serverId: string,
  userId: string,
  channelId: string,
) =>
  post<{ ok: boolean }>(`/api/servers/${serverId}/members/${userId}/voice-move`, {
    channelId,
  });

/**
 * SFU rooms only — a mesh call's audio never touches the server, and the API
 * answers 409 with the honest explanation rather than pretending otherwise.
 */
export const setMemberVoiceMuted = (
  serverId: string,
  userId: string,
  muted: boolean,
) =>
  post<{ ok: boolean }>(`/api/servers/${serverId}/members/${userId}/voice-mute`, {
    muted,
  });

/** `before` is the last-loaded entry's own `id` — a bare, ever-increasing
 * cursor, unlike the message list's timestamp-plus-id pair (see the schema
 * comment on `audit_log` for why the simpler cursor is safe here). */
export const fetchAuditLog = (
  serverId: string,
  options: { before?: string; action?: string; actorId?: string } = {},
) => {
  const params = new URLSearchParams();
  if (options.before) params.set("before", options.before);
  if (options.action) params.set("action", options.action);
  if (options.actorId) params.set("actorId", options.actorId);
  const query = params.toString();
  return apiFetch<AuditLogPage>(
    `/api/servers/${serverId}/audit-log${query ? `?${query}` : ""}`,
  );
};

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

export const fetchWebhooks = (channelId: string) =>
  apiFetch<{ webhooks: Webhook[] }>(`/api/channels/${channelId}/webhooks`);

export const createWebhook = (
  channelId: string,
  body: { name: string; avatarUrl?: string | null },
) => post<{ webhook: Webhook }>(`/api/channels/${channelId}/webhooks`, body);

export const deleteWebhook = (webhookId: string) =>
  del<{ ok: boolean }>(`/api/webhooks/${webhookId}`);

// ------------------------------------------------------- users, DMs, blocks

/**
 * Prefix search over handles, and the only way to reach somebody you share no
 * server with.
 *
 * Takes a signal because it is typed into: an in-flight request for `an` must
 * be abandoned rather than allowed to land after the one for `ana` and repaint
 * the list with staler results.
 */
export const searchUsers = (query: string, signal?: AbortSignal) =>
  apiFetch<UserSearchResponse>(
    `/api/users/search?q=${encodeURIComponent(query)}`,
    signal ? { signal } : {},
  );

/**
 * Exact `name#1234` lookup, for a handle somebody read out to you.
 *
 * Answers with one user or a 404 — unlike search, which answers with a list.
 * A handle names exactly one account or none, and flattening the miss into an
 * empty list here would hide the difference between "no such handle" and "the
 * search found nothing", which are different things to say to the user.
 */
export const lookupUserByTag = (tag: string, signal?: AbortSignal) =>
  apiFetch<{ user: PublicUser }>(
    `/api/users/lookup?tag=${encodeURIComponent(tag)}`,
    signal ? { signal } : {},
  );

export const fetchConversations = () =>
  apiFetch<DmListResponse>("/api/dms");

/**
 * Open a conversation with these people, or hand back the one that already
 * exists — a second tap must not create a second 1:1 with the same person.
 *
 * The caller's own id is not sent. A conversation with yourself is not a thing
 * the model can express, and the server rejects it rather than storing half of
 * one.
 */
export const createConversation = (userIds: string[]) =>
  post<{ conversation: DmSummary }>("/api/dms", { userIds });

/**
 * Take a conversation off the list. It is hidden, not deleted: the other person
 * still has their copy, and one side removing a row must not destroy the other
 * side's history.
 */
export const hideConversation = (channelId: string) =>
  del<{ ok: boolean }>(`/api/dms/${channelId}`);

export const fetchBlocks = () => apiFetch<BlockListResponse>("/api/blocks");

export const blockUser = (userId: string) =>
  post<{ ok: boolean }>("/api/blocks", { userId });

export const unblockUser = (userId: string) =>
  del<{ ok: boolean }>(`/api/blocks/${userId}`);

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

// ------------------------------------------------------------------ reports

/**
 * File a report. The body says *what* is wrong, never where the report should
 * go — the server derives that from the reported message or the named server,
 * so a client cannot aim a complaint at the wrong moderators.
 */
export const createReport = (body: CreateReportRequest) =>
  post<{ report: Report }>("/api/reports", body);

/** Same bare-integer cursor contract as the audit log. */
function reportQuery(options: { before?: string; status?: ReportStatus }) {
  const params = new URLSearchParams();
  if (options.before) params.set("before", options.before);
  if (options.status) params.set("status", options.status);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const fetchServerReports = (
  serverId: string,
  options: { before?: string; status?: ReportStatus } = {},
) =>
  apiFetch<ReportPage>(
    `/api/servers/${serverId}/reports${reportQuery(options)}`,
  );

/**
 * The reporter's own reports, in the narrow shape they may see — no moderator
 * name and no snapshot of anyone's content.
 */
export const fetchMyReports = (
  options: { before?: string; status?: ReportStatus } = {},
) => apiFetch<ReportSummaryPage>(`/api/reports/mine${reportQuery(options)}`);

export const resolveReport = (
  reportId: string,
  body: ResolveReportRequest,
) => patch<{ report: Report }>(`/api/reports/${reportId}`, body);

import type { ChannelSession } from "@pqp/shared";
import { apiFetch } from "./api";

/**
 * Watch party session scheduling. Thin wrappers over the server routes in
 * `server/src/api/index.ts`. Kept in their own file rather than folded into
 * `api.ts` so this feature's surface stays reviewable on its own.
 */

export function createChannelSession(
  channelId: string,
  input: { title: string; startsAt: string; description?: string | null },
): Promise<{ session: ChannelSession }> {
  return apiFetch<{ session: ChannelSession }>(`/api/channels/${channelId}/sessions`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateChannelSession(
  sessionId: string,
  patch: { title?: string; startsAt?: string; description?: string | null },
): Promise<{ session: ChannelSession }> {
  return apiFetch<{ session: ChannelSession }>(`/api/sessions/${sessionId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function cancelChannelSession(
  sessionId: string,
): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/api/sessions/${sessionId}/cancel`, { method: "POST" });
}

export function listUpcomingChannelSessions(
  channelId: string,
): Promise<{ sessions: ChannelSession[] }> {
  return apiFetch<{ sessions: ChannelSession[] }>(`/api/channels/${channelId}/sessions/upcoming`);
}

export function listUpcomingChannelSessionsForServer(
  serverId: string,
): Promise<{ sessions: ChannelSession[] }> {
  return apiFetch<{ sessions: ChannelSession[] }>(`/api/servers/${serverId}/sessions/upcoming`);
}

export function setChannelSessionReminder(
  sessionId: string,
  wants: boolean,
): Promise<{ ok: true; reminding: boolean }> {
  return apiFetch<{ ok: true; reminding: boolean }>(`/api/sessions/${sessionId}/remind`, {
    method: wants ? "POST" : "DELETE",
  });
}

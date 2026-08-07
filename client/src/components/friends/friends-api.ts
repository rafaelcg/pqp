import type { FriendRequestResult, FriendsResponse } from "@pqp/shared";
import { apiFetch } from "@/lib/api";

/**
 * The friends endpoints, kept beside the only view that calls them rather
 * than in lib/api.ts — same shape as every wrapper there: typed, thin, and
 * riding `apiFetch` for auth, timeout and the 401-refresh retry.
 */

export const fetchFriends = () => apiFetch<FriendsResponse>("/api/friends");

export const sendFriendRequest = (userId: string) =>
  apiFetch<FriendRequestResult>("/api/friends", {
    method: "POST",
    body: JSON.stringify({ userId }),
  });

export const acceptFriendRequest = (userId: string) =>
  apiFetch<{ ok: boolean }>(`/api/friends/${userId}/accept`, {
    method: "POST",
  });

/** Decline, cancel, or unfriend — the server treats all three as one removal. */
export const removeFriend = (userId: string) =>
  apiFetch<{ ok: boolean }>(`/api/friends/${userId}`, { method: "DELETE" });

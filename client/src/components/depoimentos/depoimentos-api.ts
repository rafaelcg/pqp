import type {
  Depoimento,
  DepoimentoList,
  PendingDepoimentoList,
  ProfileCommunityList,
} from "@pqp/shared";
import { apiFetch } from "@/lib/api";

/**
 * The depoimento endpoints, kept beside the feature that calls them rather
 * than in lib/api.ts — the same shape `friends-api.ts` uses: typed, thin, and
 * riding `apiFetch` for auth, timeout and the 401-refresh retry.
 */

/** A profile's published depoimentos. Empty for somebody outside the audience. */
export const fetchDepoimentos = (userId: string) =>
  apiFetch<DepoimentoList>(`/api/users/${userId}/depoimentos`);

/** Your own queue — the only place a pending one is readable. */
export const fetchPendingDepoimentos = () =>
  apiFetch<PendingDepoimentoList>("/api/me/depoimentos/pending");

export const writeDepoimento = (userId: string, body: string) =>
  apiFetch<{ depoimento: Depoimento }>(`/api/users/${userId}/depoimentos`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });

export const approveDepoimento = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/depoimentos/${id}/approve`, {
    method: "POST",
  });

/**
 * Refuse a pending one, take a published one down, or withdraw your own — the
 * server treats all three as one deletion, and none of them tells the other
 * side anything.
 */
export const deleteDepoimento = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/depoimentos/${id}`, { method: "DELETE" });

/** The community chips on somebody's card. */
export const fetchProfileCommunities = (userId: string) =>
  apiFetch<ProfileCommunityList>(`/api/users/${userId}/communities`);

/** This membership's badge opt-out, flipped from the community's own menu. */
export const setProfileVisibility = (serverId: string, showOnProfile: boolean) =>
  apiFetch<{ ok: boolean; showOnProfile: boolean }>(
    `/api/servers/${serverId}/profile-visibility`,
    { method: "PATCH", body: JSON.stringify({ showOnProfile }) },
  );

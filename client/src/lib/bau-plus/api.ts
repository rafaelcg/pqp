import type {
  BauAttemptResponse,
  BauMembership,
  BauMembershipsResponse,
  BauOffer,
  BauPaymentMethod,
  BauSandboxAction,
} from "@pqp/shared";
import { apiFetch } from "@/lib/api";

/**
 * Baú+ over HTTP (`docs/BAU_PAYMENTS.md`). Web and desktop only: the phone
 * apps never draw a price, a Pix or a pay button.
 */

function post<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export const fetchBauOffer = (serverId: string) =>
  apiFetch<BauOffer>(`/api/servers/${serverId}/bau-plus`);

export const startBauCheckout = (
  serverId: string,
  planId: string,
  method: BauPaymentMethod,
) =>
  post<BauAttemptResponse>(`/api/servers/${serverId}/bau-plus/checkout`, {
    planId,
    method,
  });

export const fetchBauAttempt = (attemptId: string, refresh = false) =>
  apiFetch<BauAttemptResponse>(
    `/api/bau-plus/attempts/${attemptId}${refresh ? "?refresh=1" : ""}`,
  );

export const cancelBauAttempt = (attemptId: string) =>
  post<BauAttemptResponse>(`/api/bau-plus/attempts/${attemptId}/cancel`);

export const actOnSandboxAttempt = (
  attemptId: string,
  action: BauSandboxAction,
) =>
  post<BauAttemptResponse>(`/api/bau-plus/attempts/${attemptId}/sandbox`, {
    action,
  });

export const fetchMyBauMemberships = () =>
  apiFetch<BauMembershipsResponse>("/api/bau-plus/memberships");

export const cancelBauMembership = (membershipId: string) =>
  post<{ membership: BauMembership }>(
    `/api/bau-plus/memberships/${membershipId}/cancel`,
  );

export const resumeBauMembership = (membershipId: string) =>
  post<{ membership: BauMembership }>(
    `/api/bau-plus/memberships/${membershipId}/resume`,
  );

export const refundBauMembership = (membershipId: string) =>
  post<{ membership: BauMembership }>(
    `/api/bau-plus/memberships/${membershipId}/refund`,
  );

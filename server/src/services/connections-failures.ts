import type { ConnectionProvider } from "@pqp/shared";
import { logEvent } from "../lib/log.js";

/**
 * What `completeConnection` says when it fails.
 *
 * For 17 days Twitch (and Battle.net) connections failed in production with
 * NOTHING in the log: the operator rotated the Twitch app's client secret, the
 * token exchange got `403 invalid client secret`, the person saw one generic
 * sentence, and the pending state row was already consumed. Every failure on
 * this path now leaves one `[pqp] connections.completeFailed` line naming the
 * provider, the user, the step and what the provider said, and a rejected
 * client secret additionally leaves one error line an alert rule can match.
 *
 * Never logged, on any path: the authorization code, an access token, the
 * client secret, the PKCE verifier, the state nonce, or a callback URL (the
 * code rides in its query string). `upstreamError` is scrubbed of the first
 * four before it gets here (`describeUpstream`).
 */

export type ConnectionFailureStep =
  | "not_configured"
  | "provider_error"
  | "state_missing"
  | "state_consume"
  | "code_missing"
  | "steam_verify"
  | "steam_profile"
  | "token_exchange"
  | "userinfo"
  | "upsert";

export interface ConnectionFailure {
  provider: ConnectionProvider;
  userId: string;
  step: ConnectionFailureStep;
  /** What we answered the client. */
  status: number;
  upstreamStatus?: number;
  upstreamError?: string;
  /** Our own short reason, e.g. the HttpError text. Never provider-supplied. */
  reason?: string;
}

/** Since-boot counts by `<provider>.<step>`, for the operator metrics. Bounded: 3 x 10. */
const failureCounts = new Map<string, number>();

export function connectionFailureCounts(): Record<string, number> {
  return Object.fromEntries(failureCounts);
}

/** Test seam: the counters and the once-an-hour latch are module state. */
export function resetConnectionFailureState(): void {
  failureCounts.clear();
  credentialsAlertedAt.clear();
}

const CREDENTIALS_ALERT_INTERVAL_MS = 60 * 60 * 1000;
const credentialsAlertedAt = new Map<ConnectionProvider, number>();

const SECRET_ENV: Partial<Record<ConnectionProvider, string>> = {
  battlenet: "BATTLENET_CLIENT_SECRET",
  twitch: "TWITCH_CLIENT_SECRET",
};

export function reportConnectionFailure(failure: ConnectionFailure): void {
  const key = `${failure.provider}.${failure.step}`;
  failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
  logEvent("connections.completeFailed", { ...failure });
}

/**
 * The provider rejected OUR client id/secret. Every occurrence gets the
 * ordinary line above; the first per provider per hour also gets this one on
 * stderr, in a fixed sentence, so a Loki rule or a grep finds it without
 * knowing the provider and a stuck integration cannot flood the log.
 */
export function reportProviderCredentialsRejected(
  provider: ConnectionProvider,
  detail: { upstreamStatus?: number; upstreamError?: string },
): void {
  const now = Date.now();
  const last = credentialsAlertedAt.get(provider);
  if (last !== undefined && now - last < CREDENTIALS_ALERT_INTERVAL_MS) {
    return;
  }
  credentialsAlertedAt.set(provider, now);
  const secretName = SECRET_ENV[provider] ?? `${provider.toUpperCase()}_CLIENT_SECRET`;
  const suffix = [
    `provider=${provider}`,
    detail.upstreamStatus !== undefined ? `upstreamStatus=${detail.upstreamStatus}` : null,
    detail.upstreamError ? `upstreamError=${detail.upstreamError}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  console.error(
    `[pqp] connections.credentialsRejected PROVIDER CREDENTIALS REJECTED: check ${secretName} ${suffix}`,
  );
}

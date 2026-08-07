import { DEV_AUTH_TOKEN } from "@pqp/shared";

export { DEV_AUTH_TOKEN };

export function isDevAuthBypassEnabled(): boolean {
  return import.meta.env.VITE_DEV_AUTH_BYPASS === "true";
}

/**
 * The dev-bypass bearer token for this browser context.
 *
 * The server already understands `dev-local-token:<suffix>` as a *distinct*
 * dev account (the e2e suite drives its "callee" over a raw WebSocket that
 * way). Reading an optional suffix from localStorage lets a Playwright test
 * put a second, fully real client in a second browser context — which is the
 * only way to end-to-end a call with actual media in both directions.
 *
 * Inert outside the bypass: this function is only reached when
 * `VITE_DEV_AUTH_BYPASS` is `"true"`, which production builds never set, and
 * the server ignores dev tokens entirely when `NODE_ENV=production`.
 */
export function devAuthToken(): string {
  let suffix: string | null = null;
  try {
    suffix = localStorage.getItem("pqp:dev-user-suffix");
  } catch {
    // Storage can be denied (privacy mode); the primary account is fine.
  }
  return suffix ? `${DEV_AUTH_TOKEN}:${suffix}` : DEV_AUTH_TOKEN;
}

export async function getAuthToken(
  getClerkToken: () => Promise<string | null>,
): Promise<string | null> {
  if (isDevAuthBypassEnabled()) {
    return devAuthToken();
  }
  return getClerkToken();
}

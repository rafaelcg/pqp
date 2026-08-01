import { DEV_AUTH_TOKEN } from "@pqp/shared";

export { DEV_AUTH_TOKEN };

export function isDevAuthBypassEnabled(): boolean {
  return import.meta.env.VITE_DEV_AUTH_BYPASS === "true";
}

export async function getAuthToken(
  getClerkToken: () => Promise<string | null>,
): Promise<string | null> {
  if (isDevAuthBypassEnabled()) {
    return DEV_AUTH_TOKEN;
  }
  return getClerkToken();
}

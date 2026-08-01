/**
 * Fixed token accepted only when `DEV_AUTH_BYPASS` is on and NODE_ENV is not
 * production. Lives in shared so the client and server can never disagree about
 * its value — they previously each declared their own copy.
 */
export const DEV_AUTH_TOKEN = "dev-local-token";

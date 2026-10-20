/**
 * The apps origin is where app bundles are served (a separate registrable
 * domain, PLAN D4). The API tells the client in `GET /api/apps/config`
 * (`origin`, null while `APPS_ORIGIN` is unset). This is the one place the
 * client decides whether to believe that string.
 */

/** An https origin, or http on localhost for the dev server. Anything else is not an apps origin. */
export function parseAppsOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol === "https:" || (url.protocol === "http:" && local)) return url.origin;
  } catch {
    // fall through
  }
  return null;
}

/** Whether `url` is served by `origin` (an entry or asset URL must be, or the host refuses to frame it). */
export function isOnAppsOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

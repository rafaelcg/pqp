/**
 * Addresses of a public jam: where it lives in the app, and where it lives on
 * the open web (jam.pqp.gg, `docs/JAM_SITE.md`).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PublicJamRoute = { kind: "song"; songId: string } | { kind: "new" };

/** `/app/jam/<songId>`: a public jam opened inside the app, with no channel. `/app/jam/new` starts one. */
export function parsePublicJamPath(pathname: string): PublicJamRoute | null {
  const match = /^\/app\/jam\/([^/]+)\/?$/.exec(pathname);
  if (!match) {
    return null;
  }
  const raw = decodeURIComponent(match[1]!).toLowerCase();
  if (raw === "new") {
    return { kind: "new" };
  }
  return UUID.test(raw) ? { kind: "song", songId: raw } : null;
}

export function publicJamAppPath(songId: string): string {
  return `/app/jam/${songId}`;
}

export const NEW_PUBLIC_JAM_PATH = "/app/jam/new";

interface Where {
  protocol: string;
  hostname: string;
  host: string;
}

function hostedOnPqp(hostname: string): boolean {
  return hostname === "pqp.gg" || hostname === "www.pqp.gg";
}

/** The public site's home: `https://jam.pqp.gg/` on the hosted instance, `/jam` anywhere else. */
export function jamSiteHomeUrl(where: Where = window.location): string {
  return hostedOnPqp(where.hostname) ? "https://jam.pqp.gg/" : `${where.protocol}//${where.host}/jam`;
}

/** The address anybody can open a public jam at. */
export function publicJamShareUrl(songId: string, where: Where = window.location): string {
  return hostedOnPqp(where.hostname)
    ? `https://jam.pqp.gg/m/${songId}`
    : `${where.protocol}//${where.host}/jam/m/${songId}`;
}

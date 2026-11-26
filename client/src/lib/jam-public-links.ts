/**
 * Addresses of a public jam: where it lives in the app, and where it lives on
 * the open web (jam.pqp.gg, `docs/JAM_SITE.md`).
 */

import { withSignedParam } from "./jam-signed-in";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PublicJamRoute = { kind: "song"; songId: string } | { kind: "new" };

/** `/app/jam/<songId>`: a public jam opened inside the app, with no channel. `/app/jam/new` starts one. */
export function parsePublicJamPath(pathname: string): PublicJamRoute | null {
  const match = /^\/app\/jam\/([^/]+)\/?$/.exec(pathname);
  if (!match) {
    return null;
  }
  let raw: string;
  try {
    raw = decodeURIComponent(match[1]!).toLowerCase();
  } catch {
    return null;
  }
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
function jamSiteBase(where: Where): string {
  return hostedOnPqp(where.hostname) ? "https://jam.pqp.gg/" : `${where.protocol}//${where.host}/jam`;
}

/**
 * The public site's home, for a link or a redirect FROM the app. Everybody who
 * is in the app is signed in, so the address says so (`signed=1`, a harmless
 * hint: `lib/jam-signed-in.ts`) and the site does not ask them for an account
 * again; and on the hosted instance, where the two origins share no storage, it
 * carries the language the app is speaking (`lang`) so the site does not flip to
 * the browser's. Same-origin mounts share the saved choice already.
 */
export function jamSiteHomeUrl(where: Where = window.location, lang: string | null = null): string {
  const hosted = hostedOnPqp(where.hostname);
  const href = withSignedParam(jamSiteBase(where));
  return hosted && lang ? `${href}&lang=${encodeURIComponent(lang)}` : href;
}

/** The address anybody can open a public jam at. */
export function publicJamShareUrl(songId: string, where: Where = window.location): string {
  return hostedOnPqp(where.hostname)
    ? `https://jam.pqp.gg/m/${songId}`
    : `${where.protocol}//${where.host}/jam/m/${songId}`;
}

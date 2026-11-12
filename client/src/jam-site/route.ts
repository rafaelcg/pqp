/**
 * Where the public jam site lives, as arithmetic. No React, no window: the
 * entry, the links and the tests all ask this file.
 *
 * TWO MOUNTS, ONE SITE.
 *   host   `jam.pqp.gg` (any hostname that starts with `jam.`): `/` is the
 *          home and `/m/<songId>` a song.
 *   path   `/jam` and `/jam/m/<songId>` on any other host (pqp.gg, a Pages
 *          preview, localhost), so the site works before the hostname exists.
 *
 * A link is always built for the mount the visitor is on, so nobody is moved
 * between the two by clicking around.
 */

export type JamView =
  | { kind: "home" }
  | { kind: "song"; songId: string }
  | { kind: "unknown" };

export type JamMount = "host" | "path";

export interface JamLocation {
  mount: JamMount;
  view: JamView;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isJamSongId(value: string): boolean {
  return UUID.test(value);
}

/** `jam.pqp.gg`, `jam.staging.pqp.gg`, `jam.localhost`. */
export function isJamHostname(hostname: string): boolean {
  return /^jam\./i.test(hostname);
}

function viewFor(rest: string): JamView {
  const path = rest.length > 1 ? rest.replace(/\/+$/, "") : rest;
  if (path === "" || path === "/") {
    return { kind: "home" };
  }
  const song = path.match(/^\/m\/([^/]+)$/);
  if (song && isJamSongId(song[1]!)) {
    return { kind: "song", songId: song[1]!.toLowerCase() };
  }
  return { kind: "unknown" };
}

/** Null when this address is not the jam site at all. */
export function parseJamLocation(where: {
  hostname: string;
  pathname: string;
}): JamLocation | null {
  if (isJamHostname(where.hostname)) {
    return { mount: "host", view: viewFor(where.pathname) };
  }
  const match = where.pathname.match(/^\/jam(\/.*)?$/);
  if (match) {
    return { mount: "path", view: viewFor(match[1] ?? "/") };
  }
  return null;
}

/** The path (no origin) of a view inside a mount. */
export function jamPath(mount: JamMount, view: JamView): string {
  const base = mount === "host" ? "" : "/jam";
  if (view.kind === "song") {
    return `${base}/m/${view.songId}`;
  }
  return mount === "host" ? "/" : "/jam";
}

/**
 * The origin of the main site (the app lives there). On `jam.pqp.gg` it is
 * `https://pqp.gg`; on any other host the same origin, so it is relative.
 */
export function mainSiteOrigin(where: {
  protocol: string;
  hostname: string;
  port: string;
}): string {
  if (!isJamHostname(where.hostname)) {
    return "";
  }
  const host = where.hostname.replace(/^jam\./i, "");
  return `${where.protocol}//${host}${where.port ? `:${where.port}` : ""}`;
}

/** The canonical address of a view on the hosted site. */
export function jamCanonicalUrl(view: JamView): string {
  const origin = "https://jam.pqp.gg";
  return view.kind === "song" ? `${origin}/m/${view.songId}` : `${origin}/`;
}

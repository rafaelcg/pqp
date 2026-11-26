/**
 * "This browser is signed in to pqp", as a hint the public jam site can read.
 *
 * WHY. The public site (`jam.pqp.gg`, `docs/JAM_SITE.md`) loads no auth, so it
 * could not tell a person who had just signed up, or a member who clicked "Ver
 * todas no site", from a stranger: the header said "Entrar" and every record
 * button asked for an account again (finding N4 of the launch user test, round
 * 2). The app KNOWS, so it writes the fact down where the site can read it.
 *
 * WHAT IT IS NOT. It grants nothing and proves nothing. It is a boolean and the
 * first word of the display name, to draw a header ("Rafa" or an initial instead
 * of "Entrar"). Every call the site hands over still lands in the app, which
 * authorises it with the real session. A hint that is wrong (a copied cookie, a
 * sign-out in another browser) costs one click that ends on the app's own sign-in.
 * Never a token, an id, an email or an avatar address (those carry an id).
 *
 * THREE CARRIERS, because the site and the app are not always one origin:
 *
 *  - a cookie scoped to `.pqp.gg`, which is the only thing `jam.pqp.gg` and
 *    `pqp.gg` share (their `localStorage` is not). `Secure`, `SameSite=Lax`, not
 *    `HttpOnly` (the site reads it from script; it holds nothing secret).
 *  - `localStorage` on the app's own origin, which is the site's too on every
 *    same-origin mount (`/jam` on pqp.gg, a preview, localhost).
 *  - `?signed=1` on the links the app hands to the site (`jamSiteHomeUrl`): the
 *    site writes it down for the visit in `sessionStorage` and takes it off the
 *    address. It covers a browser that refuses the cookie.
 *
 * Written by the app whenever an account is ready (every boot renews it) and
 * removed when the session ends. Thirty days at most, so a stale one cannot
 * outlive a browser nobody opens.
 */

export interface JamSignedIn {
  /** First word of the display name, for the header; null when there is none. */
  name: string | null;
}

export const JAM_SIGNED_IN_COOKIE = "pqp_jam_in";
export const JAM_SIGNED_IN_KEY = "pqp:jam-signed-in";
export const JAM_SIGNED_IN_PARAM = "signed";
export const JAM_SIGNED_IN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NAME_MAX = 20;

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The part of a display name the header shows: its first word, without control characters, cut short. */
export function hintName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const word = raw.replace(/[\p{Cc}\p{Cf}]+/gu, "").trim().split(/\s+/u)[0] ?? "";
  const cut = Array.from(word).slice(0, NAME_MAX).join("");
  return cut === "" ? null : cut;
}

/** `1` or `1.<name>`: the value both the cookie and the stored record carry. */
export function encodeHint(name: string | null): string {
  const clean = hintName(name);
  return clean ? `1.${encodeURIComponent(clean)}` : "1";
}

export function decodeHint(value: string | null | undefined): JamSignedIn | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^1(?:\.(.*))?$/su.exec(value);
  if (!match) {
    return null;
  }
  if (match[1] === undefined) {
    return { name: null };
  }
  try {
    return { name: hintName(decodeURIComponent(match[1])) };
  } catch {
    return { name: null };
  }
}

// ----------------------------------------------------------------- the cookie

/** `.pqp.gg` for the hosted instance (where the site and the app are two origins), else null: a host-only cookie. */
export function hintCookieDomain(hostname: string): string | null {
  const host = hostname.toLowerCase();
  return host === "pqp.gg" || host.endsWith(".pqp.gg") ? ".pqp.gg" : null;
}

function cookieAttributes(hostname: string, secure: boolean, maxAgeSeconds: number): string {
  const domain = hintCookieDomain(hostname);
  return `Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${domain ? `; Domain=${domain}` : ""}${secure ? "; Secure" : ""}`;
}

/** The `document.cookie` assignment that records the hint. */
export function hintCookie(name: string | null, hostname: string, secure: boolean): string {
  return `${JAM_SIGNED_IN_COOKIE}=${encodeHint(name)}; ${cookieAttributes(hostname, secure, Math.floor(JAM_SIGNED_IN_TTL_MS / 1000))}`;
}

/** The one that removes it. */
export function clearedHintCookie(hostname: string, secure: boolean): string {
  return `${JAM_SIGNED_IN_COOKIE}=; ${cookieAttributes(hostname, secure, 0)}`;
}

/** The hint in a `document.cookie` string, if there is one. */
export function hintFromCookieHeader(header: string | null | undefined): JamSignedIn | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === JAM_SIGNED_IN_COOKIE) {
      return decodeHint(part.slice(at + 1).trim());
    }
  }
  return null;
}

// ------------------------------------------------------------ the stored copy

export function readStoredHint(storage: ReadableStorage | null, now: number = Date.now()): JamSignedIn | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(JAM_SIGNED_IN_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const { value, at } = parsed as { value?: unknown; at?: unknown };
    if (typeof value !== "string" || typeof at !== "number" || now - at > JAM_SIGNED_IN_TTL_MS || at > now + 60_000) {
      return null;
    }
    return decodeHint(value);
  } catch {
    // User-writable storage: anything unreadable is "not signed in".
    return null;
  }
}

export function writeStoredHint(storage: WritableStorage | null, name: string | null, now: number = Date.now()): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(JAM_SIGNED_IN_KEY, JSON.stringify({ value: encodeHint(name), at: now }));
  } catch {
    // Storage denied: the cookie and the link parameter still carry it.
  }
}

export function clearStoredHint(storage: WritableStorage | null): void {
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(JAM_SIGNED_IN_KEY);
  } catch {
    // Nothing to do.
  }
}

// ---------------------------------------------------------------- the address

/** Does this query string say the app handed the visitor over signed in? */
export function signedParamIn(search: string): boolean {
  return new URLSearchParams(search).get(JAM_SIGNED_IN_PARAM) === "1";
}

/** The same address with the marker taken off (the rest of the query and the hash untouched). */
export function withoutSignedParam(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(JAM_SIGNED_IN_PARAM);
  return url.toString();
}

/** A link from the app to the site that says the visitor is signed in (a harmless `signed=1`). */
export function withSignedParam(href: string): string {
  const hash = href.indexOf("#");
  const base = hash === -1 ? href : href.slice(0, hash);
  const tail = hash === -1 ? "" : href.slice(hash);
  return `${base}${base.includes("?") ? "&" : "?"}${JAM_SIGNED_IN_PARAM}=1${tail}`;
}

// ------------------------------------------------------------ the browser half

function local(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function session(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The app, with an account ready: say so, for the site (every call renews the thirty days). */
export function rememberSignedIn(displayName: string | null | undefined): void {
  if (typeof window === "undefined") {
    return;
  }
  const name = hintName(displayName);
  writeStoredHint(local(), name);
  try {
    document.cookie = hintCookie(name, window.location.hostname, window.location.protocol === "https:");
  } catch {
    // Cookies denied: the stored copy and the link parameter remain.
  }
}

/** The session ended (sign-out, or Clerk found nobody): take the hint away everywhere it was written. */
export function forgetSignedIn(): void {
  if (typeof window === "undefined") {
    return;
  }
  clearStoredHint(local());
  clearStoredHint(session());
  try {
    document.cookie = clearedHintCookie(window.location.hostname, window.location.protocol === "https:");
  } catch {
    // Nothing to do.
  }
}

/** What the site knows now: the cookie, else the app's stored copy (same origin), else this visit's parameter. */
export function readSignedIn(): JamSignedIn | null {
  if (typeof window === "undefined") {
    return null;
  }
  let cookie: string | null = null;
  try {
    cookie = document.cookie;
  } catch {
    cookie = null;
  }
  return hintFromCookieHeader(cookie) ?? readStoredHint(local()) ?? readStoredHint(session());
}

/** The site, at boot: the app handed the visitor over with `?signed=1`. Written down for the visit (this tab) only. */
export function adoptSignedParam(): void {
  if (typeof window === "undefined" || !signedParamIn(window.location.search)) {
    return;
  }
  const known = readSignedIn();
  writeStoredHint(session(), known?.name ?? null);
  try {
    window.history.replaceState(window.history.state, "", withoutSignedParam(window.location.href));
  } catch {
    // The marker just stays on the address; nothing breaks.
  }
}

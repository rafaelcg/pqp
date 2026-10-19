import { APP_AVATAR_MAX_CHARS } from "@pqp/shared";
import { discardBody, readLimited } from "./limited-body";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const FETCH_TIMEOUT_MS = 4000;
/** The shortest prefix is `data:image/gif;base64,` (22 characters); the longest type is `image/jpeg`. */
const LONGEST_PREFIX = "data:image/jpeg;base64,".length;
/** Bytes whose base64 form, with the longest prefix, still fits the data URL cap. */
const MAX_AVATAR_BYTES = Math.floor(((APP_AVATAR_MAX_CHARS - LONGEST_PREFIX) / 4) * 3);

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Where an avatar may finally come from after a redirect. The first hop was
 * checked against the allow list; a redirect from there (`/api/avatars/:id`
 * answers 302 to the storage URL) is our own server's choice, and the final
 * answer must be https, or the very origin that was asked, and never a literal
 * address (loopback, private ranges, IPv6) or `localhost` for a page that is not.
 */
export function acceptableFinalUrl(finalUrl: string, requestedUrl: string): boolean {
  try {
    const final = new URL(finalUrl);
    const requested = new URL(requestedUrl);
    if (final.origin === requested.origin) return true;
    if (final.protocol !== "https:") return false;
    const host = final.hostname;
    if (host === "localhost" || host.endsWith(".localhost") || host.includes(":")) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Is this URL pqp's own avatar route, `/api/avatars/<user>` ON THE API's ORIGIN?
 * That is the only URL whose redirect is followed: the API answers 302 to the
 * uploaded object in our own bucket, and the path names a user, never a
 * destination, so where it sends the browser is the server's choice
 * (`serveAvatarObject` in the API). The same path on any other origin (the
 * page's, say) is just a URL somebody typed. No `apiOrigin`, no exception.
 */
export function isAvatarRoute(url: string, apiOrigin: string | null | undefined): boolean {
  if (!apiOrigin) return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === apiOrigin && /^\/api\/avatars\/[^/]+$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Fetches a user's avatar from the page and returns it as a data URL, so the
 * app never gets a link it could load or track. Anything that is not a small
 * png, jpeg, webp or gif (an SVG, a redirect to an error page, a 404, a
 * timeout, a body past the cap) is `null`: the app draws its own fallback. The
 * body is read with a byte limit, never buffered whole first, and a body that is
 * refused is cancelled, not left open. The result is at most
 * `APP_AVATAR_MAX_CHARS` characters, which is what the bridge allows.
 *
 * Redirects: a browser follows one before the page can look at it, so checking
 * the final URL afterwards cannot stop the request. A URL somebody typed (any
 * path on an allowed origin) is therefore fetched with `redirect: "error"` and
 * cannot bounce the browser anywhere; only pqp's own avatar route on the API's
 * origin (`isAvatarRoute`) follows its redirect, and the final URL is checked
 * as well.
 */
export async function fetchAvatarDataUrl(
  url: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  options: { apiOrigin?: string | null } = {},
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const followRedirect = isAvatarRoute(url, options.apiOrigin);
  try {
    const response = await fetchImpl(url, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: followRedirect ? "follow" : "error",
      signal: controller.signal,
    });
    const refuse = () => {
      discardBody(response);
      return null;
    };
    if (!response.ok) return refuse();
    if (response.redirected && (!followRedirect || !acceptableFinalUrl(response.url, url))) return refuse();
    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) return refuse();
    const bytes = await readLimited(response, MAX_AVATAR_BYTES);
    if (!bytes) return null;
    const dataUrl = `data:${type};base64,${toBase64(bytes)}`;
    return dataUrl.length <= APP_AVATAR_MAX_CHARS ? dataUrl : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Most distinct avatar URLs held at once: a roster is at most 264 people, so this is about one roster. */
const CACHE_LIMIT = 300;

/**
 * One fetch per URL while it is among the most recent `CACHE_LIMIT`; a failure
 * is cached too, so a broken avatar is not retried on every roster push. The
 * oldest entries are dropped, so people who came and went do not pile up in
 * memory for the life of the host.
 *
 * `allowedOrigins` is who an avatar URL may point at (the page itself and the
 * API). A user can set their avatar URL to anything, and the host must not
 * become a way to make somebody's browser call an address a stranger chose, so
 * a URL outside the list is `null` without a request. Only the avatar route on
 * `apiOrigin` follows its redirect (`/api/avatars/:id` answers 302 to the
 * storage URL, which is our own server's choice); any other URL on an allowed
 * origin may not redirect at all (`fetchAvatarDataUrl`). What finally arrives
 * must still be a small image.
 */
export class AvatarCache {
  private readonly cache = new Map<string, Promise<string | null>>();

  constructor(
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly allowedOrigins: readonly string[] = [],
    private readonly apiOrigin: string | null = null,
  ) {}

  private allowed(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
      return this.allowedOrigins.includes(parsed.origin);
    } catch {
      return false;
    }
  }

  get(url: string | null): Promise<string | null> {
    if (url === null || !this.allowed(url)) return Promise.resolve(null);
    let hit = this.cache.get(url);
    if (hit) {
      // most recently used goes last
      this.cache.delete(url);
    } else {
      hit = fetchAvatarDataUrl(url, this.fetchImpl, { apiOrigin: this.apiOrigin });
    }
    this.cache.set(url, hit);
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return hit;
  }
}

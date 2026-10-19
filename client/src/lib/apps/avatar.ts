import { APP_AVATAR_MAX_CHARS } from "@pqp/shared";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const FETCH_TIMEOUT_MS = 4000;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Fetches a user's avatar from the page and returns it as a data URL, so the
 * app never gets a link it could load or track. Anything that is not a small
 * png, jpeg, webp or gif (an SVG, a redirect to an error page, a 404, a
 * timeout) is `null`: the app draws its own fallback. The result is at most
 * `APP_AVATAR_MAX_CHARS` characters, which is what the bridge schema allows.
 */
export async function fetchAvatarDataUrl(
  url: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const prefix = `data:${type};base64,`;
    // 4 characters of base64 per 3 bytes: refuse before encoding what cannot fit
    if (prefix.length + Math.ceil(bytes.length / 3) * 4 > APP_AVATAR_MAX_CHARS) return null;
    return prefix + toBase64(bytes);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** One fetch per URL for the life of the host; a failure is cached too, so a broken avatar is not retried on every roster push. */
export class AvatarCache {
  private readonly cache = new Map<string, Promise<string | null>>();

  constructor(private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)) {}

  get(url: string | null): Promise<string | null> {
    if (url === null) return Promise.resolve(null);
    let hit = this.cache.get(url);
    if (!hit) {
      hit = fetchAvatarDataUrl(url, this.fetchImpl);
      this.cache.set(url, hit);
    }
    return hit;
  }
}

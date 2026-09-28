/**
 * Public Google Play listing URL for the Android app.
 *
 * The app went live on Google Play (`gg.pqp.app`, verified 2026-09-28), so
 * this now has a code default, same shape as `android-apk.ts`'s GitHub
 * fallback: empty keeps the default, a whitespace-only override hides the
 * button entirely (the same trick `VITE_ANDROID_APK_URL` uses), and any
 * other value replaces it outright. A self-host that never sets
 * `VITE_PLAY_STORE_URL` still links to OUR listing by default, exactly as
 * an unset `VITE_ANDROID_APK_URL` links to our GitHub release; either one
 * can be pointed at a self-host's own listing or hidden with a single space.
 *
 * `/android` and the other download surfaces read this to decide whether
 * Google Play is the primary action. With it set (now the default), the
 * Play badge leads and the APK becomes a small secondary "ou baixa o APK"
 * link. See `docs/ANDROID_RELEASE.md` §4b.
 */
export const PLAY_STORE_PACKAGE_ID = "gg.pqp.app";

export const PLAY_STORE_LISTING_URL = `https://play.google.com/store/apps/details?id=${PLAY_STORE_PACKAGE_ID}`;

export function playStoreUrlFrom(raw: unknown): string | null {
  if (typeof raw !== "string") return PLAY_STORE_LISTING_URL;
  if (raw.length > 0 && raw.trim() === "") return null;
  return raw.trim() || PLAY_STORE_LISTING_URL;
}

export function playStoreUrl(): string | null {
  return playStoreUrlFrom(import.meta.env.VITE_PLAY_STORE_URL);
}

/**
 * Play's own `hl` query param picks the listing (and badge) language.
 * `es-419` matches `intlLocale()` in `lib/locale.ts`: our one Spanish
 * catalogue reads as Latin American Spanish, not European.
 */
const PLAY_STORE_HL: Record<string, string> = {
  en: "en",
  "pt-BR": "pt-BR",
  es: "es-419",
};

/**
 * Appends `hl=<locale>` to a Play Store URL, replacing any `hl` the URL
 * already carries. Falls back to the URL unchanged if it cannot be parsed
 * (an override that is not a real URL is the caller's problem, not ours).
 */
export function playStoreUrlWithLocale(url: string, locale: string): string {
  const hl = PLAY_STORE_HL[locale];
  if (!hl) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("hl", hl);
    return parsed.toString();
  } catch {
    return url;
  }
}

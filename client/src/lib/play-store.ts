/**
 * Public Google Play listing URL for the Android app.
 *
 * Hosted-only, same rule as the sponsor/donation links and the Android APK
 * click beacon: the default is off, so a self-hosted build never links to
 * our listing. Unlike `android-apk.ts`, there is no code default here — the
 * Play listing does not exist until Rafael sets this, so an unset value
 * means "no Play link yet", not "use a fallback".
 *
 * `/android` reads this to decide which button is primary: set, the Play
 * button leads and the APK becomes a secondary "or download the APK" link;
 * unset, the page behaves exactly as it did before this existed (APK only).
 * See `docs/ANDROID_RELEASE.md`.
 */
export function playStoreUrlFrom(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return raw.trim() || null;
}

export function playStoreUrl(): string | null {
  return playStoreUrlFrom(import.meta.env.VITE_PLAY_STORE_URL);
}

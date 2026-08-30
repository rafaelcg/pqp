/**
 * Public URL of the Android beta APK.
 *
 * Not `/releases/latest/download/…`. `latest` is the Electron version tag
 * (`v0.1.0` and friends); pointing the APK there would either 404 or steal
 * "latest" from the desktop updater. CI publishes a rolling prerelease on
 * the stable tag `android-beta` as exactly `pqp.apk`, from the `sideload`
 * variant (prod API, debug-signed — not the Play upload key). Runbook:
 * `docs/ANDROID_RELEASE.md` §4b.
 *
 * `VITE_ANDROID_APK_URL` overrides it at build time (R2, a different
 * asset name, or a single space to hide the button).
 */
export const ANDROID_APK_ASSET_NAME = "pqp.apk";

export const ANDROID_APK_RELEASE_TAG = "android-beta";

export const ANDROID_APK_DOWNLOAD_URL =
  `https://github.com/rafaelcg/pqp/releases/download/${ANDROID_APK_RELEASE_TAG}/${ANDROID_APK_ASSET_NAME}`;

/**
 * Empty / unset keeps the GitHub default. A whitespace-only value (the
 * TestFlight trick: set the env to a single space) hides the CTA.
 */
export function androidApkUrlFrom(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return ANDROID_APK_DOWNLOAD_URL;
  }
  if (raw.length > 0 && raw.trim() === "") {
    return null;
  }
  return raw.trim() || ANDROID_APK_DOWNLOAD_URL;
}

export function androidApkUrl(): string | null {
  return androidApkUrlFrom(import.meta.env.VITE_ANDROID_APK_URL);
}

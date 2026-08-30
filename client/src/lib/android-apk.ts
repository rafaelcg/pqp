/**
 * Public URL of the Android beta APK.
 *
 * GitHub `releases/latest/download/<name>` only works if the filename is
 * stable. Desktop artifacts are not (`pqp-0.1.0-x64.exe` dies on the next
 * tag — see `downloads.ts`). The APK is: attach it to the latest GitHub
 * Release as exactly `pqp.apk`. That is the whole reason this default can
 * live in the source the way the TestFlight URL does.
 *
 * `VITE_ANDROID_APK_URL` overrides it at build time (R2, a different
 * asset name, or a single space to hide the button). Runbook:
 * `docs/ANDROID_RELEASE.md` §4b.
 */
export const ANDROID_APK_ASSET_NAME = "pqp.apk";

export const ANDROID_APK_DOWNLOAD_URL =
  `https://github.com/rafaelcg/pqp/releases/latest/download/${ANDROID_APK_ASSET_NAME}`;

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

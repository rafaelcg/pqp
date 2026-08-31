/**
 * Operator-side count of taps on the Android APK download button.
 *
 * Hosted-only, same rule as Umami and Google Ads: the default is off, so a
 * self-hosted build never pings our Worker. The pqp.gg Pages workflow sets
 * `VITE_ANDROID_APK_CLICK_URL` to the public `POST /apk-click` on pqp-admin.
 * A whitespace-only value also hides it.
 *
 * The beacon carries no identity. The Worker rate-limits by IP and stores a
 * counter. See tools/admin-dashboard/README.md.
 */

export function androidApkClickUrlFrom(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length > 0 && raw.trim() === "") return null;
  return raw.trim() || null;
}

export function androidApkClickUrl(): string | null {
  return androidApkClickUrlFrom(import.meta.env.VITE_ANDROID_APK_CLICK_URL);
}

function defaultSend(url: string): boolean {
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    return navigator.sendBeacon(url, new Blob(["1"], { type: "text/plain" }));
  }
  if (typeof fetch === "function") {
    void fetch(url, { method: "POST", body: "1", keepalive: true, mode: "no-cors" }).catch(
      () => undefined,
    );
    return true;
  }
  return false;
}

/**
 * Fire-and-forget. Never throws, never waits, never blocks the download.
 * Returns whether a send was attempted.
 */
export function recordAndroidApkClick(
  send: (url: string) => boolean = defaultSend,
  raw: unknown = import.meta.env.VITE_ANDROID_APK_CLICK_URL,
): boolean {
  const url = androidApkClickUrlFrom(raw);
  if (!url) return false;
  try {
    return send(url);
  } catch {
    return false;
  }
}

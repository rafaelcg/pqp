/**
 * What a WebSocket's `User-Agent` says about the app behind it, reduced to
 * the few families support needs to debug "I can't hear" / "my share has no
 * sound" and nothing more.
 *
 * WHY THIS IS NOT A UA STRING IN A COLUMN
 * A raw user agent is a fingerprint: version numbers to the patch level, OS
 * builds, device models. What a support conversation needs is far coarser:
 * which of our four apps, and for the browser case which engine on which OS.
 * So the parse happens at the door, the string is dropped, and only the
 * families below ever reach a row. The one version kept is OUR app's own, for
 * the desktop shell and iOS (see `parseClientAgent`).
 *
 * Pure: no I/O, no clock, tested in `client-agent.test.ts`.
 */

export const CLIENT_PLATFORMS = ["web", "desktop", "ios", "android", "unknown"] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];

export const CLIENT_OS_FAMILIES = [
  "windows",
  "macos",
  "linux",
  "ios",
  "android",
  "chromeos",
  "other",
] as const;
export type ClientOsFamily = (typeof CLIENT_OS_FAMILIES)[number];

export const CLIENT_BROWSER_FAMILIES = [
  "chrome",
  "edge",
  "firefox",
  "safari",
  "opera",
  "samsung",
  "electron",
  "other",
] as const;
export type ClientBrowserFamily = (typeof CLIENT_BROWSER_FAMILIES)[number];

export interface ClientFacts {
  platform: ClientPlatform;
  /** OUR app's version, when the client said it. Null otherwise. */
  appVersion: string | null;
  osFamily: ClientOsFamily | null;
  /** A browser's family (Electron counts as one). Null for the native apps. */
  browserFamily: ClientBrowserFamily | null;
}

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/;

/** A version we are willing to store: short, plain, no spaces or slashes. */
export function sanitizeAppVersion(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim();
  return VERSION_PATTERN.test(value) ? value : null;
}

function osFamilyOf(ua: string): ClientOsFamily | null {
  // Order matters: an iPhone's UA says "like Mac OS X", an Android's says
  // "Linux", and a Chromebook's says both "X11" and "CrOS".
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/CrOS/.test(ua)) return "chromeos";
  if (/Windows/.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/.test(ua)) return "macos";
  if (/Linux|X11/.test(ua)) return "linux";
  return null;
}

function browserFamilyOf(ua: string): ClientBrowserFamily {
  // Chromium derivatives all say "Chrome/", and Safari-on-iOS wrappers say
  // "Safari/", so the specific tokens go first.
  if (/Electron\//.test(ua)) return "electron";
  if (/Edg(e|A|iOS)?\//.test(ua)) return "edge";
  if (/OPR\/|Opera/.test(ua)) return "opera";
  if (/SamsungBrowser\//.test(ua)) return "samsung";
  if (/Firefox\/|FxiOS\//.test(ua)) return "firefox";
  if (/Chrome\/|CriOS\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "other";
}

/**
 * Parse a `User-Agent`.
 *
 *  - Electron shell: Chromium's UA with `Electron/x` and, from the default,
 *    our own `pqp/<version>` token. `appVersion` is that token's version.
 *  - Android app: OkHttp sets `okhttp/<library version>` and the app does not
 *    override it, so the platform is known and OUR version is NOT. The
 *    library's version is deliberately not stored in its place: it would read
 *    as an app version and mislead.
 *  - iOS app: `URLSessionWebSocketTask` sends `<executable>/<CFBundleVersion>
 *    CFNetwork/x Darwin/y`, with no `Mozilla`. That version is the build
 *    number, not the marketing version.
 *  - Anything with `Mozilla/` is a browser: platform `web`.
 *  - No UA, or one we do not know (a script, a bot): `unknown`.
 */
export function parseClientAgent(rawUserAgent: string | null | undefined): ClientFacts {
  const ua = (rawUserAgent ?? "").slice(0, 512);
  const unknown: ClientFacts = {
    platform: "unknown",
    appVersion: null,
    osFamily: null,
    browserFamily: null,
  };
  if (ua === "") {
    return unknown;
  }

  if (/Electron\//.test(ua)) {
    const ours = /(?:^|\s)(?:@pqp\/electron|pqp)\/(\d[0-9A-Za-z.+_-]*)/i.exec(ua);
    return {
      platform: "desktop",
      appVersion: sanitizeAppVersion(ours?.[1]),
      osFamily: osFamilyOf(ua),
      browserFamily: "electron",
    };
  }

  if (/^okhttp\//i.test(ua)) {
    return { platform: "android", appVersion: null, osFamily: "android", browserFamily: null };
  }

  if (!/Mozilla\//.test(ua) && /CFNetwork\//.test(ua) && /Darwin\//.test(ua)) {
    const first = /^([A-Za-z0-9_.-]+)\/(\d[0-9A-Za-z.+_-]*)/.exec(ua);
    return {
      platform: "ios",
      appVersion: first && /^pqp/i.test(first[1]!) ? sanitizeAppVersion(first[2]) : null,
      osFamily: "ios",
      browserFamily: null,
    };
  }

  if (/Mozilla\//.test(ua)) {
    return {
      platform: "web",
      appVersion: null,
      osFamily: osFamilyOf(ua) ?? "other",
      browserFamily: browserFamilyOf(ua),
    };
  }

  return unknown;
}

/**
 * What a client may say about itself on the `auth` frame, hand-parsed like
 * `caps` (a junk field must never cost a socket its connection). Nothing
 * sends this yet; it is the seam that lets an app declare its own
 * `platform` / `version` later with no server release. A declared value wins
 * over the user agent's for the fields it names, and only from the known
 * enum, so a client cannot write an arbitrary string into the table.
 */
export function applyDeclaredClient(parsed: ClientFacts, declared: unknown): ClientFacts {
  if (!declared || typeof declared !== "object") {
    return parsed;
  }
  const { platform, version } = declared as { platform?: unknown; version?: unknown };
  const knownPlatform = CLIENT_PLATFORMS.find(
    (candidate) => candidate !== "unknown" && candidate === platform,
  );
  const declaredVersion = sanitizeAppVersion(version);
  if (!knownPlatform && !declaredVersion) {
    return parsed;
  }
  return {
    ...parsed,
    platform: knownPlatform ?? parsed.platform,
    appVersion: declaredVersion ?? parsed.appVersion,
  };
}

/**
 * Which desktop artifact to offer a visitor, and where that file actually is.
 *
 * WHY THE URLS ARE NOT HARDCODED
 *
 * `https://github.com/OWNER/REPO/releases/latest/download/<name>` only works if
 * `<name>` is stable across releases. Ours is not: electron-builder is
 * configured with `artifactName: "${productName}-${version}-${arch}.${ext}"`
 * (`electron/package.json`), and `docs/DESKTOP.md` §5 makes bumping that
 * version a required step of cutting a release — electron-updater compares
 * against it. So the real assets of run 31186452374 are
 * `pqp-0.0.1-arm64.dmg`, `pqp-0.0.1-x64.dmg`, `pqp-0.0.1-x64.exe`,
 * `pqp-0.0.1-x86_64.AppImage`, `pqp-0.0.1-amd64.deb`, and the next release
 * renames every one of them. A hardcoded filename here is a 404 on release two.
 *
 * So the version is matched, never spelled: every link starts life pointing at
 * the releases page — which is always correct and never needs a redeploy — and
 * is upgraded to a direct asset URL once `resolveLatestAssets()` has matched
 * the patterns below against the real release. Failure of that lookup is
 * invisible: the page renders identically and the link still works, one click
 * longer. Nothing on screen depends on the response, so there is no spinner, no
 * layout shift, and no version number to go stale.
 *
 * The lookup is deliberately NOT fired on page load. api.github.com is
 * unauthenticated (60 requests/hour/IP — a visitor behind CGNAT can be over it
 * through no fault of their own) and this landing page otherwise makes no
 * third-party requests at all. The UI calls this on hover/focus of the download
 * control instead, so a visitor who never reaches for it never touches GitHub.
 */

const REPO = "rafaelcg/pqp";

/** The public repository. Used by the landing hosting column and trust strip. */
export const SOURCE_REPO_URL = `https://github.com/${REPO}`;

/** Always valid, even before the first tag exists on a fresh repo… almost:
 *  GitHub 404s `/releases/latest` while a repo has zero published releases.
 *  These links go live with the first `v*` tag. */
export const RELEASES_PAGE_URL = `https://github.com/${REPO}/releases/latest`;

/** Where the SmartScreen / unsigned-build situation is written down. */
export const DESKTOP_DOCS_URL = `https://github.com/${REPO}/blob/main/docs/DESKTOP.md#4-windows`;

const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

export type Platform = "mac" | "windows" | "linux" | "mobile" | "unknown";
export type MacArch = "arm64" | "x64";

/** One downloadable file. Named by what it is, not by what it is called. */
export type AssetId =
  | "mac-arm64"
  | "mac-x64"
  | "windows"
  | "linux-appimage"
  | "linux-deb";

/**
 * How each artifact's filename looks, with the version left open.
 *
 * Confirmed against the artifacts of Electron run 31186452374 rather than
 * guessed — the Windows `.exe` in particular is one file, not two, because
 * `nsis` and `portable` both resolve to the same `artifactName` and the second
 * overwrites the first.
 */
const ASSET_PATTERNS: Record<AssetId, RegExp> = {
  "mac-arm64": /^pqp-.+-arm64\.dmg$/,
  "mac-x64": /^pqp-.+-x64\.dmg$/,
  windows: /^pqp-.+-x64\.exe$/,
  "linux-appimage": /^pqp-.+-x86_64\.AppImage$/i,
  "linux-deb": /^pqp-.+-amd64\.deb$/,
};

export type AssetUrls = Partial<Record<AssetId, string>>;

// ---------------------------------------------------------------- detection

interface HighEntropyValues {
  architecture?: string;
  bitness?: string;
}

export interface NavigatorUAData {
  platform?: string;
  mobile?: boolean;
  getHighEntropyValues?: (hints: string[]) => Promise<HighEntropyValues>;
}

/** Just the bits of `navigator` this file reads, so it can be tested. */
export interface PlatformSignals {
  userAgent?: string;
  maxTouchPoints?: number;
  userAgentData?: NavigatorUAData;
}

export interface DownloadPlan {
  platform: Platform;
  /**
   * `null` means "this is a Mac and we could not tell which chip" — Safari and
   * Firefox ship no `navigator.userAgentData` at all, and every browser reports
   * "Intel Mac OS X" in the UA string on Apple Silicon. The UI offers both
   * builds in that case; it does not guess, because handing an Intel binary to
   * an M-series Mac (or the reverse) is a broken first run.
   */
  macArch: MacArch | null;
}

export function readPlatformSignals(): PlatformSignals {
  if (typeof navigator === "undefined") {
    return {};
  }
  return {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    userAgentData: (navigator as Navigator & { userAgentData?: NavigatorUAData })
      .userAgentData,
  };
}

/**
 * Which OS family, in the order the checks have to happen.
 *
 * Order is the whole trick. Android's UA says `Linux`, so Android has to be
 * ruled out before Linux. iPadOS 13+ reports a desktop Safari UA that says
 * `Macintosh` and is indistinguishable from a MacBook except by
 * `maxTouchPoints`, so touch has to be ruled out before Mac. No Mac has a
 * touchscreen, which is what makes that test safe.
 */
export function detectPlatform(signals: PlatformSignals): Platform {
  const ua = signals.userAgent ?? "";
  const uaData = signals.userAgentData;

  if (uaData?.mobile === true) {
    return "mobile";
  }
  if (/iPhone|iPad|iPod|Android|Mobile Safari|Windows Phone/i.test(ua)) {
    return "mobile";
  }
  // iPadOS pretending to be a Mac.
  if (/Macintosh/i.test(ua) && (signals.maxTouchPoints ?? 0) > 1) {
    return "mobile";
  }

  // `userAgentData.platform` is the browser's own answer and beats sniffing.
  switch (uaData?.platform) {
    case "macOS":
      return "mac";
    case "Windows":
      return "windows";
    case "Linux":
      return "linux";
    case "Android":
      return "mobile";
    case "Chrome OS":
    case "Chromium OS":
      // Crostini can install a .deb, but most Chromebooks cannot and the ones
      // that can are not the default experience. The web app is the answer.
      return "unknown";
    default:
      break;
  }

  if (/CrOS/.test(ua)) {
    return "unknown";
  }
  if (/Windows|Win32|Win64/i.test(ua)) {
    return "windows";
  }
  if (/Mac OS X|Macintosh/i.test(ua)) {
    return "mac";
  }
  if (/Linux|X11|FreeBSD/i.test(ua)) {
    return "linux";
  }
  return "unknown";
}

/**
 * Apple Silicon or Intel, or `null` when the browser will not say.
 *
 * `getHighEntropyValues(["architecture"])` is the only route that answers this
 * correctly — Chromium reports `arm` / `x86` there. Everything else (the UA
 * string, `navigator.platform`) says "Intel" on every Mac ever made. A WebGL
 * renderer sniff would cover Safari, but Safari reports a generic "Apple GPU"
 * for both chips, so it would produce confident wrong answers. `null` is the
 * honest result and the UI knows what to do with it.
 */
export async function detectMacArch(
  signals: PlatformSignals,
): Promise<MacArch | null> {
  const probe = signals.userAgentData?.getHighEntropyValues;
  if (!probe) {
    return null;
  }
  try {
    const values = await probe.call(signals.userAgentData, ["architecture"]);
    const architecture = values?.architecture?.toLowerCase();
    if (architecture === "arm" || architecture === "arm64") {
      return "arm64";
    }
    if (architecture === "x86" || architecture === "x86_64") {
      return "x64";
    }
    return null;
  } catch {
    // The hint can be refused (permissions policy, a privacy extension). A
    // refusal is "we do not know", which is exactly `null`.
    return null;
  }
}

export async function detectDownloadPlan(
  signals: PlatformSignals = readPlatformSignals(),
): Promise<DownloadPlan> {
  const platform = detectPlatform(signals);
  return {
    platform,
    macArch: platform === "mac" ? await detectMacArch(signals) : null,
  };
}

/**
 * True on an actual iPhone/iPad/iPod. The iOS beta CTA is only useful to these
 * visitors: an Android or desktop user offered a TestFlight link has nothing to
 * do with it. iPadOS 13+ reports its UA as a Mac, so the touch heuristic is what
 * separates a touch Mac (an iPad) from a real desktop.
 */
export function isIOSDevice(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) {
    return true;
  }
  return (
    /Macintosh/.test(ua) &&
    typeof document !== "undefined" &&
    "ontouchend" in document
  );
}

// ------------------------------------------------------------- asset lookup

interface ReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

/**
 * Match the latest release's assets against the patterns above.
 *
 * Never throws and never rejects: an empty object means "link to the releases
 * page", which is what the UI already renders.
 */
export async function fetchLatestAssets(
  fetchImpl: typeof fetch,
): Promise<AssetUrls> {
  try {
    const response = await fetchImpl(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
      // No cookies to GitHub from a marketing page, ever.
      credentials: "omit",
    });
    if (!response.ok) {
      return {};
    }
    const body: unknown = await response.json();
    const assets = (body as { assets?: unknown } | null)?.assets;
    if (!Array.isArray(assets)) {
      return {};
    }
    const found: AssetUrls = {};
    for (const raw of assets as ReleaseAsset[]) {
      const name = typeof raw?.name === "string" ? raw.name : null;
      const url =
        typeof raw?.browser_download_url === "string"
          ? raw.browser_download_url
          : null;
      if (!name || !url) {
        continue;
      }
      for (const [id, pattern] of Object.entries(ASSET_PATTERNS)) {
        if (!found[id as AssetId] && pattern.test(name)) {
          found[id as AssetId] = url;
        }
      }
    }
    return found;
  } catch {
    return {};
  }
}

/**
 * The cached, browser-facing version. One request per page load at most, and
 * a miss is cached too — retrying on every hover would be worse than the extra
 * click a missing URL costs.
 */
let pending: Promise<AssetUrls> | null = null;

export function resolveLatestAssets(): Promise<AssetUrls> {
  if (typeof fetch !== "function") {
    return Promise.resolve({});
  }
  pending ??= fetchLatestAssets(fetch);
  return pending;
}

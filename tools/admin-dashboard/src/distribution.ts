/**
 * Android distribution numbers that do not live on the API.
 *
 * Two different counts, kept separate on purpose:
 *  - **clicks**: the `/android` download button, recorded here in KV. A
 *    click is a click, including people who never finish the install.
 *  - **downloads**: GitHub's `download_count` on the `pqp.apk` asset of the
 *    rolling `android-beta` prerelease. That is the file actually leaving
 *    GitHub, so it is lower than clicks (abandoned) and can be higher
 *    (curl, CI, a retry). The dashboard draws both and says so.
 *
 * Neither is a person. Neither identifies a person.
 */

export const APK_CLICKS_KEY = "state";
export const APK_RATE_PREFIX = "rl:";
/** KV refuses anything under 60s. One click per IP per minute is plenty. */
export const APK_RATE_TTL_SECONDS = 60;
export const GITHUB_CACHE_MS = 5 * 60 * 1000;
export const ANDROID_APK_ASSET_NAME = "pqp.apk";
export const ANDROID_APK_RELEASE_TAG = "android-beta";

export const CLICK_ORIGINS = [
  "https://pqp.gg",
  "https://www.pqp.gg",
  "https://pqp-3yr.pages.dev",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
] as const;

export interface ApkClickState {
  total: number;
  /** São Paulo calendar day the `today` bucket belongs to (`YYYY-MM-DD`). */
  day: string;
  today: number;
  lastAt: string | null;
}

export interface GithubApkDownloads {
  downloads: number;
  tag: string;
  asset: string;
  fetchedAt: string;
}

export interface DistributionBlock {
  apkClicks: number;
  apkClicksToday: number;
  apkClicksLastAt: string | null;
  apkClicksConfigured: boolean;
  apkDownloads: number | null;
  apkDownloadsTag: string;
  apkDownloadsAsset: string;
  apkDownloadsFetchedAt: string | null;
}

export function emptyClicks(): ApkClickState {
  return { total: 0, day: "", today: 0, lastAt: null };
}

/** São Paulo day, the same clock the rest of the dashboard names. */
export function saoPauloDay(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export function bumpClicks(current: ApkClickState, at: Date = new Date()): ApkClickState {
  const day = saoPauloDay(at);
  return {
    total: current.total + 1,
    day,
    today: current.day === day ? current.today + 1 : 1,
    lastAt: at.toISOString(),
  };
}

export function isAllowedClickOrigin(origin: string | null): boolean {
  if (!origin) return true;
  return (CLICK_ORIGINS as readonly string[]).includes(origin);
}

interface GithubRelease {
  tag_name?: string;
  assets?: { name?: string; download_count?: number }[];
}

export function apkDownloadsFromRelease(
  release: GithubRelease,
  assetName = ANDROID_APK_ASSET_NAME,
): number | null {
  const asset = (release.assets ?? []).find((row) => row.name === assetName);
  return typeof asset?.download_count === "number" ? asset.download_count : null;
}

let githubCache: { at: number; value: GithubApkDownloads | null } | null = null;

export function resetGithubCache(): void {
  githubCache = null;
}

export async function fetchGithubApkDownloads(
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubApkDownloads | null> {
  if (githubCache && Date.now() - githubCache.at < GITHUB_CACHE_MS) {
    return githubCache.value;
  }
  const url = `https://api.github.com/repos/${repo}/releases/tags/${ANDROID_APK_RELEASE_TAG}`;
  try {
    const res = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "pqp-admin",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      githubCache = { at: Date.now(), value: null };
      return null;
    }
    const body = (await res.json()) as GithubRelease;
    const downloads = apkDownloadsFromRelease(body);
    const value: GithubApkDownloads | null =
      downloads === null
        ? null
        : {
            downloads,
            tag: ANDROID_APK_RELEASE_TAG,
            asset: ANDROID_APK_ASSET_NAME,
            fetchedAt: new Date().toISOString(),
          };
    githubCache = { at: Date.now(), value };
    return value;
  } catch {
    githubCache = { at: Date.now(), value: null };
    return null;
  }
}

export function distributionBlock(
  clicks: ApkClickState | null,
  configured: boolean,
  github: GithubApkDownloads | null,
): DistributionBlock {
  const state = clicks ?? emptyClicks();
  const today = saoPauloDay();
  return {
    apkClicks: state.total,
    apkClicksToday: state.day === today ? state.today : 0,
    apkClicksLastAt: state.lastAt,
    apkClicksConfigured: configured,
    apkDownloads: github?.downloads ?? null,
    apkDownloadsTag: github?.tag ?? ANDROID_APK_RELEASE_TAG,
    apkDownloadsAsset: github?.asset ?? ANDROID_APK_ASSET_NAME,
    apkDownloadsFetchedAt: github?.fetchedAt ?? null,
  };
}

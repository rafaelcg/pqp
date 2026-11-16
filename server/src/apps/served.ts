import { getPool } from "../db.js";
import { logEvent } from "../lib/log.js";
import { readCatalogFile } from "./catalog.js";

/**
 * WHICH VERSIONS THE APPS SITE SERVES, as far as this build knows.
 *
 * The apps site is rebuilt from `apps/` on every deploy and a Pages deploy
 * replaces the whole site (docs/APPS.md, "Deploy"), so the bundles it serves are
 * exactly the versions `tools/apps-build` writes into `catalog.json`, the same
 * file this process loads at boot. A `repo` version the catalog no longer lists
 * is a 404 on the apps origin: a frame pinned to it shows that 404 page and
 * never says hello. That is what happened on 2026-11-12, when Locadora's
 * `current_version` was still 1.0.3 after the site had moved on to 1.0.6.
 *
 * The answer is three-valued on purpose:
 *  - `served`: the catalog lists this version of this app;
 *  - `not-served`: the catalog names the app but not this version, and the
 *    version came from the repo, so nothing else could be serving it;
 *  - `unknown`: a `submission` version (not built from `apps/`), or an app the
 *    catalog does not name at all (an app being removed, a test fixture, an
 *    empty or unreadable catalog). Nothing is refused on a guess.
 */

export type ServedAnswer = "served" | "not-served" | "unknown";

let override: Map<string, Set<string>> | null = null;
let cached: Map<string, Set<string>> | null = null;

function index(entries: unknown[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const entry of entries) {
    const manifest = (entry as { manifest?: { id?: unknown; version?: unknown } } | null)?.manifest;
    if (typeof manifest?.id !== "string" || typeof manifest.version !== "string") continue;
    const versions = out.get(manifest.id) ?? new Set<string>();
    versions.add(manifest.version);
    out.set(manifest.id, versions);
  }
  return out;
}

/** App id to the versions this build's catalog lists, read once per process. */
export function shippedCatalogVersions(): Map<string, Set<string>> {
  if (override) return override;
  cached ??= index(readCatalogFile());
  return cached;
}

/** Tests: the catalog this build "ships". `null` goes back to the committed file. */
export function setShippedCatalogForTests(entries: Array<{ id: string; version: string }> | null): void {
  override = entries
    ? index(entries.map((entry) => ({ manifest: { id: entry.id, version: entry.version } })))
    : null;
}

export function servedByThisBuild(
  appId: string,
  version: string | null,
  source: string | null,
): ServedAnswer {
  if (version === null || source !== "repo") return "unknown";
  const versions = shippedCatalogVersions().get(appId);
  if (!versions) return "unknown";
  return versions.has(version) ? "served" : "not-served";
}

export interface CurrentVersionNotServed {
  appId: string;
  currentVersion: string;
  /** What this build's catalog lists for the app instead, oldest first. */
  shipped: string[];
}

/**
 * Every `live` app whose `current_version` this build's apps site does not
 * serve: each start pins that version and every frame of it is a 404.
 */
export async function liveAppsNotServed(): Promise<CurrentVersionNotServed[]> {
  const { rows } = await getPool().query<{ id: string; current_version: string; source: string | null }>(
    `SELECT a.id, a.current_version, v.source
       FROM apps a
       LEFT JOIN app_versions v ON v.app_id = a.id AND v.version = a.current_version
      WHERE a.status = 'live' AND a.current_version IS NOT NULL
      ORDER BY a.id`,
  );
  return rows
    .filter((row) => servedByThisBuild(row.id, row.current_version, row.source) === "not-served")
    .map((row) => ({
      appId: row.id,
      currentVersion: row.current_version,
      shipped: [...(shippedCatalogVersions().get(row.id) ?? [])].sort(),
    }));
}

/**
 * The boot check: one loud line per live app the apps site cannot load, so the
 * mismatch is in the logs (and on the dashboard through `GET /api/admin/metrics`)
 * before anybody opens the app and stares at a white pane. Never throws.
 */
export async function reportCurrentVersionsNotServed(): Promise<CurrentVersionNotServed[]> {
  try {
    const stranded = await liveAppsNotServed();
    for (const app of stranded) {
      console.error(
        `[apps] ${app.appId} is live on ${app.currentVersion}, which the apps site of this build does not serve ` +
          `(it serves ${app.shipped.join(", ") || "nothing"}): move currentVersion on the dashboard`,
      );
      logEvent("apps.currentVersionNotServed", { ...app });
    }
    return stranded;
  } catch (error) {
    console.error("[apps] could not check which live versions are served:", error);
    return [];
  }
}

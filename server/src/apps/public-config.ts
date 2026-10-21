import { LOCADORA_APP_ID, type PublicAppsConfig, type PublicGuestApp } from "@pqp/shared";
import { getPool } from "../db.js";
import { isEnabled } from "../lib/flags.js";
import { manifestOfRow, type AppAvailabilityRow } from "./availability.js";
import { appBundleUrl, appsOrigin } from "./origin.js";

/**
 * `GET /api/public/apps/config`, the body: the one answer the signed-out pages
 * of pqp Apps read (`client/src/lib/apps-landing.ts`, and the Pages edge).
 *
 * The same for every caller: no Authorization is read, no server or session
 * is involved, so it is publicly cacheable. `enabled` and `cloudSaves` are
 * flag reads (an in-process snapshot). `guest` needs one more fact, that
 * Locadora is really released (`apps.status = 'live'`, `global_enabled`, a
 * valid stored manifest), which is a database read: it is asked only while
 * `apps_landing` and `locadora_guest` are both on and an apps origin exists,
 * and its answer is kept in this process for `LOCADORA_ROW_TTL_MS`, so a
 * landing page under load costs the database one query a minute, not one a
 * visit. A failed read (the database down, the breaker open) is "no guest"
 * for `LOCADORA_ROW_MISS_MS`: the pages still answer, the player is simply not
 * offered. That is the direction to fail: guest play is an extra.
 *
 * The guest app is built from the stored BUILT manifest, exactly like an entry
 * of `GET /api/apps/config`, so its bundle URL and asset hashes are the
 * catalog's, never a request's.
 */

export const LOCADORA_ROW_TTL_MS = 60_000;
export const LOCADORA_ROW_MISS_MS = 10_000;

type RowReader = () => Promise<AppAvailabilityRow | null>;

let memo: { at: number; ttl: number; row: AppAvailabilityRow | null } | null = null;
let inflight: Promise<AppAvailabilityRow | null> | null = null;

async function readLocadoraRow(): Promise<AppAvailabilityRow | null> {
  const result = await getPool().query<AppAvailabilityRow>(
    `SELECT a.id, a.status, a.current_version, a.global_enabled, a.community_unlocked,
            v.manifest, NULL::boolean AS operator_enabled, NULL::boolean AS owner_enabled
       FROM apps a
       LEFT JOIN app_versions v ON v.app_id = a.id AND v.version = a.current_version
      WHERE a.id = $1`,
    [LOCADORA_APP_ID],
  );
  return result.rows[0] ?? null;
}

/** The row, from this process's memo when it is fresh; null on a miss or a failure. */
async function locadoraRow(read: RowReader, now: number): Promise<AppAvailabilityRow | null> {
  if (memo && now - memo.at < memo.ttl) return memo.row;
  if (!inflight) {
    inflight = read()
      .then(
        (row) => {
          memo = { at: Date.now(), ttl: LOCADORA_ROW_TTL_MS, row };
          return row;
        },
        () => {
          memo = { at: Date.now(), ttl: LOCADORA_ROW_MISS_MS, row: null };
          return null;
        },
      )
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Tests only: forget the memo. */
export function resetPublicAppsConfigCache(): void {
  memo = null;
  inflight = null;
}

/** The guest app from a released Locadora row, or null when it is not released or its manifest is not trusted. */
export function guestAppOfRow(row: AppAvailabilityRow | null, origin: string): PublicGuestApp | null {
  if (!row || row.status !== "live" || !row.current_version || !row.global_enabled) return null;
  const manifest = manifestOfRow(row);
  if (!manifest || manifest.id !== LOCADORA_APP_ID) return null;
  const entry = appBundleUrl(origin, manifest.id, manifest.version, manifest.entry.path);
  const assets = (manifest.assets ?? []).map((asset) => ({
    name: asset.name,
    url: appBundleUrl(origin, manifest.id, manifest.version, asset.path),
    sha256: asset.sha256,
    bytes: asset.bytes,
  }));
  // every address has to be a real one on the apps origin, or there is nothing to run
  if (!entry || assets.some((asset) => !asset.url)) return null;
  return {
    id: manifest.id,
    version: manifest.version,
    entry: { url: entry },
    capabilities: manifest.capabilities,
    state: manifest.state,
    events: manifest.events,
    assets: assets.map((asset) => ({ ...asset, url: asset.url! })),
  };
}

export async function publicAppsConfig(
  options: { readRow?: RowReader; now?: number } = {},
): Promise<PublicAppsConfig> {
  const enabled = isEnabled("apps_landing");
  const cloudSaves = isEnabled("locadora_saves_announced");
  const origin = appsOrigin();
  if (!enabled || !isEnabled("locadora_guest") || !origin) {
    return { enabled, guest: false, cloudSaves, locadora: null };
  }
  const row = await locadoraRow(options.readRow ?? readLocadoraRow, options.now ?? Date.now());
  const app = guestAppOfRow(row, origin);
  return app
    ? { enabled, guest: true, cloudSaves, locadora: { origin, app } }
    : { enabled, guest: false, cloudSaves, locadora: null };
}

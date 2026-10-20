import { validateAppManifest, type AppManifest } from "@pqp/shared";
import { getPool } from "../db.js";

/**
 * The manifest a session was pinned to. A version's manifest is immutable (the
 * catalog loader refuses a changed hash), so once read it is cached for the
 * life of the process: the event and state hot paths ask for its caps on every
 * frame and must not touch the database to find them.
 */

const cache = new Map<string, AppManifest>();

const keyOf = (appId: string, version: string) => `${appId}\u0000${version}`;

export async function loadPinnedManifest(
  appId: string,
  version: string,
): Promise<AppManifest | null> {
  const key = keyOf(appId, version);
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const result = await getPool().query<{ manifest: unknown }>(
    `SELECT manifest FROM app_versions WHERE app_id = $1 AND version = $2`,
    [appId, version],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  const checked = validateAppManifest(row.manifest);
  if (!checked.ok) {
    return null;
  }
  cache.set(key, checked.manifest);
  return checked.manifest;
}

export function resetManifestCacheForTests(): void {
  cache.clear();
}

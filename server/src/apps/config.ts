import {
  APP_REQUIRED_LOCALES,
  appString,
  type AppConfigEntry,
  type AppManifest,
  type AppsConfig,
} from "@pqp/shared";
import { isEnabled } from "../lib/flags.js";
import {
  appShareAllowed,
  evaluateAvailability,
  manifestOfRow,
  readLiveAvailabilityRows,
  readServerFacts,
} from "./availability.js";
import { appBundleUrl, appsOrigin } from "./origin.js";

/**
 * `GET /api/apps/config?serverId=`: the launcher's answer for one server.
 *
 * The flag off, or a server that does not exist, is the same quiet
 * `{ enabled: false, origin: null, apps: [] }`: a client hides the launcher
 * instead of handling a 404 storm, and nothing about the platform is visible.
 * With the flag on, every `live` app is listed with `available` and the
 * `reason` it is not, so the launcher can draw a disabled tile with the reason
 * written (apps that are draft, in review or retired are not listed at all).
 * The caller has already proved membership of the server.
 *
 * Every entry is built from the stored, validated BUILT manifest. Nothing in it
 * comes from a client, and the bundle URLs are the apps origin plus the
 * immutable path of the pinned version.
 */

export const DISABLED_APPS_CONFIG: AppsConfig = {
  enabled: false,
  origin: null,
  apps: [],
};

/** The keys of the manifest's i18n a client draws, per locale. */
export function clientI18nKeys(manifest: AppManifest): string[] {
  const keys = [
    manifest.name,
    manifest.description,
    manifest.presence.phrase,
    manifest.presence.short,
  ];
  if (manifest.notice !== undefined) {
    keys.push(manifest.notice);
  }
  return keys;
}

function i18nSubset(manifest: AppManifest): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const locale of APP_REQUIRED_LOCALES) {
    const strings: Record<string, string> = {};
    for (const key of clientI18nKeys(manifest)) {
      const value = appString(manifest.i18n[locale], key);
      if (value !== undefined) {
        strings[key] = value;
      }
    }
    out[locale] = strings;
  }
  return out;
}

export async function appsConfigForServer(serverId: string): Promise<AppsConfig> {
  if (!isEnabled("apps", { serverId })) {
    return DISABLED_APPS_CONFIG;
  }
  const server = await readServerFacts(serverId);
  if (!server) {
    return DISABLED_APPS_CONFIG;
  }
  const origin = appsOrigin();
  const rows = await readLiveAvailabilityRows(serverId);
  const apps: AppConfigEntry[] = [];
  for (const row of rows) {
    const manifest = manifestOfRow(row);
    if (!manifest) {
      continue;
    }
    const verdict = evaluateAvailability(serverId, row, server, { origin });
    apps.push({
      id: manifest.id,
      version: manifest.version,
      category: manifest.category,
      icon: manifest.icon,
      name: manifest.name,
      description: manifest.description,
      ...(manifest.notice !== undefined ? { notice: manifest.notice } : {}),
      presence: manifest.presence,
      channelTypes: manifest.channelTypes,
      players: manifest.players,
      capabilities: manifest.capabilities,
      content: manifest.content,
      hostBound: manifest.hostBound,
      i18n: i18nSubset(manifest),
      entry: { url: appBundleUrl(origin, manifest.id, manifest.version, manifest.entry.path) },
      assets: (manifest.assets ?? []).map((asset) => ({
        name: asset.name,
        url: appBundleUrl(origin, manifest.id, manifest.version, asset.path),
        sha256: asset.sha256,
        bytes: asset.bytes,
      })),
      ...(manifest.sandbox !== undefined ? { sandbox: manifest.sandbox } : {}),
      available: verdict.available,
      reason: verdict.reason,
      shareAllowed: appShareAllowed(serverId, manifest),
    });
  }
  return { enabled: true, origin, apps };
}

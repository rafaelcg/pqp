import type { Pool, PoolClient } from "pg";
import {
  validateAppManifest,
  type AppManifest,
  type AppUnavailableReason,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { FEATURE_FLAGS, isEnabled, type FlagKey } from "../lib/flags.js";
import { appsOrigin } from "./origin.js";

/**
 * WHETHER AN APP MAY RUN IN A PLACE: PLAN D10, in one function.
 *
 * Every gate must hold, and the answer names the FIRST one that does not, in
 * this order, so the launcher can write the reason on a disabled tile:
 *
 *  1. `flag-off`           the runtime flag `apps` for the server
 *  2. `not-live`           `apps.status = 'live'` with a current version
 *  3. `global-off`         `apps.global_enabled`, the operator's master switch
 *  4. `not-allowed-here`   `server_apps.operator_enabled IS TRUE`
 *  5. `owner-off`          `server_apps.owner_enabled IS NOT FALSE`
 *  6. `community-locked`   a public community needs `apps.community_unlocked`
 *  7. `emulator-off`       category `emulator` also needs `emulator_room`
 *  8. `channel-type`       the channel's type is one the manifest lists
 *  9. `no-origin`          the deployment has an apps origin at all
 *
 * The owner can only remove what the operator allowed: `owner_enabled` TRUE
 * does nothing without `operator_enabled`, and NULL (undecided) is on only when
 * the operator allowed it.
 *
 * "A community" is `servers.is_community` (the public address), not only the
 * directory listing: the address already lets any account in with one tap, and
 * the lock exists because apps with free text or pictures are not scanned by
 * anything we run (docs/CONTENT_SAFETY.md). The listing implies an address, so
 * a listed community is always locked as well.
 *
 * Reads the database on every call, nothing is cached: the operator's switch
 * is answered by the very next request, and the flag read is already an
 * in-process snapshot lookup.
 */

export interface AppAvailability {
  available: boolean;
  reason: AppUnavailableReason | null;
}

/** What a channel can be for an app. Anything else is `channel-type`. */
export type AppChannelType = "text" | "voice";

type Queryable = Pick<Pool | PoolClient, "query">;

/** The columns `evaluate` needs, as one row, joined once. */
export interface AppAvailabilityRow {
  id: string;
  status: "draft" | "review" | "live" | "retired";
  current_version: string | null;
  global_enabled: boolean;
  community_unlocked: boolean;
  /** The current version's stored manifest, or null with no version. */
  manifest: unknown;
  operator_enabled: boolean | null;
  owner_enabled: boolean | null;
}

export interface AppServerFacts {
  isCommunity: boolean;
}

/**
 * `emulator_room` is PR #1390's flag. Until it is merged the registry has no
 * such key, and an emulator app is simply off: the safe answer, and the same
 * code is correct the day the key exists.
 */
export function emulatorRoomEnabled(serverId: string): boolean {
  if (!Object.hasOwn(FEATURE_FLAGS, "emulator_room")) {
    return false;
  }
  return isEnabled("emulator_room" as string as FlagKey, { serverId });
}

/** D14: whether an app may share its pane and admit spectators in a server. */
export function appShareAllowed(
  serverId: string,
  app: { category: AppManifest["category"] },
): boolean {
  if (app.category !== "emulator") {
    return true;
  }
  return isEnabled("locadora_share", { serverId });
}

/** The manifest a row stored, validated again so a corrupt row is never trusted. */
export function manifestOfRow(row: AppAvailabilityRow): AppManifest | null {
  if (row.manifest === null || row.manifest === undefined) {
    return null;
  }
  const checked = validateAppManifest(row.manifest);
  return checked.ok ? checked.manifest : null;
}

/**
 * The pure decision over facts already read. Exported for the config route,
 * which reads many apps for one server and must not ask the database per app.
 */
export function evaluateAvailability(
  serverId: string,
  row: AppAvailabilityRow,
  server: AppServerFacts,
  options: { channelType?: AppChannelType | string | null; origin?: string | null } = {},
): AppAvailability {
  const off = (reason: AppUnavailableReason): AppAvailability => ({
    available: false,
    reason,
  });
  if (!isEnabled("apps", { serverId })) {
    return off("flag-off");
  }
  const manifest = manifestOfRow(row);
  if (row.status !== "live" || !row.current_version || !manifest) {
    return off("not-live");
  }
  if (!row.global_enabled) {
    return off("global-off");
  }
  if (row.operator_enabled !== true) {
    return off("not-allowed-here");
  }
  if (row.owner_enabled === false) {
    return off("owner-off");
  }
  if (server.isCommunity && !row.community_unlocked) {
    return off("community-locked");
  }
  if (manifest.category === "emulator" && !emulatorRoomEnabled(serverId)) {
    return off("emulator-off");
  }
  if (
    options.channelType !== undefined &&
    options.channelType !== null &&
    !(manifest.channelTypes as readonly string[]).includes(options.channelType)
  ) {
    return off("channel-type");
  }
  const origin = options.origin === undefined ? appsOrigin() : options.origin;
  if (!origin) {
    return off("no-origin");
  }
  return { available: true, reason: null };
}

const ROW_COLUMNS = `a.id, a.status, a.current_version, a.global_enabled,
       a.community_unlocked, v.manifest, sa.operator_enabled, sa.owner_enabled`;
const ROW_JOINS = `FROM apps a
  LEFT JOIN app_versions v ON v.app_id = a.id AND v.version = a.current_version
  LEFT JOIN server_apps sa ON sa.server_id = $1 AND sa.app_id = a.id`;

export async function readServerFacts(
  serverId: string,
  db: Queryable = getPool(),
): Promise<AppServerFacts | null> {
  const result = await db.query<{ is_community: boolean }>(
    `SELECT COALESCE(is_community, FALSE) AS is_community FROM servers WHERE id = $1`,
    [serverId],
  );
  const row = result.rows[0];
  return row ? { isCommunity: row.is_community } : null;
}

/** One app's row for one server, or null when there is no such app. */
export async function readAvailabilityRow(
  serverId: string,
  appId: string,
  db: Queryable = getPool(),
): Promise<AppAvailabilityRow | null> {
  const result = await db.query<AppAvailabilityRow>(
    `SELECT ${ROW_COLUMNS} ${ROW_JOINS} WHERE a.id = $2`,
    [serverId, appId],
  );
  return result.rows[0] ?? null;
}

/** Every `live` app's row for one server, for the launcher. */
export async function readLiveAvailabilityRows(
  serverId: string,
  db: Queryable = getPool(),
): Promise<AppAvailabilityRow[]> {
  const result = await db.query<AppAvailabilityRow>(
    `SELECT ${ROW_COLUMNS} ${ROW_JOINS}
      WHERE a.status = 'live' AND a.current_version IS NOT NULL
      ORDER BY a.id`,
    [serverId],
  );
  return result.rows;
}

/**
 * `appAvailability(serverId, appId, { channelType })`: the one question every
 * caller asks. An unknown app or server is `not-live` / `not-allowed-here`
 * rather than an error, so a route can answer 404 or a tile can draw a reason
 * without a second code path.
 */
export async function appAvailability(
  serverId: string,
  appId: string,
  options: { channelType?: AppChannelType | string | null } = {},
): Promise<AppAvailability> {
  if (!isEnabled("apps", { serverId })) {
    return { available: false, reason: "flag-off" };
  }
  const [row, server] = await Promise.all([
    readAvailabilityRow(serverId, appId),
    readServerFacts(serverId),
  ]);
  if (!row) {
    return { available: false, reason: "not-live" };
  }
  if (!server) {
    return { available: false, reason: "not-allowed-here" };
  }
  return evaluateAvailability(serverId, row, server, options);
}

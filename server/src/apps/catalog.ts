import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { z } from "zod";
import { validateAppManifest, type AppManifest } from "@pqp/shared";
import { getPool } from "../db.js";
import { logEvent } from "../lib/log.js";

/**
 * THE CATALOG LOADER: how first-party apps get into the database.
 *
 * `catalog.json` is written by the packager (`tools/apps-build/`, Track R) and
 * committed. Each entry is a BUILT manifest plus `manifestSha256`, the identity
 * the packager gives that exact build (the loader compares it, it does not
 * recompute it: the canonical form belongs to the packager). At boot, on the
 * API and on the worker, every entry is validated with `validateAppManifest`
 * and merged into `apps` and `app_versions`, and the merge is INSERT-ONLY:
 *
 *  - an unknown app id inserts `apps` as `draft`, off everywhere
 *    (`global_enabled` false, nothing in `server_apps`), under the manifest's
 *    publisher, which must already exist and not be suspended;
 *  - an unknown (id, version) inserts `app_versions` as `pending` review with
 *    source `repo`;
 *  - a known (id, version) with the SAME hash is a no-op, and with a DIFFERENT
 *    hash is refused with a loud log and not written: a version is immutable,
 *    and a changed bundle under an old number is exactly what pinning a version
 *    on a session exists to rule out;
 *  - nothing ever changes the status, the switches, the review fields or the
 *    `current_version` of an existing row, with one exception: an app whose
 *    `current_version` is still NULL gets the newest version this load inserted
 *    (so the first load of a new app is usable once the operator approves it).
 *
 * Every insert writes one `app_admin_audit` row (`catalog-load`, actor `boot`).
 * The whole load is one transaction under an advisory lock, so `api-a`,
 * `api-b` and the worker booting together produce one set of rows and one set
 * of audit lines, and a second run of the same catalog writes nothing. What
 * already exists is read in three statements for the whole catalog, not three
 * per entry, so a populated catalog costs a boot a handful of round trips.
 *
 * A load that fails (the database was down at boot) is retried with a bounded
 * backoff by `startAppCatalogLoad`; it is idempotent, so a retry that races a
 * sibling's success writes nothing.
 *
 * THE DEV CONVENIENCE. With `DEV_AUTH_BYPASS=true` and `NODE_ENV` not
 * `production`, apps of the `pqp` publisher are made `live`, `global_enabled`
 * and `community_unlocked` on every load, and the dev seed releases them on its
 * Sandbox server (`enableDevAppsForServer`), so a local checkout can run an app
 * without the dashboard. Production never does this: the guard is the same
 * pair of conditions the dev auth bypass itself needs.
 */

const here = dirname(fileURLToPath(import.meta.url));

const entrySchema = z.object({
  manifest: z.unknown(),
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export type CatalogEntry = z.infer<typeof entrySchema>;

export interface CatalogRefusal {
  appId: string | null;
  version: string | null;
  reason:
    | "invalid-entry"
    | "invalid-manifest"
    | "unknown-publisher"
    | "publisher-mismatch"
    | "hash-changed";
}

export interface CatalogLoadResult {
  appsInserted: number;
  versionsInserted: number;
  currentVersionsSet: number;
  refused: CatalogRefusal[];
  /** Apps made live by the dev convenience. 0 anywhere but a dev box. */
  devEnabled: number;
}

/** Whether the dev convenience applies: the dev auth bypass, never production. */
export function devAppsConvenienceEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.DEV_AUTH_BYPASS === "true" && env.NODE_ENV !== "production";
}

/** The committed catalog. A missing or unreadable file is an empty catalog, logged. */
export function readCatalogFile(path = join(here, "catalog.json")): unknown[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    logEvent("apps.catalog.unreadable", { path, error: String(error) });
    return [];
  }
  try {
    const parsed = JSON.parse(text) as { apps?: unknown };
    return Array.isArray(parsed.apps) ? parsed.apps : [];
  } catch (error) {
    logEvent("apps.catalog.unreadable", { path, error: String(error) });
    return [];
  }
}

interface ParsedSemver {
  core: [bigint, bigint, bigint];
  pre: string[];
}

function parseSemver(version: string): ParsedSemver {
  const dash = version.indexOf("-");
  const core = dash === -1 ? version : version.slice(0, dash);
  const [major = "0", minor = "0", patch = "0"] = core.split(".");
  return {
    // BigInt: the manifest's version pattern allows numbers of any length, and
    // a double would call two long ones equal.
    core: [BigInt(major), BigInt(minor), BigInt(patch)],
    pre: dash === -1 ? [] : version.slice(dash + 1).split("."),
  };
}

/** SemVer 2.0.0 precedence: a prerelease sorts before its release. */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) {
      return left.core[i]! < right.core[i]! ? -1 : 1;
    }
  }
  if (left.pre.length === 0 && right.pre.length === 0) {
    return 0;
  }
  if (left.pre.length === 0) {
    return 1;
  }
  if (right.pre.length === 0) {
    return -1;
  }
  const length = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < length; i += 1) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) {
      return -1;
    }
    if (y === undefined) {
      return 1;
    }
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      if (BigInt(x) !== BigInt(y)) {
        return BigInt(x) < BigInt(y) ? -1 : 1;
      }
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

async function audit(
  client: PoolClient,
  appId: string,
  version: string | null,
  after: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO app_admin_audit (actor_kind, action, app_id, app_version, before, after)
     VALUES ('boot', 'catalog-load', $1, $2, NULL, $3::jsonb)`,
    [appId, version, JSON.stringify(after)],
  );
}

function refuse(
  result: CatalogLoadResult,
  refusal: CatalogRefusal,
  detail: Record<string, unknown> = {},
): void {
  result.refused.push(refusal);
  // Loud on purpose: a refused entry means the repository and the database
  // disagree about what a published version contains.
  console.error(
    `[apps] catalog entry refused: ${refusal.reason} ` +
      `(${refusal.appId ?? "?"}@${refusal.version ?? "?"})`,
  );
  logEvent("apps.catalog.refused", { ...refusal, ...detail });
}

/** What the database already holds for the apps and publishers a catalog names. */
interface KnownState {
  /** publisher id to whether it is suspended. */
  publishers: Map<string, boolean>;
  /** app id to its publisher id. */
  apps: Map<string, string>;
  /** `app id` + NUL + `version` to its stored manifest hash. */
  versions: Map<string, string>;
}

const versionKey = (appId: string, version: string) => `${appId}\u0000${version}`;

async function readKnownState(
  client: PoolClient,
  publisherIds: readonly string[],
  appIds: readonly string[],
): Promise<KnownState> {
  const [publishers, apps, versions] = await Promise.all([
    client.query<{ id: string; suspended_at: Date | null }>(
      `SELECT id, suspended_at FROM app_publishers WHERE id = ANY($1::text[])`,
      [[...publisherIds]],
    ),
    client.query<{ id: string; publisher_id: string }>(
      `SELECT id, publisher_id FROM apps WHERE id = ANY($1::text[])`,
      [[...appIds]],
    ),
    client.query<{ app_id: string; version: string; manifest_sha256: string }>(
      `SELECT app_id, version, manifest_sha256 FROM app_versions WHERE app_id = ANY($1::text[])`,
      [[...appIds]],
    ),
  ]);
  return {
    publishers: new Map(publishers.rows.map((row) => [row.id, row.suspended_at !== null])),
    apps: new Map(apps.rows.map((row) => [row.id, row.publisher_id])),
    versions: new Map(
      versions.rows.map((row) => [versionKey(row.app_id, row.version), row.manifest_sha256]),
    ),
  };
}

export async function loadAppCatalog(
  options: { entries?: unknown[]; dev?: boolean } = {},
): Promise<CatalogLoadResult> {
  const result: CatalogLoadResult = {
    appsInserted: 0,
    versionsInserted: 0,
    currentVersionsSet: 0,
    refused: [],
    devEnabled: 0,
  };
  const raw = options.entries ?? readCatalogFile();
  const dev = options.dev ?? devAppsConvenienceEnabled();
  if (raw.length === 0 && !dev) {
    // An empty catalog costs a boot nothing at all, not even a connection.
    return result;
  }

  // Validation needs no database: settle every entry first, so the transaction
  // only holds the entries that can be written.
  const valid: Array<{ manifest: AppManifest; manifestSha256: string }> = [];
  for (const item of raw) {
    const entry = entrySchema.safeParse(item);
    if (!entry.success) {
      refuse(result, { appId: null, version: null, reason: "invalid-entry" });
      continue;
    }
    const checked = validateAppManifest(entry.data.manifest);
    if (!checked.ok) {
      const candidate = entry.data.manifest as { id?: unknown; version?: unknown } | null;
      refuse(
        result,
        {
          appId: typeof candidate?.id === "string" ? candidate.id : null,
          version: typeof candidate?.version === "string" ? candidate.version : null,
          reason: "invalid-manifest",
        },
        { issues: checked.issues.slice(0, 5) },
      );
      continue;
    }
    valid.push({ manifest: checked.manifest, manifestSha256: entry.data.manifestSha256 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // One loader at a time across `api-a`, `api-b` and the worker.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('pqp.apps.catalog-load'))`);

    const known = await readKnownState(
      client,
      [...new Set(valid.map((item) => item.manifest.publisher))],
      [...new Set(valid.map((item) => item.manifest.id))],
    );
    const insertedByApp = new Map<string, string[]>();
    for (const item of valid) {
      await mergeEntry(client, item.manifest, item.manifestSha256, known, result, insertedByApp);
    }

    // First version of an app that has none yet: the newest this load brought.
    for (const [appId, versions] of insertedByApp) {
      const newest = [...versions].sort(compareSemver).at(-1)!;
      const set = await client.query(
        `UPDATE apps SET current_version = $2, updated_at = NOW()
          WHERE id = $1 AND current_version IS NULL`,
        [appId, newest],
      );
      result.currentVersionsSet += set.rowCount ?? 0;
    }

    if (dev) {
      const live = await client.query(
        `UPDATE apps
            SET status = 'live', global_enabled = TRUE, community_unlocked = TRUE,
                updated_at = NOW()
          WHERE publisher_id = 'pqp'
            AND current_version IS NOT NULL
            AND (status <> 'live' OR NOT global_enabled OR NOT community_unlocked)`,
      );
      result.devEnabled = live.rowCount ?? 0;
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  if (result.appsInserted || result.versionsInserted || result.refused.length) {
    logEvent("apps.catalog.loaded", {
      appsInserted: result.appsInserted,
      versionsInserted: result.versionsInserted,
      currentVersionsSet: result.currentVersionsSet,
      refused: result.refused.length,
    });
  }
  return result;
}

async function mergeEntry(
  client: PoolClient,
  manifest: AppManifest,
  manifestSha256: string,
  known: KnownState,
  result: CatalogLoadResult,
  insertedByApp: Map<string, string[]>,
): Promise<void> {
  const ref = { appId: manifest.id, version: manifest.version };

  const suspended = known.publishers.get(manifest.publisher);
  if (suspended === undefined || suspended) {
    refuse(result, { ...ref, reason: "unknown-publisher" });
    return;
  }

  const knownPublisher = known.apps.get(manifest.id);
  if (knownPublisher !== undefined && knownPublisher !== manifest.publisher) {
    // An id belongs to the publisher that first brought it.
    refuse(result, { ...ref, reason: "publisher-mismatch" });
    return;
  }

  const storedHash = known.versions.get(versionKey(manifest.id, manifest.version));
  if (storedHash !== undefined) {
    if (storedHash !== manifestSha256) {
      refuse(result, { ...ref, reason: "hash-changed" }, {
        stored: storedHash,
        offered: manifestSha256,
      });
    }
    return;
  }

  if (knownPublisher === undefined) {
    const created = await client.query(
      `INSERT INTO apps (id, publisher_id) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [manifest.id, manifest.publisher],
    );
    known.apps.set(manifest.id, manifest.publisher);
    if (created.rowCount) {
      result.appsInserted += 1;
      await audit(client, manifest.id, null, {
        status: "draft",
        publisher: manifest.publisher,
      });
    }
  }

  const inserted = await client.query(
    `INSERT INTO app_versions (app_id, version, manifest, manifest_sha256, entry_sha256, source)
     VALUES ($1, $2, $3::jsonb, $4, $5, 'repo')
     ON CONFLICT (app_id, version) DO NOTHING`,
    [
      manifest.id,
      manifest.version,
      JSON.stringify(manifest),
      manifestSha256,
      manifest.entry.sha256,
    ],
  );
  known.versions.set(versionKey(manifest.id, manifest.version), manifestSha256);
  if (inserted.rowCount) {
    result.versionsInserted += 1;
    const versions = insertedByApp.get(manifest.id) ?? [];
    versions.push(manifest.version);
    insertedByApp.set(manifest.id, versions);
    await audit(client, manifest.id, manifest.version, {
      reviewStatus: "pending",
      source: "repo",
      manifestSha256,
    });
  }
}

/** Seconds before each retry of a failed boot load: bounded, a handful of tries. */
export const CATALOG_RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000] as const;

/**
 * The boot step: try the load once (awaited, so the rows exist before the first
 * request when the database is up) and, if it fails, keep trying in the
 * background with a bounded backoff, so a database that was down at boot still
 * ends up with its apps without a restart. Never throws, and never holds the
 * process open (timers are unref'd). The load is idempotent, so a retry that
 * races a sibling's success writes nothing.
 */
export async function startAppCatalogLoad(
  options: {
    load?: () => Promise<unknown>;
    delaysMs?: readonly number[];
    schedule?: (run: () => void, delayMs: number) => void;
  } = {},
): Promise<void> {
  const load = options.load ?? (() => loadAppCatalog());
  const delays = options.delaysMs ?? CATALOG_RETRY_DELAYS_MS;
  const schedule =
    options.schedule ??
    ((run: () => void, delayMs: number) => {
      setTimeout(run, delayMs).unref();
    });

  const attempt = async (index: number): Promise<void> => {
    try {
      await load();
    } catch (error) {
      const delay = delays[index];
      console.error(
        `[apps] catalog load failed (attempt ${index + 1}):`,
        error,
        delay === undefined ? "giving up until the next restart" : `retrying in ${delay} ms`,
      );
      if (delay !== undefined) {
        schedule(() => void attempt(index + 1), delay);
      }
    }
  };
  await attempt(0);
}

/**
 * The dev convenience's second half: release every `pqp` app on one server
 * (the dev seed's Sandbox). Never called outside a dev box, and refuses to run
 * anywhere else even if it is.
 */
export async function enableDevAppsForServer(
  serverId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (!devAppsConvenienceEnabled(env)) {
    return 0;
  }
  const result = await getPool().query(
    `INSERT INTO server_apps (server_id, app_id, operator_enabled)
     SELECT $1, id, TRUE FROM apps WHERE publisher_id = 'pqp'
     ON CONFLICT (server_id, app_id)
     DO UPDATE SET operator_enabled = TRUE, updated_at = NOW()
       WHERE server_apps.operator_enabled IS DISTINCT FROM TRUE`,
    [serverId],
  );
  return result.rowCount ?? 0;
}

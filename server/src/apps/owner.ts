import { APP_REQUIRED_LOCALES, appString } from "@pqp/shared";
import { z } from "zod";
import { getPool } from "../db.js";
import { HttpError } from "../lib/http.js";
import { logEvent } from "../lib/log.js";
import {
  actorUserId,
  endLiveSessions,
  inAppsTransaction,
  recordSessionsEnded,
  writeAppAudit,
  type AppAdminActor,
} from "./admin.js";
import { OPERATOR_RELEASED_SQL, operatorReleased } from "./availability.js";
import { publishAppsChanged } from "./changed.js";

/**
 * THE OWNER'S SWITCHES (PLAN D10, Phase 5): `GET` and `PUT
 * /api/servers/:serverId/apps`, for whoever holds MANAGE_SERVER.
 *
 * The operator decides which apps a server MAY have (`server_apps.operator_enabled`);
 * the owner can only take away from that. So the list is the apps the operator
 * released here (its own switch on this server, or the app's default when it
 * has decided nothing, see `operatorReleased`; and that are `live`; a public
 * community's release counts only while the app is unlocked for communities,
 * the same rule availability uses),
 * each with the owner's own switch, and the one write accepts `false` (off) or
 * `null` (back to whatever the operator allowed): `true` does not exist, because
 * an owner switching ON something the operator never allowed would be the
 * operator's decision taken by the wrong person.
 *
 * Switching an app off ends that server's live sessions of it (`app-disabled`),
 * the same promise the operator's switches make, and is audited
 * (`app_admin_audit`, actor `owner`, the count of sessions ended written back).
 */

export const setOwnerAppSchema = z.object({
  appId: z.string().regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/),
  /** `false` switches the app off here; `null` removes that, the operator's release applies again. */
  ownerEnabled: z.union([z.literal(false), z.null()]),
});

export interface OwnerAppView {
  id: string;
  icon: string | null;
  category: string | null;
  /** The name and description in each language the manifest carries. */
  names: Record<string, string>;
  descriptions: Record<string, string>;
  /** The owner has not switched it off. */
  enabled: boolean;
  /** The operator's master switch is off for everybody: nothing runs, whatever this says. */
  paused: boolean;
  liveSessions: number;
}

export interface OwnerAppsList {
  apps: OwnerAppView[];
}

interface ManifestStrings {
  name?: unknown;
  description?: unknown;
  icon?: unknown;
  category?: unknown;
  i18n?: Record<string, Record<string, string> | undefined>;
}

function perLocale(manifest: ManifestStrings, key: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof key !== "string") {
    return out;
  }
  for (const locale of APP_REQUIRED_LOCALES) {
    const strings = manifest.i18n?.[locale];
    const value = strings ? appString(strings, key) : undefined;
    if (value !== undefined) {
      out[locale] = value;
    }
  }
  return out;
}

/** `GET /api/servers/:serverId/apps`. The caller has already been checked for MANAGE_SERVER. */
export async function listOwnerApps(serverId: string): Promise<OwnerAppsList> {
  const { rows } = await getPool().query<{
    id: string;
    manifest: ManifestStrings | null;
    global_enabled: boolean;
    owner_enabled: boolean | null;
    live_sessions: number;
  }>(
    // FROM the app and the server, the decision LEFT JOINed: a server released
    // by the app's default has no `server_apps` row at all.
    `SELECT a.id, v.manifest, a.global_enabled, sa.owner_enabled,
            (SELECT COUNT(*)::int FROM app_sessions x
              WHERE x.server_id = s.id AND x.app_id = a.id AND x.status = 'live') AS live_sessions
       FROM servers s
       CROSS JOIN apps a
       LEFT JOIN server_apps sa ON sa.server_id = s.id AND sa.app_id = a.id
       LEFT JOIN app_versions v ON v.app_id = a.id AND v.version = a.current_version
      WHERE s.id = $1
        AND ${OPERATOR_RELEASED_SQL}
        AND a.status = 'live'
        AND (NOT s.is_community OR a.community_unlocked)
      ORDER BY a.id`,
    [serverId],
  );
  return {
    apps: rows.map((row) => {
      const manifest = row.manifest ?? {};
      return {
        id: row.id,
        icon: typeof manifest.icon === "string" ? manifest.icon : null,
        category: typeof manifest.category === "string" ? manifest.category : null,
        names: perLocale(manifest, manifest.name),
        descriptions: perLocale(manifest, manifest.description),
        enabled: row.owner_enabled !== false,
        paused: !row.global_enabled,
        liveSessions: row.live_sessions,
      } satisfies OwnerAppView;
    }),
  };
}

export interface OwnerAppWriteResult {
  appId: string;
  enabled: boolean;
  changed: boolean;
  sessionsEnded: number;
}

/** `PUT /api/servers/:serverId/apps`. The caller has already been checked for MANAGE_SERVER. */
export async function setOwnerApp(
  serverId: string,
  userId: string,
  input: z.infer<typeof setOwnerAppSchema>,
): Promise<OwnerAppWriteResult> {
  const actor: AppAdminActor = { kind: "owner", userId };
  const written = await inAppsTransaction(async (client) => {
    // The app first (shared: owners do not queue behind each other, and the
    // operator's writes, which take it FOR UPDATE, wait for this to commit),
    // then its `server_apps` row: the same ordering every other write takes.
    // The app's own default is read under that lock.
    const app = await client.query<{
      default_operator_enabled: boolean;
      community_unlocked: boolean;
      is_community: boolean;
    }>(
      `SELECT a.default_operator_enabled, a.community_unlocked,
              COALESCE(s.is_community, FALSE) AS is_community
         FROM apps a JOIN servers s ON s.id = $1
        WHERE a.id = $2 AND a.status = 'live'
        FOR SHARE OF a`,
      [serverId, input.appId],
    );
    const facts = app.rows[0];
    // One owner write per (server, app) at a time. With no row yet (a server the
    // default released) there is nothing to lock FOR UPDATE, so two first
    // switches would both read "undecided", both audit the same transition and
    // both answer `changed`. This lock makes the second one read the first's
    // row. It is taken after the app's lock and before the row's, and the
    // operator's writes (which take the app FOR UPDATE) never take it, so no
    // cycle is possible.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `app-owner:${serverId}:${input.appId}`,
    ]);
    const decided = await client.query<{
      operator_enabled: boolean | null;
      owner_enabled: boolean | null;
    }>(
      `SELECT operator_enabled, owner_enabled FROM server_apps
        WHERE server_id = $1 AND app_id = $2 FOR UPDATE`,
      [serverId, input.appId],
    );
    const row = decided.rows[0] ?? { operator_enabled: null, owner_enabled: null };
    // Not released here is "not there" to the owner: nothing to switch.
    if (
      !facts ||
      !operatorReleased(row.operator_enabled, facts.default_operator_enabled) ||
      (facts.is_community && !facts.community_unlocked)
    ) {
      throw new HttpError(404, "App not found");
    }
    const before = row.owner_enabled === false ? false : null;
    if (before === input.ownerEnabled) {
      return { changed: false, auditId: null as string | null };
    }
    // An UPSERT: an app released by the default has no row until somebody decides.
    await client.query(
      `INSERT INTO server_apps (server_id, app_id, owner_enabled, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (server_id, app_id) DO UPDATE
         SET owner_enabled = EXCLUDED.owner_enabled, updated_at = NOW()`,
      [serverId, input.appId, input.ownerEnabled],
    );
    const auditId = await writeAppAudit(client, actor, {
      action: "owner-server",
      appId: input.appId,
      serverId,
      before: { ownerEnabled: before },
      after: { ownerEnabled: input.ownerEnabled },
    });
    return { changed: true, auditId };
  });

  const progress = { ended: 0 };
  if (written.changed) {
    logEvent("apps.owner.switch", { appId: input.appId, serverId, ownerEnabled: input.ownerEnabled });
    publishAppsChanged({ appId: input.appId, serverId });
    if (input.ownerEnabled === false) {
      try {
        await endLiveSessions(input.appId, serverId, actorUserId(actor), progress);
      } finally {
        if (written.auditId) {
          await recordSessionsEnded(written.auditId, progress.ended).catch(() => {});
        }
      }
    }
  }
  return {
    appId: input.appId,
    enabled: input.ownerEnabled !== false,
    changed: written.changed,
    sessionsEnded: progress.ended,
  };
}

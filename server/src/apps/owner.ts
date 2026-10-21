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
import { publishAppsChanged } from "./changed.js";

/**
 * THE OWNER'S SWITCHES (PLAN D10, Phase 5): `GET` and `PUT
 * /api/servers/:serverId/apps`, for whoever holds MANAGE_SERVER.
 *
 * The operator decides which apps a server MAY have (`server_apps.operator_enabled`);
 * the owner can only take away from that. So the list is the apps the operator
 * released here (and that are `live`; a public community's release counts only
 * while the app is unlocked for communities, the same rule availability uses),
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
    `SELECT a.id, v.manifest, a.global_enabled, sa.owner_enabled,
            (SELECT COUNT(*)::int FROM app_sessions x
              WHERE x.server_id = sa.server_id AND x.app_id = a.id AND x.status = 'live') AS live_sessions
       FROM server_apps sa
       JOIN servers s ON s.id = sa.server_id
       JOIN apps a ON a.id = sa.app_id
       LEFT JOIN app_versions v ON v.app_id = a.id AND v.version = a.current_version
      WHERE sa.server_id = $1
        AND sa.operator_enabled IS TRUE
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
    // The app and server rows give the same ordering every other write to the
    // switches takes: the app first, then its `server_apps` row.
    const released = await client.query<{ owner_enabled: boolean | null }>(
      `SELECT sa.owner_enabled
         FROM server_apps sa
         JOIN servers s ON s.id = sa.server_id
         JOIN apps a ON a.id = sa.app_id
        WHERE sa.server_id = $1 AND sa.app_id = $2
          AND sa.operator_enabled IS TRUE AND a.status = 'live'
          AND (NOT s.is_community OR a.community_unlocked)
        FOR UPDATE OF sa`,
      [serverId, input.appId],
    );
    const row = released.rows[0];
    // Not released here is "not there" to the owner: nothing to switch.
    if (!row) {
      throw new HttpError(404, "App not found");
    }
    const before = row.owner_enabled === false ? false : null;
    if (before === input.ownerEnabled) {
      return { changed: false, auditId: null as string | null };
    }
    await client.query(
      `UPDATE server_apps SET owner_enabled = $3, updated_at = NOW()
        WHERE server_id = $1 AND app_id = $2`,
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

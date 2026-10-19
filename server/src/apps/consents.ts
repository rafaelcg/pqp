import { APP_REQUIRED_LOCALES, appString, type AppConsent, type AppManifest } from "@pqp/shared";
import { getPool } from "../db.js";
import { loadPinnedManifest } from "./manifests.js";

/**
 * WHAT A PERSON ACCEPTED, per app (`app_consents`, mock 04, docs/APPS.md).
 *
 * The join sheet is shown once per app per person. Accepting records the
 * manifest version whose capabilities were on the sheet, and whether the person
 * ticked the optional id box (only an app that asks for `identity: "user-id"`
 * has one; for any other app the box does not exist, and the answer is stored
 * as no). Revoking, from Configurações, Apps, does not delete the row: the row
 * says when, and `revoked_at` is what makes the next Entrar show the sheet
 * again.
 *
 * A consent goes STALE when a newer version of the app asks for something
 * different (a capability diff): the sheet shows again, with what changed
 * being whatever the new manifest says. Same version, or a version with the
 * same capabilities, keeps the consent.
 */

export type ConsentRow = AppConsent;

interface DbRow {
  app_id: string;
  accepted_version: string;
  identity_granted: boolean;
  consented_at: Date;
  current_version: string | null;
}

function capabilitiesKey(manifest: AppManifest): string {
  return JSON.stringify(manifest.capabilities);
}

function namesOf(manifest: AppManifest, key: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (key === undefined) {
    return out;
  }
  for (const locale of APP_REQUIRED_LOCALES) {
    const value = appString(manifest.i18n[locale], key);
    if (value !== undefined) {
      out[locale] = value;
    }
  }
  return out;
}

/** Every app this person has accepted and not revoked, newest first. */
export async function listConsents(userId: string): Promise<ConsentRow[]> {
  const result = await getPool().query<DbRow>(
    `SELECT c.app_id, c.accepted_version, c.identity_granted, c.consented_at, a.current_version
       FROM app_consents c
       JOIN apps a ON a.id = c.app_id
      WHERE c.user_id = $1 AND c.revoked_at IS NULL
      ORDER BY c.consented_at DESC`,
    [userId],
  );
  const out: ConsentRow[] = [];
  for (const row of result.rows) {
    const accepted = await loadPinnedManifest(row.app_id, row.accepted_version);
    if (!accepted) {
      continue;
    }
    const current =
      row.current_version && row.current_version !== row.accepted_version
        ? await loadPinnedManifest(row.app_id, row.current_version)
        : accepted;
    out.push({
      appId: row.app_id,
      acceptedVersion: row.accepted_version,
      identityGranted: row.identity_granted,
      consentedAt: row.consented_at.toISOString(),
      identity: (current ?? accepted).capabilities.identity,
      names: namesOf(current ?? accepted, (current ?? accepted).name),
      notices: namesOf(current ?? accepted, (current ?? accepted).notice),
      stale: current !== null && capabilitiesKey(current) !== capabilitiesKey(accepted),
    });
  }
  return out;
}

export type RecordConsentResult =
  | { ok: true; identityGranted: boolean }
  | { ok: false; reason: "unknown-app" };

/**
 * Record that `userId` accepted `appId` as it is now (its current version).
 * `identityGranted` is honoured only for an app that asks for `user-id`.
 */
export async function recordConsent(
  userId: string,
  appId: string,
  identityGranted: boolean,
): Promise<RecordConsentResult> {
  const app = await getPool().query<{ current_version: string | null }>(
    `SELECT current_version FROM apps WHERE id = $1`,
    [appId],
  );
  const version = app.rows[0]?.current_version;
  if (!version) {
    return { ok: false, reason: "unknown-app" };
  }
  const manifest = await loadPinnedManifest(appId, version);
  if (!manifest) {
    return { ok: false, reason: "unknown-app" };
  }
  const granted = identityGranted && manifest.capabilities.identity === "user-id";
  await getPool().query(
    `INSERT INTO app_consents (user_id, app_id, accepted_version, identity_granted, consented_at, revoked_at)
     VALUES ($1, $2, $3, $4, NOW(), NULL)
     ON CONFLICT (user_id, app_id) DO UPDATE
        SET accepted_version = EXCLUDED.accepted_version,
            identity_granted = EXCLUDED.identity_granted,
            consented_at = NOW(),
            revoked_at = NULL`,
    [userId, appId, version, granted],
  );
  return { ok: true, identityGranted: granted };
}

/** Take the acceptance back. Idempotent: revoking what was never accepted is a no-op. */
export async function revokeConsent(userId: string, appId: string): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE app_consents
        SET revoked_at = NOW(), identity_granted = FALSE
      WHERE user_id = $1 AND app_id = $2 AND revoked_at IS NULL`,
    [userId, appId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Which of `userIds` currently let `appId` see their derived id. */
export async function usersGrantingIdentity(
  appId: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  if (userIds.length === 0) {
    return new Set();
  }
  const result = await getPool().query<{ user_id: string }>(
    `SELECT user_id FROM app_consents
      WHERE app_id = $1 AND user_id = ANY($2::uuid[])
        AND identity_granted = TRUE AND revoked_at IS NULL`,
    [appId, userIds],
  );
  return new Set(result.rows.map((row) => row.user_id));
}

import type { UserPreferences } from "@pqp/shared";
import { getPool } from "../db.js";

/**
 * Cross-device settings. The row is created lazily, so "never changed a
 * setting" and "reset everything to defaults" are both an absent row, and the
 * caller reads them as an empty object.
 */
export async function getPreferences(
  userId: string,
): Promise<UserPreferences> {
  const result = await getPool().query<{ settings: UserPreferences }>(
    `SELECT settings FROM user_preferences WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0]?.settings ?? {};
}

/**
 * Upsert a validated patch over whatever is stored, and return the whole
 * merged object.
 *
 * `||` is jsonb concatenation, which is a shallow merge with the right side
 * winning — so a client that only knows about some keys can never drop the
 * ones it has not heard of. Last write wins: two devices editing different
 * settings both keep theirs, two devices editing the same one settle on
 * whichever request the database saw last.
 */
export async function mergePreferences(
  userId: string,
  patch: UserPreferences,
): Promise<UserPreferences> {
  const result = await getPool().query<{ settings: UserPreferences }>(
    `INSERT INTO user_preferences (user_id, settings)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE
       SET settings = user_preferences.settings || EXCLUDED.settings,
           updated_at = NOW()
     RETURNING settings`,
    [userId, JSON.stringify(patch)],
  );
  return result.rows[0]!.settings;
}

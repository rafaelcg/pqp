import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The one-shot backfill that keeps existing accounts out of first-run onboarding.
 *
 * `schema.sql` runs on every boot, so almost everything in it is a structural
 * statement that is safe to replay. This block is not: it writes an
 * `onboardedAt` preference whose meaning is "you already existed when
 * onboarding shipped". Replaying it would keep re-applying that claim to
 * accounts created since, and every one of them would silently lose the flow.
 *
 * Two properties, and the second is the one worth a test:
 *
 *  1. it marks the accounts that were there when it first ran;
 *  2. it does not run a second time — which is what makes a new signup on the
 *     next boot still see the flow.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");

const MIGRATION = "onboarding_grandfather_2026_08";

async function insertUser(
  clerkId: string,
  displayName = clerkId,
): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO users (clerk_id, display_name) VALUES ($1, $2) RETURNING id`,
    [clerkId, displayName],
  );
  return result.rows[0]!.id;
}

async function onboardedAt(userId: string): Promise<string | undefined> {
  const result = await getPool().query<{
    settings: { onboardedAt?: string; theme?: string };
  }>(`SELECT settings FROM user_preferences WHERE user_id = $1`, [userId]);
  return result.rows[0]?.settings.onboardedAt;
}

describeDb("onboarding grandfather backfill", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users, user_preferences CASCADE`);
    // Put the database back to the moment before onboarding shipped, so the
    // block under test is armed again.
    await getPool().query(`DELETE FROM data_migrations WHERE name = $1`, [
      MIGRATION,
    ]);
  });

  it("marks every account that already existed", async () => {
    const existing = await insertUser("clerk_backfill_existing");
    await initDb();
    expect(await onboardedAt(existing)).toBeTruthy();
  });

  it("keeps the settings an existing account had already stored", async () => {
    const existing = await insertUser("clerk_backfill_settings");
    await getPool().query(
      `INSERT INTO user_preferences (user_id, settings) VALUES ($1, $2::jsonb)`,
      [existing, JSON.stringify({ theme: "light" })],
    );

    await initDb();

    const result = await getPool().query<{
      settings: { theme?: string; onboardedAt?: string };
    }>(`SELECT settings FROM user_preferences WHERE user_id = $1`, [existing]);
    expect(result.rows[0]!.settings.theme).toBe("light");
    expect(result.rows[0]!.settings.onboardedAt).toBeTruthy();
  });

  it("does not run again, so a later signup still gets onboarding", async () => {
    await insertUser("clerk_backfill_before");
    await initDb();

    // Signs up after the migration ran, then the server restarts.
    const newcomer = await insertUser("clerk_backfill_after");
    await initDb();

    expect(await onboardedAt(newcomer)).toBeUndefined();
  });

  it("leaves an account still carrying the placeholder name unmarked", async () => {
    // `placeholderDisplayName` output — either nothing was derivable from the
    // identity provider, or the email scrub above just rewrote this row. Old,
    // but never once asked what it wants to be called, which is the one thing
    // onboarding is for.
    const nameless = await insertUser("clerk_backfill_nameless", "User 3f9a");
    const named = await insertUser("clerk_backfill_named", "Rafael");

    await initDb();

    expect(await onboardedAt(nameless)).toBeUndefined();
    expect(await onboardedAt(named)).toBeTruthy();
  });

  it("does not mistake a real name that merely starts with User", async () => {
    const real = await insertUser("clerk_backfill_userish", "User Experience");
    await initDb();
    expect(await onboardedAt(real)).toBeTruthy();
  });

  it("records itself even when there is nobody to mark", async () => {
    await initDb();
    const marks = await getPool().query(
      `SELECT 1 FROM data_migrations WHERE name = $1`,
      [MIGRATION],
    );
    expect(marks.rows).toHaveLength(1);
  });
});

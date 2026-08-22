import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * First-touch acquisition, pinned against a real database.
 *
 * The two rules that matter are both in a WHERE clause, which is exactly the
 * kind of thing a unit test with a mocked pool would not exercise: the write
 * must land once and only once, and must be refused for an account that is not
 * a fresh signup. The report is checked for shape and for the exclusions that
 * keep it honest (webhook pseudo-rows and the house cast are not signups).
 */

// TEST_DATABASE_URL wins; see the note in api.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { acquisitionReport, recordAcquisition } = await import(
  "./acquisition.js"
);

describeDb("recordAcquisition", () => {
  beforeAll(async () => {
    await initDb();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await closePool();
  });

  async function freshUser(clerkId: string) {
    return upsertUser({ clerkId, displayName: "Ana", avatarUrl: null });
  }

  async function columns(userId: string) {
    const result = await getPool().query<{
      acquisition_source: string | null;
      acquisition_medium: string | null;
      acquisition_campaign: string | null;
      acquisition_gclid: string | null;
      acquisition_ref: string | null;
      acquisition_landing: string | null;
      acquisition_at: Date | null;
    }>(
      `SELECT acquisition_source, acquisition_medium, acquisition_campaign,
              acquisition_gclid, acquisition_ref, acquisition_landing,
              acquisition_at
         FROM users WHERE id = $1`,
      [userId],
    );
    return result.rows[0]!;
  }

  it("writes once, and never again", async () => {
    const user = await freshUser("clerk-ana");
    expect(
      await recordAcquisition(user.id, {
        source: "google",
        medium: "cpc",
        campaign: "tela-br",
        gclid: "abc",
        landing: "/tela",
      }),
    ).toBe(true);
    const first = await columns(user.id);
    expect(first.acquisition_source).toBe("google");
    expect(first.acquisition_campaign).toBe("tela-br");
    expect(first.acquisition_landing).toBe("/tela");
    expect(first.acquisition_ref).toBeNull();
    expect(first.acquisition_at).not.toBeNull();

    // A second campaign click, a second tab, a replayed request: all the same
    // answer. First touch means the row does not move.
    expect(
      await recordAcquisition(user.id, { source: "meta", campaign: "other" }),
    ).toBe(false);
    const second = await columns(user.id);
    expect(second.acquisition_source).toBe("google");
    expect(second.acquisition_at).toEqual(first.acquisition_at);
  });

  it("refuses an account that is not a fresh signup", async () => {
    const user = await freshUser("clerk-old");
    await getPool().query(
      `UPDATE users SET created_at = now() - interval '2 days' WHERE id = $1`,
      [user.id],
    );
    expect(await recordAcquisition(user.id, { source: "google" })).toBe(false);
    expect((await columns(user.id)).acquisition_source).toBeNull();
  });

  it("treats an all-blank payload as nothing to record", async () => {
    const user = await freshUser("clerk-blank");
    expect(await recordAcquisition(user.id, { source: "  ", ref: "" })).toBe(
      false,
    );
    expect((await columns(user.id)).acquisition_at).toBeNull();
  });

  it("reports signups grouped by source, medium, campaign and ref", async () => {
    const a = await freshUser("clerk-a");
    const b = await freshUser("clerk-b");
    const c = await freshUser("clerk-c");
    await freshUser("clerk-organic");
    await recordAcquisition(a.id, { source: "google", medium: "cpc", campaign: "x" });
    await recordAcquisition(b.id, { source: "google", medium: "cpc", campaign: "x" });
    await recordAcquisition(c.id, { source: "newsletter" });
    // Not signups: a webhook pseudo-row and a character account.
    await getPool().query(
      `UPDATE users SET is_webhook = TRUE WHERE clerk_id = 'clerk-c'`,
    );
    const ghost = await freshUser("clerk-ghost");
    await getPool().query(
      `UPDATE users SET is_character = TRUE WHERE id = $1`,
      [ghost.id],
    );

    const report = await acquisitionReport(30);
    expect(report.days).toBe(30);
    expect(report.total).toBe(3);
    expect(report.rows).toEqual([
      { source: "google", medium: "cpc", campaign: "x", ref: null, signups: 2 },
      { source: null, medium: null, campaign: null, ref: null, signups: 1 },
    ]);
  });

  // The whole point of reporting `ref`: a signup from pqp.gg/r/reddit has no
  // UTM parameters at all, so without this column it is indistinguishable in
  // the report from somebody who arrived on an untagged link.
  it("keeps a ref-only signup out of the unattributed row", async () => {
    const a = await freshUser("clerk-ref");
    await freshUser("clerk-bare");
    await recordAcquisition(a.id, { ref: "reddit", landing: "/" });

    const report = await acquisitionReport(30);
    expect(report.rows).toEqual([
      { source: null, medium: null, campaign: null, ref: "reddit", signups: 1 },
      { source: null, medium: null, campaign: null, ref: null, signups: 1 },
    ]);
  });

  it("breaks the same window down by landing page", async () => {
    const a = await freshUser("clerk-tela");
    const b = await freshUser("clerk-tela-2");
    const c = await freshUser("clerk-root");
    await freshUser("clerk-nolanding");
    await recordAcquisition(a.id, { source: "google", landing: "/tela" });
    await recordAcquisition(b.id, { source: "google", landing: "/tela" });
    await recordAcquisition(c.id, { source: "x", landing: "/" });

    const report = await acquisitionReport(30);
    expect(report.landings).toEqual([
      { landing: "/tela", signups: 2 },
      { landing: "/", signups: 1 },
    ]);
  });
});

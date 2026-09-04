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
const { acquisitionReport, recordAcquisition, retentionBySource } = await import(
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

  // ---------------------------------------------------------- retention

  describe("retentionBySource", () => {
    /** One channel for the whole describe: messages need somewhere to live. */
    let channelId: string | null = null;
    async function somewhereToPost(ownerId: string): Promise<string> {
      if (channelId) {
        return channelId;
      }
      const server = await getPool().query<{ id: string }>(
        `INSERT INTO servers (name, owner_id) VALUES ('t', $1) RETURNING id`,
        [ownerId],
      );
      const channel = await getPool().query<{ id: string }>(
        `INSERT INTO channels (server_id, name, type)
         VALUES ($1, 'geral', 'text') RETURNING id`,
        [server.rows[0]!.id],
      );
      channelId = channel.rows[0]!.id;
      return channelId;
    }

    /** A message from this user, aged so it lands inside or outside the window. */
    async function post(userId: string, daysAgo: number) {
      const where = await somewhereToPost(userId);
      await getPool().query(
        `INSERT INTO messages (channel_id, author_id, body, created_at)
         VALUES ($1, $2, 'oi', now() - ($3::int * interval '1 day'))`,
        [where, userId, daysAgo],
      );
    }

    /** Backdate a signup so it is old enough to have had a chance to return. */
    async function age(userId: string, daysAgo: number) {
      await getPool().query(
        `UPDATE users SET created_at = now() - ($2::int * interval '1 day')
          WHERE id = $1`,
        [userId, daysAgo],
      );
    }

    beforeEach(() => {
      // Every test truncates, so a cached id from the previous one is a
      // foreign key to a row that no longer exists.
      channelId = null;
    });

    it("separates a channel that keeps people from one that does not", async () => {
      // The comparison the ad budget turns on: same signups, different worth.
      const stayed = await freshUser("clerk-reddit-stay");
      const left = await freshUser("clerk-cpc-left");
      await recordAcquisition(stayed.id, { ref: "reddit" });
      await recordAcquisition(left.id, { source: "google", medium: "cpc" });
      await age(stayed.id, 10);
      await age(left.id, 10);
      await post(stayed.id, 1);
      await post(left.id, 9); // signed up, posted once, never came back

      const report = await retentionBySource(30);
      const byChannel = Object.fromEntries(
        report.rows.map((r) => [String(r.channel), r]),
      );
      expect(byChannel["reddit"]).toEqual({
        channel: "reddit",
        signups: 1,
        retained: 1,
      });
      expect(byChannel["google / cpc"]).toEqual({
        channel: "google / cpc",
        signups: 1,
        retained: 0,
      });
    });

    it("does not count somebody who signed up an hour ago as lost", async () => {
      // They have not failed to return, they have not had the chance. Counting
      // them would make a channel look worse the faster it delivers.
      const fresh = await freshUser("clerk-just-now");
      await recordAcquisition(fresh.id, { ref: "reddit" });

      const report = await retentionBySource(30);
      expect(report.rows).toEqual([]);
    });

    it("keeps the unattributed majority as its own row", async () => {
      const bare = await freshUser("clerk-bare-ret");
      await age(bare.id, 5);

      const report = await retentionBySource(30);
      expect(report.rows).toEqual([
        { channel: null, signups: 1, retained: 0 },
      ]);
    });

    it("excludes webhooks and the house cast", async () => {
      const ghost = await freshUser("clerk-ghost-ret");
      await age(ghost.id, 5);
      await getPool().query(`UPDATE users SET is_character = TRUE WHERE id = $1`, [
        ghost.id,
      ]);

      const report = await retentionBySource(30);
      expect(report.rows).toEqual([]);
    });

    it("reports the windows it used", async () => {
      const report = await retentionBySource(30, 7);
      expect(report.days).toBe(30);
      expect(report.activeWindowDays).toBe(7);
      expect(Date.parse(report.since)).toBeLessThan(Date.now());
    });
  });

});

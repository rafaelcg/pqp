import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Daily actives and signup retention, against a real database.
 *
 * What each case guards, because each is a way this could ship looking right:
 *
 *  1. **The São Paulo day.** A UTC day would split every Brazilian evening in
 *     two. 23:59 in São Paulo is 02:59 UTC the next day.
 *  2. **One row per person per day**, however many sockets and however many
 *     API processes noted them, and without a query per connection.
 *  3. **A failed flush loses nothing.** The breaker open during a blip must
 *     not become a hole in the chart.
 *  4. **No blending.** Before tracking started only messages exist, so the
 *     "active" series is null there instead of quietly message-only, and a
 *     cohort bracket that is not over yet is not counted as a failure.
 */

// TEST_DATABASE_URL wins; see the note in api.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const {
  activityDay,
  clampActivityDays,
  clampCohortWeeks,
  computeUserActivityReport,
  createUserActivityRecorder,
} = await import("./user-activity.js");

describe("activityDay", () => {
  it("is the São Paulo calendar day, not the UTC one", () => {
    expect(activityDay(Date.parse("2026-09-21T02:59:59Z"))).toBe("2026-09-20");
    expect(activityDay(Date.parse("2026-09-21T03:00:00Z"))).toBe("2026-09-21");
  });
});

describe("query clamps", () => {
  it("falls back and bounds", () => {
    expect(clampActivityDays(null)).toBe(90);
    expect(clampActivityDays("3")).toBe(14);
    expect(clampActivityDays("999")).toBe(180);
    expect(clampCohortWeeks("x")).toBe(12);
    expect(clampCohortWeeks("100")).toBe(26);
  });
});

describeDb("user activity", () => {
  beforeAll(async () => {
    await initDb();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await closePool();
  });

  async function person(clerkId: string, signup?: string) {
    const user = await upsertUser({ clerkId, displayName: clerkId, avatarUrl: null });
    if (signup) {
      await getPool().query(
        `UPDATE users SET created_at = ($2::timestamp AT TIME ZONE 'America/Sao_Paulo')
          WHERE id = $1`,
        [user.id, signup],
      );
    }
    return user.id;
  }

  async function rows(): Promise<{ user_id: string; day: string }[]> {
    const result = await getPool().query(
      `SELECT user_id, to_char(day, 'YYYY-MM-DD') AS day
         FROM user_activity_days ORDER BY day, user_id`,
    );
    return result.rows;
  }

  describe("recorder", () => {
    it("writes one row per person per day, across notes and processes", async () => {
      const ana = await person("ana");
      const now = () => Date.parse("2026-09-20T15:00:00Z");
      const a = createUserActivityRecorder({ now });
      const b = createUserActivityRecorder({ now });

      a.note(ana);
      a.note(ana);
      expect(a.stats().pending).toBe(1);
      expect(await a.flush()).toBe(1);

      // Stored today: a reconnect is not queued again.
      a.note(ana);
      expect(a.stats().pending).toBe(0);

      // The sibling API process saw the same person the same day.
      b.note(ana);
      expect(await b.flush()).toBe(0);

      expect(await rows()).toEqual([{ user_id: ana, day: "2026-09-20" }]);
    });

    it("starts a new row when the São Paulo day turns", async () => {
      const ana = await person("ana");
      let at = Date.parse("2026-09-21T02:59:00Z");
      const recorder = createUserActivityRecorder({ now: () => at });
      recorder.note(ana);
      await recorder.flush();
      at = Date.parse("2026-09-21T03:01:00Z");
      recorder.note(ana);
      await recorder.flush();
      expect((await rows()).map((r) => r.day)).toEqual(["2026-09-20", "2026-09-21"]);
    });

    it("skips the house cast and survives an account deleted before the flush", async () => {
      const ana = await person("ana");
      const cast = await person("cast");
      const gone = await person("gone");
      await getPool().query(`UPDATE users SET is_character = TRUE WHERE id = $1`, [cast]);
      const recorder = createUserActivityRecorder({
        now: () => Date.parse("2026-09-20T15:00:00Z"),
      });
      recorder.note(ana);
      recorder.note(cast);
      recorder.note(gone);
      await getPool().query(`DELETE FROM users WHERE id = $1`, [gone]);
      expect(await recorder.flush()).toBe(1);
      expect(recorder.stats().flushFailures).toBe(0);
      expect(await rows()).toEqual([{ user_id: ana, day: "2026-09-20" }]);
    });

    it("keeps what a failed flush held and writes it on the next one", async () => {
      const ana = await person("ana");
      let broken = true;
      const recorder = createUserActivityRecorder({
        now: () => Date.parse("2026-09-20T15:00:00Z"),
        pool: () => ({
          query: ((text: string, values?: unknown[]) =>
            broken
              ? Promise.reject(new Error("database unavailable"))
              : getPool().query(text, values)) as never,
        }),
      });
      recorder.note(ana);
      expect(await recorder.flush()).toBe(0);
      expect(recorder.stats()).toMatchObject({ pending: 1, flushFailures: 1 });
      expect(await rows()).toEqual([]);

      broken = false;
      expect(await recorder.flush()).toBe(1);
      expect(recorder.stats().pending).toBe(0);
      expect(await rows()).toHaveLength(1);
    });

    it("drops and counts past its bound instead of growing", () => {
      const recorder = createUserActivityRecorder({ maxPending: 2 });
      recorder.note("00000000-0000-0000-0000-000000000001");
      recorder.note("00000000-0000-0000-0000-000000000002");
      recorder.note("00000000-0000-0000-0000-000000000003");
      expect(recorder.stats()).toMatchObject({ pending: 2, dropped: 1 });
    });
  });

  describe("report", () => {
    let channelId: string | null = null;
    async function post(authorId: string, at: string) {
      if (!channelId) {
        const server = await getPool().query<{ id: string }>(
          `INSERT INTO servers (name, owner_id) VALUES ('t', $1) RETURNING id`,
          [authorId],
        );
        const channel = await getPool().query<{ id: string }>(
          `INSERT INTO channels (server_id, name, type)
           VALUES ($1, 'geral', 'text') RETURNING id`,
          [server.rows[0]!.id],
        );
        channelId = channel.rows[0]!.id;
      }
      await getPool().query(
        `INSERT INTO messages (channel_id, author_id, body, created_at)
         VALUES ($1, $2, 'oi', ($3::timestamp AT TIME ZONE 'America/Sao_Paulo'))`,
        [channelId, authorId, at],
      );
    }

    async function opened(userId: string, day: string) {
      await getPool().query(
        `INSERT INTO user_activity_days (user_id, day) VALUES ($1, $2)`,
        [userId, day],
      );
    }

    beforeEach(() => {
      channelId = null;
    });

    it("keeps the two measures apart and only counts brackets that are over", async () => {
      // Tracking starts 2026-09-10. Today is Sunday 2026-09-20 in São Paulo.
      const ana = await person("ana", "2026-09-01 12:00");
      const bia = await person("bia", "2026-09-09 12:00");
      const cast = await person("cast", "2026-09-09 12:00");
      const hook = await person("hook", "2026-09-09 12:00");
      await getPool().query(`UPDATE users SET is_character = TRUE WHERE id = $1`, [cast]);
      await getPool().query(`UPDATE users SET is_webhook = TRUE WHERE id = $1`, [hook]);

      await post(ana, "2026-09-05 20:00");
      await post(ana, "2026-09-08 23:30");
      await post(hook, "2026-09-19 10:00");
      await opened(ana, "2026-09-10");
      await opened(ana, "2026-09-19");
      await opened(bia, "2026-09-10");
      await opened(bia, "2026-09-17");
      await opened(cast, "2026-09-19");

      const report = await computeUserActivityReport(
        { days: 14, weeks: 4 },
        { now: Date.parse("2026-09-20T15:00:00Z") },
      );
      expect(report.today).toBe("2026-09-20");
      expect(report.trackingSince).toBe("2026-09-10");
      expect(report.days).toHaveLength(14);
      const day = (d: string) => report.days.find((row) => row.day === d)!;

      // Before tracking: no "active" figure at all, messages still counted.
      expect(day("2026-09-08")).toMatchObject({ dau: null, postedDau: 1 });
      // Bots and the house cast never count.
      expect(day("2026-09-19")).toMatchObject({ dau: 1, postedDau: 0 });
      expect(day("2026-09-10").dau).toBe(2);
      // A 7-day window reaching back before tracking is null, not a low number.
      expect(day("2026-09-10").wau).toBeNull();
      expect(day("2026-09-10").postedWau).toBe(1);
      expect(day("2026-09-16").wau).toBe(2);
      expect(day("2026-09-20").mau).toBeNull();

      expect(report.cohorts.map((c) => [c.week, c.size])).toEqual([
        ["2026-08-31", 1],
        ["2026-09-07", 1],
      ]);
      const [first, second] = report.cohorts;
      // Ana: day 1 and week 1 are over; week 1 had a message; both brackets
      // predate tracking, so "active" has nobody eligible rather than a zero.
      expect(first!.d1).toEqual({ eligible: 1, posted: 0, activeEligible: 0, active: 0 });
      expect(first!.d7).toEqual({ eligible: 1, posted: 1, activeEligible: 0, active: 0 });
      expect(first!.d30.eligible).toBe(0);
      // Bia: came back on day 1; her week 1 ends 2026-09-22, so it is not a
      // failure yet, it is not counted.
      expect(second!.d1).toEqual({ eligible: 1, posted: 0, activeEligible: 1, active: 1 });
      expect(second!.d7).toEqual({ eligible: 0, posted: 0, activeEligible: 0, active: 0 });
    });

    it("reports no tracking without inventing zeros", async () => {
      await person("ana", "2026-09-01 12:00");
      const report = await computeUserActivityReport(
        { days: 14, weeks: 4 },
        { now: Date.parse("2026-09-20T15:00:00Z") },
      );
      expect(report.trackingSince).toBeNull();
      expect(report.days.every((row) => row.dau === null)).toBe(true);
      expect(report.cohorts[0]!.d1.activeEligible).toBe(0);
    });
  });
});

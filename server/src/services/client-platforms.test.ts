import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Which app a person connected from, against a real database.
 *
 * What each case guards:
 *
 *  1. **Families only.** The row holds platform, our version, OS family and
 *     browser family; the raw user agent has nowhere to go.
 *  2. **No write per connection.** A reconnect with the same facts is not
 *     queued again inside the hour, and a change is.
 *  3. **One row per (account, platform)**, latest wins, across processes.
 *  4. **Retention and erasure.** The sweep removes what was not seen for 90
 *     days and nothing else; deleting the account removes the rest.
 *  5. **The read.** Newest first, and a stale row is not served even before
 *     the sweep has run.
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
  CLIENT_PLATFORM_REFRESH_MS,
  CLIENT_PLATFORM_RETENTION_DAYS,
  createClientPlatformRecorder,
  resolveUserClientTarget,
  sweepClientPlatforms,
  userClientReport,
} = await import("./client-platforms.js");
const { parseClientAgent } = await import("../lib/client-agent.js");

const CHROME_WIN = parseClientAgent(
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
);
const FIREFOX_WIN = parseClientAgent(
  "Mozilla/5.0 (Windows NT 10.0; Win64; rv:131.0) Gecko/20100101 Firefox/131.0",
);
const DESKTOP = parseClientAgent(
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) pqp/0.2.7 Chrome/128.0.0.0 Electron/32.2.0 Safari/537.36",
);
const ANDROID = parseClientAgent("okhttp/5.0.0");
const NOBODY = parseClientAgent(undefined);

describeDb("client platforms", () => {
  beforeAll(async () => {
    await initDb();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await closePool();
  });

  async function person(clerkId: string) {
    const user = await upsertUser({ clerkId, displayName: clerkId, avatarUrl: null });
    return user.id;
  }

  async function rows(userId: string) {
    const result = await getPool().query(
      `SELECT platform, app_version, os_family, browser_family
         FROM user_client_platforms WHERE user_id = $1 ORDER BY platform`,
      [userId],
    );
    return result.rows;
  }

  it("has no column that could hold a user agent, an address or a device", async () => {
    const result = await getPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'user_client_platforms' ORDER BY ordinal_position`,
    );
    expect(result.rows.map((r) => r.column_name)).toEqual([
      "user_id",
      "platform",
      "app_version",
      "os_family",
      "browser_family",
      "first_seen_at",
      "last_seen_at",
    ]);
  });

  describe("recorder", () => {
    it("stores families, one row per platform, and the desktop app's version", async () => {
      const ana = await person("ana");
      const recorder = createClientPlatformRecorder();
      recorder.note(ana, CHROME_WIN);
      recorder.note(ana, DESKTOP);
      recorder.note(ana, ANDROID);
      expect(await recorder.flush()).toBe(3);
      expect(await rows(ana)).toEqual([
        { platform: "android", app_version: null, os_family: "android", browser_family: null },
        { platform: "desktop", app_version: "0.2.7", os_family: "macos", browser_family: "electron" },
        { platform: "web", app_version: null, os_family: "windows", browser_family: "chrome" },
      ]);
    });

    it("says nothing for a client it cannot identify", async () => {
      const ana = await person("ana");
      const recorder = createClientPlatformRecorder();
      recorder.note(ana, NOBODY);
      expect(recorder.stats().pending).toBe(0);
      expect(await recorder.flush()).toBe(0);
      expect(await rows(ana)).toEqual([]);
    });

    it("does not write again for the same facts inside the hour, and does for a change", async () => {
      const ana = await person("ana");
      let at = Date.parse("2026-10-01T12:00:00Z");
      const recorder = createClientPlatformRecorder({ now: () => at });
      recorder.note(ana, CHROME_WIN);
      await recorder.flush();

      // A reconnect herd: same account, same facts, nothing queued.
      for (let i = 0; i < 50; i += 1) {
        recorder.note(ana, CHROME_WIN);
      }
      expect(recorder.stats().pending).toBe(0);

      // The same platform on another browser is a change, and replaces the row.
      recorder.note(ana, FIREFOX_WIN);
      expect(recorder.stats().pending).toBe(1);
      await recorder.flush();
      expect((await rows(ana))[0]).toMatchObject({ platform: "web", browser_family: "firefox" });

      // Past the hour the same facts are written once more, to move last_seen.
      at += CLIENT_PLATFORM_REFRESH_MS + 1;
      recorder.note(ana, FIREFOX_WIN);
      expect(recorder.stats().pending).toBe(1);
    });

    it("keeps the first sighting and moves the last, across processes", async () => {
      const ana = await person("ana");
      const a = createClientPlatformRecorder();
      const b = createClientPlatformRecorder();
      a.note(ana, CHROME_WIN);
      await a.flush();
      await getPool().query(
        `UPDATE user_client_platforms
            SET first_seen_at = NOW() - INTERVAL '5 days', last_seen_at = NOW() - INTERVAL '5 days'
          WHERE user_id = $1`,
        [ana],
      );
      b.note(ana, FIREFOX_WIN);
      await b.flush();

      const result = await getPool().query<{ first_old: boolean; last_new: boolean }>(
        `SELECT first_seen_at < NOW() - INTERVAL '4 days' AS first_old,
                last_seen_at > NOW() - INTERVAL '1 minute' AS last_new
           FROM user_client_platforms WHERE user_id = $1`,
        [ana],
      );
      expect(result.rows).toEqual([{ first_old: true, last_new: true }]);
      expect(await rows(ana)).toHaveLength(1);
    });

    it("skips the house cast and survives an account deleted before the flush", async () => {
      const ana = await person("ana");
      const cast = await person("cast");
      const gone = await person("gone");
      await getPool().query(`UPDATE users SET is_character = TRUE WHERE id = $1`, [cast]);
      const recorder = createClientPlatformRecorder();
      recorder.note(ana, CHROME_WIN);
      recorder.note(cast, CHROME_WIN);
      recorder.note(gone, CHROME_WIN);
      await getPool().query(`DELETE FROM users WHERE id = $1`, [gone]);
      expect(await recorder.flush()).toBe(1);
      expect(recorder.stats().flushFailures).toBe(0);
    });

    it("keeps everything when a flush fails, and lands it on the next", async () => {
      const ana = await person("ana");
      let broken = true;
      const recorder = createClientPlatformRecorder({
        pool: () => ({
          query: ((...args: unknown[]) =>
            broken
              ? Promise.reject(new Error("breaker open"))
              : (getPool().query as (...a: unknown[]) => unknown)(...args)) as never,
        }),
      });
      recorder.note(ana, CHROME_WIN);
      await recorder.flush();
      expect(recorder.stats()).toMatchObject({ flushFailures: 1, pending: 1 });
      broken = false;
      expect(await recorder.flush()).toBe(1);
      expect(await rows(ana)).toHaveLength(1);
    });

    it("drops, and counts, notes past its bound instead of growing", async () => {
      const recorder = createClientPlatformRecorder({ maxPending: 2 });
      const ids = [await person("a"), await person("b"), await person("c")];
      for (const id of ids) {
        recorder.note(id, CHROME_WIN);
      }
      expect(recorder.stats()).toMatchObject({ pending: 2, dropped: 1 });
    });
  });

  describe("retention", () => {
    it("deletes only rows not seen for the retention window", async () => {
      const ana = await person("ana");
      const recorder = createClientPlatformRecorder();
      recorder.note(ana, CHROME_WIN);
      recorder.note(ana, DESKTOP);
      await recorder.flush();
      await getPool().query(
        `UPDATE user_client_platforms
            SET last_seen_at = NOW() - make_interval(days => $2)
          WHERE user_id = $1 AND platform = 'web'`,
        [ana, CLIENT_PLATFORM_RETENTION_DAYS + 1],
      );
      expect(await sweepClientPlatforms()).toBe(1);
      expect((await rows(ana)).map((r) => r.platform)).toEqual(["desktop"]);
    });

    it("goes with the account", async () => {
      const ana = await person("ana");
      const recorder = createClientPlatformRecorder();
      recorder.note(ana, CHROME_WIN);
      await recorder.flush();
      await getPool().query(`DELETE FROM users WHERE id = $1`, [ana]);
      const left = await getPool().query(`SELECT 1 FROM user_client_platforms`);
      expect(left.rowCount).toBe(0);
    });
  });

  describe("the read", () => {
    it("answers newest first with a latest, and what it cannot know", async () => {
      const ana = await person("ana");
      const recorder = createClientPlatformRecorder();
      recorder.note(ana, CHROME_WIN);
      recorder.note(ana, ANDROID);
      await recorder.flush();
      await getPool().query(
        `UPDATE user_client_platforms SET last_seen_at = NOW() - INTERVAL '2 days'
          WHERE user_id = $1 AND platform = 'web'`,
        [ana],
      );
      const report = await userClientReport(ana);
      expect(report.clients.map((c) => c.platform)).toEqual(["android", "web"]);
      expect(report.latest?.platform).toBe("android");
      expect(report.retentionDays).toBe(CLIENT_PLATFORM_RETENTION_DAYS);
      expect(report.notRecorded).toContain("android app version");
      // The raw string was never kept, so it cannot be here.
      expect(JSON.stringify(report)).not.toMatch(/Mozilla|okhttp|AppleWebKit/);
    });

    it("is empty, not an error, for somebody never seen, and hides a stale row", async () => {
      const ana = await person("ana");
      expect(await userClientReport(ana)).toMatchObject({ latest: null, clients: [] });

      const recorder = createClientPlatformRecorder();
      recorder.note(ana, CHROME_WIN);
      await recorder.flush();
      await getPool().query(
        `UPDATE user_client_platforms
            SET last_seen_at = NOW() - make_interval(days => $2) WHERE user_id = $1`,
        [ana, CLIENT_PLATFORM_RETENTION_DAYS + 1],
      );
      expect((await userClientReport(ana)).clients).toEqual([]);
    });

    it("finds a person by id, handle or tag, and by nothing else", async () => {
      const ana = await person("ana");
      await getPool().query(`UPDATE users SET handle = 'anabela' WHERE id = $1`, [ana]);
      const tag = await getPool().query<{ username: string; discriminator: string }>(
        `SELECT username, discriminator FROM users WHERE id = $1`,
        [ana],
      );
      const { username, discriminator } = tag.rows[0]!;
      expect(await resolveUserClientTarget({ userId: ana })).toBe(ana);
      expect(await resolveUserClientTarget({ handle: "@Anabela" })).toBe(ana);
      expect(await resolveUserClientTarget({ tag: `${username}#${discriminator}` })).toBe(ana);
      expect(await resolveUserClientTarget({ handle: "nobody" })).toBeNull();
      expect(await resolveUserClientTarget({ tag: "no tag" })).toBeNull();
      expect(
        await resolveUserClientTarget({ userId: "00000000-0000-4000-8000-000000000001" }),
      ).toBeNull();
    });
  });
});

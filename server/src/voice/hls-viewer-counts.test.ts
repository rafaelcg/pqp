import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Watch party viewer counts (`hls-viewer-counts.ts`) on a real Postgres:
 * the per-minute flush bound, two API processes that both saw some of the
 * same audience, and the numbers the history dialog reads.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const {
  createHlsViewerCounter,
  hlsViewerMinutes,
  liveHlsViewerSessions,
  hlsViewerAudience,
  resetHlsViewerAudienceCacheForTests,
  presentHlsViewers,
  peekPresentHlsViewers,
  resetHlsPresentCacheForTests,
  HLS_VIEWER_EVAL_LAG_MS,
  HLS_VIEWER_FLUSH_INTERVAL_MS,
  HLS_VIEWER_PRESENT_TOLERANCE_MS,
  HLS_PRESENCE_MAX_AGE_MS,
  HLS_PRESENCE_READ_CACHE_MS,
} = await import("./hls-viewer-counts.js");
const { listWatchPartyHistory } = await import("./hls-history.js");

const STARTED_AT = 1_700_000_040_000;
/** A wall clock well after the broadcast started, on a minute boundary. */
const T0 = Date.UTC(2026, 8, 23, 21, 0, 0);

function userId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/**
 * A pool that counts the statements a flush sends, so the bound is asserted
 * on what reaches Postgres rather than on a counter the module keeps itself.
 */
function countingPool() {
  const calls: string[] = [];
  return {
    calls,
    pool: () => ({
      query: ((text: string, values?: unknown[]) => {
        calls.push(text);
        return getPool().query(text, values);
      }) as ReturnType<typeof getPool>["query"],
    }),
  };
}

function isFlushWrite(sql: string): boolean {
  return /^\s*(INSERT|WITH)/.test(sql);
}

describeDb("watch party viewer counts", () => {
  let channelId: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(
      `TRUNCATE users, servers, channels, hls_sessions,
                hls_session_viewers, hls_session_viewer_minutes,
                hls_session_viewer_stats, hls_session_presence,
                voice_rooms, voice_peers RESTART IDENTITY CASCADE`,
    );
    resetHlsViewerAudienceCacheForTests();
    resetHlsPresentCacheForTests();
    const owner = await upsertUser({
      clerkId: "clerk_hls_viewer_counts",
      displayName: "Host",
      avatarUrl: null,
    });
    const server = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('Sala', $1) RETURNING id`,
      [owner.id],
    );
    const channel = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position)
       VALUES ($1, 'cinema', 'watch_party', 0) RETURNING id`,
      [server.rows[0]!.id],
    );
    channelId = channel.rows[0]!.id;
  });

  it("writes at most once a minute per broadcast, however many heartbeats arrive", async () => {
    let now = T0;
    const { calls, pool } = countingPool();
    const counter = createHlsViewerCounter({ now: () => now, pool });

    // 300 viewers polling every two seconds for a minute: 9,000 sightings.
    for (let second = 0; second < 60; second += 2) {
      now = T0 + second * 1000;
      for (let n = 1; n <= 300; n += 1) {
        counter.note(channelId, STARTED_AT, userId(n), "playlist");
      }
      // The timer ticks every 15 s; ticking every poll is strictly worse.
      await counter.flushDue();
    }
    // One write for the whole minute. (The hourly prune is a DELETE and not
    // counted.)
    expect(calls.filter(isFlushWrite)).toHaveLength(1);

    now = T0 + HLS_VIEWER_FLUSH_INTERVAL_MS;
    counter.note(channelId, STARTED_AT, userId(1), "presence");
    await counter.flushDue();
    expect(calls.filter(isFlushWrite)).toHaveLength(2);

    // Still watching a minute later. Concurrency is read at an instant
    // HLS_VIEWER_EVAL_LAG_MS in the past, which all 300 now cover.
    now = T0 + 2 * HLS_VIEWER_FLUSH_INTERVAL_MS;
    for (let n = 1; n <= 300; n += 1) {
      counter.note(channelId, STARTED_AT, userId(n), "presence");
    }
    const [flushed] = await counter.flushDue();
    expect(calls.filter(isFlushWrite)).toHaveLength(3);
    expect(flushed).toMatchObject({ liveViewers: 300, peakViewers: 300, uniqueViewers: 300 });
    expect(counter.stats().flushes).toBe(3);
  });

  it("does not write at all for a minute with no sightings", async () => {
    let now = T0;
    const { calls, pool } = countingPool();
    const counter = createHlsViewerCounter({ now: () => now, pool });
    counter.note(channelId, STARTED_AT, userId(1), "presence");
    await counter.flushDue();
    const afterFirst = calls.length;
    now = T0 + 5 * HLS_VIEWER_FLUSH_INTERVAL_MS;
    await counter.flushDue();
    expect(calls.slice(afterFirst)).toEqual([]);
    expect(counter.stats().trackedSessions).toBe(0);
  });

  it("counts the union of two API processes, never the sum", async () => {
    let now = T0;
    const a = createHlsViewerCounter({ now: () => now });
    const b = createHlsViewerCounter({ now: () => now });

    // HTTP is balanced per request, so viewers 1-60 land on A, 41-100 on B:
    // 41-60 hit both.
    for (let n = 1; n <= 60; n += 1) {
      a.note(channelId, STARTED_AT, userId(n), "presence");
    }
    for (let n = 41; n <= 100; n += 1) {
      b.note(channelId, STARTED_AT, userId(n), "presence");
    }
    now = T0 + HLS_VIEWER_EVAL_LAG_MS + 10_000;
    const [fromA] = await a.flushDue();
    expect(fromA).toMatchObject({ liveViewers: 60, uniqueViewers: 60 });
    now += 10_000;
    const [fromB] = await b.flushDue();
    expect(fromB).toMatchObject({ liveViewers: 100, peakViewers: 100, uniqueViewers: 100 });

    // Later: 51-100 left, 1-50 are still watching and all land on A.
    now = T0 + 150_000;
    for (let n = 1; n <= 50; n += 1) {
      a.note(channelId, STARTED_AT, userId(n), "presence");
    }
    now = T0 + 150_000 + HLS_VIEWER_EVAL_LAG_MS;
    expect(await b.flushDue()).toEqual([]); // nothing new on B: no write
    const [later] = await a.flushDue();
    expect(later).toMatchObject({ liveViewers: 50, peakViewers: 100, uniqueViewers: 100 });

    const stats = await getPool().query<{ peak_viewers: number; unique_viewers: number }>(
      `SELECT peak_viewers, unique_viewers FROM hls_session_viewer_stats
        WHERE channel_id = $1 AND started_at_ms = $2`,
      [channelId, STARTED_AT],
    );
    expect(stats.rows).toEqual([{ peak_viewers: 100, unique_viewers: 100 }]);

    const minutes = await hlsViewerMinutes(channelId, STARTED_AT);
    expect(minutes.map((row) => row.viewers)).toEqual([100, 50]);
  });

  it("does not count people who watched one after the other as simultaneous", async () => {
    // Farol on #799: a rolling "seen in the last two minutes" window would
    // report a peak of 100 here. Fifty people watch for a minute and leave;
    // a minute later fifty others arrive and watch for two.
    let now = T0;
    const counter = createHlsViewerCounter({ now: () => now });
    for (let t = 0; t <= 400_000; t += 15_000) {
      now = T0 + t;
      if (t % 30_000 === 0) {
        if (t <= 60_000) {
          for (let n = 1; n <= 50; n += 1) {
            counter.note(channelId, STARTED_AT, userId(n), "presence");
          }
        }
        if (t >= 120_000 && t <= 240_000) {
          for (let n = 51; n <= 100; n += 1) {
            counter.note(channelId, STARTED_AT, userId(n), "presence");
          }
        }
      }
      await counter.flushDue();
    }
    const stats = await getPool().query<{ peak_viewers: number; unique_viewers: number }>(
      `SELECT peak_viewers, unique_viewers FROM hls_session_viewer_stats
        WHERE channel_id = $1 AND started_at_ms = $2`,
      [channelId, STARTED_AT],
    );
    expect(stats.rows).toEqual([{ peak_viewers: 50, unique_viewers: 100 }]);
  });

  it("keeps the higher reading of a minute when the other process flushes a lower one", async () => {
    let now = T0;
    const a = createHlsViewerCounter({ now: () => now });
    const b = createHlsViewerCounter({ now: () => now });
    for (let n = 1; n <= 30; n += 1) {
      a.note(channelId, STARTED_AT, userId(n), "presence");
    }
    now = T0 + HLS_VIEWER_EVAL_LAG_MS + 10_000;
    await a.flushDue();
    // B flushes later in the same evaluated minute with a lower reading.
    b.note(channelId, STARTED_AT, userId(99), "presence");
    await getPool().query(
      `UPDATE hls_session_viewers SET last_seen_at = last_seen_at - interval '10 minutes'
        WHERE user_id <> $1`,
      [userId(99)],
    );
    now += 5_000;
    await b.flushDue();
    const minutes = await hlsViewerMinutes(channelId, STARTED_AT);
    expect(minutes).toHaveLength(1);
    expect(minutes[0]!.viewers).toBe(30);
  });

  it("feeds the history dialog and the admin metrics, as counts only", async () => {
    await getPool().query(
      `INSERT INTO hls_sessions (channel_id, object_prefix, started_at, ended_at, rung)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), NOW(), '720p30')`,
      [channelId, `live/${channelId}/${STARTED_AT}-720p30`, STARTED_AT],
    );
    // Real wall clock: the admin read compares against the database's NOW().
    let now = Date.now() - HLS_VIEWER_EVAL_LAG_MS - 10_000;
    const counter = createHlsViewerCounter({ now: () => now });
    for (let n = 1; n <= 7; n += 1) {
      counter.note(channelId, STARTED_AT, userId(n), "presence");
    }
    now += HLS_VIEWER_EVAL_LAG_MS + 10_000;
    await counter.flushDue();

    const history = await listWatchPartyHistory(channelId, 10);
    expect(history).toHaveLength(1);
    expect(history[0]!.viewers).toEqual({ peak: 7, unique: 7 });

    // "Watching now" is the presence rows, not the flushed ones: the seven are
    // still on the playlist at this instant, so they beat again and the
    // process republishes who it saw.
    for (let n = 1; n <= 7; n += 1) {
      counter.note(channelId, STARTED_AT, userId(n), "presence");
    }
    await counter.publishPresence();

    const live = await liveHlsViewerSessions();
    expect(live).toEqual([
      {
        channelId,
        channel: "cinema",
        server: "Sala",
        community: null,
        startedAt: STARTED_AT,
        liveViewers: 7,
        peakViewers: 7,
        uniqueViewers: 7,
      },
    ]);
    expect(JSON.stringify(live)).not.toContain(userId(1));

    // A community's broadcast says so, with its public address.
    await getPool().query(
      `UPDATE servers SET is_community = TRUE, is_community_listed = TRUE, community_slug = 'sala'
        WHERE name = 'Sala'`,
    );
    const tagged = await liveHlsViewerSessions();
    expect(tagged[0]!.community).toEqual({ slug: "sala", listed: true, suspended: false });
  });

  it("shows no count for a broadcast nobody was counted on", async () => {
    await getPool().query(
      `INSERT INTO hls_sessions (channel_id, object_prefix, started_at, ended_at, rung)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), NOW(), '720p30')`,
      [channelId, `live/${channelId}/${STARTED_AT}-720p30`, STARTED_AT],
    );
    const history = await listWatchPartyHistory(channelId, 10);
    expect(history[0]!.viewers).toBeNull();
  });

  it("keeps a failed flush's sightings through a long outage and asks the database once a minute", async () => {
    let now = T0;
    let fail = true;
    const query = vi.fn((text: string, values?: unknown[]) =>
      fail ? Promise.reject(new Error("pool down")) : getPool().query(text, values),
    );
    const counter = createHlsViewerCounter({
      now: () => now,
      pool: () => ({ query }) as unknown as ReturnType<typeof getPool>,
    });
    counter.note(channelId, STARTED_AT, userId(1), "presence");
    await counter.flushDue();
    now = T0 + 15_000;
    await counter.flushDue();
    const flushWrites = () =>
      query.mock.calls.filter(([sql]) => isFlushWrite(sql)).length;
    expect(flushWrites()).toBe(1);
    expect(counter.stats().flushFailures).toBe(1);

    // A ten-minute outage, well past the live window: the sighting is kept
    // and the broadcast keeps its slot, not stranded or forgotten.
    for (let minute = 1; minute <= 10; minute += 1) {
      now = T0 + minute * HLS_VIEWER_FLUSH_INTERVAL_MS;
      await counter.flushDue();
    }
    expect(counter.stats()).toMatchObject({ trackedSessions: 1, flushFailures: 11 });

    fail = false;
    now = T0 + 11 * HLS_VIEWER_FLUSH_INTERVAL_MS;
    const [flushed] = await counter.flushDue();
    expect(flushed).toMatchObject({ uniqueViewers: 1 });
    // Stored now, so it can be let go once it ages out.
    now += HLS_VIEWER_FLUSH_INTERVAL_MS;
    await counter.flushDue();
    expect(counter.stats().trackedSessions).toBe(0);
  });

  describe("audience: device class and foreground / background time", () => {
    async function rows() {
      const result = await getPool().query<{
        user_id: string;
        device_class: string | null;
        visible_ms: string;
        hidden_ms: string;
      }>(
        `SELECT v.user_id::text, v.device_class,
                (SELECT COALESCE(SUM((e.value->>'v')::bigint), 0) FROM jsonb_each(v.detail) e)::text AS visible_ms,
                (SELECT COALESCE(SUM((e.value->>'h')::bigint), 0) FROM jsonb_each(v.detail) e)::text AS hidden_ms
           FROM hls_session_viewers v
          WHERE v.channel_id = $1 AND v.started_at_ms = $2
          ORDER BY v.user_id`,
        [channelId, STARTED_AT],
      );
      return result.rows;
    }

    it("sums a viewer's beats across flushes and across two API processes", async () => {
      let now = T0;
      const a = createHlsViewerCounter({ now: () => now });
      const b = createHlsViewerCounter({ now: () => now });
      // The same phone's beats are balanced across both machines.
      a.note(channelId, STARTED_AT, userId(1), "presence", {
        device: "phone",
        visibleMs: 20_000,
        hiddenMs: 10_000,
      });
      b.note(channelId, STARTED_AT, userId(1), "presence", {
        device: "phone",
        visibleMs: 5_000,
        hiddenMs: 25_000,
      });
      a.note(channelId, STARTED_AT, userId(2), "presence", {
        device: "desktop",
        visibleMs: 30_000,
        hiddenMs: 0,
      });
      // A client that predates the report: no detail at all.
      a.note(channelId, STARTED_AT, userId(3), "presence");
      now = T0 + 5_000;
      await a.flushDue();
      await b.flushDue();
      // A second minute, the phone again, on A.
      now = T0 + HLS_VIEWER_FLUSH_INTERVAL_MS + 5_000;
      a.note(channelId, STARTED_AT, userId(1), "presence", {
        device: "phone",
        visibleMs: 30_000,
      });
      await a.flushDue();
      // A flush with nothing new re-sends the same cumulative value.
      now += HLS_VIEWER_FLUSH_INTERVAL_MS;
      a.note(channelId, STARTED_AT, userId(1), "presence");
      await a.flushDue();

      expect(await rows()).toEqual([
        { user_id: userId(1), device_class: "phone", visible_ms: "55000", hidden_ms: "35000" },
        { user_id: userId(2), device_class: "desktop", visible_ms: "30000", hidden_ms: "0" },
        { user_id: userId(3), device_class: null, visible_ms: "0", hidden_ms: "0" },
      ]);
    });

    it("keeps a failed flush's beats, and a retry of a statement that had committed counts once", async () => {
      let now = T0;
      let mode: "down" | "commit-then-fail" | "ok" = "down";
      const counter = createHlsViewerCounter({
        now: () => now,
        pool: () => ({
          query: (async (text: string, values?: unknown[]) => {
            if (!isFlushWrite(text) || mode === "ok") {
              return getPool().query(text, values);
            }
            if (mode === "down") {
              throw new Error("db down");
            }
            // The statement reaches Postgres and commits; the reply is lost.
            await getPool().query(text, values);
            throw new Error("timeout after commit");
          }) as ReturnType<typeof getPool>["query"],
        }),
      });
      counter.note(channelId, STARTED_AT, userId(1), "presence", {
        device: "tablet",
        visibleMs: 30_000,
        hiddenMs: 0,
      });
      await counter.flushDue();
      expect(counter.stats().flushFailures).toBe(1);
      expect(await rows()).toEqual([]);

      // Committed but reported as failed: the row is there, and stays right
      // however many times the same state is written again.
      mode = "commit-then-fail";
      now = T0 + HLS_VIEWER_FLUSH_INTERVAL_MS;
      counter.note(channelId, STARTED_AT, userId(1), "presence", {
        visibleMs: 10_000,
        hiddenMs: 20_000,
      });
      await counter.flushDue();
      expect(counter.stats().flushFailures).toBe(2);
      for (const minute of [2, 3]) {
        now = T0 + minute * HLS_VIEWER_FLUSH_INTERVAL_MS;
        await counter.flushDue();
      }
      mode = "ok";
      now = T0 + 4 * HLS_VIEWER_FLUSH_INTERVAL_MS;
      await counter.flushDue();
      expect(await rows()).toEqual([
        { user_id: userId(1), device_class: "tablet", visible_ms: "40000", hidden_ms: "20000" },
      ]);

      // Stored means owed no more: a flush with nothing new adds nothing.
      now += HLS_VIEWER_FLUSH_INTERVAL_MS;
      counter.note(channelId, STARTED_AT, userId(1), "presence");
      await counter.flushDue();
      expect((await rows())[0]).toMatchObject({ visible_ms: "40000", hidden_ms: "20000" });
    });

    it("a viewer who comes back after leaving the map adds a new share, not a clobber", async () => {
      let now = T0;
      const counter = createHlsViewerCounter({ now: () => now });
      counter.note(channelId, STARTED_AT, userId(1), "presence", { visibleMs: 30_000 });
      await counter.flushDue();
      // Long gone: stored and expired out of this process's map.
      now = T0 + 10 * HLS_VIEWER_FLUSH_INTERVAL_MS;
      await counter.flushDue();
      expect(counter.stats().trackedSessions).toBe(0);
      counter.note(channelId, STARTED_AT, userId(1), "presence", { visibleMs: 5_000 });
      await counter.flushDue();
      expect((await rows())[0]).toMatchObject({ visible_ms: "35000" });
    });

    it("reports counts and seconds per broadcast, with new accounts split out, and no user id", async () => {
      // Two real accounts: one created before the broadcast, one after.
      const old = await upsertUser({
        clerkId: "clerk_aud_old",
        displayName: "Old",
        avatarUrl: null,
      });
      const fresh = await upsertUser({
        clerkId: "clerk_aud_new",
        displayName: "New",
        avatarUrl: null,
      });
      await getPool().query(
        `UPDATE users SET created_at = to_timestamp($2 / 1000.0) - interval '30 days' WHERE id = $1`,
        [old.id, STARTED_AT],
      );
      await getPool().query(
        `UPDATE users SET created_at = to_timestamp($2 / 1000.0) + interval '5 minutes' WHERE id = $1`,
        [fresh.id, STARTED_AT],
      );
      const now = Date.now();
      const counter = createHlsViewerCounter({ now: () => now });
      counter.note(channelId, STARTED_AT, old.id, "presence", {
        device: "desktop",
        visibleMs: 90_000,
      });
      counter.note(channelId, STARTED_AT, fresh.id, "presence", {
        device: "phone",
        visibleMs: 30_000,
        hiddenMs: 90_000,
      });
      counter.note(channelId, STARTED_AT, userId(9), "presence");
      await counter.flushDue({ force: true });

      const audience = await hlsViewerAudience();
      expect(audience).toEqual([
        {
          channelId,
          startedAt: STARTED_AT,
          viewers: 3,
          byDevice: { phone: 1, tablet: 0, desktop: 1, unknown: 1 },
          newAccountsByDevice: { phone: 1, tablet: 0, desktop: 0, unknown: 0 },
          visibleSeconds: 120,
          hiddenSeconds: 90,
          hiddenShare: 0.429,
          reportingViewers: 2,
        },
      ]);
      expect(JSON.stringify(audience)).not.toContain(fresh.id);
    });

    it("only looks at the most recent broadcasts, and serves a cached answer inside a minute", async () => {
      const now = Date.now();
      const counter = createHlsViewerCounter({ now: () => now });
      // Three broadcasts, the oldest stats row a day and a half stale.
      for (const [i, started] of [STARTED_AT, STARTED_AT + 1, STARTED_AT + 2].entries()) {
        counter.note(channelId, started, userId(i + 1), "presence", { device: "phone" });
      }
      await counter.flushDue({ force: true });
      await getPool().query(
        `UPDATE hls_session_viewer_stats SET updated_at = NOW() - interval '36 hours'
          WHERE started_at_ms = $1`,
        [STARTED_AT],
      );
      const two = await hlsViewerAudience(2);
      expect(two.map((row) => row.startedAt).sort()).toEqual([STARTED_AT + 1, STARTED_AT + 2]);
      // The stale one is outside the day even with room to spare.
      resetHlsViewerAudienceCacheForTests();
      expect((await hlsViewerAudience(10)).map((row) => row.startedAt).sort()).toEqual([
        STARTED_AT + 1,
        STARTED_AT + 2,
      ]);
      // Cached: a change in the table is not seen inside the minute.
      await getPool().query(`DELETE FROM hls_session_viewers`);
      expect(await hlsViewerAudience(10)).toHaveLength(2);
    });

    it("stores nothing but the three classes", async () => {
      await expect(
        getPool().query(
          `INSERT INTO hls_session_viewers
             (channel_id, started_at_ms, user_id, first_seen_at, last_seen_at, device_class)
           VALUES ($1, $2, $3, now(), now(), 'Mozilla/5.0')`,
          [channelId, STARTED_AT, userId(1)],
        ),
      ).rejects.toThrow();
    });
  });

  describe("watching right now (hls_session_presence)", () => {
    async function seat(user: string) {
      await getPool().query(
        `INSERT INTO voice_rooms (channel_id, transport) VALUES ($1, 'livekit')
         ON CONFLICT DO NOTHING`,
        [channelId],
      );
      await getPool().query(
        `INSERT INTO voice_peers (peer_id, channel_id, user_id, instance_id, display_name)
         VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), 'x')`,
        [channelId, user],
      );
    }

    function presenceReads(spy: { mock: { calls: unknown[][] } }): number {
      return spy.mock.calls.filter((call) =>
        /FROM hls_session_presence/.test(String(call[0])),
      ).length;
    }

    it("publishes only who was seen within the heartbeat tolerance", async () => {
      let now = T0;
      const counter = createHlsViewerCounter({ now: () => now });
      counter.note(channelId, STARTED_AT, userId(1), "presence");
      now = T0 + 20_000;
      counter.note(channelId, STARTED_AT, userId(2), "presence");
      // 1 was last seen 50 s ago (past the 45 s tolerance), 2 30 s ago.
      now = T0 + 50_000;
      expect(now - T0).toBeGreaterThan(HLS_VIEWER_PRESENT_TOLERANCE_MS);
      expect(await counter.publishPresence()).toBe(1);
      expect(await presentHlsViewers(channelId, STARTED_AT)).toBe(1);
      // Exactly on the tolerance still counts, one millisecond past does not.
      now = T0 + 20_000 + HLS_VIEWER_PRESENT_TOLERANCE_MS;
      await counter.publishPresence();
      resetHlsPresentCacheForTests();
      expect(await presentHlsViewers(channelId, STARTED_AT)).toBe(1);
      now += 1;
      await counter.publishPresence();
      resetHlsPresentCacheForTests();
      expect(await presentHlsViewers(channelId, STARTED_AT)).toBe(0);
    });

    it("is one account however many machines saw it, and does not wait for a flush", async () => {
      const now = T0;
      const a = createHlsViewerCounter({ now: () => now });
      const b = createHlsViewerCounter({ now: () => now });
      // 1-60 on A, 41-100 on B, 41-60 on both. Summing the machines says 120;
      // the accounts are 100. Nobody has flushed (`flushDue` never ran), which
      // is exactly why the stored rows cannot answer "now".
      for (let n = 1; n <= 60; n += 1) {
        a.note(channelId, STARTED_AT, userId(n), "presence");
      }
      for (let n = 41; n <= 100; n += 1) {
        b.note(channelId, STARTED_AT, userId(n), "presence");
      }
      await a.publishPresence();
      await b.publishPresence();
      expect(await presentHlsViewers(channelId, STARTED_AT)).toBe(100);
      const stored = await getPool().query(
        `SELECT 1 FROM hls_session_viewers WHERE channel_id = $1`,
        [channelId],
      );
      expect(stored.rowCount).toBe(0);
    });

    it("writes one row per process per broadcast, never one per beat", async () => {
      let now = T0;
      const { calls, pool } = countingPool();
      const counter = createHlsViewerCounter({ now: () => now, pool });
      for (let beat = 0; beat < 300; beat += 1) {
        now = T0 + beat * 100;
        for (let n = 1; n <= 200; n += 1) {
          counter.note(channelId, STARTED_AT, userId(n), "playlist");
        }
      }
      expect(calls).toEqual([]);
      await counter.publishPresence();
      await counter.publishPresence();
      expect(calls.filter((sql) => /hls_session_presence/.test(sql))).toHaveLength(2);
      const stored = await getPool().query<{ rows: number; ids: number }>(
        `SELECT COUNT(*)::int AS rows, MAX(cardinality(user_ids))::int AS ids
           FROM hls_session_presence`,
      );
      expect(stored.rows).toEqual([{ rows: 1, ids: 200 }]);
      expect(counter.stats().presenceWrites).toBe(2);
    });

    it("retracts once when the last viewer goes quiet, then writes nothing", async () => {
      let now = T0;
      const { calls, pool } = countingPool();
      const counter = createHlsViewerCounter({ now: () => now, pool });
      counter.note(channelId, STARTED_AT, userId(1), "presence");
      expect(await counter.publishPresence()).toBe(1);
      now = T0 + HLS_VIEWER_PRESENT_TOLERANCE_MS + 1;
      expect(await counter.publishPresence()).toBe(1); // the empty row
      expect(await counter.publishPresence()).toBe(0);
      expect(await counter.publishPresence()).toBe(0);
      expect(calls).toHaveLength(2);
      resetHlsPresentCacheForTests();
      expect(await presentHlsViewers(channelId, STARTED_AT)).toBe(0);
    });

    it("ignores a machine that stopped publishing", async () => {
      const counter = createHlsViewerCounter();
      counter.note(channelId, STARTED_AT, userId(1), "presence");
      await counter.publishPresence();
      expect(await presentHlsViewers(channelId, STARTED_AT)).toBe(1);
      await getPool().query(
        `UPDATE hls_session_presence
            SET sampled_at = NOW() - ($1 || ' milliseconds')::interval`,
        [String(HLS_PRESENCE_MAX_AGE_MS + 1_000)],
      );
      resetHlsPresentCacheForTests();
      expect(await presentHlsViewers(channelId, STARTED_AT)).toBe(0);
    });

    it("leaves out people who hold a seat, here or on the other machine", async () => {
      const counter = createHlsViewerCounter();
      for (let n = 1; n <= 10; n += 1) {
        counter.note(channelId, STARTED_AT, userId(n), "presence");
      }
      await counter.publishPresence();
      // 1 is seated on this machine (the caller names it), 2 is in the
      // registry from the other one.
      await seat(userId(2));
      expect(
        await presentHlsViewers(channelId, STARTED_AT, { excludeUserIds: [userId(1)] }),
      ).toBe(8);
      // An orphaned seat (the 90 s resume hold) is not on the roster.
      await getPool().query(`UPDATE voice_peers SET orphaned_at = NOW()`);
      resetHlsPresentCacheForTests();
      expect(
        await presentHlsViewers(channelId, STARTED_AT, { excludeUserIds: [userId(1)] }),
      ).toBe(9);
    });

    it("shares one read between an arrival wave, and peeks without asking", async () => {
      const counter = createHlsViewerCounter();
      counter.note(channelId, STARTED_AT, userId(1), "presence");
      await counter.publishPresence();
      expect(peekPresentHlsViewers(channelId, STARTED_AT)).toBeNull();

      const queries = vi.spyOn(getPool(), "query");
      const wave = await Promise.all(
        Array.from({ length: 200 }, () => presentHlsViewers(channelId, STARTED_AT)),
      );
      expect(new Set(wave)).toEqual(new Set([1]));
      expect(presenceReads(queries)).toBe(1);

      // Inside the cache window nothing more is asked, even sequentially.
      await presentHlsViewers(channelId, STARTED_AT);
      expect(presenceReads(queries)).toBe(1);
      expect(peekPresentHlsViewers(channelId, STARTED_AT)).toBe(1);
      expect(
        peekPresentHlsViewers(channelId, STARTED_AT, 1_000, Date.now() + 5_000),
      ).toBeNull();
      expect(HLS_PRESENCE_READ_CACHE_MS).toBeLessThan(HLS_PRESENCE_MAX_AGE_MS);
      queries.mockRestore();
    });

    it("answers null, not zero, when the database cannot", async () => {
      const spy = vi
        .spyOn(getPool(), "query")
        .mockRejectedValueOnce(new Error("breaker open") as never);
      expect(await presentHlsViewers(channelId, STARTED_AT)).toBeNull();
      spy.mockRestore();
    });

    it("is the operator's liveViewers too: one definition, not two windows", async () => {
      // The shape of 2026-10-03: heartbeats a flush apart. The stored rows call
      // everybody seen in the last two minutes "live"; the presence rows call
      // only who beat within the tolerance.
      await getPool().query(
        `INSERT INTO hls_session_viewer_stats (channel_id, started_at_ms, peak_viewers, unique_viewers)
         VALUES ($1, $2, 0, 0)`,
        [channelId, STARTED_AT],
      );
      const real = Date.now();
      let now = real - 100_000;
      const counter = createHlsViewerCounter({ now: () => now });
      // 40 left 100 s ago and are still in the stored rows; 25 are present.
      for (let n = 1; n <= 40; n += 1) {
        counter.note(channelId, STARTED_AT, userId(n), "presence");
      }
      await counter.flushDue({ force: true });
      now = real;
      for (let n = 41; n <= 65; n += 1) {
        counter.note(channelId, STARTED_AT, userId(n), "presence");
      }
      await counter.flushDue({ force: true });
      await counter.publishPresence();
      const [row] = await liveHlsViewerSessions();
      expect(row!.liveViewers).toBe(25);
      expect(await presentHlsViewers(channelId, STARTED_AT)).toBe(25);

      // Two of the 25 also hold a seat in the call (the roster counts them, the
      // dashboard lists them as `inCall`): both surfaces leave them out, so the
      // operator's number is the app's number.
      await seat(userId(41));
      await seat(userId(42));
      resetHlsPresentCacheForTests();
      const [seated] = await liveHlsViewerSessions();
      expect(seated!.liveViewers).toBe(23);
      expect(await presentHlsViewers(channelId, STARTED_AT)).toBe(23);
      const loose = await getPool().query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM hls_session_viewers
          WHERE last_seen_at >= NOW() - interval '120 seconds'`,
      );
      expect(loose.rows[0]!.n).toBe(65);
    });
  });

  it("refuses sightings that are not a real (channel, broadcast, account)", async () => {
    const counter = createHlsViewerCounter();
    counter.note("not-a-uuid", STARTED_AT, userId(1), "presence");
    counter.note(channelId, Number.NaN, userId(1), "presence");
    counter.note(channelId, STARTED_AT, "dev-user", "presence");
    expect(counter.stats()).toMatchObject({ dropped: 3, trackedSessions: 0 });
    expect(await counter.flushDue()).toEqual([]);
  });
});

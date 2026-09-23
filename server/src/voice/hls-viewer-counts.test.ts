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
  HLS_VIEWER_EVAL_LAG_MS,
  HLS_VIEWER_FLUSH_INTERVAL_MS,
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
                hls_session_viewer_stats RESTART IDENTITY CASCADE`,
    );
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

    const live = await liveHlsViewerSessions();
    expect(live).toEqual([
      {
        channel: "cinema",
        server: "Sala",
        startedAt: STARTED_AT,
        liveViewers: 7,
        peakViewers: 7,
        uniqueViewers: 7,
      },
    ]);
    expect(JSON.stringify(live)).not.toContain(userId(1));
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

  it("refuses sightings that are not a real (channel, broadcast, account)", async () => {
    const counter = createHlsViewerCounter();
    counter.note("not-a-uuid", STARTED_AT, userId(1), "presence");
    counter.note(channelId, Number.NaN, userId(1), "presence");
    counter.note(channelId, STARTED_AT, "dev-user", "presence");
    expect(counter.stats()).toMatchObject({ dropped: 3, trackedSessions: 0 });
    expect(await counter.flushDue()).toEqual([]);
  });
});

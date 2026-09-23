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
    // Two writes for the first flush (people, then counts). Nothing else for
    // the rest of the minute. (The hourly prune is a DELETE and not counted.)
    expect(calls.filter(isFlushWrite)).toHaveLength(2);

    now = T0 + HLS_VIEWER_FLUSH_INTERVAL_MS;
    counter.note(channelId, STARTED_AT, userId(1), "presence");
    const [flushed] = await counter.flushDue();
    expect(calls.filter(isFlushWrite)).toHaveLength(4);
    expect(flushed).toMatchObject({ liveViewers: 300, peakViewers: 300, uniqueViewers: 300 });
    expect(counter.stats().flushes).toBe(2);
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

    // HTTP is balanced per request, so viewers 1-50 land on A, 51-100 on B,
    // and 41-60 hit both inside the same minute.
    for (let n = 1; n <= 60; n += 1) {
      a.note(channelId, STARTED_AT, userId(n), "presence");
    }
    for (let n = 41; n <= 100; n += 1) {
      b.note(channelId, STARTED_AT, userId(n), "presence");
    }
    await a.flushDue();
    now = T0 + 20_000;
    const [fromB] = await b.flushDue();
    expect(fromB).toMatchObject({ liveViewers: 100, peakViewers: 100, uniqueViewers: 100 });

    // Next minute: half the room left. A flushes last this time, with only
    // what it saw; B's earlier rows still inside the live window count too.
    now = T0 + 2 * HLS_VIEWER_FLUSH_INTERVAL_MS + 30_000;
    for (let n = 1; n <= 50; n += 1) {
      a.note(channelId, STARTED_AT, userId(n), "presence");
    }
    await b.flushDue(); // nothing new on B: no write
    const [fromA] = await a.flushDue();
    expect(fromA).toMatchObject({ liveViewers: 50, peakViewers: 100, uniqueViewers: 100 });

    const stats = await getPool().query<{ peak_viewers: number; unique_viewers: number }>(
      `SELECT peak_viewers, unique_viewers FROM hls_session_viewer_stats
        WHERE channel_id = $1 AND started_at_ms = $2`,
      [channelId, STARTED_AT],
    );
    expect(stats.rows).toEqual([{ peak_viewers: 100, unique_viewers: 100 }]);

    const minutes = await hlsViewerMinutes(channelId, STARTED_AT);
    expect(minutes.map((row) => row.viewers)).toEqual([100, 50]);
  });

  it("keeps the higher reading of a minute when the other process flushes a lower one", async () => {
    let now = T0 + 10_000;
    const a = createHlsViewerCounter({ now: () => now });
    const b = createHlsViewerCounter({ now: () => now });
    for (let n = 1; n <= 30; n += 1) {
      a.note(channelId, STARTED_AT, userId(n), "presence");
    }
    await a.flushDue();
    // B flushes later in the same minute, after most of A's viewers aged out
    // of the live window.
    now = T0 + 10_000 + 2_000;
    b.note(channelId, STARTED_AT, userId(99), "presence");
    await getPool().query(
      `UPDATE hls_session_viewers SET last_seen_at = last_seen_at - interval '10 minutes'
        WHERE user_id <> $1`,
      [userId(99)],
    );
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
    const counter = createHlsViewerCounter();
    for (let n = 1; n <= 7; n += 1) {
      counter.note(channelId, STARTED_AT, userId(n), "presence");
    }
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

  it("keeps a failed flush's sightings for the next minute and asks the database once a minute", async () => {
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

    fail = false;
    now = T0 + HLS_VIEWER_FLUSH_INTERVAL_MS;
    const [flushed] = await counter.flushDue();
    expect(flushed).toMatchObject({ uniqueViewers: 1 });
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

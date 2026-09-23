import type { Pool } from "pg";
import { getPool } from "../db.js";
import { logEvent } from "../lib/log.js";

/**
 * HOW MANY PEOPLE WATCHED A WATCH PARTY.
 *
 * Until this module we could not say. The playlist route logs only its
 * rejections, the edge Worker's logs are out of reach, and telemetry is
 * sampled one viewer in ten. So viewers are counted where they are already
 * authenticated and cheap to see:
 *
 * - `POST /api/live-hls/presence`, which every web player sends every 30 s
 *   while it is playing (`LIVE_HLS_PRESENCE_INTERVAL_MS` in `@pqp/shared`).
 *   It carries the same `?t=` viewer token the playlist request does, so it
 *   covers viewers the edge Worker serves entirely (LL) just as well as the
 *   ones this API proxies.
 * - Every playlist response this API serves, and every telemetry batch whose
 *   token verifies. Both are already authenticated; noting them is a map
 *   write, and they catch clients that predate the heartbeat (a tab that has
 *   not reloaded, the native apps on the API path).
 *
 * The viewer's id is the AUTHENTICATED user id, checked against the one the
 * token names, never anything the client supplies, and it never leaves the
 * server: every reader of these tables counts rows.
 *
 * NO WRITE PER POLL. A heartbeat is a `Map.set`. Each process flushes what it
 * saw at most once per `HLS_VIEWER_FLUSH_INTERVAL_MS` per broadcast, in ONE
 * statement: upsert the people it saw (`hls_session_viewers`), count who was
 * present at the evaluated instant, file that under its minute and fold it
 * into the running peak, and add the accounts that were new to this
 * broadcast to the unique total.
 *
 * TWO MACHINES. HTTP is balanced per request, so the same viewer's
 * heartbeats land on both API processes. Adding the two processes' counts
 * would double them; instead each flush writes WHO it saw. Unique grows only
 * by rows a flush actually INSERTED, which happens once per account however
 * many machines saw it, so it never rescans the audience (a Farol finding on
 * #799). Concurrency is read from the shared rows, and the higher reading of
 * a minute wins (`GREATEST`), so the order machines flush in does not
 * matter.
 *
 * CONCURRENT MEANS PRESENT AT THE SAME INSTANT, not "seen in the last two
 * minutes". A rolling window would count somebody who left and somebody who
 * arrived a minute later as simultaneous, and inflate the peak (a Farol
 * finding on #799). So each flush evaluates one instant in the PAST,
 * `HLS_VIEWER_EVAL_LAG_MS` ago, by when both machines have written what they
 * saw around it, and counts the viewers whose [first seen, last seen] span
 * covers it within `HLS_VIEWER_PRESENT_TOLERANCE_MS` (one heartbeat and its
 * timer jitter). That reading is filed under the minute of the instant.
 *
 * `HLS_VIEWER_LIVE_WINDOW_MS` is only for the operator's "watching now" and
 * this process's own memory: seen within two minutes, knowingly loose.
 */

/** Each process writes a broadcast's viewers at most this often. */
export const HLS_VIEWER_FLUSH_INTERVAL_MS = 60_000;

/** Seen within this long counts as "watching now" on the operator's view. */
export const HLS_VIEWER_LIVE_WINDOW_MS = 120_000;

/**
 * How far back a flush evaluates concurrency: one flush interval plus the
 * tick that runs it plus slack, so the other machine's sightings of that
 * instant are already in the table.
 */
export const HLS_VIEWER_EVAL_LAG_MS = 90_000;

/**
 * A viewer counts as present at an instant when last seen no more than this
 * before it: the 30 s heartbeat plus the 10 s timer that sends it, plus slack.
 */
export const HLS_VIEWER_PRESENT_TOLERANCE_MS = 45_000;

/** A viewer row (which holds a user id) outlives its last sighting by this. */
export const HLS_VIEWER_ROW_RETENTION_HOURS = 24;

/** How often the prune above runs, per process. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Sanity caps. Every entry is a real, token-verified (user, broadcast) pair,
 * so these only bound a bug, never a normal night.
 */
const MAX_TRACKED_SESSIONS = 512;
const MAX_VIEWERS_PER_SESSION = 50_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HlsViewerSource = "presence" | "playlist" | "telemetry";

interface TrackedSession {
  channelId: string;
  startedAt: number;
  /** userId -> first and last seen by this process, epoch ms. */
  viewers: Map<string, { first: number; last: number }>;
  /**
   * The newest sighting a successful flush has stored. A viewer seen after
   * this is not forgotten, however old, until a flush stores it: a database
   * that is down longer than the live window must not lose sightings (a
   * Farol finding on #799).
   */
  persistedThrough: number;
  /** Anything noted since the last successful flush. */
  dirty: boolean;
  lastFlushAt: number;
  flushing: boolean;
}

export interface HlsViewerFlushResult {
  channelId: string;
  startedAt: number;
  liveViewers: number;
  peakViewers: number;
  uniqueViewers: number;
}

export interface HlsViewerCounterStats {
  /** Sightings since boot, by where they came from. */
  noted: Record<HlsViewerSource, number>;
  /** Broadcasts this process holds viewers for right now. */
  trackedSessions: number;
  /** Viewers this process saw inside the live window, summed over broadcasts. */
  viewersHere: number;
  flushes: number;
  flushFailures: number;
  /** Sightings refused by a sanity cap. Belongs at zero. */
  dropped: number;
}

export interface HlsViewerCounter {
  note(
    channelId: string,
    startedAt: number,
    userId: string,
    source: HlsViewerSource,
  ): void;
  /**
   * Flush every broadcast that has something new and has not been flushed
   * inside the interval. `force` ignores the interval (shutdown).
   */
  flushDue(options?: { force?: boolean }): Promise<HlsViewerFlushResult[]>;
  stats(): HlsViewerCounterStats;
  start(): () => Promise<void>;
  resetForTests(): void;
}

export function createHlsViewerCounter(
  options: {
    now?: () => number;
    pool?: () => Pick<Pool, "query">;
    flushIntervalMs?: number;
    liveWindowMs?: number;
    evalLagMs?: number;
    presentToleranceMs?: number;
  } = {},
): HlsViewerCounter {
  const now = options.now ?? Date.now;
  const pool = options.pool ?? getPool;
  const flushIntervalMs = options.flushIntervalMs ?? HLS_VIEWER_FLUSH_INTERVAL_MS;
  const liveWindowMs = options.liveWindowMs ?? HLS_VIEWER_LIVE_WINDOW_MS;
  const evalLagMs = options.evalLagMs ?? HLS_VIEWER_EVAL_LAG_MS;
  const presentToleranceMs =
    options.presentToleranceMs ?? HLS_VIEWER_PRESENT_TOLERANCE_MS;
  const sessions = new Map<string, TrackedSession>();
  const noted: Record<HlsViewerSource, number> = {
    presence: 0,
    playlist: 0,
    telemetry: 0,
  };
  let flushes = 0;
  let flushFailures = 0;
  let dropped = 0;
  let lastPruneAt = 0;

  function note(
    channelId: string,
    startedAt: number,
    userId: string,
    source: HlsViewerSource,
  ): void {
    if (
      !UUID_RE.test(channelId) ||
      !UUID_RE.test(userId) ||
      !Number.isSafeInteger(startedAt) ||
      startedAt <= 0
    ) {
      dropped += 1;
      return;
    }
    const key = `${channelId}:${startedAt}`;
    let session = sessions.get(key);
    if (!session) {
      if (sessions.size >= MAX_TRACKED_SESSIONS) {
        dropped += 1;
        return;
      }
      session = {
        channelId,
        startedAt,
        viewers: new Map(),
        persistedThrough: 0,
        dirty: false,
        // Zero, so the very first flush after a broadcast is first seen is
        // not held back a whole interval.
        lastFlushAt: 0,
        flushing: false,
      };
      sessions.set(key, session);
    }
    const at = now();
    const seen = session.viewers.get(userId);
    if (seen) {
      seen.last = at;
    } else {
      if (session.viewers.size >= MAX_VIEWERS_PER_SESSION) {
        dropped += 1;
        return;
      }
      session.viewers.set(userId, { first: at, last: at });
    }
    session.dirty = true;
    noted[source] += 1;
  }

  async function flushOne(
    session: TrackedSession,
    at: number,
  ): Promise<HlsViewerFlushResult | null> {
    const userIds: string[] = [];
    const firstMs: number[] = [];
    const lastMs: number[] = [];
    let newest = 0;
    for (const [userId, seen] of session.viewers) {
      userIds.push(userId);
      firstMs.push(seen.first);
      lastMs.push(seen.last);
      newest = Math.max(newest, seen.last);
    }
    session.flushing = true;
    session.dirty = false;
    try {
      // ONE statement, so the viewer upsert and the counts built on it land
      // together or not at all. A data-modifying CTE's rows are invisible to
      // the rest of its own statement, so "who is present" is the snapshot's
      // rows for everybody NOT in this batch plus this batch merged with its
      // own stored span (`merged`).
      const counted = await pool().query<{
        live: number;
        peak_viewers: number;
        unique_viewers: number;
      }>(
        `WITH batch AS (
           SELECT u.user_id,
                  to_timestamp(u.first_ms / 1000.0) AS first_seen,
                  to_timestamp(u.last_ms / 1000.0) AS last_seen
             FROM unnest($3::uuid[], $4::float8[], $5::float8[])
                  AS u(user_id, first_ms, last_ms)
         ), merged AS (
           SELECT b.user_id,
                  LEAST(b.first_seen, v.first_seen_at) AS first_seen,
                  GREATEST(b.last_seen, v.last_seen_at) AS last_seen
             FROM batch b
             LEFT JOIN hls_session_viewers v
               ON v.channel_id = $1 AND v.started_at_ms = $2 AND v.user_id = b.user_id
         ), ins AS (
           INSERT INTO hls_session_viewers
             (channel_id, started_at_ms, user_id, first_seen_at, last_seen_at)
           SELECT $1, $2, user_id, first_seen, last_seen FROM batch
           ON CONFLICT (channel_id, started_at_ms, user_id) DO UPDATE
             SET last_seen_at = GREATEST(hls_session_viewers.last_seen_at, EXCLUDED.last_seen_at),
                 first_seen_at = LEAST(hls_session_viewers.first_seen_at, EXCLUDED.first_seen_at)
           RETURNING (xmax = 0) AS inserted
         ), eval AS (
           SELECT to_timestamp($6::float8 / 1000.0) AS at,
                  to_timestamp(($6::float8 - $7::float8) / 1000.0) AS since
         ), present AS (
           SELECT (
             (SELECT COUNT(*) FROM hls_session_viewers v, eval
               WHERE v.channel_id = $1 AND v.started_at_ms = $2
                 AND v.last_seen_at >= eval.since
                 AND v.first_seen_at <= eval.at
                 AND NOT (v.user_id = ANY($3::uuid[])))
             +
             (SELECT COUNT(*) FROM merged, eval
               WHERE merged.last_seen >= eval.since
                 AND merged.first_seen <= eval.at)
           )::int AS n
         ), added AS (
           SELECT COUNT(*) FILTER (WHERE inserted)::int AS n FROM ins
         ), minute AS (
           INSERT INTO hls_session_viewer_minutes
             (channel_id, started_at_ms, minute, viewers)
           SELECT $1, $2, date_trunc('minute', eval.at), present.n
             FROM present, eval
           ON CONFLICT (channel_id, started_at_ms, minute) DO UPDATE
             SET viewers = GREATEST(hls_session_viewer_minutes.viewers, EXCLUDED.viewers)
         )
         INSERT INTO hls_session_viewer_stats AS s
           (channel_id, started_at_ms, peak_viewers, peak_at, unique_viewers, updated_at)
         SELECT $1, $2, present.n, eval.at, added.n, NOW() FROM present, added, eval
         ON CONFLICT (channel_id, started_at_ms) DO UPDATE
           SET peak_at = CASE WHEN EXCLUDED.peak_viewers > s.peak_viewers
                              THEN EXCLUDED.peak_at ELSE s.peak_at END,
               peak_viewers = GREATEST(s.peak_viewers, EXCLUDED.peak_viewers),
               unique_viewers = s.unique_viewers + EXCLUDED.unique_viewers,
               updated_at = NOW()
         RETURNING (SELECT n FROM present) AS live, peak_viewers, unique_viewers`,
        [
          session.channelId,
          session.startedAt,
          userIds,
          firstMs,
          lastMs,
          at - evalLagMs,
          presentToleranceMs,
        ],
      );
      session.lastFlushAt = at;
      session.persistedThrough = Math.max(session.persistedThrough, newest);
      flushes += 1;
      const row = counted.rows[0];
      return {
        channelId: session.channelId,
        startedAt: session.startedAt,
        liveViewers: row?.live ?? 0,
        peakViewers: row?.peak_viewers ?? 0,
        uniqueViewers: row?.unique_viewers ?? 0,
      };
    } catch (error) {
      // A measurement: not retried in a loop. Marked dirty again so the next
      // tick carries these sightings (`expire` keeps anything newer than
      // `persistedThrough`), and `lastFlushAt` is still stamped so a
      // struggling database is asked once a minute, not once a tick.
      session.dirty = true;
      session.lastFlushAt = at;
      flushFailures += 1;
      logEvent("voice.hlsViewerFlushFailed", {
        channelId: session.channelId,
        startedAt: session.startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      session.flushing = false;
    }
  }

  /**
   * Forget viewers this process has both stored and not seen for the live
   * window, and broadcasts with nobody left. A sighting no flush has stored
   * yet is kept however old it is, so a long outage delays the count rather
   * than losing it, and a session is never left holding a slot with nothing
   * in it.
   */
  function expire(at: number): void {
    for (const [key, session] of sessions) {
      for (const [userId, seen] of session.viewers) {
        if (at - seen.last > liveWindowMs && seen.last <= session.persistedThrough) {
          session.viewers.delete(userId);
        }
      }
      if (session.viewers.size === 0 && !session.flushing) {
        sessions.delete(key);
      }
    }
  }

  async function prune(at: number): Promise<void> {
    if (at - lastPruneAt < PRUNE_INTERVAL_MS) {
      return;
    }
    lastPruneAt = at;
    try {
      await pool().query(
        `DELETE FROM hls_session_viewers
          WHERE last_seen_at < NOW() - ($1 || ' hours')::interval`,
        [String(HLS_VIEWER_ROW_RETENTION_HOURS)],
      );
    } catch {
      // The next hour tries again.
    }
  }

  async function flushDue(
    flushOptions: { force?: boolean } = {},
  ): Promise<HlsViewerFlushResult[]> {
    const at = now();
    const due = [...sessions.values()].filter(
      (session) =>
        session.dirty &&
        !session.flushing &&
        session.viewers.size > 0 &&
        (flushOptions.force || at - session.lastFlushAt >= flushIntervalMs),
    );
    const results: HlsViewerFlushResult[] = [];
    // One broadcast at a time: a busy night is a handful of broadcasts, and
    // this should never hold more than one pooled connection.
    for (const session of due) {
      const result = await flushOne(session, at);
      if (result) {
        results.push(result);
      }
    }
    expire(at);
    await prune(at);
    return results;
  }

  function stats(): HlsViewerCounterStats {
    const at = now();
    let viewersHere = 0;
    for (const session of sessions.values()) {
      for (const seen of session.viewers.values()) {
        if (at - seen.last <= liveWindowMs) {
          viewersHere += 1;
        }
      }
    }
    return {
      noted: { ...noted },
      trackedSessions: sessions.size,
      viewersHere,
      flushes,
      flushFailures,
      dropped,
    };
  }

  function start(): () => Promise<void> {
    // Ticks more often than the interval so a broadcast first seen just
    // after a tick is not held back almost two intervals; `flushDue` itself
    // enforces the once-per-interval bound per broadcast.
    const timer = setInterval(() => {
      void flushDue().catch(() => undefined);
    }, Math.max(1_000, Math.floor(flushIntervalMs / 4)));
    timer.unref?.();
    return async () => {
      clearInterval(timer);
      await flushDue({ force: true }).catch(() => undefined);
    };
  }

  return {
    note,
    flushDue,
    stats,
    start,
    resetForTests() {
      sessions.clear();
      noted.presence = 0;
      noted.playlist = 0;
      noted.telemetry = 0;
      flushes = 0;
      flushFailures = 0;
      dropped = 0;
      lastPruneAt = 0;
    },
  };
}

/** The process-wide counter every route notes into. */
export const hlsViewerCounter = createHlsViewerCounter();

export function noteHlsViewer(
  channelId: string,
  startedAt: number,
  userId: string,
  source: HlsViewerSource,
): void {
  hlsViewerCounter.note(channelId, startedAt, userId, source);
}

export interface LiveHlsViewerSession {
  channel: string | null;
  server: string | null;
  /** The broadcast's start, epoch ms, as the history dialog names it. */
  startedAt: number;
  liveViewers: number;
  peakViewers: number;
  uniqueViewers: number;
}

/**
 * Broadcasts with a viewer seen in the last few minutes, across every API
 * process (read from the shared tables, so up to one flush interval behind).
 * For `GET /api/admin/metrics`. Names, never ids.
 */
export async function liveHlsViewerSessions(
  limit = 20,
): Promise<LiveHlsViewerSession[]> {
  const result = await getPool().query<{
    channel: string | null;
    server: string | null;
    started_at_ms: string;
    live: number;
    peak_viewers: number;
    unique_viewers: number;
  }>(
    `SELECT c.name AS channel,
            srv.name AS server,
            st.started_at_ms::text AS started_at_ms,
            (SELECT COUNT(*)::int FROM hls_session_viewers v
              WHERE v.channel_id = st.channel_id
                AND v.started_at_ms = st.started_at_ms
                AND v.last_seen_at >= NOW() - ($2 || ' milliseconds')::interval) AS live,
            st.peak_viewers,
            st.unique_viewers
       FROM hls_session_viewer_stats st
       JOIN channels c ON c.id = st.channel_id
       LEFT JOIN servers srv ON srv.id = c.server_id
      WHERE st.updated_at >= NOW() - interval '5 minutes'
      ORDER BY live DESC, st.started_at_ms DESC
      LIMIT $1`,
    [limit, String(HLS_VIEWER_LIVE_WINDOW_MS)],
  );
  return result.rows.map((row) => ({
    channel: row.channel,
    server: row.server,
    startedAt: Number(row.started_at_ms),
    liveViewers: row.live,
    peakViewers: row.peak_viewers,
    uniqueViewers: row.unique_viewers,
  }));
}

/** The per-minute series for one broadcast, oldest first. */
export async function hlsViewerMinutes(
  channelId: string,
  startedAt: number,
): Promise<Array<{ minute: string; viewers: number }>> {
  const result = await getPool().query<{ minute: Date; viewers: number }>(
    `SELECT minute, viewers FROM hls_session_viewer_minutes
      WHERE channel_id = $1 AND started_at_ms = $2
      ORDER BY minute ASC`,
    [channelId, startedAt],
  );
  return result.rows.map((row) => ({
    minute: row.minute.toISOString(),
    viewers: row.viewers,
  }));
}

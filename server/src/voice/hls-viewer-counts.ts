import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getPool } from "../db.js";
import { logEvent } from "../lib/log.js";
import {
  communityColumns,
  communityTag,
  type CommunityColumns,
  type CommunityTag,
} from "../services/community-tag.js";

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
 * WATCHING RIGHT NOW is a different question from either of the above, and
 * the stored rows cannot answer it: they are flushed once a minute, so a
 * viewer who is on the playlist this second can have a `last_seen_at` a
 * minute and a half old, and any window short enough to mean "now" undercounts
 * (a 45 s window over the rows read 73 for a party the loose two minute window
 * read 97 for). So each process also publishes, every
 * `HLS_PRESENCE_PUBLISH_INTERVAL_MS`, ONE row of its own
 * (`hls_session_presence`): the accounts it saw within
 * `HLS_VIEWER_PRESENT_TOLERANCE_MS`. A reader unions the fresh rows by
 * account, so two machines never add and neither is a flush behind
 * (`presentHlsViewers`). That one number is what the operator's `liveViewers`
 * and the in-app count (`watch_party_server_audience`) both read.
 * `HLS_VIEWER_LIVE_WINDOW_MS` is now only this process's own memory.
 */

/** Each process writes a broadcast's viewers at most this often. */
export const HLS_VIEWER_FLUSH_INTERVAL_MS = 60_000;

/**
 * How long this process remembers a viewer it has stored. No longer the
 * operator's "watching now" (see `HLS_PRESENCE_PUBLISH_INTERVAL_MS`).
 */
export const HLS_VIEWER_LIVE_WINDOW_MS = 120_000;

/** Each process republishes who it saw within the tolerance this often. */
export const HLS_PRESENCE_PUBLISH_INTERVAL_MS = 10_000;

/**
 * A presence row older than this is ignored: two missed publishes. It is what
 * takes a dead machine's viewers out of the count without anybody cleaning up.
 */
export const HLS_PRESENCE_MAX_AGE_MS = 25_000;

/** One read of a broadcast's count is shared for this long, per process. */
export const HLS_PRESENCE_READ_CACHE_MS = 5_000;

/**
 * Sanity cap on one row's ids (16 bytes each). Bounds a bug, not a night: a
 * 500 viewer party is 8 KB.
 */
const MAX_PRESENCE_IDS = 10_000;

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
/** Foreground or background time one viewer may accrue between two flushes. */
const MAX_PENDING_MS = 30 * 60_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HlsViewerSource = "presence" | "playlist" | "telemetry";

/**
 * What a presence beat may add about the person behind it, and nothing more:
 * a coarse device class and foreground / background milliseconds. No user
 * agent, no address, no size in pixels.
 */
export interface HlsViewerDetail {
  device?: "phone" | "tablet" | "desktop";
  visibleMs?: number;
  hiddenMs?: number;
}

interface ViewerSeen {
  first: number;
  last: number;
  device: "phone" | "tablet" | "desktop" | null;
  /**
   * CUMULATIVE for this map entry, never reset by a flush: the stored value
   * is SET, not added to, so a retried flush cannot count twice.
   */
  visibleMs: number;
  hiddenMs: number;
}

interface TrackedSession {
  channelId: string;
  startedAt: number;
  /** userId -> first and last seen by this process, epoch ms. */
  viewers: Map<string, ViewerSeen>;
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
  /** Ids in the presence row this process last wrote; 0 means "empty or none". */
  presencePublished: number;
  publishing: boolean;
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
  /** Presence rows written / failed since boot. Failures belong at zero. */
  presenceWrites: number;
  presenceFailures: number;
  /** Sightings refused by a sanity cap. Belongs at zero. */
  dropped: number;
}

export interface HlsViewerCounter {
  note(
    channelId: string,
    startedAt: number,
    userId: string,
    source: HlsViewerSource,
    detail?: HlsViewerDetail,
  ): void;
  /**
   * Flush every broadcast that has something new and has not been flushed
   * inside the interval. `force` ignores the interval (shutdown).
   */
  flushDue(options?: { force?: boolean }): Promise<HlsViewerFlushResult[]>;
  /**
   * Rewrite this process's presence row for every broadcast it holds viewers
   * for (and once more, empty, when the last one left). Resolves to the
   * number of rows written.
   */
  publishPresence(): Promise<number>;
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
    presenceIntervalMs?: number;
  } = {},
): HlsViewerCounter {
  const now = options.now ?? Date.now;
  const pool = options.pool ?? getPool;
  const flushIntervalMs = options.flushIntervalMs ?? HLS_VIEWER_FLUSH_INTERVAL_MS;
  const liveWindowMs = options.liveWindowMs ?? HLS_VIEWER_LIVE_WINDOW_MS;
  const evalLagMs = options.evalLagMs ?? HLS_VIEWER_EVAL_LAG_MS;
  const presentToleranceMs =
    options.presentToleranceMs ?? HLS_VIEWER_PRESENT_TOLERANCE_MS;
  const presenceIntervalMs =
    options.presenceIntervalMs ?? HLS_PRESENCE_PUBLISH_INTERVAL_MS;
  const sessions = new Map<string, TrackedSession>();
  // Names this process's share of a viewer's foreground / background time in
  // the row, so two machines add up and a retry of one does not.
  const instanceId = randomUUID().slice(0, 8);
  const noted: Record<HlsViewerSource, number> = {
    presence: 0,
    playlist: 0,
    telemetry: 0,
  };
  let flushes = 0;
  let flushFailures = 0;
  let presenceWrites = 0;
  let presenceFailures = 0;
  let dropped = 0;
  let lastPruneAt = 0;

  function applyDetail(seen: ViewerSeen, detail: HlsViewerDetail | undefined): void {
    if (!detail) {
      return;
    }
    if (detail.device) {
      seen.device = detail.device;
    }
    // Clamped again here: the route's schema already bounds a beat, this
    // bounds the sum a buggy caller could build up between two flushes.
    seen.visibleMs = Math.min(seen.visibleMs + (detail.visibleMs ?? 0), MAX_PENDING_MS);
    seen.hiddenMs = Math.min(seen.hiddenMs + (detail.hiddenMs ?? 0), MAX_PENDING_MS);
  }

  function note(
    channelId: string,
    startedAt: number,
    userId: string,
    source: HlsViewerSource,
    detail?: HlsViewerDetail,
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
        presencePublished: 0,
        publishing: false,
      };
      sessions.set(key, session);
    }
    const at = now();
    const seen = session.viewers.get(userId);
    if (seen) {
      seen.last = at;
      applyDetail(seen, detail);
    } else {
      if (session.viewers.size >= MAX_VIEWERS_PER_SESSION) {
        dropped += 1;
        return;
      }
      const created: ViewerSeen = {
        first: at,
        last: at,
        device: null,
        visibleMs: 0,
        hiddenMs: 0,
      };
      applyDetail(created, detail);
      session.viewers.set(userId, created);
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
    const devices: Array<string | null> = [];
    const details: string[] = [];
    let newest = 0;
    for (const [userId, seen] of session.viewers) {
      userIds.push(userId);
      firstMs.push(seen.first);
      lastMs.push(seen.last);
      devices.push(seen.device);
      details.push(
        seen.visibleMs + seen.hiddenMs > 0
          ? JSON.stringify({
              [`${instanceId}:${seen.first}`]: { v: seen.visibleMs, h: seen.hiddenMs },
            })
          : "{}",
      );
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
                  to_timestamp(u.last_ms / 1000.0) AS last_seen,
                  u.device, u.detail::jsonb AS detail
             FROM unnest($3::uuid[], $4::float8[], $5::float8[],
                         $8::text[], $9::text[])
                  AS u(user_id, first_ms, last_ms, device, detail)
         ), merged AS (
           SELECT b.user_id,
                  LEAST(b.first_seen, v.first_seen_at) AS first_seen,
                  GREATEST(b.last_seen, v.last_seen_at) AS last_seen
             FROM batch b
             LEFT JOIN hls_session_viewers v
               ON v.channel_id = $1 AND v.started_at_ms = $2 AND v.user_id = b.user_id
         ), ins AS (
           INSERT INTO hls_session_viewers
             (channel_id, started_at_ms, user_id, first_seen_at, last_seen_at,
              device_class, detail)
           SELECT $1, $2, user_id, first_seen, last_seen, device, detail
             FROM batch
           ON CONFLICT (channel_id, started_at_ms, user_id) DO UPDATE
             SET last_seen_at = GREATEST(hls_session_viewers.last_seen_at, EXCLUDED.last_seen_at),
                 first_seen_at = LEAST(hls_session_viewers.first_seen_at, EXCLUDED.first_seen_at),
                 device_class = COALESCE(EXCLUDED.device_class, hls_session_viewers.device_class),
                 detail = hls_session_viewers.detail || EXCLUDED.detail
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
          devices,
          details,
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
      // The counter's own clock, not the database's: every row here was
      // stamped from `now()`, so a cutoff from NOW() would disagree with it
      // whenever the two clocks do (an injected clock in a test, or skew).
      await pool().query(
        `DELETE FROM hls_session_viewers
          WHERE last_seen_at < to_timestamp($1::float8 / 1000.0)
                               - ($2 || ' hours')::interval`,
        [at, String(HLS_VIEWER_ROW_RETENTION_HOURS)],
      );
      // Presence rows are ignored after seconds; an hour only bounds the
      // rows of processes and broadcasts that are gone. DB clock, like the
      // writes.
      await pool().query(
        `DELETE FROM hls_session_presence
          WHERE sampled_at < NOW() - interval '1 hour'`,
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

  async function publishPresence(): Promise<number> {
    const at = now();
    let written = 0;
    for (const session of [...sessions.values()]) {
      if (session.publishing) {
        continue;
      }
      const ids: string[] = [];
      for (const [userId, seen] of session.viewers) {
        if (at - seen.last <= presentToleranceMs) {
          ids.push(userId);
          if (ids.length >= MAX_PRESENCE_IDS) {
            break;
          }
        }
      }
      // Nobody now and nothing of ours to retract: no write.
      if (ids.length === 0 && session.presencePublished === 0) {
        continue;
      }
      session.publishing = true;
      try {
        // The DATABASE's clock for `sampled_at`, so two machines whose clocks
        // disagree still agree on which row is fresh. Who counts as present
        // is this process's own judgement, from its own heartbeats.
        await pool().query(
          `INSERT INTO hls_session_presence
             (channel_id, started_at_ms, instance_id, user_ids, sampled_at)
           VALUES ($1, $2, $3, $4::uuid[], NOW())
           ON CONFLICT (channel_id, started_at_ms, instance_id) DO UPDATE
             SET user_ids = EXCLUDED.user_ids,
                 sampled_at = EXCLUDED.sampled_at`,
          [session.channelId, session.startedAt, instanceId, ids],
        );
        session.presencePublished = ids.length;
        presenceWrites += 1;
        written += 1;
      } catch (error) {
        presenceFailures += 1;
        logEvent("voice.hlsPresenceFailed", {
          channelId: session.channelId,
          startedAt: session.startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        session.publishing = false;
      }
    }
    return written;
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
      presenceWrites,
      presenceFailures,
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
    const presenceTimer = setInterval(() => {
      void publishPresence().catch(() => undefined);
    }, presenceIntervalMs);
    presenceTimer.unref?.();
    return async () => {
      clearInterval(timer);
      clearInterval(presenceTimer);
      await flushDue({ force: true }).catch(() => undefined);
    };
  }

  return {
    note,
    flushDue,
    publishPresence,
    stats,
    start,
    resetForTests() {
      sessions.clear();
      noted.presence = 0;
      noted.playlist = 0;
      noted.telemetry = 0;
      flushes = 0;
      flushFailures = 0;
      presenceWrites = 0;
      presenceFailures = 0;
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
  detail?: HlsViewerDetail,
): void {
  hlsViewerCounter.note(channelId, startedAt, userId, source, detail);
}

export interface HlsAudienceByDevice {
  phone: number;
  tablet: number;
  desktop: number;
  /** Viewers whose client predates the device report. */
  unknown: number;
}

export interface HlsViewerAudience {
  channelId: string;
  startedAt: number;
  /** Everyone still in `hls_session_viewers` (a day after the last sighting). */
  viewers: number;
  byDevice: HlsAudienceByDevice;
  /** Accounts created after the broadcast started, by device. */
  newAccountsByDevice: HlsAudienceByDevice;
  visibleSeconds: number;
  hiddenSeconds: number;
  /** hidden / (visible + hidden), 0 to 1, or null with nothing reported. */
  hiddenShare: number | null;
  /** Viewers that reported foreground or background time at all. */
  reportingViewers: number;
}

/**
 * Who watched, by coarse class, for each broadcast that still has viewer
 * rows (they are pruned a day after the last sighting, so this is a "since
 * yesterday" read, not a history). Counts and seconds only: a user id is used
 * to join `users.created_at` and never leaves this query.
 */
let audienceCache: { at: number; limit: number; value: HlsViewerAudience[] } | null = null;
let audienceInFlight: Promise<HlsViewerAudience[]> | null = null;
/** Metrics are recomputed every 30 s at most; this bounds any other caller too. */
const AUDIENCE_CACHE_MS = 60_000;

export function resetHlsViewerAudienceCacheForTests(): void {
  audienceCache = null;
  audienceInFlight = null;
}

/**
 * Bounded twice: the ten broadcasts come from `hls_session_viewer_stats` (one
 * row per broadcast, indexed on `updated_at`), and only THOSE broadcasts' viewer
 * rows are aggregated, by primary-key prefix. The cost follows the ten
 * returned sessions, not the day's total viewers. Cached for a minute and
 * coalesced, so a burst of admin reads is one query.
 */
export async function hlsViewerAudience(limit = 10): Promise<HlsViewerAudience[]> {
  const nowMs = Date.now();
  if (
    audienceCache &&
    audienceCache.limit === limit &&
    nowMs - audienceCache.at < AUDIENCE_CACHE_MS
  ) {
    return audienceCache.value;
  }
  if (audienceInFlight) {
    return audienceInFlight;
  }
  audienceInFlight = queryHlsViewerAudience(limit)
    .then((value) => {
      audienceCache = { at: Date.now(), limit, value };
      return value;
    })
    .finally(() => {
      audienceInFlight = null;
    });
  return audienceInFlight;
}

async function queryHlsViewerAudience(limit: number): Promise<HlsViewerAudience[]> {
  const result = await getPool().query<{
    channel_id: string;
    started_at_ms: string;
    viewers: string;
    phone: string;
    tablet: string;
    desktop: string;
    unknown: string;
    new_phone: string;
    new_tablet: string;
    new_desktop: string;
    new_unknown: string;
    visible_ms: string;
    hidden_ms: string;
    reporting: string;
  }>(
    `WITH recent AS (
       SELECT channel_id, started_at_ms
         FROM hls_session_viewer_stats
        WHERE updated_at >= NOW() - interval '24 hours'
        ORDER BY updated_at DESC
        LIMIT $1
     )
     SELECT v.channel_id::text AS channel_id,
            v.started_at_ms::text AS started_at_ms,
            COUNT(*)::text AS viewers,
            COUNT(*) FILTER (WHERE v.device_class = 'phone')::text AS phone,
            COUNT(*) FILTER (WHERE v.device_class = 'tablet')::text AS tablet,
            COUNT(*) FILTER (WHERE v.device_class = 'desktop')::text AS desktop,
            COUNT(*) FILTER (WHERE v.device_class IS NULL)::text AS unknown,
            COUNT(*) FILTER (WHERE n.isnew AND v.device_class = 'phone')::text AS new_phone,
            COUNT(*) FILTER (WHERE n.isnew AND v.device_class = 'tablet')::text AS new_tablet,
            COUNT(*) FILTER (WHERE n.isnew AND v.device_class = 'desktop')::text AS new_desktop,
            COUNT(*) FILTER (WHERE n.isnew AND v.device_class IS NULL)::text AS new_unknown,
            COALESCE(SUM(d.v), 0)::text AS visible_ms,
            COALESCE(SUM(d.h), 0)::text AS hidden_ms,
            COUNT(*) FILTER (WHERE d.v + d.h > 0)::text AS reporting
       FROM recent r
       JOIN hls_session_viewers v
         ON v.channel_id = r.channel_id AND v.started_at_ms = r.started_at_ms
       LEFT JOIN users u ON u.id = v.user_id
      CROSS JOIN LATERAL (
        SELECT COALESCE(SUM((e.value->>'v')::bigint), 0) AS v,
               COALESCE(SUM((e.value->>'h')::bigint), 0) AS h
          FROM jsonb_each(v.detail) e
      ) d
      CROSS JOIN LATERAL (
        SELECT COALESCE(u.created_at >= to_timestamp(v.started_at_ms / 1000.0), FALSE) AS isnew
      ) n
      GROUP BY v.channel_id, v.started_at_ms
      ORDER BY v.started_at_ms DESC`,
    [limit],
  );
  return result.rows.map((row) => {
    const visible = Number(row.visible_ms);
    const hidden = Number(row.hidden_ms);
    return {
      channelId: row.channel_id,
      startedAt: Number(row.started_at_ms),
      viewers: Number(row.viewers),
      byDevice: {
        phone: Number(row.phone),
        tablet: Number(row.tablet),
        desktop: Number(row.desktop),
        unknown: Number(row.unknown),
      },
      newAccountsByDevice: {
        phone: Number(row.new_phone),
        tablet: Number(row.new_tablet),
        desktop: Number(row.new_desktop),
        unknown: Number(row.new_unknown),
      },
      visibleSeconds: Math.round(visible / 1000),
      hiddenSeconds: Math.round(hidden / 1000),
      hiddenShare:
        visible + hidden > 0
          ? Math.round((hidden / (visible + hidden)) * 1000) / 1000
          : null,
      reportingViewers: Number(row.reporting),
    };
  });
}

// -------------------------------------------------------------- watching now

/**
 * THE NUMBER, for one broadcast: distinct accounts present on the playlist
 * right now, unioned across every API process's presence row, MINUS the ones
 * who hold a seat in the channel's voice room. The seat holders are the roster's
 * to count (the client adds the roster itself), and a seated tab that also
 * keeps a player open must not be counted by both. `excludeUserIds` is the
 * seats this process holds; with `VOICE_REGISTRY=postgres` the other
 * machine's seats are excluded by the query itself, off `voice_peers`.
 *
 * Returns null when it cannot be answered (database down, breaker open): the
 * caller keeps today's number rather than saying zero.
 *
 * Cached for `HLS_PRESENCE_READ_CACHE_MS` and coalesced, per broadcast. An
 * arrival wave asks once per viewer (the `watch-live` answer, `GET /live`), so
 * without it 500 people arriving is 500 queries; with it, a handful.
 */
const presentCache = new Map<string, { at: number; value: number }>();
const presentInFlight = new Map<string, Promise<number | null>>();

export function resetHlsPresentCacheForTests(): void {
  presentCache.clear();
  presentInFlight.clear();
}

function presentKey(channelId: string, startedAt: number): string {
  return `${channelId}:${startedAt}`;
}

/**
 * The last answer for a broadcast, however old up to `maxAgeMs`, never a
 * query. For paths that run once per socket in a reconnect storm.
 */
export function peekPresentHlsViewers(
  channelId: string,
  startedAt: number,
  maxAgeMs = 2 * 60_000,
  nowMs: number = Date.now(),
): number | null {
  const held = presentCache.get(presentKey(channelId, startedAt));
  return held && nowMs - held.at <= maxAgeMs ? held.value : null;
}

export async function presentHlsViewers(
  channelId: string,
  startedAt: number,
  options: { excludeUserIds?: readonly string[]; nowMs?: number } = {},
): Promise<number | null> {
  const key = presentKey(channelId, startedAt);
  const nowMs = options.nowMs ?? Date.now();
  const held = presentCache.get(key);
  if (held && nowMs - held.at < HLS_PRESENCE_READ_CACHE_MS) {
    return held.value;
  }
  const running = presentInFlight.get(key);
  if (running) {
    return running;
  }
  const query = queryPresentHlsViewers(channelId, startedAt, options.excludeUserIds ?? [])
    .then((value) => {
      presentCache.set(key, { at: nowMs, value });
      // Only live broadcasts are ever asked about, so this stays a handful;
      // the sweep is for the ones that ended.
      if (presentCache.size > 64) {
        for (const [entryKey, entry] of presentCache) {
          if (nowMs - entry.at > 5 * 60_000) {
            presentCache.delete(entryKey);
          }
        }
      }
      return value;
    })
    .catch(() => null)
    .finally(() => {
      presentInFlight.delete(key);
    });
  presentInFlight.set(key, query);
  return query;
}

async function queryPresentHlsViewers(
  channelId: string,
  startedAt: number,
  excludeUserIds: readonly string[],
): Promise<number> {
  const result = await getPool().query<{ n: number }>(
    `SELECT COUNT(DISTINCT u.user_id)::int AS n
       FROM hls_session_presence p
       CROSS JOIN LATERAL unnest(p.user_ids) AS u(user_id)
      WHERE p.channel_id = $1
        AND p.started_at_ms = $2
        AND p.sampled_at >= NOW() - ($3 || ' milliseconds')::interval
        AND NOT (u.user_id = ANY($4::uuid[]))
        AND NOT EXISTS (
          SELECT 1 FROM voice_peers vp
           WHERE vp.channel_id = $1
             AND vp.user_id = u.user_id
             AND vp.orphaned_at IS NULL
        )`,
    [channelId, startedAt, String(HLS_PRESENCE_MAX_AGE_MS), [...excludeUserIds]],
  );
  return result.rows[0]?.n ?? 0;
}

export interface LiveHlsViewerSession {
  /** The channel's id, the join key to `voice.rooms`; never a user id. */
  channelId: string;
  channel: string | null;
  server: string | null;
  /** Set when the server is a community; see `services/community-tag.ts`. */
  community: CommunityTag | null;
  /** The broadcast's start, epoch ms, as the history dialog names it. */
  startedAt: number;
  liveViewers: number;
  peakViewers: number;
  uniqueViewers: number;
}

/**
 * Broadcasts with a viewer seen in the last few minutes, across every API
 * process. `liveViewers` is the ONE definition of "watching now"
 * (`presentHlsViewers`): distinct accounts the processes' presence rows say
 * were on the playlist within the heartbeat tolerance, at most
 * `HLS_PRESENCE_MAX_AGE_MS` ago. It used to be every account seen in the last
 * two minutes in rows that were themselves a flush behind, which read 97 for a
 * party the app said had 49 watching. It leaves out accounts that hold a seat in
 * the channel's voice room (the roster counts them, and the dashboard lists
 * `inCall` beside it), exactly as the app's count does, so the two add up the
 * same way. The seats come from `voice_peers`, which only has rows with
 * `VOICE_REGISTRY=postgres` (production); without it this reads every account
 * on the playlist. Peak and unique are still the rows'.
 * For `GET /api/admin/metrics`. Names and the channel id, never a user id.
 */
export async function liveHlsViewerSessions(
  limit = 20,
): Promise<LiveHlsViewerSession[]> {
  const result = await getPool().query<CommunityColumns & {
    channel_id: string;
    channel: string | null;
    server: string | null;
    started_at_ms: string;
    live: number;
    peak_viewers: number;
    unique_viewers: number;
  }>(
    `SELECT st.channel_id::text AS channel_id,
            c.name AS channel,
            srv.name AS server,
            ${communityColumns("srv")},
            st.started_at_ms::text AS started_at_ms,
            (SELECT COUNT(DISTINCT u.user_id)::int
               FROM hls_session_presence p
               CROSS JOIN LATERAL unnest(p.user_ids) AS u(user_id)
              WHERE p.channel_id = st.channel_id
                AND p.started_at_ms = st.started_at_ms
                AND p.sampled_at >= NOW() - ($2 || ' milliseconds')::interval
                AND NOT EXISTS (
                  SELECT 1 FROM voice_peers vp
                   WHERE vp.channel_id = st.channel_id
                     AND vp.user_id = u.user_id
                     AND vp.orphaned_at IS NULL
                )) AS live,
            st.peak_viewers,
            st.unique_viewers
       FROM hls_session_viewer_stats st
       JOIN channels c ON c.id = st.channel_id
       LEFT JOIN servers srv ON srv.id = c.server_id
      WHERE st.updated_at >= NOW() - interval '5 minutes'
      ORDER BY live DESC, st.started_at_ms DESC
      LIMIT $1`,
    [limit, String(HLS_PRESENCE_MAX_AGE_MS)],
  );
  return result.rows.map((row) => ({
    channelId: row.channel_id,
    channel: row.channel,
    server: row.server,
    community: communityTag(row),
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

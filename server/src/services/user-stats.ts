import type { Pool } from "pg";
import type { MusicState } from "@pqp/shared";
import { getPool } from "../db.js";
import { isEnabled } from "../lib/flags.js";
import { logEvent } from "../lib/log.js";
import { processRole, servesTraffic } from "../lib/process-role.js";
import { isVoiceRegistryEnabled } from "../voice/registry.js";
import { activityDay } from "./user-activity.js";

/**
 * Per-person, per-day counts for the Retrospectiva: time in calls, time
 * sharing a screen, tracks queued, watch parties watched.
 *
 * WHY THIS EXISTS
 * None of it was kept. A voice seat is deleted when its person leaves, the
 * music queue lives on the room, and a watch party's viewer rows are pruned a
 * day after the last sighting. A year in review cannot count what nobody
 * wrote down, and it cannot rebuild it later either: every day this did not
 * run is a day missing from the recap.
 *
 * WHAT IS KEPT, AND WHAT IS NOT
 * Counts per person per São Paulo day (`user_daily_stats`), and which parties
 * a person watched (`user_watch_parties`). Never who was in a call with whom:
 * the sampler reads room sizes to decide whether a seat counts, and stores
 * nothing about the room. The cascade on `users` removes all of it with an
 * art. 18 deletion.
 *
 * CALL AND SHARE TIME: A SAMPLER, NOT JOIN/LEAVE PAIRS
 * Pairs break on everything this product does to a call: a deploy, a resume
 * onto the sibling machine, a seat held for its resume window, a crash. A
 * minute tick that looks at who is seated right now survives all of them.
 * It reads the same sources, in the same order, as the occupancy sampler
 * (`services/voice-occupancy.ts`): `voice_peers` with the registry on, the
 * in-process map in a process that serves traffic, and NOTHING in a dedicated
 * worker with the registry off, where an empty map and an empty building look
 * the same. That case is counted (`blindTicks`), never written as zeros.
 *
 * A seat counts when it is live (not held for resume) and its room has at
 * least two different people, bots and the house cast not counted. One person
 * alone is the idle-hangup case, and the ghost seats of pitfall 13 have the
 * same shape; neither is "time in a call". Somebody seated twice (two tabs)
 * counts once, and sharing in either seat counts as sharing.
 *
 * Each row remembers the last minute it added (`voice_sampled_at`), and the
 * upsert only adds when the minute differs. Two samplers briefly running
 * during a worker rollout, or a statement retried after a timeout that had
 * in fact committed, add that minute once.
 *
 * TRACKS QUEUED
 * Noted where a music write is ACCEPTED (`ws/voice.ts`), never where a queue
 * decided elsewhere is adopted, and flushed once a minute as one statement.
 * A retried flush can count a batch twice; for a recap that is acceptable,
 * and it is why this is a count and not a ledger.
 *
 * Runtime flag `user_stats` (env `USER_STATS`, on by default) stops every
 * write here. Counters on `GET /api/admin/metrics` under `userStats`.
 */

export const USER_STATS_SAMPLE_INTERVAL_MS = 60_000;
export const USER_STATS_MUSIC_FLUSH_INTERVAL_MS = 60_000;
/** Viewer rows are pruned a day after the last sighting; copy well inside it. */
export const USER_STATS_WATCH_PARTY_COPY_INTERVAL_MS = 15 * 60_000;
/** How far back each copy looks. Two hours covers a missed tick or a deploy. */
const WATCH_PARTY_COPY_LOOKBACK = "2 hours";
const MIN_PEOPLE_IN_ROOM = 2;
const MAX_PENDING_MUSIC = 50_000;
const BLIND_WARNING_INTERVAL_MS = 60 * 60_000;

export type UserStatsSource = "registry" | "local" | "unavailable" | "off";

export interface LiveSeat {
  userId: string;
  voiceChannelId: string;
  sharingScreen: boolean;
}

/**
 * Tracks this write added on behalf of `userId`: present in `next` (playing
 * or queued), absent from everything the room held before (playing, queued,
 * or already played), added by that person, and not picked by autoplay. A
 * reorder, a skip or a removal adds nothing.
 */
export function newlyQueuedTracks(
  held: MusicState | null,
  next: MusicState | null,
  userId: string,
): number {
  if (!next) {
    return 0;
  }
  const known = new Set<string>();
  if (held) {
    if (held.current) {
      known.add(held.current.id);
    }
    for (const track of held.queue) {
      known.add(track.id);
    }
    for (const track of held.history ?? []) {
      known.add(track.id);
    }
  }
  let added = 0;
  const candidates = next.current ? [next.current, ...next.queue] : next.queue;
  for (const track of candidates) {
    if (
      !known.has(track.id) &&
      track.addedByUserId === userId &&
      !track.autoplayed
    ) {
      known.add(track.id);
      added += 1;
    }
  }
  return added;
}

async function readLiveSeats(): Promise<{
  source: Exclude<UserStatsSource, "off">;
  seats: LiveSeat[];
}> {
  if (isVoiceRegistryEnabled()) {
    const result = await getPool().query<{
      user_id: string;
      channel_id: string;
      sharing_screen: boolean;
    }>(
      `SELECT user_id, channel_id, sharing_screen
         FROM voice_peers
        WHERE orphaned_at IS NULL`,
    );
    return {
      source: "registry",
      seats: result.rows.map((row) => ({
        userId: row.user_id,
        voiceChannelId: row.channel_id,
        sharingScreen: row.sharing_screen,
      })),
    };
  }
  if (!servesTraffic(processRole())) {
    return { source: "unavailable", seats: [] };
  }
  // Lazy, like the occupancy sampler: the worker never loads the socket module.
  const { localLiveSeats } = await import("../ws/voice.js");
  return { source: "local", seats: localLiveSeats() };
}

export interface UserStatsMetrics {
  enabled: boolean;
  lastSource: UserStatsSource | null;
  samples: number;
  /** Person-minutes added by the sampler since this process started. */
  seatMinutes: number;
  sampleFailures: number;
  blindTicks: number;
  musicNoted: number;
  musicPending: number;
  musicFlushes: number;
  musicFlushFailures: number;
  musicDropped: number;
  watchPartyCopies: number;
  watchPartyRowsCopied: number;
  watchPartyCopyFailures: number;
}

export interface UserStatsRecorder {
  sample(now?: Date): Promise<{ source: UserStatsSource; written: number }>;
  noteMusicQueued(userId: string, count: number): void;
  flushMusic(): Promise<number>;
  copyWatchParties(): Promise<number>;
  /** Starts the music flush. The sampler and the copy run from `jobs.ts`. */
  start(): () => Promise<void>;
  metrics(): UserStatsMetrics;
  resetForTests(): void;
}

export function createUserStatsRecorder(
  options: {
    now?: () => number;
    pool?: () => Pick<Pool, "query">;
    readSeats?: typeof readLiveSeats;
    enabled?: () => boolean;
    flushIntervalMs?: number;
  } = {},
): UserStatsRecorder {
  const now = options.now ?? Date.now;
  const pool = options.pool ?? getPool;
  const readSeats = options.readSeats ?? readLiveSeats;
  const enabled = options.enabled ?? (() => isEnabled("user_stats"));
  const flushIntervalMs =
    options.flushIntervalMs ?? USER_STATS_MUSIC_FLUSH_INTERVAL_MS;

  /** Noted and not yet stored, keyed `day|userId`. */
  let pendingMusic = new Map<string, { userId: string; day: string; count: number }>();
  let flushing: Promise<number> | null = null;
  let lastBlindWarningAt = 0;
  let m: Omit<UserStatsMetrics, "enabled" | "musicPending"> = emptyMetrics();

  function emptyMetrics(): Omit<UserStatsMetrics, "enabled" | "musicPending"> {
    return {
      lastSource: null,
      samples: 0,
      seatMinutes: 0,
      sampleFailures: 0,
      blindTicks: 0,
      musicNoted: 0,
      musicFlushes: 0,
      musicFlushFailures: 0,
      musicDropped: 0,
      watchPartyCopies: 0,
      watchPartyRowsCopied: 0,
      watchPartyCopyFailures: 0,
    };
  }

  async function sample(
    at: Date = new Date(now()),
  ): Promise<{ source: UserStatsSource; written: number }> {
    if (!enabled()) {
      m.lastSource = "off";
      return { source: "off", written: 0 };
    }
    let read: Awaited<ReturnType<typeof readLiveSeats>>;
    try {
      read = await readSeats();
    } catch (error) {
      m.sampleFailures += 1;
      logEvent("userStats.sampleFailed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { source: "unavailable", written: 0 };
    }
    m.lastSource = read.source;
    if (read.source === "unavailable") {
      m.blindTicks += 1;
      if (at.getTime() - lastBlindWarningAt > BLIND_WARNING_INTERVAL_MS) {
        lastBlindWarningAt = at.getTime();
        logEvent("userStats.blind", {
          role: processRole(),
          registry: isVoiceRegistryEnabled() ? "postgres" : "off",
        });
      }
      return { source: read.source, written: 0 };
    }
    m.samples += 1;
    if (read.seats.length === 0) {
      return { source: read.source, written: 0 };
    }
    const bucket = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
    const day = activityDay(bucket.getTime());
    try {
      // Joined to `users` first, so bots, webhooks and the house cast never
      // count and never make a room "two people", and an account deleted
      // since the read drops out instead of failing on the foreign key.
      const result = await pool().query(
        `WITH seats AS (
           SELECT v.user_id, v.channel_id, v.sharing
             FROM unnest($1::uuid[], $2::uuid[], $3::boolean[])
                    AS v(user_id, channel_id, sharing)
             JOIN users u ON u.id = v.user_id
            WHERE NOT u.is_webhook AND NOT u.is_character AND NOT u.is_bot
         ), rooms AS (
           SELECT channel_id FROM seats
            GROUP BY channel_id
           HAVING count(DISTINCT user_id) >= ${MIN_PEOPLE_IN_ROOM}
         ), people AS (
           SELECT s.user_id, bool_or(s.sharing) AS sharing
             FROM seats s JOIN rooms r USING (channel_id)
            GROUP BY s.user_id
         )
         INSERT INTO user_daily_stats
           (user_id, day, voice_seconds, share_seconds, voice_sampled_at)
         SELECT user_id, $4::date, 60,
                CASE WHEN sharing THEN 60 ELSE 0 END, $5::timestamptz
           FROM people
         ON CONFLICT (user_id, day) DO UPDATE SET
           voice_seconds    = user_daily_stats.voice_seconds + EXCLUDED.voice_seconds,
           share_seconds    = user_daily_stats.share_seconds + EXCLUDED.share_seconds,
           voice_sampled_at = EXCLUDED.voice_sampled_at
         WHERE user_daily_stats.voice_sampled_at IS DISTINCT FROM EXCLUDED.voice_sampled_at`,
        [
          read.seats.map((seat) => seat.userId),
          read.seats.map((seat) => seat.voiceChannelId),
          read.seats.map((seat) => seat.sharingScreen),
          day,
          bucket.toISOString(),
        ],
      );
      const written = result.rowCount ?? 0;
      m.seatMinutes += written;
      return { source: read.source, written };
    } catch (error) {
      m.sampleFailures += 1;
      logEvent("userStats.sampleFailed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { source: read.source, written: 0 };
    }
  }

  function noteMusicQueued(userId: string, count: number): void {
    if (count <= 0 || !enabled()) {
      return;
    }
    const day = activityDay(now());
    const key = `${day}|${userId}`;
    const entry = pendingMusic.get(key);
    if (entry) {
      entry.count += count;
    } else if (pendingMusic.size >= MAX_PENDING_MUSIC) {
      m.musicDropped += count;
      return;
    } else {
      pendingMusic.set(key, { userId, day, count });
    }
    m.musicNoted += count;
  }

  function flushMusic(): Promise<number> {
    if (flushing) {
      return flushing;
    }
    if (pendingMusic.size === 0) {
      return Promise.resolve(0);
    }
    flushing = flushMusicBatch().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  async function flushMusicBatch(): Promise<number> {
    const batch = pendingMusic;
    pendingMusic = new Map();
    const entries = [...batch.values()];
    try {
      const result = await pool().query(
        `INSERT INTO user_daily_stats (user_id, day, music_queued)
         SELECT v.user_id, v.day, v.count
           FROM unnest($1::uuid[], $2::date[], $3::int[]) AS v(user_id, day, count)
           JOIN users u ON u.id = v.user_id
          WHERE NOT u.is_webhook AND NOT u.is_character AND NOT u.is_bot
         ON CONFLICT (user_id, day) DO UPDATE SET
           music_queued = user_daily_stats.music_queued + EXCLUDED.music_queued`,
        [
          entries.map((e) => e.userId),
          entries.map((e) => e.day),
          entries.map((e) => e.count),
        ],
      );
      m.musicFlushes += 1;
      return result.rowCount ?? 0;
    } catch (error) {
      m.musicFlushFailures += 1;
      // Put back what did not land, merged with anything noted meanwhile.
      for (const entry of entries) {
        const key = `${entry.day}|${entry.userId}`;
        const current = pendingMusic.get(key);
        if (current) {
          current.count += entry.count;
        } else if (pendingMusic.size >= MAX_PENDING_MUSIC) {
          m.musicDropped += entry.count;
        } else {
          pendingMusic.set(key, { ...entry });
        }
      }
      logEvent("userStats.musicFlushFailed", {
        pending: pendingMusic.size,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Copy recent viewer rows into the durable table before the viewer table
   * prunes them. Idempotent: the primary key is the party, so every copy
   * after the first is a no-op for the same viewer.
   *
   * Known gap: a seat in the party's call that never loaded the stream (the
   * host, a co-host, a speaker) has no viewer row. Hosting is already kept
   * on `channel_sessions`; speaking without watching is not counted.
   */
  async function copyWatchParties(): Promise<number> {
    if (!enabled()) {
      return 0;
    }
    try {
      const result = await pool().query(
        `INSERT INTO user_watch_parties
           (user_id, channel_id, started_at_ms, first_seen_at)
         SELECT v.user_id, v.channel_id, v.started_at_ms, v.first_seen_at
           FROM hls_session_viewers v
           JOIN users u ON u.id = v.user_id
          WHERE v.last_seen_at > now() - interval '${WATCH_PARTY_COPY_LOOKBACK}'
            AND NOT u.is_webhook AND NOT u.is_character AND NOT u.is_bot
         ON CONFLICT DO NOTHING`,
      );
      const copied = result.rowCount ?? 0;
      m.watchPartyCopies += 1;
      m.watchPartyRowsCopied += copied;
      return copied;
    } catch (error) {
      m.watchPartyCopyFailures += 1;
      logEvent("userStats.watchPartyCopyFailed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  function start(): () => Promise<void> {
    const timer = setInterval(() => {
      void flushMusic().catch(() => undefined);
    }, flushIntervalMs);
    timer.unref?.();
    return async () => {
      clearInterval(timer);
      await flushMusic().catch(() => undefined);
      await flushMusic().catch(() => undefined);
    };
  }

  return {
    sample,
    noteMusicQueued,
    flushMusic,
    copyWatchParties,
    start,
    metrics: () => ({
      ...m,
      enabled: enabled(),
      musicPending: [...pendingMusic.values()].reduce((sum, e) => sum + e.count, 0),
    }),
    resetForTests() {
      pendingMusic = new Map();
      flushing = null;
      lastBlindWarningAt = 0;
      m = emptyMetrics();
    },
  };
}

export const userStats = createUserStatsRecorder();

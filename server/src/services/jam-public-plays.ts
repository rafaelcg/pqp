import { createHmac } from "node:crypto";
import { getPool } from "../db.js";

/**
 * PLAYS, COUNTED WITHOUT A WRITE PER LISTENER.
 *
 * A play is counted at most once per song per viewer per clock hour, where a
 * viewer is a signed-in account or, signed out, an address. Three layers, so a
 * popular song is not a write per request and a loop cannot inflate it:
 *
 *  1. A per-process memo of (song, viewer, hour) keys already queued or
 *     written. A repeat inside the hour is dropped in memory: no statement.
 *  2. A queue, flushed every `FLUSH_MS` (or at `FLUSH_MAX` keys) as ONE
 *     `INSERT ... SELECT FROM unnest(...) ON CONFLICT DO NOTHING` into
 *     `jam_public_play_marks`, whose primary key is the dedupe on every
 *     machine at once: the same viewer reaching the two API containers in one
 *     hour inserts one row, not two. Only the rows that actually inserted add
 *     to `jam_public_songs.plays_count`, in the same statement.
 *  3. The public route's address-keyed bucket bounds how fast one address can
 *     even ask (`jam-public-routes.ts`).
 *
 * The `user_activity_days` arrangement: a memo in front of a key that is
 * already unique in the database. The memo is a cost saving, never a
 * correctness claim; losing it (a restart) costs one no-op insert per viewer.
 * A queue not yet flushed when the process dies is at most `FLUSH_MS` of plays,
 * which is an acceptable thing to lose for a counter.
 *
 * Viewers are stored as an HMAC (the derived key below), never the account id
 * or the address itself. Marks older than three hours are swept
 * (`sweepJamPublic`).
 */

const FLUSH_MS = 5_000;
const FLUSH_MAX = 500;
/** Memo entries kept before the memo is dropped and refilled (bounded memory). */
const MEMO_MAX = 100_000;
/**
 * Plays waiting at most. Past it (a database so slow that flushes cannot keep
 * up) a new play is dropped and counted in `dropped`: an undercount, bounded
 * memory, and never a pile of waiting promises.
 */
const QUEUE_MAX = FLUSH_MAX * 10;
/** A failed batch is put back this many times before it is let go. */
const FLUSH_RETRIES = 3;

function viewerSecret(): string {
  const raw = process.env.CLERK_SECRET_KEY || "pqp-dev-jam-public-plays";
  return createHmac("sha256", raw).update("pqp-jam-public-plays").digest("base64url");
}

/** The stored viewer: an HMAC of `account:<id>` or `address:<ip>`, 32 characters. */
export function jamPlayViewer(kind: "account" | "address", value: string): string {
  return createHmac("sha256", viewerSecret()).update(`${kind}:${value}`).digest("hex").slice(0, 32);
}

function hourBucket(nowMs: number): number {
  return Math.floor(nowMs / 3_600_000);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One counter per process in production; the tests build two to stand in for
 * the two API containers and show the database does the cross-machine dedupe.
 */
export class JamPlayCounter {
  private memo = new Set<string>();
  private queue = new Map<string, { songId: string; viewer: string; hour: number; tries: number }>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<number> | null = null;
  /** Plays this counter actually added (rows inserted). */
  counted = 0;
  /** Requests dropped by the memo before any statement. */
  deduped = 0;
  flushFailures = 0;
  /** Plays let go: the queue was full, or a batch failed `FLUSH_RETRIES` times. */
  dropped = 0;

  /** Note a play. Never throws, never waits on the database. */
  note(songId: string, viewer: string, nowMs = Date.now()): void {
    if (!UUID.test(songId)) {
      return;
    }
    const hour = hourBucket(nowMs);
    const key = `${songId}:${viewer}:${hour}`;
    if (this.memo.has(key)) {
      this.deduped += 1;
      return;
    }
    if (this.queue.size >= QUEUE_MAX) {
      this.dropped += 1;
      return;
    }
    if (this.memo.size >= MEMO_MAX) {
      this.memo.clear();
    }
    this.memo.add(key);
    this.queue.set(key, { songId: songId.toLowerCase(), viewer, hour, tries: 0 });
    // One flush in flight at most: while one runs, the queue waits for the
    // trailing timer instead of every note stacking another await on it.
    if (this.queue.size >= FLUSH_MAX && !this.flushing) {
      void this.flush();
    } else {
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.timer || this.queue.size === 0) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_MS);
    this.timer.unref?.();
  }

  /** Write what is queued. Returns the plays added. One flush at a time. */
  async flush(): Promise<number> {
    if (this.flushing) {
      await this.flushing;
    }
    if (this.queue.size === 0) {
      return 0;
    }
    const entries = [...this.queue.entries()];
    const batch = entries.map(([, one]) => one);
    this.queue.clear();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushing = (async () => {
      try {
        // Marks only for songs that have a publication (an unknown id is
        // skipped, never a foreign-key error that loses the whole batch), and
        // the counter moves by exactly the rows that inserted.
        const result = await getPool().query<{ added: number }>(
          `WITH incoming AS (
             SELECT DISTINCT u.song_id, u.viewer, u.hour
               FROM unnest($1::uuid[], $2::text[], $3::int[]) AS u(song_id, viewer, hour)
               JOIN jam_public_songs p ON p.song_id = u.song_id
           ), inserted AS (
             INSERT INTO jam_public_play_marks (song_id, viewer, hour_bucket)
             SELECT song_id, viewer, hour FROM incoming
             ON CONFLICT DO NOTHING
             RETURNING song_id
           ), bumped AS (
             UPDATE jam_public_songs p SET plays_count = p.plays_count + c.n
               FROM (SELECT song_id, COUNT(*)::int AS n FROM inserted GROUP BY song_id) c
              WHERE p.song_id = c.song_id
             RETURNING c.n
           )
           SELECT COALESCE(SUM(n), 0)::int AS added FROM bumped`,
          [batch.map((one) => one.songId), batch.map((one) => one.viewer), batch.map((one) => one.hour)],
        );
        const added = result.rows[0]?.added ?? 0;
        this.counted += added;
        return added;
      } catch (error) {
        this.flushFailures += 1;
        // Put the batch back for the next flush (a retried key is never
        // double counted: the primary key decides), up to a few times; then
        // let it go and free its memo keys so a later play in the same hour
        // can count.
        for (const [key, one] of entries) {
          if (one.tries + 1 < FLUSH_RETRIES && this.queue.size < QUEUE_MAX) {
            this.queue.set(key, { ...one, tries: one.tries + 1 });
          } else {
            this.memo.delete(key);
            this.dropped += 1;
          }
        }
        console.error(
          "[jam-public] could not count plays:",
          error instanceof Error ? error.message : error,
        );
        return 0;
      } finally {
        this.flushing = null;
        this.schedule();
      }
    })();
    return this.flushing;
  }

  reset(): void {
    this.memo.clear();
    this.queue.clear();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.counted = 0;
    this.deduped = 0;
    this.flushFailures = 0;
    this.dropped = 0;
  }
}

/** This process's counter. */
export const jamPlays = new JamPlayCounter();

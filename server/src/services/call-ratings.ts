import type {
  CallRatingSummary,
  CallTransport,
  CreateCallRatingRequest,
  MediaQualitySummary,
} from "@pqp/shared";
import { getPool } from "../db.js";

/**
 * Prompted call quality, written once per call and read only in aggregate.
 *
 * The read is deliberately counts-only. An operator does not need to know that
 * a particular person had a bad call on Tuesday, and a list of individual
 * scores keyed by anything would slowly rebuild a per-person record of who has
 * bad wifi. What is useful is the average, the shape of the distribution, and
 * whether one transport is worse than the other; all three survive aggregation.
 */

export async function recordCallRating(
  userId: string,
  input: CreateCallRatingRequest,
): Promise<void> {
  await getPool().query(
    `INSERT INTO call_ratings
       (user_id, channel_id, rating, note, duration_seconds,
        peer_count, transport, had_screen_share, media_quality)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      userId,
      input.channelId ?? null,
      input.rating,
      // A note on a good score is not information, it is a compliment, and
      // storing it would mean the operator's note list stopped being a list of
      // problems. The client does not ask for one above 3; this is the rule
      // being enforced where it cannot be bypassed.
      input.rating <= 3 ? (input.note ?? null) : null,
      input.durationSeconds,
      input.peerCount,
      input.transport,
      input.hadScreenShare,
      // Same rule, same reason, same enforcement point as the note above: a
      // media quality reading on a good call is not diagnostic, it is a
      // measurement nobody will ever read, and the dashboard only ever shows
      // this next to a note -- which only exists on a rating of 3 or less.
      // Keeping a good call's sample around anyway would be the note rule
      // with a loophole in it.
      input.rating <= 3 && input.mediaQuality
        ? JSON.stringify(input.mediaQuality)
        : null,
    ],
  );
}

interface SummaryRow {
  rating: string;
  n: string;
}

interface TransportRow {
  transport: CallTransport;
  n: string;
  avg: string | null;
}

interface NoteRow {
  rating: number;
  note: string;
  created_at: Date;
  // Already validated by `mediaQualitySchema` on the way in, so this is read
  // back as the type it was written as rather than re-parsed.
  media_quality: MediaQualitySummary | null;
}

/**
 * The dashboard's view of call quality over the last `days` days.
 *
 * Three queries rather than one with grouping sets: each is a trivial index
 * scan over a small table, and the alternative is a single query whose result
 * needs unpicking in JavaScript anyway. Run concurrently.
 */
export async function callRatingSummary(
  days: number,
): Promise<CallRatingSummary> {
  const pool = getPool();
  const since = `now() - ($1::int * interval '1 day')`;
  const [distribution, byTransport, notes] = await Promise.all([
    pool.query<SummaryRow>(
      `SELECT rating::text AS rating, COUNT(*)::text AS n
         FROM call_ratings
        WHERE created_at >= ${since}
        GROUP BY rating
        ORDER BY rating`,
      [days],
    ),
    pool.query<TransportRow>(
      `SELECT transport,
              COUNT(*)::text AS n,
              ROUND(AVG(rating), 1)::text AS avg
         FROM call_ratings
        WHERE created_at >= ${since}
        GROUP BY transport
        ORDER BY transport`,
      [days],
    ),
    pool.query<NoteRow>(
      `SELECT rating, note, created_at, media_quality
         FROM call_ratings
        WHERE created_at >= ${since}
          AND note IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 10`,
      [days],
    ),
  ]);

  const counts: Record<string, number> = {};
  let total = 0;
  let weighted = 0;
  for (const row of distribution.rows) {
    const n = Number(row.n);
    counts[row.rating] = n;
    total += n;
    weighted += n * Number(row.rating);
  }

  return {
    total,
    average: total > 0 ? Math.round((weighted / total) * 10) / 10 : null,
    distribution: counts,
    byTransport: byTransport.rows.map((row) => ({
      transport: row.transport,
      total: Number(row.n),
      average: row.avg === null ? null : Number(row.avg),
    })),
    recentNotes: notes.rows.map((row) => ({
      rating: row.rating,
      note: row.note,
      createdAt: row.created_at.toISOString(),
      mediaQuality: row.media_quality,
    })),
  };
}

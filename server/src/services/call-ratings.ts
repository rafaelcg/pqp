import {
  AUDIO_HEALTH_KINDS,
  type AudioHealthSummary,
  type CallRatingSummary,
  type CallTransport,
  type CreateCallRatingRequest,
  type MediaBandSummary,
  type MediaQualitySummary,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { logEvent } from "../lib/log.js";

/**
 * Prompted call quality, written once per call and read only in aggregate.
 *
 * The read is deliberately counts-only. An operator does not need to know that
 * a particular person had a bad call on Tuesday, and a list of individual
 * scores keyed by anything would slowly rebuild a per-person record of who has
 * bad wifi. What is useful is the average, the shape of the distribution, and
 * whether one transport is worse than the other; all three survive aggregation.
 */

/**
 * The audio self-repair's own report, tallied per rated call.
 *
 * WHY STILL HERE NOW THAT THE ROW KEEPS EVERY SCORE'S `media_quality`. The
 * row answers "how did calls in each band look over the window"; this answers
 * "did the repair work since the last deploy", with `<kind>.lowRated` and the
 * `autoFixed` / `manualFixed` / `unresolved` totals, which the per-band read
 * does not add up. Bounded integers keyed by the five fixed kinds: nothing
 * about who, nothing that grows. Since boot, in process, on `GET
 * /api/admin/metrics` as `callRatings.audioHealthSinceBoot`, and one
 * `voice.audioHealthRated` log line per rated call that saw anything.
 */
const audioHealthCounts = new Map<string, number>();

function bump(key: string, by: number): void {
  if (by > 0) {
    audioHealthCounts.set(key, (audioHealthCounts.get(key) ?? 0) + by);
  }
}

export function noteRatedAudioHealth(
  rating: number,
  transport: CallTransport,
  summary: AudioHealthSummary | undefined,
): void {
  if (!summary) {
    return;
  }
  const fields: Record<string, number | string> = { rating, transport };
  for (const kind of AUDIO_HEALTH_KINDS) {
    const counts = summary[kind];
    if (!counts || counts.detected === 0) {
      continue;
    }
    bump(`${kind}.calls`, 1);
    if (rating <= 2) {
      bump(`${kind}.lowRated`, 1);
    }
    for (const [field, value] of Object.entries(counts)) {
      bump(`${kind}.${field}`, value);
      fields[`${kind}.${field}`] = value;
    }
  }
  if (Object.keys(fields).length > 2) {
    logEvent("voice.audioHealthRated", fields);
  }
}

/** Snapshot for metrics: only keys actually seen appear (bounded set). */
export function callRatingAudioHealthCounts(): Record<string, number> {
  return Object.fromEntries(audioHealthCounts);
}

/** Test seam. */
export function resetCallRatingAudioHealthCounts(): void {
  audioHealthCounts.clear();
}

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
      // Every score carries it, on purpose. It used to be kept only for 3 or
      // less, so over eight weeks a good call had no measurements at all and
      // a bad one could not be compared with anything. The shape is bounded
      // numbers and booleans (`mediaQualitySchema`, strict, already parsed by
      // the route), nothing that names anybody, so there is no privacy reason
      // to throw a good call's reading away. The NOTE rule above is separate
      // and unchanged.
      input.mediaQuality ? JSON.stringify(input.mediaQuality) : null,
    ],
  );
  // Counted only once the row is stored, so a failed write (and the retry
  // that follows it) never counts one call twice.
  noteRatedAudioHealth(input.rating, input.transport, input.mediaQuality?.audioHealth);
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

interface BandRow {
  good: boolean;
  ratings: string;
  with_media: string;
  loss_median: number | null;
  rtt_median: number | null;
  reconnected: string;
  relay_known: string;
  relayed: string;
  [kind: string]: unknown;
}

function emptyBand(): MediaBandSummary {
  return {
    ratings: 0,
    withMedia: 0,
    packetLossPercentMedian: null,
    rttMsMedian: null,
    reconnectShare: null,
    relayedShare: null,
    audioHealthCalls: Object.fromEntries(AUDIO_HEALTH_KINDS.map((kind) => [kind, 0])),
  };
}

function share(part: string, whole: string): number | null {
  const n = Number(whole);
  return n > 0 ? Math.round((Number(part) / n) * 1000) / 1000 : null;
}

function round1(value: number | null): number | null {
  return value === null ? null : Math.round(Number(value) * 10) / 10;
}

/**
 * Good calls (4 to 5) beside low ones (1 to 3), in one scan of the window the
 * `created_at` index already serves. `media_quality` is NULL on phones and old
 * bundles, so every figure is over `withMedia`, not over `ratings`: a median of
 * the calls that were measured, with the sample size beside it.
 * `percentile_cont` ignores NULL, so a call with no loss reading adds nothing
 * to the loss median rather than dragging it to zero.
 */
const BAND_AUDIO_COLUMNS = AUDIO_HEALTH_KINDS.map(
  (kind) =>
    `COUNT(*) FILTER (WHERE media_quality->'audioHealth'->'${kind}' IS NOT NULL
        AND COALESCE((media_quality->'audioHealth'->'${kind}'->>'detected')::int, 0) > 0)::text AS "${kind}"`,
).join(",\n              ");

/**
 * The dashboard's view of call quality over the last `days` days.
 *
 * Four queries rather than one with grouping sets: each is a trivial index
 * scan over a small table, and the alternative is a single query whose result
 * needs unpicking in JavaScript anyway. Run concurrently.
 */
export async function callRatingSummary(
  days: number,
): Promise<CallRatingSummary> {
  const pool = getPool();
  const since = `now() - ($1::int * interval '1 day')`;
  const [distribution, byTransport, notes, bands] = await Promise.all([
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
    pool.query<BandRow>(
      `SELECT rating >= 4 AS good,
              COUNT(*)::text AS ratings,
              COUNT(media_quality)::text AS with_media,
              percentile_cont(0.5) WITHIN GROUP
                (ORDER BY (media_quality->>'packetLossPercent')::float8) AS loss_median,
              percentile_cont(0.5) WITHIN GROUP
                (ORDER BY (media_quality->>'rttMsMedian')::float8) AS rtt_median,
              COUNT(*) FILTER (
                WHERE COALESCE((media_quality->>'reconnectCount')::int, 0) > 0
              )::text AS reconnected,
              COUNT(*) FILTER (WHERE media_quality->>'relayed' IS NOT NULL)::text AS relay_known,
              COUNT(*) FILTER (WHERE media_quality->>'relayed' = 'true')::text AS relayed,
              ${BAND_AUDIO_COLUMNS}
         FROM call_ratings
        WHERE created_at >= ${since}
        GROUP BY 1`,
      [days],
    ),
  ]);

  const mediaByBand = { good: emptyBand(), low: emptyBand() };
  for (const row of bands.rows) {
    mediaByBand[row.good ? "good" : "low"] = {
      ratings: Number(row.ratings),
      withMedia: Number(row.with_media),
      packetLossPercentMedian: round1(row.loss_median),
      rttMsMedian: round1(row.rtt_median),
      reconnectShare: share(row.reconnected, row.with_media),
      relayedShare: share(row.relayed, row.relay_known),
      audioHealthCalls: Object.fromEntries(
        AUDIO_HEALTH_KINDS.map((kind) => [kind, Number(row[kind])]),
      ),
    };
  }

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
    mediaByBand,
  };
}

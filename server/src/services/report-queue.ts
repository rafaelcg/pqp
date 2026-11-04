import { getPool } from "../db.js";
import { BLOCK_REPORT_PLACE } from "./block-notice.js";

/**
 * `moderation.reports` on `GET /api/admin/metrics`: how many reports are open,
 * and, the figure that makes the 24 hour promise checkable, how long the OLDEST
 * open one has been waiting.
 *
 * WHY AGE AND NOT JUST A COUNT. A count of open reports cannot tell one filed a
 * minute ago from one filed three days ago, and "within 24 hours" is a claim
 * about the second. The dashboard's old "abertas" tile only ever said how many.
 * `oldestOpenAgeSeconds` is what a Grafana rule can compare with a number
 * (`tools/monitoring/grafana-alert-rules-moderation.json`, 12 h and 20 h).
 *
 * EVERY QUEUE COUNTS. The query reads the `reports` table whole: a server's own
 * queue (owner and admins), the instance queue, an automated scanner hit
 * (`reporter_id` NULL), a story, a Baú post, a community. A report sitting in a
 * server owner's queue that the owner never reads is exactly the case an
 * instance moderator has to catch, and `GET /api/reports/all` is the screen
 * that reaches it. Which queue a report is in is not this figure's business;
 * that it is unanswered is.
 *
 * ONE EXCEPTION, AND ONLY FOR THE AGE FIGURES: the informational "Bloqueio"
 * tickets a user's block opens (`services/block-notice.ts`: no reporter, a user
 * subject, place label `BLOCK_REPORT_PLACE`). They tell an operator that
 * somebody blocked an account; they are not reports of objectionable content,
 * and nobody promised to answer them within 24 hours. Left in, one ticket
 * nobody needs to act on would hold `oldestOpenAgeSeconds` above the 12 h and
 * 20 h alert lines forever. They still count in `open` (the queue shows them),
 * and once a moderator closes one it is just another resolved row.
 *
 * Read from Postgres, so both API replicas and the worker agree and the
 * exporter takes it from one replica (`moderation` is a take-first block).
 * It scans the whole table, as the counts it replaces always did: resolved
 * reports are pruned at 90 days (`pruneResolvedReports`) and the result sits in
 * the metrics snapshot's 30 second cache, so it runs about twice a minute.
 */
export interface ReportQueueStats {
  open: number;
  actioned: number;
  dismissed: number;
  /**
   * Filed in the last 24 hours, whatever their status now. A second look
   * (`escalated_from`, a copy of a server report its staff closed) is not a
   * new filing and is left out.
   */
  last24h: number;
  /**
   * Age in whole seconds of the oldest report still `open`, or 0 when none is.
   * 0 rather than null on purpose: "nothing waiting" is a healthy reading the
   * alert wants to see as a number, not an absence it has to guess about.
   */
  oldestOpenAgeSeconds: number;
  /** Open reports older than 12 hours: the warning line. */
  openOver12h: number;
  /** Open reports older than 24 hours: the promise already broken. */
  openOver24h: number;
}

/** The informational block tickets, as a predicate over `reports` ($1 = label). */
const IS_BLOCK_NOTICE = `(reporter_id IS NULL AND subject_type = 'user'
                          AND channel_label IS NOT DISTINCT FROM $1)`;

export async function reportQueueStats(): Promise<ReportQueueStats> {
  const result = await getPool().query<{
    open: string;
    actioned: string;
    dismissed: string;
    last24h: string;
    oldest_open_age_seconds: string;
    open_over_12h: string;
    open_over_24h: string;
  }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'open')::text AS open,
            COUNT(*) FILTER (WHERE status = 'actioned')::text AS actioned,
            COUNT(*) FILTER (WHERE status = 'dismissed')::text AS dismissed,
            COUNT(*) FILTER (
              WHERE created_at >= now() - interval '24 hours'
                AND escalated_from IS NULL
            )::text AS last24h,
            COALESCE(
              floor(extract(epoch FROM now() - MIN(created_at)
                FILTER (WHERE status = 'open' AND NOT ${IS_BLOCK_NOTICE}))),
              0
            )::text AS oldest_open_age_seconds,
            COUNT(*) FILTER (
              WHERE status = 'open' AND NOT ${IS_BLOCK_NOTICE}
                AND created_at < now() - interval '12 hours'
            )::text AS open_over_12h,
            COUNT(*) FILTER (
              WHERE status = 'open' AND NOT ${IS_BLOCK_NOTICE}
                AND created_at < now() - interval '24 hours'
            )::text AS open_over_24h
       FROM reports`,
    [BLOCK_REPORT_PLACE],
  );
  const row = result.rows[0];
  return {
    open: Number(row?.open ?? 0),
    actioned: Number(row?.actioned ?? 0),
    dismissed: Number(row?.dismissed ?? 0),
    last24h: Number(row?.last24h ?? 0),
    oldestOpenAgeSeconds: Math.max(0, Number(row?.oldest_open_age_seconds ?? 0)),
    openOver12h: Number(row?.open_over_12h ?? 0),
    openOver24h: Number(row?.open_over_24h ?? 0),
  };
}

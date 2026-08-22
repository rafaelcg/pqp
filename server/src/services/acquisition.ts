import type { AcquisitionInput } from "@pqp/shared";
import { getPool } from "../db.js";

/**
 * First-touch acquisition: which link brought an account here.
 *
 * Two functions and nothing else. `recordAcquisition` is the one write, made by
 * the client once right after sign-up; `acquisitionReport` is the one read,
 * made by the operator. There is no per-user read anywhere: these columns never
 * ride in a user payload, so they cannot leak through a profile, a member list
 * or a presence frame. See the `acquisition` block in schema.sql for why the
 * data exists at all.
 */

/** Empty after trimming means "the parameter was not there". */
function orNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * Write the acquisition onto the account, if the account has none.
 *
 * FIRST TOUCH IS ENFORCED IN THE WHERE CLAUSE, not by reading first: two tabs
 * bootstrapping at once both send, and only one of them can match
 * `acquisition_at IS NULL`. The age guard is the second rule: an account older
 * than a day that sends an acquisition is somebody who already had an account
 * clicking a campaign link on a fresh device, which is a visit and not an
 * acquisition. Counting it would credit the campaign with a signup it did not
 * produce, which is the exact number this exists to get right.
 *
 * Returns whether a row was written. Nothing upstream depends on the answer
 * today; it is returned so a test can tell the two refusals from a success.
 */
export async function recordAcquisition(
  userId: string,
  input: AcquisitionInput,
): Promise<boolean> {
  const values = [
    orNull(input.source),
    orNull(input.medium),
    orNull(input.campaign),
    orNull(input.gclid),
    orNull(input.ref),
    orNull(input.landing),
  ];
  if (values.every((value) => value === null)) {
    return false;
  }
  const result = await getPool().query(
    `UPDATE users SET
       acquisition_source = $2,
       acquisition_medium = $3,
       acquisition_campaign = $4,
       acquisition_gclid = $5,
       acquisition_ref = $6,
       acquisition_landing = $7,
       acquisition_at = now()
     WHERE id = $1
       AND acquisition_at IS NULL
       AND created_at > now() - interval '1 day'`,
    [userId, ...values],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface AcquisitionReportRow {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  /**
   * pqp's own short-link parameter. Reported alongside the UTM trio rather
   * than folded into it: a `?ref=reddit` link is the readable form we hand to
   * humans, and if it did not appear here it would land in the report as an
   * unattributed signup, which is the exact hole this report exists to close.
   */
  ref: string | null;
  signups: number;
}

export interface AcquisitionReport {
  /** Inclusive lower bound of the window, ISO. */
  since: string;
  days: number;
  /** Every account created in the window, attributed or not. */
  total: number;
  /** Attributed accounts, grouped; an all-null row is "no campaign parameters". */
  rows: AcquisitionReportRow[];
  /** The same window broken down by the page the person first landed on. */
  landings: AcquisitionLandingRow[];
}

export interface AcquisitionLandingRow {
  landing: string | null;
  signups: number;
}

/**
 * Signups in the last `days` days, grouped by source/medium/campaign.
 *
 * Grouped by ACCOUNT CREATION DATE rather than by `acquisition_at`: the
 * question is "how many of the people who signed up this month came from X",
 * and the unattributed row is part of that answer, so it is kept rather than
 * filtered. Webhook pseudo-rows and the house cast are not signups and are
 * excluded. The gclid is not a grouping key (it is unique per click, which
 * would make every row a count of one); it is there for the day a campaign
 * needs to be reconciled against the ad platform by hand.
 */
export async function acquisitionReport(days: number): Promise<AcquisitionReport> {
  const pool = getPool();
  const [grouped, total, landings] = await Promise.all([
    pool.query<{
      source: string | null;
      medium: string | null;
      campaign: string | null;
      ref: string | null;
      signups: string;
    }>(
      `SELECT acquisition_source AS source,
              acquisition_medium AS medium,
              acquisition_campaign AS campaign,
              acquisition_ref AS ref,
              COUNT(*)::text AS signups
         FROM users
        WHERE created_at >= now() - ($1::int * interval '1 day')
          AND NOT is_webhook
          AND NOT is_character
        GROUP BY 1, 2, 3, 4
        ORDER BY COUNT(*) DESC, 1 NULLS LAST, 2 NULLS LAST, 3 NULLS LAST, 4 NULLS LAST`,
      [days],
    ),
    pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total
         FROM users
        WHERE created_at >= now() - ($1::int * interval '1 day')
          AND NOT is_webhook
          AND NOT is_character`,
      [days],
    ),
    pool.query<{ landing: string | null; signups: string }>(
      `SELECT acquisition_landing AS landing,
              COUNT(*)::text AS signups
         FROM users
        WHERE created_at >= now() - ($1::int * interval '1 day')
          AND NOT is_webhook
          AND NOT is_character
          AND acquisition_landing IS NOT NULL
        GROUP BY 1
        ORDER BY COUNT(*) DESC, 1`,
      [days],
    ),
  ]);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return {
    since: since.toISOString(),
    days,
    total: Number(total.rows[0]?.total ?? 0),
    rows: grouped.rows.map((row) => ({
      source: row.source,
      medium: row.medium,
      campaign: row.campaign,
      ref: row.ref,
      signups: Number(row.signups),
    })),
    landings: landings.rows.map((row) => ({
      landing: row.landing,
      signups: Number(row.signups),
    })),
  };
}

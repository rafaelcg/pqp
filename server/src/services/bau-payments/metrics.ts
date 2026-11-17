import { getPool } from "../../db.js";

/**
 * Baú+ payments on `GET /api/admin/metrics` (`creatorHub.payments`). Counts
 * only: no amount per person, no name, no charge id.
 *
 * `process` is this process since it started (two API machines and a worker
 * each have their own, like the push counters). `db` is deployment wide,
 * cached 30 s, null when the read failed.
 */

const counters = {
  checkoutsStarted: 0,
  checkoutsReused: 0,
  paid: 0,
  renewalsPaid: 0,
  attemptsExpired: 0,
  attemptsFailed: 0,
  refunds: 0,
  refundsRefused: 0,
  cancels: 0,
  resumes: 0,
  reminders: 0,
  graceEntered: 0,
  membershipsExpired: 0,
  vipGranted: 0,
  vipRevoked: 0,
  vipRegranted: 0,
  providerErrors: 0,
  webhooksReceived: 0,
  webhooksDuplicate: 0,
  webhooksBadSignature: 0,
  webhooksUnknownCharge: 0,
  webhooksFailed: 0,
};

export type BauPaymentsCounter = keyof typeof counters;

export function countBauPayments(name: BauPaymentsCounter, by = 1): void {
  counters[name] += by;
}

export interface BauPaymentsMetrics {
  process: Record<BauPaymentsCounter, number>;
  db: {
    plansActive: number;
    payoutAccountsConnected: number;
    memberships: Record<string, number>;
    /** Memberships holding the VIP cargo through a payment right now. */
    vipFromPayments: number;
    attemptsPending: number;
    paid7d: number;
    refunded7d: number;
  } | null;
}

let cached: { at: number; value: BauPaymentsMetrics["db"] } | null = null;

async function readDb(): Promise<NonNullable<BauPaymentsMetrics["db"]>> {
  const result = await getPool().query<Record<string, string | null>>(
    `SELECT
       (SELECT COUNT(*) FROM bau_plans WHERE active)::text AS plans,
       (SELECT COUNT(*) FROM bau_payout_accounts WHERE status = 'connected')::text AS accounts,
       (SELECT COALESCE(json_object_agg(status, n), '{}'::json)
          FROM (SELECT status, COUNT(*) AS n FROM bau_memberships GROUP BY status) s)::text AS statuses,
       (SELECT COUNT(*) FROM bau_memberships WHERE vip_owned)::text AS vip,
       (SELECT COUNT(*) FROM bau_payment_attempts WHERE status = 'pending')::text AS pending,
       (SELECT COUNT(*) FROM bau_payment_attempts
         WHERE paid_at > NOW() - INTERVAL '7 days')::text AS paid7d,
       (SELECT COUNT(*) FROM bau_payment_attempts
         WHERE refunded_at > NOW() - INTERVAL '7 days')::text AS refunded7d`,
  );
  const row = result.rows[0] ?? {};
  const n = (value: string | null | undefined) => Number(value ?? 0);
  return {
    plansActive: n(row.plans),
    payoutAccountsConnected: n(row.accounts),
    memberships: JSON.parse(row.statuses ?? "{}") as Record<string, number>,
    vipFromPayments: n(row.vip),
    attemptsPending: n(row.pending),
    paid7d: n(row.paid7d),
    refunded7d: n(row.refunded7d),
  };
}

export async function bauPaymentsMetrics(): Promise<BauPaymentsMetrics> {
  const now = Date.now();
  if (!cached || now - cached.at > 30_000) {
    try {
      cached = { at: now, value: await readDb() };
    } catch (error) {
      console.error("[bau-payments] metrics read failed:", error);
      cached = { at: now, value: null };
    }
  }
  return { process: { ...counters }, db: cached.value };
}

export function resetBauPaymentsMetricsForTests(): void {
  for (const key of Object.keys(counters) as BauPaymentsCounter[]) {
    counters[key] = 0;
  }
  cached = null;
}

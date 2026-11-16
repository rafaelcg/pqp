import { BAU_GRACE_DAYS, BAU_REMINDER_DAYS, type BauMembershipStatus } from "@pqp/shared";
import { getPool } from "../../db.js";
import { countBauPayments } from "./metrics.js";
import { notifyBauPlusUpdate } from "./notify.js";
import {
  auditBauMembership,
  cancelPendingAttemptRow,
  syncAttemptFromProvider,
  type BauAttemptRow,
} from "./service.js";
import { HAS_ACCESS_SQL, grantVipForMembership, revokeVipForMembership } from "./vip.js";

/**
 * The monthly clock, once a minute (`jobs.ts`, so the worker runs it when
 * there is one). Runs whatever the flags say: turning `bau_payments` off stops
 * NEW checkouts and must keep honouring the months people already paid for,
 * so a VIP still expires on its date and a refund still ends access.
 *
 * Every step claims its rows with a conditional UPDATE ... RETURNING (or a
 * row lock inside `vip.ts`), so with two processes each row moves once and
 * each fan is told once. Every step is bounded per tick.
 *
 *   1. Codes past their expiry: asked of the provider, expired if still open.
 *   2. Reminder, `BAU_REMINDER_DAYS` before the month ends, once per month.
 *   3. active -> grace when the month ends unpaid.
 *   4. grace -> expired `BAU_GRACE_DAYS` later.
 *   5. VIP taken back from every membership without access that gave it
 *      (expired, refunded, cancelled at the end of its month, or a step above
 *      that died between its UPDATE and the revoke).
 *   6. VIP given back to a fan who left and came back (kick or leave drops
 *      `member_roles` by FK) while still paid, and to a paid membership whose
 *      grant never landed. Staff taking the cargo away on purpose is NOT
 *      undone: that leaves `vip_granted_at` after the current `joined_at`.
 */

const BATCH = 200;

interface Claimed {
  id: string;
  server_id: string;
  user_id: string;
  status: BauMembershipStatus;
}

export interface BauSweepResult {
  attemptsChecked: number;
  reminders: number;
  grace: number;
  expired: number;
  revoked: number;
  regranted: number;
}

export async function sweepBauPayments(): Promise<BauSweepResult> {
  const pool = getPool();
  const result: BauSweepResult = {
    attemptsChecked: 0,
    reminders: 0,
    grace: 0,
    expired: 0,
    revoked: 0,
    regranted: 0,
  };

  const stale = await pool.query<BauAttemptRow>(
    `SELECT * FROM bau_payment_attempts
      WHERE status = 'pending' AND expires_at < NOW() - INTERVAL '30 seconds'
      ORDER BY expires_at
      LIMIT 100`,
  );
  for (const row of stale.rows) {
    try {
      await syncAttemptFromProvider(row);
      result.attemptsChecked += 1;
    } catch (error) {
      console.error("[bau-payments] sweep sync failed:", error);
    }
  }

  // Open codes made pointless by a payment on the same membership (two tabs,
  // Pix then card) that the provider did not cancel when it settled. Asked
  // again every tick until the provider agrees, so a sibling never stays
  // payable for its whole lifetime after a refusal.
  const orphans = await pool.query<BauAttemptRow>(
    // Least recently tried first, and a refusal is stamped, so a handful the
    // provider keeps refusing can never starve the rest. A settled sibling
    // that was later refunded still counts: the code is just as pointless.
    `SELECT a.* FROM bau_payment_attempts a
      WHERE a.status = 'pending'
        AND EXISTS (SELECT 1 FROM bau_payment_attempts p
                     WHERE p.membership_id = a.membership_id
                       AND p.status IN ('paid', 'refunded')
                       AND p.paid_at > a.created_at)
      ORDER BY a.updated_at
      LIMIT 100`,
  );
  for (const row of orphans.rows) {
    try {
      if (!(await cancelPendingAttemptRow(row))) {
        await pool.query(`UPDATE bau_payment_attempts SET updated_at = NOW() WHERE id = $1`, [row.id]);
      }
    } catch (error) {
      console.error("[bau-payments] sweep sibling cancel failed:", error);
    }
  }

  const reminded = await pool.query<Claimed>(
    `UPDATE bau_memberships m
        SET reminded_for = m.period_end, updated_at = NOW()
      WHERE m.id IN (
        SELECT id FROM bau_memberships
         WHERE status = 'active'
           AND period_end > NOW()
           AND period_end <= NOW() + ($1::int * INTERVAL '1 day')
           AND reminded_for IS DISTINCT FROM period_end
         LIMIT ${BATCH})
      RETURNING m.id, m.server_id, m.user_id, m.status`,
    [BAU_REMINDER_DAYS],
  );
  for (const row of reminded.rows) {
    result.reminders += 1;
    countBauPayments("reminders");
    notifyBauPlusUpdate(row.user_id, {
      serverId: row.server_id,
      membershipId: row.id,
      status: row.status,
      attemptId: null,
      reason: "reminder",
    });
  }

  const grace = await pool.query<Claimed>(
    `UPDATE bau_memberships m
        SET status = 'grace', updated_at = NOW()
      WHERE m.id IN (
        SELECT id FROM bau_memberships
         WHERE status = 'active' AND period_end <= NOW()
         LIMIT ${BATCH})
        AND m.status = 'active'
      RETURNING m.id, m.server_id, m.user_id, m.status`,
  );
  for (const row of grace.rows) {
    result.grace += 1;
    countBauPayments("graceEntered");
    await auditBauMembership(row, "bau_plus.grace", [{ key: "status", old: "active", new: "grace" }], null);
    notifyBauPlusUpdate(row.user_id, {
      serverId: row.server_id,
      membershipId: row.id,
      status: "grace",
      attemptId: null,
      reason: "grace",
    });
  }

  const expired = await pool.query<Claimed>(
    `UPDATE bau_memberships m
        SET status = 'expired', expired_at = NOW(), updated_at = NOW()
      WHERE m.id IN (
        SELECT id FROM bau_memberships
         WHERE status = 'grace'
           AND period_end + ($1::int * INTERVAL '1 day') <= NOW()
         LIMIT ${BATCH})
        AND m.status = 'grace'
      RETURNING m.id, m.server_id, m.user_id, m.status`,
    [BAU_GRACE_DAYS],
  );
  for (const row of expired.rows) {
    result.expired += 1;
    countBauPayments("membershipsExpired");
    await auditBauMembership(row, "bau_plus.expire", [{ key: "status", old: "grace", new: "expired" }], null);
  }

  const toRevoke = await pool.query<Claimed>(
    `SELECT m.id, m.server_id, m.user_id, m.status FROM bau_memberships m
      WHERE m.vip_owned AND NOT ${HAS_ACCESS_SQL}
      LIMIT ${BATCH}`,
  );
  for (const row of toRevoke.rows) {
    try {
      if (await revokeVipForMembership(row.id)) {
        result.revoked += 1;
        notifyBauPlusUpdate(row.user_id, {
          serverId: row.server_id,
          membershipId: row.id,
          status: row.status,
          attemptId: null,
          reason: row.status === "refunded" ? "refunded" : "expired",
        });
      }
    } catch (error) {
      console.error("[bau-payments] sweep revoke failed:", error);
    }
  }

  const toGrant = await pool.query<Claimed & { granted_before: boolean }>(
    `SELECT m.id, m.server_id, m.user_id, m.status,
            (m.vip_granted_at IS NOT NULL) AS granted_before
       FROM bau_memberships m
       JOIN server_members sm ON sm.server_id = m.server_id AND sm.user_id = m.user_id
      WHERE ${HAS_ACCESS_SQL}
        AND (m.vip_granted_at IS NULL OR m.vip_granted_at < sm.joined_at)
        AND NOT EXISTS (
          SELECT 1 FROM member_roles mr
            JOIN roles r ON r.id = mr.role_id AND r.server_id = mr.server_id
           WHERE mr.server_id = m.server_id AND mr.user_id = m.user_id
             AND r.system_key = 'vip')
      LIMIT ${BATCH}`,
  );
  for (const row of toGrant.rows) {
    try {
      if (await grantVipForMembership(row.id)) {
        result.regranted += 1;
        countBauPayments("vipRegranted");
        if (row.granted_before) {
          await auditBauMembership(row, "bau_plus.vip_regrant", [{ key: "vip", old: false, new: true }], null);
        }
      }
    } catch (error) {
      console.error("[bau-payments] sweep regrant failed:", error);
    }
  }

  return result;
}

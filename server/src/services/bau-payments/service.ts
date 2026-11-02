import {
  BAU_GRACE_DAYS,
  BAU_REFUND_WINDOW_DAYS,
  BAU_REMINDER_DAYS,
  bauMembershipHasAccess,
  type AuditAction,
  type BauAttemptKind,
  type BauAttemptResponse,
  type BauAttemptStatus,
  type BauCheckoutBody,
  type BauFailureReason,
  type BauMembership,
  type BauMembershipStatus,
  type BauOffer,
  type BauPaymentAttempt,
  type BauPaymentMethod,
  type BauPlan,
  type BauPlanBody,
  type BauReceipt,
  type BauSandboxAction,
  type BauSeller,
} from "@pqp/shared";
import type { PoolClient } from "pg";
import { getPool } from "../../db.js";
import { isEnabled } from "../../lib/flags.js";
import { HttpError } from "../../lib/http.js";
import { logEvent } from "../../lib/log.js";
import { logAudit } from "../audit.js";
import { countBauPayments } from "./metrics.js";
import { notifyBauPlusUpdate } from "./notify.js";
import {
  activePaymentProvider,
  getRegisteredProvider,
  isSandboxAllowed,
  registerPaymentProvider,
  type PaymentProvider,
  type ProviderAccount,
  type ProviderCharge,
  type ProviderWebhookEvent,
} from "./provider.js";
import { createSandboxProvider, type SandboxProvider } from "./sandbox-provider.js";
import { grantVipForMembership, revokeVipForMembership } from "./vip.js";

/**
 * BAÚ+ PAYMENTS: offer, checkout, the charge state machine, cancel, refund.
 * Contract and the reasoning behind each rule: `docs/BAU_PAYMENTS.md`.
 *
 * The state machine lives in one function, `applyCharge`, which takes what the
 * PROVIDER says about a charge (never what a webhook body claims) and moves our
 * rows with the attempt and the membership locked. Every caller (webhook, poll,
 * sweep, dev controls) goes through it, and every move is guarded on the
 * current status, so a repeat is a no-op and two processes cannot both apply
 * the same payment.
 */

export const sandboxProvider: SandboxProvider = createSandboxProvider();
registerPaymentProvider(sandboxProvider);
sandboxProvider.setEventSink((events) => handleProviderEvents(sandboxProvider, events).then(() => {}));

function pixTtlMs(): number {
  const minutes = Number(process.env.BAU_PAYMENTS_PIX_TTL_MINUTES ?? 15);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60_000;
}
const CARD_TTL_MS = 30 * 60_000;
/** A pending charge younger than this is handed back instead of making a new one. */
const REUSE_MARGIN_MS = 60_000;
/** Charges a fan may start for one membership per hour. */
const ATTEMPTS_PER_HOUR = 12;
/** A poll asks the provider at most this often per charge, unless told to. */
const PROVIDER_REFRESH_MS = 10_000;

const DAY_MS = 86_400_000;

// ------------------------------------------------------------------ gating

/** The flags that make a server sell. Checkout needs every one of them. */
export function isBauPaymentsOnFor(serverId: string): boolean {
  return (
    isEnabled("community_home") &&
    isEnabled("community_home_vip", { serverId }) &&
    isEnabled("bau_payments", { serverId })
  );
}

// ------------------------------------------------------------------ rows

interface PlanRow {
  id: string;
  server_id: string;
  name: string;
  price_cents: number;
  currency: "BRL";
  perks: unknown;
  active: boolean;
}

interface PayoutRow {
  server_id: string;
  provider: string;
  account_ref: string;
  seller_name: string;
  status: "connected" | "disabled";
}

interface MembershipRow {
  id: string;
  server_id: string;
  user_id: string;
  plan_id: string;
  status: BauMembershipStatus;
  period_start: Date | null;
  period_end: Date | null;
  first_paid_at: Date | null;
  last_paid_at: Date | null;
  cancelled_at: Date | null;
  refunded_at: Date | null;
  vip_owned: boolean;
}

interface AttemptRow {
  id: string;
  membership_id: string;
  server_id: string;
  user_id: string;
  plan_id: string;
  provider: string;
  account_ref: string;
  provider_ref: string | null;
  method: BauPaymentMethod;
  kind: BauAttemptKind;
  amount_cents: number;
  status: BauAttemptStatus;
  failure_reason: BauFailureReason | null;
  pix_code: string | null;
  redirect_url: string | null;
  seller_name: string;
  provider_label: string;
  expires_at: Date;
  paid_at: Date | null;
  refunded_at: Date | null;
  period_start: Date | null;
  period_end: Date | null;
  created_at: Date;
}

function toPlan(row: PlanRow): BauPlan {
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    priceCents: row.price_cents,
    currency: "BRL",
    perks: Array.isArray(row.perks) ? row.perks.filter((p): p is string => typeof p === "string") : [],
    active: row.active,
  };
}

function providerLabelOf(id: string): string {
  return getRegisteredProvider(id)?.label ?? id;
}

function toAttempt(row: AttemptRow): BauPaymentAttempt {
  return {
    id: row.id,
    membershipId: row.membership_id,
    serverId: row.server_id,
    method: row.method,
    kind: row.kind,
    status: row.status,
    amountCents: row.amount_cents,
    currency: "BRL",
    // A code is only useful while it can still be paid.
    pixCode: row.status === "pending" ? row.pix_code : null,
    redirectUrl: row.status === "pending" ? row.redirect_url : null,
    expiresAt: row.expires_at.toISOString(),
    paidAt: row.paid_at?.toISOString() ?? null,
    failureReason: row.failure_reason,
    createdAt: row.created_at.toISOString(),
    sandbox: row.provider === "sandbox",
  };
}

function toReceipt(row: AttemptRow): BauReceipt {
  return {
    attemptId: row.id,
    status: row.status === "refunded" ? "refunded" : "paid",
    method: row.method,
    amountCents: row.amount_cents,
    currency: "BRL",
    paidAt: (row.paid_at ?? row.created_at).toISOString(),
    refundedAt: row.refunded_at?.toISOString() ?? null,
    periodStart: row.period_start?.toISOString() ?? null,
    periodEnd: row.period_end?.toISOString() ?? null,
    sellerName: row.seller_name,
    providerLabel: row.provider_label,
    reference: row.provider_ref ?? row.id,
  };
}

/** The last moment the 7-day refund can be asked for, or null. */
function refundableUntil(membership: MembershipRow, attempts: AttemptRow[], now: Date): Date | null {
  if (membership.status === "refunded" || membership.status === "pending") {
    return null;
  }
  // The withdrawal right is for the membership's FIRST-EVER payment. The row
  // keeps `first_paid_at` forever (a refund or an expiry never clears it) and
  // it is the paid charge's own `paid_at`, so the test is on the membership,
  // not on how much history was read: a renewal, and a payment after an
  // earlier one was refunded or ran out, do not reopen it.
  const latestPaid = attempts.find((a) => a.status === "paid");
  if (
    !latestPaid?.paid_at ||
    !membership.first_paid_at ||
    latestPaid.paid_at.getTime() !== membership.first_paid_at.getTime()
  ) {
    return null;
  }
  const until = new Date(latestPaid.paid_at.getTime() + BAU_REFUND_WINDOW_DAYS * DAY_MS);
  return until > now ? until : null;
}

function renewalDue(row: MembershipRow, now: Date): boolean {
  if (row.status === "grace") {
    return true;
  }
  if (row.status !== "active" || !row.period_end) {
    return false;
  }
  return row.period_end.getTime() - now.getTime() <= BAU_REMINDER_DAYS * DAY_MS;
}

interface MembershipContext {
  server_name: string;
  server_icon_url: string | null;
  plan_name: string;
  plan_price_cents: number;
  seller_name: string | null;
  payout_provider: string | null;
}

function toMembership(
  row: MembershipRow & MembershipContext,
  attempts: AttemptRow[],
  now = new Date(),
): BauMembership {
  const pending = attempts.find((a) => a.status === "pending" && a.expires_at > now) ?? null;
  const newest = attempts[0];
  const seller: BauSeller = {
    name: row.seller_name ?? newest?.seller_name ?? row.server_name,
    providerLabel: providerLabelOf(row.payout_provider ?? newest?.provider ?? "sandbox"),
  };
  const refundUntil = refundableUntil(row, attempts, now);
  return {
    id: row.id,
    serverId: row.server_id,
    serverName: row.server_name,
    serverIconUrl: row.server_icon_url,
    plan: {
      id: row.plan_id,
      name: row.plan_name,
      priceCents: row.plan_price_cents,
      currency: "BRL",
    },
    status: row.status,
    hasAccess: bauMembershipHasAccess(row.status, row.period_end, now),
    periodStart: row.period_start?.toISOString() ?? null,
    periodEnd: row.period_end?.toISOString() ?? null,
    graceEndsAt: row.period_end
      ? new Date(row.period_end.getTime() + BAU_GRACE_DAYS * DAY_MS).toISOString()
      : null,
    renewalDue: renewalDue(row, now),
    refundableUntil: refundUntil?.toISOString() ?? null,
    firstPaidAt: row.first_paid_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    refundedAt: row.refunded_at?.toISOString() ?? null,
    seller,
    pendingAttempt: pending ? toAttempt(pending) : null,
    // Two years of months is plenty for a screen; the rows stay.
    receipts: attempts
      .filter((a) => a.status === "paid" || a.status === "refunded")
      .slice(0, 24)
      .map(toReceipt),
  };
}

const MEMBERSHIP_SELECT = `
  SELECT m.*, s.name AS server_name, s.icon_url AS server_icon_url,
         p.name AS plan_name, p.price_cents AS plan_price_cents,
         pa.seller_name, pa.provider AS payout_provider
    FROM bau_memberships m
    JOIN servers s ON s.id = m.server_id
    JOIN bau_plans p ON p.id = m.plan_id
    LEFT JOIN bau_payout_accounts pa ON pa.server_id = m.server_id`;

async function attemptsFor(membershipIds: string[]): Promise<Map<string, AttemptRow[]>> {
  const byMembership = new Map<string, AttemptRow[]>();
  if (membershipIds.length === 0) {
    return byMembership;
  }
  // The newest 30 per membership: enough for the screen (24 receipts and any
  // open code), and the pay sheet's poll never drags a long history along.
  const result = await getPool().query<AttemptRow>(
    `SELECT * FROM (
       SELECT a.*, ROW_NUMBER() OVER (PARTITION BY a.membership_id ORDER BY a.created_at DESC) AS rn
         FROM bau_payment_attempts a
        WHERE a.membership_id = ANY($1::uuid[])
     ) ranked
     WHERE rn <= 30
     ORDER BY created_at DESC`,
    [membershipIds],
  );
  for (const row of result.rows) {
    const list = byMembership.get(row.membership_id) ?? [];
    list.push(row);
    byMembership.set(row.membership_id, list);
  }
  return byMembership;
}

async function readMembership(where: string, params: unknown[]): Promise<BauMembership | null> {
  const result = await getPool().query<MembershipRow & MembershipContext>(
    `${MEMBERSHIP_SELECT} WHERE ${where} LIMIT 1`,
    params,
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  const attempts = await attemptsFor([row.id]);
  return toMembership(row, attempts.get(row.id) ?? []);
}

export function getMembershipById(id: string): Promise<BauMembership | null> {
  return readMembership(`m.id = $1`, [id]);
}

export async function listMyMemberships(userId: string): Promise<BauMembership[]> {
  const result = await getPool().query<MembershipRow & MembershipContext>(
    `${MEMBERSHIP_SELECT}
      WHERE m.user_id = $1
        AND (m.first_paid_at IS NOT NULL
             OR EXISTS (SELECT 1 FROM bau_payment_attempts a
                         WHERE a.membership_id = m.id AND a.status = 'pending'
                           AND a.expires_at > NOW()))
      ORDER BY m.updated_at DESC
      LIMIT 50`,
    [userId],
  );
  const attempts = await attemptsFor(result.rows.map((row) => row.id));
  return result.rows.map((row) => toMembership(row, attempts.get(row.id) ?? []));
}

// ------------------------------------------------------------------ offer

async function readPlan(serverId: string): Promise<PlanRow | null> {
  const result = await getPool().query<PlanRow>(
    `SELECT * FROM bau_plans WHERE server_id = $1 AND active LIMIT 1`,
    [serverId],
  );
  return result.rows[0] ?? null;
}

async function readPayout(serverId: string): Promise<PayoutRow | null> {
  const result = await getPool().query<PayoutRow>(
    `SELECT * FROM bau_payout_accounts WHERE server_id = $1`,
    [serverId],
  );
  return result.rows[0] ?? null;
}

interface Sellable {
  plan: PlanRow;
  payout: PayoutRow;
  provider: PaymentProvider;
}

async function sellable(serverId: string): Promise<Sellable | null> {
  if (!isBauPaymentsOnFor(serverId)) {
    return null;
  }
  const provider = activePaymentProvider();
  if (!provider) {
    return null;
  }
  const [server, plan, payout] = await Promise.all([
    getPool().query<{ community_home_enabled: boolean }>(
      `SELECT community_home_enabled FROM servers WHERE id = $1`,
      [serverId],
    ),
    readPlan(serverId),
    readPayout(serverId),
  ]);
  if (!server.rows[0]?.community_home_enabled || !plan || !payout) {
    return null;
  }
  if (payout.status !== "connected" || payout.provider !== provider.id) {
    return null;
  }
  return { plan, payout, provider };
}

/**
 * What a member of this server may buy. Answers with the fan's own membership
 * even when selling is off, so somebody who paid can still see and cancel it
 * after an operator turns a server off.
 */
export async function getBauOffer(serverId: string, userId: string): Promise<BauOffer> {
  const [sale, membership] = await Promise.all([
    sellable(serverId),
    readMembership(`m.server_id = $1 AND m.user_id = $2`, [serverId, userId]),
  ]);
  return {
    enabled: Boolean(sale),
    plan: sale ? toPlan(sale.plan) : null,
    seller: sale
      ? { name: sale.payout.seller_name, providerLabel: sale.provider.label }
      : null,
    methods: sale ? [...sale.provider.methods] : [],
    sandbox: Boolean(sale?.provider.sandbox),
    membership: membership && (membership.firstPaidAt || membership.pendingAttempt) ? membership : null,
    graceDays: BAU_GRACE_DAYS,
    reminderDays: BAU_REMINDER_DAYS,
    refundWindowDays: BAU_REFUND_WINDOW_DAYS,
  };
}

// ------------------------------------------------------------------ checkout

async function attemptWithMembership(
  attemptId: string,
  loaded?: AttemptRow,
): Promise<BauAttemptResponse> {
  let row = loaded;
  if (!row) {
    const attempt = await getPool().query<AttemptRow>(
      `SELECT * FROM bau_payment_attempts WHERE id = $1`,
      [attemptId],
    );
    row = attempt.rows[0];
  }
  if (!row) {
    throw new HttpError(404, "Not found");
  }
  const membership = await getMembershipById(row.membership_id);
  if (!membership) {
    throw new HttpError(404, "Not found");
  }
  return { attempt: toAttempt(row), membership };
}

async function reserveAttempt(
  membershipId: string,
  input: {
    serverId: string;
    userId: string;
    method: BauPaymentMethod;
    kind: BauAttemptKind;
    expiresAt: Date;
    sale: Sellable;
  },
): Promise<{ row: AttemptRow; reused: boolean }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT 1 FROM bau_memberships WHERE id = $1 FOR UPDATE`, [membershipId]);
    const pending = await client.query<AttemptRow>(
      `SELECT * FROM bau_payment_attempts
        WHERE membership_id = $1 AND status = 'pending' AND method = $2
          AND expires_at > NOW() + ($3::int * INTERVAL '1 millisecond')
        ORDER BY created_at DESC LIMIT 1`,
      [membershipId, input.method, REUSE_MARGIN_MS],
    );
    const open = pending.rows[0];
    if (open && open.amount_cents === input.sale.plan.price_cents) {
      await client.query("COMMIT");
      return { row: open, reused: true };
    }
    const recent = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM bau_payment_attempts
        WHERE membership_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [membershipId],
    );
    if (Number(recent.rows[0]?.n ?? 0) >= ATTEMPTS_PER_HOUR) {
      throw new HttpError(429, "too_many_attempts");
    }
    const created = await client.query<AttemptRow>(
      `INSERT INTO bau_payment_attempts
         (membership_id, server_id, user_id, plan_id, provider, account_ref, method, kind,
          amount_cents, seller_name, provider_label, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        membershipId,
        input.serverId,
        input.userId,
        input.sale.plan.id,
        input.sale.provider.id,
        input.sale.payout.account_ref,
        input.method,
        input.kind,
        input.sale.plan.price_cents,
        input.sale.payout.seller_name,
        input.sale.provider.label,
        input.expiresAt,
      ],
    );
    await client.query("COMMIT");
    return { row: created.rows[0]!, reused: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Start (or resume) paying for the server's plan. Hands back a pending charge
 * that is still good rather than making a second one, so a double tap, a
 * reload or a second tab never stacks charges.
 */
export async function startBauCheckout(
  serverId: string,
  userId: string,
  body: BauCheckoutBody,
): Promise<BauAttemptResponse> {
  const sale = await sellable(serverId);
  if (!sale) {
    throw new HttpError(404, "Not found");
  }
  if (sale.plan.id !== body.planId) {
    throw new HttpError(409, "plan_changed");
  }
  if (!sale.provider.methods.includes(body.method)) {
    throw new HttpError(400, "method_unavailable");
  }

  const upsert = await getPool().query<MembershipRow>(
    `INSERT INTO bau_memberships (server_id, user_id, plan_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (server_id, user_id) DO UPDATE SET updated_at = bau_memberships.updated_at
     RETURNING *`,
    [serverId, userId, sale.plan.id],
  );
  const membership = upsert.rows[0]!;
  const now = new Date();
  const access = bauMembershipHasAccess(membership.status, membership.period_end, now);
  if (access && !renewalDue(membership, now)) {
    // Nothing to pay yet: active and outside the reminder window, or cancelled
    // with time left (that is `resume`, which charges nothing).
    throw new HttpError(409, "already_member");
  }

  // One checkout at a time per membership: the "is there a good open code"
  // question and the insert of a new one run under a transaction lock, so two
  // taps or two tabs at the same instant get the same code instead of two
  // payable charges.
  const kind: BauAttemptKind = access ? "renewal" : "first";
  const expiresAt = new Date(now.getTime() + (body.method === "pix" ? pixTtlMs() : CARD_TTL_MS));
  const reserved = await reserveAttempt(membership.id, {
    serverId,
    userId,
    method: body.method,
    kind,
    expiresAt,
    sale,
  });
  if (reserved.reused) {
    countBauPayments("checkoutsReused");
    return attemptWithMembership(reserved.row.id, reserved.row);
  }
  const attempt = reserved.row;
  const serverName = await getPool().query<{ name: string }>(
    `SELECT name FROM servers WHERE id = $1`,
    [serverId],
  );

  let charge: ProviderCharge;
  try {
    charge = await sale.provider.createCharge({
      account: { ref: sale.payout.account_ref, sellerName: sale.payout.seller_name },
      reference: attempt.id,
      amountCents: sale.plan.price_cents,
      currency: "BRL",
      method: body.method,
      description: `VIP ${serverName.rows[0]?.name ?? ""}`.trim().slice(0, 60),
      expiresAt,
    });
  } catch (error) {
    countBauPayments("providerErrors");
    console.error("[bau-payments] createCharge failed:", error);
    await getPool().query(
      `UPDATE bau_payment_attempts
          SET status = 'failed', failure_reason = 'provider_error', updated_at = NOW()
        WHERE id = $1`,
      [attempt.id],
    );
    throw new HttpError(502, "provider_unavailable");
  }

  await recordProviderCharge(attempt.id, charge);
  countBauPayments("checkoutsStarted");
  logEvent("bauPayments.checkout", {
    serverId,
    method: body.method,
    kind,
    provider: sale.provider.id,
  });

  // A pending charge of the OTHER method is cancelled, so a fan who moves
  // from Pix to card (or back) can never pay both.
  void cancelOtherPending(membership.id, attempt.id);

  // A charge that came back already settled (a provider that confirms a card
  // synchronously) goes through the same machine at once.
  if (charge.status !== "pending") {
    await applyCharge(attempt.id, charge, "provider");
  }
  return attemptWithMembership(attempt.id);
}

/**
 * The provider made the charge; this row must learn its ref, or a payment on
 * it could never be matched. Retried, and if the database still refuses, the
 * webhook path finds the attempt by the reference we sent (`charge.reference`
 * is our attempt id) and fills the ref in then.
 */
async function recordProviderCharge(attemptId: string, charge: ProviderCharge): Promise<void> {
  let lastError: unknown = null;
  for (let tries = 0; tries < 3; tries += 1) {
    try {
      await getPool().query(
        `UPDATE bau_payment_attempts
            SET provider_ref = $2, pix_code = $3, redirect_url = $4, expires_at = $5, updated_at = NOW()
          WHERE id = $1`,
        [attemptId, charge.ref, charge.pixCode, charge.redirectUrl, charge.expiresAt],
      );
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150 * (tries + 1)));
    }
  }
  console.error("[bau-payments] provider charge not recorded", { attemptId, ref: charge.ref });
  throw lastError;
}

async function cancelOtherPending(membershipId: string, keepId: string): Promise<void> {
  try {
    const others = await getPool().query<AttemptRow>(
      `SELECT * FROM bau_payment_attempts
        WHERE membership_id = $1 AND status = 'pending' AND id <> $2`,
      [membershipId, keepId],
    );
    for (const other of others.rows) {
      await cancelPendingAttemptRow(other);
    }
  } catch (error) {
    console.error("[bau-payments] cancelling other pending charges failed:", error);
  }
}

/**
 * Cancel an open charge at the provider, and only then here. True when it is
 * cancelled. A provider that refuses leaves the attempt pending: it still
 * expires on its own, and if the fan pays it anyway the payment is applied
 * (paid always wins), rather than reporting a cancel that did not happen.
 */
export async function cancelPendingAttemptRow(row: AttemptRow): Promise<boolean> {
  const provider = getRegisteredProvider(row.provider);
  if (provider && row.provider_ref) {
    try {
      await provider.cancelCharge(accountOf(row), row.provider_ref);
    } catch (error) {
      countBauPayments("providerErrors");
      console.error("[bau-payments] cancelCharge failed:", error);
      return false;
    }
  }
  await getPool().query(
    `UPDATE bau_payment_attempts
        SET status = 'cancelled', failure_reason = 'cancelled', updated_at = NOW()
      WHERE id = $1 AND status = 'pending'`,
    [row.id],
  );
  return true;
}

function accountOf(row: AttemptRow): ProviderAccount {
  return { ref: row.account_ref, sellerName: row.seller_name };
}

async function ownAttempt(attemptId: string, userId: string): Promise<AttemptRow> {
  const result = await getPool().query<AttemptRow>(
    `SELECT * FROM bau_payment_attempts WHERE id = $1 AND user_id = $2`,
    [attemptId, userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new HttpError(404, "Not found");
  }
  return row;
}

const lastRefresh = new Map<string, number>();

/**
 * The pay screen's poll (the WS frame is the fast path; this is the net under
 * it). Reads our row; asks the provider only every `PROVIDER_REFRESH_MS`, or
 * at once with `refresh` ("já paguei e não liberou").
 */
export async function getBauAttempt(
  attemptId: string,
  userId: string,
  options: { refresh?: boolean } = {},
): Promise<BauAttemptResponse> {
  const row = await ownAttempt(attemptId, userId);
  const canAsk = row.status === "pending" || (options.refresh && row.status !== "paid" && row.status !== "refunded");
  if (canAsk && row.provider_ref) {
    const last = lastRefresh.get(row.id) ?? 0;
    const due = options.refresh || row.expires_at.getTime() <= Date.now() || Date.now() - last >= PROVIDER_REFRESH_MS;
    if (due && Date.now() - last >= 2_000) {
      lastRefresh.set(row.id, Date.now());
      if (lastRefresh.size > 5_000) {
        lastRefresh.clear();
      }
      await syncAttemptFromProvider(row);
      return attemptWithMembership(row.id);
    }
  }
  return attemptWithMembership(row.id, row);
}

async function syncAttemptFromProvider(row: AttemptRow): Promise<void> {
  const provider = getRegisteredProvider(row.provider);
  if (!provider || !row.provider_ref) {
    return;
  }
  let charge: ProviderCharge;
  try {
    charge = await provider.getCharge(accountOf(row), row.provider_ref);
  } catch (error) {
    countBauPayments("providerErrors");
    console.error("[bau-payments] getCharge failed:", error);
    return;
  }
  if (charge.status === "pending" && row.expires_at.getTime() < Date.now() - 30_000) {
    // Our clock says the code is over; a provider that has not caught up yet
    // is told so by the row. A late payment still lands: paid beats expired.
    charge = { ...charge, status: "expired", failureReason: "expired" };
  }
  await applyCharge(row.id, charge, "poll");
}

export async function cancelBauAttempt(attemptId: string, userId: string): Promise<BauAttemptResponse> {
  const row = await ownAttempt(attemptId, userId);
  if (row.status === "pending" && !(await cancelPendingAttemptRow(row))) {
    throw new HttpError(502, "cancel_failed");
  }
  return attemptWithMembership(row.id);
}

// ------------------------------------------------------------------ state machine

type ApplySource = "webhook" | "poll" | "sweep" | "provider" | "refund";

interface Applied {
  /** Other open charges of the membership, to cancel once this one is paid. */
  siblings?: AttemptRow[];
  attempt: AttemptRow;
  membership: MembershipRow;
  reason: "paid" | "attempt-expired" | "attempt-failed" | "refunded" | null;
  previousStatus: BauMembershipStatus;
}

/**
 * THE state machine. Takes the provider's word for one charge and moves the
 * attempt and its membership, both locked. Paid beats expired, failed and
 * cancelled (money that arrived is never ignored); refunded beats paid;
 * nothing moves a paid or refunded charge back.
 */
export async function applyCharge(
  attemptId: string,
  charge: ProviderCharge,
  source: ApplySource,
): Promise<Applied | null> {
  const client = await getPool().connect();
  let applied: Applied | null = null;
  try {
    await client.query("BEGIN");
    const attemptResult = await client.query<AttemptRow>(
      `SELECT * FROM bau_payment_attempts WHERE id = $1 FOR UPDATE`,
      [attemptId],
    );
    const attempt = attemptResult.rows[0];
    if (!attempt) {
      await client.query("ROLLBACK");
      return null;
    }
    const membershipResult = await client.query<MembershipRow>(
      `SELECT * FROM bau_memberships WHERE id = $1 FOR UPDATE`,
      [attempt.membership_id],
    );
    const membership = membershipResult.rows[0]!;
    const previousStatus = membership.status;
    applied = await transition(client, attempt, membership, charge);
    if (applied) {
      applied.previousStatus = previousStatus;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  if (applied?.reason) {
    await afterTransition(applied, source);
  }
  return applied;
}

async function transition(
  client: PoolClient,
  attempt: AttemptRow,
  membership: MembershipRow,
  charge: ProviderCharge,
): Promise<Applied | null> {
  const status = charge.status;
  if (status === "paid") {
    if (attempt.status === "paid" || attempt.status === "refunded") {
      return null;
    }
    const now = new Date();
    // A renewal paid while VIP is still on extends the month that is running,
    // so paying three days early or in grace loses no day and gains none.
    const runs = bauMembershipHasAccess(membership.status, membership.period_end, now);
    const start = runs && membership.period_end ? membership.period_end : now;
    const updatedAttempt = await client.query<AttemptRow>(
      `UPDATE bau_payment_attempts
          SET status = 'paid', failure_reason = NULL, kind = $4,
              paid_at = COALESCE($2, NOW()),
              period_start = $3, period_end = $3::timestamptz + INTERVAL '1 month',
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [attempt.id, charge.paidAt, start, runs ? "renewal" : "first"],
    );
    const paidRow = updatedAttempt.rows[0]!;
    const updatedMembership = await client.query<MembershipRow>(
      `UPDATE bau_memberships
          SET status = 'active', plan_id = $2,
              period_start = $3, period_end = $4,
              first_paid_at = COALESCE(first_paid_at, $5),
              last_paid_at = NOW(),
              cancelled_at = NULL, refunded_at = NULL, expired_at = NULL,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [membership.id, paidRow.plan_id, paidRow.period_start, paidRow.period_end, paidRow.paid_at],
    );
    // Any other code still open for this membership is now pointless. It is
    // cancelled at the provider after this commits (`afterTransition`), and
    // only marked cancelled here once the provider agrees, so a sibling the
    // provider would still accept is never reported cancelled.
    const siblings = await client.query<AttemptRow>(
      `SELECT * FROM bau_payment_attempts
        WHERE membership_id = $1 AND status = 'pending' AND id <> $2`,
      [membership.id, attempt.id],
    );
    return {
      siblings: siblings.rows,
      attempt: paidRow,
      membership: updatedMembership.rows[0]!,
      reason: "paid",
      previousStatus: membership.status,
    };
  }

  if (status === "refunded") {
    if (attempt.status === "refunded") {
      return null;
    }
    if (attempt.status !== "paid") {
      return null;
    }
    const refunded = await client.query<AttemptRow>(
      `UPDATE bau_payment_attempts
          SET status = 'refunded', refunded_at = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [attempt.id],
    );
    // Giving money back ends the access it bought. A renewal refunded at the
    // provider by the creator ends it too: the simple rule, written down.
    const updatedMembership = await client.query<MembershipRow>(
      `UPDATE bau_memberships
          SET status = 'refunded', refunded_at = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [membership.id],
    );
    return {
      attempt: refunded.rows[0]!,
      membership: updatedMembership.rows[0]!,
      reason: "refunded",
      previousStatus: membership.status,
    };
  }

  if (status === "expired" || status === "failed" || status === "cancelled") {
    if (attempt.status !== "pending") {
      return null;
    }
    const next: BauAttemptStatus = status;
    const reason: BauFailureReason =
      charge.failureReason ?? (status === "failed" ? "declined" : status === "expired" ? "expired" : "cancelled");
    const updated = await client.query<AttemptRow>(
      `UPDATE bau_payment_attempts
          SET status = $2, failure_reason = $3, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [attempt.id, next, reason],
    );
    return {
      attempt: updated.rows[0]!,
      membership,
      reason: status === "failed" ? "attempt-failed" : status === "expired" ? "attempt-expired" : null,
      previousStatus: membership.status,
    };
  }
  return null;
}

async function afterTransition(applied: Applied, source: ApplySource): Promise<void> {
  const { attempt, membership, reason } = applied;
  if (reason === "paid") {
    for (const sibling of applied.siblings ?? []) {
      await cancelPendingAttemptRow(sibling);
    }
    countBauPayments("paid");
    if (attempt.kind === "renewal") {
      countBauPayments("renewalsPaid");
    }
    await grantVipForMembership(membership.id).catch((error) => {
      // The sweep's regrant pass finds a paid membership with no cargo and
      // gives it; logged, not thrown, so the webhook is still acknowledged.
      console.error("[bau-payments] grant failed:", error);
    });
    await auditBauMembership(membership, "bau_plus.activate", [
      { key: "status", old: applied.previousStatus, new: "active" },
      { key: "attemptId", old: null, new: attempt.id },
    ], membership.user_id);
  } else if (reason === "refunded") {
    countBauPayments("refunds");
    await revokeVipForMembership(membership.id).catch((error) => {
      console.error("[bau-payments] revoke failed:", error);
    });
    await auditBauMembership(membership, "bau_plus.refund", [
      { key: "status", old: applied.previousStatus, new: "refunded" },
      { key: "attemptId", old: null, new: attempt.id },
    ], membership.user_id);
  } else if (reason === "attempt-expired") {
    countBauPayments("attemptsExpired");
  } else if (reason === "attempt-failed") {
    countBauPayments("attemptsFailed");
  }
  logEvent("bauPayments.charge", {
    serverId: membership.server_id,
    status: attempt.status,
    kind: attempt.kind,
    source,
  });
  if (reason) {
    notifyBauPlusUpdate(membership.user_id, {
      serverId: membership.server_id,
      membershipId: membership.id,
      status: membership.status,
      attemptId: attempt.id,
      reason,
    });
  }
}

export async function auditBauMembership(
  membership: Pick<MembershipRow, "server_id" | "user_id">,
  action: AuditAction,
  changes: { key: string; old: unknown; new: unknown }[],
  actorId: string | null,
): Promise<void> {
  try {
    await logAudit({
      serverId: membership.server_id,
      actorId,
      action,
      targetType: "user",
      targetId: membership.user_id,
      changes,
    });
  } catch (error) {
    console.error("[bau-payments] audit write failed:", error);
  }
}

// ------------------------------------------------------------------ webhooks

/**
 * Every notification a provider sends, applied once. The event row is the
 * idempotency key; the charge is re-read from the provider, so the body of a
 * webhook is never believed, only its "look at charge X".
 */
export async function handleProviderEvents(
  provider: PaymentProvider,
  events: ProviderWebhookEvent[],
): Promise<{ processed: number; duplicates: number }> {
  let processed = 0;
  let duplicates = 0;
  for (const event of events) {
    countBauPayments("webhooksReceived");
    const inserted = await getPool().query<{ processed_at: Date | null }>(
      `INSERT INTO bau_payment_events (provider, event_id, type, provider_ref)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, event_id) DO UPDATE SET type = EXCLUDED.type
       RETURNING processed_at`,
      [provider.id, event.eventId.slice(0, 200), event.type.slice(0, 100), event.chargeRef.slice(0, 200)],
    );
    if (inserted.rows[0]?.processed_at) {
      countBauPayments("webhooksDuplicate");
      duplicates += 1;
      continue;
    }
    const attempt = await getPool().query<AttemptRow>(
      `SELECT * FROM bau_payment_attempts WHERE provider = $1 AND provider_ref = $2`,
      [provider.id, event.chargeRef],
    );
    let row = attempt.rows[0];
    if (!row && event.reference && /^[0-9a-f-]{36}$/i.test(event.reference)) {
      // The charge exists at the provider but its ref never reached our row
      // (`recordProviderCharge` gave up). Our own reference names the attempt;
      // the provider must agree before the ref is written.
      const byReference = await getPool().query<AttemptRow>(
        `SELECT * FROM bau_payment_attempts
          WHERE id = $1 AND provider = $2 AND provider_ref IS NULL`,
        [event.reference, provider.id],
      );
      const candidate = byReference.rows[0];
      if (candidate) {
        const charge = await provider.getCharge(accountOf(candidate), event.chargeRef);
        if (charge.reference === candidate.id) {
          await recordProviderCharge(candidate.id, charge);
          row = { ...candidate, provider_ref: charge.ref };
        }
      }
    }
    let error: string | null = null;
    if (!row) {
      countBauPayments("webhooksUnknownCharge");
      error = "unknown charge";
    } else {
      try {
        const charge = await provider.getCharge(accountOf(row), event.chargeRef);
        await applyCharge(row.id, charge, "webhook");
      } catch (failure) {
        countBauPayments("webhooksFailed");
        // Not marked processed: the provider retries, and so may we.
        await getPool().query(
          `UPDATE bau_payment_events SET error = $3 WHERE provider = $1 AND event_id = $2`,
          [provider.id, event.eventId, String(failure).slice(0, 300)],
        );
        throw failure;
      }
    }
    await getPool().query(
      `UPDATE bau_payment_events SET processed_at = NOW(), error = $3
        WHERE provider = $1 AND event_id = $2`,
      [provider.id, event.eventId, error],
    );
    processed += 1;
  }
  return { processed, duplicates };
}

// ------------------------------------------------------------------ fan actions

async function ownMembership(membershipId: string, userId: string): Promise<MembershipRow> {
  const result = await getPool().query<MembershipRow>(
    `SELECT * FROM bau_memberships WHERE id = $1 AND user_id = $2`,
    [membershipId, userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new HttpError(404, "Not found");
  }
  return row;
}

async function membershipOrThrow(id: string): Promise<BauMembership> {
  const membership = await getMembershipById(id);
  if (!membership) {
    throw new HttpError(404, "Not found");
  }
  return membership;
}

/**
 * Stop renewing. VIP stays until the month that was paid ends (cancelled);
 * in grace, nothing was paid for the days left, so it ends now. A membership
 * that never paid simply drops its open code.
 */
export async function cancelBauMembership(membershipId: string, userId: string): Promise<BauMembership> {
  const row = await ownMembership(membershipId, userId);
  const pending = await getPool().query<AttemptRow>(
    `SELECT * FROM bau_payment_attempts WHERE membership_id = $1 AND status = 'pending'`,
    [row.id],
  );
  for (const attempt of pending.rows) {
    // A code the provider will not cancel could still be paid, and paying it
    // would bring the membership back: say so rather than report a cancel.
    if (!(await cancelPendingAttemptRow(attempt))) {
      throw new HttpError(502, "cancel_failed");
    }
  }
  if (row.status === "active" || row.status === "grace") {
    const updated = await getPool().query<MembershipRow>(
      `UPDATE bau_memberships
          SET status = 'cancelled', cancelled_at = NOW(),
              updated_at = NOW()
        WHERE id = $1 AND status IN ('active', 'grace')
        RETURNING *`,
      [row.id],
    );
    if (updated.rows[0]) {
      countBauPayments("cancels");
      await auditBauMembership(row, "bau_plus.cancel", [{ key: "status", old: row.status, new: "cancelled" }], userId);
      // A no-op while the paid month runs (the revoke re-checks access); it
      // takes the cargo only for a cancel in grace, where nothing was paid.
      await revokeVipForMembership(row.id);
      notifyBauPlusUpdate(userId, {
        serverId: row.server_id,
        membershipId: row.id,
        status: "cancelled",
        attemptId: null,
        reason: "cancelled",
      });
    }
  }
  return membershipOrThrow(row.id);
}

/** Undo a cancel while the paid month is still running. Charges nothing. */
export async function resumeBauMembership(membershipId: string, userId: string): Promise<BauMembership> {
  const row = await ownMembership(membershipId, userId);
  const updated = await getPool().query<MembershipRow>(
    `UPDATE bau_memberships
        SET status = 'active', cancelled_at = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'cancelled' AND period_end > NOW()
      RETURNING *`,
    [row.id],
  );
  if (!updated.rows[0]) {
    throw new HttpError(409, "cannot_resume");
  }
  countBauPayments("resumes");
  await auditBauMembership(row, "bau_plus.resume", [{ key: "status", old: "cancelled", new: "active" }], userId);
  notifyBauPlusUpdate(userId, {
    serverId: row.server_id,
    membershipId: row.id,
    status: "active",
    attemptId: null,
    reason: "resumed",
  });
  return membershipOrThrow(row.id);
}

/**
 * The 7-day right of withdrawal: the FIRST payment of a membership, within
 * `BAU_REFUND_WINDOW_DAYS` of it, one tap, no creator approval. The provider
 * refunds from the creator's balance; when it cannot, the fan gets an error
 * and nothing changes here (pqp never tops a refund up).
 */
export async function refundBauMembership(membershipId: string, userId: string): Promise<BauMembership> {
  const row = await ownMembership(membershipId, userId);
  const attempts = await getPool().query<AttemptRow>(
    `SELECT * FROM bau_payment_attempts WHERE membership_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [row.id],
  );
  const until = refundableUntil(row, attempts.rows, new Date());
  const target = attempts.rows.find((a) => a.status === "paid");
  if (!until || !target || !target.provider_ref) {
    countBauPayments("refundsRefused");
    throw new HttpError(409, "refund_window_closed");
  }
  const provider = getRegisteredProvider(target.provider);
  if (!provider) {
    throw new HttpError(503, "provider_unavailable");
  }
  let result: { status: "refunded" | "pending" };
  try {
    result = await provider.refundCharge(accountOf(target), target.provider_ref);
  } catch (error) {
    countBauPayments("providerErrors");
    console.error("[bau-payments] refund failed:", error);
    throw new HttpError(502, "refund_failed");
  }
  if (result.status === "refunded") {
    const charge = await provider.getCharge(accountOf(target), target.provider_ref);
    await applyCharge(
      target.id,
      charge.status === "refunded" ? charge : { ...charge, status: "refunded" },
      "refund",
    );
  }
  return membershipOrThrow(row.id);
}

// ------------------------------------------------------------------ creator + dev

/** The server's one plan, created or replaced (MANAGE_SERVER, checked by the route). */
export async function upsertBauPlan(serverId: string, actorId: string, body: BauPlanBody): Promise<BauPlan> {
  const client = await getPool().connect();
  let plan: PlanRow;
  try {
    await client.query("BEGIN");
    const current = await client.query<PlanRow>(
      `SELECT * FROM bau_plans WHERE server_id = $1 AND active FOR UPDATE`,
      [serverId],
    );
    const existing = current.rows[0];
    if (existing && existing.price_cents === body.priceCents) {
      // Same price: edit in place, every membership keeps pointing at it.
      const updated = await client.query<PlanRow>(
        `UPDATE bau_plans SET name = $2, perks = $3::jsonb, active = $4, updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [existing.id, body.name, JSON.stringify(body.perks), body.active],
      );
      plan = updated.rows[0]!;
    } else {
      // A new price is a new plan: a receipt and a running month keep the price
      // they were sold at, and the next renewal pays the new one.
      if (existing) {
        await client.query(`UPDATE bau_plans SET active = FALSE, updated_at = NOW() WHERE id = $1`, [existing.id]);
      }
      const inserted = await client.query<PlanRow>(
        `INSERT INTO bau_plans (server_id, name, price_cents, perks, active)
         VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING *`,
        [serverId, body.name, body.priceCents, JSON.stringify(body.perks), body.active],
      );
      plan = inserted.rows[0]!;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await logAudit({
    serverId,
    actorId,
    action: "bau_plus.plan_update",
    targetType: "server",
    targetId: serverId,
    changes: [
      { key: "name", old: null, new: plan.name },
      { key: "priceCents", old: null, new: plan.price_cents },
      { key: "active", old: null, new: plan.active },
    ],
  });
  return toPlan(plan);
}

export async function getBauPlanForStaff(serverId: string): Promise<{
  plan: BauPlan | null;
  payout: { provider: string; sellerName: string; status: string } | null;
}> {
  const [plan, payout] = await Promise.all([readPlan(serverId), readPayout(serverId)]);
  return {
    plan: plan ? toPlan(plan) : null,
    payout: payout
      ? { provider: payout.provider, sellerName: payout.seller_name, status: payout.status }
      : null,
  };
}

/**
 * Dev and staging: connect the server to the sandbox in one call, so the fan
 * flow can be walked without the (later) payout connect slice.
 */
export async function connectSandboxPayout(
  serverId: string,
  actorId: string | null,
  sellerName: string,
): Promise<void> {
  if (!isSandboxAllowed()) {
    throw new HttpError(404, "Not found");
  }
  await getPool().query(
    `INSERT INTO bau_payout_accounts (server_id, provider, account_ref, seller_name, status, connected_by)
     VALUES ($1, 'sandbox', $2, $3, 'connected', $4)
     ON CONFLICT (server_id) DO UPDATE
       SET provider = 'sandbox', account_ref = EXCLUDED.account_ref,
           seller_name = EXCLUDED.seller_name, status = 'connected', updated_at = NOW()`,
    [serverId, `sbxacct_${serverId.slice(0, 8)}`, sellerName.slice(0, 80), actorId],
  );
}

/** The dev controls on the pay screen ("simular pagamento" and friends). */
export async function actOnSandboxAttempt(
  attemptId: string,
  userId: string,
  action: BauSandboxAction,
): Promise<BauAttemptResponse> {
  const row = await ownAttempt(attemptId, userId);
  if (row.provider !== "sandbox" || !isSandboxAllowed() || !row.provider_ref) {
    throw new HttpError(404, "Not found");
  }
  await sandboxProvider.act(row.provider_ref, action);
  return attemptWithMembership(row.id);
}

/** Tests only. */
export function resetBauPaymentsForTests(): void {
  lastRefresh.clear();
  sandboxProvider.reset();
}

export { syncAttemptFromProvider, DAY_MS as BAU_DAY_MS };
export type { AttemptRow as BauAttemptRow };

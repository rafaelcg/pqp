import { z } from "zod";

/**
 * BAÚ+ PAYMENTS: the fan pays a creator for the VIP cargo, inside pqp.
 *
 * The contract every client and the server agree on. The longer story (who is
 * the merchant, why there is a provider adapter, what each status means and
 * which transitions exist) is `docs/BAU_PAYMENTS.md`; this file is the shapes.
 *
 * THE CREATOR IS THE MERCHANT. pqp never holds money: every charge is made by a
 * payment provider on the creator's own payout account, through an adapter
 * (`server/src/services/bau-payments/providers/`). A built-in SANDBOX provider
 * makes fake Pix codes so the whole flow runs with no real provider and no real
 * money. Phones never draw any of this (store policy): no price, no Pix, no
 * button. The VIP cargo the payment grants is the server's ordinary VIP role
 * (`system_key = 'vip'`), so everything that already reads VIP keeps working.
 *
 * MONTHLY, ONE PIX AT A TIME. A paid charge buys one month. Three days before
 * the month ends the fan is reminded; when it ends without a new payment the
 * membership is in GRACE for three more days, still VIP; after that it EXPIRES
 * and the cargo goes. A recurring provider can replace the reminder later
 * without changing these states.
 */

/** Every price is in BRL cents: Pix is Brazil only. */
export const BAU_PAYMENT_CURRENCY = "BRL";
export const BAU_PLAN_MIN_CENTS = 500;
export const BAU_PLAN_MAX_CENTS = 20_000;
export const BAU_PLAN_NAME_MAX = 40;
export const BAU_PLAN_PERK_MAX = 80;
export const BAU_PLAN_PERKS_MAX = 4;

/** Days of access after an unpaid month ends, before the cargo goes. */
export const BAU_GRACE_DAYS = 3;
/** Days before the month ends that the renewal reminder goes out. */
export const BAU_REMINDER_DAYS = 3;
/** The right of withdrawal (CDC art. 49): days after a first payment. */
export const BAU_REFUND_WINDOW_DAYS = 7;

export const BAU_MEMBERSHIP_STATUSES = [
  /** Checkout started, nothing paid yet. No access. */
  "pending",
  /** Paid; the month is running. Access. */
  "active",
  /** The month ended unpaid; still access for `BAU_GRACE_DAYS`. */
  "grace",
  /** Grace ran out. No access. */
  "expired",
  /** The fan stopped renewing. Access until `periodEnd`, then none. */
  "cancelled",
  /** The first payment was given back. No access. */
  "refunded",
] as const;
export const bauMembershipStatusSchema = z.enum(BAU_MEMBERSHIP_STATUSES);
export type BauMembershipStatus = z.infer<typeof bauMembershipStatusSchema>;

export const BAU_ATTEMPT_STATUSES = [
  "pending",
  "paid",
  "expired",
  "failed",
  "cancelled",
  "refunded",
] as const;
export const bauAttemptStatusSchema = z.enum(BAU_ATTEMPT_STATUSES);
export type BauAttemptStatus = z.infer<typeof bauAttemptStatusSchema>;

export const BAU_PAYMENT_METHODS = ["pix", "card"] as const;
export const bauPaymentMethodSchema = z.enum(BAU_PAYMENT_METHODS);
export type BauPaymentMethod = z.infer<typeof bauPaymentMethodSchema>;

/** A first payment opens a membership; a renewal extends one. */
export type BauAttemptKind = "first" | "renewal";

/** Why an attempt did not end paid. `null` while pending or once paid. */
export const BAU_FAILURE_REASONS = [
  "declined",
  "expired",
  "cancelled",
  "provider_error",
] as const;
export type BauFailureReason = (typeof BAU_FAILURE_REASONS)[number];

export interface BauPlan {
  id: string;
  serverId: string;
  name: string;
  priceCents: number;
  currency: typeof BAU_PAYMENT_CURRENCY;
  /** What VIP gives, in the creator's words, at most four short lines. */
  perks: string[];
  active: boolean;
}

/** Who sells. Named on the pay screen and on every receipt (consumer law). */
export interface BauSeller {
  /** The creator's name as the payout account knows it. */
  name: string;
  /** The provider that processes the charge, for the receipt line. */
  providerLabel: string;
}

export interface BauPaymentAttempt {
  id: string;
  membershipId: string;
  serverId: string;
  method: BauPaymentMethod;
  kind: BauAttemptKind;
  status: BauAttemptStatus;
  amountCents: number;
  currency: typeof BAU_PAYMENT_CURRENCY;
  /** The Pix "copia e cola" (the QR encodes exactly this). Null for card. */
  pixCode: string | null;
  /** A provider-hosted card page, when the provider has one. */
  redirectUrl: string | null;
  expiresAt: string;
  paidAt: string | null;
  failureReason: BauFailureReason | null;
  createdAt: string;
  /** True only on the built-in sandbox: the dev controls may be drawn. */
  sandbox: boolean;
}

export interface BauReceipt {
  attemptId: string;
  status: "paid" | "refunded";
  method: BauPaymentMethod;
  amountCents: number;
  currency: typeof BAU_PAYMENT_CURRENCY;
  paidAt: string;
  refundedAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  sellerName: string;
  providerLabel: string;
  /** The provider's id for the charge, for a support conversation. */
  reference: string;
}

export interface BauMembership {
  id: string;
  serverId: string;
  serverName: string;
  serverIconUrl: string | null;
  plan: { id: string; name: string; priceCents: number; currency: typeof BAU_PAYMENT_CURRENCY };
  status: BauMembershipStatus;
  /** Whether the VIP cargo comes from this membership right now. */
  hasAccess: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  /** `periodEnd` plus the grace days; when access ends if nothing is paid. */
  graceEndsAt: string | null;
  /** Inside the reminder window (or in grace): time to pay the next month. */
  renewalDue: boolean;
  /** The last moment the 7-day refund may be asked for, or null. */
  refundableUntil: string | null;
  firstPaidAt: string | null;
  cancelledAt: string | null;
  refundedAt: string | null;
  seller: BauSeller;
  /** A charge still waiting to be paid, so a closed screen can be reopened. */
  pendingAttempt: BauPaymentAttempt | null;
  /** Paid (and refunded) charges, newest first. */
  receipts: BauReceipt[];
}

/** `GET /api/servers/:serverId/bau-plus`: what a fan may buy here. */
export interface BauOffer {
  /** The flags, the plan, the payout account and a provider all line up. */
  enabled: boolean;
  plan: BauPlan | null;
  seller: BauSeller | null;
  methods: BauPaymentMethod[];
  /** The sandbox provider is the one in use (dev and staging only). */
  sandbox: boolean;
  membership: BauMembership | null;
  graceDays: number;
  reminderDays: number;
  refundWindowDays: number;
}

export const bauCheckoutBodySchema = z.object({
  planId: z.string().uuid(),
  method: bauPaymentMethodSchema.default("pix"),
});
export type BauCheckoutBody = z.infer<typeof bauCheckoutBodySchema>;

export interface BauAttemptResponse {
  attempt: BauPaymentAttempt;
  membership: BauMembership;
}

export interface BauMembershipsResponse {
  memberships: BauMembership[];
}

const perkSchema = z.string().trim().min(1).max(BAU_PLAN_PERK_MAX);

/** `PUT /api/servers/:serverId/bau-plus/plan` (MANAGE_SERVER). */
export const bauPlanBodySchema = z.object({
  name: z.string().trim().min(1).max(BAU_PLAN_NAME_MAX),
  priceCents: z.number().int().min(BAU_PLAN_MIN_CENTS).max(BAU_PLAN_MAX_CENTS),
  perks: z.array(perkSchema).max(BAU_PLAN_PERKS_MAX).default([]),
  active: z.boolean().default(true),
});
export type BauPlanBody = z.infer<typeof bauPlanBodySchema>;

/** What the sandbox may be told to do with a pending charge (dev only). */
export const BAU_SANDBOX_ACTIONS = ["pay", "fail", "expire"] as const;
export const bauSandboxActionSchema = z.enum(BAU_SANDBOX_ACTIONS);
export type BauSandboxAction = z.infer<typeof bauSandboxActionSchema>;

/**
 * `bau-plus-update`: something about one of the caller's own memberships
 * changed. Per person (the account's own sockets on every instance), never a
 * channel fan-out, so it is out of `CHAT_SERVER_MESSAGE_TYPES` like
 * `friend-activity`. Content-light on purpose: the client re-reads the offer or
 * the attempt it is looking at. `reason` lets an open pay screen flip to paid
 * the instant the provider confirms, with no poll.
 */
export const BAU_UPDATE_REASONS = [
  "paid",
  "attempt-expired",
  "attempt-failed",
  "refunded",
  "cancelled",
  "resumed",
  "reminder",
  "grace",
  "expired",
] as const;
export const bauPlusUpdateSchema = z.object({
  type: z.literal("bau-plus-update"),
  serverId: z.string().uuid(),
  membershipId: z.string().uuid(),
  status: bauMembershipStatusSchema,
  attemptId: z.string().uuid().nullable(),
  reason: z.enum(BAU_UPDATE_REASONS),
});
export type BauPlusUpdateMessage = z.infer<typeof bauPlusUpdateSchema>;

/**
 * Does this membership hold the VIP cargo right now? The one rule, shared so
 * the server's sweep and the client's banner cannot disagree.
 */
export function bauMembershipHasAccess(
  status: BauMembershipStatus,
  periodEnd: Date | string | null,
  now: Date = new Date(),
): boolean {
  if (status === "active" || status === "grace") {
    return true;
  }
  if (status === "cancelled" && periodEnd) {
    return new Date(periodEnd).getTime() > now.getTime();
  }
  return false;
}

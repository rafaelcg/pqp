import type { IncomingHttpHeaders } from "node:http";
import type {
  BauFailureReason,
  BauPaymentMethod,
} from "@pqp/shared";
import { isDevAuthBypassEnabled } from "../../auth/clerk.js";

/**
 * THE PROVIDER ADAPTER. Everything pqp needs from a payment engine, and
 * nothing else, so Mercado Pago, LivePix, Asaas or Stripe can be plugged in
 * later without touching the membership logic.
 *
 * The rules every adapter keeps:
 *
 *   - THE CREATOR IS THE MERCHANT. A charge is made on the creator's own
 *     account (`ProviderAccount.ref`); money never enters an account of pqp's.
 *   - THE PROVIDER IS THE TRUTH. A webhook only says "look at charge X";
 *     `getCharge` is what the state machine believes. Events arrive twice and
 *     out of order, and the re-fetch is what makes that harmless.
 *   - NO SECRET IN A ROW OR A LOG. An adapter that needs a creator's key reads
 *     it from wherever the connect slice stores it, encrypted; `account.ref` is
 *     an id.
 *   - `verifyWebhook` returns null for a bad signature. The route answers 401
 *     and counts it; nothing is applied.
 */

export interface ProviderAccount {
  /** The creator's account id at the provider. */
  ref: string;
  sellerName: string;
}

export type ProviderChargeStatus =
  | "pending"
  | "paid"
  | "expired"
  | "failed"
  | "cancelled"
  | "refunded";

export interface CreateChargeInput {
  account: ProviderAccount;
  /** Our attempt id. Sent to the provider as its external reference. */
  reference: string;
  amountCents: number;
  currency: "BRL";
  method: BauPaymentMethod;
  /** "VIP · <server>", what the fan's bank statement shows when supported. */
  description: string;
  expiresAt: Date;
}

export interface ProviderCharge {
  ref: string;
  /** Our attempt id, as the provider echoes it back (its external reference). */
  reference: string | null;
  status: ProviderChargeStatus;
  /** Pix copia e cola. The client draws the QR from this exact text. */
  pixCode: string | null;
  /** A hosted card page, for a provider that has one. */
  redirectUrl: string | null;
  expiresAt: Date;
  paidAt: Date | null;
  failureReason: BauFailureReason | null;
}

export interface ProviderWebhookEvent {
  /** The provider's id for this notification: the idempotency key. */
  eventId: string;
  type: string;
  /** The charge the event is about; `getCharge` is asked what it says. */
  chargeRef: string;
  /** Our attempt id when the provider sends it back; a fallback match only. */
  reference?: string | null;
}

export interface PaymentProvider {
  /** Stored on every row (`bau_payment_attempts.provider`). */
  readonly id: string;
  /** Shown on receipts: "Processado por <label>". */
  readonly label: string;
  readonly sandbox: boolean;
  /** What the pay screen may offer, first is the default. Pix first. */
  readonly methods: readonly BauPaymentMethod[];
  createCharge(input: CreateChargeInput): Promise<ProviderCharge>;
  getCharge(account: ProviderAccount, ref: string): Promise<ProviderCharge>;
  cancelCharge(account: ProviderAccount, ref: string): Promise<void>;
  /** `pending` when the provider confirms later, by webhook. */
  refundCharge(
    account: ProviderAccount,
    ref: string,
  ): Promise<{ status: "refunded" | "pending" }>;
  verifyWebhook(
    headers: IncomingHttpHeaders,
    rawBody: Buffer,
  ): ProviderWebhookEvent[] | null;
}

/**
 * May the sandbox run here? Never on production: a sandbox charge is a button
 * that grants VIP for free. Allowed in development, under the dev auth bypass,
 * and on a Fly app named `-staging` (the same platform-injected name the load
 * test token trusts, see `auth/load-test.ts`).
 */
export function isSandboxAllowed(): boolean {
  const flyApp = process.env.FLY_APP_NAME;
  if (flyApp) {
    return flyApp.endsWith("-staging");
  }
  return process.env.NODE_ENV !== "production";
}

const registry = new Map<string, PaymentProvider>();

/** For a real adapter, and for tests. */
export function registerPaymentProvider(provider: PaymentProvider): void {
  registry.set(provider.id, provider);
}

export function getRegisteredProvider(id: string): PaymentProvider | null {
  return registry.get(id) ?? null;
}

/**
 * The provider new charges go to, or null (payments are cleanly off).
 *
 * `BAU_PAYMENTS_PROVIDER` names it. Unset means the sandbox under the dev auth
 * bypass and nothing anywhere else, so a self-host that never set it makes no
 * charge and draws no button. `none` turns it off even in dev. A name with no
 * registered adapter, or `sandbox` where the sandbox is not allowed, is off.
 */
export function activePaymentProvider(): PaymentProvider | null {
  const raw = (process.env.BAU_PAYMENTS_PROVIDER ?? "").trim().toLowerCase();
  const id = raw || (isDevAuthBypassEnabled() ? "sandbox" : "");
  if (!id || id === "none") {
    return null;
  }
  if (id === "sandbox" && !isSandboxAllowed()) {
    warnOnce("sandbox-refused", "[bau-payments] sandbox provider refused on this deployment");
    return null;
  }
  const provider = registry.get(id) ?? null;
  if (!provider) {
    warnOnce(`missing-${id}`, `[bau-payments] no adapter named ${id}; payments off`);
  }
  return provider;
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(message);
  }
}

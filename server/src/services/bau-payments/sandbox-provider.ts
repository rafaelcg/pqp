import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { pixCrc16, type BauPaymentMethod, type BauSandboxAction } from "@pqp/shared";
import type {
  CreateChargeInput,
  PaymentProvider,
  ProviderAccount,
  ProviderCharge,
  ProviderChargeStatus,
  ProviderWebhookEvent,
} from "./provider.js";

/**
 * THE SANDBOX: a pretend payment engine, so the whole Baú+ flow runs end to
 * end with no provider account and no money. Only where `isSandboxAllowed`
 * says so (never production).
 *
 * It behaves like a real one where it matters:
 *
 *   - a charge has a Pix copia e cola (a well formed BR Code with a valid CRC,
 *     made out to a key that does not exist, `NAO PAGUE` in the name), and an
 *     expiry;
 *   - it pays itself `BAU_PAYMENTS_SANDBOX_AUTOPAY_SECONDS` after creation
 *     (default 8, `0` never), or when the dev controls say `pay`, `fail` or
 *     `expire`, and a refund is immediate;
 *   - each of those SENDS A WEBHOOK through the same handler the HTTP route
 *     uses, with an event id, so idempotency and the re-fetch are exercised
 *     the way a real provider would exercise them.
 *
 * STATE: the charge's creation and expiry times are encoded in its ref, so
 * `getCharge` can answer for a charge created by another process or before a
 * restart. Only what a dev control changed lives in memory; losing it on a
 * restart is harmless, because the state machine never moves a paid or
 * refunded attempt back to pending.
 */

const SANDBOX_KEY = "sandbox@pqp.invalid";

function autopayMs(): number {
  const raw = process.env.BAU_PAYMENTS_SANDBOX_AUTOPAY_SECONDS;
  const seconds = raw === undefined || raw === "" ? 8 : Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function cardOffered(): boolean {
  return process.env.BAU_PAYMENTS_SANDBOX_CARD !== "false";
}

export function sandboxWebhookSecret(): string {
  return process.env.BAU_PAYMENTS_SANDBOX_SECRET || "pqp-sandbox-dev-secret";
}

export const SANDBOX_SIGNATURE_HEADER = "x-sandbox-signature";

export function signSandboxBody(body: string): string {
  return `sha256=${createHmac("sha256", sandboxWebhookSecret()).update(body).digest("hex")}`;
}

/** EMV tag-length-value, the BR Code's only syntax. */
function tlv(tag: string, value: string): string {
  return `${tag}${String(value.length).padStart(2, "0")}${value}`;
}

export function sandboxPixCode(amountCents: number, txid: string): string {
  const account = tlv("00", "BR.GOV.BCB.PIX") + tlv("01", SANDBOX_KEY) + tlv("02", "PQP SANDBOX NAO PAGUE");
  const body =
    tlv("00", "01") +
    tlv("26", account) +
    tlv("52", "0000") +
    tlv("53", "986") +
    tlv("54", (amountCents / 100).toFixed(2)) +
    tlv("58", "BR") +
    tlv("59", "PQP SANDBOX NAO PAGUE") +
    tlv("60", "PORTO ALEGRE") +
    tlv("62", tlv("05", txid.slice(0, 25)));
  const withCrcTag = `${body}6304`;
  return withCrcTag + pixCrc16(withCrcTag);
}

interface DecodedRef {
  method: BauPaymentMethod;
  createdAt: number;
  expiresAt: number;
  amountCents: number;
}

/** `sbx_<p|c>_<created36>_<expires36>_<amount36>_<random>`. */
function encodeRef(input: DecodedRef): string {
  return [
    "sbx",
    input.method === "card" ? "c" : "p",
    input.createdAt.toString(36),
    input.expiresAt.toString(36),
    input.amountCents.toString(36),
    randomBytes(6).toString("hex"),
  ].join("_");
}

function decodeRef(ref: string): DecodedRef | null {
  const parts = ref.split("_");
  if (parts.length !== 6 || parts[0] !== "sbx") {
    return null;
  }
  const createdAt = parseInt(parts[2]!, 36);
  const expiresAt = parseInt(parts[3]!, 36);
  const amountCents = parseInt(parts[4]!, 36);
  if (![createdAt, expiresAt, amountCents].every(Number.isFinite)) {
    return null;
  }
  return { method: parts[1] === "c" ? "card" : "pix", createdAt, expiresAt, amountCents };
}

interface Override {
  status: ProviderChargeStatus;
  at: number;
  failureReason: ProviderCharge["failureReason"];
}

type EventSink = (events: ProviderWebhookEvent[]) => Promise<void>;

export interface SandboxProvider extends PaymentProvider {
  /** The dev controls: what the fan's "simular" buttons do. */
  act(ref: string, action: BauSandboxAction): Promise<void>;
  /** Where its webhooks go: the same handler the HTTP route feeds. */
  setEventSink(sink: EventSink | null): void;
  /** Tests: forget overrides and pending timers. */
  reset(): void;
}

export function createSandboxProvider(): SandboxProvider {
  const overrides = new Map<string, Override>();
  /** Our attempt id per charge, so events and reads carry it back. */
  const references = new Map<string, string>();
  const timers = new Set<NodeJS.Timeout>();
  let sink: EventSink | null = null;
  let eventSeq = 0;

  /**
   * One webhook. Rejects when the handler failed, so a dev control that
   * simulated a payment reports the failure instead of pretending it landed
   * (the timer path, with no caller to tell, logs it and the poll's re-fetch
   * still applies the payment, since `getCharge` answers from the override).
   */
  function emit(ref: string, type: string): Promise<void> {
    eventSeq += 1;
    const event: ProviderWebhookEvent = {
      eventId: `sbxevt_${Date.now().toString(36)}_${eventSeq}_${randomBytes(3).toString("hex")}`,
      type,
      chargeRef: ref,
      reference: references.get(ref) ?? null,
    };
    return sink ? sink([event]) : Promise.resolve();
  }

  function emitQuietly(ref: string, type: string): void {
    void emit(ref, type).catch((error: unknown) => {
      console.error("[bau-payments] sandbox webhook failed:", error);
    });
  }

  function charge(ref: string, now = Date.now()): ProviderCharge {
    const decoded = decodeRef(ref);
    if (!decoded) {
      throw new Error("Unknown sandbox charge");
    }
    const base: ProviderCharge = {
      ref,
      reference: references.get(ref) ?? null,
      status: "pending",
      pixCode: decoded.method === "pix" ? sandboxPixCode(decoded.amountCents, ref.slice(-12)) : null,
      redirectUrl: null,
      expiresAt: new Date(decoded.expiresAt),
      paidAt: null,
      failureReason: null,
    };
    const override = overrides.get(ref);
    if (override) {
      return {
        ...base,
        status: override.status,
        paidAt: override.status === "paid" || override.status === "refunded" ? new Date(override.at) : null,
        failureReason: override.failureReason,
      };
    }
    const autopay = autopayMs();
    if (
      decoded.method === "pix" &&
      autopay > 0 &&
      now >= decoded.createdAt + autopay &&
      decoded.createdAt + autopay < decoded.expiresAt
    ) {
      return { ...base, status: "paid", paidAt: new Date(decoded.createdAt + autopay) };
    }
    if (now >= decoded.expiresAt) {
      return { ...base, status: "expired", failureReason: "expired" };
    }
    return base;
  }

  return {
    id: "sandbox",
    label: "Sandbox",
    sandbox: true,
    get methods(): readonly BauPaymentMethod[] {
      return cardOffered() ? ["pix", "card"] : ["pix"];
    },
    async createCharge(input: CreateChargeInput): Promise<ProviderCharge> {
      const createdAt = Date.now();
      const ref = encodeRef({
        method: input.method,
        createdAt,
        expiresAt: input.expiresAt.getTime(),
        amountCents: input.amountCents,
      });
      references.set(ref, input.reference);
      const autopay = autopayMs();
      if (input.method === "pix" && autopay > 0) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          emitQuietly(ref, "charge.paid");
        }, autopay);
        timer.unref?.();
        timers.add(timer);
      }
      return charge(ref, createdAt);
    },
    async getCharge(_account: ProviderAccount, ref: string): Promise<ProviderCharge> {
      return charge(ref);
    },
    async cancelCharge(_account: ProviderAccount, ref: string): Promise<void> {
      const current = charge(ref);
      if (current.status === "pending") {
        overrides.set(ref, { status: "cancelled", at: Date.now(), failureReason: "cancelled" });
      }
    },
    async refundCharge(_account: ProviderAccount, ref: string) {
      const current = charge(ref);
      if (current.status !== "paid" && current.status !== "refunded") {
        throw new Error("Only a paid sandbox charge can be refunded");
      }
      overrides.set(ref, {
        status: "refunded",
        at: current.paidAt?.getTime() ?? Date.now(),
        failureReason: null,
      });
      // Like a real provider: the refund webhook arrives after the answer,
      // and is a no-op by then (the service already applied it).
      emitQuietly(ref, "charge.refunded");
      return { status: "refunded" as const };
    },
    verifyWebhook(headers: IncomingHttpHeaders, rawBody: Buffer): ProviderWebhookEvent[] | null {
      const header = headers[SANDBOX_SIGNATURE_HEADER];
      const given = Array.isArray(header) ? header[0] : header;
      if (!given) {
        return null;
      }
      const expected = signSandboxBody(rawBody.toString("utf8"));
      const a = Buffer.from(given);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return null;
      }
      try {
        const parsed = JSON.parse(rawBody.toString("utf8")) as {
          events?: { id?: unknown; type?: unknown; charge?: unknown; reference?: unknown }[];
        };
        return (parsed.events ?? [])
          .filter(
            (e) => typeof e.id === "string" && typeof e.type === "string" && typeof e.charge === "string",
          )
          .map((e) => ({
            eventId: e.id as string,
            type: e.type as string,
            chargeRef: e.charge as string,
            reference: typeof e.reference === "string" ? e.reference : null,
          }));
      } catch {
        return null;
      }
    },
    async act(ref: string, action: BauSandboxAction): Promise<void> {
      const current = charge(ref);
      if (current.status !== "pending" && !(action === "pay" && current.status === "expired")) {
        // A real provider would refuse too. "Pay" on an expired code is the
        // "paid at the last second, confirmed late" case and is allowed.
        if (current.status === "paid" && action === "pay") {
          await emit(ref, "charge.paid");
        }
        return;
      }
      const now = Date.now();
      if (action === "pay") {
        overrides.set(ref, { status: "paid", at: now, failureReason: null });
        await emit(ref, "charge.paid");
      } else if (action === "fail") {
        overrides.set(ref, { status: "failed", at: now, failureReason: "declined" });
        await emit(ref, "charge.failed");
      } else {
        overrides.set(ref, { status: "expired", at: now, failureReason: "expired" });
        await emit(ref, "charge.expired");
      }
    },
    setEventSink(next: EventSink | null): void {
      sink = next;
    },
    reset(): void {
      overrides.clear();
      references.clear();
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
    },
  };
}

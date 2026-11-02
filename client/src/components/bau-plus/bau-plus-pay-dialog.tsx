import type {
  BauMembership,
  BauOffer,
  BauPaymentAttempt,
  BauPaymentMethod,
  BauSandboxAction,
} from "@pqp/shared";
import {
  Check,
  ChevronLeft,
  Clock3,
  Copy,
  CreditCard,
  ExternalLink,
  FlaskConical,
  RotateCcw,
  ShieldCheck,
  TimerOff,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ServerIcon } from "@/components/layout/server-identity";
import { useCopyText } from "@/components/settings/kit/copy-button";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { RadioGroup } from "@/components/ui/radio-group";
import { ApiError } from "@/lib/api";
import {
  actOnSandboxAttempt,
  fetchBauAttempt,
  startBauCheckout,
} from "@/lib/bau-plus/api";
import {
  formatBauDay,
  formatBrl,
  formatCountdown,
} from "@/lib/bau-plus/format";
import { onBauPlusUpdate } from "@/lib/bau-plus/updates";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { PixQr } from "./pix-qr";

/**
 * THE PAY SHEET. One calm column, Stripe Checkout's shape and a bank app's Pix
 * screen: who sells and what it costs first, the QR and one copy button next,
 * and the moment it lands, a confirmation that hands the fan back to the post
 * they wanted to read.
 *
 * Three steps, one dialog (the title band follows the step):
 *
 *   summary   seller, price, what VIP gives, Pix or card, one button
 *   pay       QR + copy (Pix) or the card page, a countdown, "esperando";
 *             expired, declined and "já paguei" live here too
 *   paid      the check, until when, and "Ler o post"
 *
 * The confirmation is pushed (`bau-plus-update`), and polled every 4 s as the
 * net under it, so a bank that confirms in two seconds flips the screen in two
 * seconds. Nothing here decides anything: every state is what the API says.
 *
 * Web and desktop only. Phones never open this (store policy).
 */

type Step =
  | { kind: "summary" }
  | { kind: "pay"; attempt: BauPaymentAttempt }
  | { kind: "paid"; membership: BauMembership; attempt: BauPaymentAttempt };

const POLL_MS = 4_000;

function checkoutError(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    if (error.status === 409 && error.message === "plan_changed")
      return "bauPlus.error.planChanged";
    if (error.status === 409 && error.message === "already_member")
      return "bauPlus.error.alreadyMember";
    if (error.status === 429) return "bauPlus.error.tooMany";
    if (error.status === 502 || error.status === 503)
      return "bauPlus.error.provider";
    if (error.status === 0) return "bauPlus.error.network";
  }
  return "bauPlus.error.generic";
}

export function BauPlusPayDialog({
  open,
  offer,
  serverName,
  serverIconUrl,
  onClose,
  onPaid,
  onOfferStale,
  primaryAfterPaid,
  onOpenMembership,
}: {
  open: boolean;
  offer: BauOffer;
  serverName: string;
  serverIconUrl: string | null;
  onClose: () => void;
  /** The money landed: refresh the feed so the post opens. */
  onPaid: (membership: BauMembership) => void;
  /** The price changed under the fan: re-read the offer. */
  onOfferStale: () => void;
  /** "Ler o post" when opened from a post, "Ver os posts VIP" otherwise. */
  primaryAfterPaid: "post" | "feed";
  onOpenMembership?: () => void;
}) {
  const { t, locale } = useTranslation();
  const plan = offer.plan;
  const methods = offer.methods;
  const [method, setMethod] = useState<BauPaymentMethod>(methods[0] ?? "pix");
  const [step, setStep] = useState<Step>(() =>
    offer.membership?.pendingAttempt
      ? { kind: "pay", attempt: offer.membership.pendingAttempt }
      : { kind: "summary" },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  // A fresh sheet each time it opens: resume a code still open, else start over.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      paidRef.current = false;
      shownRef.current = offer.membership?.pendingAttempt ?? null;
      setError(null);
      setBusy(false);
      setMethod(methods[0] ?? "pix");
      setStep(
        offer.membership?.pendingAttempt
          ? { kind: "pay", attempt: offer.membership.pendingAttempt }
          : { kind: "summary" },
      );
    }
    wasOpen.current = open;
  }, [open, offer.membership?.pendingAttempt, methods]);

  // Once paid, the sheet stays paid: a poll that left before the frame and
  // answers after it ("still pending") must not take the confirmation away.
  const paidRef = useRef(false);
  const shownRef = useRef<BauPaymentAttempt | null>(null);
  const settle = useCallback(
    (attempt: BauPaymentAttempt, membership: BauMembership) => {
      if (attempt.status === "paid") {
        if (!paidRef.current) {
          paidRef.current = true;
          setStep({ kind: "paid", membership, attempt });
          onPaid(membership);
        }
      } else if (!paidRef.current) {
        // Statuses only move forward: a poll that left while the code was
        // open must not bring back a code the provider already declined or
        // let expire.
        const shown = shownRef.current;
        if (
          shown &&
          shown.id === attempt.id &&
          shown.status !== "pending" &&
          attempt.status === "pending"
        ) {
          return;
        }
        shownRef.current = attempt;
        setStep({ kind: "pay", attempt });
      }
    },
    [onPaid],
  );

  const attemptId = step.kind === "pay" ? step.attempt.id : null;
  const attemptPending =
    step.kind === "pay" && step.attempt.status === "pending";

  // The fast path: the server says this charge moved.
  useEffect(() => {
    if (!open || !attemptId) return undefined;
    return onBauPlusUpdate((message) => {
      if (message.attemptId !== attemptId) return;
      void fetchBauAttempt(attemptId)
        .then((answer) => settle(answer.attempt, answer.membership))
        .catch(() => {});
    });
  }, [open, attemptId, settle]);

  // The net under it.
  useEffect(() => {
    if (!open || !attemptId || !attemptPending) return undefined;
    const timer = window.setInterval(() => {
      void fetchBauAttempt(attemptId)
        .then((answer) => settle(answer.attempt, answer.membership))
        .catch(() => {});
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, attemptId, attemptPending, settle]);

  if (!plan || !offer.seller) {
    return null;
  }
  const price = formatBrl(plan.priceCents, locale);
  const seller = offer.seller.name;

  async function start(chosen: BauPaymentMethod) {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await startBauCheckout(plan.serverId, plan.id, chosen);
      settle(answer.attempt, answer.membership);
    } catch (failure) {
      const key = checkoutError(failure);
      if (key === "bauPlus.error.planChanged") {
        onOfferStale();
      }
      setError(key);
    } finally {
      setBusy(false);
    }
  }

  const title =
    step.kind === "summary"
      ? t("bauPlus.pay.title", { server: serverName })
      : step.kind === "paid"
        ? t("bauPlus.paid.title")
        : step.attempt.method === "card"
          ? t("bauPlus.card.title")
          : t("bauPlus.pix.title");

  return (
    <Dialog
      open={open}
      size="sm"
      title={title}
      headerKey={step.kind}
      onClose={onClose}
      closeOnBackdrop={step.kind !== "pay"}
    >
      <div className="px-5 pb-5 pt-5" data-bau-pay data-bau-step={step.kind}>
        {step.kind === "summary" && (
          <SummaryStep
            serverName={serverName}
            serverIconUrl={serverIconUrl}
            seller={seller}
            price={price}
            perks={plan.perks}
            methods={methods}
            method={method}
            onMethod={setMethod}
            busy={busy}
            error={error}
            refundDays={offer.refundWindowDays}
            onStart={() => void start(method)}
          />
        )}
        {step.kind === "pay" && (
          <PayStep
            attempt={step.attempt}
            seller={seller}
            providerLabel={offer.seller.providerLabel}
            price={formatBrl(step.attempt.amountCents, locale)}
            busy={busy}
            error={error}
            onRestart={(next) => void start(next)}
            onBack={() => {
              setError(null);
              setStep({ kind: "summary" });
            }}
            canSwitchToPix={methods.includes("pix")}
            onSettle={settle}
          />
        )}
        {step.kind === "paid" && (
          <PaidStep
            membership={step.membership}
            attempt={step.attempt}
            serverName={serverName}
            seller={seller}
            reminderDays={offer.reminderDays}
            primary={primaryAfterPaid}
            onDone={onClose}
            onOpenMembership={onOpenMembership}
          />
        )}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ summary

function SummaryStep({
  serverName,
  serverIconUrl,
  seller,
  price,
  perks,
  methods,
  method,
  onMethod,
  busy,
  error,
  refundDays,
  onStart,
}: {
  serverName: string;
  serverIconUrl: string | null;
  seller: string;
  price: string;
  perks: string[];
  methods: BauPaymentMethod[];
  method: BauPaymentMethod;
  onMethod: (method: BauPaymentMethod) => void;
  busy: boolean;
  error: MessageKey | null;
  refundDays: number;
  onStart: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="bau-step-in flex flex-col">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-card)] bg-surface-3 text-sm font-semibold text-text-secondary">
          <ServerIcon name={serverName} iconUrl={serverIconUrl} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text">
            {serverName}
          </p>
          <p className="truncate text-sm text-text-tertiary" data-bau-seller>
            {t("bauPlus.pay.soldBy", { seller })}
          </p>
        </div>
      </div>

      <div className="mt-6 flex items-baseline gap-2">
        <span
          className="font-display text-[2.75rem] font-bold leading-none tracking-tight text-text tabular-nums"
          data-bau-price
        >
          {price}
        </span>
        <span className="text-sm text-text-secondary">
          {t("bauPlus.pay.perMonth")}
        </span>
      </div>

      {perks.length > 0 && (
        <ul
          className="mt-5 flex flex-col gap-2.5"
          aria-label={t("bauPlus.pay.perksLabel")}
        >
          {perks.map((perk) => (
            <li
              key={perk}
              className="flex items-start gap-2.5 text-sm leading-5 text-text"
            >
              <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent-soft text-on-accent-soft">
                <Check aria-hidden className="h-2.5 w-2.5" strokeWidth={3} />
              </span>
              <span className="text-pretty">{perk}</span>
            </li>
          ))}
        </ul>
      )}

      {methods.length > 1 && (
        <RadioGroup
          className="mt-6"
          label={t("bauPlus.pay.methodLabel")}
          value={method}
          onValueChange={onMethod}
          options={methods.map((value) => ({
            value,
            label: t(
              value === "pix" ? "bauPlus.method.pix" : "bauPlus.method.card",
            ),
          }))}
        />
      )}

      <Button
        className={cn(
          "h-11 w-full text-[15px]",
          methods.length > 1 ? "mt-3" : "mt-6",
        )}
        onClick={onStart}
        disabled={busy}
        data-bau-start
      >
        {busy
          ? t("bauPlus.pay.starting")
          : t(
              method === "card"
                ? "bauPlus.pay.startCard"
                : "bauPlus.pay.startPix",
              { price },
            )}
      </Button>
      {error && <ErrorLine message={t(error)} />}

      <div className="mt-5 space-y-1.5 text-[13px] leading-5 text-text-tertiary">
        <p className="text-pretty">{t("bauPlus.pay.renewal")}</p>
        <p className="text-pretty">
          {t("bauPlus.pay.refund", { days: refundDays })}
        </p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ pay

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function PayStep({
  attempt,
  seller,
  providerLabel,
  price,
  busy,
  error,
  onRestart,
  onBack,
  canSwitchToPix,
  onSettle,
}: {
  attempt: BauPaymentAttempt;
  seller: string;
  providerLabel: string;
  price: string;
  busy: boolean;
  error: MessageKey | null;
  onRestart: (method: BauPaymentMethod) => void;
  onBack: () => void;
  canSwitchToPix: boolean;
  onSettle: (attempt: BauPaymentAttempt, membership: BauMembership) => void;
}) {
  const { t } = useTranslation();
  const pending = attempt.status === "pending";
  const now = useNow(pending);
  const left = new Date(attempt.expiresAt).getTime() - now;
  const timedOut = pending && left <= 0;
  const expired =
    attempt.status === "expired" || attempt.status === "cancelled" || timedOut;
  const declined = attempt.status === "failed";
  const [checking, setChecking] = useState(false);
  const [checkedLate, setCheckedLate] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);

  async function checkAgain() {
    setChecking(true);
    setCheckFailed(false);
    try {
      const answer = await fetchBauAttempt(attempt.id, true);
      onSettle(answer.attempt, answer.membership);
      setCheckedLate(answer.attempt.status !== "paid");
    } catch {
      // Could not ask: not the same as "the bank has not confirmed".
      setCheckedLate(false);
      setCheckFailed(true);
    } finally {
      setChecking(false);
    }
  }

  // Announced once per state, never per tick of the countdown.
  const status = (
    <p className="sr-only" role="status" aria-live="polite">
      {expired
        ? t("bauPlus.pix.expiredTitle")
        : declined
          ? t("bauPlus.card.declinedTitle")
          : t("bauPlus.pix.waiting")}
    </p>
  );

  const back = (
    <button
      type="button"
      className="-ml-2 mb-1 inline-flex h-9 items-center gap-1 self-start rounded-[var(--radius-control)] px-2 text-sm text-text-tertiary transition-colors duration-[var(--duration-fast)] hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      onClick={onBack}
      data-bau-back
    >
      <ChevronLeft aria-hidden className="h-4 w-4" />
      {t("bauPlus.pix.back")}
    </button>
  );

  if (declined || expired) {
    const isCard = attempt.method === "card";
    return (
      <div className="flex flex-col">
        {status}
        {back}
        <StateNotice
          tone={declined ? "danger" : "neutral"}
          icon={declined ? CreditCard : TimerOff}
          title={
            declined
              ? t("bauPlus.card.declinedTitle")
              : isCard
                ? t("bauPlus.card.expiredTitle")
                : t("bauPlus.pix.expiredTitle")
          }
          body={
            declined
              ? t("bauPlus.card.declinedBody")
              : isCard
                ? t("bauPlus.card.expiredBody")
                : t("bauPlus.pix.expiredBody", { price, seller })
          }
          data={declined ? "declined" : "expired"}
        />
        <div className="bau-step-in mt-6 flex flex-col gap-2 [--stagger:1]">
          {declined ? (
            <>
              {canSwitchToPix && (
                <Button
                  className="h-11 w-full text-[15px]"
                  disabled={busy}
                  onClick={() => onRestart("pix")}
                >
                  {t("bauPlus.card.usePix")}
                </Button>
              )}
              <Button
                variant="secondary"
                className="h-11 w-full"
                disabled={busy}
                onClick={() => onRestart("card")}
              >
                {t("bauPlus.card.retry")}
              </Button>
            </>
          ) : (
            <>
              <Button
                className="h-11 w-full text-[15px]"
                disabled={busy}
                onClick={() => onRestart(attempt.method)}
              >
                <RotateCcw aria-hidden className="mr-2 h-4 w-4" />
                {t(isCard ? "bauPlus.card.again" : "bauPlus.pix.again")}
              </Button>
              <Button
                variant="ghost"
                className="h-11 w-full text-text-secondary"
                disabled={checking}
                onClick={() => void checkAgain()}
                data-bau-check-late
              >
                {checking
                  ? t("bauPlus.pix.checking")
                  : t("bauPlus.pix.paidAlready")}
              </Button>
              {checkedLate && (
                <p
                  className="bau-step-in text-pretty px-2 text-center text-[13px] leading-5 text-text-secondary"
                  data-bau-late-note
                >
                  {t("bauPlus.pix.lateNote")}
                </p>
              )}
              {checkFailed && (
                <ErrorLine message={t("bauPlus.pix.checkFailed")} />
              )}
            </>
          )}
        </div>
        {error && <ErrorLine message={t(error)} />}
        <Fineprint seller={seller} providerLabel={providerLabel} />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {status}
      {back}
      <div className="bau-step-in">
        <AmountLine price={price} seller={seller} centered />
      </div>

      {attempt.method === "pix" ? (
        <PixBody attempt={attempt} price={price} />
      ) : (
        <CardBody attempt={attempt} providerLabel={providerLabel} />
      )}

      <WaitingLine left={left} />
      {error && <ErrorLine message={t(error)} />}

      {attempt.sandbox && (
        <SandboxControls
          attemptId={attempt.id}
          method={attempt.method}
          onSettle={onSettle}
        />
      )}
      <Fineprint seller={seller} providerLabel={providerLabel} />
    </div>
  );
}

function StateNotice({
  tone,
  icon: Icon,
  title,
  body,
  data,
}: {
  tone: "danger" | "neutral";
  icon: typeof CreditCard;
  title: string;
  body: string;
  data: string;
}) {
  return (
    <div
      className="bau-step-in flex flex-col items-center px-2 pt-3 text-center"
      data-bau-state={data}
      {...{ [`data-bau-${data}`]: "" }}
    >
      <span
        className={cn(
          "grid h-14 w-14 place-items-center rounded-full",
          tone === "danger"
            ? "bg-danger-soft text-on-danger-soft"
            : "bg-surface-3 text-text-secondary ring-1 ring-border",
        )}
      >
        <Icon aria-hidden className="h-6 w-6" />
      </span>
      <p className="mt-4 font-display text-xl font-bold text-text text-balance">
        {title}
      </p>
      <p className="mt-1.5 max-w-[20rem] text-pretty text-sm leading-6 text-text-secondary">
        {body}
      </p>
    </div>
  );
}

function AmountLine({
  price,
  seller,
  centered = false,
}: {
  price: string;
  seller: string;
  centered?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn("min-w-0", centered && "text-center")}>
      <p className="font-display text-[1.75rem] font-bold leading-tight text-text tabular-nums">
        {price}
      </p>
      <p className="mt-0.5 truncate text-sm text-text-tertiary">
        {t("bauPlus.pix.to", { seller })}
      </p>
    </div>
  );
}

function PixBody({
  attempt,
  price,
}: {
  attempt: BauPaymentAttempt;
  price: string;
}) {
  const { t } = useTranslation();
  const code = attempt.pixCode ?? "";
  const codeRef = useRef<HTMLElement>(null);
  const { copied, failed, copy } = useCopyText(code, {
    selectOnFail: () => codeRef.current,
  });
  const stepsList: MessageKey[] = [
    "bauPlus.pix.step1",
    "bauPlus.pix.step2",
    "bauPlus.pix.step3",
  ];

  return (
    <>
      {/* A phone cannot scan its own screen: there the copy button leads and
          the QR is smaller; on a computer the QR is the main thing. */}
      <div className="bau-step-in mx-auto mt-4 w-full max-w-[11rem] [--stagger:1] sm:mt-5 sm:max-w-[13.5rem]">
        {code ? (
          <PixQr
            code={code}
            label={t("bauPlus.pix.qrLabel", { price })}
            className="aspect-square w-full"
          />
        ) : (
          <div className="aspect-square w-full rounded-[var(--radius-card)] bg-surface-2" />
        )}
      </div>

      {code && (
        <div className="bau-step-in mt-4 [--stagger:2]">
          <Button
            className="h-11 w-full text-[15px]"
            onClick={copy}
            data-bau-copy
          >
            <span
              className="relative mr-2 inline-grid h-4 w-4 place-items-center"
              aria-hidden
            >
              <Copy
                className={cn(
                  "col-start-1 row-start-1 h-4 w-4 transition-[opacity,transform,filter] duration-[var(--duration-base)] ease-[var(--ease-standard)]",
                  copied
                    ? "scale-[0.25] opacity-0 blur-[4px]"
                    : "scale-100 opacity-100 blur-0",
                )}
              />
              <Check
                className={cn(
                  "col-start-1 row-start-1 h-4 w-4 transition-[opacity,transform,filter] duration-[var(--duration-base)] ease-[var(--ease-standard)]",
                  copied
                    ? "scale-100 opacity-100 blur-0"
                    : "scale-[0.25] opacity-0 blur-[4px]",
                )}
              />
            </span>
            {copied ? t("bauPlus.pix.copied") : t("bauPlus.pix.copy")}
          </Button>
          <span className="sr-only" role="status">
            {copied
              ? t("bauPlus.pix.copied")
              : failed
                ? t("bauPlus.pix.copyFailed")
                : ""}
          </span>
          <code
            ref={codeRef}
            className="mt-2 block select-all truncate px-1 text-center font-mono text-[11px] text-text-tertiary"
            data-bau-pix-code
          >
            {code}
          </code>
          <ol className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
            {stepsList.map((key, index) => (
              <li
                key={key}
                className="flex items-start gap-3 text-[13px] leading-5 text-text-secondary"
              >
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-surface-2 text-[11px] font-semibold text-text-secondary tabular-nums">
                  {index + 1}
                </span>
                <span className="text-pretty">{t(key)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}

function CardBody({
  attempt,
  providerLabel,
}: {
  attempt: BauPaymentAttempt;
  providerLabel: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="bau-step-in mt-5 rounded-[var(--radius-card)] border border-border bg-surface-1 p-4 [--stagger:1]">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-2 text-text-secondary">
          <CreditCard aria-hidden className="h-4 w-4" />
        </span>
        <p className="text-pretty text-sm leading-5 text-text-secondary">
          {t("bauPlus.card.body", { provider: providerLabel })}
        </p>
      </div>
      {attempt.redirectUrl && (
        <Button asChild className="mt-4 h-11 w-full">
          <a
            href={attempt.redirectUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("bauPlus.card.open")}
            <ExternalLink aria-hidden className="ml-2 h-4 w-4 opacity-80" />
            <span className="sr-only">
              {t("communityHome.vip.opensNewTab")}
            </span>
          </a>
        </Button>
      )}
    </div>
  );
}

/** "● Esperando o pagamento" and, beside it, how long the code is good for. */
function WaitingLine({ left }: { left: number }) {
  const { t } = useTranslation();
  return (
    <div
      className="bau-step-in mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[13px] text-text-secondary [--stagger:3]"
      data-bau-waiting
    >
      <span className="inline-flex items-center gap-2">
        <span
          aria-hidden
          className="bau-wait-dot h-2 w-2 rounded-full bg-accent"
        />
        {t("bauPlus.pix.waiting")}
      </span>
      <span
        className="inline-flex items-center gap-1.5 tabular-nums text-text-tertiary"
        data-bau-countdown
      >
        <Clock3 aria-hidden className="h-3.5 w-3.5" />
        {t("bauPlus.pix.expiresIn", { time: formatCountdown(left) })}
      </span>
    </div>
  );
}

function SandboxControls({
  attemptId,
  method,
  onSettle,
}: {
  attemptId: string;
  method: BauPaymentMethod;
  onSettle: (attempt: BauPaymentAttempt, membership: BauMembership) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<BauSandboxAction | null>(null);
  async function act(action: BauSandboxAction) {
    setBusy(action);
    try {
      const answer = await actOnSandboxAttempt(attemptId, action);
      onSettle(answer.attempt, answer.membership);
    } finally {
      setBusy(null);
    }
  }
  const actions: { action: BauSandboxAction; label: MessageKey }[] = [
    { action: "pay", label: "bauPlus.sandbox.pay" },
    {
      action: "fail",
      label:
        method === "card" ? "bauPlus.sandbox.decline" : "bauPlus.sandbox.fail",
    },
    { action: "expire", label: "bauPlus.sandbox.expire" },
  ];
  return (
    <div
      className="mt-4 rounded-[var(--radius-card)] border border-dashed border-border-strong px-3 py-2.5"
      data-bau-sandbox
    >
      <p className="flex items-center gap-1.5 text-xs font-medium text-text-tertiary">
        <FlaskConical aria-hidden className="h-3.5 w-3.5" />
        {t("bauPlus.sandbox.note")}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {actions.map(({ action, label }) => (
          <Button
            key={action}
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void act(action)}
            data-bau-sandbox-action={action}
          >
            {t(label)}
          </Button>
        ))}
      </div>
    </div>
  );
}

function Fineprint({
  seller,
  providerLabel,
}: {
  seller: string;
  providerLabel: string;
}) {
  const { t } = useTranslation();
  return (
    <p className="mt-5 flex items-start justify-center gap-1.5 text-pretty text-center text-xs leading-5 text-text-tertiary">
      <ShieldCheck aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        {t("bauPlus.pay.fineprint", { seller, provider: providerLabel })}
      </span>
    </p>
  );
}

function ErrorLine({ message }: { message: ReactNode }) {
  return (
    <p
      className="mt-3 rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-sm text-on-danger-soft"
      role="alert"
    >
      {message}
    </p>
  );
}

// ------------------------------------------------------------------ paid

function PaidStep({
  membership,
  attempt,
  serverName,
  seller,
  reminderDays,
  primary,
  onDone,
  onOpenMembership,
}: {
  membership: BauMembership;
  attempt: BauPaymentAttempt;
  serverName: string;
  seller: string;
  reminderDays: number;
  primary: "post" | "feed";
  onDone: () => void;
  onOpenMembership?: () => void;
}) {
  const { t, locale } = useTranslation();
  const until = membership.periodEnd
    ? formatBauDay(membership.periodEnd, locale)
    : null;
  return (
    <div className="flex flex-col items-center pt-2 text-center" data-bau-paid>
      <p className="sr-only" role="status" aria-live="polite">
        {t("bauPlus.paid.announce")}
      </p>
      <div className="relative grid h-16 w-16 place-items-center">
        <span
          aria-hidden
          className="bau-paid-ring absolute inset-0 rounded-full bg-success-soft"
        />
        <span className="bau-paid-mark relative grid h-16 w-16 place-items-center rounded-full bg-success-soft text-on-success-soft">
          <svg
            viewBox="0 0 24 24"
            aria-hidden
            className="h-8 w-8"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path className="bau-paid-check" d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </span>
      </div>
      <p className="bau-step-in mt-5 font-display text-2xl font-bold text-text text-balance [--stagger:2]">
        {t("bauPlus.paid.headline", { server: serverName })}
      </p>
      <p className="bau-step-in mt-2 max-w-[19rem] text-pretty text-sm leading-6 text-text-secondary [--stagger:3]">
        {until
          ? t("bauPlus.paid.until", { server: serverName, date: until })
          : t("bauPlus.paid.unlocked", { server: serverName })}{" "}
        {t("bauPlus.paid.reminder", { count: reminderDays })}
      </p>
      <div className="bau-step-in mt-6 flex w-full flex-col gap-2 [--stagger:4]">
        <Button
          className="h-11 w-full text-[15px]"
          onClick={onDone}
          data-bau-paid-continue
          autoFocus
        >
          {t(
            primary === "post"
              ? "bauPlus.paid.readPost"
              : "bauPlus.paid.seePosts",
          )}
        </Button>
        {onOpenMembership && (
          <Button
            variant="ghost"
            className="h-11 w-full text-text-secondary"
            onClick={onOpenMembership}
          >
            {t("bauPlus.paid.manage")}
          </Button>
        )}
      </div>
      <p className="mt-4 text-xs text-text-tertiary tabular-nums">
        {t("bauPlus.paid.receipt", {
          price: formatBrl(attempt.amountCents, locale),
          seller,
          method: t(
            attempt.method === "card"
              ? "bauPlus.method.card"
              : "bauPlus.method.pix",
          ),
        })}
      </p>
    </div>
  );
}

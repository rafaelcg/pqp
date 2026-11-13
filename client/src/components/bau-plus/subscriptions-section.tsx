import type {
  BauMembership,
  BauMembershipStatus,
  BauReceipt,
} from "@pqp/shared";
import { Receipt, RotateCcw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SettingsEmpty, SettingsGroup } from "@/components/settings/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  cancelBauMembership,
  fetchMyBauMemberships,
  refundBauMembership,
  resumeBauMembership,
} from "@/lib/bau-plus/api";
import {
  bauPeriodLeft,
  formatBauDay,
  formatBrl,
} from "@/lib/bau-plus/format";
import { onBauPlusUpdate, requestBauPay } from "@/lib/bau-plus/updates";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { BauMonthMeter, VipSeal } from "./vip-seal";

/**
 * Configurações, Assinaturas: every creator this person pays, one box each,
 * with what it is, where it stands, the one next step, and the receipts.
 *
 * The states a fan can be in, and the button each one gets:
 *   active      "Cancelar renovação" (and "Pedir reembolso" inside 7 days)
 *   due / grace "Renovar por R$ X" first
 *   cancelled   "Reativar" while the month runs
 *   expired     "Voltar pro VIP"
 *   pending     "Continuar o pagamento"
 *   refunded    receipts only
 *
 * Cancelling and refunding ask first and say exactly what happens; nothing
 * else does. Web and desktop only, like every Baú+ screen.
 */

const STATUS_BADGE: Record<
  BauMembershipStatus,
  {
    label: MessageKey;
    variant: "success" | "warning" | "neutral" | "danger" | "accent";
  }
> = {
  active: { label: "bauPlus.status.active", variant: "success" },
  grace: { label: "bauPlus.status.grace", variant: "warning" },
  pending: { label: "bauPlus.status.pending", variant: "neutral" },
  cancelled: { label: "bauPlus.status.cancelled", variant: "neutral" },
  expired: { label: "bauPlus.status.expired", variant: "neutral" },
  refunded: { label: "bauPlus.status.refunded", variant: "neutral" },
};

export function useMyBauMemberships() {
  const [memberships, setMemberships] = useState<BauMembership[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Only the newest read may write: an older answer arriving late must not
  // put back a state the person already moved past.
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const answer = await fetchMyBauMemberships();
      if (mine === seq.current) {
        setMemberships(answer.memberships);
        setFailed(false);
      }
    } catch {
      if (mine === seq.current) {
        setFailed(true);
      }
    }
  }, []);
  useEffect(() => {
    void reload();
    return onBauPlusUpdate(() => void reload());
  }, [reload]);
  return { memberships, failed, reload, setMemberships };
}

/**
 * Whether Configurações should list Assinaturas at all: asked when the dialog
 * opens, remembered once true for the rest of the session (a refund must not
 * make the section vanish under the person reading it). An API without Baú+
 * answers 404, which is "no".
 */
let sawMemberships = false;
export function useHasBauMemberships(open: boolean): boolean {
  const [has, setHas] = useState(sawMemberships);
  useEffect(() => {
    if (!open || sawMemberships) return;
    let live = true;
    void fetchMyBauMemberships()
      .then((answer) => {
        if (live && answer.memberships.length > 0) {
          sawMemberships = true;
          setHas(true);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open]);
  return has;
}

export function SubscriptionsSection({
  onNavigateAway,
}: {
  onNavigateAway?: () => void;
}) {
  const { t } = useTranslation();
  const { memberships, failed, reload, setMemberships } = useMyBauMemberships();

  function replace(next: BauMembership) {
    setMemberships((list) =>
      (list ?? []).map((item) => (item.id === next.id ? next : item)),
    );
  }

  return (
    <div className="flex flex-col gap-6" data-testid="bau-subscriptions">
      {memberships === null && !failed && (
        <div
          className="flex flex-col gap-3"
          aria-busy="true"
          aria-label={t("bauPlus.manager.loading")}
        >
          <Skeleton className="h-40 w-full rounded-[var(--radius-card)]" />
          <Skeleton className="h-24 w-full rounded-[var(--radius-card)]" />
        </div>
      )}
      {failed && memberships === null && (
        <SettingsGroup>
          <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
            <p className="text-sm text-text-secondary">
              {t("bauPlus.manager.loadFailed")}
            </p>
            <Button size="sm" variant="secondary" onClick={() => void reload()}>
              <RotateCcw aria-hidden className="mr-1.5 h-3.5 w-3.5" />
              {t("bauPlus.manager.retry")}
            </Button>
          </div>
        </SettingsGroup>
      )}
      {failed && memberships !== null && (
        <p
          className="flex flex-wrap items-center gap-2 text-sm text-text-secondary"
          role="status"
        >
          {t("bauPlus.manager.stale")}
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            onClick={() => void reload()}
          >
            {t("bauPlus.manager.retry")}
          </Button>
        </p>
      )}
      {memberships && memberships.length === 0 && (
        <SettingsGroup>
          <SettingsEmpty
            icon={Sparkles}
            title={t("bauPlus.manager.emptyTitle")}
            description={t("bauPlus.manager.emptyBody")}
          />
        </SettingsGroup>
      )}
      {memberships?.map((membership) => (
        <MembershipCard
          key={membership.id}
          membership={membership}
          onChanged={replace}
          onPay={() => {
            requestBauPay(membership.serverId);
            onNavigateAway?.();
          }}
        />
      ))}
    </div>
  );
}

function MembershipCard({
  membership,
  onChanged,
  onPay,
}: {
  membership: BauMembership;
  onChanged: (membership: BauMembership) => void;
  onPay: () => void;
}) {
  const { t, locale } = useTranslation();
  const [confirm, setConfirm] = useState<"cancel" | "refund" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [receipt, setReceipt] = useState<BauReceipt | null>(null);
  const price = formatBrl(membership.plan.priceCents, locale);
  const end = membership.periodEnd
    ? formatBauDay(membership.periodEnd, locale)
    : null;
  const graceEnd = membership.graceEndsAt
    ? formatBauDay(membership.graceEndsAt, locale)
    : null;
  const refundUntil = membership.refundableUntil
    ? formatBauDay(membership.refundableUntil, locale)
    : null;
  const badge = STATUS_BADGE[membership.status];

  async function run(action: "cancel" | "refund" | "resume") {
    setBusy(true);
    setError(null);
    try {
      const fn =
        action === "cancel"
          ? cancelBauMembership
          : action === "refund"
            ? refundBauMembership
            : resumeBauMembership;
      const answer = await fn(membership.id);
      onChanged(answer.membership);
    } catch {
      setError(
        action === "refund"
          ? "bauPlus.manager.refundFailed"
          : "bauPlus.manager.actionFailed",
      );
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  // The sentence under the name: where this stands, in one line.
  const situation: string = membership.pendingAttempt
    ? t("bauPlus.manager.situation.pending")
    : membership.status === "active" && end
      ? membership.renewalDue
        ? t("bauPlus.manager.situation.due", { date: end })
        : t("bauPlus.manager.situation.active", { date: end })
      : membership.status === "grace" && graceEnd
        ? t("bauPlus.manager.situation.grace", { date: graceEnd })
        : membership.status === "cancelled" && end
          ? membership.hasAccess
            ? t("bauPlus.manager.situation.cancelled", { date: end })
            : t("bauPlus.manager.situation.ended", { date: end })
          : membership.status === "refunded"
            ? t("bauPlus.manager.situation.refunded")
            : end
              ? t("bauPlus.manager.situation.ended", { date: end })
              : "";

  // While VIP is on: since when, until when, and a bar for the month.
  const since =
    membership.hasAccess && membership.firstPaidAt
      ? formatBauDay(membership.firstPaidAt, locale)
      : null;
  const period = bauPeriodLeft(membership.periodStart, membership.periodEnd);
  const daysLeft = (count: number) =>
    t("bauPlus.manager.daysLeft", { count: Math.max(1, count) });
  let month: {
    label: string;
    left: string | null;
    remaining: number;
    tone: "vip" | "warning" | "muted";
    note: string | null;
  } | null = null;
  if (!membership.pendingAttempt && membership.hasAccess && end) {
    if (membership.status === "active" && period) {
      month = {
        label: t(
          membership.renewalDue
            ? "bauPlus.manager.month.dueLabel"
            : "bauPlus.manager.month.activeLabel",
          { date: end },
        ),
        left: daysLeft(period.daysLeft),
        remaining: period.remaining,
        tone: "vip",
        note: t(
          membership.renewalDue
            ? "bauPlus.manager.month.dueNote"
            : "bauPlus.manager.month.activeNote",
        ),
      };
    } else if (membership.status === "cancelled" && period) {
      month = {
        label: t("bauPlus.manager.month.cancelledLabel", { date: end }),
        left: daysLeft(period.daysLeft),
        remaining: period.remaining,
        tone: "muted",
        note: t("bauPlus.manager.month.cancelledNote"),
      };
    } else if (membership.status === "grace" && graceEnd) {
      const grace = bauPeriodLeft(membership.periodEnd, membership.graceEndsAt);
      month = {
        label: t("bauPlus.manager.month.graceLabel", { date: end }),
        left: t("bauPlus.manager.month.graceLeft", { date: graceEnd }),
        remaining: grace?.remaining ?? 0,
        tone: "warning",
        note: t("bauPlus.manager.month.graceNote"),
      };
    }
  }

  const needsPay =
    Boolean(membership.pendingAttempt) ||
    membership.status === "grace" ||
    (membership.status === "active" && membership.renewalDue) ||
    membership.status === "expired" ||
    (membership.status === "cancelled" && !membership.hasAccess) ||
    membership.status === "refunded";

  const payLabel = membership.pendingAttempt
    ? t("bauPlus.strip.continue")
    : membership.status === "grace" || membership.status === "active"
      ? t("bauPlus.strip.renew", { price })
      : t("bauPlus.strip.comeBack");

  return (
    <section
      className="elevation-1 overflow-hidden rounded-[var(--radius-card)] bg-surface-card"
      aria-labelledby={`bau-m-${membership.id}`}
      data-bau-membership={membership.status}
    >
      <div className="flex items-start gap-3.5 p-4">
        <VipSeal
          name={membership.serverName}
          iconUrl={membership.serverIconUrl}
          tone={membership.hasAccess ? "vip" : "muted"}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4
              id={`bau-m-${membership.id}`}
              className="truncate text-[15px] font-semibold text-text"
            >
              {membership.serverName}
            </h4>
            <Badge variant={badge.variant}>{t(badge.label)}</Badge>
          </div>
          <p className="mt-0.5 text-sm text-text-tertiary tabular-nums">
            {t("bauPlus.manager.plan", { plan: membership.plan.name, price })}
          </p>
          {since && (
            <p
              className="mt-0.5 text-sm text-text-tertiary"
              data-bau-member-since
            >
              {t("bauPlus.manager.since", { date: since })}
            </p>
          )}
        </div>
      </div>

      {month ? (
        <div
          className="border-t border-border px-4 py-3.5"
          data-bau-situation
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
            <span className="min-w-0 text-pretty font-medium text-text">
              {month.label}
            </span>
            {month.left && (
              <span className="shrink-0 text-text-tertiary tabular-nums">
                {month.left}
              </span>
            )}
          </div>
          <BauMonthMeter
            remaining={month.remaining}
            tone={month.tone}
            className="mt-2.5"
          />
          {month.note && (
            <p className="mt-2 text-pretty text-[13px] leading-5 text-text-tertiary">
              {month.note}
            </p>
          )}
        </div>
      ) : situation ? (
        <p
          className="border-t border-border px-4 py-3.5 text-pretty text-sm leading-5 text-text-secondary"
          data-bau-situation
        >
          {situation}
        </p>
      ) : null}

      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 border-t border-border px-4 py-3.5 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs text-text-tertiary">
            {t("bauPlus.manager.sellerLabel")}
          </dt>
          <dd className="mt-0.5 truncate text-text">
            {membership.seller.name}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-text-tertiary">
            {t("bauPlus.manager.billingLabel")}
          </dt>
          <dd className="mt-0.5 text-text">{t("bauPlus.manager.billing")}</dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        {needsPay && (
          <Button
            size="sm"
            className="h-9 px-4"
            onClick={onPay}
            disabled={busy}
            data-bau-manager-pay
          >
            {payLabel}
          </Button>
        )}
        {membership.status === "cancelled" && membership.hasAccess && (
          <Button
            size="sm"
            className="h-9 px-4"
            onClick={() => void run("resume")}
            disabled={busy}
          >
            {t("bauPlus.strip.resume")}
          </Button>
        )}
        {(membership.status === "active" || membership.status === "grace") && (
          <Button
            size="sm"
            variant="secondary"
            className="h-9"
            onClick={() => setConfirm("cancel")}
            disabled={busy}
            data-bau-cancel
          >
            {t("bauPlus.manager.cancel")}
          </Button>
        )}
        {refundUntil && (
          <Button
            size="sm"
            variant="ghost"
            className="h-9"
            onClick={() => setConfirm("refund")}
            disabled={busy}
            data-bau-refund
          >
            {t("bauPlus.manager.refund", { date: refundUntil })}
          </Button>
        )}
      </div>
      {error && (
        <p
          className="mx-4 mb-3 rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-sm text-on-danger-soft"
          role="alert"
        >
          {t(error)}
        </p>
      )}

      {membership.receipts.length > 0 && (
        <div className="border-t border-border">
          <p className="px-4 pb-1 pt-3 text-xs font-medium text-text-tertiary">
            {t("bauPlus.manager.receipts")}
          </p>
          <ul>
            {membership.receipts.map((item) => (
              <li key={item.attemptId}>
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                  onClick={() => setReceipt(item)}
                  data-bau-receipt
                >
                  <Receipt
                    aria-hidden
                    className="h-4 w-4 shrink-0 text-text-tertiary"
                  />
                  <span className="min-w-0 flex-1 truncate text-text">
                    {formatBauDay(item.paidAt, locale)}
                  </span>
                  {item.status === "refunded" && (
                    <Badge variant="neutral">
                      {t("bauPlus.status.refunded")}
                    </Badge>
                  )}
                  <span className="shrink-0 text-text-secondary tabular-nums">
                    {formatBrl(item.amountCents, locale)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog
        open={confirm === "cancel"}
        title={t("bauPlus.manager.cancelTitle")}
        description={
          membership.status === "grace"
            ? t("bauPlus.manager.cancelBodyGrace")
            : t("bauPlus.manager.cancelBody", { date: end ?? "" })
        }
        confirmLabel={t("bauPlus.manager.cancelConfirm")}
        cancelLabel={t("bauPlus.manager.keep")}
        onConfirm={() => void run("cancel")}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "refund"}
        title={t("bauPlus.manager.refundTitle")}
        description={t("bauPlus.manager.refundBody", {
          price,
          server: membership.serverName,
        })}
        confirmLabel={t("bauPlus.manager.refundConfirm")}
        cancelLabel={t("bauPlus.manager.keep")}
        onConfirm={() => void run("refund")}
        onClose={() => setConfirm(null)}
      />
      <ReceiptDialog
        receipt={receipt}
        serverName={membership.serverName}
        planName={membership.plan.name}
        onClose={() => setReceipt(null)}
      />
    </section>
  );
}

function ReceiptDialog({
  receipt,
  serverName,
  planName,
  onClose,
}: {
  receipt: BauReceipt | null;
  serverName: string;
  planName: string;
  onClose: () => void;
}) {
  const { t, locale } = useTranslation();
  if (!receipt) return null;
  const rows: [MessageKey, string][] = [
    ["bauPlus.receipt.seller", receipt.sellerName],
    [
      "bauPlus.receipt.item",
      t("bauPlus.receipt.itemValue", { plan: planName, server: serverName }),
    ],
    [
      "bauPlus.receipt.period",
      receipt.periodStart && receipt.periodEnd
        ? t("bauPlus.receipt.periodValue", {
            from: formatBauDay(receipt.periodStart, locale),
            to: formatBauDay(receipt.periodEnd, locale),
          })
        : "",
    ],
    [
      "bauPlus.receipt.method",
      t(
        receipt.method === "card"
          ? "bauPlus.method.card"
          : "bauPlus.method.pix",
      ),
    ],
    ["bauPlus.receipt.provider", receipt.providerLabel],
    ["bauPlus.receipt.reference", receipt.reference],
  ];
  return (
    <Dialog open title={t("bauPlus.receipt.title")} size="sm" onClose={onClose}>
      <DialogBody className="pb-5">
        <p className="font-display text-[2rem] font-bold leading-none text-text tabular-nums">
          {formatBrl(receipt.amountCents, locale)}
        </p>
        <p className="mt-1.5 text-sm text-text-tertiary">
          {receipt.status === "refunded" && receipt.refundedAt
            ? t("bauPlus.receipt.refundedOn", {
                date: formatBauDay(receipt.refundedAt, locale),
              })
            : t("bauPlus.receipt.paidOn", {
                date: formatBauDay(receipt.paidAt, locale),
              })}
        </p>
        <dl className="mt-5 divide-y divide-border rounded-[var(--radius-card)] border border-border">
          {rows
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div
                key={label}
                className="flex items-start justify-between gap-4 px-3.5 py-2.5 text-sm"
              >
                <dt className="shrink-0 text-text-tertiary">{t(label)}</dt>
                <dd
                  className={cn(
                    "min-w-0 break-all text-right text-text",
                    label === "bauPlus.receipt.reference" &&
                      "font-mono text-xs leading-5",
                  )}
                >
                  {value}
                </dd>
              </div>
            ))}
        </dl>
        <p className="mt-4 text-pretty text-xs leading-5 text-text-tertiary">
          {t("bauPlus.receipt.note", { seller: receipt.sellerName })}
        </p>
      </DialogBody>
    </Dialog>
  );
}

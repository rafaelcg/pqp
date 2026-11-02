import type { BauMembership, BauOffer } from "@pqp/shared";
import { CalendarClock, Clock3, PartyPopper, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { resumeBauMembership } from "@/lib/bau-plus/api";
import { formatBauDay, formatBrl } from "@/lib/bau-plus/format";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The fan's own membership, at the top of the creator's Baú, only when there is
 * something to do or to know: a Pix still open, the renewal reminder (three days
 * before the month ends), grace, a VIP that just ran out, a cancelled one still
 * running, and the welcome right after paying. A running month with nothing due
 * draws nothing; the feed itself is the proof.
 *
 * One action each, always the next step ("Renovar", "Continuar", "Reativar"),
 * plus "Gerenciar", which opens Configurações, Assinaturas.
 */

const RECENT_EXPIRY_MS = 30 * 86_400_000;

type Variant =
  "welcome" | "pending" | "due" | "grace" | "expired" | "cancelled";

function variantOf(
  membership: BauMembership,
  welcome: boolean,
  now = Date.now(),
): Variant | null {
  if (welcome && membership.hasAccess) return "welcome";
  if (membership.pendingAttempt) return "pending";
  if (membership.status === "grace") return "grace";
  if (membership.status === "active" && membership.renewalDue) return "due";
  if (membership.status === "cancelled" && membership.hasAccess)
    return "cancelled";
  if (
    membership.status === "expired" &&
    membership.periodEnd &&
    now - new Date(membership.periodEnd).getTime() < RECENT_EXPIRY_MS
  ) {
    return "expired";
  }
  return null;
}

const TONE: Record<Variant, string> = {
  welcome: "bg-success-soft text-on-success-soft border-transparent",
  pending: "bg-surface-1 text-text border-border",
  due: "bg-surface-1 text-text border-border",
  grace: "bg-warning-soft text-on-warning-soft border-transparent",
  expired: "bg-surface-1 text-text border-border",
  cancelled: "bg-surface-1 text-text border-border",
};

export function BauPlusMembershipStrip({
  offer,
  serverName,
  welcome,
  onDismissWelcome,
  onPay,
  onManage,
  onChanged,
}: {
  offer: BauOffer;
  serverName: string;
  welcome: boolean;
  onDismissWelcome: () => void;
  /** Opens the pay sheet (renew, continue, come back). */
  onPay: () => void;
  onManage: () => void;
  onChanged: () => void;
}) {
  const { t, locale } = useTranslation();
  const [busy, setBusy] = useState(false);
  const membership = offer.membership;
  if (!membership) return null;
  const variant = variantOf(membership, welcome);
  if (!variant) return null;
  // Renewing needs the shop open; a closed one still shows the facts.
  const canPay = offer.enabled && Boolean(offer.plan);
  const price = formatBrl(
    offer.plan?.priceCents ?? membership.plan.priceCents,
    locale,
  );
  const end = membership.periodEnd
    ? formatBauDay(membership.periodEnd, locale)
    : "";
  const graceEnd = membership.graceEndsAt
    ? formatBauDay(membership.graceEndsAt, locale)
    : "";

  const copy: Record<Variant, { title: MessageKey; body: MessageKey }> = {
    welcome: {
      title: "bauPlus.strip.welcomeTitle",
      body: "bauPlus.strip.welcomeBody",
    },
    pending: {
      title: "bauPlus.strip.pendingTitle",
      body: "bauPlus.strip.pendingBody",
    },
    due: { title: "bauPlus.strip.dueTitle", body: "bauPlus.strip.dueBody" },
    grace: {
      title: "bauPlus.strip.graceTitle",
      body: "bauPlus.strip.graceBody",
    },
    expired: {
      title: "bauPlus.strip.expiredTitle",
      body: "bauPlus.strip.expiredBody",
    },
    cancelled: {
      title: "bauPlus.strip.cancelledTitle",
      body: "bauPlus.strip.cancelledBody",
    },
  };
  const vars = { server: serverName, date: end, graceEnd, price };
  const Icon =
    variant === "welcome"
      ? PartyPopper
      : variant === "grace" || variant === "pending"
        ? Clock3
        : CalendarClock;

  async function resume() {
    if (!membership) return;
    setBusy(true);
    try {
      await resumeBauMembership(membership.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const primary =
    variant === "welcome" ? null : variant === "cancelled" ? (
      <Button
        size="sm"
        className="h-9 px-4"
        disabled={busy}
        onClick={() => void resume()}
      >
        {t("bauPlus.strip.resume")}
      </Button>
    ) : canPay ? (
      <Button size="sm" className="h-9 px-4" onClick={onPay} data-bau-strip-pay>
        {variant === "pending"
          ? t("bauPlus.strip.continue")
          : variant === "expired"
            ? t("bauPlus.strip.comeBack")
            : t("bauPlus.strip.renew", { price })}
      </Button>
    ) : null;

  return (
    <div
      role="status"
      className={cn(
        "bau-step-in flex flex-col gap-3 rounded-[var(--radius-card)] border px-4 py-3.5 sm:flex-row sm:items-center",
        TONE[variant],
      )}
      data-bau-strip={variant}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Icon
          aria-hidden
          className="mt-0.5 h-[18px] w-[18px] shrink-0 opacity-80"
        />
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-5">
            {t(copy[variant].title, vars)}
          </p>
          <p className="mt-0.5 text-pretty text-sm leading-5 opacity-85">
            {t(copy[variant].body, vars)}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 pl-[30px] sm:pl-0">
        {primary}
        {variant === "welcome" ? (
          <button
            type="button"
            className="grid h-9 w-9 place-items-center rounded-[var(--radius-control)] transition-colors hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            aria-label={t("bauPlus.strip.dismiss")}
            onClick={onDismissWelcome}
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        ) : (
          <Button size="sm" variant="ghost" className="h-9" onClick={onManage}>
            {t("bauPlus.strip.manage")}
          </Button>
        )}
      </div>
    </div>
  );
}

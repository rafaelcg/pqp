import type { BauMembership, BauOffer } from "@pqp/shared";
import { ChevronRight, Clock3, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { resumeBauMembership } from "@/lib/bau-plus/api";
import {
  bauPeriodLeft,
  formatBauDay,
  formatBrl,
} from "@/lib/bau-plus/format";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { BauMonthMeter, VipSeal } from "./vip-seal";

/**
 * The fan's own membership, at the top of the creator's Baú.
 *
 * Being a member is shown, quietly: a slim row with the creator's VIP seal,
 * since when and until when, and a hairline at the bottom for how much of the
 * month is left. It only grows into a card with a button when there is
 * something to do: a Pix still open, the renewal three days before the month
 * ends, grace, a cancelled month still running, a VIP that ended in the last
 * 30 days. Right after paying, the welcome plays the seal's arrival once.
 *
 * One action each, always the next step ("Renovar", "Continuar", "Reativar",
 * "Voltar pro VIP"), plus "Gerenciar", which opens Configurações, Assinaturas.
 */

const RECENT_EXPIRY_MS = 30 * 86_400_000;

type Variant =
  | "welcome"
  | "member"
  | "pending"
  | "due"
  | "grace"
  | "expired"
  | "cancelled";

export function stripVariant(
  membership: BauMembership,
  welcome: boolean,
  now = Date.now(),
): Variant | null {
  if (welcome && membership.hasAccess) return "welcome";
  if (membership.pendingAttempt) return "pending";
  if (membership.status === "grace") return "grace";
  if (membership.status === "active" && membership.renewalDue) return "due";
  if (membership.status === "active") return "member";
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

/** The strip's surface, and the seal's ring, which must match it. */
const TONE: Record<Variant, { box: string; ring: string }> = {
  welcome: {
    box: "border-transparent bg-accent-soft text-on-accent-soft",
    ring: "ring-accent-soft",
  },
  member: { box: "border-border bg-surface-1 text-text", ring: "ring-surface-1" },
  pending: { box: "border-border bg-surface-1 text-text", ring: "ring-surface-1" },
  due: { box: "border-border bg-surface-1 text-text", ring: "ring-surface-1" },
  grace: {
    box: "border-transparent bg-warning-soft text-on-warning-soft",
    ring: "ring-warning-soft",
  },
  expired: { box: "border-border bg-surface-1 text-text", ring: "ring-surface-1" },
  cancelled: {
    box: "border-border bg-surface-1 text-text",
    ring: "ring-surface-1",
  },
};

export function BauPlusMembershipStrip({
  offer,
  serverName,
  serverIconUrl,
  welcome,
  onDismissWelcome,
  onPay,
  onManage,
  onChanged,
}: {
  offer: BauOffer;
  serverName: string;
  serverIconUrl: string | null;
  welcome: boolean;
  onDismissWelcome: () => void;
  /** Opens the pay sheet (renew, continue, come back). */
  onPay: () => void;
  onManage: () => void;
  onChanged: () => void;
}) {
  const { t, locale } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const membership = offer.membership;
  if (!membership) return null;
  const variant = stripVariant(membership, welcome);
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
  const since = membership.firstPaidAt
    ? formatBauDay(membership.firstPaidAt, locale)
    : "";
  const period = bauPeriodLeft(membership.periodStart, membership.periodEnd);
  const daysLeft = period?.daysLeft ?? 0;

  const copy: Record<Variant, { title: MessageKey; body: MessageKey }> = {
    welcome: {
      title: "bauPlus.strip.welcomeTitle",
      body: "bauPlus.strip.welcomeBody",
    },
    member: {
      title: "bauPlus.strip.memberTitle",
      body: since ? "bauPlus.strip.memberBody" : "bauPlus.strip.memberBodyNoSince",
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
  const vars = {
    server: serverName,
    date: end,
    graceEnd,
    price,
    since,
    count: Math.max(1, daysLeft),
  };

  async function resume() {
    if (!membership) return;
    setBusy(true);
    setFailed(false);
    try {
      await resumeBauMembership(membership.id);
      onChanged();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const primary =
    variant === "welcome" || variant === "member" ? null : variant ===
      "cancelled" ? (
      <Button
        size="sm"
        className="h-9 px-4 max-sm:flex-1"
        disabled={busy}
        onClick={() => void resume()}
      >
        {t("bauPlus.strip.resume")}
      </Button>
    ) : canPay ? (
      <Button
        size="sm"
        className="h-9 px-4 max-sm:flex-1"
        onClick={onPay}
        data-bau-strip-pay
      >
        {variant === "pending"
          ? t("bauPlus.strip.continue")
          : variant === "expired"
            ? t("bauPlus.strip.comeBack")
            : t("bauPlus.strip.renew", { price })}
      </Button>
    ) : null;

  const tone = TONE[variant];
  const slim = variant === "member" || variant === "welcome";
  // The hairline: how much of the paid month is left, wherever access runs.
  const meter =
    period && membership.hasAccess && variant !== "grace" ? (
      <BauMonthMeter
        remaining={period.remaining}
        className="absolute inset-x-0 bottom-0 h-[3px] rounded-none bg-transparent"
      />
    ) : null;

  const lead =
    variant === "pending" ? (
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-card)] bg-surface-3 text-text-secondary">
        <Clock3 aria-hidden className="h-[18px] w-[18px]" />
      </span>
    ) : (
      <VipSeal
        name={serverName}
        iconUrl={serverIconUrl}
        size="sm"
        tone={membership.hasAccess ? "vip" : "muted"}
        celebrate={variant === "welcome"}
        ringClass={tone.ring}
      />
    );

  const text = (
    <div className="min-w-0 flex-1">
      <p className="text-sm font-semibold leading-5">
        {t(copy[variant].title, vars)}
      </p>
      <p
        className={cn(
          "mt-0.5 text-pretty text-[13px] leading-5",
          variant === "welcome" || variant === "grace"
            ? "opacity-85"
            : "text-text-secondary",
        )}
        data-bau-strip-body
      >
        {t(copy[variant].body, vars)}
      </p>
    </div>
  );

  // Nothing to do: the whole row is the way to Assinaturas, so a phone does
  // not have to squeeze a "Gerenciar" beside the words.
  if (variant === "member") {
    return (
      <button
        type="button"
        className={cn(
          "bau-step-in group relative flex w-full items-center gap-3.5 overflow-hidden rounded-[var(--radius-card)] border px-3.5 py-3 text-left transition-colors duration-[var(--duration-fast)] hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
          tone.box,
        )}
        onClick={onManage}
        aria-label={`${t(copy.member.title, vars)}. ${t(copy.member.body, vars)} ${t("bauPlus.strip.manage")}`}
        data-bau-strip="member"
        data-bau-strip-manage
      >
        {lead}
        {text}
        <span className="hidden text-[13px] text-text-tertiary transition-colors group-hover:text-text sm:inline">
          {t("bauPlus.strip.manage")}
        </span>
        <ChevronRight
          aria-hidden
          className="h-4 w-4 shrink-0 text-text-tertiary transition-transform duration-[var(--duration-fast)] group-hover:translate-x-0.5"
        />
        {meter}
      </button>
    );
  }

  return (
    <div
      role="status"
      className={cn(
        "bau-step-in relative overflow-hidden rounded-[var(--radius-card)] border",
        slim ? "px-3.5 py-3" : "px-4 py-3.5",
        tone.box,
      )}
      data-bau-strip={variant}
    >
      <div
        className={cn(
          "flex gap-3",
          slim ? "items-center" : "flex-col sm:flex-row sm:items-center",
        )}
      >
        <div
          className={cn(
            "flex min-w-0 flex-1 gap-3.5",
            slim ? "items-center" : "items-start sm:items-center",
          )}
        >
          {lead}
          <div className="min-w-0 flex-1">
            {text}
            {failed && (
              <p className="mt-1.5 text-sm font-medium text-danger" role="alert">
                {t("bauPlus.manager.actionFailed")}
              </p>
            )}
          </div>
        </div>
        <div
          className={cn(
            "flex shrink-0 items-center gap-1.5",
            // On a phone the button takes the row, under the words.
            !slim && "max-sm:w-full",
          )}
        >
          {primary}
          {variant === "welcome" ? (
            <button
              type="button"
              className="grid h-9 w-9 place-items-center rounded-[var(--radius-control)] transition-colors duration-[var(--duration-fast)] hover:bg-surface-1focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              aria-label={t("bauPlus.strip.dismiss")}
              onClick={onDismissWelcome}
            >
              <X aria-hidden className="h-4 w-4" />
            </button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-9 text-text-secondary"
              onClick={onManage}
              data-bau-strip-manage
            >
              {t("bauPlus.strip.manage")}
            </Button>
          )}
        </div>
      </div>
      {meter}
    </div>
  );
}

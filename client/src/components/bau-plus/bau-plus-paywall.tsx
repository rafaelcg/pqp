import type { BauOffer } from "@pqp/shared";
import { Lock } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { formatBrl } from "@/lib/bau-plus/format";
import { useTranslation } from "@/lib/i18n";

/**
 * The locked post when the server sells VIP (Baú+): Substack's and Patreon's
 * teaser shape. The reader sees the title and the creator's teaser, then text
 * that is clearly there and clearly not readable, fading into one card with one
 * button that says the price.
 *
 * NEVER A DISABLED BUTTON. The only states are "Apoiar por R$ X/mês", "Continuar
 * o pagamento" (a Pix is already open) and, for somebody whose VIP ran out,
 * "Voltar pro VIP". The blurred lines are decoration (`aria-hidden`); the card
 * is a labelled group whose button is described by the sentence above it.
 *
 * The real body never reaches the client: the blurred text is a stock sentence
 * from the catalogue, the same for every post.
 */
export function BauPlusPaywall({
  offer,
  serverName,
  onStart,
  onView,
}: {
  offer: BauOffer;
  serverName: string;
  onStart: () => void;
  /** Drawn once with a live button; for the funnel counter. */
  onView?: () => void;
}) {
  const { t, locale } = useTranslation();
  const headingId = useId();
  const bodyId = useId();
  const viewed = useRef(false);
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  useEffect(() => {
    if (!viewed.current) {
      viewed.current = true;
      onViewRef.current?.();
    }
  }, []);

  if (!offer.plan) {
    return null;
  }
  const price = formatBrl(offer.plan.priceCents, locale);
  const membership = offer.membership;
  const pending = Boolean(membership?.pendingAttempt);
  const lapsed =
    membership?.status === "expired" ||
    membership?.status === "cancelled" ||
    membership?.status === "refunded";

  const cta = pending
    ? t("bauPlus.paywall.continue")
    : lapsed
      ? t("bauPlus.paywall.comeBack", { price })
      : t("bauPlus.paywall.cta", { price });

  return (
    <div className="mt-3" data-home-unlock-cta data-bau-paywall>
      {/* Three lines at any width: the sentence twice, clipped. */}
      <p
        aria-hidden
        className="bau-blur-text max-h-[5.25rem] overflow-hidden text-sm leading-7 text-text-secondary"
      >
        {t("bauPlus.paywall.blurText")} {t("bauPlus.paywall.blurText")}
      </p>
      <div
        role="group"
        aria-labelledby={headingId}
        className="elevation-1 relative -mt-6 rounded-[var(--radius-card)] bg-surface-card p-4 sm:p-5"
      >
        <div className="flex items-center gap-2.5">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft text-on-accent-soft">
            <Lock aria-hidden className="h-3.5 w-3.5" />
          </span>
          <p
            id={headingId}
            className="min-w-0 font-display text-lg font-bold leading-6 text-text text-balance"
          >
            {t("bauPlus.paywall.title")}
          </p>
        </div>
        <p
          id={bodyId}
          className="mt-2 max-w-[34rem] text-pretty text-sm leading-6 text-text-secondary"
        >
          {pending
            ? t("bauPlus.paywall.pendingBody")
            : t("bauPlus.paywall.body", { server: serverName })}
        </p>
        <div className="mt-4 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-4">
          <Button
            className="h-11 w-full px-5 text-[15px] sm:w-auto"
            onClick={onStart}
            aria-describedby={bodyId}
            data-bau-paywall-cta
          >
            {cta}
          </Button>
          <p className="text-center text-[13px] leading-5 text-text-tertiary sm:text-left">
            {t("bauPlus.paywall.fine")}
          </p>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AndroidMark,
  IosMark,
} from "@/components/downloads/platform-marks";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { isAutomatedBrowser } from "@/lib/hints";
import { isAndroidDevice } from "@/lib/downloads";
import { useTranslation } from "@/lib/i18n";
import {
  isMobileBetaHintSeen,
  rememberMobileBetaHint,
} from "@/lib/mobile-beta-hint";

/**
 * One corner card: there is a native app for this phone.
 *
 * Same shape as QG / cargos / dice. No backdrop, no focus trap, Escape or
 * the X closes it. Android goes to `/android`, iPhone to `/beta`. The
 * queue in `corner-hints.ts` is what stops this stacking on the others.
 */
export function MobileBetaHint({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const [eligible] = useState(
    () => !isAutomatedBrowser() && !isMobileBetaHintSeen(),
  );
  const [open, setOpen] = useState(true);
  const [android] = useState(() => isAndroidDevice());

  useEffect(() => {
    if (eligible && enabled) {
      rememberMobileBetaHint();
    }
  }, [eligible, enabled]);

  const show = eligible && enabled && open;
  const titleKey = android
    ? "mobileBetaHint.android.title"
    : "mobileBetaHint.ios.title";
  const bodyKey = android
    ? "mobileBetaHint.android.body"
    : "mobileBetaHint.ios.body";
  const ctaKey = android
    ? "mobileBetaHint.android.cta"
    : "mobileBetaHint.ios.cta";
  const to = android ? "/android" : "/beta";
  const Mark = android ? AndroidMark : IosMark;

  return (
    <CornerCard
      open={show}
      onClose={() => setOpen(false)}
      label={t(titleKey)}
      dismissLabel={t("mobileBetaHint.dismiss")}
      dataAttribute="mobile-beta"
      title={t(titleKey)}
      body={t(bodyKey)}
      footer={
        <Button asChild size="sm" className="cta-lift rounded-full px-4">
          <Link to={to} onClick={() => setOpen(false)}>
            {t(ctaKey)}
          </Link>
        </Button>
      }
    >
      <div
        aria-hidden
        className="mt-3 flex items-center justify-center rounded-xl bg-ink-3/60 py-4"
      >
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-signal/12 text-signal">
          <Mark className="h-8 w-8" />
        </span>
      </div>
    </CornerCard>
  );
}

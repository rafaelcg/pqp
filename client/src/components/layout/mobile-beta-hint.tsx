import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AndroidMark,
  IosMark,
} from "@/components/downloads/platform-marks";
import { Button } from "@/components/ui/button";
import { isAutomatedBrowser } from "@/lib/cargos-hint";
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

  useEffect(() => {
    if (!eligible || !enabled || !open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [eligible, enabled, open]);

  if (!eligible || !enabled || !open) {
    return null;
  }

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
    <aside
      aria-label={t(titleKey)}
      className="animate-fade-in safe-pb fixed inset-x-3 bottom-3 z-30 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[22rem]"
    >
      <div className="rounded-2xl border border-ink-4 bg-ink-2 p-4 shadow-[var(--shadow-popover)]">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 font-display text-sm font-bold tracking-tight text-paper">
            {t(titleKey)}
          </h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label={t("mobileBetaHint.dismiss")}
            className="-mr-1 -mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-paper-muted outline-none hover:bg-ink-3 hover:text-paper focus-visible:ring-2 focus-visible:ring-signal/60"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
        <p className="mt-1.5 text-pretty text-sm leading-relaxed text-paper-muted">
          {t(bodyKey)}
        </p>
        <div
          aria-hidden
          className="mt-3 flex items-center justify-center rounded-xl bg-ink-3/60 py-4"
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-signal/12 text-signal">
            <Mark className="h-8 w-8" />
          </span>
        </div>
        <Button asChild size="sm" className="cta-lift mt-3 rounded-full px-4">
          <Link to={to} onClick={() => setOpen(false)}>
            {t(ctaKey)}
          </Link>
        </Button>
      </div>
    </aside>
  );
}

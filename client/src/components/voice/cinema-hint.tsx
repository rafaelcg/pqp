import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "@/lib/i18n";
import {
  rememberCinemaHint,
  shouldShowCinemaHint,
} from "@/lib/cinema-hint";
import { cn } from "@/lib/utils";

/**
 * One line on the stage, iPhone in a browser tab only: the home-screen app is
 * where a share gets the whole screen. Inline rather than a corner card
 * because it is about the thing under it, and the corner queue is for cards
 * that could show anywhere. See `docs/ONBOARDING.md`.
 *
 * Not gated on `navigator.webdriver`: it only ever renders under an iOS user
 * agent, which the one suite that emulates an iPhone wants to see.
 */
export function CinemaHint({
  visible,
  className,
}: {
  /** The stage is expanded with a share on it. */
  visible: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [eligible] = useState(() => shouldShowCinemaHint());
  const [open, setOpen] = useState(true);
  const show = eligible && visible && open;

  useEffect(() => {
    if (show) {
      rememberCinemaHint();
    }
  }, [show]);

  if (!show) {
    return null;
  }
  return (
    <div
      role="note"
      data-cinema-hint=""
      className={cn(
        "pointer-events-auto flex max-w-[min(100%,26rem)] items-center gap-2 rounded-full bg-ink/80 py-1.5 pl-3 pr-1.5 text-xs text-paper shadow-lg ring-1 ring-ink-4/60 backdrop-blur-sm animate-rise",
        className,
      )}
    >
      <span className="min-w-0 truncate">{t("cinemaHint.body")}</span>
      <button
        type="button"
        aria-label={t("cinemaHint.dismiss")}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-paper-muted hover:bg-ink-3 hover:text-paper"
        onClick={() => setOpen(false)}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

import { Music2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isolate } from "@/lib/bidi";
import { useTranslation } from "@/lib/i18n";
import type { JamHandover } from "@/lib/jam-handover";

/**
 * "Voltar pra jam": one strip at the top of the app for somebody who came from
 * the public jam site, after the first run and the song are behind them. It is
 * the way back that the chat product never had (finding M1: two of five testers
 * escaped with the browser's Back button, one gave up).
 *
 * The button reopens the song they came for, inside the app where they are
 * signed in (the public site never knows it, `docs/JAM_SITE.md`); for a person
 * who came to start a jam it opens the start sheet. The X is "not now" and ends
 * the session's handover, so closing a song stops leaving the app too.
 *
 * Same frame as the other strips (`NewcomerInviteStrip`): accent-soft, one
 * primary, one close, `animate-rise` (off under reduced motion). Mounted by
 * `App` above the page, so it shows on the home, a server and a conversation
 * alike, and never while a public jam is open (that view covers the app).
 */
export function JamHandoverStrip({
  handover,
  onReturn,
  onDismiss,
}: {
  handover: JamHandover;
  onReturn: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-jam-handover-strip=""
      role="status"
      className="animate-rise flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-accent-soft px-4 py-2.5"
    >
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent"
      >
        <Music2 className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-on-accent-soft">
          {t("jam.handover.waiting")}
        </p>
        {handover.title ? (
          <p className="truncate text-sm text-on-accent-soft/80">
            {isolate(handover.title)}
          </p>
        ) : null}
      </div>
      {/* On a phone the button takes its own row under the text, lined up with
          it (past the 32px icon and its 12px gap), like the newcomer strip's;
          the X stays at the end of the first row. */}
      <div className="order-last flex w-full pl-11 sm:order-none sm:w-auto sm:pl-0">
        <Button
          size="sm"
          data-jam-handover-return=""
          className="shrink-0"
          onClick={onReturn}
        >
          {t("jam.handover.back")}
        </Button>
      </div>
      <button
        type="button"
        data-jam-handover-close=""
        aria-label={t("jam.handover.dismiss")}
        onClick={onDismiss}
        className="relative shrink-0 rounded-[var(--radius-control)] p-1.5 text-on-accent-soft/70 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring after:absolute after:-inset-1.5 after:content-['']"
      >
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>
  );
}

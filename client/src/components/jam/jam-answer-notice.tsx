import { Check, Undo2, X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { isolate } from "@/lib/bidi";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import type { JamInstrument } from "@pqp/shared";

/**
 * What happened when the starter answered an outside part, said where the answer
 * was given (user test round 3, n-1: after "Aceitar" the box vanished and a tile
 * appeared, and the starter said it was quiet).
 *
 *   accepted  the part is in; what the public sees now; "Desfazer" for a few
 *             seconds (the part goes back to the queue: it is the same take taken
 *             out of the mix again, which the API allows)
 *   undone    it went back to the queue
 *   refused   the part was declined; the sender is told. No undo: a declined take
 *             is deleted, and the API has no way to bring it back
 *
 * It stands where the waiting block stood (the top of the song), is a status for
 * a screen reader, and leaves by itself.
 */

export type JamAnswerKind = "accepted" | "undone" | "refused";

export interface JamAnswer {
  kind: JamAnswerKind;
  trackId: string;
  instrument: JamInstrument;
  /** The sender, as the starter sees them. */
  name: string | null;
}

/** How long the answer stays, and how long "Desfazer" is offered (the same window: the button is the point of the box). */
export const JAM_ANSWER_MS = 8000;
export const JAM_ANSWER_UNDONE_MS = 5000;

export function JamAnswerNotice({
  answer,
  busy = false,
  onUndo,
  onDismiss,
}: {
  answer: JamAnswer;
  busy?: boolean;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const { kind, trackId } = answer;
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, kind === "undone" ? JAM_ANSWER_UNDONE_MS : JAM_ANSWER_MS);
    return () => window.clearTimeout(timer);
    // One timer per answer: a re-render with the same answer must not start the clock over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, trackId]);
  const Icon = kind === "refused" ? X : Check;
  return (
    <div
      role="status"
      aria-live="polite"
      data-jam-answered={kind}
      className="animate-rise mt-3 flex items-start gap-3 rounded-[var(--radius-panel)] border border-border bg-surface-2 p-3"
    >
      <span aria-hidden="true" className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-3 text-text-secondary">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-snug text-text [overflow-wrap:anywhere] [text-wrap:pretty]">
          {t(`jam.public.answered.${kind}` as MessageKey, {
            instrument: t(JAM_INSTRUMENT_LOOK[answer.instrument].nameKey as MessageKey).toLowerCase(),
            name: isolate(answer.name ?? t("jam.tile.anonymous")),
          })}
        </p>
        {kind === "accepted" && (
          <Button size="sm" variant="secondary" className="mt-2 gap-1.5 pointer-coarse:h-11" disabled={busy} onClick={onUndo} data-jam-answered-undo="">
            <Undo2 className="h-3.5 w-3.5" aria-hidden />
            {t("jam.public.answered.undo")}
          </Button>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("common.close")}
        data-jam-answered-close=""
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-text-secondary outline-none hover:bg-surface-3 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring pointer-coarse:h-11 pointer-coarse:w-11"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

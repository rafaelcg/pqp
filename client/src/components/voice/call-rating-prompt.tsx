import { useState } from "react";
import { CALL_RATING_NOTE_MAX_LENGTH } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { RatableCall } from "@/hooks/use-call-rating";

/**
 * "How was that call?", once, after a call that was long enough to have an
 * answer.
 *
 * NUMBERS, NOT STARS. Stars are a rating of a thing you chose; a call is
 * something that either worked or did not, and five stars invites a review
 * where five buttons invites a verdict. The labels on the ends do the work
 * that a star's shape does not.
 *
 * THE NOTE ONLY APPEARS ON A LOW SCORE, because that is the only place the
 * number leaves a question open. A 5 tells us everything a 5 can tell us; a 2
 * needs to say whether it was the voice, the picture or the joining. Asking
 * everybody for prose would cost the majority a step and buy nothing, and the
 * server drops a note on a high score anyway.
 *
 * DISMISSING IS FREE AND FINAL. The X closes it for this call and the cooldown
 * has already been written, so nobody can be nagged by re-opening the tab.
 * There is no "remind me later", because there is no later for a call that has
 * already ended.
 */
export function CallRatingPrompt({
  call,
  onDone,
}: {
  call: RatableCall;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const wantsNote = rating !== null && rating <= 3;

  async function send(score: number, withNote: string) {
    setSending(true);
    try {
      await apiFetch("/api/voice/ratings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating: score,
          note: withNote.trim() ? withNote.trim() : undefined,
          durationSeconds: call.durationSeconds,
          peerCount: call.peerCount,
          transport: call.transport,
          hadScreenShare: call.hadScreenShare,
          channelId: call.channelId ?? undefined,
        }),
      });
    } catch {
      // A rating that failed to send is not worth an error message. The person
      // has already answered and moved on, and there is nothing they could do
      // about it: telling them would turn our problem into their interruption.
    } finally {
      setSent(true);
      setSending(false);
      window.setTimeout(onDone, 1400);
    }
  }

  function pick(score: number) {
    setRating(score);
    // A good score is the whole answer, so it goes immediately and the card
    // gets out of the way. A low one waits for the optional detail.
    if (score > 3) {
      void send(score, "");
    }
  }

  if (sent) {
    return (
      <div
        role="status"
        className="rounded-lg border border-paper/10 bg-surface-2 px-4 py-3 text-sm text-paper-muted"
      >
        {t("call.rating.thanks")}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-paper/10 bg-surface-2 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-paper">{t("call.rating.ask")}</p>
        <button
          type="button"
          onClick={onDone}
          aria-label={t("call.rating.dismiss")}
          className="-mr-1 -mt-1 rounded p-1 text-paper-muted transition-colors hover:text-paper"
        >
          <span aria-hidden>&times;</span>
        </button>
      </div>

      <div className="mt-3 flex items-center gap-1.5">
        {[1, 2, 3, 4, 5].map((score) => (
          <button
            key={score}
            type="button"
            disabled={sending}
            aria-label={t("call.rating.score", { score: String(score) })}
            aria-pressed={rating === score}
            onClick={() => pick(score)}
            className={cn(
              "h-9 w-9 rounded-md border text-sm font-semibold tabular-nums transition-colors",
              rating === score
                ? "border-signal bg-signal text-ink"
                : "border-paper/15 text-paper-muted hover:border-paper/40 hover:text-paper",
            )}
          >
            {score}
          </button>
        ))}
      </div>

      <div className="mt-2 flex justify-between text-[11px] text-paper-muted/70">
        <span>{t("call.rating.low")}</span>
        <span>{t("call.rating.high")}</span>
      </div>

      {wantsNote && (
        <div className="mt-3 flex flex-col gap-2">
          <label htmlFor="call-rating-note" className="sr-only">
            {t("call.rating.notePlaceholder")}
          </label>
          <input
            id="call-rating-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={CALL_RATING_NOTE_MAX_LENGTH}
            placeholder={t("call.rating.notePlaceholder")}
            className="w-full rounded-md border border-paper/15 bg-surface-1 px-3 py-2 text-sm text-paper placeholder:text-paper-muted/60 focus:border-signal focus:outline-none"
          />
          <Button
            size="sm"
            disabled={sending}
            onClick={() => void send(rating!, note)}
          >
            {t("call.rating.send")}
          </Button>
        </div>
      )}
    </div>
  );
}

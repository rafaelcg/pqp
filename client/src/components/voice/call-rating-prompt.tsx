import { useState } from "react";
import { CALL_RATING_NOTE_MAX_LENGTH } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { RatableCall } from "@/hooks/use-call-rating";
import { X } from "@phosphor-icons/react";
import { Icon } from "@/components/ui/icon";

/** Under the redesign the prompt is a card, on the card tokens. */
const CARD =
  // It floats over the user panel and the rail, so it is a popover: a solid
  // surface with a lift, never the see-through card tint.
  "redesign:rounded-[var(--popover-radius)] redesign:border-[color:var(--popover-border)] redesign:bg-[color:var(--popover-surface)] redesign:px-5 redesign:py-4 redesign:shadow-[var(--popover-shadow)]";

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
  initialRating = null,
  initialStage = null,
}: {
  call: RatableCall;
  onDone: () => void;
  /** The QA sheet's way to show the note step; the app never passes it. */
  initialRating?: number | null;
  /** The QA sheet's way to show sending and thanks; the app never passes it. */
  initialStage?: "sending" | "sent" | null;
}) {
  const { t } = useTranslation();
  const [rating, setRating] = useState<number | null>(initialRating);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(initialStage === "sending");
  const [sent, setSent] = useState(initialStage === "sent");

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
          // Same rule as the note above, and the server enforces it too
          // (`recordCallRating`) rather than trusting this: a quality
          // reading on a good call is not diagnostic, so there is nothing to
          // send.
          mediaQuality: score <= 3 ? call.mediaQuality : undefined,
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
        className={cn("rounded-lg border border-paper/10 bg-surface-2 px-4 py-3 text-sm text-paper-muted", CARD, "redesign:text-text-secondary")}
      >
        {t("call.rating.thanks")}
      </div>
    );
  }

  return (
    <div className={cn("rounded-lg border border-paper/10 bg-surface-2 px-4 py-3", CARD)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-paper redesign:font-semibold redesign:text-text">{t("call.rating.ask")}</p>
        <button
          type="button"
          onClick={onDone}
          aria-label={t("call.rating.dismiss")}
          className="-mr-1 -mt-1 rounded p-1 text-paper-muted transition-colors hover:text-paper redesign:-mr-2 redesign:-mt-1.5 redesign:flex redesign:h-7 redesign:w-7 redesign:items-center redesign:justify-center redesign:rounded-full redesign:p-0 redesign:text-text-tertiary redesign:hover:bg-[color:var(--card-row-hover)] redesign:hover:text-text redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-[color:var(--color-focus-ring)]"
        >
          <span aria-hidden className="redesign:hidden">&times;</span>
          <Icon icon={X} kind="symbol" size="sm" className="hidden redesign:block" />
        </button>
      </div>

      {/* Under the redesign the end labels span exactly the five scores. */}
      <div className="contents redesign:block redesign:w-fit">
      <div className="mt-3 flex items-center gap-1.5 redesign:gap-2">
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
              "redesign:rounded-full redesign:disabled:cursor-default redesign:disabled:opacity-60 redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-offset-2 redesign:focus-visible:ring-offset-ring-offset redesign:focus-visible:ring-[color:var(--color-focus-ring)]",
              rating === score
                ? "redesign:border-accent redesign:bg-accent redesign:text-on-accent"
                : "redesign:border-[color:var(--card-border)] redesign:bg-[color:var(--call-control-bg)] redesign:text-text-secondary redesign:hover:border-[color:var(--card-border)] redesign:hover:bg-[color:var(--call-control-hover)] redesign:hover:text-text",
            )}
          >
            {score}
          </button>
        ))}
      </div>

      <div className="mt-2 flex justify-between text-[11px] text-paper-muted/70 redesign:text-xs redesign:text-text-tertiary">
        <span>{t("call.rating.low")}</span>
        <span>{t("call.rating.high")}</span>
      </div>
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
            className="w-full rounded-md border border-paper/15 bg-surface-1 px-3 py-2 text-sm text-paper placeholder:text-paper-muted/60 focus:border-signal focus:outline-none redesign:h-[var(--input-h)] redesign:rounded-[var(--input-radius,var(--radius-control))] redesign:border-[color:var(--input-border)] redesign:bg-[color:var(--input-bg)] redesign:px-[var(--input-px)] redesign:text-text redesign:placeholder:text-text-tertiary redesign:focus:border-[color:var(--input-border)] redesign:focus-visible:ring-2 redesign:focus-visible:ring-offset-2 redesign:focus-visible:ring-offset-ring-offset redesign:focus-visible:ring-[color:var(--input-ring,var(--color-focus-ring))]"
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

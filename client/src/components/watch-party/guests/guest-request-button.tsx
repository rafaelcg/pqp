import { Hand } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * CONVIDADOS §3.1: the audience's ONLY control, and only when `guests ===
 * "request"`. Four states — idle, pending, declined-with-a-cooldown, and (per
 * the spec) never a fifth "the room is full" state that closes the button:
 * the queue is never closed, only the list that shows it.
 *
 * WITHDRAW IS ALWAYS FREE while pending: asking is a request, and somebody
 * who changed their mind must be able to say so, same reasoning as lowering a
 * hand (`docs/RAISED_HANDS.md`). A decline costs a cooldown; a withdraw never
 * does.
 */
export function GuestRequestButton({
  requested,
  position,
  cooldownMinutesLeft,
  onRequest,
  onWithdraw,
  className,
}: {
  requested: boolean;
  /** 1-based place in the queue, or null (not requesting, or unknown yet). */
  position: number | null;
  /** Minutes left on a decline's cooldown, or null when none is active. */
  cooldownMinutesLeft: number | null;
  onRequest: () => void;
  onWithdraw: () => void;
  className?: string;
}) {
  const { t } = useTranslation();

  if (cooldownMinutesLeft !== null && cooldownMinutesLeft > 0) {
    return (
      <div
        data-watch-party-guest-request="declined"
        className={cn("flex flex-col items-end gap-0.5 text-right", className)}
      >
        <Button variant="secondary" size="sm" disabled>
          <Hand className="h-3.5 w-3.5" aria-hidden="true" />
          {t("watchParty.guests.ask")}
        </Button>
        <span className="max-w-[16rem] text-[11px] text-text-tertiary">
          {t("watchParty.guests.declined", { minutes: cooldownMinutesLeft })}
        </span>
      </div>
    );
  }

  if (requested) {
    return (
      <div
        data-watch-party-guest-request="pending"
        className={cn("flex flex-col items-end gap-0.5 text-right", className)}
      >
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-on-accent-soft"
            aria-live="polite"
          >
            <Hand className="h-3.5 w-3.5" aria-hidden="true" />
            {t("watchParty.guests.asked")}
          </span>
          <button
            type="button"
            data-watch-party-guest-withdraw
            className="text-xs text-text-tertiary underline-offset-2 hover:text-text hover:underline"
            onClick={onWithdraw}
          >
            {t("watchParty.guests.withdraw")}
          </button>
        </div>
        {position !== null && (
          <span className="text-[11px] text-text-tertiary">
            {t("watchParty.guests.position", { position })}
          </span>
        )}
      </div>
    );
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      data-watch-party-guest-request="idle"
      onClick={onRequest}
      className={className}
    >
      <Hand className="h-3.5 w-3.5" aria-hidden="true" />
      {t("watchParty.guests.ask")}
    </Button>
  );
}

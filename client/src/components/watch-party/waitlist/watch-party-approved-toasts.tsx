import { PartyPopper, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";

export interface WatchPartyApprovedCard {
  serverId: string;
  serverName: string;
}

/**
 * "Watch party liberada!": the other end of "avisamos aqui quando liberar".
 *
 * Fed from two places in `App.tsx`: the durable list the API keeps
 * (`GET /api/watch-party/waitlist/approvals`, read once at boot, so somebody
 * who was offline when the operator pressed Ativar still hears about it) and
 * the live `watch-party-waitlist-approved` frame. The card stays until it is
 * answered, because it is the one thing this person asked to be told, and
 * either button spends it on the server so it never comes back.
 *
 * Same corner and shell as the session reminders; `animate-toast-in` is
 * already off under reduced motion.
 */
export function WatchPartyApprovedToasts({
  cards,
  onOpen,
  onDismiss,
}: {
  cards: readonly WatchPartyApprovedCard[];
  onOpen: (serverId: string) => void;
  onDismiss: (serverId: string) => void;
}) {
  const { t } = useTranslation();
  if (cards.length === 0) {
    return null;
  }
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-[max(0.5rem,env(safe-area-inset-top))] z-40 flex flex-col items-center gap-2 px-2 sm:top-[4.25rem]"
      data-watch-party-approved-toasts=""
    >
      {cards.slice(0, 3).map((card) => (
        <div
          key={card.serverId}
          role="status"
          data-watch-party-approved-toast={card.serverId}
          className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-border bg-surface-2 p-3 shadow-[var(--shadow-popover)] animate-toast-in"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-on-accent-soft">
            <PartyPopper className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-text">
              {t("watchParty.waitlist.toast.title")}
            </p>
            <p className="text-xs text-text-secondary [overflow-wrap:anywhere]">
              {t("watchParty.waitlist.toast.body", { server: card.serverName })}
            </p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => onOpen(card.serverId)}>
                {t("watchParty.waitlist.toast.open")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onDismiss(card.serverId)}>
                {t("watchParty.waitlist.toast.dismiss")}
              </Button>
            </div>
          </div>
          <button
            type="button"
            aria-label={t("a11y.closeDialog")}
            className="shrink-0 rounded-[var(--radius-control)] p-1 text-text-tertiary transition-colors hover:bg-surface-3 hover:text-text"
            onClick={() => onDismiss(card.serverId)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

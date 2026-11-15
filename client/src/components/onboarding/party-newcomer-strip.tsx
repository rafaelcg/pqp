import { Clapperboard, X } from "lucide-react";
import { useTranslation } from "@/lib/i18n";

/**
 * "What is this": one dismissible line for a stranger who just landed in a
 * live watch party (`party_newcomer_experience`, `lib/party-newcomer.ts`).
 *
 * The public page and the wizard say "a community" and never "a film is on
 * air"; the arrival strip that used to say something was removed over parties
 * (the film is the welcome) and nothing replaced it, so the chat asked three
 * times what this was. This says the three things a first-timer needs and no
 * more: it is a watch party, somebody is sharing their screen, and where the
 * room is. Where the room is depends on the layout drawn right now (beside the
 * film on a wide window, under it on a phone), which the caller reads from the
 * split rather than guessing from a width.
 *
 * A strip and not a card: it sits between the party bar and the picture and
 * pushes nothing around when closed, and it is not a corner card, so it takes
 * no part in `CORNER_HINT_ORDER`. Motion is `animate-rise`, which the global
 * reduced-motion rule already turns off.
 */
export function PartyNewcomerStrip({
  hostName,
  chatBeside,
  onDismiss,
}: {
  /** Who is sharing. Empty falls back to a line with no name in it. */
  hostName: string;
  /** The chat is beside the film, not under it. */
  chatBeside: boolean;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const name = hostName.trim();
  const body = name
    ? t(
        chatBeside
          ? "partyNewcomer.body.beside"
          : "partyNewcomer.body.below",
        { name },
      )
    : t(
        chatBeside
          ? "partyNewcomer.bodyNoName.beside"
          : "partyNewcomer.bodyNoName.below",
      );

  return (
    <div
      data-party-newcomer-strip=""
      role="status"
      className="animate-rise flex shrink-0 items-center gap-2 border-b border-border bg-accent-soft px-3 py-1.5"
    >
      <Clapperboard
        aria-hidden="true"
        className="h-4 w-4 shrink-0 text-on-accent-soft"
      />
      <p className="min-w-0 flex-1 text-pretty text-xs font-medium text-on-accent-soft sm:text-sm">
        {body}
      </p>
      <button
        type="button"
        data-party-newcomer-dismiss=""
        aria-label={t("partyNewcomer.dismiss")}
        onClick={onDismiss}
        className="relative shrink-0 rounded-[var(--radius-control)] p-1.5 text-on-accent-soft/70 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring after:absolute after:-inset-1.5 after:content-['']"
      >
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>
  );
}

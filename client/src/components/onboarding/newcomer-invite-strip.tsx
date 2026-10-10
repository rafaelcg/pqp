import { UserPlus, X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { track } from "@/lib/track";

/**
 * "Chama teus amigos pra cá": one strip under the header of a public
 * community, for a newcomer who is in nothing but public communities and has
 * no friends yet. The button opens Criar sala with a name already in it, and
 * that dialog ends on the invite link and the pastes (`ServerReadyPanel`), so
 * two taps put a link in hand.
 *
 * Same frame as the arrival strip, and it takes the arrival strip's slot:
 * one instruction per screen. Who sees it is `newcomerInviteVisible` in
 * `lib/newcomer-invite.ts`; this file only draws it.
 */
export function NewcomerInviteStrip({
  onInvite,
  onDismiss,
}: {
  onInvite: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    track("newcomer_invite_view");
  }, []);

  return (
    <div
      data-newcomer-invite-strip=""
      role="status"
      className="animate-rise flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-accent-soft px-4 py-3"
    >
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent"
      >
        <UserPlus className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-balance text-sm font-semibold text-on-accent-soft">
          {t("newcomerInvite.title")}
        </p>
        <p className="mt-0.5 text-pretty text-sm text-on-accent-soft/80">
          {t("newcomerInvite.body")}
        </p>
      </div>
      {/* On a phone the button takes its own row under the text, lined up
          with it (past the 32px icon and its 12px gap), like the arrival
          strip's copy button. */}
      <div className="order-last flex w-full gap-2 pl-11 sm:order-none sm:w-auto sm:pl-0">
        <Button
          size="sm"
          data-newcomer-invite-action=""
          className="shrink-0"
          onClick={() => {
            track("newcomer_invite_click");
            onInvite();
          }}
        >
          <UserPlus aria-hidden="true" className="h-3.5 w-3.5" />
          {t("newcomerInvite.action")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          data-newcomer-invite-later=""
          className="hidden shrink-0 sm:inline-flex"
          onClick={() => {
            track("newcomer_invite_dismiss");
            onDismiss();
          }}
        >
          {t("newcomerInvite.later")}
        </Button>
      </div>
      <button
        type="button"
        data-newcomer-invite-close=""
        aria-label={t("newcomerInvite.later")}
        onClick={() => {
          track("newcomer_invite_dismiss");
          onDismiss();
        }}
        className="relative shrink-0 rounded-[var(--radius-control)] p-1.5 text-on-accent-soft/70 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring after:absolute after:-inset-1.5 after:content-[''] sm:hidden"
      >
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>
  );
}

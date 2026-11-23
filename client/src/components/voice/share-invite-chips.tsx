import { ScreenShare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * "{name} tá compartilhando a tela · Assistir", for shares that opt-in
 * watching held back (`VoiceState.shareInvitePeerIds`, `share_popout`, issue
 * 1736).
 *
 * Lives in the call's bar, beside the faces, because that bar is what is on
 * screen in every channel while the chat keeps the pane: the stage, where a
 * declined share's tile used to carry its own way back, is not drawn when the
 * popout is on. Nothing is received for a share until its button is pressed.
 */

export interface ShareInvite {
  peerId: string;
  presenterName: string;
}

/** Named chips before the rest collapse into "+2 compartilhando". */
export const SHARE_INVITE_CHIP_LIMIT = 2;

export function shareInviteSlots<T>(
  invites: readonly T[],
  limit: number = SHARE_INVITE_CHIP_LIMIT,
): { shown: T[]; overflow: number } {
  // "+1" is never worth a name: with exactly one over the limit, show it.
  if (invites.length <= limit + 1) {
    return { shown: [...invites], overflow: 0 };
  }
  return { shown: invites.slice(0, limit), overflow: invites.length - limit };
}

export function ShareInviteChips({
  invites,
  onWatch,
  className,
}: {
  invites: readonly ShareInvite[];
  onWatch: (peerId: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  if (invites.length === 0) {
    return null;
  }
  const { shown, overflow } = shareInviteSlots(invites);
  return (
    <div
      data-testid="share-invite-chips"
      className={cn("flex min-w-0 shrink items-center gap-1.5", className)}
    >
      {shown.map((invite) => (
        <span
          key={invite.peerId}
          data-share-invite={invite.peerId}
          className="flex min-w-0 items-center gap-1.5 rounded-full bg-surface-2 py-0.5 pl-2.5 pr-0.5 text-xs text-text"
        >
          <ScreenShare
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-signal"
          />
          <span className="min-w-0 truncate">
            {t("voice.share.invite", { name: invite.presenterName })}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-6 shrink-0 rounded-full px-2.5 text-xs"
            aria-label={t("voice.share.inviteWatchLabel", {
              name: invite.presenterName,
            })}
            onClick={() => onWatch(invite.peerId)}
          >
            {t("voice.share.inviteWatch")}
          </Button>
        </span>
      ))}
      {overflow > 0 && (
        <span className="shrink-0 text-xs text-text-tertiary">
          {t("voice.share.inviteMore", { count: overflow })}
        </span>
      )}
    </div>
  );
}

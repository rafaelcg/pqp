import { Dialog, DialogBody } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";

/**
 * CONVIDADOS §3.4: "the one moment in this feature that deserves to
 * interrupt." A person finds themselves in their own copy of `party.guests
 * .invited` and this fires — not a banner, a dialog, because going on air is
 * the one thing here worth stopping someone to ask about.
 *
 * ACCEPTING IS THE CALLER'S JOB, not this component's: the order in §3.4 (stop
 * the HLS player, ask for mic then camera, join the room, publish, THEN call
 * `join`) lives in the hook that has the room and the player, not in a
 * dialog. This only asks the yes/no question and reports which.
 */
export function GuestInviteDialog({
  open,
  hostName,
  busy = false,
  onAccept,
  onDecline,
}: {
  open: boolean;
  hostName: string;
  /** True while the accept path (mic/camera prompts, joining) is running. */
  busy?: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const { t } = useTranslation();
  if (!open) {
    return null;
  }
  return (
    <Dialog
      open={open}
      title={t("watchParty.guests.invitedTitle", { name: hostName })}
      description={t("watchParty.guests.invitedBody")}
      onClose={onDecline}
      closeOnBackdrop={false}
      dismissible={!busy}
      footer={
        <div className="flex w-full justify-end gap-2" data-watch-party-guest-invite-dialog>
          <Button
            variant="secondary"
            onClick={onDecline}
            disabled={busy}
            data-watch-party-guest-invite-decline
          >
            {t("watchParty.guests.invitedDecline")}
          </Button>
          <Button
            onClick={onAccept}
            disabled={busy}
            data-watch-party-guest-invite-accept
          >
            {t("watchParty.guests.invitedAccept")}
          </Button>
        </div>
      }
    >
      <DialogBody>
        <span className="sr-only">{t("watchParty.guests.invitedBody")}</span>
      </DialogBody>
    </Dialog>
  );
}

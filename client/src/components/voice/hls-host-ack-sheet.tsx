import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { useTranslation } from "@/lib/i18n";

/**
 * "You're responsible for what you stream", shown once per user per server.
 * `useHlsHostAck` owns whether it should be open at all; this is only the
 * sheet itself.
 *
 * WHEN IT APPEARS, AND WHY THAT MOVED. It used to be raised by the share
 * start, which in a watch party meant it landed AFTER "Ir ao vivo": the party
 * was already live and the room already told about it while the host read a
 * notice about being responsible for what they broadcast. That is the one
 * moment the notice exists for, and it arrived too late to inform the
 * decision. It is now raised when a host opens the setup surface, before
 * anything can be sent. The plain screen-share path outside a watch party
 * still raises it at the share start, which for that path is still before
 * anything goes out.
 *
 * `confirmLabel` exists because of that move: "Entendi, começar a transmitir"
 * is a lie on a surface where confirming starts nothing.
 */
export function HlsHostAckSheet({
  open,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  open: boolean;
  /** Defaults to the "start streaming" wording of the share-start path. */
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Dialog
      open={open}
      title={t("voice.hostAck.title")}
      size="sm"
      closeOnBackdrop={false}
      onClose={onClose}
      footer={
        <div className="flex w-full flex-col gap-2">
          <Button
            type="button"
            className="w-full"
            autoFocus
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel ?? t("voice.hostAck.confirm")}
          </Button>
          <Link
            to="/terms"
            target="_blank"
            rel="noreferrer"
            className="text-center text-xs text-paper-muted underline"
          >
            {t("voice.hostAck.terms")}
          </Link>
        </div>
      }
    >
      <DialogBody>
        <p className="text-sm text-paper-muted">{t("voice.hostAck.body")}</p>
      </DialogBody>
    </Dialog>
  );
}

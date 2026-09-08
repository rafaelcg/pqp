import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useTranslation } from "@/lib/i18n";

/**
 * "You're responsible for what you stream" -- shown once per user per
 * server, the first time they start a watch-party / HLS broadcast in that
 * server. `useHlsHostAck` owns whether it should be open at all; this is
 * only the sheet itself.
 */
export function HlsHostAckSheet({
  open,
  onConfirm,
  onClose,
}: {
  open: boolean;
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
            {t("voice.hostAck.confirm")}
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
      <p className="text-sm text-paper-muted">{t("voice.hostAck.body")}</p>
    </Dialog>
  );
}

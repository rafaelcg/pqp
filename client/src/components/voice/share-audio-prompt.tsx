import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckRow } from "@/components/ui/check-row";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { useTranslation } from "@/lib/i18n";

/**
 * The audio question, asked before the picker on a Windows desktop shell
 * whose picker cannot ask yet.
 *
 * Discord puts this checkbox on the share picker itself. Ours does too, from
 * the binary that advertises `sharePickerOffersAudio`. Until that install
 * replaces this one, the page has to ask: the older picker treats
 * `audioRequested` as the whole switch, and a hidden icon on the call bar
 * was how people missed the choice and then fought the Windows mixer.
 */
export function ShareAudioPrompt({
  open,
  onConfirm,
  onClose,
}: {
  open: boolean;
  onConfirm: (shareAudio: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [shareAudio, setShareAudio] = useState(false);

  useEffect(() => {
    if (open) {
      setShareAudio(false);
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      title={t("voice.share.audioPromptTitle")}
      description={t("voice.share.audioPromptLead")}
      size="sm"
      onClose={onClose}
      footer={
        <div className="grid w-full min-w-0 grid-cols-2 gap-2">
          <Button
            type="button"
            variant="ghost"
            className="h-auto min-h-9 w-full min-w-0 whitespace-normal px-2 text-center"
            onClick={onClose}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            className="h-auto min-h-9 w-full min-w-0 whitespace-normal px-2 text-center"
            onClick={() => {
              onConfirm(shareAudio);
              onClose();
            }}
          >
            {t("voice.share.audioPromptContinue")}
          </Button>
        </div>
      }
    >
      <DialogBody>
        <CheckRow
          checked={shareAudio}
          onCheckedChange={setShareAudio}
          label={t("voice.control.shareSound")}
        />
        <p className="mt-2 px-2 text-xs text-text-tertiary">
          {t("voice.control.shareSoundDetail")}
        </p>
      </DialogBody>
    </Dialog>
  );
}

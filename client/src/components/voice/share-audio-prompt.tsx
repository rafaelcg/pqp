import { useEffect, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "@/lib/i18n";

/**
 * The audio question, asked before the picker on a Windows desktop shell
 * whose picker cannot ask yet.
 *
 * Discord puts this switch on the share picker itself. Ours does too, from
 * the binary that advertises `sharePickerOffersAudio` (the shell's own picker
 * draws the same row: a speaker, the words, a switch that starts on). Until
 * that install replaces this one, the page has to ask: the older picker treats
 * `audioRequested` as the whole switch, and a hidden icon on the call bar was
 * how people missed the choice and then fought the Windows mixer.
 *
 * ON BY DEFAULT, every time it opens. A missed box meant a silent share and
 * "(no sound)" on the viewers' stage; turning it off is one click, counts for
 * that share only, and says out loud what it means.
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
  const [shareAudio, setShareAudio] = useState(true);

  useEffect(() => {
    if (open) {
      setShareAudio(true);
    }
  }, [open]);

  const Icon = shareAudio ? Volume2 : VolumeX;

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
        <div
          data-testid="share-audio-row"
          data-state={shareAudio ? "on" : "off"}
          className="flex items-start gap-3 rounded-[var(--radius-control)] border border-border bg-surface-1 p-3"
        >
          <Icon
            className={
              shareAudio
                ? "mt-0.5 h-6 w-6 shrink-0 text-accent"
                : "mt-0.5 h-6 w-6 shrink-0 text-text-tertiary"
            }
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <Switch
              checked={shareAudio}
              onCheckedChange={setShareAudio}
              label={t("voice.control.shareSound")}
              description={t("voice.share.audioPromptHint")}
              className="px-0 py-0"
            />
            {/* What the viewers get instead, in words, only while it is off:
                a switch that is off looks like any other setting, and a
                missed one is the silent share this row exists to prevent. */}
            <p
              role="status"
              data-testid="share-audio-off-note"
              className="mt-1 text-xs font-semibold text-text"
            >
              {shareAudio ? null : t("voice.share.audioPromptOff")}
            </p>
          </div>
        </div>
      </DialogBody>
    </Dialog>
  );
}

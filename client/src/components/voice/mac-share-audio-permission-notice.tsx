import { useEffect, useState, useSyncExternalStore } from "react";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import {
  getMacShareAudioPermission,
  subscribeMacShareAudioPermission,
} from "@/lib/mac-share-audio-permission";
import { openMacShareAudioSettings } from "@/lib/mac-shell-share-audio";

/**
 * "Teu compartilhamento está sem som." One card, in the call, for the
 * presenter on the macOS desktop app whose computer sound did not open because
 * the System Audio Recording permission is missing. It says what the viewers
 * get, what to turn on, and one button that opens that exact Settings pane.
 * The same `CornerCard` frame as the other inline call cards; the controller
 * raises and clears the state (`lib/mac-share-audio-permission.ts`).
 */
export function MacShareAudioPermissionNotice({
  visible = true,
}: {
  /** False while the call chrome is hidden, like the other cards in the bar. */
  visible?: boolean;
}) {
  const { t } = useTranslation();
  const raised = useSyncExternalStore(
    subscribeMacShareAudioPermission,
    getMacShareAudioPermission,
    getMacShareAudioPermission,
  );
  const [closedAt, setClosedAt] = useState<number | null>(null);
  // Held past `raised` going null so the exit animation keeps its sentence.
  const [shown, setShown] = useState(raised);
  useEffect(() => {
    if (raised) {
      setShown(raised);
    }
  }, [raised]);

  if (!shown) {
    return null;
  }
  const open = visible && raised !== null && closedAt !== raised.at;
  const title = t("voice.macShareAudio.title");

  return (
    <CornerCard
      layout="inline"
      open={open}
      onClose={() => setClosedAt(shown.at)}
      label={title}
      dismissLabel={t("featureHint.dismiss")}
      dataAttribute="mac-share-audio-permission"
      title={title}
      body={
        <>
          <span className="block">{t("voice.macShareAudio.body")}</span>
          <span className="mt-1 block">{t("voice.macShareAudio.retry")}</span>
        </>
      }
      footer={
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            className="cta-lift rounded-full px-4"
            data-mac-share-audio-open-settings
            onClick={() => {
              void openMacShareAudioSettings();
            }}
          >
            {t("voice.macShareAudio.openSettings")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full px-4"
            onClick={() => setClosedAt(shown.at)}
          >
            {t("featureHint.gotIt")}
          </Button>
        </div>
      }
    />
  );
}

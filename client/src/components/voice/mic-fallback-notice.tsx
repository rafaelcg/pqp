import { useEffect, useState } from "react";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { requestSettingsSection } from "@/lib/settings-request";
import { useTranslation } from "@/lib/i18n";
import type { MicFallbackNotice as MicFallbackNoticeState } from "@/hooks/use-voice";

/**
 * "Seu microfone de sempre não ligou." One card, in the call, from the
 * moment the saved microphone could not start until the substitute stops
 * being necessary.
 *
 * Reported 2026-09-14: this used to be a bare line in the generic
 * `voiceState.notice` strip, drawn absolutely across the TOP of the stage
 * with no close button, and nothing ever cleared it once the saved device
 * (NVIDIA Broadcast, in the report) came back — it sat there for the rest
 * of the call, once even covering a shared screen. Same `CornerCard` frame
 * as `CapacityNotice`, laid out inline in the call bar instead: in flow
 * above the controls, never over the picture.
 *
 * The lifecycle lives entirely on the controller (`use-voice.ts`,
 * `VoiceState.micFallback`): set the moment a substitute mic opens, cleared
 * the moment the saved device answers again — on its own via `devicechange`,
 * or because the person picked a device by hand — and closing it here is
 * remembered for the rest of the call. This component only ever reads that
 * one field and reports a close.
 */
export function MicFallbackNotice({
  micFallback,
  visible = true,
  onDismiss,
}: {
  micFallback: MicFallbackNoticeState | null;
  /**
   * False while the call chrome is hidden (idle auto-hide). Same reasoning
   * as `CapacityNotice`: a card nobody can see must not sit there mid-fade
   * under something else once the chrome comes back.
   */
  visible?: boolean;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  // Held past `micFallback` going null so the card's own exit animation
  // shows the sentence it was already showing, rather than snapping to the
  // "unnamed" copy (or nothing) for the ~180ms it takes to fade out.
  const [shown, setShown] = useState(micFallback);
  useEffect(() => {
    if (micFallback) {
      setShown(micFallback);
    }
  }, [micFallback]);

  const open = visible && micFallback !== null;
  if (!shown) {
    return null;
  }

  return (
    <CornerCard
      layout="inline"
      open={open}
      onClose={onDismiss}
      label={t("voice.notice.micFallbackTitle")}
      dismissLabel={t("featureHint.dismiss")}
      dataAttribute="voice-mic-fallback"
      title={t("voice.notice.micFallbackTitle")}
      body={
        shown.label
          ? t("voice.notice.micFallback", { label: shown.label })
          : t("voice.notice.micFallbackUnnamed")
      }
      footer={
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full px-4"
          onClick={() => requestSettingsSection("voice")}
        >
          {t("voice.notice.micFallbackSwitch")}
        </Button>
      }
    />
  );
}

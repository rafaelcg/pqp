import { useEffect, useState } from "react";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { requestConnectionCheck } from "@/lib/settings-request";
import type { AudioHealthPrompt } from "@/lib/audio-health";

const COPY = {
  mic: { title: "voice.audioHealth.micTitle", body: "voice.audioHealth.micBody" },
  hearing: { title: "voice.audioHealth.hearingTitle", body: "voice.audioHealth.hearingBody" },
  micUnavailable: {
    title: "voice.audioHealth.micUnavailableTitle",
    body: "voice.audioHealth.micUnavailableBody",
  },
} as const satisfies Record<AudioHealthPrompt, { title: string; body: string }>;

/**
 * "Parece que teu mic parou. Arrumar?" The audio self-repair's one visible
 * surface (`lib/audio-health.ts`): it shows only after the quiet repairs did
 * not bring the sound back, and its button runs the bigger one (reopen the
 * microphone, replay and resubscribe, or rejoin with a microphone). Same
 * inline `CornerCard` as `MicFallbackNotice`, in flow above the call bar,
 * never over the picture.
 *
 * The lifecycle is the controller's (`VoiceState.audioHealthPrompt`): up when
 * a ladder runs out, down the moment the tap is taken or the sound comes back
 * on its own, and closing it keeps that problem quiet for the rest of the call.
 */
export function AudioHealthNotice({
  prompt,
  visible = true,
  onRepair,
  onDismiss,
}: {
  prompt: AudioHealthPrompt | null;
  /** False while the call chrome is hidden, same as `MicFallbackNotice`. */
  visible?: boolean;
  onRepair: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  // Held past `prompt` going null so the exit animation keeps its sentence.
  const [shown, setShown] = useState(prompt);
  useEffect(() => {
    if (prompt) {
      setShown(prompt);
    }
  }, [prompt]);

  if (!shown) {
    return null;
  }
  const copy = COPY[shown];

  return (
    <CornerCard
      layout="inline"
      open={visible && prompt !== null}
      onClose={onDismiss}
      label={t("voice.audioHealth.label")}
      dismissLabel={t("featureHint.dismiss")}
      dataAttribute="voice-audio-health"
      title={t(copy.title)}
      body={t(copy.body)}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="rounded-full px-4"
            onClick={onRepair}
            data-audio-health-repair={shown}
          >
            {t("voice.audioHealth.repair")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full px-4"
            onClick={() => requestConnectionCheck()}
          >
            {t("connection.check")}
          </Button>
        </div>
      }
    />
  );
}

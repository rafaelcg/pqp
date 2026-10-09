import { useEffect, useState } from "react";
import { FeatureHint } from "@/components/layout/feature-hint";
import { shouldOfferVoiceNoteTranscriptionNotice } from "@/lib/feature-hints";
import { loadVoiceTranscriptionEnabled } from "@/lib/attachments";
import { useTranslation } from "@/lib/i18n";
import { requestSettingsSection } from "@/lib/settings-request";
import {
  markTranscriptionAvailable,
  useVoiceTranscription,
} from "@/lib/voice-transcription-prefs";

/**
 * The first time somebody records a voice note: it will be transcribed, and
 * where to turn that off. A coachmark above the composer through the same
 * shell and store as every other one-time card (`FeatureHint`, `lib/hints.ts`),
 * not a dialog, so it never gets between a person and the microphone.
 *
 * Always mounted, enabled only while a recording is under way: a hint with a
 * live gate is mounted with `enabled`, not behind `&&` (docs/ONBOARDING.md).
 */
export function VoiceNoteTranscriptionNotice({
  recording,
  serverId,
}: {
  recording: boolean;
  serverId: string | null;
}) {
  const { t } = useTranslation();
  const { mine } = useVoiceTranscription();
  const [transcriptionOn, setTranscriptionOn] = useState(false);

  useEffect(() => {
    if (!recording) {
      return;
    }
    let cancelled = false;
    void loadVoiceTranscriptionEnabled(serverId).then((on) => {
      if (!cancelled) {
        setTranscriptionOn(on);
        if (on) {
          markTranscriptionAvailable();
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [recording, serverId]);

  return (
    <div className="pointer-events-none absolute bottom-full left-3 z-20 mb-2 sm:left-4 [&>*]:pointer-events-auto">
      <FeatureHint
        id="voiceNoteTranscription"
        enabled={shouldOfferVoiceNoteTranscriptionNotice({
          recording,
          transcriptionOn,
          mine,
        })}
        title={t("featureHint.voiceNoteTranscription.title")}
        body={t("featureHint.voiceNoteTranscription.body")}
        actionLabel={t("featureHint.voiceNoteTranscription.action")}
        onAction={() => requestSettingsSection("privacy")}
      />
    </div>
  );
}

import { useEffect, useState } from "react";
import {
  SettingsGroup,
  SettingsNotice,
  SettingsSwitchRow,
} from "@/components/settings/kit";
import { loadVoiceTranscriptionEnabled } from "@/lib/attachments";
import { useTranslation } from "@/lib/i18n";
import { usePreferenceSyncFailed } from "@/lib/preferences";
import {
  markTranscriptionAvailable,
  setVoiceTranscription,
  useTranscriptionSeen,
  useVoiceTranscription,
} from "@/lib/voice-transcription-prefs";

const SYNCED_KEYS = ["voiceTranscription"] as const;

/**
 * "Mensagens de voz": the two halves of transcription. Drawn only where it
 * exists (the flag is on for conversations, or something in this session has
 * shown it is on for a server), so a deployment without it has no switches for
 * a thing that does not happen.
 *
 * Each switch applies the moment it is pressed, like the rest of Privacidade.
 * Turning off "my notes" does not reach back into notes already sent: the
 * server copied the choice onto each note when it was recorded, and the copy
 * says so.
 */
export function VoiceNotesGroup() {
  const { t } = useTranslation();
  const prefs = useVoiceTranscription();
  const seen = useTranscriptionSeen();
  const syncFailed = usePreferenceSyncFailed(SYNCED_KEYS);
  const [globalOn, setGlobalOn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadVoiceTranscriptionEnabled(null).then((on) => {
      if (!cancelled && on) {
        setGlobalOn(true);
        markTranscriptionAvailable();
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!globalOn && !seen) {
    return null;
  }

  return (
    <SettingsGroup
      id="voice-notes"
      title={t("settings.privacy.voiceNotes.title")}
      description={t("settings.privacy.voiceNotes.description")}
    >
      <SettingsSwitchRow
        id="voice-notes-transcribe-mine"
        label={t("settings.privacy.voiceNotes.mine.label")}
        description={t("settings.privacy.voiceNotes.mine.hint")}
        checked={prefs.mine}
        onCheckedChange={(mine) => setVoiceTranscription({ mine })}
      />
      <SettingsSwitchRow
        id="voice-notes-show-transcripts"
        label={t("settings.privacy.voiceNotes.show.label")}
        description={t("settings.privacy.voiceNotes.show.hint")}
        checked={prefs.show}
        onCheckedChange={(show) => setVoiceTranscription({ show })}
        status={
          syncFailed ? (
            <SettingsNotice tone="warning" role="alert">
              {t("settings.syncFailed")}
            </SettingsNotice>
          ) : undefined
        }
      />
    </SettingsGroup>
  );
}

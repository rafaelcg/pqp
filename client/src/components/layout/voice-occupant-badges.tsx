import { HeadphoneOff, MicOff, ScreenShare, Video } from "lucide-react";
import type { VoiceParticipant } from "@pqp/shared";
import { useTranslation } from "@/lib/i18n";

/**
 * The per-occupant voice-state badges: mic-off, deafened, sharing screen,
 * camera on.
 *
 * Rendered from the roster (`VoiceParticipant`), which the server updates on
 * every `set-voice-state` and `set-camera` — so someone *outside* the call
 * sees who is muted or on camera before joining. Deafened implies muted (the
 * controller enforces that), so only the deafen icon is shown then: two red
 * icons would say the same thing twice in a 16px row. Camera-on is the
 * roster's `cameraStreamId`, the same field the mesh uses to file a face.
 *
 * There is deliberately no speaking badge here beyond the ring the in-call
 * viewer already gets: speaking is not carried on the roster (see the fan-out
 * note on `voiceParticipantSchema`), and this row must not pretend otherwise.
 */
export function VoiceOccupantBadges({
  person,
}: {
  person: VoiceParticipant;
}) {
  const { t } = useTranslation();
  const cameraOn = Boolean(person.cameraStreamId);
  if (
    !person.muted &&
    !person.deafened &&
    !person.sharingScreen &&
    !cameraOn
  ) {
    return null;
  }
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      {person.sharingScreen && (
        <ScreenShare
          aria-label={t("chrome.sharingScreen")}
          role="img"
          className="h-3 w-3 text-signal"
        />
      )}
      {cameraOn && (
        <Video
          aria-label={t("chrome.cameraOn")}
          role="img"
          className="h-3 w-3 text-signal"
        />
      )}
      {person.deafened ? (
        <HeadphoneOff
          aria-label={t("chrome.deafened")}
          role="img"
          className="h-3 w-3 text-danger"
        />
      ) : (
        person.muted && (
          <MicOff aria-label={t("chrome.muted")} role="img" className="h-3 w-3 text-danger" />
        )
      )}
    </span>
  );
}

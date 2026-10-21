import { Hand, HeadphoneOff, MicOff, ScreenShare, Video } from "lucide-react";
import { HandPositionBadge } from "@/components/voice/hand-position-badge";
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
 *
 * A RAISED HAND *IS* SHOWN HERE, to people standing outside the call as well
 * as to people in it, and that was a decision rather than an accident of
 * where the field rides. The roster is one frame for both audiences, so
 * hiding the hand from the sidebar would mean this component deliberately
 * dropping something it was told. It is also the more useful way round:
 * "somebody in there is waiting to talk" is exactly the sort of thing that
 * makes a person open the call, and a hand is a public gesture in a room
 * whose occupants are already listed by name.
 *
 * THE POSITION IS SHOWN TOO, next to the hand. It used to live only in the
 * queue on the stage, and a call with no camera never opens the stage, so the
 * room could not read its own turn order. An RPG table asked for exactly
 * that: the hand with its number, on every person, the way Meet draws it.
 */
export function VoiceOccupantBadges({
  person,
  handPosition = null,
}: {
  person: VoiceParticipant;
  /** This person's place in the room's queue (1-based), or null. */
  handPosition?: number | null;
}) {
  const { t } = useTranslation();
  const cameraOn = Boolean(person.cameraStreamId);
  const handRaised = person.handRaisedAt != null;
  if (
    !person.muted &&
    !person.deafened &&
    !person.sharingScreen &&
    !cameraOn &&
    !handRaised
  ) {
    return null;
  }
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      {handRaised &&
        (handPosition !== null ? (
          <HandPositionBadge position={handPosition} className="text-[10px]" />
        ) : (
          <Hand
            aria-label={t("voice.hand.raised")}
            role="img"
            className="h-3 w-3 text-signal"
          />
        ))}
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

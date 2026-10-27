import {
  EarSlash,
  Hand as HandFill,
  MicrophoneSlash,
  MonitorArrowUp,
  VideoCamera,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import {
  Hand,
  HeadphoneOff,
  MicOff,
  ScreenShare,
  Video,
  type LucideIcon,
} from "lucide-react";
import { Icon, type IconKind } from "@/components/ui/icon";
import { useRedesign } from "@/lib/redesign";
import { cn } from "@/lib/utils";
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
/**
 * One state badge: the name on the wrapper, the Lucide glyph with the toggle
 * off and the Phosphor one (14px) under the redesign.
 */
function BadgeGlyph({
  off: Off,
  on,
  kind = "object",
  label,
  tone,
  onClassName = "h-3.5 w-3.5",
}: {
  off: LucideIcon;
  on: PhosphorIcon;
  kind?: IconKind;
  label: string;
  /** Accent for what someone is doing, danger for what they cannot do. */
  tone: "accent" | "danger";
  /** The Phosphor glyph's size, 14px unless a shape needs more room. */
  onClassName?: string;
}) {
  const redesign = useRedesign();
  return (
    <span
      role="img"
      aria-label={label}
      // Under the redesign the glyph says its state on hover too: a filled
      // ear at 16px is easy to take for a "no" sign.
      title={redesign ? label : undefined}
      className={cn(
        "flex",
        // The accent as a mark on the pane needs its text step (lime is
        // too light on the light theme); danger reads as it is.
        tone === "accent" ? "text-signal redesign:text-accent-text" : "text-danger",
      )}
    >
      <Off aria-hidden="true" className="h-3 w-3 redesign:hidden" />
      <Icon icon={on} kind={kind} className={cn("hidden redesign:block", onClassName)} />
    </span>
  );
}

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
    <span className="ml-auto flex shrink-0 items-center gap-1 redesign:gap-1.5">
      {handRaised &&
        (handPosition !== null ? (
          <HandPositionBadge position={handPosition} className="text-[10px] redesign:text-[11px]" />
        ) : (
          <BadgeGlyph off={Hand} on={HandFill} label={t("voice.hand.raised")} tone="accent" />
        ))}
      {person.sharingScreen && (
        <BadgeGlyph
          off={ScreenShare}
          on={MonitorArrowUp}
          label={t("chrome.sharingScreen")}
          tone="accent"
        />
      )}
      {cameraOn && (
        <BadgeGlyph off={Video} on={VideoCamera} label={t("chrome.cameraOn")} tone="accent" />
      )}
      {person.deafened ? (
        // The bold ear at 16px: filled it read as a "no" sign, at 14px as a scribble.
          <BadgeGlyph off={HeadphoneOff} on={EarSlash} kind="symbol" label={t("chrome.deafened")} tone="danger" onClassName="h-4 w-4" />
      ) : (
        person.muted && (
          <BadgeGlyph off={MicOff} on={MicrophoneSlash} label={t("chrome.muted")} tone="danger" />
        )
      )}
    </span>
  );
}
